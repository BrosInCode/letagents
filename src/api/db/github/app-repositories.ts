import { desc, eq } from "drizzle-orm";

import { normalizeRoomName } from "../../room-routing.js";
import { db } from "../client.js";
import { toGitHubAppRepository } from "../mappers.js";
import { github_app_repositories } from "../schema.js";
import type { GitHubAppRepository } from "../types.js";

export async function upsertGitHubAppRepository(input: {
  github_repo_id: string;
  installation_id: string;
  owner_login: string;
  repo_name: string;
}): Promise<GitHubAppRepository> {
  const now = new Date().toISOString();
  const full_name = `${input.owner_login}/${input.repo_name}`;
  const room_id = normalizeRoomName(`github.com/${full_name}`);

  const [repository] = await db
    .insert(github_app_repositories)
    .values({
      github_repo_id: input.github_repo_id,
      installation_id: input.installation_id,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
      full_name,
      room_id,
      removed_at: null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: github_app_repositories.github_repo_id,
      set: {
        installation_id: input.installation_id,
        owner_login: input.owner_login,
        repo_name: input.repo_name,
        full_name,
        room_id,
        removed_at: null,
        updated_at: now,
      },
    })
    .returning();

  return toGitHubAppRepository(repository);
}

export async function markGitHubAppRepositoryRemoved(
  githubRepoId: string,
  removedAt = new Date().toISOString()
): Promise<void> {
  await db
    .update(github_app_repositories)
    .set({
      removed_at: removedAt,
      updated_at: removedAt,
    })
    .where(eq(github_app_repositories.github_repo_id, githubRepoId));
}

export async function getGitHubAppRepositoryByFullName(
  fullName: string
): Promise<GitHubAppRepository | undefined> {
  const [repository] = await db
    .select()
    .from(github_app_repositories)
    .where(eq(github_app_repositories.full_name, fullName))
    .limit(1);

  return repository ? toGitHubAppRepository(repository) : undefined;
}

export async function getGitHubAppRepositoryByRoomId(
  roomId: string
): Promise<GitHubAppRepository | undefined> {
  const [repository] = await db
    .select()
    .from(github_app_repositories)
    .where(eq(github_app_repositories.room_id, roomId))
    .orderBy(desc(github_app_repositories.updated_at))
    .limit(1);

  return repository ? toGitHubAppRepository(repository) : undefined;
}
