import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDesktopArchitecture,
  assertDesktopVersion,
  createDesktopReleaseManifest,
  createSquirrelMacReleaseManifest,
  desktopAssetNames,
  desktopMetadataNames,
  normalizeReleaseBaseUrl,
} from "./release-metadata.mjs";

test("release assets are immutable and architecture-specific", () => {
  assert.deepEqual(desktopAssetNames({ version: "0.1.0", arch: "arm64" }), {
    dmg: "LetAgents-0.1.0-darwin-arm64.dmg",
    zip: "LetAgents-0.1.0-darwin-arm64.zip",
  });
});

test("release metadata names remain distinct when architecture artifacts are merged", () => {
  assert.deepEqual(desktopMetadataNames({ arch: "arm64" }), {
    releaseManifest: "desktop-release-arm64.json",
    squirrelManifest: "RELEASES-arm64.json",
  });
  assert.deepEqual(desktopMetadataNames({ arch: "x64" }), {
    releaseManifest: "desktop-release-x64.json",
    squirrelManifest: "RELEASES-x64.json",
  });
});

test("Squirrel.Mac metadata points at the signed ZIP", () => {
  assert.deepEqual(createSquirrelMacReleaseManifest({
    version: "0.1.0",
    arch: "arm64",
    baseUrl: "https://github.com/BrosInCode/letagents/releases/download/desktop-v0.1.0",
    publishedAt: "2026-08-10T12:00:00Z",
    notes: "First desktop release",
  }), {
    currentRelease: "0.1.0",
    releases: [{
      version: "0.1.0",
      updateTo: {
        version: "0.1.0",
        pub_date: "2026-08-10T12:00:00.000Z",
        notes: "First desktop release",
        name: "LetAgents 0.1.0",
        url: "https://github.com/BrosInCode/letagents/releases/download/desktop-v0.1.0/LetAgents-0.1.0-darwin-arm64.zip",
      },
    }],
  });
});

test("release manifest seals artifact size and digest", () => {
  const manifest = createDesktopReleaseManifest({
    version: "0.1.0",
    arch: "arm64",
    baseUrl: "https://downloads.example.com/darwin/arm64/",
    publishedAt: "2026-08-10T12:00:00Z",
    signed: true,
    notarized: true,
    artifacts: [{ kind: "installer", name: "LetAgents.dmg", bytes: 42, sha256: "abc123" }],
  });
  assert.equal(manifest.signed, true);
  assert.equal(manifest.notarized, true);
  assert.deepEqual(manifest.artifacts, [{
    kind: "installer",
    name: "LetAgents.dmg",
    url: "https://downloads.example.com/darwin/arm64/LetAgents.dmg",
    bytes: 42,
    sha256: "abc123",
  }]);
});

test("release inputs reject ambiguous versions, architectures, and transport", () => {
  assert.throws(() => assertDesktopVersion("0.1.0-beta.1"), /numeric x\.y\.z/);
  assert.throws(() => assertDesktopArchitecture("universal"), /arm64 or x64/);
  assert.throws(() => normalizeReleaseBaseUrl("http://downloads.example.com"), /must use HTTPS/);
  assert.throws(() => normalizeReleaseBaseUrl("not-a-url"), /absolute HTTPS URL/);
});
