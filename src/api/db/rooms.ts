import { asc, eq, inArray, sql } from "drizzle-orm";

import { defaultRoomDisplayName, generateRoomDisplayName, normalizeRoomDisplayName } from "../rooms/display-name.js";
import { getRoomNature, isJoinCodeShape, isReservedMainRoomCreationId, originForNewMainRoom, recordStoredRoomOrigin } from "../rooms/room-nature.js";
import { normalizeRoomId, normalizeRoomName } from "../rooms/routing.js";
import { db } from "./client.js";
import { findFocusRoomRowByKey } from "./focus-room-lookup.js";
import { ensureGitHubRepoRoomBinding } from "./git-room-bindings.js";
import { insertRoomRow } from "./room-rows.js";
import {
  agent_asks,
  agent_wake_rules,
  desktop_reminder_deliveries,
  github_app_repositories,
  id_sequences,
  room_aliases,
  rooms,
  supervisor_host_grants,
  tracker_rule_versions,
} from "./schema.js";
import { generateCode, getRoomScopedSequenceNames, isUniqueConstraintError, nextPrefixedId, type RoomSequenceExecutor } from "./utils.js";
import { toProject, toRoomAlias } from "./mappers.js";
import type { Project, RoomAlias } from "./types.js";

export async function createProject(options: { organizationId?: string | null } = {}): Promise<Project> {
  const created_at = new Date().toISOString();

  while (true) {
    const roomId = generateCode();
    const display_name = generateRoomDisplayName(roomId);

    try {
      await db.transaction(async (tx) => {
        await insertRoomRow(tx, {
          id: roomId,
          display_name,
          origin: "join_code",
          created_at,
          ...(options.organizationId ? { organization_id: options.organizationId } : {}),
        });
        await tx
          .delete(id_sequences)
          .where(inArray(id_sequences.name, getRoomScopedSequenceNames(roomId)));
      });
      const project: Project = {
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
      recordStoredRoomOrigin(project, "join_code");
      return project;
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
  if (isReservedMainRoomCreationId(canonicalId)) {
    throw new Error(`'${canonicalId}' is a focus-room locator or reserved room id`);
  }
  const existing = await getProjectById(canonicalId);
  if (existing) {
    await ensureGitHubRepoRoomBinding(existing.id);
    return { room: existing, created: false };
  }

  const created_at = new Date().toISOString();
  const display_name = defaultRoomDisplayName(canonicalId);
  try {
    await db.transaction(async (tx) => {
      await insertRoomRow(tx, { id: canonicalId, display_name, origin: originForNewMainRoom(canonicalId), created_at });
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
    recordStoredRoomOrigin(room, originForNewMainRoom(canonicalId));
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
  parentRoomId: string;
  focusKey: string;
  displayName?: string | null;
}): Promise<{ room: Project; created: boolean }> {
  const parent = await getProjectById(input.parentRoomId);
  if (!parent) {
    throw new Error(`Parent room '${input.parentRoomId}' does not exist`);
  }

  const existing = await getGitChildRoom({
    parentRoomId: parent.id,
    focusKey: input.focusKey,
  });
  if (existing) {
    return { room: existing, created: false };
  }

  while (true) {
    const roomId = await buildFocusRoomId();
    const created_at = new Date().toISOString();
    const display_name = input.displayName?.trim() || generateRoomDisplayName(input.focusKey);
    try {
      const created = await db.transaction(async (tx) => {
        const [row] = await insertRoomRow(tx, {
          id: roomId,
          display_name,
          kind: "focus",
          parent_room_id: parent.id,
          focus_key: input.focusKey,
          focus_status: "active",
          created_at,
        });

        await tx
          .delete(id_sequences)
          .where(inArray(id_sequences.name, getRoomScopedSequenceNames(roomId)));

        return row;
      });

      return { room: toProject(created), created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const retriedByKey = await getGitChildRoom({
        parentRoomId: parent.id,
        focusKey: input.focusKey,
      });
      if (retriedByKey) {
        return { room: retriedByKey, created: false };
      }
    }
  }
}

export async function getGitChildRoom(input: {
  parentRoomId: string;
  focusKey: string;
}): Promise<Project | undefined> {
  // Archived rooms count: a branch room is reopened, never recreated.
  const row = await findFocusRoomRowByKey({
    parentRoomId: input.parentRoomId,
    focusKey: input.focusKey,
    includeArchived: true,
  });

  return row ? toProject(row) : undefined;
}

export async function buildFocusRoomId(executor: RoomSequenceExecutor = db): Promise<string> {
  return nextPrefixedId("focus_rooms", "focus", executor);
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
  if (!isJoinCodeShape(normalizedCode)) {
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

  if (isJoinCodeShape(normalizedId)) {
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

/**
 * Change a room's id inside the caller's transaction. Foreign keys with
 * ON UPDATE CASCADE carry most rows along; this also moves what they cannot:
 * the per-room message and task counters (their names embed the room id) and
 * the columns that store a room id with no foreign key. Without the counters,
 * numbering restarts at 1 and every new message collides with an old one.
 */
export async function renameRoomId(
  tx: RoomSequenceExecutor,
  fromRoomId: string,
  toRoomId: string
): Promise<void> {
  // A main room's origin follows its id: today's callers keep the class
  // (code -> code, repo -> repo), and this keeps any later caller honest.
  // A focus room stays `focus`. Set in the same statement as the new id.
  const [before] = await tx
    .select({ kind: rooms.kind, origin: rooms.origin })
    .from(rooms)
    .where(eq(rooms.id, fromRoomId))
    .limit(1);
  const nextOrigin = before?.kind === "main" ? originForNewMainRoom(toRoomId) : null;
  const originChanges = nextOrigin !== null && before?.origin !== nextOrigin;
  await tx
    .update(rooms)
    .set(originChanges ? { id: toRoomId, origin: nextOrigin } : { id: toRoomId })
    .where(eq(rooms.id, fromRoomId));
  if (originChanges && before?.origin) {
    console.warn(
      `[room origin] rename ${JSON.stringify(fromRoomId)} -> ${JSON.stringify(toRoomId)} changed origin ${before.origin} -> ${nextOrigin}`
    );
  }

  const fromSequences = getRoomScopedSequenceNames(fromRoomId);
  const toSequences = getRoomScopedSequenceNames(toRoomId);
  // No room has the new id, so a counter under that name is a leftover.
  await tx.delete(id_sequences).where(inArray(id_sequences.name, toSequences));
  for (const [index, fromName] of fromSequences.entries()) {
    await tx
      .update(id_sequences)
      .set({ name: toSequences[index] })
      .where(eq(id_sequences.name, fromName));
  }

  await tx
    .update(supervisor_host_grants)
    .set({
      allowed_room_ids: sql`CASE
        WHEN ${toRoomId}::text = ANY(${supervisor_host_grants.allowed_room_ids})
          THEN array_remove(${supervisor_host_grants.allowed_room_ids}, ${fromRoomId}::text)
        ELSE array_replace(${supervisor_host_grants.allowed_room_ids}, ${fromRoomId}::text, ${toRoomId}::text)
      END`,
    })
    .where(sql`${fromRoomId}::text = ANY(${supervisor_host_grants.allowed_room_ids})`);
  await tx.update(agent_asks).set({ room_id: toRoomId }).where(eq(agent_asks.room_id, fromRoomId));
  await tx
    .update(tracker_rule_versions)
    .set({ room_id: toRoomId })
    .where(eq(tracker_rule_versions.room_id, fromRoomId));
  await tx
    .update(github_app_repositories)
    .set({ room_id: toRoomId })
    .where(eq(github_app_repositories.room_id, fromRoomId));
  // A task-watch rule keeps the task's room in its baseline; a stale copy
  // never matches the task again, so the rule would never fire.
  await tx
    .update(agent_wake_rules)
    .set({ baseline: sql`jsonb_set(${agent_wake_rules.baseline}, '{room_id}', to_jsonb(${toRoomId}::text))` })
    .where(sql`${agent_wake_rules.baseline}->>'room_id' = ${fromRoomId}::text`);
  // A queued reminder whose message is not found under its room is deleted.
  await tx
    .update(desktop_reminder_deliveries)
    .set({ room_id: toRoomId })
    .where(eq(desktop_reminder_deliveries.room_id, fromRoomId));
}

export async function rotateProjectCode(projectId: string): Promise<Project | null> {
  const project = await getProjectById(projectId);
  if (!project || !project.code) return null;

  while (true) {
    const nextCode = generateCode();

    try {
      await db.transaction(async (tx) => {
        await renameRoomId(tx, projectId, nextCode);
      });

      const rotated: Project = {
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
      // A rotation changes the id only; the room keeps its origin.
      recordStoredRoomOrigin(rotated, getRoomNature(project).origin);
      return rotated;
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
  if (isJoinCodeShape(normalizedAlias)) {
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
