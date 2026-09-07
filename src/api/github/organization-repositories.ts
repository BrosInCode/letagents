import { githubRequest } from "./app-client.js";
import { GitHubOrganizationAccessError } from "./organization-memberships.js";

export interface AccessibleOrganizationRepository {
  github_repo_id: string;
  full_name: string;
  visibility: "public" | "private";
}

// Use the person's token, never an installation token: company-wide app access
// is not employee access. GitHub filters this list to repositories visible to
// that credential; private entries additionally require explicit read permission.
// https://docs.github.com/en/rest/repos/repos#list-organization-repositories
export async function listAccessibleOrganizationRepositories(input: {
  token: string;
  organizationId: string;
  login: string;
  fetchImpl?: typeof fetch;
}): Promise<AccessibleOrganizationRepository[]> {
  const result = new Map<string, AccessibleOrganizationRepository>();
  const signal = AbortSignal.timeout(15_000);
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubRequest({
      url: `https://api.github.com/orgs/${encodeURIComponent(input.login)}/repos?type=all&sort=full_name&direction=asc&per_page=100&page=${page}`,
      token: input.token,
      fetchImpl: input.fetchImpl,
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new GitHubOrganizationAccessError(response.status);
    const repositories: unknown = await response.json();
    if (!Array.isArray(repositories)) throw new GitHubOrganizationAccessError(502);
    for (const repo of repositories) {
      if (!Number.isSafeInteger(repo?.id) || repo.id <= 0
        || !Number.isSafeInteger(repo?.owner?.id)
        || typeof repo.full_name !== "string" || typeof repo.private !== "boolean") {
        throw new GitHubOrganizationAccessError(502);
      }
      // A rename/transfer racing discovery must not move data across companies.
      if (String(repo.owner.id) !== input.organizationId) continue;
      if (repo.private && repo.permissions?.pull !== true) continue;
      const id = String(repo.id);
      result.set(id, {
        github_repo_id: id,
        full_name: repo.full_name,
        visibility: repo.private ? "private" : "public",
      });
    }
    if (!response.headers.get("link")?.includes('rel="next"')) return [...result.values()];
  }
  throw new GitHubOrganizationAccessError(502);
}
