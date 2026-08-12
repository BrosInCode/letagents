import type { Express, Response } from "express";

import type { Project } from "../../db.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { normalizeRoomId } from "../../rooms/routing.js";
import { PullRequestDiffCache } from "./pull-request-diff-cache.js";

export interface RoomPullRequestDiffRouteDeps {
  resolveCanonicalRoomRequestId(roomId: string): Promise<string>;
  resolveRoomOrReply(roomId: string, res: Response): Promise<Project | null>;
  // Git-room-aware participant gate: public repos allow participants; private/unknown
  // visibility fail closed to a live repo-collaborator check.
  requireParticipant(
    req: AuthenticatedRequest,
    res: Response,
    project: Project,
    options?: { freshCollaboratorCheck?: boolean },
  ): Promise<boolean>;
  getGitHubAppRepositoryByRoomId(roomId: string): Promise<
    | {
        installation_id: string;
        owner_login: string;
        repo_name: string;
        full_name: string;
        host?: string | null;
        removed_at?: string | null;
      }
    | undefined
  >;
  getGitHubAppInstallationById(
    installationId: string,
  ): Promise<{ suspended_at?: string | null; uninstalled_at?: string | null } | undefined>;
  getGitHubRoomEvents(input: {
    room_id: string;
    event_type?: string;
    github_object_id?: string;
    limit?: number;
  }): Promise<{ events: Array<{ head_sha: string | null }> }>;
  fetchPullRequestUnifiedDiff(input: {
    owner: string;
    repo: string;
    number: number;
    installationId: string;
  }): Promise<{ diff: string; headSha: string }>;
}

// Keyed by repo identity + installation + PR + head SHA (written only after auth).
const diffCache = new PullRequestDiffCache();
// Coalesce concurrent misses per repo+PR+expected-SHA so we mint a token / fetch once,
// and a post-force-push request (different SHA) never joins an older in-flight fetch.
const inFlight = new Map<string, Promise<{ diff: string; headSha: string }>>();

function repoPrIdentity(
  repository: { host?: string | null; owner_login: string; repo_name: string; installation_id: string },
  number: number,
): string {
  const host = (repository.host ?? "github.com").toLowerCase();
  return `${host}/${repository.owner_login.toLowerCase()}/${repository.repo_name.toLowerCase()}#inst:${repository.installation_id}#pr:${number}`;
}

const DIFF_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  rate_limited: 429,
  too_large: 413,
  timeout: 504,
  moved: 409,
  sha_mismatch: 409,
  invalid_content: 502,
  upstream: 502,
};

export function registerRoomPullRequestDiffRoutes(
  app: Express,
  deps: RoomPullRequestDiffRouteDeps,
): void {
  app.get(/^\/rooms\/(.+)\/pull-requests\/(\d+)\/diff$/, async (req: AuthenticatedRequest, res) => {
    const params = req.params as Record<string, string>;
    const rawId = decodeURIComponent(params[0] ?? "");
    const number = Number.parseInt(params[1] ?? "", 10);
    if (!Number.isInteger(number) || number <= 0) {
      res.status(400).json({ error: "Invalid pull request number." });
      return;
    }

    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(rawId));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return;

    // (a) Authorize before any repo resolution, cache read, or GitHub fetch.
    //     (d) Unknown repo visibility fails closed inside this git-room-aware gate.
    //     (f) freshCollaboratorCheck bypasses the 30-min positive collaborator cache
    //     so a revoked collaborator loses source-diff access immediately.
    if (!(await deps.requireParticipant(req, res, project, { freshCollaboratorCheck: true }))) return;

    // (b) Focus rooms bind their repository on the parent git-room.
    const repoRoomId = project.parent_room_id ?? project.id;
    const repository = await deps.getGitHubAppRepositoryByRoomId(repoRoomId);
    if (!repository) {
      res.status(404).json({ error: "This room is not connected to a GitHub App repository." });
      return;
    }

    // (4) Reject a removed repository before minting a token, even if the
    //     installation itself is still active.
    if (repository.removed_at) {
      res.status(409).json({ error: "This repository connection has been removed." });
      return;
    }

    // (c) Require an active (non-suspended, non-uninstalled) App installation.
    const installation = await deps.getGitHubAppInstallationById(repository.installation_id);
    if (!installation || installation.suspended_at || installation.uninstalled_at) {
      res.status(409).json({ error: "The GitHub App installation for this repository is not active." });
      return;
    }

    // (c) Only proxy a PR actually associated with this room; its latest
    //     pull_request event supplies the authoritative head SHA.
    const { events } = await deps.getGitHubRoomEvents({
      room_id: repoRoomId,
      event_type: "pull_request",
      github_object_id: String(number),
      limit: 1,
    });
    const eventHeadSha = events[0]?.head_sha ?? null;
    if (!eventHeadSha) {
      res.status(404).json({ error: "No pull request with that number is associated with this room." });
      return;
    }

    // (e) Cache read happens only after authorization, keyed by identity + the
    //     room event's head SHA. A force-push advances that SHA, so the old key misses.
    const cacheKey = `${repoPrIdentity(repository, number)}@${eventHeadSha}`;
    const cached = diffCache.get(cacheKey);
    if (cached !== null) {
      res.json({ number, head_sha: eventHeadSha, diff: cached, cached: true });
      return;
    }

    // (5) Single-flight keyed by identity + expected event SHA so concurrent misses
    //     coalesce onto one fetch, while a post-force-push request (new SHA → new key)
    //     never joins an older in-flight fetch. (3) Only this producer writes the cache.
    let pending = inFlight.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const result = await deps.fetchPullRequestUnifiedDiff({
          owner: repository.owner_login,
          repo: repository.repo_name,
          number,
          installationId: repository.installation_id,
        });
        // (2) The fetched head SHA must match the room event's; otherwise the room's
        //     view is stale (force-push) — fail closed without caching.
        if (result.headSha !== eventHeadSha) {
          throw Object.assign(new Error("pull request head does not match the room event"), {
            code: "sha_mismatch",
          });
        }
        diffCache.set(cacheKey, result.diff);
        return result;
      })().finally(() => {
        inFlight.delete(cacheKey);
      });
      inFlight.set(cacheKey, pending);
    }

    let result: { diff: string; headSha: string };
    try {
      result = await pending;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const status = (code && DIFF_ERROR_STATUS[code]) || 502;
      // Never cache error bodies.
      res.status(status).json({ error: "Could not fetch the pull request diff.", code: code ?? "upstream" });
      return;
    }

    res.json({ number, head_sha: result.headSha, diff: result.diff, cached: false });
  });
}

// Test-only: reset the module-level caches between cases.
export function __resetPullRequestDiffCache(): void {
  diffCache.clear();
  inFlight.clear();
}
