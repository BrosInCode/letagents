import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

export default defineConfig({
  base: "./",
  plugins: [vue(), {
    name: "workspace-reader-notices",
    generateBundle() {
      const files = ["monaco-editor/LICENSE", "monaco-editor/ThirdPartyNotices.txt", "dompurify/LICENSE"];
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
    alias: {
      "@": fileURLToPath(new URL("./renderer/src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
  },
});
