import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkProcessTreeSeal, sourceDigest } from "./seal.mjs";

const seal = JSON.parse(readFileSync(new URL("./letagents-process-tree.seal.json", import.meta.url), "utf8"));

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
