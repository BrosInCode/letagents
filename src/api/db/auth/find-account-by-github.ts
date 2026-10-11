import { and, eq } from "drizzle-orm";

import { db } from "../client.js";
import { accounts } from "../schema.js";

export interface GitHubUserReference {
  /** Used in logs and messages only. Never used to match an account. */
  login: string;
  github_user_id?: string | null;
}

/**
 * Finds the LetAgents account for a GitHub user by the GitHub user id only.
 * A login can change or be reused, so it never matches an account.
 * Returns null when the id is missing.
 */
export async function findAccountByGitHubUser(
  input: GitHubUserReference,
): Promise<typeof accounts.$inferSelect | null> {
  const githubUserId = input.github_user_id?.trim() || null;
  if (!githubUserId) return null;

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, "github"), eq(accounts.provider_user_id, githubUserId)))
    .limit(1);
  return account ?? null;
}

/** Resolves GitHub users to de-duplicated LetAgents account ids. Unknown users are skipped. */
export async function resolveGitHubNotifyAccountIds(
  users: readonly GitHubUserReference[] | null | undefined,
): Promise<string[]> {
  const accountIds = new Set<string>();
  for (const user of users ?? []) {
    const account = await findAccountByGitHubUser(user);
    if (account) accountIds.add(account.id);
  }
  return [...accountIds];
}
