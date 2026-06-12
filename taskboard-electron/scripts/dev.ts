// Dev runner: bun-builds main/preload/renderer, launches Electron, and
// rebuilds on source changes. Renderer rebuilds are picked up by main.ts
// (it watches .bun/renderer in dev and reloads the window); main/preload
// changes restart Electron.
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { buildAll, buildMain, buildPreload, buildRenderer } from "./build.ts";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// The electron package's main export is the path to the Electron binary.
const electronBin = require("electron") as unknown as string;

await buildAll();

let electron: ChildProcess | null = null;
let restarting = false;

function launchElectron(): void {
  electron = spawn(electronBin, ["."], { cwd: appRoot, stdio: "inherit" });
  electron.on("exit", (code) => {
    if (!restarting) process.exit(code ?? 0);
  });
}

async function restartElectron(): Promise<void> {
  restarting = true;
  const prev = electron;
  if (prev) {
    await new Promise<void>((resolve) => {
      prev.once("exit", () => resolve());
      prev.kill("SIGTERM");
      setTimeout(resolve, 3000);
    });
  }
  restarting = false;
  launchElectron();
}

let pending: Promise<void> = Promise.resolve();
function queue(job: () => Promise<void>): void {
  pending = pending.then(job).catch((err) => console.error("[dev] rebuild failed:", err));
}

const watcher = chokidar.watch(["src", "index.html"], {
  cwd: appRoot,
  ignoreInitial: true,
});
watcher.on("all", (_event, filePath) => {
  if (filePath.endsWith(".test.ts")) return;
  const isMain = filePath === path.join("src", "main.ts");
  const isPreload = filePath === path.join("src", "preload.ts");
  if (isMain || isPreload) {
    queue(async () => {
      await (isMain ? buildMain() : buildPreload());
      console.log("[dev] main/preload changed; restarting Electron");
      await restartElectron();
    });
  } else {
    queue(async () => {
      await buildRenderer();
    });
  }
});

launchElectron();
