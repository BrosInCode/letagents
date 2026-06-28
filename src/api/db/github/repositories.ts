import { eq } from "drizzle-orm";

import { normalizeRoomName } from "../../rooms/routing.js";
import { db } from "../client.js";
import { normalizeGitRoomVisibility, upsertGitRoomBinding } from "../git-room-bindings.js";
import { toGitHubRepositoryLink } from "../mappers.js";
import { room_aliases, rooms, github_repositories } from "../schema.js";
import { assertRoomAliasAvailable, getOrCreateCanonicalRoom, getProjectById } from "../rooms.js";
import type { GitHubRepositoryLink, GitRoomVisibility, Project } from "../types.js";

export async function getGitHubRepositoryLinkById(
  githubRepoId: string
): Promise<GitHubRepositoryLink | undefined> {
  const [repo] = await db
    .select()
    .from(github_repositories)
    .where(eq(github_repositories.github_repo_id, githubRepoId))
    .limit(1);

  return repo ? toGitHubRepositoryLink(repo) : undefined;
}

export async function upsertGitHubRepositoryLink(input: {
  github_repo_id: string;
  room_id: string;
  owner_login: string;
  repo_name: string;
  default_branch?: string | null;
  visibility?: GitRoomVisibility | null;
}): Promise<GitHubRepositoryLink> {
  const { room } = await getOrCreateCanonicalRoom(input.room_id);
  const created_at = new Date().toISOString();
  const updated_at = created_at;
  const full_name = `${input.owner_login}/${input.repo_name}`;
  const repositoryUpdate: Partial<typeof github_repositories.$inferInsert> = {
    room_id: room.id,
    owner_login: input.owner_login,
    repo_name: input.repo_name,
    full_name,
    updated_at,
  };
  if (input.default_branch !== undefined) {
    repositoryUpdate.default_branch = input.default_branch;
  }
  if (input.visibility !== undefined) {
    repositoryUpdate.visibility = normalizeGitRoomVisibility(input.visibility);
  }

  const [repo] = await db
    .insert(github_repositories)
    .values({
      github_repo_id: input.github_repo_id,
      room_id: room.id,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
      full_name,
      default_branch: input.default_branch ?? null,
      visibility: normalizeGitRoomVisibility(input.visibility),
      created_at,
      updated_at,
    })
    .onConflictDoUpdate({
      target: github_repositories.github_repo_id,
      set: repositoryUpdate,
    })
    .returning();

  const link = toGitHubRepositoryLink(repo);
  await upsertDefaultGitHubRoomBinding(link);
  return link;
}

async function upsertDefaultGitHubRoomBinding(
  link: GitHubRepositoryLink
): Promise<void> {
  await upsertGitRoomBinding({
    room_id: link.room_id,
    provider: "github",
    host: "github.com",
    repository_id: link.github_repo_id,
    repository_full_name: link.full_name,
    repository_owner: link.owner_login,
    repository_name: link.repo_name,
    ref_type: "default_branch",
    ref_name: link.default_branch,
    default_branch: link.default_branch,
    visibility: link.visibility,
    is_default: true,
    source: "github_repository",
  });
}

export async function migrateGitHubRepositoryCanonicalRoom(input: {
  github_repo_id: string;
  owner_login: string;
  repo_name: string;
}): Promise<Project | null> {
  const existing = await getGitHubRepositoryLinkById(input.github_repo_id);
  if (!existing) {
    return null;
  }

  const nextRoomId = normalizeRoomName(`github.com/${input.owner_login}/${input.repo_name}`);
  if (existing.room_id === nextRoomId) {
    await upsertGitHubRepositoryLink({
      github_repo_id: input.github_repo_id,
      room_id: nextRoomId,
      owner_login: input.owner_login,
      repo_name: input.repo_name,
      default_branch: existing.default_branch,
      visibility: existing.visibility,
    });
    return (await getProjectById(nextRoomId)) ?? null;
  }

  const updated_at = new Date().toISOString();
  await db.transaction(async (tx) => {
    await assertRoomAliasAvailable(nextRoomId, existing.room_id, tx);

    const [existingAlias] = await tx
      .select()
      .from(room_aliases)
      .where(eq(room_aliases.alias, nextRoomId))
      .limit(1);

    if (existingAlias?.room_id === existing.room_id) {
      await tx.delete(room_aliases).where(eq(room_aliases.alias, nextRoomId));
    }

    await tx
      .update(rooms)
      .set({ id: nextRoomId })
      .where(eq(rooms.id, existing.room_id));

    await tx
      .insert(room_aliases)
      .values({
        alias: existing.room_id,
        room_id: nextRoomId,
        created_at: updated_at,
      })
      .onConflictDoNothing();

    await tx
      .update(github_repositories)
      .set({
        room_id: nextRoomId,
        owner_login: input.owner_login,
        repo_name: input.repo_name,
        full_name: `${input.owner_login}/${input.repo_name}`,
        updated_at,
      })
      .where(eq(github_repositories.github_repo_id, input.github_repo_id));
  });

  await upsertDefaultGitHubRoomBinding({
    ...existing,
    room_id: nextRoomId,
    owner_login: input.owner_login,
    repo_name: input.repo_name,
    full_name: `${input.owner_login}/${input.repo_name}`,
    updated_at,
  });

  return (await getProjectById(nextRoomId)) ?? null;
}
