const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  packagerConfig: {
    asar: true,
    name: "AgentForge",
    appBundleId: "com.agentforge.app",
    extraResource: ["./resources/taskboard"],
    // Bun builds the app into .bun/ (see scripts/build.ts); ship only the
    // built output, package.json, and pruned node_modules.
    ignore: [
      /^\/src/,
      /^\/scripts/,
      /^\/resources/,
      /^\/index\.html$/,
      /^\/tsconfig.*\.json$/,
      /^\/eslint\.config\.mjs$/,
      /^\/bun\.lock$/,
      /^\/package-lock\.json$/,
      /^\/\.vite/,
      /^\/out/,
    ],
    osxSign: {
      // "-" is codesign's ad-hoc identity, not a keychain certificate name.
      identity: "-",
      identityValidation: false,
      continueOnError: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
      }),
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
