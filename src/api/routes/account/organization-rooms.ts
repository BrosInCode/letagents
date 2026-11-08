import type { Express } from "express";

import { getConnectedOrganizationRooms, getMemberOrganizationRooms } from "../../db/organization-rooms.js";
import {
  GitHubOrganizationSsoRequiredError,
  listAccessibleOrganizationRepositories,
} from "../../github/organization-repositories.js";
import { filterAccountIdsWithRoomAccess } from "../../server/events.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { organizationRouteDeps, verifiedOrganizationMemberships, type OrganizationRouteDeps } from "./organizations.js";

export interface OrganizationRoomRouteDeps extends OrganizationRouteDeps {
  getConnectedRooms: typeof getConnectedOrganizationRooms;
  listAccessibleRepositories: typeof listAccessibleOrganizationRepositories;
  getMemberRooms: typeof getMemberOrganizationRooms;
  // Same access rule as the rest of the app. Only a confirmed allow
  // (`recents`) keeps a repo room in the list.
  filterRoomAccess: (roomId: string, accountIds: readonly string[]) => Promise<{ recents: string[] }>;
}

const ACCESS_CHECK_CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function registerOrganizationRoomRoutes(app: Express, deps: OrganizationRoomRouteDeps = {
  ...organizationRouteDeps,
  getConnectedRooms: getConnectedOrganizationRooms,
  listAccessibleRepositories: listAccessibleOrganizationRepositories,
  getMemberRooms: getMemberOrganizationRooms,
  filterRoomAccess: filterAccountIdsWithRoomAccess,
}): void {
  app.get("/organizations/:organizationId/rooms", async (req: AuthenticatedRequest, res) => {
    const organizationId = String(req.params.organizationId);
    if (!/^[1-9][0-9]*$/.test(organizationId)) {
      res.status(400).json({ error: "invalid_organization_id" });
      return;
    }
    const memberships = await verifiedOrganizationMemberships(req, res, deps);
    if (!memberships) return;
    const membership = memberships.find((item) => item.github_org_id === organizationId);
    const accountId = req.sessionAccount!.account_id;
    if (!membership) {
      await deps.removeMembership(accountId, organizationId);
      res.status(403).json({ error: "organization_membership_required" });
      return;
    }
    const joinedIds = await deps.getJoinedIds(accountId);
    if (!joinedIds.includes(organizationId)) {
      res.status(403).json({ error: "organization_join_required" });
      return;
    }
    const organization = await deps.saveMembership({ accountId, membership, create: false });
    if (!organization) {
      res.status(409).json({ error: "organization_setup_required" });
      return;
    }
    const candidates = await deps.getConnectedRooms(organizationId);
    let repoRooms: Array<Record<string, unknown>> = [];
    if (candidates.length) {
      let accessible;
      try {
        accessible = await deps.listAccessibleRepositories({
          token: req.sessionAccount!.provider_access_token!,
          organizationId,
          login: membership.login,
        });
      } catch (error) {
        if (error instanceof GitHubOrganizationSsoRequiredError) {
          res.status(403).json({
            error: "organization_sso_required",
            ...(error.authorizeUrl ? { authorize_url: error.authorizeUrl } : {}),
          });
          return;
        }
        res.status(503).json({ error: "organization_rooms_verification_unavailable" });
        return;
      }
      const byId = new Map(accessible.map((repo) => [repo.github_repo_id, repo]));
      const listed = candidates.flatMap((candidate) => {
        const repo = byId.get(candidate.github_repo_id);
        // Wait for existing webhook rename/transfer reconciliation before
        // exposing a room with an outdated canonical repository address.
        if (!repo || repo.full_name.toLowerCase() !== candidate.full_name.toLowerCase()) return [];
        return [{ candidate, repo }];
      });
      // GitHub also lists public repos to people with no role there, but the
      // app needs triage or higher for a public repo room. Ask the same rule.
      let allowed: boolean[];
      try {
        allowed = await mapWithConcurrency(listed, ACCESS_CHECK_CONCURRENCY, async ({ candidate }) =>
          (await deps.filterRoomAccess(candidate.room_id, [accountId])).recents.includes(accountId));
      } catch {
        res.status(503).json({ error: "organization_rooms_verification_unavailable" });
        return;
      }
      repoRooms = listed.flatMap(({ candidate, repo }, index) => allowed[index]
        ? [{
          kind: "repo",
          room_id: candidate.room_id,
          display_name: candidate.display_name,
          full_name: candidate.full_name,
          github_repo_id: candidate.github_repo_id,
          organization_id: organizationId,
          visibility: repo.visibility,
        }]
        : []);
    }
    const memberRooms = await deps.getMemberRooms(organizationId, accountId);
    res.json({
      organization,
      rooms: [
        ...repoRooms,
        ...memberRooms.map((room) => ({
          kind: "room",
          room_id: room.room_id,
          display_name: room.display_name,
          full_name: null,
          github_repo_id: null,
          organization_id: organizationId,
          visibility: null,
        })),
      ],
    });
  });
}
