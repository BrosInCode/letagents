import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsDirectory, "../..");
const repositoryRoot = resolve(desktopRoot, "../..");

async function source(path) {
  return readFile(path, "utf8");
}

test("packaging preserves APNs plist behavior and rebrands every Electron helper", async () => {
  const [packager, smoke] = await Promise.all([
    source(join(scriptsDirectory, "package-artifact.mjs")),
    source(join(scriptsDirectory, "packaged-supervisor-smoke.mjs")),
  ]);

  assert.match(packager, /\["NSUserNotificationAlertStyle", "alert"\]/);
  assert.match(packager, /rebrandHelper\(\{\}\)/);
  assert.match(packager, /qualifier: " \(GPU\)"/);
  assert.match(packager, /qualifier: " \(Plugin\)"/);
  assert.match(packager, /qualifier: " \(Renderer\)"/);
  assert.match(smoke, /"Contents", "MacOS", "LetAgents"/);
});

test("packaging rejects a non-square application icon before generating the iconset", async () => {
  const packager = await source(join(scriptsDirectory, "package-artifact.mjs"));

  assert.match(packager, /sips", \["-g", "pixelWidth", "-g", "pixelHeight"/);
  assert.match(packager, /assertSquareImageDimensions\(parseSipsDimensions\(sourceMetadata\), source\)/);
});

test("signed release packaging requires and embeds the APNs provisioning contract", async () => {
  const [packager, entitlements, workflow] = await Promise.all([
    source(join(scriptsDirectory, "package-macos.mjs")),
    source(join(desktopRoot, "electron", "entitlements.mac.plist")),
    source(join(repositoryRoot, ".github", "workflows", "desktop-release.yml")),
  ]);

  assert.match(entitlements, /<key>com\.apple\.developer\.aps-environment<\/key>\s*<string>production<\/string>/);
  assert.match(packager, /MACOS_PROVISIONING_PROFILE_PATH/);
  assert.match(packager, /"Contents", "embedded\.provisionprofile"/);
  assert.match(packager, /provisioningProfile,/);
  assert.match(packager, /optionsForFile:/);
  assert.match(packager, /entitlements\.mac\.plist/);
  assert.match(workflow, /MACOS_PROVISIONING_PROFILE_BASE64: \$\{\{ secrets\.MACOS_PROVISIONING_PROFILE_BASE64 \}\}/);
  assert.match(workflow, /MACOS_PROVISIONING_PROFILE_PATH=/);
});

test("release DMGs are signed before notarization and Gatekeeper assessment", async () => {
  const packager = await source(join(scriptsDirectory, "package-macos.mjs"));
  const signDmg = packager.indexOf('await execFileAsync("codesign", ["--sign", identity, "--force", "--timestamp", dmg]);');
  const verifyDmg = packager.indexOf('await execFileAsync("codesign", ["--verify", "--verbose=2", dmg]);');
  const notarizeDmg = packager.indexOf("await notarize({ appPath: dmg, ...credentials });");
  const assessDmg = packager.indexOf('"context:primary-signature"');

  assert.ok(signDmg >= 0, "the DMG must receive a Developer ID signature");
  assert.ok(verifyDmg > signDmg, "the DMG signature must be verified after signing");
  assert.ok(notarizeDmg > verifyDmg, "the signed DMG must be notarized after verification");
  assert.ok(assessDmg > notarizeDmg, "Gatekeeper assessment must run after notarization");
});

test("release workflow builds, attests, and publishes independent architecture feeds", async () => {
  const workflow = await source(join(repositoryRoot, ".github", "workflows", "desktop-release.yml"));

  assert.match(workflow, /arch: arm64\s+runner: macos-15/);
  assert.match(workflow, /arch: x64\s+runner: macos-15-intel/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /feed_tag="desktop-feed-\$\{arch\}"/);
  assert.match(workflow, /RELEASES-\$\{arch\}\.json/);
  assert.doesNotMatch(workflow, /releases\/latest/);
  assert.doesNotMatch(workflow, /--latest(?:\s|$)/);
});
