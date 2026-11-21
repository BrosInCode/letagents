import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isolatePackagedBundle, linksLeaving, resolutionRootsAbove } from "./packaged-artifact-isolation.mjs";

function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), "letagents-isolation-test-")));
}

test("a folder below a package.json or a node_modules folder is found", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "checkout", "release", "App"), { recursive: true });
    assert.deepEqual(resolutionRootsAbove(join(root, "checkout", "release", "App")).filter((path) => path.startsWith(root)), []);
    writeFileSync(join(root, "checkout", "package.json"), "{}");
    mkdirSync(join(root, "checkout", "node_modules"));
    assert.deepEqual(
      resolutionRootsAbove(join(root, "checkout", "release", "App")).filter((path) => path.startsWith(root)),
      [join(root, "checkout", "package.json"), join(root, "checkout", "node_modules")],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this repository's release folder is below a package.json, which is why the checks use a copy", () => {
  assert.ok(resolutionRootsAbove(import.meta.dirname).some((path) => path.endsWith(join("apps", "desktop", "package.json"))));
});

test("a link that leads out of the bundle is found, and a link inside it is not", { skip: process.platform === "win32" ? "needs the right to create links" : false }, () => {
  const root = scratch();
  try {
    const bundle = join(root, "App");
    mkdirSync(join(bundle, "inner"), { recursive: true });
    writeFileSync(join(bundle, "inner", "file.js"), "");
    writeFileSync(join(root, "outside.js"), "");
    symlinkSync(join("inner", "file.js"), join(bundle, "inside-link.js"));
    assert.deepEqual(linksLeaving(bundle), []);
    symlinkSync(join(root, "outside.js"), join(bundle, "inner", "outside-link.js"));
    symlinkSync(join(root, "no-such-file"), join(bundle, "broken-link"));
    assert.deepEqual(linksLeaving(bundle).sort(), [join(bundle, "broken-link"), join(bundle, "inner", "outside-link.js")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the copy keeps the files and refuses a parent with a package.json", async () => {
  const root = scratch();
  try {
    const bundle = join(root, "built", "App");
    mkdirSync(join(bundle, "resources"), { recursive: true });
    writeFileSync(join(bundle, "resources", "main.js"), "export const here = 1;\n");

    mkdirSync(join(root, "clean"));
    const isolated = await isolatePackagedBundle(bundle, { parent: join(root, "clean") });
    assert.equal(isolated.bundle, join(isolated.root, "App"));
    assert.equal((await import(pathToFileURL(join(isolated.bundle, "resources", "main.js")).href)).here, 1);

    mkdirSync(join(root, "checkout"));
    writeFileSync(join(root, "checkout", "package.json"), "{}");
    await assert.rejects(isolatePackagedBundle(bundle, { parent: join(root, "checkout") }), /Node could load code from there/);
    // A refused copy does not stay on disk.
    assert.deepEqual(readdirSync(join(root, "checkout")), ["package.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
