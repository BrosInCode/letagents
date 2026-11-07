import type { Express } from "express";

import { getConnectedOrganizationRooms } from "../../db/organization-rooms.js";
import { listAccessibleOrganizationRepositories } from "../../github/organization-repositories.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { organizationRouteDeps, verifiedOrganizationMemberships, type OrganizationRouteDeps } from "./organizations.js";

export interface OrganizationRoomRouteDeps extends OrganizationRouteDeps {
  getConnectedRooms: typeof getConnectedOrganizationRooms;
  listAccessibleRepositories: typeof listAccessibleOrganizationRepositories;
}

export function registerOrganizationRoomRoutes(app: Express, deps: OrganizationRoomRouteDeps = {
  ...organizationRouteDeps,
  getConnectedRooms: getConnectedOrganizationRooms,
  listAccessibleRepositories: listAccessibleOrganizationRepositories,
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
    if (!candidates.length) {
      res.json({ organization, rooms: [] });
      return;
    }
    let accessible;
    try {
      accessible = await deps.listAccessibleRepositories({
        token: req.sessionAccount!.provider_access_token!,
        organizationId,
        login: membership.login,
      });
    } catch {
      res.status(503).json({ error: "organization_rooms_verification_unavailable" });
      return;
    }
    const byId = new Map(accessible.map((repo) => [repo.github_repo_id, repo]));
    res.json({
      organization,
      rooms: candidates.flatMap((candidate) => {
        const repo = byId.get(candidate.github_repo_id);
        // Wait for existing webhook rename/transfer reconciliation before
        // exposing a room with an outdated canonical repository address.
        if (!repo || repo.full_name.toLowerCase() !== candidate.full_name.toLowerCase()) return [];
        return [{ ...candidate, organization_id: organizationId, visibility: repo.visibility }];
      }),
    });
  });
}
