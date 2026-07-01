import path from "node:path";

export interface ElectrobunRuntimePaths {
  executableDir: string;
  resourcesDir: string;
  appResourcesDir: string;
  weixinBridge: string;
  skillCreatorDir: string;
}

export function resolveElectrobunResourceDir(executableDir = process.cwd()): string {
  return path.resolve(executableDir, "..", "Resources");
}

export function resolveRuntimePaths(executableDir = process.cwd()): ElectrobunRuntimePaths {
  const resourcesDir = resolveElectrobunResourceDir(executableDir);
  const appResourcesDir = path.join(resourcesDir, "app");
  return {
    executableDir,
    resourcesDir,
    appResourcesDir,
    weixinBridge: path.join(appResourcesDir, "resources", "weixin-bridge"),
    skillCreatorDir: path.join(appResourcesDir, "vendor", "skill-creator"),
  };
}

export function applyBackendResourceEnv(
  env: NodeJS.ProcessEnv,
  paths: ElectrobunRuntimePaths,
): NodeJS.ProcessEnv {
  return {
    ...env,
    AGENTFORGE_WEIXIN_BRIDGE: env.AGENTFORGE_WEIXIN_BRIDGE || paths.weixinBridge,
    AGENTFORGE_SKILL_CREATOR_DIR: env.AGENTFORGE_SKILL_CREATOR_DIR || paths.skillCreatorDir,
  };
}
