import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDesktopArchitecture,
  assertDesktopVersion,
  createDesktopReleaseManifest,
  createDesktopUpdaterConfig,
  createElectronUpdaterMacManifest,
  createElectronUpdaterWindowsManifest,
  createSquirrelMacReleaseManifest,
  desktopAssetNames,
  desktopMetadataNames,
  normalizeReleaseBaseUrl,
} from "./release-metadata.mjs";

test("packaged updater configuration selects the architecture feed and stable cache", () => {
  assert.deepEqual(createDesktopUpdaterConfig({ arch: "arm64" }), {
    provider: "generic",
    url: "https://downloads.letagents.chat/desktop/feeds/arm64/",
    updaterCacheDirName: "letagents-desktop-updater",
  });
  assert.throws(() => createDesktopUpdaterConfig({ arch: "ia32" }), /support arm64 or x64/);
});

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
    updaterManifest: "latest-mac-arm64.yml",
  });
  assert.deepEqual(desktopMetadataNames({ arch: "x64" }), {
    releaseManifest: "desktop-release-x64.json",
    squirrelManifest: "RELEASES-x64.json",
    updaterManifest: "latest-mac-x64.yml",
  });
});

test("electron-updater metadata seals the immutable ZIP size and SHA-512 digest", () => {
  assert.deepEqual(createElectronUpdaterMacManifest({
    version: "0.1.0",
    arch: "arm64",
    baseUrl: "https://downloads.letagents.chat/desktop/v0.1.0",
    publishedAt: "2026-08-10T12:00:00Z",
    notes: "First desktop release",
    zipArtifact: {
      name: "LetAgents-0.1.0-darwin-arm64.zip",
      bytes: 1234,
      sha512: "YWJjMTIz",
    },
  }), {
    version: "0.1.0",
    files: [{
      url: "https://downloads.letagents.chat/desktop/v0.1.0/LetAgents-0.1.0-darwin-arm64.zip",
      sha512: "YWJjMTIz",
      size: 1234,
    }],
    path: "https://downloads.letagents.chat/desktop/v0.1.0/LetAgents-0.1.0-darwin-arm64.zip",
    sha512: "YWJjMTIz",
    releaseName: "LetAgents 0.1.0",
    releaseNotes: "First desktop release",
    releaseDate: "2026-08-10T12:00:00.000Z",
  });
});

test("electron-updater metadata rejects an unsealed ZIP", () => {
  assert.throws(() => createElectronUpdaterMacManifest({
    version: "0.1.0",
    arch: "arm64",
    baseUrl: "https://downloads.letagents.chat/desktop/v0.1.0",
    publishedAt: "2026-08-10T12:00:00Z",
    zipArtifact: { name: "LetAgents-0.1.0-darwin-arm64.zip", bytes: 1234 },
  }), /base64 SHA-512/);
});

test("Squirrel.Mac metadata points at the signed ZIP", () => {
  assert.deepEqual(createSquirrelMacReleaseManifest({
    version: "0.1.0",
    arch: "arm64",
    baseUrl: "https://downloads.letagents.chat/desktop/v0.1.0",
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
        url: "https://downloads.letagents.chat/desktop/v0.1.0/LetAgents-0.1.0-darwin-arm64.zip",
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

test("the Windows updater config reads its own feed folder and asks for no publisher signature", () => {
  assert.deepEqual(createDesktopUpdaterConfig({ arch: "x64", platform: "win32" }), {
    provider: "generic",
    url: "https://downloads.letagents.chat/desktop/feeds/win32-x64/",
    updaterCacheDirName: "letagents-desktop-updater",
  });
  // Unsigned builds: NsisUpdater checks a signature only when publisherName is set.
  assert.equal("publisherName" in createDesktopUpdaterConfig({ arch: "x64", platform: "win32" }), false);
  assert.notEqual(
    createDesktopUpdaterConfig({ arch: "x64", platform: "win32" }).url,
    createDesktopUpdaterConfig({ arch: "x64" }).url,
  );
  assert.throws(() => createDesktopUpdaterConfig({ arch: "arm64", platform: "win32" }), /Windows desktop releases support x64/);
  assert.throws(() => createDesktopUpdaterConfig({ arch: "x64", platform: "linux" }), /support darwin or win32/);
});

test("Windows release names never collide with macOS names when artifacts are merged", () => {
  assert.deepEqual(desktopAssetNames({ version: "0.1.0", arch: "x64", platform: "win32" }), {
    installer: "LetAgents-0.1.0-win32-x64-setup.exe",
  });
  const windows = desktopMetadataNames({ arch: "x64", platform: "win32" });
  assert.deepEqual(windows, {
    releaseManifest: "desktop-release-win32-x64.json",
    updaterManifest: "latest-win32-x64.yml",
  });
  const mac = [...Object.values(desktopMetadataNames({ arch: "arm64" })), ...Object.values(desktopMetadataNames({ arch: "x64" }))];
  for (const name of Object.values(windows)) assert.ok(!mac.includes(name), name);
});

test("NsisUpdater metadata seals the immutable installer size and SHA-512 digest", () => {
  const manifest = createElectronUpdaterWindowsManifest({
    version: "0.1.0",
    arch: "x64",
    baseUrl: "https://downloads.letagents.chat/desktop/v0.1.0",
    publishedAt: "2026-08-10T12:00:00Z",
    notes: "First Windows release",
    installerArtifact: { name: "LetAgents-0.1.0-win32-x64-setup.exe", bytes: 4321, sha512: "ZGVmNDU2" },
  });
  assert.deepEqual(manifest, {
    version: "0.1.0",
    files: [{
      url: "https://downloads.letagents.chat/desktop/v0.1.0/LetAgents-0.1.0-win32-x64-setup.exe",
      sha512: "ZGVmNDU2",
      size: 4321,
    }],
    path: "https://downloads.letagents.chat/desktop/v0.1.0/LetAgents-0.1.0-win32-x64-setup.exe",
    sha512: "ZGVmNDU2",
    releaseName: "LetAgents 0.1.0",
    releaseNotes: "First Windows release",
    releaseDate: "2026-08-10T12:00:00.000Z",
  });
  // The installer runs with the user's own rights; no elevation flag.
  assert.equal("isAdminRightsRequired" in manifest.files[0], false);
  assert.throws(() => createElectronUpdaterWindowsManifest({
    version: "0.1.0",
    arch: "x64",
    baseUrl: "https://downloads.letagents.chat/desktop/v0.1.0",
    publishedAt: "2026-08-10T12:00:00Z",
    installerArtifact: { name: "LetAgents-0.1.0-darwin-x64.dmg", bytes: 4321, sha512: "ZGVmNDU2" },
  }), /Windows installer size and base64 SHA-512/);
});

test("the Windows release manifest records an unsigned win32 build", () => {
  const manifest = createDesktopReleaseManifest({
    version: "0.1.0",
    arch: "x64",
    platform: "win32",
    baseUrl: "https://downloads.letagents.chat/desktop/v0.1.0/",
    publishedAt: "2026-08-10T12:00:00Z",
    signed: false,
    notarized: false,
    artifacts: [{ kind: "installer", name: "LetAgents-0.1.0-win32-x64-setup.exe", bytes: 42, sha256: "abc123" }],
  });
  assert.equal(manifest.platform, "win32");
  assert.equal(manifest.signed, false);
  assert.equal(createDesktopReleaseManifest({
    version: "0.1.0",
    arch: "arm64",
    baseUrl: "https://downloads.letagents.chat/desktop/v0.1.0/",
    publishedAt: "2026-08-10T12:00:00Z",
    signed: true,
    notarized: true,
    artifacts: [],
  }).platform, "darwin");
});
