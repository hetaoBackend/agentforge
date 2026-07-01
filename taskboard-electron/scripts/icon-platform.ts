export function resolveIconPlatform(): NodeJS.Platform | string {
  return process.env.AGENTFORGE_ICON_PLATFORM || process.platform;
}

export function shouldGenerateIcns(platform = resolveIconPlatform()): boolean {
  return platform === "darwin";
}
