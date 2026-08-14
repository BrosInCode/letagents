const DESKTOP_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SUPPORTED_ARCHITECTURES = new Set(["arm64", "x64"]);

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

export function desktopAssetNames({ version, arch }) {
  assertDesktopVersion(version);
  assertDesktopArchitecture(arch);
  const stem = `LetAgents-${version}-darwin-${arch}`;
  return {
    dmg: `${stem}.dmg`,
    zip: `${stem}.zip`,
  };
}

export function desktopMetadataNames({ arch }) {
  assertDesktopArchitecture(arch);
  return {
    releaseManifest: `desktop-release-${arch}.json`,
    squirrelManifest: `RELEASES-${arch}.json`,
    updaterManifest: `latest-mac-${arch}.yml`,
  };
}

export function createDesktopUpdaterConfig({ arch }) {
  assertDesktopArchitecture(arch);
  return {
    provider: "generic",
    url: `https://downloads.letagents.chat/desktop/feeds/${arch}/`,
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
  baseUrl,
  publishedAt,
  signed,
  notarized,
  artifacts,
}) {
  assertDesktopVersion(version);
  assertDesktopArchitecture(arch);
  const normalizedBaseUrl = normalizeReleaseBaseUrl(baseUrl);
  const publicationDate = new Date(publishedAt);
  if (Number.isNaN(publicationDate.valueOf())) {
    throw new Error(`Desktop release metadata requires a valid publication date; received '${publishedAt ?? ""}'.`);
  }
  return {
    format: 1,
    product: "LetAgents",
    version,
    platform: "darwin",
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
