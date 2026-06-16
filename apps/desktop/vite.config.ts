import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  base: "./",
  plugins: [vue()],
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
