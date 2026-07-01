import { describe, expect, test } from "bun:test";

import electrobunConfig from "../../electrobun.config.ts";
import { shouldGenerateIcns } from "../../scripts/icon-platform.ts";
import {
  applyBackendResourceEnv,
  resolveElectrobunResourceDir,
  resolveRuntimePaths,
} from "./paths.ts";

const packageJson = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
  scripts: Record<string, string>;
};

describe("Electrobun runtime paths", () => {
  test("Bun host entrypoint matches Electrobun launcher filename contract", () => {
    expect(electrobunConfig.build.bun.entrypoint).toBe("src/electrobun/index.ts");
  });

  test("main view entrypoint matches HTML script filename contract", () => {
    expect(electrobunConfig.build.views.main.entrypoint).toBe("src/renderer/index.tsx");
  });

  test("mac app icon avoids Electrobun iconutil and is installed by lifecycle hooks", () => {
    expect(electrobunConfig.build.mac?.icons).toBe("");
  });

  test("lifecycle hooks install the mac app icon into bundle resources", () => {
    expect(electrobunConfig.scripts.postBuild).toBe("./scripts/install-mac-app-icon.ts");
    expect(electrobunConfig.scripts.postWrap).toBe("./scripts/install-mac-app-icon.ts");
    expect(electrobunConfig.scripts.postPackage).toBe("./scripts/install-mac-app-icon.ts");
  });

  test("package scripts install mac app icons after Electrobun writes final bundles", () => {
    expect(packageJson.scripts.start).toBe("bun scripts/electrobun-dev.ts");
    expect(packageJson.scripts.build).toBe("bun scripts/electrobun-build.ts");
    expect(packageJson.scripts.build).toBe(packageJson.scripts["build:check"]);
    expect(packageJson.scripts.make).toBe("bun scripts/electrobun-build.ts --env=stable");
  });

  test("app icon generation only uses icns tooling on macOS", () => {
    expect(shouldGenerateIcns("darwin")).toBe(true);
    expect(shouldGenerateIcns("linux")).toBe(false);
    expect(shouldGenerateIcns("win32")).toBe(false);
  });

  test("resolveElectrobunResourceDir resolves beside the executable directory", () => {
    expect(resolveElectrobunResourceDir("/Applications/AgentForge.app/Contents/MacOS")).toBe(
      "/Applications/AgentForge.app/Contents/Resources",
    );
  });

  test("resolveRuntimePaths points packaged resources at Electrobun Resources", () => {
    const paths = resolveRuntimePaths("/Applications/AgentForge.app/Contents/MacOS");

    expect(paths.resourcesDir).toBe("/Applications/AgentForge.app/Contents/Resources");
    expect(paths.appResourcesDir).toBe("/Applications/AgentForge.app/Contents/Resources/app");
    expect(paths.weixinBridge).toBe(
      "/Applications/AgentForge.app/Contents/Resources/app/resources/weixin-bridge",
    );
    expect(paths.skillCreatorDir).toBe(
      "/Applications/AgentForge.app/Contents/Resources/app/vendor/skill-creator",
    );
  });

  test("applyBackendResourceEnv preserves unrelated env and sets backend resource overrides", () => {
    const env = applyBackendResourceEnv(
      { PATH: "/usr/bin", AGENTFORGE_WEIXIN_BRIDGE: "/custom/bridge" },
      resolveRuntimePaths("/App/Contents/MacOS"),
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.AGENTFORGE_WEIXIN_BRIDGE).toBe("/custom/bridge");
    expect(env.AGENTFORGE_SKILL_CREATOR_DIR).toBe(
      "/App/Contents/Resources/app/vendor/skill-creator",
    );
  });
});
