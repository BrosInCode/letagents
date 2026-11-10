import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const lazyViewStylesPrefix = "lazy-view-styles:";
const stylesheetModule = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(\?|$)/;
const nonStylesheetQuery = /[?&](inline|raw|url)(&|$)/;

/**
 * `import "lazy-view-styles:./View.vue"` keeps the stylesheets of a view that loads
 * on demand in the entry CSS, at the place its static import had, so the
 * cascade order of every rule stays as it was. Only the view's JavaScript is
 * split off. In dev the line imports the view itself, as the static import did.
 */
function lazyViewStyles(): Plugin {
  let command: "build" | "serve" = "build";
  return {
    name: "lazy-view-styles",
    enforce: "pre",
    configResolved(config) {
      command = config.command;
    },
    async resolveId(source, importer) {
      if (source.startsWith(`\0${lazyViewStylesPrefix}`)) return source;
      if (!source.startsWith(lazyViewStylesPrefix)) return null;
      const target = await this.resolve(source.slice(lazyViewStylesPrefix.length), importer, { skipSelf: true });
      if (!target) throw new Error(`lazy-view-styles: cannot resolve ${source} from ${importer}`);
      return `\0${lazyViewStylesPrefix}${target.id}`;
    },
    async load(id) {
      if (!id.startsWith(`\0${lazyViewStylesPrefix}`)) return null;
      const target = id.slice(lazyViewStylesPrefix.length + 1);
      if (command === "serve") return `import ${JSON.stringify(target)};`;
      // Rollup runs a module after its static imports, in import order; stylesheets
      // are concatenated in that order. Walk the view's static graph the same way.
      const styles: string[] = [];
      const seen = new Set<string>();
      const visit = async (moduleId: string): Promise<void> => {
        if (seen.has(moduleId)) return;
        seen.add(moduleId);
        const info = await this.load({ id: moduleId, resolveDependencies: true });
        for (const dependency of info.importedIds) await visit(dependency);
        if (stylesheetModule.test(moduleId) && !nonStylesheetQuery.test(moduleId)) {
          styles.push(moduleId);
          // A CSS module is free of side effects, so a bare import would not keep it
          // (and its CSS) in the entry; it is imported here for its CSS alone.
          info.moduleSideEffects = "no-treeshake";
        }
      };
      await visit(target);
      return styles.map((style) => `import ${JSON.stringify(style)};`).join("\n");
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [lazyViewStyles(), vue({
    // Electron's <webview> tag: Vue should leave it alone.
    template: { compilerOptions: { isCustomElement: (tag) => tag === "webview" } },
  }), {
    name: "workspace-reader-notices",
    generateBundle() {
      const files = [
        "monaco-editor/LICENSE",
        "monaco-editor/ThirdPartyNotices.txt",
        "dompurify/LICENSE",
        "highlight.js/LICENSE",
      ];
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
    dedupe: ["vue"],
    alias: {
      "@": fileURLToPath(new URL("./renderer/src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist-renderer",
    emptyOutDir: true,
  },
});
