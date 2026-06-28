import { eq, inArray } from "drizzle-orm";

import { db } from "./client.js";
import { toGitRoomBinding } from "./mappers.js";
import { room_git_bindings } from "./schema.js";
import type {
  GitRoomBinding,
  GitRoomBindingSource,
  GitRoomProvider,
  GitRoomRefType,
  GitRoomVisibility,
} from "./types.js";

export interface UpsertGitRoomBindingInput {
  room_id: string;
  provider: GitRoomProvider;
  host: string;
  repository_id?: string | null;
  repository_full_name: string;
  repository_owner: string;
  repository_name: string;
  ref_type: GitRoomRefType;
  ref_name?: string | null;
  default_branch?: string | null;
  base_ref?: string | null;
  head_ref?: string | null;
  head_repository_id?: string | null;
  head_repository_full_name?: string | null;
  head_repository_owner?: string | null;
  head_repository_name?: string | null;
  visibility?: GitRoomVisibility | null;
  is_default?: boolean;
  source: GitRoomBindingSource;
}

export function normalizeGitRoomVisibility(
  visibility: string | null | undefined
): GitRoomVisibility {
  return visibility === "public" || visibility === "private" ? visibility : "unknown";
}

export function buildManualGitHubRepoRoomBindingInput(
  roomId: string
): UpsertGitRoomBindingInput | null {
  const match = /^github\.com\/([^/:\s]+)\/([^/:\s]+)$/i.exec(roomId.trim());
  if (!match) {
    return null;
  }

  const [, rawOwner, rawName] = match;
  const owner = rawOwner.toLowerCase();
  const name = rawName.toLowerCase();
  const canonicalRoomId = `github.com/${owner}/${name}`;
  return {
    room_id: canonicalRoomId,
    provider: "github",
    host: "github.com",
    repository_id: null,
    repository_full_name: `${owner}/${name}`,
    repository_owner: owner,
    repository_name: name,
    ref_type: "default_branch",
    ref_name: null,
    default_branch: null,
    visibility: "unknown",
    is_default: true,
    source: "manual",
  };
}

export async function ensureGitHubRepoRoomBinding(
  roomId: string
): Promise<GitRoomBinding | null> {
  const input = buildManualGitHubRepoRoomBindingInput(roomId);
  if (!input) {
    return null;
  }

  const existing = await getGitRoomBindingForRoom(roomId);
  if (existing) {
    return existing;
  }

  return upsertGitRoomBinding(input);
}

export async function upsertGitRoomBinding(
  input: UpsertGitRoomBindingInput
): Promise<GitRoomBinding> {
  const now = new Date().toISOString();
  const visibility = normalizeGitRoomVisibility(input.visibility);

  const [binding] = await db
    .insert(room_git_bindings)
    .values({
      room_id: input.room_id,
      provider: input.provider,
      host: input.host,
      repository_id: input.repository_id ?? null,
      repository_full_name: input.repository_full_name,
      repository_owner: input.repository_owner,
      repository_name: input.repository_name,
      ref_type: input.ref_type,
      ref_name: input.ref_name ?? null,
      default_branch: input.default_branch ?? null,
      base_ref: input.base_ref ?? null,
      head_ref: input.head_ref ?? null,
      head_repository_id: input.head_repository_id ?? null,
      head_repository_full_name: input.head_repository_full_name ?? null,
      head_repository_owner: input.head_repository_owner ?? null,
      head_repository_name: input.head_repository_name ?? null,
      visibility,
      is_default: input.is_default ?? false,
      source: input.source,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: room_git_bindings.room_id,
      set: {
        provider: input.provider,
        host: input.host,
        repository_id: input.repository_id ?? null,
        repository_full_name: input.repository_full_name,
        repository_owner: input.repository_owner,
        repository_name: input.repository_name,
        ref_type: input.ref_type,
        ref_name: input.ref_name ?? null,
        default_branch: input.default_branch ?? null,
        base_ref: input.base_ref ?? null,
        head_ref: input.head_ref ?? null,
        head_repository_id: input.head_repository_id ?? null,
        head_repository_full_name: input.head_repository_full_name ?? null,
        head_repository_owner: input.head_repository_owner ?? null,
        head_repository_name: input.head_repository_name ?? null,
        visibility,
        is_default: input.is_default ?? false,
        source: input.source,
        updated_at: now,
      },
    })
    .returning();

  return toGitRoomBinding(binding);
}

export async function getGitRoomBindingForRoom(
  roomId: string
): Promise<GitRoomBinding | null> {
  const [binding] = await db
    .select()
    .from(room_git_bindings)
    .where(eq(room_git_bindings.room_id, roomId))
    .limit(1);

  return binding ? toGitRoomBinding(binding) : null;
}

export async function getGitRoomBindingsForRooms(
  roomIds: string[]
): Promise<Map<string, GitRoomBinding>> {
  const uniqueRoomIds = [...new Set(roomIds.filter(Boolean))];
  if (!uniqueRoomIds.length) {
    return new Map();
  }

  const rows = await db
    .select()
    .from(room_git_bindings)
    .where(inArray(room_git_bindings.room_id, uniqueRoomIds));

  return new Map(rows.map((row) => [row.room_id, toGitRoomBinding(row)]));
}
