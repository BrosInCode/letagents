import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ownPlacePaths, PROVIDER_ADAPTER_ENTRIES } from "./packaged-app-import-check.mjs";
import {
  isPackagedBuildFile,
  isTestBuildPath,
  packagedBuildFilter,
  packagedImports,
  packagedPackageJson,
  packagedTestPaths,
} from "./packaged-imports.mjs";

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

test("compiled tests, their fixtures and source maps are not part of the packaged build output", () => {
  for (const path of [
    "__tests__/main-window.test.js",
    "__tests__/helpers/room.js",
    "__tests__/provider-replay/fixtures/turn.json",
    "main\\__tests__\\x.test.js",
    "main/agents/__fixtures__/a.js",
    "main/x.test.js",
    "main/x.test.js.map",
    "main/x.spec.mjs",
  ]) {
    assert.equal(isTestBuildPath(path), true, path);
    assert.equal(isPackagedBuildFile(path), false, path);
  }
  for (const path of ["main.js", "main/tests-panel.js", "main/latest.js", "main/rooms/test-room.js", "page-preload.cjs"]) {
    assert.equal(isTestBuildPath(path), false, path);
    assert.equal(isPackagedBuildFile(path), true, path);
  }
});

test("the build folder filter copies the app code and leaves out the tests", async () => {
  // A folder named __tests__ above the build folder does not count.
  const workspace = mkdtempSync(join(tmpdir(), "letagents-packaged-build-"));
  const build = join(workspace, "__tests__", "dist-electron");
  const app = join(workspace, "app");
  try {
    for (const [path, content] of [
      ["main.js", "export {};\n"],
      ["main/rooms/room.js", "export {};\n"],
      ["main/rooms/room.d.ts", "export {};\n"],
      ["__tests__/room.test.js", "export {};\n"],
      ["__tests__/fixtures/room.json", "{}\n"],
      ["main/rooms/room.test.js", "export {};\n"],
    ]) {
      mkdirSync(dirname(join(build, path)), { recursive: true });
      writeFileSync(join(build, path), content);
    }
    await cp(build, join(app, "dist-electron"), { recursive: true, filter: packagedBuildFilter(build) });
    assert.deepEqual(packagedTestPaths(app, ["dist-electron", "dist-daemon"]), []);
    assert.equal(existsSync(join(app, "dist-electron", "main.js")), true);
    assert.equal(existsSync(join(app, "dist-electron", "main", "rooms", "room.js")), true);
    assert.equal(existsSync(join(app, "dist-electron", "main", "rooms", "room.d.ts")), false);
    assert.equal(existsSync(join(app, "dist-electron", "__tests__")), false);
    assert.equal(existsSync(join(app, "dist-electron", "main", "rooms", "room.test.js")), false);

    // The packaging check finds tests that a plain copy brings in.
    await cp(build, join(app, "dist-daemon"), { recursive: true });
    assert.deepEqual(packagedTestPaths(app, ["dist-electron", "dist-daemon"]).sort(), [
      "dist-daemon/__tests__",
      "dist-daemon/main/rooms/room.test.js",
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/** A small app folder in the shape of the packaged app. */
function temporaryApp({ imports = packagedPackageJson(desktopPackage).imports, adapterImport = "#provider-runtime/shared.js" } = {}) {
  const app = mkdtempSync(join(tmpdir(), "letagents-packaged-imports-"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module", imports }));
  mkdirSync(join(app, "dist-provider-runtime", "agents"), { recursive: true });
  mkdirSync(join(app, "dist-electron"));
  mkdirSync(join(app, "dist-daemon"));
  writeFileSync(join(app, "dist-provider-runtime", "shared.js"), "export const shared = 1;\n");
  writeFileSync(join(app, "dist-daemon", "main.js"), 'import "#provider-runtime/shared.js";\n');
  for (const [index, entry] of PROVIDER_ADAPTER_ENTRIES.entries()) {
    const name = index === 0 ? adapterImport : "#provider-runtime/shared.js";
    writeFileSync(join(app, "dist-provider-runtime", "agents", entry), `import ${JSON.stringify(name)};\n`);
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

test("the check passes for an app with the packaged import map and loads all five adapters", () => {
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
    const agents = join(app, "dist-provider-runtime", "agents");
    mkdirSync(join(agents, "copy"));
    writeFileSync(join(agents, "copy", "shared.js"), "export const shared = 2;\n");
    writeFileSync(join(agents, "package.json"), JSON.stringify({ type: "module", imports: { "#provider-runtime/*.js": "./copy/*.js" } }));
    const result = runCheck(app);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /agents.package\.json declares import names; only the package\.json of the packaged app may/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("the check fails when a second import map gives import and require two different files", () => {
  const app = temporaryApp();
  try {
    // CommonJS resolution of this map gives the shared file of the app, and
    // ESM resolution gives a copy. The adapters are ESM, so they load the copy.
    // A target must stay inside its own package, so the require target is a
    // link to the app's shared file (a second copy where links need a right).
    const agents = join(app, "dist-provider-runtime", "agents");
    mkdirSync(join(agents, "same"));
    mkdirSync(join(agents, "copy"));
    try {
      symlinkSync(join(app, "dist-provider-runtime", "shared.js"), join(agents, "same", "shared.js"));
    } catch {
      copyFileSync(join(app, "dist-provider-runtime", "shared.js"), join(agents, "same", "shared.js"));
    }
    writeFileSync(join(agents, "copy", "shared.js"), "export const shared = 2;\n");
    writeFileSync(join(agents, "package.json"), JSON.stringify({
      type: "module",
      imports: { "#provider-runtime/*.js": { require: "./same/*.js", import: "./copy/*.js" } },
    }));
    // The map is valid: an ES module in that folder really loads the copy.
    writeFileSync(join(agents, "probe.mjs"), 'import { shared } from "#provider-runtime/shared.js";\nprocess.stdout.write(String(shared));\n');
    assert.equal(execFileSync(process.execPath, [join(agents, "probe.mjs")], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }), "2");
    const result = runCheck(app);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /agents.package\.json declares import names/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("a package.json below the build output that declares no import names is accepted", () => {
  const app = temporaryApp();
  try {
    writeFileSync(join(app, "dist-electron", "package.json"), JSON.stringify({ type: "module" }));
    // The files that use the name are in other folders, so their scope is the app's package.json.
    assert.equal(runCheck(app).status, 0);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("the three forms of a path from a file's own place are read", () => {
  assert.deepEqual(ownPlacePaths('import(new URL("../a/b.js", import.meta.url).href)'), [["../a/b.js"]]);
  assert.deepEqual(
    ownPlacePaths(`runtime ??= import(new URL(import.meta.url.endsWith(".ts")\n    ? "../electron/main/x.ts" // repository tests and development only\n    : "../dist-electron/main/x.js", import.meta.url).href)`),
    [["../dist-electron/main/x.js"]],
  );
  assert.deepEqual(
    ownPlacePaths('return resolve(dirname(fileURLToPath(import.meta.url)), "../dist-electron/main/agents/y.js");'),
    [["../dist-electron/main/agents/y.js"]],
  );
  assert.deepEqual(ownPlacePaths('join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "z.mjs")'), [["..", "shared", "z.mjs"]]);
  // Not a path from the file's own place.
  assert.deepEqual(ownPlacePaths('new URL("/auth/github", base); new URL("https://example.test/x")'), []);
});

test("the check fails when a file names a path from its own place that the app does not have", () => {
  const app = temporaryApp();
  try {
    mkdirSync(join(app, "shared"));
    writeFileSync(join(app, "shared", "worker.mjs"), "");
    const user = join(app, "dist-daemon", "worker-user.js");
    writeFileSync(user, 'export const worker = new URL("../shared/worker.mjs", import.meta.url);\n');
    const passing = runCheck(app);
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /1 path\(s\) from a file's own place exist/);
    // The same file one folder deeper, as after a move: the path now points beside the app's folder.
    mkdirSync(join(app, "dist-daemon", "moved"));
    writeFileSync(join(app, "dist-daemon", "moved", "worker-user.js"), 'export const worker = new URL("../shared/worker.mjs", import.meta.url);\n');
    const failing = runCheck(app);
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /moved.worker-user\.js names \.\.\/shared\/worker\.mjs from its own place/);
    // The packaged app has no compiled tests, so a test folder gets no exemption.
    rmSync(join(app, "dist-daemon", "moved"), { recursive: true });
    mkdirSync(join(app, "dist-daemon", "__tests__"));
    writeFileSync(join(app, "dist-daemon", "__tests__", "x.test.js"), 'export const fixture = new URL("./no-such-fixture.json", import.meta.url);\n');
    const withTest = runCheck(app);
    assert.equal(withTest.status, 1);
    assert.match(withTest.stderr, /__tests__.x\.test\.js names \.\/no-such-fixture\.json from its own place/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test("the check fails when an adapter entry file is missing", () => {
  const app = temporaryApp();
  try {
    rmSync(join(app, "dist-provider-runtime", "agents", PROVIDER_ADAPTER_ENTRIES[3]));
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
