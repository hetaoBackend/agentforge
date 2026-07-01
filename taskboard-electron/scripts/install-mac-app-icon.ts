import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallMacAppIconOptions {
  allowMissingBuildDir?: boolean;
  appRoot?: string;
  buildDir?: string;
  quiet?: boolean;
  targetOS?: string;
  wrapperBundlePath?: string;
}

const defaultAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveFromAppRoot(appRoot: string, targetPath: string): string {
  return path.resolve(appRoot, targetPath);
}

function resolveBuildDirs(appRoot: string, explicitBuildDir?: string): string[] {
  if (explicitBuildDir) {
    return [resolveFromAppRoot(appRoot, explicitBuildDir)];
  }

  const buildRoot = path.join(appRoot, "build");
  if (!existsSync(buildRoot)) {
    return [];
  }

  return readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("-macos-"))
    .map((entry) => path.join(buildRoot, entry.name));
}

function needsInstall(sourceIcon: string, destinationIcon: string): boolean {
  if (!existsSync(destinationIcon)) {
    return true;
  }

  const sourceStats = statSync(sourceIcon);
  const destinationStats = statSync(destinationIcon);
  return destinationStats.size !== sourceStats.size || destinationStats.size === 0;
}

export function installMacAppIcon(options: InstallMacAppIconOptions = {}): string[] {
  const targetOS = options.targetOS ?? process.env.ELECTROBUN_OS;
  if (targetOS && targetOS !== "macos") {
    if (!options.quiet) console.log(`[install-icon] Skipping app icon for ${targetOS}`);
    return [];
  }

  const appRoot = options.appRoot ?? defaultAppRoot;
  const sourceIcon = path.join(appRoot, "assets", "agentforge.icns");
  const buildDirs = resolveBuildDirs(appRoot, options.buildDir ?? process.env.ELECTROBUN_BUILD_DIR);
  const wrapperBundlePath = options.wrapperBundlePath ?? process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;

  if (!existsSync(sourceIcon)) {
    throw new Error(`App icon source does not exist: ${sourceIcon}`);
  }

  if (buildDirs.length === 0) {
    if (options.allowMissingBuildDir) return [];
    throw new Error(
      `No Electrobun macOS build directories found under ${path.join(appRoot, "build")}`,
    );
  }

  const appBundlePaths = new Set<string>();

  if (wrapperBundlePath) {
    appBundlePaths.add(resolveFromAppRoot(appRoot, wrapperBundlePath));
  }

  for (const buildDir of buildDirs) {
    if (!existsSync(buildDir)) {
      if (options.allowMissingBuildDir) continue;
      throw new Error(`Electrobun build directory does not exist: ${buildDir}`);
    }

    for (const entry of readdirSync(buildDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        appBundlePaths.add(path.join(buildDir, entry.name));
      }
    }
  }

  if (appBundlePaths.size === 0) {
    if (options.allowMissingBuildDir) return [];
    throw new Error(`No macOS .app bundle found in ${buildDirs.join(", ")}`);
  }

  const installedIcons: string[] = [];
  for (const appBundlePath of appBundlePaths) {
    if (!existsSync(appBundlePath)) {
      if (options.allowMissingBuildDir) continue;
      throw new Error(`macOS .app bundle does not exist: ${appBundlePath}`);
    }

    const destinationIcon = path.join(appBundlePath, "Contents", "Resources", "AppIcon.icns");

    if (!needsInstall(sourceIcon, destinationIcon)) {
      continue;
    }

    mkdirSync(path.dirname(destinationIcon), { recursive: true });
    copyFileSync(sourceIcon, destinationIcon);

    const iconSize = statSync(destinationIcon).size;
    if (iconSize === 0) {
      throw new Error(`Installed app icon is empty: ${destinationIcon}`);
    }

    installedIcons.push(destinationIcon);
    if (!options.quiet) console.log(`[install-icon] Installed ${destinationIcon}`);
  }

  return installedIcons;
}

if (import.meta.main) {
  installMacAppIcon();
}
