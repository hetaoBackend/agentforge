# Installation Troubleshooting

This guide covers the most common issues when installing AgentForge's Electron frontend dependencies.

---

## `bun install` hangs or freezes

This is the most common issue. The terminal appears stuck after a few lines of output, with no error message.

### Why this happens

`bun install` in `taskboard-electron/` triggers two heavy operations:

1. **Electron binary download** — Electron 40 is ~100MB, downloaded from GitHub releases. This is the most common culprit, especially in China or on slow connections.
2. **Native module compilation** — Some packages use `node-gyp` to compile C++ code. This requires build tools and can silently stall if they are missing.

---

## Step 1: Wait first

If this is your first install, give it **3–5 minutes**. The download may still be in progress with no visible output.

---

## Step 2: Diagnose the hang

Open a second terminal while `bun install` is running:

```bash
# Check if bun is actively doing network I/O
lsof -p $(pgrep -f "bun") 2>/dev/null | grep -i net
```

- If you see active connections → it's downloading, just slow. Use the mirror fix below.
- If nothing → it may be stuck on native compilation. See the build tools section.

---

## Fix A: Use mirrors (most common fix)

### For users in China

Set mirrors before installing:

```bash
# npm registry mirror
bun install --registry https://registry.npmmirror.com

# Electron binary mirror (critical — this is what usually hangs)
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

cd taskboard-electron
bun install
```

To make the Electron mirror permanent:

```bash
# Add to ~/.npmrc
echo 'electron_mirror=https://npmmirror.com/mirrors/electron/' >> ~/.npmrc
```

### For users outside China with slow GitHub

Use a VPN, or set a custom Electron mirror:

```bash
export ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/
cd taskboard-electron
bun install
```

---

## Fix B: Clean install

If a previous interrupted install left corrupted cache:

```bash
cd taskboard-electron
rm -rf node_modules
rm -f package-lock.json
bun pm cache rm
bun install
```

---

## Fix C: Missing build tools (native module compilation fails)

Some packages require platform-specific compilers. Install them before running `bun install`.

### macOS

```bash
xcode-select --install
```

If Xcode is already installed but node-gyp still fails:

```bash
sudo xcode-select --switch /Library/Developer/CommandLineTools
```

### Linux (Debian/Ubuntu)

```bash
sudo apt-get install build-essential python3
```

### Windows

Run in an **Administrator** PowerShell:

```powershell
bun install --global windows-build-tools
```

Or install manually:
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload
- Python 3.x (add to PATH)

---

## Fix D: Bun version mismatch

AgentForge requires **Bun 1.3 or later**. Check your version:

```bash
bun -v   # Should be 1.3.x or higher
```

If outdated or missing, install/upgrade from [bun.sh](https://bun.sh/):

```bash
curl -fsSL https://bun.sh/install | bash   # install
bun upgrade                                # or upgrade in place
```

---

## Full reset (if nothing else works)

```bash
cd taskboard-electron

# Clean everything
rm -rf node_modules .bun
rm -f bun.lock

# Set mirrors
bun install --registry https://registry.npmmirror.com
echo 'electron_mirror=https://npmmirror.com/mirrors/electron/' >> ~/.npmrc

# Reinstall
bun pm cache rm
bun install
```

---

## Verify installation succeeded

After `bun install` completes, confirm Electron was downloaded:

```bash
ls taskboard-electron/node_modules/electron/dist/
# Should show: Electron.app (macOS) or electron.exe (Windows) or electron (Linux)
```

Then start the app:

```bash
cd taskboard-electron
bun run start
```

---

## Still stuck?

Collect this information when reporting an issue:

```bash
bun -v
uname -a          # macOS/Linux
cat ~/.npmrc      # electron mirror config, if any
```

Open an issue at: https://github.com/anthropics/agentforge/issues
