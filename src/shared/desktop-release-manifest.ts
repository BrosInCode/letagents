export const MAC_DESKTOP_PUBLIC_BASE_URL = "https://downloads.letagents.chat";

export type MacDesktopArchitecture = "arm64" | "x64";

export interface MacDesktopPublicReleaseManifest {
  schemaVersion: 1;
  channel: "beta";
  version: string;
  checksumsUrl: string;
  assets: Record<MacDesktopArchitecture, {
    fileName: string;
    publicUrl: string;
    bytes: number;
    sha256: string;
  }>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function numericVersion(value: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error("Desktop release manifest version must be numeric x.y.z.");
  }
  return value.split(".").map(Number);
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function parseMacDesktopPublicReleaseManifest(
  value: unknown,
  minimumVersion: string,
): MacDesktopPublicReleaseManifest {
  const manifest = record(value, "Desktop release manifest");
  const version = manifest.version;
  if (manifest.schemaVersion !== 1 || manifest.channel !== "beta") {
    throw new Error("Desktop release manifest has an unsupported contract.");
  }
  if (typeof version !== "string") {
    throw new Error("Desktop release manifest version must be numeric x.y.z.");
  }
  numericVersion(version);
  if (compareVersions(version, minimumVersion) < 0) {
    throw new Error(`Desktop release manifest ${version} is older than ${minimumVersion}.`);
  }

  const rawAssets = record(manifest.assets, "Desktop release assets");
  const checksumsUrl = `${MAC_DESKTOP_PUBLIC_BASE_URL}/desktop/v${version}/checksums.txt`;
  if (manifest.checksumsUrl !== checksumsUrl) {
    throw new Error("Desktop release manifest does not use the immutable public checksum URL.");
  }
  const assets = {} as MacDesktopPublicReleaseManifest["assets"];
  for (const architecture of ["arm64", "x64"] as const) {
    const rawAsset = record(rawAssets[architecture], `${architecture} desktop release asset`);
    const fileName = `LetAgents-${version}-darwin-${architecture}.dmg`;
    const publicUrl = `${MAC_DESKTOP_PUBLIC_BASE_URL}/desktop/v${version}/${fileName}`;
    if (rawAsset.fileName !== fileName || rawAsset.publicUrl !== publicUrl) {
      throw new Error(`${architecture} desktop release asset does not use the immutable public URL.`);
    }
    if (!Number.isSafeInteger(rawAsset.bytes) || Number(rawAsset.bytes) <= 0) {
      throw new Error(`${architecture} desktop release asset must have a positive byte size.`);
    }
    if (typeof rawAsset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(rawAsset.sha256)) {
      throw new Error(`${architecture} desktop release asset must have a lowercase SHA-256 digest.`);
    }
    assets[architecture] = {
      fileName,
      publicUrl,
      bytes: Number(rawAsset.bytes),
      sha256: rawAsset.sha256,
    };
  }

  return { schemaVersion: 1, channel: "beta", version, checksumsUrl, assets };
}
