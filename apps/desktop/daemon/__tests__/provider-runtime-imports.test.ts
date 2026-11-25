import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The provider runtime is imported by one name, "#provider-runtime/<file>.js".
// Source tests must load the TypeScript source, also when an older build
// output is on disk. Compiled code must load the build output, with no source
// folder and no TypeScript loader. This file proves both with the real
// "imports" entry of the desktop package.json, in a temporary package.

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
  imports?: Record<string, unknown>;
};
const SOURCE_CONDITION = "letagents-source";
const tsxLoader = import.meta.resolve("tsx");

function temporaryPackage(): string {
  const root = mkdtempSync(join(tmpdir(), "letagents-provider-runtime-imports-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", imports: desktopPackage.imports }));
  mkdirSync(join(root, "provider-runtime"));
  mkdirSync(join(root, "dist-provider-runtime"));
  mkdirSync(join(root, "consumer"));
  writeFileSync(join(root, "provider-runtime", "probe.ts"), `export const origin: string = "source";\n`);
  writeFileSync(join(root, "dist-provider-runtime", "probe.js"), `export const origin = "old build output";\n`);
  writeFileSync(
    join(root, "consumer", "main.js"),
    `import { origin } from "#provider-runtime/probe.js";\nprocess.stdout.write(origin);\n`,
  );
  return root;
}

function run(root: string, nodeArguments: string[]): string {
  return execFileSync(process.execPath, [...nodeArguments, join(root, "consumer", "main.js")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
}

test("the desktop package declares the provider runtime import with a source condition", () => {
  const entry = desktopPackage.imports?.["#provider-runtime/*.js"] as Record<string, string> | undefined;
  assert.ok(entry, "apps/desktop/package.json must declare #provider-runtime/*.js");
  assert.deepEqual(Object.keys(entry), [SOURCE_CONDITION, "types", "default"]);
  assert.equal(entry[SOURCE_CONDITION], "./provider-runtime/*.ts");
  assert.equal(entry.default, "./dist-provider-runtime/*.js");
});

test("this test process itself runs with the source condition", () => {
  // The supported test commands pass the condition. Without it a source test
  // would load the build output of the provider runtime, which can be old.
  assert.match(
    import.meta.resolve("#provider-runtime/provider-probe-cache.js"),
    /\/provider-runtime\/provider-probe-cache\.ts$/,
  );
});

test("a source run loads the source, also when an old build output exists", () => {
  const root = temporaryPackage();
  try {
    assert.equal(run(root, [`--conditions=${SOURCE_CONDITION}`, "--import", tsxLoader]), "source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compiled run loads the build output, with no source folder and no TypeScript loader", () => {
  const root = temporaryPackage();
  try {
    rmSync(join(root, "provider-runtime"), { recursive: true, force: true });
    assert.equal(run(root, []), "old build output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
