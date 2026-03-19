import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.SKIP_BACKEND_BUILD === "1") {
  console.log("[build-backend] SKIP_BACKEND_BUILD=1, skipping bundled backend rebuild");
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..", "..");

console.log("[build-backend] Rebuilding bundled Python backend...");

const result = spawnSync("make", ["build-backend"], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
