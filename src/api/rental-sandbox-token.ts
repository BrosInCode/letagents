/**
 * Sandbox token scoping for rental sessions.
 *
 * Creates GitHub installation access tokens scoped to a single repository.
 * Uses raw HTTP + JWT signing (no @octokit dependency).
 *
 * Requires a GitHub App with installation access to the target repo.
 */

import crypto from "crypto";
import { getGitHubAppConfig } from "./github-config.js";
import { db } from "./db/client.js";
import { github_app_repositories } from "./db/schema.js";
import { eq, and, isNull } from "drizzle-orm";

export interface ScopedTokenResult {
  token: string;
  expires_at: string;
  repository_id: number;
  permissions: Record<string, string>;
}

/**
 * Create a JWT for the GitHub App (RS256).
 */
function createAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: appId,
      iat: now - 60,   // issued 60s ago to handle clock skew
      exp: now + 600,   // expires in 10 minutes
    })
  ).toString("base64url");

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

/**
 * Create a repository-scoped GitHub installation access token.
 *
 * @param repoScope - Owner/repo string (e.g. "kdnotfound/myproject")
 * @returns Scoped token, or null if not possible
 */
export async function createScopedInstallationToken(
  repoScope: string
): Promise<ScopedTokenResult | null> {
  const appConfig = await getGitHubAppConfig();

  if (!appConfig.appId || !appConfig.privateKey) {
    console.warn("[sandbox-token] GitHub App not configured — cannot create scoped tokens");
    return null;
  }

  const [owner, repo] = repoScope.split("/");
  if (!owner || !repo) {
    console.warn(`[sandbox-token] Invalid repo_scope: ${repoScope}`);
    return null;
  }

  // Find the installation that covers this repo
  const [appRepo] = await db
    .select()
    .from(github_app_repositories)
    .where(
      and(
        eq(github_app_repositories.owner_login, owner),
        eq(github_app_repositories.repo_name, repo),
        isNull(github_app_repositories.removed_at)
      )
    )
    .limit(1);

  if (!appRepo) {
    console.warn(`[sandbox-token] No GitHub App installation found for ${repoScope}`);
    return null;
  }

  try {
    const jwt = createAppJWT(appConfig.appId, appConfig.privateKey);

    const permissions = {
      contents: "write",
      pull_requests: "write",
      issues: "read",
      metadata: "read",
    };

    const response = await fetch(
      `https://api.github.com/app/installations/${appRepo.installation_id}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          repository_ids: [Number(appRepo.github_repo_id)],
          permissions,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[sandbox-token] GitHub API ${response.status}: ${errorText}`);
      return null;
    }

    const data = (await response.json()) as { token: string; expires_at: string };

    return {
      token: data.token,
      expires_at: data.expires_at,
      repository_id: Number(appRepo.github_repo_id),
      permissions,
    };
  } catch (error) {
    console.error(`[sandbox-token] Failed to create scoped token for ${repoScope}:`, error);
    return null;
  }
}

/**
 * Verify that a GitHub App installation has access to a specific repo.
 */
export async function verifyRepoAccess(repoScope: string): Promise<boolean> {
  const [owner, repo] = repoScope.split("/");
  if (!owner || !repo) return false;

  const [appRepo] = await db
    .select({ github_repo_id: github_app_repositories.github_repo_id })
    .from(github_app_repositories)
    .where(
      and(
        eq(github_app_repositories.owner_login, owner),
        eq(github_app_repositories.repo_name, repo),
        isNull(github_app_repositories.removed_at)
      )
    )
    .limit(1);

  return !!appRepo;
}
