import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import ts from "typescript";

// App.vue keeps its template and wiring; its script logic lives in composables/app/
// (and a few pure helpers in domain/). Source contracts read them as one text.
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const appFiles = (): string[] => {
  const composables = `${sourceRoot}composables/app/`;
  const files = existsSync(composables)
    ? readdirSync(composables).filter((name) => name.endsWith(".ts")).sort().map((name) => `${composables}${name}`)
    : [];
  const aliases = `${sourceRoot}domain/app-room-aliases.ts`;
  return existsSync(aliases) ? [...files, aliases] : files;
};

/** App.vue followed by every composable and helper its script was split into. */
export function appSource(): string {
  return [`${sourceRoot}App.vue`, ...appFiles()].map((file) => readFileSync(file, "utf8")).join("\n");
}

/** The source of a named function from App.vue's script or its composables, at any depth. */
export function appFunction(name: string): string {
  const scripts = [
    parse(readFileSync(`${sourceRoot}App.vue`, "utf8")).descriptor.scriptSetup!.content,
    ...appFiles().map((file) => readFileSync(file, "utf8")),
  ];
  for (const script of scripts) {
    const file = ts.createSourceFile("app.ts", script, ts.ScriptTarget.Latest, true);
    let found: string | null = null;
    (function visit(node: ts.Node): void {
      if (found) return;
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        found = node.getText(file);
        return;
      }
      ts.forEachChild(node, visit);
    })(file);
    if (found) return found;
  }
  throw new Error(`App function ${name} was not found.`);
}
