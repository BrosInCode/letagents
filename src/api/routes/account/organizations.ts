import type { Express, Response } from "express";

import {
  getJoinedOrganizationIds,
  getOrganizationsForGitHubIds,
  removeOrganizationMembership,
  saveVerifiedOrganizationMembership,
} from "../../db/organizations.js";
import {
  GitHubOrganizationAccessError,
  GitHubOrganizationScopeError,
  readGitHubOrganizationAccess,
  type GitHubOrganizationAccess,
  type GitHubOrganizationMembership,
} from "../../github/organization-memberships.js";
import type { AuthenticatedRequest } from "../../http/helpers.js";
import { isAppSession, isSameOriginCookieWrite } from "../../request/app-session.js";

export interface OrganizationRouteDeps {
  readAccess: typeof readGitHubOrganizationAccess;
  getOrganizations: typeof getOrganizationsForGitHubIds;
  getJoinedIds: typeof getJoinedOrganizationIds;
  saveMembership: typeof saveVerifiedOrganizationMembership;
  removeMembership: typeof removeOrganizationMembership;
}

export const organizationRouteDeps: OrganizationRouteDeps = {
  readAccess: readGitHubOrganizationAccess,
  getOrganizations: getOrganizationsForGitHubIds,
  getJoinedIds: getJoinedOrganizationIds,
  saveMembership: saveVerifiedOrganizationMembership,
  removeMembership: removeOrganizationMembership,
};

// Company routes are for people in the desktop or web app. Owner tokens,
// agent sessions, and remote MCP tokens are refused.
export async function verifiedOrganizationAccess(
  req: AuthenticatedRequest,
  res: Response,
  deps: Pick<OrganizationRouteDeps, "readAccess">,
): Promise<GitHubOrganizationAccess | null> {
  if (!isAppSession(req)) {
    res.status(req.authKind ? 403 : 401).json({
      error: req.authKind ? "human_app_session_required" : "github_signin_required",
    });
    return null;
  }
  if (!req.sessionAccount || req.sessionAccount.provider !== "github"
    || !req.sessionAccount.provider_access_token) {
    res.status(401).json({ error: "github_signin_required" });
    return null;
  }
  try {
    return await deps.readAccess(req.sessionAccount.provider_access_token);
  } catch (error) {
    if (error instanceof GitHubOrganizationScopeError) {
      res.status(403).json({ error: "github_scope_required" });
      return null;
    }
    const reconnect = error instanceof GitHubOrganizationAccessError && error.status === 401;
    res.status(reconnect ? 401 : 503).json({
      error: reconnect ? "github_signin_required" : "organization_verification_unavailable",
    });
    return null;
  }
}

/**
 * GitHub leaves an organization out of the membership list until the token is
 * authorized for its SAML single sign-on. That says nothing about membership,
 * so answer `organization_sso_required` and keep any stored join.
 */
export function respondIfSsoHidden(access: GitHubOrganizationAccess, organizationId: string, res: Response): boolean {
  if (!access.ssoRequiredOrgIds.includes(organizationId)) return false;
  res.status(403).json({ error: "organization_sso_required" });
  return true;
}

export async function verifiedOrganizationMemberships(
  req: AuthenticatedRequest,
  res: Response,
  deps: Pick<OrganizationRouteDeps, "readAccess">,
): Promise<GitHubOrganizationMembership[] | null> {
  return (await verifiedOrganizationAccess(req, res, deps))?.memberships ?? null;
}

export function registerAccountOrganizationRoutes(
  app: Express,
  deps: OrganizationRouteDeps = organizationRouteDeps,
): void {
  app.get("/account/organizations", async (req: AuthenticatedRequest, res) => {
    const access = await verifiedOrganizationAccess(req, res, deps);
    if (!access) return;
    const { memberships, invitations, ssoRequiredOrgIds } = access;
    const [organizations, joinedIds] = await Promise.all([
      deps.getOrganizations([...memberships.map((membership) => membership.github_org_id), ...ssoRequiredOrgIds]),
      deps.getJoinedIds(req.sessionAccount!.account_id),
    ]);
    const loginById = new Map(organizations.map((org) => [org.github_org_id, org.login]));
    const configured = new Set(organizations.map((org) => org.github_org_id));
    const joined = new Set(joinedIds);
    res.json({
      organizations: memberships.map((membership) => ({
        ...membership,
        setup: configured.has(membership.github_org_id),
        joined: configured.has(membership.github_org_id) && joined.has(membership.github_org_id),
      })),
      invitations,
      sso_required: ssoRequiredOrgIds.map((id) => ({ github_org_id: id, login: loginById.get(id) ?? null })),
    });
  });

  for (const action of ["setup", "join"] as const) {
    app.post(`/organizations/:organizationId/${action}`, async (req: AuthenticatedRequest, res) => {
      const organizationId = String(req.params.organizationId);
      if (!/^[1-9][0-9]*$/.test(organizationId)) {
        res.status(400).json({ error: "invalid_organization_id" });
        return;
      }
      if (isAppSession(req) && !isSameOriginCookieWrite(req)) {
        res.status(403).json({ error: "cross_site_write_refused" });
        return;
      }
      const access = await verifiedOrganizationAccess(req, res, deps);
      if (!access) return;
      const membership = access.memberships.find((org) => org.github_org_id === organizationId);
      if (!membership) {
        if (respondIfSsoHidden(access, organizationId, res)) return;
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
