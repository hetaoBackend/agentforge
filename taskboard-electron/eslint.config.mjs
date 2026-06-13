import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      ".bun/**",
      "out/**",
      "node_modules/**",
      "resources/**",
      "dist/**",
      // Throwaway manual hot-reload probe, not part of the app or test suite.
    ],
  },

  js.configs.recommended,

  // TypeScript sources (main, preload, renderer, tests, build scripts).
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
  })),

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

  // Pragmatic migration posture: the codebase leans on `any` while strict
  // typing is layered in incrementally.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Node-side code: Electron main/preload, build scripts, Forge config.
  {
    files: ["src/main.ts", "src/preload.ts", "scripts/**/*.ts", "forge.config.js", "*.config.js"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: {
        ...globals.node,
        // Bun runtime globals used by the build scripts (run with `bun`).
        Bun: "readonly",
      },
    },
  },

  // The preload script intentionally uses CommonJS `require` (Electron preload
  // context); main.ts keeps a lazy `require` for a synchronous child_process call.
  {
    files: ["src/main.ts", "src/preload.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // Renderer code: browser context + React/JSX.
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
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

  // Renderer unit tests run under `bun test`, so they need Node globals too.
  {
    files: ["src/renderer/**/*.test.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Keep ESLint clear of anything Prettier owns (formatting).
  prettier,
);
