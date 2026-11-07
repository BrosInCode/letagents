import { githubRequest } from "./app-client.js";

export interface GitHubOrganizationMembership {
  github_org_id: string;
  login: string;
  avatar_url: string | null;
  role: "owner" | "member";
}

export class GitHubOrganizationAccessError extends Error {
  constructor(public readonly status: number) {
    super("GitHub organization membership could not be verified.");
  }
}

// Read the authenticated user's memberships (including private memberships),
// never an unauthenticated public org list or a caller-supplied role. GitHub's
// organization membership 'admin' role means organization owner.
// https://docs.github.com/en/rest/orgs/members#list-organization-memberships-for-the-authenticated-user
export async function listGitHubOrganizationMemberships(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubOrganizationMembership[]> {
  const memberships = new Map<string, GitHubOrganizationMembership>();
  const signal = AbortSignal.timeout(15_000);
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubRequest({
      url: `https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=${page}`,
      token,
      signal,
      fetchImpl,
      redirect: "error",
    });
    if (!response.ok) throw new GitHubOrganizationAccessError(response.status);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new GitHubOrganizationAccessError(502);
    for (const item of payload) {
      if (item?.state === "pending") continue;
      if (item?.state !== "active") throw new GitHubOrganizationAccessError(502);
      const org = item.organization;
      if (!org || !Number.isSafeInteger(org.id) || org.id <= 0
        || typeof org.login !== "string" || !org.login.trim()
        || (item.role !== "admin" && item.role !== "member")) {
        throw new GitHubOrganizationAccessError(502);
      }
      const id = String(org.id);
      memberships.set(id, {
        github_org_id: id,
        login: org.login,
        avatar_url: typeof org.avatar_url === "string" ? org.avatar_url : null,
        role: item.role === "admin" ? "owner" : "member",
      });
    }
    // Construct each page on the trusted API host rather than forwarding the
    // user's credential to an arbitrary Link URL. Never return a partial list.
    if (!response.headers.get("link")?.includes('rel="next"')) return [...memberships.values()];
  }
  throw new GitHubOrganizationAccessError(502);
}
