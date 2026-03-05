import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import started from 'electron-squirrel-startup';
import chokidar from 'chokidar';

if (started) {
  app.quit();
}

let pythonProcess = null;

function getPythonCommand() {
  if (app.isPackaged) {
    const binaryPath = path.join(process.resourcesPath, 'taskboard');
    return { cmd: binaryPath, args: [], cwd: undefined };
  } else {
    // In dev mode, app.getAppPath() returns taskboard-electron/ dir
    // The Python project root is one level up
    const projectRoot = path.join(app.getAppPath(), '..');
    return { cmd: 'uv', args: ['run', 'taskboard.py'], cwd: projectRoot };
  }
}

function waitForBackend(port, timeoutMs) {
  return new Promise((resolve, reject) => {
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
      req.on('error', scheduleRetry);
      req.setTimeout(500, () => { req.destroy(); scheduleRetry(); });

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

function killPortSync(port) {
  // Best-effort: kill any process already holding the port before we spawn
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
    if (out) {
      out.split('\n').forEach(pid => {
        try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
      });
    }
  } catch (_) { /* lsof returned nothing or failed */ }
}

function startPythonBackend() {
  killPortSync(9712);
  const { cmd, args, cwd } = getPythonCommand();
  pythonProcess = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    ...(cwd ? { cwd } : {}),
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log('[Python]', data.toString().trim());
  });
  pythonProcess.stderr.on('data', (data) => {
    console.error('[Python stderr]', data.toString().trim());
  });
  pythonProcess.on('error', (err) => {
    console.error('[Python] Failed to start:', err);
  });

  return waitForBackend(9712, 15000);
}

function stopPythonBackend() {
  if (!pythonProcess) return;
  const proc = pythonProcess;
  pythonProcess = null;
  try {
    proc.kill('SIGTERM');
  } catch (_) { /* already gone */ }
}

function setupPythonHotReload() {
  if (app.isPackaged) return; // 生产环境不启用热重载

  const projectRoot = path.resolve(path.join(app.getAppPath(), '..'));
  // 监听根目录并使用过滤函数，而不是使用通配符模式
  const watcher = chokidar.watch('.', {
    cwd: projectRoot,
    ignored: [
      /node_modules/,
      /\.git/,
      /\.venv/,
      /__pycache__/,
      /build/,
      /dist/,
      /^\./,
    ],
    persistent: true,
    ignoreInitial: true,
  }).on('ready', () => {
    console.log('[Hot Reload] Watcher ready, monitoring:', projectRoot);
  });

  let restartTimeout = null;
  let isRestarting = false; // 重启锁

  const scheduleRestart = (filePath, eventType) => {
    // Restart for .py/.toml files in the project root or in the channels/ directory.
    // Files in other subdirectories are ignored to avoid restarting when a running
    // task modifies files (e.g. README.md, todo.md in working directories).
    const ext = path.extname(filePath).toLowerCase();
    if (!['.py', '.toml'].includes(ext)) {
      return;
    }
    // Allow root-level files and files under channels/
    const isRootLevel = !filePath.includes('/') && !filePath.includes(path.sep);
    const isChannelsDir = filePath.startsWith('channels/') || filePath.startsWith(`channels${path.sep}`);
    if (!isRootLevel && !isChannelsDir) {
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
        console.log('[Hot Reload] Restart already in progress, skipping...');
        return;
      }

      isRestarting = true;
      console.log('[Hot Reload] Restarting Python backend...');
      try {
        stopPythonBackend();
        await startPythonBackend();
        console.log('[Hot Reload] Python backend restarted successfully');
      } catch (error) {
        console.error('[Hot Reload] Failed to restart Python backend:', error);
      } finally {
        isRestarting = false;
      }
    }, 500); // 500ms 延迟，避免文件保存时的多次触发
  };

  watcher.on('change', (filePath) => scheduleRestart(filePath, 'changed'));
  watcher.on('add', (filePath) => scheduleRestart(filePath, 'added'));
  watcher.on('unlink', (filePath) => scheduleRestart(filePath, 'removed'));

  watcher.on('error', (error) => {
    console.error('[Hot Reload] File watcher error:', error);
  });

  console.log('[Hot Reload] Python backend hot reload enabled');
  return watcher;
}

// Handle terminal Ctrl+C and kill signals so the backend is cleaned up
process.on('SIGINT', () => {
  stopPythonBackend();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopPythonBackend();
  process.exit(0);
});

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  return mainWindow;
};

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();

  // 设置Python后端热重载
  let pythonWatcher = null;
  if (!app.isPackaged) {
    pythonWatcher = setupPythonHotReload();
  }

  startPythonBackend()
    .then(() => console.log('[Python] Backend is ready on port 9712'))
    .catch((err) => console.error('[Python] Backend failed:', err));

  app.activate(() => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopPythonBackend();
  app.quit();
});

app.on('before-quit', () => {
  stopPythonBackend();
  if (pythonWatcher) {
    pythonWatcher.close();
  }
});
