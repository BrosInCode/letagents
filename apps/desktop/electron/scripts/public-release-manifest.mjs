import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ARCHITECTURES = ["arm64", "x64"];
// Windows ships x64 only. The website lists it under `windows` beside the
// macOS `assets`, so a reader that knows only `assets` keeps working.
const WINDOWS_ARCHITECTURES = ["x64"];

function installerFileName(version, platform, architecture) {
  return platform === "win32"
    ? `LetAgents-${version}-win32-${architecture}-setup.exe`
    : `LetAgents-${version}-darwin-${architecture}.dmg`;
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Desktop version must be numeric x.y.z; received ${version}.`);
  }
  return version;
}

function normalizeBaseUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Desktop release base URL must be an HTTPS origin without credentials, query, or hash.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function assertAsset({ version, platform, architecture, asset }) {
  const expectedFileName = installerFileName(version, platform, architecture);
  if (asset.fileName !== expectedFileName) {
    throw new Error(`Expected ${expectedFileName}; received ${asset.fileName}.`);
  }
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
    throw new Error(`${expectedFileName} must have a positive byte size.`);
  }
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error(`${expectedFileName} must have a lowercase SHA-256 digest.`);
  }
}

export function createPublicDesktopReleaseManifest({ version, baseUrl, assets, windows }) {
  const safeVersion = assertVersion(version);
  const safeBaseUrl = normalizeBaseUrl(baseUrl);
  const releaseBaseUrl = `${safeBaseUrl}/desktop/v${safeVersion}`;
  const normalize = (platform, architectures, source) => Object.fromEntries(architectures.map((architecture) => {
    const asset = source?.[architecture];
    if (!asset) {
      throw new Error(`Missing ${platform === "win32" ? "Windows " : ""}${architecture} desktop installer.`);
    }
    assertAsset({ version: safeVersion, platform, architecture, asset });
    return [architecture, {
      fileName: asset.fileName,
      publicUrl: `${releaseBaseUrl}/${asset.fileName}`,
      bytes: asset.bytes,
      sha256: asset.sha256,
    }];
  }));

  return {
    schemaVersion: 1,
    channel: "beta",
    version: safeVersion,
    checksumsUrl: `${releaseBaseUrl}/checksums.txt`,
    assets: normalize("darwin", ARCHITECTURES, assets),
    windows: normalize("win32", WINDOWS_ARCHITECTURES, windows),
  };
}

async function installerAsset(artifactsDirectory, version, platform, architecture) {
  const fileName = installerFileName(version, platform, architecture);
  const path = join(artifactsDirectory, fileName);
  const [metadata, sha256] = await Promise.all([
    stat(path),
    (async () => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest("hex");
    })(),
  ]);
  return {
    fileName: basename(path),
    bytes: metadata.size,
    sha256,
  };
}

export async function writePublicDesktopReleaseManifest({
  version,
  baseUrl,
  artifactsDirectory,
  outputPath,
  checksumsPath,
}) {
  const assetsFor = async (platform, architectures) => Object.fromEntries(await Promise.all(architectures.map(async (architecture) => [
    architecture,
    await installerAsset(artifactsDirectory, version, platform, architecture),
  ])));
  const assets = await assetsFor("darwin", ARCHITECTURES);
  const windows = await assetsFor("win32", WINDOWS_ARCHITECTURES);
  const manifest = createPublicDesktopReleaseManifest({ version, baseUrl, assets, windows });
  const checksums = [
    `${assets.arm64.sha256}  ${assets.arm64.fileName}`,
    `${assets.x64.sha256}  ${assets.x64.fileName}`,
    `${windows.x64.sha256}  ${windows.x64.fileName}`,
    "",
  ].join("\n");
  await Promise.all([
    writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 }),
    writeFile(checksumsPath, checksums, { encoding: "utf8", mode: 0o644 }),
  ]);
  return manifest;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [version, baseUrl, artifactsDirectory, outputPath, checksumsPath] = process.argv.slice(2);
  if (!version || !baseUrl || !artifactsDirectory || !outputPath || !checksumsPath) {
    throw new Error("Usage: public-release-manifest.mjs <version> <public-base-url> <artifacts-directory> <output-path> <checksums-path>");
  }
  await writePublicDesktopReleaseManifest({ version, baseUrl, artifactsDirectory, outputPath, checksumsPath });
}
