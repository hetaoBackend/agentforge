import { BrowserView, BrowserWindow, Utils, app } from "electrobun/bun";

import { logger } from "../../../backend/src/log.ts";
import { runServer, type RunningServer } from "../../../backend/src/server.ts";
import { normalizeDirectorySelection } from "../renderer/nativeBridge.ts";
import { applyBackendResourceEnv, resolveRuntimePaths } from "./paths.ts";

const runtimePaths = resolveRuntimePaths();
Object.assign(process.env, applyBackendResourceEnv(process.env, runtimePaths));

let runningServer: RunningServer | null = null;
let stopping = false;

async function startBackend(): Promise<void> {
  logger.info(`=== Electrobun backend starting at ${new Date().toISOString()} on port 9712 ===`);
  logger.info(`Electrobun resources at ${runtimePaths.resourcesDir}`);
  runningServer = await runServer(9712);
}

async function stopBackend(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const server = runningServer;
  runningServer = null;
  if (server) {
    await server.stop();
  }
}

const nativeBridgeRPC = BrowserView.defineRPC<any>({
  maxRequestTime: 600000,
  handlers: {
    requests: {
      selectDirectory: async () => {
        const selection = await Utils.openFileDialog({
          startingFolder: "~/",
          allowedFileTypes: "*",
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });
        return normalizeDirectorySelection(selection);
      },
    },
    messages: {},
  },
});

await startBackend();

new BrowserWindow({
  title: "AgentForge",
  url: "views://main/index.html",
  renderer: "native",
  titleBarStyle: "hiddenInset",
  frame: {
    x: 100,
    y: 100,
    width: 1280,
    height: 800,
  },
  rpc: nativeBridgeRPC,
});

app.on("before-quit", () => {
  void stopBackend();
});

process.on("SIGINT", () => {
  void stopBackend().finally(() => app.quit());
});

process.on("SIGTERM", () => {
  void stopBackend().finally(() => app.quit());
});
