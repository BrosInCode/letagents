/** Make a dependency-free evaluator from a fixed allowlist. Never reads credentials. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const sources = [
  "scripts/room-acknowledgment-eval.ts",
  "src/api/messages/jev-acknowledgment.ts",
  "src/api/messages/jev-conversation-routing.ts",
];
const allowedImports = new Set([
  "node:fs/promises", "../src/api/messages/jev-conversation-routing.js",
  "../src/api/messages/jev-acknowledgment.js",
]);

export async function prepareEvaluator(destination) {
  // Require a new directory: never overwrite a checkout or deployed code.
  await mkdir(destination, { mode: 0o700 });
  for (const relative of sources) {
    const source = await readFile(join(root, relative), "utf8");
    const compiled = ts.transpileModule(source, {
      fileName: relative,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    const tree = ts.createSourceFile(relative, compiled, ts.ScriptTarget.ES2022, true);
    const check = node => {
      if (ts.isImportDeclaration(node) && !allowedImports.has(node.moduleSpecifier.text)) {
        throw new Error(`Unexpected evaluator import in ${relative}`);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier
        || ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        throw new Error(`Unexpected evaluator module loading in ${relative}`);
      }
      ts.forEachChild(node, check);
    };
    check(tree);
    const output = join(destination, relative.replace(/\.ts$/, ".js"));
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, compiled, { mode: 0o600 });
  }
  for (const fixture of ["cases", "holdout"]) {
    const relative = `scripts/room-acknowledgment-eval.${fixture}.json`;
    const cases = await readFile(join(root, relative), "utf8");
    if (JSON.parse(cases).length !== 36) throw new Error("Review the evaluation budget when changing its 36 cases per suite.");
    await writeFile(join(destination, relative), cases, { mode: 0o600 });
  }
  await writeFile(join(destination, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error("Usage: prepare-room-ack-eval.mjs NEW_DIRECTORY");
  await prepareEvaluator(resolve(process.argv[2]));
}
