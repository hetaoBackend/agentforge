// Compile the Bun TypeScript backend into a single-file binary bundled with
// the Electron app (replaces the PyInstaller build of taskboard.py).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.SKIP_BACKEND_BUILD === "1") {
  console.log("[build-backend] SKIP_BACKEND_BUILD=1, skipping bundled backend rebuild");
  process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const backendDir = path.resolve(appRoot, "..", "backend");
const outfile = path.join(appRoot, "resources", "taskboard");

console.log("[build-backend] Compiling Bun backend binary...");

const result = spawnSync("bun", ["build", "--compile", "taskboard.ts", "--outfile", outfile], {
  cwd: backendDir,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`[build-backend] Backend binary written to ${outfile}`);
