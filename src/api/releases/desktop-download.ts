import type { Express } from "express";

import {
  createGitHubAppJwt,
  githubRequest,
  githubRequestJson,
  mintInstallationToken,
} from "../github/app-client.js";
import { getGitHubAppConfig } from "../github/config.js";
import {
  MAC_DESKTOP_BETA_RELEASE,
  type MacDesktopArchitecture,
} from "../../shared/desktop-release.js";

const RELEASE_REPOSITORY = "BrosInCode/letagents";
const GITHUB_API_BASE_URL = "https://api.github.com";

interface GitHubReleaseAsset {
  name: string;
  url: string;
}

interface DesktopDownloadRouteDeps {
  resolveRedirect?: (architecture: MacDesktopArchitecture) => Promise<string>;
  redirectCacheTtlMs?: number;
}

interface CachedRedirect {
  expiresAt: number;
  location: string;
}

const DEFAULT_REDIRECT_CACHE_TTL_MS = 45_000;

let installationIdPromise: Promise<string> | undefined;
let releaseAssetsPromise: Promise<GitHubReleaseAsset[]> | undefined;

function parseArchitecture(raw: string): MacDesktopArchitecture | undefined {
  return raw === "arm64" || raw === "x64" ? raw : undefined;
}

async function getRepositoryInstallationId(): Promise<string> {
  if (!installationIdPromise) {
    installationIdPromise = (async () => {
      const config = await getGitHubAppConfig();
      if (!config.appId || !config.privateKey) {
        throw new Error("GitHub App credentials are not configured");
      }
      const jwt = createGitHubAppJwt({ appId: config.appId, privateKey: config.privateKey });
      const result = await githubRequestJson({
        url: `${GITHUB_API_BASE_URL}/repos/${RELEASE_REPOSITORY}/installation`,
        token: jwt,
        timeoutMs: 10_000,
      });
      const installationId = typeof result === "object" && result && "id" in result
        ? String((result as { id: unknown }).id)
        : "";
      if (!installationId) throw new Error("GitHub repository installation response did not include an id");
      return installationId;
    })().catch((error) => {
      installationIdPromise = undefined;
      throw error;
    });
  }
  return installationIdPromise;
}

async function getReleaseAssets(token: string): Promise<GitHubReleaseAsset[]> {
  if (!releaseAssetsPromise) {
    releaseAssetsPromise = (async () => {
      const result = await githubRequestJson({
        url: `${GITHUB_API_BASE_URL}/repos/${RELEASE_REPOSITORY}/releases/tags/${MAC_DESKTOP_BETA_RELEASE.tag}`,
        token,
        timeoutMs: 10_000,
      });
      const assets = typeof result === "object" && result && "assets" in result
        ? (result as { assets: unknown }).assets
        : undefined;
      if (!Array.isArray(assets)) throw new Error("GitHub release response did not include assets");
      return assets.flatMap((asset) => {
        if (!asset || typeof asset !== "object" || !("name" in asset) || !("url" in asset)) return [];
        return [{ name: String(asset.name), url: String(asset.url) }];
      });
    })().catch((error) => {
      releaseAssetsPromise = undefined;
      throw error;
    });
  }
  return releaseAssetsPromise;
}

export async function resolveDesktopDownloadRedirect(
  architecture: MacDesktopArchitecture,
): Promise<string> {
  const config = await getGitHubAppConfig();
  const installationId = await getRepositoryInstallationId();
  const token = await mintInstallationToken({ config, installationId });
  const assets = await getReleaseAssets(token);
  const expectedName = MAC_DESKTOP_BETA_RELEASE.assets[architecture].fileName;
  const asset = assets.find((candidate) => candidate.name === expectedName);
  if (!asset) throw new Error(`GitHub release asset ${expectedName} was not found`);

  const response = await githubRequest({
    url: asset.url,
    token,
    accept: "application/octet-stream",
    redirect: "manual",
    timeoutMs: 10_000,
  });
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new Error(`GitHub release asset redirect failed with status ${response.status}`);
  }
  return location;
}

export function createCachedDesktopRedirectResolver(
  resolveRedirect: (architecture: MacDesktopArchitecture) => Promise<string>,
  ttlMs = DEFAULT_REDIRECT_CACHE_TTL_MS,
  now = () => Date.now(),
): (architecture: MacDesktopArchitecture) => Promise<string> {
  const cached = new Map<MacDesktopArchitecture, CachedRedirect>();
  const inflight = new Map<MacDesktopArchitecture, Promise<string>>();

  return async (architecture) => {
    const existing = cached.get(architecture);
    if (existing && existing.expiresAt > now()) return existing.location;
    if (existing) cached.delete(architecture);

    const pending = inflight.get(architecture);
    if (pending) return pending;

    let request!: Promise<string>;
    request = resolveRedirect(architecture)
      .then((location) => {
        cached.set(architecture, { location, expiresAt: now() + ttlMs });
        return location;
      })
      .finally(() => {
        if (inflight.get(architecture) === request) inflight.delete(architecture);
      });
    inflight.set(architecture, request);
    return request;
  };
}

export function registerDesktopDownloadRoutes(
  app: Express,
  deps: DesktopDownloadRouteDeps = {},
): void {
  const resolveRedirect = createCachedDesktopRedirectResolver(
    deps.resolveRedirect ?? resolveDesktopDownloadRedirect,
    deps.redirectCacheTtlMs,
  );

  app.get(`/downloads/mac/v${MAC_DESKTOP_BETA_RELEASE.version}/checksums`, (_req, res) => {
    const { version, assets } = MAC_DESKTOP_BETA_RELEASE;
    res
      .type("text/plain")
      .set("Cache-Control", "public, max-age=86400, immutable")
      .send([
        `LetAgents for Mac beta v${version}`,
        "",
        `SHA-256 (${assets.arm64.fileName})`,
        assets.arm64.sha256,
        "",
        `SHA-256 (${assets.x64.fileName})`,
        assets.x64.sha256,
        "",
      ].join("\n"));
  });

  app.get("/downloads/mac/:architecture", async (req, res) => {
    const architecture = parseArchitecture(req.params.architecture);
    if (!architecture) {
      res.status(404).send("Mac beta build not found.");
      return;
    }

    try {
      const location = await resolveRedirect(architecture);
      res.set("Cache-Control", "private, max-age=30").redirect(302, location);
    } catch (error) {
      console.error(`[desktop-download] Failed to resolve ${architecture} beta asset`, error);
      res.status(502).send("The Mac beta download is temporarily unavailable. Please try again shortly.");
    }
  });
}
