import pluginVue from "eslint-plugin-vue";
import tsParser from "@typescript-eslint/parser";

/**
 * Narrow gate: catch used-but-unimported Vue components in templates.
 * vue-tsc does not fail on unresolved template tags (they become unknown
 * native elements at runtime). See focus_32 task_15 / #695.
 */
export default [
  ...pluginVue.configs["flat/base"],
  {
    files: ["renderer/src/**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tsParser,
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      // <webview> is Electron's tag; vite.config.ts tells Vue to leave it alone.
      "vue/no-undef-components": ["error", { ignorePatterns: ["^webview$"] }],
    },
  },
];
