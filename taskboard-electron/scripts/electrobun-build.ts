import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installMacAppIcon } from "./install-mac-app-icon.ts";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electrobunBin = path.join(appRoot, "node_modules", ".bin", "electrobun");
const command = existsSync(electrobunBin) ? electrobunBin : "electrobun";
const args = ["build", ...process.argv.slice(2)];

const result = spawnSync(command, args, {
  cwd: appRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.signal) {
  console.error(`[build-icon] Electrobun exited from signal ${result.signal}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

for (const delayMs of [250, 500, 1000]) {
  await Bun.sleep(delayMs);
  installMacAppIcon({ appRoot, targetOS: "macos" });
}
