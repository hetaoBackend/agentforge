import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "AgentForge",
    identifier: "com.agentforge.app",
    version: "1.0.0",
    description: "Kanban task board for orchestrating AI coding agents",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    buildFolder: "build",
    artifactFolder: "artifacts",
    useAsar: false,
    bun: {
      entrypoint: "src/electrobun/index.ts",
      sourcemap: "linked",
    },
    views: {
      main: {
        entrypoint: "src/renderer/index.tsx",
        sourcemap: "linked",
        define: { "process.env.NODE_ENV": '"production"' },
      },
    },
    copy: {
      "src/electrobun/index.html": "views/main/index.html",
      "src/index.css": "views/main/index.css",
      assets: "views/main/assets",
      "resources/weixin-bridge": "resources/weixin-bridge",
      "../vendor/skill-creator": "vendor/skill-creator",
    },
    watch: ["../backend/src", "../backend/taskboard.ts", "../vendor/skill-creator"],
    watchIgnore: ["resources/taskboard"],
    mac: {
      codesign: false,
      createDmg: true,
      notarize: false,
      bundleCEF: false,
      icons: "",
    },
    linux: {
      bundleCEF: false,
      icon: "assets/agentforge.png",
    },
  },
  scripts: {
    preBuild: "./scripts/build-electrobun-resources.ts",
    postBuild: "./scripts/install-mac-app-icon.ts",
    postWrap: "./scripts/install-mac-app-icon.ts",
    postPackage: "./scripts/install-mac-app-icon.ts",
  },
} satisfies ElectrobunConfig;
