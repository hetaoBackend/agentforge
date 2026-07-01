# Installation Troubleshooting

This guide covers the most common issues when installing or building AgentForge's Electrobun desktop app.

## `bun install` Or `bun run build:check` Hangs

The first Electrobun build can download native Electrobun CLI/core artifacts from GitHub releases. On slow networks this can look idle for a few minutes.

Start with:

```bash
cd taskboard-electron
bun install --registry https://registry.npmmirror.com
bun run build:check
```

If the build stalls while Electrobun downloads native artifacts, use a VPN or retry once the GitHub release download is reachable.

## Clean Install

```bash
cd taskboard-electron
rm -rf node_modules build artifacts .bun
rm -f bun.lock
bun pm cache rm
bun install
```

## Build Tools

Electrobun and Bun may need platform build tools for native packaging or icon generation.

macOS:

```bash
xcode-select --install
```

Linux:

```bash
sudo apt-get install build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
```

Windows:

Install Visual Studio Build Tools with the "Desktop development with C++" workload.

## Bun Version

AgentForge requires Bun 1.3 or later:

```bash
bun -v
```

Upgrade with:

```bash
bun upgrade
```

## Verify Installation

```bash
cd taskboard-electron
bun run typecheck
bun run build:check
bun run start
```

The development app is built under `taskboard-electron/build/dev-*`. Stable DMGs are built with:

```bash
cd taskboard-electron
bun run make
```

## Reporting Issues

Include:

```bash
bun -v
uname -a
cd taskboard-electron && bun run build:check
```
