import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// DesktopRoomShell.vue keeps its layout template and wiring; its script logic
// lives in composables/room-shell/. Source contracts read the shell as it reads
// as one component: the template, then one <script setup> with the shell's own
// script followed by every composable's statements, without the context wiring
// (the `app.` prefix that composables use to read each other's names).
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const shellPath = `${sourceRoot}components/desktop/content/DesktopRoomShell.vue`;
const composablesPath = `${sourceRoot}composables/room-shell/`;

function composableStatements(): string[] {
  if (!existsSync(composablesPath)) return [];
  const statements: string[] = [];
  for (const name of readdirSync(composablesPath).filter((file) => file.endsWith(".ts")).sort()) {
    const text = readFileSync(`${composablesPath}${name}`, "utf8");
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    for (const top of file.statements) {
      if (!ts.isFunctionDeclaration(top) || !top.body) continue;
      for (const statement of top.body.statements) {
        if (isContextWiring(statement, file)) continue;
        // Keep the comments that lead the statement, as they read in the component.
        const text = statement.getFullText(file).replace(/^\s*\n/, "").replace(/^\s+/, "  ");
        statements.push(unwire(text).split("\n").map((line) => line.replace(/^ {2}/, "")).join("\n"));
      }
    }
  }
  return statements;
}

/** Undo the context wiring of names: `{ name: app.name }` -> `{ name }`, `app.name` -> `name`. */
function unwire(text: string): string {
  return text
    .replace(/(?<=[{,]\s*)([A-Za-z_$][\w$]*): app\.\1\b/g, "$1")
    .replace(/(?<![\w$.])app\.(?=[A-Za-z_$])/g, "");
}

function isContextWiring(statement: ts.Statement, file: ts.SourceFile): boolean {
  if (ts.isReturnStatement(statement)) return true;
  if (ts.isExpressionStatement(statement)) return /^Object\.assign\(app, /.test(statement.getText(file));
  if (!ts.isVariableStatement(statement)) return false;
  const initializer = statement.declarationList.declarations[0]?.initializer;
  return Boolean(initializer && ts.isAsExpression(initializer) && initializer.expression.getText(file) === "context");
}

/** DesktopRoomShell.vue with its composables' statements folded back into its script. */
export function roomShellSource(): string {
  const shell = readFileSync(shellPath, "utf8");
  const end = shell.lastIndexOf("</script>");
  const folded = composableStatements();
  return folded.length ? `${shell.slice(0, end)}\n${folded.join("\n")}\n${shell.slice(end)}` : shell;
}
