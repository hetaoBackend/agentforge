// Bun bundler pipeline for the Electron app (replaces @electron-forge/plugin-vite).
// Outputs:
//   .bun/build/main.js      - Electron main process (CJS, electron external)
//   .bun/build/preload.js   - context-bridge preload (CJS)
//   .bun/renderer/index.html (+ hashed assets) - React renderer
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function reportFailure(label: string, result: Awaited<ReturnType<typeof Bun.build>>): never {
  console.error(`[build] ${label} failed`);
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

export async function buildMain(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.join(appRoot, "src/main.ts")],
    outdir: path.join(appRoot, ".bun/build"),
    target: "node",
    format: "cjs",
    // Runtime deps resolved from packaged node_modules; electron is provided
    // by the Electron runtime itself.
    external: ["electron", "electron-squirrel-startup", "chokidar"],
    sourcemap: "linked",
    throw: false,
  });
  if (!result.success) reportFailure("main", result);
  console.log("[build] main -> .bun/build/main.js");
}

export async function buildPreload(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.join(appRoot, "src/preload.ts")],
    outdir: path.join(appRoot, ".bun/build"),
    target: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: "linked",
    throw: false,
  });
  if (!result.success) reportFailure("preload", result);
  console.log("[build] preload -> .bun/build/preload.js");
}

export async function buildRenderer(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [path.join(appRoot, "index.html")],
    outdir: path.join(appRoot, ".bun/renderer"),
    target: "browser",
    sourcemap: "linked",
    define: { "process.env.NODE_ENV": '"production"' },
    throw: false,
  });
  if (!result.success) reportFailure("renderer", result);
  console.log("[build] renderer -> .bun/renderer/index.html");
}

export async function buildAll(): Promise<void> {
  await Promise.all([buildMain(), buildPreload(), buildRenderer()]);
}

if (import.meta.main) {
  await buildAll();
}
