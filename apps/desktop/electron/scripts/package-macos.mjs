import { cp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { notarize } from "@electron/notarize";
import { sign } from "@electron/osx-sign";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = join(root, "release", "LetAgents-darwin");
const bundle = join(release, "LetAgents.app");
const dmg = join(root, "release", "LetAgents.dmg");
const identity = process.env.MACOS_SIGNING_IDENTITY?.trim();
const provisioningProfile = process.env.MACOS_PROVISIONING_PROFILE_PATH?.trim();
const notaryProfile = process.env.MACOS_NOTARY_KEYCHAIN_PROFILE?.trim();
const skipNotarization = process.env.MACOS_SKIP_NOTARIZATION === "1";

if (process.platform !== "darwin") throw new Error("macOS packaging must run on macOS.");
if (!identity) throw new Error("MACOS_SIGNING_IDENTITY is required (Developer ID Application identity).");
if (!provisioningProfile) throw new Error("MACOS_PROVISIONING_PROFILE_PATH is required for APNs entitlement signing.");
if (!notaryProfile && !skipNotarization) {
  throw new Error("MACOS_NOTARY_KEYCHAIN_PROFILE is required. Set MACOS_SKIP_NOTARIZATION=1 only for local test builds.");
}
if ((await readFile(provisioningProfile)).length === 0) throw new Error("The provisioning profile is empty.");

await cp(provisioningProfile, join(bundle, "Contents", "embedded.provisionprofile"));
await sign({
  app: bundle,
  identity,
  platform: "darwin",
  type: "distribution",
  hardenedRuntime: true,
  gatekeeperAssess: false,
  provisioningProfile,
  optionsForFile: (filePath) => filePath === bundle
    ? { entitlements: join(root, "electron", "entitlements.mac.plist") }
    : {},
});

await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle]);

if (!skipNotarization) {
  await notarize({ appPath: bundle, keychainProfile: notaryProfile });
  await execFileAsync("spctl", ["--assess", "--type", "execute", "--verbose=2", bundle]);
}

const dmgSource = join(release, "dmg-source");
await rm(dmgSource, { recursive: true, force: true });
await mkdir(dmgSource, { recursive: true });
await cp(bundle, join(dmgSource, "LetAgents.app"), { recursive: true, verbatimSymlinks: true });
await symlink("/Applications", join(dmgSource, "Applications"));
await rm(dmg, { force: true });
await execFileAsync("hdiutil", [
  "create",
  "-volname", "LetAgents",
  "-srcfolder", dmgSource,
  "-ov",
  "-format", "UDZO",
  dmg,
]);
await rm(dmgSource, { recursive: true, force: true });

if (!skipNotarization) {
  await notarize({ appPath: dmg, keychainProfile: notaryProfile });
  await execFileAsync("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg]);
}

console.log(JSON.stringify({ bundle, dmg, notarized: !skipNotarization }, null, 2));
