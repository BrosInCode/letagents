import { and, asc, eq, inArray } from "drizzle-orm";

import { generateRoomDisplayName, normalizeRoomDisplayName } from "../rooms/display-name.js";
import { isInviteCode, normalizeRoomId, normalizeRoomName } from "../rooms/routing.js";
import { db } from "./client.js";
import { ensureGitHubRepoRoomBinding } from "./git-room-bindings.js";
import { id_sequences, room_aliases, rooms } from "./schema.js";
import { generateCode, getRoomScopedSequenceNames, isUniqueConstraintError, type RoomSequenceExecutor } from "./utils.js";
import { toProject, toRoomAlias } from "./mappers.js";
import type { Project, RoomAlias } from "./types.js";

export async function createProject(): Promise<Project> {
  const created_at = new Date().toISOString();

  while (true) {
    const roomId = generateCode();
    const display_name = generateRoomDisplayName(roomId);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(rooms).values({ id: roomId, display_name, created_at });
        await tx
          .delete(id_sequences)
          .where(inArray(id_sequences.name, getRoomScopedSequenceNames(roomId)));
      });
      return {
        id: roomId,
        code: roomId,
        display_name,
        kind: "main",
        parent_room_id: null,
        focus_key: null,
        source_task_id: null,
        focus_status: null,
        focus_parent_visibility: null,
        focus_activity_scope: null,
        focus_github_event_routing: null,
        focus_archived_at: null,
        git_lifecycle_event_order_at: null,
        concluded_at: null,
        conclusion_summary: null,
        conclusion_details: null,
        created_at,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export async function createProjectWithName(name: string): Promise<Project> {
  return (await getOrCreateCanonicalRoom(normalizeRoomName(name))).room;
}

export async function getOrCreateProjectByName(
  name: string
): Promise<{ project: Project; created: boolean }> {
  const canonicalName = normalizeRoomName(name);
  const { room, created } = await getOrCreateCanonicalRoom(canonicalName);
  return { project: room, created };
}

/**
 * Create or retrieve a room using a canonical ID (e.g., "github.com/user/repo").
 * Unlike createProjectWithName, the room's `id` IS the canonical identifier —
 * no separate `name` column needed.
 */
export async function getOrCreateCanonicalRoom(
  canonicalId: string
): Promise<{ room: Project; created: boolean }> {
  const existing = await getProjectById(canonicalId);
  if (existing) {
    await ensureGitHubRepoRoomBinding(existing.id);
    return { room: existing, created: false };
  }

  const created_at = new Date().toISOString();
  const display_name = generateRoomDisplayName(canonicalId);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(rooms).values({ id: canonicalId, display_name, created_at });
      await tx
        .delete(id_sequences)
        .where(inArray(id_sequences.name, getRoomScopedSequenceNames(canonicalId)));
    });
    const room = {
      id: canonicalId,
      code: null,
      display_name,
      name: canonicalId,
      kind: "main",
      parent_room_id: null,
      focus_key: null,
      source_task_id: null,
      focus_status: null,
      focus_parent_visibility: null,
      focus_activity_scope: null,
      focus_github_event_routing: null,
      focus_archived_at: null,
      git_lifecycle_event_order_at: null,
      concluded_at: null,
      conclusion_summary: null,
      conclusion_details: null,
      created_at,
    } satisfies Project;
    await ensureGitHubRepoRoomBinding(room.id);
    return {
      room,
      created: true,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const retried = await getProjectById(canonicalId);
      if (retried) {
        await ensureGitHubRepoRoomBinding(retried.id);
        return { room: retried, created: false };
      }
    }
    throw error;
  }
}

export async function getOrCreateGitChildRoom(input: {
  roomId: string;
  parentRoomId: string;
  focusKey: string;
  displayName?: string | null;
}): Promise<{ room: Project; created: boolean }> {
  const existing = await getProjectById(input.roomId);
  if (existing) {
    return { room: existing, created: false };
  }

  const parent = await getProjectById(input.parentRoomId);
  if (!parent) {
    throw new Error(`Parent room '${input.parentRoomId}' does not exist`);
  }

  const created_at = new Date().toISOString();
  const display_name = input.displayName?.trim() || generateRoomDisplayName(input.roomId);
  try {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(rooms)
        .values({
          id: input.roomId,
          display_name,
          kind: "focus",
          parent_room_id: parent.id,
          focus_key: input.focusKey,
          focus_status: "active",
          created_at,
        })
        .returning();

      await tx
        .delete(id_sequences)
        .where(inArray(id_sequences.name, getRoomScopedSequenceNames(input.roomId)));

      return row;
    });

    return { room: toProject(created), created: true };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const retriedById = await getProjectById(input.roomId);
      if (retriedById) {
        return { room: retriedById, created: false };
      }

      const [retriedByKey] = await db
        .select()
        .from(rooms)
        .where(and(
          eq(rooms.parent_room_id, parent.id),
          eq(rooms.focus_key, input.focusKey),
          eq(rooms.kind, "focus")
        ))
        .limit(1);
      if (retriedByKey) {
        return { room: toProject(retriedByKey), created: false };
      }
    }

    throw error;
  }
}

export async function getGitChildRoom(input: {
  roomId: string;
  parentRoomId: string;
  focusKey: string;
}): Promise<Project | undefined> {
  const room = await getProjectById(input.roomId);
  if (
    room?.kind === "focus" &&
    room.parent_room_id === input.parentRoomId &&
    room.focus_key === input.focusKey
  ) {
    return room;
  }

  const [fallback] = await db
    .select()
    .from(rooms)
    .where(and(
      eq(rooms.parent_room_id, input.parentRoomId),
      eq(rooms.focus_key, input.focusKey),
      eq(rooms.kind, "focus")
    ))
    .limit(1);

  return fallback ? toProject(fallback) : undefined;
}

export async function getProjectByName(name: string): Promise<Project | undefined> {
  return getProjectById(normalizeRoomName(name));
}

export async function getAllProjects(): Promise<Pick<Project, "id" | "code" | "display_name">[]> {
  const rows = await db
    .select()
    .from(rooms)
    .where(eq(rooms.kind, "main"))
    .orderBy(asc(rooms.created_at));
  return rows.map((row) => {
    const project = toProject(row);
    return { id: project.id, code: project.code, display_name: project.display_name };
  });
}

export async function getProjectByCode(code: string): Promise<Project | undefined> {
  const normalizedCode = code.toUpperCase();
  if (!isInviteCode(normalizedCode)) {
    return undefined;
  }

  const [project] = await db.select().from(rooms).where(eq(rooms.id, normalizedCode)).limit(1);
  return project ? toProject(project) : undefined;
}

export async function getRoomAlias(alias: string): Promise<RoomAlias | undefined> {
  const normalizedAlias = normalizeRoomName(alias);
  const [roomAlias] = await db
    .select()
    .from(room_aliases)
    .where(eq(room_aliases.alias, normalizedAlias))
    .limit(1);

  return roomAlias ? toRoomAlias(roomAlias) : undefined;
}

export async function getProjectById(id: string): Promise<Project | undefined> {
  const normalizedId = normalizeRoomId(id);
  const [project] = await db.select().from(rooms).where(eq(rooms.id, normalizedId)).limit(1);
  if (project) {
    return toProject(project);
  }

  if (isInviteCode(normalizedId)) {
    return undefined;
  }

  const roomAlias = await getRoomAlias(normalizedId);
  if (!roomAlias) {
    return undefined;
  }

  const [aliasedProject] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.id, roomAlias.room_id))
    .limit(1);
  return aliasedProject ? toProject(aliasedProject) : undefined;
}

export async function rotateProjectCode(projectId: string): Promise<Project | null> {
  const project = await getProjectById(projectId);
  if (!project || !project.code) return null;

  while (true) {
    const nextCode = generateCode();

    try {
      await db.transaction(async (tx) => {
        await tx.update(rooms).set({ id: nextCode }).where(eq(rooms.id, projectId));
        await tx
          .update(id_sequences)
          .set({ name: `messages:${nextCode}` })
          .where(eq(id_sequences.name, `messages:${projectId}`));
        await tx
          .update(id_sequences)
          .set({ name: `tasks:${nextCode}` })
          .where(eq(id_sequences.name, `tasks:${projectId}`));
      });

      return {
        id: nextCode,
        code: nextCode,
        display_name: project.display_name,
        kind: project.kind,
        parent_room_id: project.parent_room_id,
        focus_key: project.focus_key,
        source_task_id: project.source_task_id,
        focus_status: project.focus_status,
        focus_parent_visibility: project.focus_parent_visibility,
        focus_activity_scope: project.focus_activity_scope,
        focus_github_event_routing: project.focus_github_event_routing,
        focus_archived_at: project.focus_archived_at,
        git_lifecycle_event_order_at: project.git_lifecycle_event_order_at,
        concluded_at: project.concluded_at,
        conclusion_summary: project.conclusion_summary,
        conclusion_details: project.conclusion_details,
        created_at: project.created_at,
      };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export async function updateProjectDisplayName(
  projectId: string,
  displayName: string
): Promise<Project | null> {
  const normalizedDisplayName = normalizeRoomDisplayName(displayName);

  const [updated] = await db
    .update(rooms)
    .set({ display_name: normalizedDisplayName })
    .where(eq(rooms.id, projectId))
    .returning();

  return updated ? toProject(updated) : null;
}

export async function assertRoomAliasAvailable(
  alias: string,
  roomId: string,
  executor: RoomSequenceExecutor = db
): Promise<void> {
  const [occupiedRoom] = await executor
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.id, alias))
    .limit(1);
  if (occupiedRoom && occupiedRoom.id !== roomId) {
    throw new Error(`Alias '${alias}' is already a canonical room id`);
  }

  const [occupiedAlias] = await executor
    .select()
    .from(room_aliases)
    .where(eq(room_aliases.alias, alias))
    .limit(1);
  if (occupiedAlias && occupiedAlias.room_id !== roomId) {
    throw new Error(`Alias '${alias}' is already assigned to a different room`);
  }
}

export async function createRoomAlias(roomId: string, alias: string): Promise<RoomAlias> {
  const normalizedAlias = normalizeRoomName(alias);
  if (isInviteCode(normalizedAlias)) {
    throw new Error("Invite codes cannot be registered as room aliases");
  }
  if (normalizedAlias === roomId) {
    throw new Error("Alias must differ from the canonical room id");
  }

  const created_at = new Date().toISOString();
  return db.transaction(async (tx) => {
    await assertRoomAliasAvailable(normalizedAlias, roomId, tx);

    const [existing] = await tx
      .select()
      .from(room_aliases)
      .where(eq(room_aliases.alias, normalizedAlias))
      .limit(1);
    if (existing) {
      return toRoomAlias(existing);
    }

    const [created] = await tx
      .insert(room_aliases)
      .values({
        alias: normalizedAlias,
        room_id: roomId,
        created_at,
      })
      .returning();

    return toRoomAlias(created);
  });
}
