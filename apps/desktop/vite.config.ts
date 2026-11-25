import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import rendererBundledPackages from "./renderer-bundled-packages.json";

type BundledPackages = Record<string, { notices: string[] }>;

/** The licence files of every package that Vite bundles into dist-renderer. */
function rendererNoticeFiles(): string[] {
  const packages: BundledPackages = { ...rendererBundledPackages.packages, ...rendererBundledPackages.bundledDependencies };
  return Object.entries(packages).flatMap(([name, { notices }]) => notices.map(file => `${name}/${file}`));
}

export default defineConfig({
  base: "./",
  plugins: [vue({
    // Electron's <webview> tag: Vue should leave it alone.
    template: { compilerOptions: { isCustomElement: (tag) => tag === "webview" } },
  }), {
    name: "workspace-reader-notices",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "agent-identity-notices.txt", source: readFileSync(new URL("../../shared/ui/agent-identity/scene/assets/brain/ATTRIBUTION.txt", import.meta.url), "utf8") });
      // The packaged app does not install the bundled packages, so their licences ship here.
      const files = rendererNoticeFiles();
      this.emitFile({ type: "asset", fileName: "workspace-reader-notices.txt", source: files.map(file =>
        `${file}\n\n${readFileSync(new URL(`./node_modules/${file}`, import.meta.url), "utf8")}`,
      ).join("\n\n") });
    },
  }],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  resolve: {
    dedupe: ["vue", "three", "marked", "dompurify", "highlight.js"],
    alias: {
      "@": fileURLToPath(new URL("./renderer/src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
  },
});
