import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker } from "electron";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import started from "electron-squirrel-startup";
import chokidar, { type FSWatcher } from "chokidar";

interface BackendCommand {
  cmd: string;
  args: string[];
  cwd: string | undefined;
}

if (started) {
  app.quit();
}

let backendProcess: ChildProcess | null = null;
let backendWatcher: FSWatcher | undefined;
let rendererWatcher: FSWatcher | undefined;

function getBackendCommand(): BackendCommand {
  if (app.isPackaged) {
    // Single-file binary produced by `bun build --compile`.
    const binaryPath = path.join(process.resourcesPath, "taskboard");
    return { cmd: binaryPath, args: [], cwd: undefined };
  } else {
    // In dev mode, app.getAppPath() returns taskboard-electron/ dir;
    // the project root (containing backend/) is one level up. Keep cwd at
    // the project root so backend relative paths match packaged behavior.
    const projectRoot = path.join(app.getAppPath(), "..");
    return { cmd: "bun", args: [path.join("backend", "taskboard.ts")], cwd: projectRoot };
  }
}

function waitForBackend(port: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          scheduleRetry();
        }
      });
      req.on("error", scheduleRetry);
      req.setTimeout(500, () => {
        req.destroy();
        scheduleRetry();
      });

      function scheduleRetry() {
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Backend did not start within ${timeoutMs}ms`));
        } else {
          setTimeout(check, 200);
        }
      }
    };
    check();
  });
}

function killPortSync(port: number): void {
  // Best-effort: kill any process already holding the port before we spawn
  try {
    const { execSync } = require("node:child_process");
    const out = execSync(`lsof -ti :${port}`, { encoding: "utf8" }).trim();
    if (out) {
      out.split("\n").forEach((pid: string) => {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch (_) {}
      });
    }
  } catch (_) {
    /* lsof returned nothing or failed */
  }
}

// macOS apps launched from Finder/Dock inherit a minimal PATH (no Homebrew,
// no ~/.bun), so child processes can't find tools like `bun`, `node`, or the
// agent CLIs. Prepend the common install dirs so they resolve.
function augmentedPath(): string {
  const extra = [
    path.join(os.homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = process.env.PATH || "";
  const merged = [...extra, ...current.split(":")].filter(Boolean);
  return [...new Set(merged)].join(":");
}

function startBackend(): Promise<void> {
  killPortSync(9712);
  const { cmd, args, cwd } = getBackendCommand();
  backendProcess = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: augmentedPath() },
    ...(cwd ? { cwd } : {}),
  });

  backendProcess.stdout.on("data", (data) => {
    console.log("[Backend]", data.toString().trim());
  });
  backendProcess.stderr.on("data", (data) => {
    console.error("[Backend stderr]", data.toString().trim());
  });
  backendProcess.on("error", (err) => {
    console.error("[Backend] Failed to start:", err);
  });

  return waitForBackend(9712, 15000);
}

function stopBackend(): void {
  if (!backendProcess) return;
  const proc = backendProcess;
  backendProcess = null;
  try {
    proc.kill("SIGTERM");
  } catch (_) {
    /* already gone */
  }
}

function setupBackendHotReload(): FSWatcher | undefined {
  if (app.isPackaged) return; // 生产环境不启用热重载

  const projectRoot = path.resolve(path.join(app.getAppPath(), ".."));
  // 监听根目录并使用过滤函数，而不是使用通配符模式
  const watcher = chokidar
    .watch(".", {
      cwd: projectRoot,
      ignored: [/node_modules/, /\.git/, /\.venv/, /__pycache__/, /build/, /dist/, /^\./],
      persistent: true,
      ignoreInitial: true,
    })
    .on("ready", () => {
      console.log("[Hot Reload] Watcher ready, monitoring:", projectRoot);
    });

  let restartTimeout: NodeJS.Timeout | null = null;
  let isRestarting = false; // 重启锁

  const scheduleRestart = (filePath: string, eventType: string) => {
    // Restart for backend TypeScript sources only (backend/**/*.ts). Files in
    // other directories are ignored to avoid restarting when a running task
    // modifies files (e.g. README.md, todo.md in working directories).
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== ".ts") {
      return;
    }
    const isBackendDir =
      filePath.startsWith("backend/") || filePath.startsWith(`backend${path.sep}`);
    if (!isBackendDir) {
      return;
    }

    console.log(`[Hot Reload] File ${eventType}: ${filePath}`);

    // 防抖处理，避免频繁重启
    if (restartTimeout) {
      clearTimeout(restartTimeout);
    }

    restartTimeout = setTimeout(async () => {
      // 只有不在重启中时才执行重启
      if (isRestarting) {
        console.log("[Hot Reload] Restart already in progress, skipping...");
        return;
      }

      isRestarting = true;
      console.log("[Hot Reload] Restarting backend...");
      try {
        stopBackend();
        await startBackend();
        console.log("[Hot Reload] Backend restarted successfully");
      } catch (error) {
        console.error("[Hot Reload] Failed to restart backend:", error);
      } finally {
        isRestarting = false;
      }
    }, 500); // 500ms 延迟，避免文件保存时的多次触发
  };

  watcher.on("change", (filePath: string) => scheduleRestart(filePath, "changed"));
  watcher.on("add", (filePath: string) => scheduleRestart(filePath, "added"));
  watcher.on("unlink", (filePath: string) => scheduleRestart(filePath, "removed"));

  watcher.on("error", (error: unknown) => {
    console.error("[Hot Reload] File watcher error:", error);
  });

  console.log("[Hot Reload] Backend hot reload enabled");
  return watcher;
}

// In dev, scripts/dev.ts rebuilds the renderer bundle on source changes;
// reload the window whenever the built output updates.
function setupRendererReload(win: BrowserWindow): FSWatcher | undefined {
  if (app.isPackaged) return;
  const rendererOut = path.join(app.getAppPath(), ".bun", "renderer");
  let reloadTimeout: NodeJS.Timeout | null = null;
  const watcher = chokidar.watch(rendererOut, { ignoreInitial: true });
  watcher.on("all", () => {
    if (reloadTimeout) clearTimeout(reloadTimeout);
    reloadTimeout = setTimeout(() => {
      if (!win.isDestroyed()) {
        console.log("[Hot Reload] Renderer bundle changed, reloading window");
        win.webContents.reloadIgnoringCache();
      }
    }, 150);
  });
  return watcher;
}

// Handle terminal Ctrl+C and kill signals so the backend is cleaned up
process.on("SIGINT", () => {
  stopBackend();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopBackend();
  process.exit(0);
});

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Renderer bundle produced by scripts/build.ts (Bun.build).
  mainWindow.loadFile(path.join(app.getAppPath(), ".bun", "renderer", "index.html"));

  return mainWindow;
};

ipcMain.handle("select-directory", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(() => {
  powerSaveBlocker.start("prevent-app-suspension");
  const mainWindow = createWindow();

  // 设置后端与渲染层热重载
  if (!app.isPackaged) {
    backendWatcher = setupBackendHotReload();
    rendererWatcher = setupRendererReload(mainWindow);
  }

  startBackend()
    .then(() => console.log("[Backend] Ready on port 9712"))
    .catch((err) => console.error("[Backend] Failed:", err));
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  stopBackend();
  app.quit();
});

app.on("before-quit", () => {
  stopBackend();
  if (backendWatcher) {
    backendWatcher.close();
  }
  if (rendererWatcher) {
    rendererWatcher.close();
  }
});
