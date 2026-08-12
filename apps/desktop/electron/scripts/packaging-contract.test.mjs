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

test("packaging seals every shared SQLite runtime imported by local rooms", async () => {
  const packager = await source(join(scriptsDirectory, "package-artifact.mjs"));

  assert.match(packager, /"shared\/sqlite-local-write-notifications\.mjs"/);
  assert.match(packager, /"shared\/sqlite-thread-routing\.mjs"/);
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

test("release workflow builds, attests, and publishes independent public R2 feeds", async () => {
  const workflow = await source(join(repositoryRoot, ".github", "workflows", "desktop-release.yml"));

  assert.match(workflow, /arch: arm64\s+runner: macos-15/);
  assert.match(workflow, /arch: x64\s+runner: macos-15-intel/);
  assert.match(workflow, /uses: actions\/attest@v4/);
  assert.match(workflow, /github\.event\.repository\.visibility == 'public'/);
  assert.match(workflow, /vars\.ENABLE_DESKTOP_PROVENANCE_ATTESTATION == 'true'/);
  assert.match(workflow, /Report unavailable provenance attestation/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /R2_ACCESS_KEY_ID: \$\{\{ secrets\.R2_ACCESS_KEY_ID \}\}/);
  assert.match(workflow, /R2_SECRET_ACCESS_KEY: \$\{\{ secrets\.R2_SECRET_ACCESS_KEY \}\}/);
  assert.match(workflow, /desktop\/v\$\{DESKTOP_VERSION\}/);
  assert.match(workflow, /feed_key="desktop\/feeds\/\$\{arch\}\/\$\{public_name\}"/);
  assert.match(workflow, /RELEASES-\$\{arch\}\.json\|RELEASES\.json\|application\/json/);
  assert.match(workflow, /latest-mac-\$\{arch\}\.yml\|latest-mac\.yml\|application\/yaml/);
  assert.match(workflow, /\*\.blockmap\) content_type="application\/octet-stream"/);
  assert.match(workflow, /public,max-age=31536000,immutable/);
  assert.match(workflow, /public,max-age=60,must-revalidate/);
  assert.match(workflow, /Immutable R2 object/);
  assert.match(workflow, /RELEASES-\$\{arch\}\.json/);
  assert.match(workflow, /GITHUB_REF_NAME}" --draft=false --prerelease --latest=false/);
  assert.doesNotMatch(workflow, /releases\/latest/);
  assert.doesNotMatch(workflow, /--latest(?:\s|$)/);
  assert.doesNotMatch(workflow, /desktop-feed-\$\{arch\}/);
});
