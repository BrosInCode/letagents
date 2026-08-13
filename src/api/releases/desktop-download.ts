import type { Express } from "express";

import {
  MAC_DESKTOP_BETA_CHECKSUM_RELEASES,
  MAC_DESKTOP_BETA_RELEASE,
  type MacDesktopArchitecture,
} from "../../shared/desktop-release.js";
import {
  MAC_DESKTOP_PUBLIC_BASE_URL,
  parseMacDesktopPublicReleaseManifest,
  type MacDesktopPublicReleaseManifest,
} from "../../shared/desktop-release-manifest.js";
import {
  advanceDesktopReleaseHighWater,
  assertDesktopReleaseAtOrAboveHighWater,
  canUseBundledDesktopReleaseFallback,
} from "./desktop-release-high-water.js";

const CURRENT_RELEASE_URL = `${MAC_DESKTOP_PUBLIC_BASE_URL}/desktop/current.json`;
const CURRENT_RELEASE_CACHE_MS = 45_000;
const CURRENT_RELEASE_FAILURE_CACHE_MS = 10_000;
const CURRENT_RELEASE_MAX_BYTES = 64 * 1024;
const CHECKSUM_SIDECAR_MAX_BYTES = 256;

interface CachedRelease {
  expiresAt: number;
  release: MacDesktopPublicReleaseManifest;
}

export interface DesktopDownloadRouteDeps {
  loadCurrentRelease?: () => Promise<MacDesktopPublicReleaseManifest>;
  canUseBundledFallback?: () => Promise<boolean>;
}

function parseArchitecture(raw: string): MacDesktopArchitecture | undefined {
  return raw === "arm64" || raw === "x64" ? raw : undefined;
}

async function readBoundedBody(response: Response, maxBytes: number, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) throw new Error(`${label} response has no body.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export async function verifyMacDesktopReleaseArtifacts(
  release: MacDesktopPublicReleaseManifest,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await Promise.all((Object.keys(release.assets) as MacDesktopArchitecture[]).map(async (architecture) => {
    const asset = release.assets[architecture];
    const assetResponse = await fetcher(asset.publicUrl, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!assetResponse.ok) {
      throw new Error(`${architecture} desktop release asset returned HTTP ${assetResponse.status}.`);
    }
    if (Number(assetResponse.headers.get("content-length")) !== asset.bytes) {
      throw new Error(`${architecture} desktop release asset byte size does not match its manifest.`);
    }
    if (!/\bimmutable\b/.test(assetResponse.headers.get("cache-control") ?? "")) {
      throw new Error(`${architecture} desktop release asset is not published immutably.`);
    }

    const sidecarResponse = await fetcher(`${asset.publicUrl}.sha256`, {
      headers: { Accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!sidecarResponse.ok) {
      throw new Error(`${architecture} desktop release checksum proof returned HTTP ${sidecarResponse.status}.`);
    }
    if (!/\bimmutable\b/.test(sidecarResponse.headers.get("cache-control") ?? "")) {
      throw new Error(`${architecture} desktop release checksum proof is not published immutably.`);
    }
    const proof = (await readBoundedBody(
      sidecarResponse,
      CHECKSUM_SIDECAR_MAX_BYTES,
      `${architecture} desktop release checksum proof`,
    )).trimEnd();
    if (proof !== `${asset.sha256}  ${asset.fileName}`) {
      throw new Error(`${architecture} desktop release checksum proof does not match its manifest.`);
    }
  }));
}

export function createDesktopReleaseManifestLoader(options: {
  fetcher?: typeof fetch;
  now?: () => number;
  acceptVersion?: (version: string) => Promise<void>;
  checkVersion?: (version: string) => Promise<void>;
  verifyRelease?: (release: MacDesktopPublicReleaseManifest) => Promise<void>;
} = {}): (url: string, cacheMs: number) => Promise<MacDesktopPublicReleaseManifest> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const acceptVersion = options.acceptVersion ?? (async () => {});
  const checkVersion = options.checkVersion ?? acceptVersion;
  const verifyRelease = options.verifyRelease ?? (async () => {});
  const releaseCache = new Map<string, CachedRelease>();
  const releaseRequests = new Map<string, Promise<MacDesktopPublicReleaseManifest>>();
  const releaseFailures = new Map<string, { expiresAt: number; error: Error }>();

  return async (url, cacheMs) => {
    const cached = releaseCache.get(url);
    if (cached && cached.expiresAt > now()) {
      await checkVersion(cached.release.version);
      return cached.release;
    }
    const failed = releaseFailures.get(url);
    if (failed && failed.expiresAt > now()) throw failed.error;

    const pending = releaseRequests.get(url);
    if (pending) return pending;

    const request = (async () => {
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Desktop release manifest returned HTTP ${response.status}.`);
      const body = await readBoundedBody(
        response,
        CURRENT_RELEASE_MAX_BYTES,
        "Desktop release manifest",
      );
      const release = parseMacDesktopPublicReleaseManifest(
        JSON.parse(body),
        MAC_DESKTOP_BETA_RELEASE.version,
      );
      await verifyRelease(release);
      await acceptVersion(release.version);
      releaseFailures.delete(url);
      releaseCache.set(url, { expiresAt: now() + cacheMs, release });
      return release;
    })().catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error("Desktop release manifest request failed.");
      releaseFailures.set(url, { expiresAt: now() + CURRENT_RELEASE_FAILURE_CACHE_MS, error });
      throw error;
    }).finally(() => releaseRequests.delete(url));

    releaseRequests.set(url, request);
    return request;
  };
}

const fetchReleaseManifest = createDesktopReleaseManifestLoader({
  verifyRelease: verifyMacDesktopReleaseArtifacts,
  acceptVersion: advanceDesktopReleaseHighWater,
  checkVersion: assertDesktopReleaseAtOrAboveHighWater,
});

function defaultCurrentRelease(): Promise<MacDesktopPublicReleaseManifest> {
  return fetchReleaseManifest(CURRENT_RELEASE_URL, CURRENT_RELEASE_CACHE_MS);
}

function checksumBody(release: {
  version: string;
  assets: Record<MacDesktopArchitecture, { fileName: string; sha256: string }>;
}): string {
  return [
    `LetAgents for Mac beta v${release.version}`,
    "",
    `SHA-256 (${release.assets.arm64.fileName})`,
    release.assets.arm64.sha256,
    "",
    `SHA-256 (${release.assets.x64.fileName})`,
    release.assets.x64.sha256,
    "",
  ].join("\n");
}

export function registerDesktopDownloadRoutes(
  app: Express,
  deps: DesktopDownloadRouteDeps = {},
): void {
  const loadCurrentRelease = deps.loadCurrentRelease ?? defaultCurrentRelease;
  const canUseBundledFallback = deps.canUseBundledFallback
    ?? (() => canUseBundledDesktopReleaseFallback(MAC_DESKTOP_BETA_RELEASE.version));

  app.get("/downloads/mac/current.json", async (_req, res) => {
    try {
      const release = await loadCurrentRelease();
      res
        .set("Cache-Control", "public, max-age=30, must-revalidate")
        .json(release);
    } catch {
      res.status(503).set("Cache-Control", "no-store").send("Current Mac beta release is temporarily unavailable.");
    }
  });

  for (const release of MAC_DESKTOP_BETA_CHECKSUM_RELEASES) {
    app.get(`/downloads/mac/v${release.version}/checksums`, (_req, res) => {
      res
        .type("text/plain")
        .set("Cache-Control", "public, max-age=86400, immutable")
        .send(checksumBody(release));
    });
  }

  app.get("/downloads/mac/:architecture", async (req, res) => {
    const architecture = parseArchitecture(req.params.architecture);
    if (!architecture) {
      res.status(404).send("Mac beta build not found.");
      return;
    }

    let publicUrl: string;
    try {
      publicUrl = (await loadCurrentRelease()).assets[architecture].publicUrl;
    } catch {
      // A bundled fallback is safe only while the durable release high-water has
      // not moved past it. Fail closed after a newer release or DB uncertainty.
      try {
        if (!await canUseBundledFallback()) throw new Error("Bundled release is stale.");
        publicUrl = MAC_DESKTOP_BETA_RELEASE.assets[architecture].publicUrl;
      } catch {
        res.status(503).set("Cache-Control", "no-store").send("Current Mac beta release is temporarily unavailable.");
        return;
      }
    }
    res
      .set("Cache-Control", "public, max-age=60, must-revalidate")
      .redirect(302, publicUrl);
  });
}
