import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPublicDesktopReleaseManifest,
  writePublicDesktopReleaseManifest,
} from "./public-release-manifest.mjs";

const assets = {
  arm64: {
    fileName: "LetAgents-0.1.5-darwin-arm64.dmg",
    bytes: 120,
    sha256: "a".repeat(64),
  },
  x64: {
    fileName: "LetAgents-0.1.5-darwin-x64.dmg",
    bytes: 140,
    sha256: "b".repeat(64),
  },
};

test("public desktop release manifest seals both immutable installers", () => {
  assert.deepEqual(createPublicDesktopReleaseManifest({
    version: "0.1.5",
    baseUrl: "https://downloads.letagents.chat/",
    assets,
  }), {
    schemaVersion: 1,
    channel: "beta",
    version: "0.1.5",
    checksumsUrl: "https://downloads.letagents.chat/desktop/v0.1.5/checksums.txt",
    assets: {
      arm64: {
        ...assets.arm64,
        publicUrl: "https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-arm64.dmg",
      },
      x64: {
        ...assets.x64,
        publicUrl: "https://downloads.letagents.chat/desktop/v0.1.5/LetAgents-0.1.5-darwin-x64.dmg",
      },
    },
  });
});

test("public desktop release manifest rejects an unsealed or ambiguous installer", () => {
  assert.throws(() => createPublicDesktopReleaseManifest({
    version: "0.1.5-beta.1",
    baseUrl: "https://downloads.letagents.chat",
    assets,
  }), /numeric x\.y\.z/);
  assert.throws(() => createPublicDesktopReleaseManifest({
    version: "0.1.5",
    baseUrl: "http://downloads.letagents.chat",
    assets,
  }), /HTTPS origin/);
  assert.throws(() => createPublicDesktopReleaseManifest({
    version: "0.1.5",
    baseUrl: "https://downloads.letagents.chat",
    assets: { ...assets, arm64: { ...assets.arm64, sha256: "not-a-digest" } },
  }), /SHA-256/);
});

test("public desktop release files derive checksums and sizes from exact DMG bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-public-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, "LetAgents-0.1.5-darwin-arm64.dmg"), "arm64 installer"),
    writeFile(join(directory, "LetAgents-0.1.5-darwin-x64.dmg"), "x64 installer"),
  ]);
  const outputPath = join(directory, "release.json");
  const checksumsPath = join(directory, "checksums.txt");

  const manifest = await writePublicDesktopReleaseManifest({
    version: "0.1.5",
    baseUrl: "https://downloads.letagents.chat",
    artifactsDirectory: directory,
    outputPath,
    checksumsPath,
  });
  assert.equal(manifest.assets.arm64.bytes, 15);
  assert.equal(manifest.assets.x64.bytes, 13);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), manifest);
  assert.equal(await readFile(checksumsPath, "utf8"), [
    `${manifest.assets.arm64.sha256}  ${manifest.assets.arm64.fileName}`,
    `${manifest.assets.x64.sha256}  ${manifest.assets.x64.fileName}`,
    "",
  ].join("\n"));
});
