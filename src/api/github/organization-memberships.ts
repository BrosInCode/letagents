import { githubRequest } from "./app-client.js";

export interface GitHubOrganizationMembership {
  github_org_id: string;
  login: string;
  avatar_url: string | null;
  role: "owner" | "member";
}

export interface GitHubOrganizationInvitation {
  github_org_id: string;
  login: string;
  avatar_url: string | null;
}

export interface GitHubOrganizationAccess {
  memberships: GitHubOrganizationMembership[];
  invitations: GitHubOrganizationInvitation[];
  // Organizations whose SAML SSO hid them from this token and that are not
  // already visible as active memberships.
  ssoRequiredOrgIds: string[];
}

/** The token lacks an organization-read scope; the person must grant it again. */
export class GitHubOrganizationScopeError extends Error {
  constructor() {
    super("The GitHub token cannot read organization memberships.");
  }
}

const ORG_READ_SCOPES = new Set(["read:org", "write:org", "admin:org"]);

// Classic OAuth tokens report their scopes. GitHub App user tokens send no
// header, so an absent header makes no judgement.
function assertOrganizationReadScope(headers: Headers): void {
  const header = headers.get("x-oauth-scopes");
  if (header === null) return;
  const scopes = header.split(",").map((scope) => scope.trim()).filter(Boolean);
  if (!scopes.some((scope) => ORG_READ_SCOPES.has(scope))) throw new GitHubOrganizationScopeError();
}

// Header form: `partial-results; organizations=1,2`. Keep digits only.
function parsePartialSsoOrganizationIds(headers: Headers): string[] {
  const header = headers.get("x-github-sso");
  if (!header) return [];
  const match = /(?:^|;)\s*partial-results\s*(?:;|$)/i.test(header)
    ? /(?:^|;)\s*organizations=([^;]*)/i.exec(header)
    : null;
  if (!match) return [];
  return match[1].split(",").map((id) => id.trim()).filter((id) => /^[1-9][0-9]*$/.test(id));
}

export class GitHubOrganizationAccessError extends Error {
  constructor(public readonly status: number) {
    super("GitHub organization membership could not be verified.");
  }
}

// Read the authenticated user's memberships (including private memberships),
// never an unauthenticated public org list or a caller-supplied role. GitHub's
// organization membership 'admin' role means organization owner. No state
// filter is sent, so GitHub returns both active and pending memberships.
// https://docs.github.com/en/rest/orgs/members#list-organization-memberships-for-the-authenticated-user
export async function readGitHubOrganizationAccess(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubOrganizationAccess> {
  const memberships = new Map<string, GitHubOrganizationMembership>();
  const invitations = new Map<string, GitHubOrganizationInvitation>();
  const ssoIds = new Set<string>();
  const signal = AbortSignal.timeout(15_000);
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubRequest({
      url: `https://api.github.com/user/memberships/orgs?per_page=100&page=${page}`,
      token,
      signal,
      fetchImpl,
      redirect: "error",
    });
    if (!response.ok) throw new GitHubOrganizationAccessError(response.status);
    assertOrganizationReadScope(response.headers);
    for (const id of parsePartialSsoOrganizationIds(response.headers)) ssoIds.add(id);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new GitHubOrganizationAccessError(502);
    for (const item of payload) {
      if (item?.state !== "active" && item?.state !== "pending") throw new GitHubOrganizationAccessError(502);
      const org = item.organization;
      if (!org || !Number.isSafeInteger(org.id) || org.id <= 0
        || typeof org.login !== "string" || !org.login.trim()
        || (item.role !== "admin" && item.role !== "member")) {
        throw new GitHubOrganizationAccessError(502);
      }
      const id = String(org.id);
      const avatar_url = typeof org.avatar_url === "string" ? org.avatar_url : null;
      if (item.state === "pending") {
        invitations.set(id, { github_org_id: id, login: org.login, avatar_url });
        continue;
      }
      memberships.set(id, {
        github_org_id: id,
        login: org.login,
        avatar_url,
        role: item.role === "admin" ? "owner" : "member",
      });
    }
    // Construct each page on the trusted API host rather than forwarding the
    // user's credential to an arbitrary Link URL. Never return a partial list.
    if (!response.headers.get("link")?.includes('rel="next"')) {
      return {
        memberships: [...memberships.values()],
        invitations: [...invitations.values()].filter((invitation) => !memberships.has(invitation.github_org_id)),
        ssoRequiredOrgIds: [...ssoIds].filter((id) => !memberships.has(id)),
      };
    }
  }
  throw new GitHubOrganizationAccessError(502);
}

export async function listGitHubOrganizationMemberships(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubOrganizationMembership[]> {
  return (await readGitHubOrganizationAccess(token, fetchImpl)).memberships;
}
