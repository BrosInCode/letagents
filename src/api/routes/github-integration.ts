import crypto from "crypto";
import type { Express, Response } from "express";

import {
  createAuthState,
  getGitHubAppInstallationById,
  getGitHubAppRepositoryByRoomId,
  type Project,
} from "../db.js";
import { getGitHubAppConfig, hasGitHubAppConfig } from "../github-config.js";
import {
  buildGitHubAppInstallationUrl,
  resolveGitHubAppRoomIntegrationStatus,
} from "../github-app-installation.js";
import { normalizeRoomId } from "../room-routing.js";
import type { AuthenticatedRequest } from "../http-helpers.js";

export interface GitHubIntegrationRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project
  ): Promise<boolean>;
  getProjectAccessRoomId(project: Project): string;
  isRepoBackedProject(project: Project): boolean;
}

async function getGitHubRoomIntegrationProject(
  deps: GitHubIntegrationRouteDeps,
  req: AuthenticatedRequest,
  res: Response,
  rawId: string
): Promise<Project | null> {
  const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
  const project = await deps.resolveRoomOrReply(roomId, res);
  if (!project) {
    return null;
  }

  if (!deps.isRepoBackedProject(project)) {
    res.status(400).json({ error: "GitHub App integrations are only available for repo-backed rooms" });
    return null;
  }

  if (!(await deps.requireParticipant(req, res, project))) {
    return null;
  }

  return project;
}

function isPlatformAdmin(req: AuthenticatedRequest): boolean {
  const platformAdminsStr = process.env.LETAGENTS_PLATFORM_ADMINS;
  if (!platformAdminsStr) return true; // Fallback to room admin if no platform admins defined

  const platformAdmins = platformAdminsStr.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (platformAdmins.length === 0) return true;

  const userLogin = req.sessionAccount?.login?.toLowerCase();
  return Boolean(userLogin && platformAdmins.includes(userLogin));
}

async function buildGitHubRoomIntegrationResponse(
  deps: GitHubIntegrationRouteDeps,
  req: AuthenticatedRequest,
  project: Project
): Promise<ReturnType<typeof resolveGitHubAppRoomIntegrationStatus>> {
  const config = await getGitHubAppConfig();
  const repository = await getGitHubAppRepositoryByRoomId(deps.getProjectAccessRoomId(project));
  const installation = repository
    ? await getGitHubAppInstallationById(repository.installation_id)
    : null;

  return resolveGitHubAppRoomIntegrationStatus({
    configured: await hasGitHubAppConfig(),
    appSlug: config.appSlug ?? null,
    setupUrl: config.setupUrl ?? null,
    isPlatformAdmin: isPlatformAdmin(req),
    repository,
    installation,
  });
}

export function registerGitHubIntegrationSetupRoute(
  app: Express,
  deps: GitHubIntegrationRouteDeps
): void {
  app.post(/^\/api\/rooms\/(.+)\/integrations\/github\/setup-manifest$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const project = await getGitHubRoomIntegrationProject(deps, req, res, rawId);
    if (!project) {
      return;
    }

    if (!(await deps.requireAdmin(req, res, project))) {
      return;
    }

    if (!isPlatformAdmin(req)) {
      res.status(403).json({ error: "Platform admin privileges required to modify global configuration." });
      return;
    }

    const baseUrl = process.env.LETAGENTS_BASE_URL || process.env.PUBLIC_API_URL || "http://localhost:3001";
    const manifest = JSON.stringify({
      name: "letagents-app",
      url: baseUrl,
      hook_attributes: {
        url: `${baseUrl}/webhooks/github`
      },
      redirect_url: `${baseUrl}/auth/github/app/callback`,
      public: true,
      default_permissions: {
        pull_requests: "write",
        issues: "write",
        checks: "write",
        contents: "read",
        metadata: "read"
      },
      default_events: [
        "pull_request",
        "pull_request_review",
        "issues",
        "issue_comment",
        "check_run"
      ]
    });

    const state = crypto.randomBytes(24).toString("hex");
    await createAuthState(state, `/in/${project.id}`);
    const actionPath = `https://github.com/settings/apps/new?state=${state}`;

    res.json({ action: actionPath, manifest });
  });
}

export function registerGitHubIntegrationRoutes(
  app: Express,
  deps: GitHubIntegrationRouteDeps
): void {
  app.get(/^\/api\/rooms\/(.+)\/integrations\/github$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const project = await getGitHubRoomIntegrationProject(deps, req, res, rawId);
    if (!project) {
      return;
    }

    res.json({
      room_id: project.id,
      access_room_id: deps.getProjectAccessRoomId(project),
      ...(await buildGitHubRoomIntegrationResponse(deps, req, project)),
    });
  });

  app.get(/^\/rooms\/(.+)\/integrations\/github$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const project = await getGitHubRoomIntegrationProject(deps, req, res, rawId);
    if (!project) {
      return;
    }

    res.json({
      room_id: project.id,
      access_room_id: deps.getProjectAccessRoomId(project),
      ...(await buildGitHubRoomIntegrationResponse(deps, req, project)),
    });
  });

  app.post(/^\/api\/rooms\/(.+)\/integrations\/github\/install-url$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const project = await getGitHubRoomIntegrationProject(deps, req, res, rawId);
    if (!project) {
      return;
    }

    if (!(await deps.requireAdmin(req, res, project))) {
      return;
    }

    const config = await getGitHubAppConfig();
    if (!(await hasGitHubAppConfig()) || !config.appSlug) {
      res.status(503).json({ error: "GitHub App install flow is not configured" });
      return;
    }

    const state = crypto.randomBytes(24).toString("hex");
    await createAuthState(state, `/in/${project.id}`);

    res.json({
      room_id: project.id,
      install_url: buildGitHubAppInstallationUrl({
        appSlug: config.appSlug,
        state,
      }),
      setup_url: config.setupUrl,
      state,
    });
  });

  app.post(/^\/rooms\/(.+)\/integrations\/github\/install-url$/, async (req: AuthenticatedRequest, res) => {
    const rawId = decodeURIComponent((req.params as Record<string, string>)[0] ?? "");
    const project = await getGitHubRoomIntegrationProject(deps, req, res, rawId);
    if (!project) {
      return;
    }

    if (!(await deps.requireAdmin(req, res, project))) {
      return;
    }

    const config = await getGitHubAppConfig();
    if (!(await hasGitHubAppConfig()) || !config.appSlug) {
      res.status(503).json({ error: "GitHub App install flow is not configured" });
      return;
    }

    const state = crypto.randomBytes(24).toString("hex");
    await createAuthState(state, `/in/${project.id}`);

    res.json({
      room_id: project.id,
      install_url: buildGitHubAppInstallationUrl({
        appSlug: config.appSlug,
        state,
      }),
      setup_url: config.setupUrl,
      state,
    });
  });
}
