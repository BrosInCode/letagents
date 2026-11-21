import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PROVIDER_ADAPTER_ENTRIES } from "./packaged-app-import-check.mjs";
import { isPackagedBuildFile, packagedImports, packagedPackageJson } from "./packaged-imports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const checkPath = join(here, "packaged-app-import-check.mjs");
const desktopPackage = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
const SOURCE_CONDITION = "letagents-source";

test("the packaged import map keeps only the build output target", () => {
  assert.deepEqual(
    packagedImports({
      "#provider-runtime/*.js": {
        [SOURCE_CONDITION]: "./provider-runtime/*.ts",
        types: "./dist-provider-runtime/*.d.ts",
        default: "./dist-provider-runtime/*.js",
      },
      "#plain": "./plain.js",
    }),
    { "#provider-runtime/*.js": "./dist-provider-runtime/*.js", "#plain": "./plain.js" },
  );
  assert.equal(packagedImports(undefined), undefined);
  assert.throws(() => packagedImports({ "#x": { [SOURCE_CONDITION]: "./x.ts" } }), /must be a path or have a default path/);
});

test("the packaged package.json of this repository has no source condition", () => {
  const packaged = packagedPackageJson(desktopPackage);
  assert.ok(Object.keys(packaged.imports).length > 0);
  for (const [name, target] of Object.entries(packaged.imports)) {
    assert.equal(typeof target, "string", `${name} must be a plain path in the packaged app`);
    assert.match(target, /^\.\/dist-/, `${name} must point at a build output folder`);
  }
  assert.doesNotMatch(JSON.stringify(packaged.imports), new RegExp(SOURCE_CONDITION));
  // Everything else is unchanged.
  assert.deepEqual({ ...packaged, imports: undefined }, { ...desktopPackage, imports: undefined });
});

test("declaration files are not part of the packaged build output", () => {
  assert.equal(isPackagedBuildFile("dist-provider-runtime/provider-probe-cache.js"), true);
  assert.equal(isPackagedBuildFile("dist-provider-runtime/provider-probe-cache.d.ts"), false);
  assert.equal(isPackagedBuildFile("dist-provider-runtime/x.d.mts"), false);
  assert.equal(isPackagedBuildFile("dist-provider-runtime/tsconfig.tsbuildinfo"), false);
});

/** A small app folder in the shape of the packaged app. */
function temporaryApp({ imports = packagedPackageJson(desktopPackage).imports, adapterImport = "#provider-runtime/shared.js" } = {}) {
  const app = mkdtempSync(join(tmpdir(), "letagents-packaged-imports-"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module", imports }));
  mkdirSync(join(app, "dist-provider-runtime"));
  mkdirSync(join(app, "dist-electron", "main", "agents"), { recursive: true });
  mkdirSync(join(app, "dist-daemon"));
  writeFileSync(join(app, "dist-provider-runtime", "shared.js"), "export const shared = 1;\n");
  writeFileSync(join(app, "dist-daemon", "main.js"), 'import "#provider-runtime/shared.js";\n');
  for (const [index, entry] of PROVIDER_ADAPTER_ENTRIES.entries()) {
    const name = index === 0 ? adapterImport : "#provider-runtime/shared.js";
    writeFileSync(join(app, "dist-electron", "main", "agents", entry), `import ${JSON.stringify(name)};\n`);
  }
  return app;
}

function runCheck(app, nodeArguments = [], env = {}) {
  return spawnSync(process.execPath, [...nodeArguments, checkPath, app], {
    cwd: app,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", ...env },
  });
}

test("the check passes for an app with the packaged import map and loads all four adapters", () => {
  const app = temporaryApp();
  try {
    const result = runCheck(app);
    assert.equal(result.status, 0, result.stderr);
    for (const entry of PROVIDER_ADAPTER_ENTRIES) assert.match(result.stdout, new RegExp(`loaded .*${entry}`));
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("the check fails when one adapter has a wrong import name", () => {
  const app = temporaryApp({ adapterImport: "#provider-runtime/no-such-file.js" });
  try {
    const result = runCheck(app);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${PROVIDER_ADAPTER_ENTRIES[0]} imports #provider-runtime/no-such-file\\.js`));
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("the check fails when two users of one import name get two different files", () => {
  const app = temporaryApp();
  try {
    // A second package.json below the build output gives the adapters their own
    // meaning of the name: a second copy of the shared file.
    const agents = join(app, "dist-electron", "main", "agents");
    mkdirSync(join(agents, "copy"));
    writeFileSync(join(agents, "copy", "shared.js"), "export const shared = 2;\n");
    writeFileSync(join(agents, "package.json"), JSON.stringify({ type: "module", imports: { "#provider-runtime/*.js": "./copy/*.js" } }));
    const result = runCheck(app);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /imports #provider-runtime\/shared\.js and gets .*copy.shared\.js, but the app's package\.json gives dist-provider-runtime.shared\.js/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("the check fails when an adapter entry file is missing", () => {
  const app = temporaryApp();
  try {
    rmSync(join(app, "dist-electron", "main", "agents", PROVIDER_ADAPTER_ENTRIES[3]));
    const result = runCheck(app);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`no provider adapter entry file ${PROVIDER_ADAPTER_ENTRIES[3]}`));
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("the check fails for an app that still has the repository's conditional import map", () => {
  const app = temporaryApp({ imports: desktopPackage.imports });
  try {
    const result = runCheck(app);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has conditional targets/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("a source condition in the environment cannot redirect the packaged app", () => {
  const app = temporaryApp();
  try {
    // With the packaged map the name has one target, so the condition has no effect.
    assert.equal(runCheck(app, [], { NODE_OPTIONS: `--conditions=${SOURCE_CONDITION}` }).status, 0);
    assert.equal(runCheck(app, [`--conditions=${SOURCE_CONDITION}`]).status, 0);
    // With the repository's map the same condition points at a source folder the app does not have.
    writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module", imports: desktopPackage.imports }));
    assert.throws(
      () => execFileSync(process.execPath, [`--conditions=${SOURCE_CONDITION}`, join(app, "dist-daemon", "main.js")], { cwd: app, stdio: "pipe", env: { ...process.env, NODE_OPTIONS: "" } }),
      /ERR_MODULE_NOT_FOUND/,
    );
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
