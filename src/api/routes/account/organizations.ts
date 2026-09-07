import type { Express, Response } from "express";

import {
  getJoinedOrganizationIds,
  getOrganizationsForGitHubIds,
  removeOrganizationMembership,
  saveVerifiedOrganizationMembership,
} from "../../db/organizations.js";
import {
  GitHubOrganizationAccessError,
  listGitHubOrganizationMemberships,
  type GitHubOrganizationMembership,
} from "../../github/organization-memberships.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";

export interface OrganizationRouteDeps {
  listMemberships: typeof listGitHubOrganizationMemberships;
  getOrganizations: typeof getOrganizationsForGitHubIds;
  getJoinedIds: typeof getJoinedOrganizationIds;
  saveMembership: typeof saveVerifiedOrganizationMembership;
  removeMembership: typeof removeOrganizationMembership;
}

export const organizationRouteDeps: OrganizationRouteDeps = {
  listMemberships: listGitHubOrganizationMemberships,
  getOrganizations: getOrganizationsForGitHubIds,
  getJoinedIds: getJoinedOrganizationIds,
  saveMembership: saveVerifiedOrganizationMembership,
  removeMembership: removeOrganizationMembership,
};

export async function verifiedOrganizationMemberships(
  req: AuthenticatedRequest,
  res: Response,
  deps: Pick<OrganizationRouteDeps, "listMemberships">,
): Promise<GitHubOrganizationMembership[] | null> {
  if (req.authKind === "agent_session") {
    res.status(403).json({ error: "human_account_required" });
    return null;
  }
  if (!req.sessionAccount || req.sessionAccount.provider !== "github"
    || !req.sessionAccount.provider_access_token) {
    res.status(401).json({ error: "github_signin_required" });
    return null;
  }
  try {
    return await deps.listMemberships(req.sessionAccount.provider_access_token);
  } catch (error) {
    const reconnect = error instanceof GitHubOrganizationAccessError && error.status === 401;
    res.status(reconnect ? 401 : 503).json({
      error: reconnect ? "github_signin_required" : "organization_verification_unavailable",
    });
    return null;
  }
}

export function registerAccountOrganizationRoutes(
  app: Express,
  deps: OrganizationRouteDeps = organizationRouteDeps,
): void {
  app.get("/account/organizations", async (req: AuthenticatedRequest, res) => {
    const memberships = await verifiedOrganizationMemberships(req, res, deps);
    if (!memberships) return;
    const [organizations, joinedIds] = await Promise.all([
      deps.getOrganizations(memberships.map((membership) => membership.github_org_id)),
      deps.getJoinedIds(req.sessionAccount!.account_id),
    ]);
    const configured = new Set(organizations.map((org) => org.github_org_id));
    const joined = new Set(joinedIds);
    res.json({
      organizations: memberships.map((membership) => ({
        ...membership,
        setup: configured.has(membership.github_org_id),
        joined: configured.has(membership.github_org_id) && joined.has(membership.github_org_id),
      })),
    });
  });

  for (const action of ["setup", "join"] as const) {
    app.post(`/organizations/:organizationId/${action}`, async (req: AuthenticatedRequest, res) => {
      const organizationId = String(req.params.organizationId);
      if (!/^[1-9][0-9]*$/.test(organizationId)) {
        res.status(400).json({ error: "invalid_organization_id" });
        return;
      }
      const memberships = await verifiedOrganizationMemberships(req, res, deps);
      if (!memberships) return;
      const membership = memberships.find((org) => org.github_org_id === organizationId);
      if (!membership) {
        await deps.removeMembership(req.sessionAccount!.account_id, organizationId);
        res.status(403).json({ error: "organization_membership_required" });
        return;
      }
      if (action === "setup" && membership.role !== "owner") {
        res.status(403).json({ error: "organization_owner_required" });
        return;
      }
      const organization = await deps.saveMembership({
        accountId: req.sessionAccount!.account_id,
        membership,
        create: action === "setup",
      });
      if (!organization) {
        res.status(409).json({ error: "organization_setup_required" });
        return;
      }
      res.json({ organization, role: membership.role, joined: true });
    });
  }
}
