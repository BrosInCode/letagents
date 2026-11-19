import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkProcessTreeSeal, sourceDigest } from "./seal.mjs";

const seal = JSON.parse(readFileSync(new URL("../../../../shared/letagents-process-tree.seal.json", import.meta.url), "utf8"));

test("the seal names the committed source", () => {
  assert.equal(sourceDigest(readFileSync(new URL("./letagents-process-tree.c", import.meta.url))), seal.sourceSha256);
});

test("the source digest does not depend on the checkout's line endings", () => {
  assert.equal(sourceDigest(Buffer.from("a\r\nb\r\n")), sourceDigest(Buffer.from("a\nb\n")));
});

test("a build is checked against the seal of its compiler", () => {
  const sealed = { sourceSha256: "s", builds: { x64: { sha256: "d", vcToolsVersion: "14.44.1", windowsSdkVersion: "10.0.1" } } };
  const build = { arch: "x64", sourceSha256: "s", sha256: "d", vcToolsVersion: "14.44.1", windowsSdkVersion: "10.0.1" };
  assert.equal(checkProcessTreeSeal(sealed, build).level, "ok");
  // Same compiler, other bytes: not reproducible, or the seal is wrong.
  assert.equal(checkProcessTreeSeal(sealed, { ...build, sha256: "e" }).level, "error");
  // The source changed without the seal.
  assert.equal(checkProcessTreeSeal(sealed, { ...build, sourceSha256: "t" }).level, "error");
  // A newer compiler on the runner: reported with the values to reseal.
  const newer = checkProcessTreeSeal(sealed, { ...build, sha256: "e", vcToolsVersion: "14.45.0" });
  assert.equal(newer.level, "warning");
  assert.match(newer.message, /"sha256":"e"/);
  assert.equal(checkProcessTreeSeal(sealed, { ...build, arch: "arm64" }).level, "warning");
});

test("a seal may name one build for each compiler while a runner image rolls out", () => {
  const old = { sha256: "d", vcToolsVersion: "14.44.1", windowsSdkVersion: "10.0.1" };
  const sealed = { sourceSha256: "s", builds: { x64: [old, { sha256: "e", vcToolsVersion: "14.45.0", windowsSdkVersion: "10.0.1" }] } };
  const build = { arch: "x64", sourceSha256: "s", ...old };
  assert.equal(checkProcessTreeSeal(sealed, build).level, "ok");
  assert.equal(checkProcessTreeSeal(sealed, { ...build, sha256: "e", vcToolsVersion: "14.45.0" }).level, "ok");
  // Each build is checked against its own compiler's bytes, not any sealed bytes.
  assert.equal(checkProcessTreeSeal(sealed, { ...build, sha256: "e" }).level, "error");
  assert.equal(checkProcessTreeSeal(sealed, { ...build, sha256: "d", vcToolsVersion: "14.45.0" }).level, "error");
  const third = checkProcessTreeSeal(sealed, { ...build, sha256: "f", vcToolsVersion: "14.46.0" });
  assert.equal(third.level, "warning");
  assert.match(third.message, /14\.44\.1.*14\.45\.0/);
});

test("the committed seal has a well-formed build for each compiler it names", () => {
  for (const [arch, entry] of Object.entries(seal.builds)) {
    const builds = Array.isArray(entry) ? entry : [entry];
    assert.ok(builds.length > 0, arch);
    for (const build of builds) {
      assert.match(build.sha256, /^[0-9a-f]{64}$/);
      assert.match(build.vcToolsVersion, /^\d+\.\d+\.\d+$/);
      assert.match(build.windowsSdkVersion, /^\d+\.\d+\.\d+\.\d+$/);
    }
    const pairs = builds.map((build) => `${build.vcToolsVersion} ${build.windowsSdkVersion}`);
    assert.equal(new Set(pairs).size, pairs.length, `${arch}: one build for each compiler and SDK`);
  }
});
