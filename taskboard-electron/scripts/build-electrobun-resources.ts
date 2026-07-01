// Build sidecar resources copied into Electrobun's Resources directory.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.SKIP_ELECTROBUN_RESOURCE_BUILD === "1") {
  console.log("[build-resources] SKIP_ELECTROBUN_RESOURCE_BUILD=1, skipping");
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const backendDir = path.resolve(appRoot, "..", "backend");
const resourcesDir = path.join(appRoot, "resources");
const weixinBridgeOutfile = path.join(resourcesDir, "weixin-bridge");

fs.mkdirSync(resourcesDir, { recursive: true });

console.log("[build-resources] Generating app icons...");
await import("./generate-icon.ts");

console.log("[build-resources] Compiling Weixin bridge binary...");
const result = spawnSync(
  "bun",
  [
    "build",
    "--compile",
    path.join("src", "channels", "weixin_bridge", "index.ts"),
    "--outfile",
    weixinBridgeOutfile,
  ],
  {
    cwd: backendDir,
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`[build-resources] Weixin bridge written to ${weixinBridgeOutfile}`);
