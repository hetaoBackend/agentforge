import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installMacAppIcon } from "./install-mac-app-icon.ts";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electrobunBin = path.join(appRoot, "node_modules", ".bin", "electrobun");
const command = existsSync(electrobunBin) ? electrobunBin : "electrobun";

let loggedInstall = false;
let lastError = "";

function tryInstallIcon(): void {
  try {
    const installedIcons = installMacAppIcon({
      allowMissingBuildDir: true,
      appRoot,
      quiet: true,
      targetOS: "macos",
    });

    if (installedIcons.length > 0 && !loggedInstall) {
      console.log(`[dev-icon] Installed app icon into ${installedIcons.length} bundle(s)`);
      loggedInstall = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) {
      console.warn(`[dev-icon] ${message}`);
      lastError = message;
    }
  }
}

const child = spawn(command, ["dev", "--watch"], {
  cwd: appRoot,
  env: process.env,
  stdio: "inherit",
});

const firstIconInstall = setTimeout(tryInstallIcon, 5000);
const iconTimer = setInterval(tryInstallIcon, 2000);

child.on("exit", (code, signal) => {
  clearTimeout(firstIconInstall);
  clearInterval(iconTimer);
  tryInstallIcon();

  if (signal) {
    process.exit(1);
    return;
  }

  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
