// Compile the Bun TypeScript backend into the single-file binary bundled with
// the Electron app.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.SKIP_BACKEND_BUILD === "1") {
  console.log("[build-backend] SKIP_BACKEND_BUILD=1, skipping bundled backend rebuild");
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const backendDir = path.resolve(appRoot, "..", "backend");
const resourcesDir = path.join(appRoot, "resources");
const backendOutfile = path.join(resourcesDir, "taskboard");
const weixinBridgeOutfile = path.join(resourcesDir, "weixin-bridge");

fs.mkdirSync(resourcesDir, { recursive: true });

function runBuild(label: string, args: string[]): void {
  console.log(`[build-backend] Compiling ${label}...`);
  const result = spawnSync("bun", args, {
    cwd: backendDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runBuild("Bun backend binary", ["build", "--compile", "taskboard.ts", "--outfile", backendOutfile]);
console.log(`[build-backend] Backend binary written to ${backendOutfile}`);

runBuild("Weixin bridge binary", [
  "build",
  "--compile",
  path.join("src", "channels", "weixin_bridge", "index.ts"),
  "--outfile",
  weixinBridgeOutfile,
]);
console.log(`[build-backend] Weixin bridge binary written to ${weixinBridgeOutfile}`);
