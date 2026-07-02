# Installation Troubleshooting

This guide covers the most common issues when installing or building AgentForge's Electrobun desktop app.

## `bun: command not found`

AgentForge's source workflow expects `bun` to be available on `PATH`. If Bun is installed under the default macOS location but your shell cannot find it, add this to `~/.zshrc`:

```zsh
export BUN_INSTALL="$HOME/.bun"
case ":$PATH:" in
  *":$BUN_INSTALL/bin:"*) ;;
  *) export PATH="$BUN_INSTALL/bin:$PATH" ;;
esac
```

Then reload the shell and verify:

```bash
source ~/.zshrc
command -v bun
bun --version
```

## Missing Backend Dependencies

When running the desktop app from source, install dependencies in both packages:

```bash
cd backend
bun install --frozen-lockfile

cd ../taskboard-electron
bun install --frozen-lockfile
bun run start
```

The desktop host imports backend TypeScript directly. If `backend/node_modules` is missing, startup can fail with an error such as `Cannot find package 'cron-parser'`.

## Port `9712` Already In Use

The desktop app starts the backend in-process on `127.0.0.1:9712`. If you previously started the backend directly, stop it before launching the desktop app.

Check the port with:

```bash
lsof -nP -iTCP:9712 -sTCP:LISTEN
```

If a standalone `bun taskboard.ts` process is listening there, stop that terminal process and run the desktop app again.

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

From the repository root:

```bash
cd backend
rm -rf node_modules
bun pm cache rm
bun install --frozen-lockfile

cd ../taskboard-electron
rm -rf node_modules build artifacts .bun
bun install --frozen-lockfile
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
cd backend
bun install --frozen-lockfile

cd ../taskboard-electron
bun install --frozen-lockfile
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
