const DESKTOP_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);
// Windows ships x64 only. Its feed folder names the platform as well as the
// architecture, so the macOS x64 and Windows x64 feeds never share a folder.
const SUPPORTED_WINDOWS_ARCHITECTURES = new Set(["x64"]);
const SUPPORTED_PLATFORMS = new Set(["darwin", "win32"]);

export function assertDesktopVersion(version) {
  if (typeof version !== "string" || !DESKTOP_VERSION_PATTERN.test(version)) {
    throw new Error(`Desktop releases require a numeric x.y.z version; received '${version ?? ""}'.`);
  }
  return version;
}

export function assertDesktopArchitecture(arch) {
  if (!SUPPORTED_ARCHITECTURES.has(arch)) {
    throw new Error(`Desktop releases support arm64 or x64; received '${arch ?? ""}'.`);
  }
  return arch;
}

export function assertDesktopPlatform(platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Desktop releases support darwin or win32; received '${platform ?? ""}'.`);
  }
  return platform;
}

export function assertWindowsArchitecture(arch) {
  if (!SUPPORTED_WINDOWS_ARCHITECTURES.has(arch)) {
    throw new Error(`Windows desktop releases support x64; received '${arch ?? ""}'.`);
  }
  return arch;
}

function assertPlatformArchitecture(platform, arch) {
  if (assertDesktopPlatform(platform) === "win32") return assertWindowsArchitecture(arch);
  return assertDesktopArchitecture(arch);
}

/** The update feed folder: `arm64`/`x64` for macOS (unchanged), `win32-x64` for Windows. */
export function desktopFeedName({ arch, platform = "darwin" }) {
  assertPlatformArchitecture(platform, arch);
  return platform === "win32" ? `win32-${arch}` : arch;
}

export function normalizeReleaseBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`LETAGENTS_DESKTOP_RELEASE_BASE_URL must be an absolute HTTPS URL; received '${baseUrl ?? ""}'.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`LETAGENTS_DESKTOP_RELEASE_BASE_URL must use HTTPS; received '${baseUrl}'.`);
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

export function desktopAssetNames({ version, arch, platform = "darwin" }) {
  assertDesktopVersion(version);
  assertPlatformArchitecture(platform, arch);
  if (platform === "win32") return { installer: `LetAgents-${version}-win32-${arch}-setup.exe` };
  const stem = `LetAgents-${version}-darwin-${arch}`;
  return {
    dmg: `${stem}.dmg`,
    zip: `${stem}.zip`,
  };
}

export function desktopMetadataNames({ arch, platform = "darwin" }) {
  assertPlatformArchitecture(platform, arch);
  if (platform === "win32") {
    return {
      releaseManifest: `desktop-release-win32-${arch}.json`,
      updaterManifest: `latest-win32-${arch}.yml`,
    };
  }
  return {
    releaseManifest: `desktop-release-${arch}.json`,
    squirrelManifest: `RELEASES-${arch}.json`,
    updaterManifest: `latest-mac-${arch}.yml`,
  };
}

export function createDesktopUpdaterConfig({ arch, platform = "darwin" }) {
  // Windows builds ship unsigned for now, so this config has no publisherName:
  // electron-updater's NsisUpdater verifies an installer's Authenticode
  // signature only when publisherName is set. The feed is HTTPS and every
  // download is checked against the SHA-512 in latest.yml either way. Add
  // publisherName here once the builds are signed.
  return {
    provider: "generic",
    url: `https://downloads.letagents.chat/desktop/feeds/${desktopFeedName({ arch, platform })}/`,
    updaterCacheDirName: "letagents-desktop-updater",
  };
}

export function createElectronUpdaterMacManifest({
  version,
  arch,
  baseUrl,
  publishedAt,
  notes = "",
  zipArtifact,
}) {
  const assets = desktopAssetNames({ version, arch });
  const normalizedBaseUrl = normalizeReleaseBaseUrl(baseUrl);
  const publicationDate = new Date(publishedAt);
  if (Number.isNaN(publicationDate.valueOf())) {
    throw new Error(`Desktop release metadata requires a valid publication date; received '${publishedAt ?? ""}'.`);
  }
  if (
    zipArtifact?.name !== assets.zip
    || !Number.isSafeInteger(zipArtifact?.bytes)
    || zipArtifact.bytes <= 0
    || typeof zipArtifact?.sha512 !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(zipArtifact.sha512)
  ) {
    throw new Error("electron-updater metadata requires the architecture ZIP size and base64 SHA-512 digest.");
  }
  const url = new URL(assets.zip, normalizedBaseUrl).toString();
  return {
    version,
    files: [{ url, sha512: zipArtifact.sha512, size: zipArtifact.bytes }],
    path: url,
    sha512: zipArtifact.sha512,
    releaseName: `LetAgents ${version}`,
    releaseNotes: String(notes),
    releaseDate: publicationDate.toISOString(),
  };
}

/**
 * NsisUpdater's latest.yml: the installer's absolute URL, size and base64
 * SHA-512. It downloads `<url>.blockmap` next to the installer for a
 * differential update and falls back to the whole installer without one.
 */
export function createElectronUpdaterWindowsManifest({
  version,
  arch,
  baseUrl,
  publishedAt,
  notes = "",
  installerArtifact,
}) {
  const assets = desktopAssetNames({ version, arch, platform: "win32" });
  const normalizedBaseUrl = normalizeReleaseBaseUrl(baseUrl);
  const publicationDate = new Date(publishedAt);
  if (Number.isNaN(publicationDate.valueOf())) {
    throw new Error(`Desktop release metadata requires a valid publication date; received '${publishedAt ?? ""}'.`);
  }
  if (
    installerArtifact?.name !== assets.installer
    || !Number.isSafeInteger(installerArtifact?.bytes)
    || installerArtifact.bytes <= 0
    || typeof installerArtifact?.sha512 !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(installerArtifact.sha512)
  ) {
    throw new Error("electron-updater metadata requires the Windows installer size and base64 SHA-512 digest.");
  }
  const url = new URL(assets.installer, normalizedBaseUrl).toString();
  return {
    version,
    files: [{ url, sha512: installerArtifact.sha512, size: installerArtifact.bytes }],
    path: url,
    sha512: installerArtifact.sha512,
    releaseName: `LetAgents ${version}`,
    releaseNotes: String(notes),
    releaseDate: publicationDate.toISOString(),
  };
}

export function createSquirrelMacReleaseManifest({
  version,
  arch,
  baseUrl,
  publishedAt,
  notes = "",
}) {
  const assets = desktopAssetNames({ version, arch });
  const normalizedBaseUrl = normalizeReleaseBaseUrl(baseUrl);
  const publicationDate = new Date(publishedAt);
  if (Number.isNaN(publicationDate.valueOf())) {
    throw new Error(`Desktop release metadata requires a valid publication date; received '${publishedAt ?? ""}'.`);
  }
  const updateTo = {
    version,
    pub_date: publicationDate.toISOString(),
    notes: String(notes),
    name: `LetAgents ${version}`,
    url: new URL(assets.zip, normalizedBaseUrl).toString(),
  };
  return {
    currentRelease: version,
    releases: [{ version, updateTo }],
  };
}

export function createDesktopReleaseManifest({
  version,
  arch,
  platform = "darwin",
  baseUrl,
  publishedAt,
  signed,
  notarized,
  artifacts,
}) {
  assertDesktopVersion(version);
  assertPlatformArchitecture(platform, arch);
  const normalizedBaseUrl = normalizeReleaseBaseUrl(baseUrl);
  const publicationDate = new Date(publishedAt);
  if (Number.isNaN(publicationDate.valueOf())) {
    throw new Error(`Desktop release metadata requires a valid publication date; received '${publishedAt ?? ""}'.`);
  }
  return {
    format: 1,
    product: "LetAgents",
    version,
    platform,
    arch,
    publishedAt: publicationDate.toISOString(),
    signed: Boolean(signed),
    notarized: Boolean(notarized),
    artifacts: artifacts.map(({ name, bytes, sha256, sha512, kind }) => ({
      kind,
      name,
      url: new URL(name, normalizedBaseUrl).toString(),
      bytes,
      sha256,
      ...(sha512 ? { sha512 } : {}),
    })),
  };
}
