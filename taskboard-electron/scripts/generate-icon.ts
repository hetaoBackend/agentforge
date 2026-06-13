import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

type Pixel = [number, number, number, number];

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(appRoot, "assets");
const sourcePath = path.join(assetsDir, "agentforge-source.png");
const iconsetDir = path.join(assetsDir, "agentforge.iconset");
const pngPath = path.join(assetsDir, "agentforge.png");
const icnsPath = path.join(assetsDir, "agentforge.icns");

const iconSpecs = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function sample(source: typeof PNG, x: number, y: number): Pixel {
  const x0 = clamp(Math.floor(x), 0, source.width - 1);
  const y0 = clamp(Math.floor(y), 0, source.height - 1);
  const x1 = clamp(x0 + 1, 0, source.width - 1);
  const y1 = clamp(y0 + 1, 0, source.height - 1);
  const tx = x - x0;
  const ty = y - y0;

  const read = (px: number, py: number): Pixel => {
    const idx = (py * source.width + px) * 4;
    return [
      source.data[idx],
      source.data[idx + 1],
      source.data[idx + 2],
      source.data[idx + 3] ?? 255,
    ];
  };

  const c00 = read(x0, y0);
  const c10 = read(x1, y0);
  const c01 = read(x0, y1);
  const c11 = read(x1, y1);

  return [0, 1, 2, 3].map((channel) => {
    const top = c00[channel] * (1 - tx) + c10[channel] * tx;
    const bottom = c01[channel] * (1 - tx) + c11[channel] * tx;
    return Math.round(top * (1 - ty) + bottom * ty);
  }) as Pixel;
}

function appIconMask(x: number, y: number, size: number): number {
  const inset = size * 0.055;
  const radius = size * 0.215;
  const half = (size - inset * 2) / 2;
  const qx = Math.abs(x - size / 2) - (half - radius);
  const qy = Math.abs(y - size / 2) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const distance = outside + inside - radius;
  return 1 - smoothstep(-1.1, 1.1, distance);
}

function renderIcon(source: typeof PNG, size: number): Buffer {
  const output = new PNG({ width: size, height: size });
  const scale = Math.min(source.width, source.height);
  const offsetX = (source.width - scale) / 2;
  const offsetY = (source.height - scale) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const srcX = offsetX + ((x + 0.5) / size) * scale - 0.5;
      const srcY = offsetY + ((y + 0.5) / size) * scale - 0.5;
      const [red, green, blue, alpha] = sample(source, srcX, srcY);
      const mask = appIconMask(x + 0.5, y + 0.5, size);
      const idx = (y * size + x) * 4;

      output.data[idx] = red;
      output.data[idx + 1] = green;
      output.data[idx + 2] = blue;
      output.data[idx + 3] = Math.round(alpha * mask);
    }
  }

  return PNG.sync.write(output);
}

await mkdir(assetsDir, { recursive: true });
await rm(iconsetDir, { recursive: true, force: true });
await mkdir(iconsetDir, { recursive: true });

const source = PNG.sync.read(Buffer.from(await Bun.file(sourcePath).arrayBuffer()));

for (const [name, size] of iconSpecs) {
  const png = renderIcon(source, size);
  await writeFile(path.join(iconsetDir, name), png);
  if (size === 1024) await writeFile(pngPath, png);
}

const result = Bun.spawnSync(["iconutil", "-c", "icns", iconsetDir, "-o", icnsPath], {
  stdout: "pipe",
  stderr: "pipe",
});

if (!result.success) {
  console.error(new TextDecoder().decode(result.stderr));
  process.exit(result.exitCode || 1);
}

await rm(iconsetDir, { recursive: true, force: true });
console.log(
  `[icon] wrote ${path.relative(appRoot, pngPath)} and ${path.relative(appRoot, icnsPath)}`,
);
