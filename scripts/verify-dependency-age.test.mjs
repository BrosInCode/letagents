import assert from "node:assert/strict";
import test from "node:test";

import { collectLockedPackages, evaluateReleaseAges } from "./verify-dependency-age.mjs";

const integrity = `sha512-${"a".repeat(64)}`;

test("collectLockedPackages deduplicates exact versions across lockfiles", () => {
  const lock = {
    packages: {
      "node_modules/example": {
        version: "1.2.3",
        resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz",
        integrity,
      },
    },
  };

  const result = collectLockedPackages([
    { file: "one/package-lock.json", lock },
    { file: "two/package-lock.json", lock },
  ]);

  assert.deepEqual(result.violations, []);
  assert.equal(result.packages.length, 1);
  assert.deepEqual(result.packages[0].lockfiles, ["one/package-lock.json", "two/package-lock.json"]);
});

test("collectLockedPackages rejects alternate registries and missing SHA-512 integrity", () => {
  const result = collectLockedPackages([
    {
      file: "package-lock.json",
      lock: {
        packages: {
          "node_modules/elsewhere": {
            version: "1.0.0",
            resolved: "https://packages.example.test/elsewhere.tgz",
            integrity,
          },
          "node_modules/weak-integrity": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/weak-integrity/-/weak-integrity-1.0.0.tgz",
            integrity: "sha1-not-accepted",
          },
          "node_modules/no-tarball": {
            version: "1.0.0",
            integrity,
          },
        },
      },
    },
  ]);

  assert.equal(result.violations.length, 3);
  assert.match(result.violations[0], /outside the public npm registry/);
  assert.match(result.violations[1], /missing SHA-512/);
  assert.match(result.violations[2], /missing a locked registry tarball URL/);
});

test("evaluateReleaseAges requires an exact exception for a young version", () => {
  const now = Date.parse("2026-07-11T12:00:00.000Z");
  const packages = [{ name: "young-package", version: "1.0.0", lockfiles: ["package-lock.json"] }];
  const metadataByName = new Map([
    ["young-package", { time: { "1.0.0": "2026-07-10T12:00:00.000Z" } }],
  ]);

  const blocked = evaluateReleaseAges({
    packages,
    metadataByName,
    policy: { minimumAgeDays: 7, exceptions: [] },
    now,
  });
  assert.equal(blocked.violations.length, 1);

  const accepted = evaluateReleaseAges({
    packages,
    metadataByName,
    policy: {
      minimumAgeDays: 7,
      exceptions: [{ name: "young-package", version: "1.0.0", reason: "Reviewed." }],
    },
    now,
  });
  assert.deepEqual(accepted.violations, []);
  assert.equal(accepted.acceptedExceptions.length, 1);
});
