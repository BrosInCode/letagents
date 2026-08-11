import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { notarize } from "@electron/notarize";
import { sign } from "@electron/osx-sign";

import {
  assertDesktopArchitecture,
  assertDesktopVersion,
  createDesktopReleaseManifest,
  createSquirrelMacReleaseManifest,
  desktopAssetNames,
  desktopMetadataNames,
  normalizeReleaseBaseUrl,
} from "./release-metadata.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = join(root, "release");
const packagedApp = join(release, "LetAgents-darwin", "LetAgents.app");
const artifactsDirectory = join(release, "artifacts");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = assertDesktopVersion(packageJson.version);
const arch = assertDesktopArchitecture(process.arch);
const assets = desktopAssetNames({ version, arch });
const metadata = desktopMetadataNames({ arch });
const dmg = join(artifactsDirectory, assets.dmg);
const zip = join(artifactsDirectory, assets.zip);
const identity = process.env.MACOS_SIGNING_IDENTITY?.trim();
const provisioningProfile = process.env.MACOS_PROVISIONING_PROFILE_PATH?.trim();
const entitlements = join(root, "electron", "entitlements.mac.plist");
const skipSigning = process.env.MACOS_SKIP_SIGNING === "1";
const skipNotarization = skipSigning || process.env.MACOS_SKIP_NOTARIZATION === "1";
const publishedAt = process.env.LETAGENTS_DESKTOP_RELEASE_PUBLISHED_AT?.trim() || new Date().toISOString();
const releaseNotes = process.env.LETAGENTS_DESKTOP_RELEASE_NOTES?.trim() || `LetAgents desktop ${version}`;
const releaseBaseUrl = normalizeReleaseBaseUrl(
  process.env.LETAGENTS_DESKTOP_RELEASE_BASE_URL?.trim()
    || `https://github.com/BrosInCode/letagents/releases/download/desktop-v${version}/`,
);

if (process.platform !== "darwin") throw new Error("macOS packaging must run on macOS.");
if (!skipSigning && !identity) {
  throw new Error("MACOS_SIGNING_IDENTITY is required (Developer ID Application identity). Use MACOS_SKIP_SIGNING=1 only for local packaging checks.");
}
if (!skipSigning && !identity.startsWith("Developer ID Application:")) {
  throw new Error("MACOS_SIGNING_IDENTITY must be a Developer ID Application identity.");
}
if (!skipSigning && !provisioningProfile) {
  throw new Error("MACOS_PROVISIONING_PROFILE_PATH is required for APNs entitlement signing.");
}
if (!skipSigning && (await readFile(provisioningProfile)).length === 0) {
  throw new Error("The macOS provisioning profile is empty.");
}

function notarizationCredentials() {
  const keychainProfile = process.env.MACOS_NOTARY_KEYCHAIN_PROFILE?.trim();
  if (keychainProfile) return { keychainProfile };
  const appleApiKey = process.env.MACOS_NOTARY_API_KEY?.trim();
  const appleApiKeyId = process.env.MACOS_NOTARY_API_KEY_ID?.trim();
  const appleApiIssuer = process.env.MACOS_NOTARY_API_ISSUER?.trim();
  if (appleApiKey && appleApiKeyId) {
    return {
      appleApiKey,
      appleApiKeyId,
      ...(appleApiIssuer ? { appleApiIssuer } : {}),
    };
  }
  throw new Error(
    "Notarization requires MACOS_NOTARY_KEYCHAIN_PROFILE or MACOS_NOTARY_API_KEY plus MACOS_NOTARY_API_KEY_ID. Set MACOS_SKIP_NOTARIZATION=1 only for a signed local test build.",
  );
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function describeArtifact(kind, path) {
  const info = await stat(path);
  return {
    kind,
    name: basename(path),
    bytes: info.size,
    sha256: await sha256(path),
  };
}

await stat(packagedApp).catch(() => {
  throw new Error(`The packaged app does not exist at ${packagedApp}. Run npm run package:artifact first.`);
});
await rm(artifactsDirectory, { recursive: true, force: true });
await mkdir(artifactsDirectory, { recursive: true });

if (!skipSigning) {
  await cp(provisioningProfile, join(packagedApp, "Contents", "embedded.provisionprofile"));
  await sign({
    app: packagedApp,
    identity,
    platform: "darwin",
    type: "distribution",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    provisioningProfile,
    optionsForFile: (filePath) => filePath === packagedApp
      ? { entitlements }
      : {},
  });
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", packagedApp]);
}

const credentials = skipNotarization ? undefined : notarizationCredentials();
if (credentials) {
  await notarize({ appPath: packagedApp, ...credentials });
  await execFileAsync("xcrun", ["stapler", "validate", packagedApp]);
  await execFileAsync("spctl", ["--assess", "--type", "execute", "--verbose=2", packagedApp]);
}

await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", packagedApp, zip]);

const dmgSource = join(release, "dmg-source");
await rm(dmgSource, { recursive: true, force: true });
await mkdir(dmgSource, { recursive: true });
await cp(packagedApp, join(dmgSource, "LetAgents.app"), { recursive: true, verbatimSymlinks: true });
await symlink("/Applications", join(dmgSource, "Applications"));
await execFileAsync("hdiutil", [
  "create",
  "-volname", "LetAgents",
  "-srcfolder", dmgSource,
  "-ov",
  "-format", "UDZO",
  dmg,
]);
await rm(dmgSource, { recursive: true, force: true });

if (!skipSigning) {
  await execFileAsync("codesign", ["--sign", identity, "--force", "--timestamp", dmg]);
  await execFileAsync("codesign", ["--verify", "--verbose=2", dmg]);
}

if (credentials) {
  await notarize({ appPath: dmg, ...credentials });
  await execFileAsync("xcrun", ["stapler", "validate", dmg]);
  await execFileAsync("spctl", [
    "--assess",
    "--type", "open",
    "--context", "context:primary-signature",
    "--verbose=2",
    dmg,
  ]);
}

const artifacts = [
  await describeArtifact("installer", dmg),
  await describeArtifact("update", zip),
];
for (const artifact of artifacts) {
  await writeFile(join(artifactsDirectory, `${artifact.name}.sha256`), `${artifact.sha256}  ${artifact.name}\n`);
}
await writeFile(join(artifactsDirectory, metadata.squirrelManifest), `${JSON.stringify(createSquirrelMacReleaseManifest({
  version,
  arch,
  baseUrl: releaseBaseUrl,
  publishedAt,
  notes: releaseNotes,
}), null, 2)}\n`);
await writeFile(join(artifactsDirectory, metadata.releaseManifest), `${JSON.stringify(createDesktopReleaseManifest({
  version,
  arch,
  baseUrl: releaseBaseUrl,
  publishedAt,
  signed: !skipSigning,
  notarized: !skipNotarization,
  artifacts,
}), null, 2)}\n`);

console.log(JSON.stringify({
  app: packagedApp,
  version,
  platform: process.platform,
  arch,
  signed: !skipSigning,
  notarized: !skipNotarization,
  artifactsDirectory,
  artifacts,
}, null, 2));
