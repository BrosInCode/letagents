import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { WINDOWS_EXECUTABLE_NAME } from "./windows-packaging.mjs";

// package-artifact.mjs writes the manifest; package-macos.mjs and
// package-windows.mjs check it against the files that ship. Each entry is a
// path, a size and a SHA-256. Paths are relative to the app folder, or to the
// bundle when they start with one of the bundle roots below.

export const PACKAGE_ARTIFACT_MANIFEST_NAME = "package-artifact-manifest.json";

const LAYOUTS = {
  darwin: { app: ["Contents", "Resources", "app"], bundleRoots: new Set(["Contents"]) },
  win32: { app: ["resources", "app"], bundleRoots: new Set(["resources", "shared", WINDOWS_EXECUTABLE_NAME]) },
};

function layout(platform) {
  const value = LAYOUTS[platform];
  if (!value) throw new Error(`No package artifact layout for platform '${platform}'.`);
  return value;
}

export function packageArtifactManifestPath({ bundle, platform }) {
  return join(bundle, ...layout(platform).app, PACKAGE_ARTIFACT_MANIFEST_NAME);
}

/** The absolute path of a manifest entry in the bundle. */
export function resolveManifestEntry({ bundle, platform, path }) {
  const segments = typeof path === "string" ? path.split("/") : [];
  if (
    segments.length === 0
    || path.includes("\\")
    || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`The package artifact manifest has an unsafe path: ${JSON.stringify(path)}.`);
  }
  const { app, bundleRoots } = layout(platform);
  return bundleRoots.has(segments[0]) ? join(bundle, ...segments) : join(bundle, ...app, ...segments);
}

/**
 * Reads a manifest entry that must be a regular file. No part of its path
 * below the bundle may be a symbolic link, so the entry cannot describe a
 * file outside the bundle.
 */
export async function readRegularFile({ bundle, file }) {
  const below = relative(bundle, file);
  if (below === "" || below.startsWith("..") || isAbsolute(below)) {
    throw new Error(`${file} is not inside ${bundle}.`);
  }
  let current = bundle;
  const segments = below.split(sep);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstat(current);
    const last = index === segments.length - 1;
    if (info.isSymbolicLink()) throw new Error(`${current} is a symbolic link, not a regular file.`);
    if (last ? !info.isFile() : !info.isDirectory()) {
      throw new Error(`${current} is not a regular ${last ? "file" : "folder"}.`);
    }
  }
  return readFile(file);
}

export function describeBytes(bytes) {
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function readPackageArtifactManifest({ bundle, platform }) {
  const manifest = JSON.parse(await readFile(packageArtifactManifestPath({ bundle, platform }), "utf8"));
  if (!Array.isArray(manifest?.files) || manifest.files.length === 0) {
    throw new Error("The package artifact manifest lists no files.");
  }
  return manifest;
}

export async function writePackageArtifactManifest({ bundle, platform, manifest }) {
  // The same format package-artifact.mjs writes.
  await writeFile(packageArtifactManifestPath({ bundle, platform }), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Compares every manifest entry with the file in the bundle. Returns the mismatches. */
export async function verifyPackageArtifactManifest({ bundle, platform, manifest }) {
  const checked = manifest ?? await readPackageArtifactManifest({ bundle, platform });
  const mismatches = [];
  if (checked.platform !== platform) {
    mismatches.push({ path: PACKAGE_ARTIFACT_MANIFEST_NAME, reason: `platform is '${checked.platform}', expected '${platform}'` });
  }
  const seen = new Set();
  for (const entry of checked.files) {
    if (seen.has(entry?.path)) {
      mismatches.push({ path: entry.path, reason: "listed more than once" });
      continue;
    }
    seen.add(entry?.path);
    let bytes;
    try {
      bytes = await readRegularFile({ bundle, file: resolveManifestEntry({ bundle, platform, path: entry?.path }) });
    } catch (error) {
      mismatches.push({ path: String(entry?.path), reason: error.code === "ENOENT" ? "missing" : error.message });
      continue;
    }
    const actual = describeBytes(bytes);
    if (actual.bytes !== entry.bytes) {
      mismatches.push({ path: entry.path, reason: `size is ${actual.bytes}, manifest has ${entry.bytes}` });
    } else if (actual.sha256 !== entry.sha256) {
      mismatches.push({ path: entry.path, reason: `SHA-256 is ${actual.sha256}, manifest has ${entry.sha256}` });
    }
  }
  return { checked: checked.files.length, mismatches };
}

/** Fails when any manifest entry does not describe the file that ships. */
export async function assertPackageArtifactManifest({ bundle, platform }) {
  const { checked, mismatches } = await verifyPackageArtifactManifest({ bundle, platform });
  if (mismatches.length > 0) {
    throw new Error(
      `The package artifact manifest does not describe the files in ${bundle}:\n`
      + mismatches.map(({ path, reason }) => `  ${path}: ${reason}`).join("\n"),
    );
  }
  return checked;
}

const MACH_O_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe]);
const FAT_MAGICS = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

/** True for a thin or universal Mach-O file (not a Java class file, which shares 0xcafebabe). */
export function isMachO(bytes) {
  if (bytes.length < 8) return false;
  const magic = bytes.readUInt32BE(0);
  if (MACH_O_MAGICS.has(magic)) return true;
  if (!FAT_MAGICS.has(magic)) return false;
  const count = magic === 0xcafebabe || magic === 0xcafebabf ? bytes.readUInt32BE(4) : bytes.readUInt32LE(4);
  // A class file has its version here (45 or more); a universal binary has its architecture count.
  return count > 0 && count < 45;
}

/**
 * The first identity that `security find-identity -v` lists for the name,
 * as its SHA-1. @electron/osx-sign picks the identity the same way.
 */
export function parseSigningIdentityHash(findIdentityOutput, identity) {
  for (const line of findIdentityOutput.split("\n")) {
    if (!line.includes(identity)) continue;
    const hash = line.substring(line.indexOf(")") + 2, line.indexOf("\"") - 1).trim();
    if (/^[0-9A-Fa-f]{40}$/.test(hash)) return hash;
  }
  throw new Error("No valid code signing identity matches MACOS_SIGNING_IDENTITY.");
}

/**
 * The codesign arguments @electron/osx-sign uses for a nested file when
 * optionsForFile returns {}: hardened runtime, a secure timestamp and its
 * default entitlements.
 */
export function nestedCodeSignArguments({ identityHash, entitlements, file }) {
  return ["--sign", identityHash, "--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, file];
}

/**
 * Signing rewrites a Mach-O file, so the manifest of an unsigned build does
 * not describe the signed bytes. This signs the manifest's Mach-O entries
 * first, records their signed size and SHA-256 and writes the manifest again.
 * The caller then signs the bundle and passes the returned paths to
 * osx-sign's `ignore`, so those files keep the bytes the manifest records.
 */
export async function signManifestMachOEntries({ bundle, identity, entitlements, execFile }) {
  const platform = "darwin";
  const manifest = await readPackageArtifactManifest({ bundle, platform });
  const appFolder = join(bundle, ...layout(platform).app);
  const machO = [];
  for (const entry of manifest.files) {
    const file = resolveManifestEntry({ bundle, platform, path: entry.path });
    if (!isMachO(await readRegularFile({ bundle, file }))) continue;
    // The nested-file arguments are right only for a plain file in the app
    // folder. osx-sign signs helper apps, frameworks and the main executable
    // with other options, so such an entry needs its own design first.
    const inApp = relative(appFolder, file);
    if (inApp.startsWith("..") || isAbsolute(inApp) || /\.(app|framework)(\/|$)/.test(inApp.split(sep).join("/"))) {
      throw new Error(`The manifest's Mach-O entry ${entry.path} is not a plain file in Contents/Resources/app, so package-macos.mjs cannot pre-sign it.`);
    }
    machO.push({ entry, file });
  }
  if (machO.length === 0) return new Set();
  const { stdout } = await execFile("security", ["find-identity", "-v"]);
  const identityHash = parseSigningIdentityHash(String(stdout), identity);
  for (const { entry, file } of machO) {
    await execFile("codesign", nestedCodeSignArguments({ identityHash, entitlements, file }));
    await execFile("codesign", ["--verify", "--strict", "--verbose=2", file]);
    Object.assign(entry, describeBytes(await readRegularFile({ bundle, file })));
  }
  await writePackageArtifactManifest({ bundle, platform, manifest });
  return new Set(machO.map(({ file }) => file));
}

/**
 * The macOS signing order: pre-sign the manifest's Mach-O entries, seal the
 * bundle with osx-sign (`signBundle` gets the `ignore` function to pass on),
 * verify the seal, then check the manifest, so a mismatch fails before the
 * notary submission.
 */
export async function signMacBundleWithManifest({ bundle, identity, entitlements, execFile, signBundle }) {
  const presigned = await signManifestMachOEntries({ bundle, identity, entitlements, execFile });
  await signBundle({ ignore: (filePath) => presigned.has(filePath) });
  await execFile("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle]);
  return assertPackageArtifactManifest({ bundle, platform: "darwin" });
}
