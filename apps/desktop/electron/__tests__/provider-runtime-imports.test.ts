import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Two rules of the provider runtime package, see
// daemon/__tests__/provider-runtime-imports.test.ts for the resolution proof.

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("this test process itself runs with the source condition", () => {
  // The supported test commands pass --conditions=letagents-source. Without
  // it a source test would load the build output of the provider runtime,
  // which can be old.
  assert.match(
    import.meta.resolve("#provider-runtime/provider-probe-cache.js"),
    /\/provider-runtime\/provider-probe-cache\.ts$/,
    "run the desktop tests through the npm test scripts, or pass --conditions=letagents-source",
  );
});

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith("dist-") || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (/\.(ts|mts|cts|mjs|cjs|js|vue)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("code outside the provider runtime imports it only by the # name", () => {
  // A relative import and the # name can load two copies of one module in one
  // process: one from the source and one from the build output. Module state
  // such as a cache then splits in two.
  const relativeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](?:\.\.?\/)+(?:[^"']*\/)?(?:dist-)?provider-runtime\//;
  const offenders: string[] = [];
  for (const file of sourceFiles(desktopRoot)) {
    const path = relative(desktopRoot, file).split(sep).join("/");
    if (path.startsWith("provider-runtime/")) continue;
    if (relativeImport.test(readFileSync(file, "utf8"))) offenders.push(path);
  }
  assert.deepEqual(offenders, [], "import the provider runtime as \"#provider-runtime/<file>.js\"");
});

test("the provider runtime imports nothing from the daemon or Electron folders", () => {
  const backwardImport = /(?:from\s+|import\s*\(\s*|import\s+)["'](?:\.\.\/)+(?:electron|daemon|renderer)\//;
  const offenders = sourceFiles(join(desktopRoot, "provider-runtime"))
    .filter((file) => backwardImport.test(readFileSync(file, "utf8")))
    .map((file) => relative(desktopRoot, file).split(sep).join("/"));
  assert.deepEqual(offenders, []);
});

test("the daemon names no adapter file in the Electron build", () => {
  // The adapters moved from electron/main/agents to provider-runtime/agents.
  // A path into dist-electron/main/agents would load nothing in a packaged
  // app. The supervision runtime (main/rooms) is the one path that remains,
  // until it moves too.
  const offenders = sourceFiles(join(desktopRoot, "daemon"))
    .filter((file) => !file.split(sep).includes("__tests__"))
    .filter((file) => /dist-electron\/main\/agents|electron\/main\/agents/.test(readFileSync(file, "utf8")))
    .map((file) => relative(desktopRoot, file).split(sep).join("/"));
  assert.deepEqual(offenders, []);
});

test("a test that starts a TypeScript child process gives it the source condition", () => {
  // A child process does not get the conditions of its parent. Without the
  // condition, "#provider-runtime/<file>.js" in the child means the build
  // output. CI runs the tests with no build, so the child cannot load it; a
  // machine with a build loads code that can be old.
  const startsTsx = /\[\s*(["'])--import\1\s*,\s*(?:(["'])tsx\2|tsx[A-Za-z]*)/;
  const offenders: string[] = [];
  for (const folder of ["electron/__tests__", "daemon/__tests__", "renderer/__tests__"]) {
    for (const file of sourceFiles(join(desktopRoot, folder))) {
      if (!/\.test\.ts$/.test(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (startsTsx.test(line)) offenders.push(`${relative(desktopRoot, file).split(sep).join("/")}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], "start the child with \"--conditions=letagents-source\" before \"--import\", \"tsx\"");
});
