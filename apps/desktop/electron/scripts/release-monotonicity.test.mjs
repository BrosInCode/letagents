import assert from "node:assert/strict";
import test from "node:test";

import { assertMutableReleaseMonotonicity } from "./release-monotonicity.mjs";

const keys = [
  "desktop/current.json",
  "desktop/v0.1.4/LetAgents-0.1.4-darwin-arm64.dmg",
  "desktop/v0.1.5/release.json",
  "desktop/v0.1.5/LetAgents-0.1.5-darwin-x64.dmg",
];

test("mutable release channels allow the highest immutable version and a newer release", () => {
  assert.equal(assertMutableReleaseMonotonicity("0.1.5", keys), "0.1.5");
  assert.equal(assertMutableReleaseMonotonicity("0.2.0", keys), "0.1.5");
});

test("mutable release channels reject every older tag before publication", () => {
  assert.throws(
    () => assertMutableReleaseMonotonicity("0.1.4", keys),
    /immutable 0\.1\.5 artifacts already exist/,
  );
  assert.throws(() => assertMutableReleaseMonotonicity("invalid", keys), /Invalid desktop version/);
});
