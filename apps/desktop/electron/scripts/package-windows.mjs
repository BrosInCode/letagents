import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createDifferentialBlockmap } from "./differential-blockmap.mjs";
import { describeArtifact } from "./release-artifacts.mjs";
import {
  assertDesktopVersion,
  assertWindowsArchitecture,
  createDesktopReleaseManifest,
  createElectronUpdaterWindowsManifest,
  desktopAssetNames,
  desktopMetadataNames,
  normalizeReleaseBaseUrl,
} from "./release-metadata.mjs";
import {
  createNsisPayloadInclude,
  findMakensis,
  listPayloadEntries,
  windowsFileVersion,
} from "./windows-packaging.mjs";

// Builds the Windows NSIS installer, its blockmap and electron-updater's
// latest.yml from the folder package-artifact.mjs assembled. The installer is
// unsigned for now (no certificate is available to the company yet), and the
// packaged app-update.yml has no publisherName, so the updater does not ask
// for an Authenticode signature; latest.yml's SHA-512 still seals each download.

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const release = join(root, "release");
const packagedApp = join(release, "LetAgents-win32", "LetAgents");
const artifactsDirectory = join(release, "artifacts");
const nsisDirectory = join(release, "nsis");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = assertDesktopVersion(packageJson.version);
const arch = assertWindowsArchitecture(process.arch);
const assets = desktopAssetNames({ version, arch, platform: "win32" });
const metadata = desktopMetadataNames({ arch, platform: "win32" });
const installer = join(artifactsDirectory, assets.installer);
const blockmap = `${installer}.blockmap`;
const publishedAt = process.env.LETAGENTS_DESKTOP_RELEASE_PUBLISHED_AT?.trim() || new Date().toISOString();
const releaseNotes = process.env.LETAGENTS_DESKTOP_RELEASE_NOTES?.trim() || `LetAgents desktop ${version}`;
const releaseBaseUrl = normalizeReleaseBaseUrl(
  process.env.LETAGENTS_DESKTOP_RELEASE_BASE_URL?.trim()
    || `https://downloads.letagents.chat/desktop/v${version}/`,
);

if (process.platform !== "win32") throw new Error("Windows packaging must run on Windows.");

await stat(join(packagedApp, "LetAgents.exe")).catch(() => {
  throw new Error(`The packaged app does not exist at ${packagedApp}. Run npm run package:artifact first.`);
});
const artifactManifest = JSON.parse(await readFile(join(packagedApp, "resources", "app", "package-artifact-manifest.json"), "utf8"));
if (artifactManifest.platform !== "win32" || artifactManifest.version !== version || artifactManifest.arch !== arch) {
  throw new Error(`The packaged app is ${artifactManifest.platform}-${artifactManifest.arch} ${artifactManifest.version}; expected win32-${arch} ${version}.`);
}

await rm(artifactsDirectory, { recursive: true, force: true });
await rm(nsisDirectory, { recursive: true, force: true });
await mkdir(artifactsDirectory, { recursive: true });
await mkdir(nsisDirectory, { recursive: true });

const payloadInclude = join(nsisDirectory, "payload.nsh");
await writeFile(payloadInclude, createNsisPayloadInclude(await listPayloadEntries(packagedApp)));
const makensis = findMakensis();
const { stdout: nsisVersion } = await execFileAsync(makensis, ["/VERSION"]);
const { stdout: nsisLog } = await execFileAsync(makensis, [
  "/V2",
  "/INPUTCHARSET", "UTF8",
  `/DVERSION=${version}`,
  `/DFILE_VERSION=${windowsFileVersion(version)}`,
  `/DSOURCE_DIR=${packagedApp}`,
  `/DPAYLOAD_NSH=${payloadInclude}`,
  `/DICON_FILE=${join(packagedApp, "resources", "letagents.ico")}`,
  `/DOUTPUT_FILE=${installer}`,
  join(root, "electron", "installer", "windows", "installer.nsi"),
], { maxBuffer: 64 * 1024 * 1024 });
if (nsisLog.trim()) console.error(nsisLog.trim());
await createDifferentialBlockmap(installer, blockmap);

const artifacts = [
  await describeArtifact("installer", installer),
  await describeArtifact("blockmap", blockmap),
];
for (const artifact of artifacts) {
  await writeFile(join(artifactsDirectory, `${artifact.name}.sha256`), `${artifact.sha256}  ${artifact.name}\n`);
}
const installerArtifact = artifacts.find((artifact) => artifact.kind === "installer");
await writeFile(join(artifactsDirectory, metadata.updaterManifest), `${JSON.stringify(createElectronUpdaterWindowsManifest({
  version,
  arch,
  baseUrl: releaseBaseUrl,
  publishedAt,
  notes: releaseNotes,
  installerArtifact,
}), null, 2)}\n`);
await writeFile(join(artifactsDirectory, metadata.releaseManifest), `${JSON.stringify(createDesktopReleaseManifest({
  version,
  arch,
  platform: "win32",
  baseUrl: releaseBaseUrl,
  publishedAt,
  signed: false,
  notarized: false,
  artifacts,
}), null, 2)}\n`);

console.log(JSON.stringify({
  app: packagedApp,
  version,
  platform: process.platform,
  arch,
  signed: false,
  nsis: nsisVersion.trim(),
  artifactsDirectory,
  artifacts,
}, null, 2));
