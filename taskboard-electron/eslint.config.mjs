import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      ".vite/**",
      "out/**",
      "node_modules/**",
      "resources/**",
      "dist/**",
      // Throwaway manual hot-reload probe, not part of the app or test suite.
      "test_hot_reload.mjs",
    ],
  },

  js.configs.recommended,

  // Project-wide tweaks: allow `_`-prefixed throwaways and intentional empty
  // catches; permit full-width spaces inside Chinese JSX copy.
  {
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipComments: true, skipTemplates: true, skipJSXText: true },
      ],
    },
  },

  // Node-side code: Electron main/preload, build scripts, Forge/Vite configs.
  {
    files: [
      "src/main.js",
      "src/preload.js",
      "scripts/**/*.mjs",
      "forge.config.js",
      "*.config.js",
      "vite.*.config.mjs",
    ],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        ...globals.node,
        // Injected by the electron-forge Vite plugin at build time.
        MAIN_WINDOW_VITE_DEV_SERVER_URL: "readonly",
        MAIN_WINDOW_VITE_NAME: "readonly",
      },
    },
  },

  // Renderer code: browser context + React/JSX.
  {
    files: ["src/renderer.js", "src/renderer/**/*.{js,jsx,mjs}"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      // New JSX transform — React need not be in scope, props aren't typed here.
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Renderer unit tests run under `node --test`, so they need Node globals too.
  {
    files: ["src/renderer/**/*.test.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Keep ESLint clear of anything Prettier owns (formatting).
  prettier,
];
