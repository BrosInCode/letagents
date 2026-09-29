import crypto from "crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { DEFAULT_FOCUS_ROOM_SETTINGS, type FocusRoomSettingsPatch } from "../focus-rooms/settings.js";
import type { FocusRoomConclusionDetails } from "../focus-rooms/conclusion.js";
import { normalizeRoomDisplayName } from "../rooms/display-name.js";
import { db } from "./client.js";
import { id_sequences, rooms } from "./schema.js";
import { getRoomScopedSequenceNames, isUniqueConstraintError } from "./utils.js";
import { toProject } from "./mappers.js";
import { buildFocusRoomId, getProjectById } from "./rooms.js";
import { getTaskById } from "./tasks.js";
import { acquireLeaseFenceTx, LeaseFenceStaleError, type LeaseFence } from "./coordination/lease-rebind.js";
import type { Project, Task } from "./types.js";

export function truncateDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= 64) {
    return normalized;
  }

  return `${normalized.slice(0, 61).trimEnd()}...`;
}

export function buildFocusRoomDisplayName(task: Task, displayName?: string): string {
  if (displayName?.trim()) {
    return normalizeRoomDisplayName(displayName);
  }

  return normalizeRoomDisplayName(truncateDisplayName(`Focus: ${task.title}`));
}

export function buildFocusRoomDisplayNameFromIntent(intentTitle: string, displayName?: string): string {
  if (displayName?.trim()) {
    return normalizeRoomDisplayName(displayName);
  }

  return normalizeRoomDisplayName(truncateDisplayName(`Focus: ${intentTitle}`));
}

export function normalizeFocusIntentTitle(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("focus intent title is required");
  }
  return truncateDisplayName(normalized);
}

export function buildAdHocFocusKey(intentTitle: string): string {
  const slug = intentTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `focus-${slug || "room"}-${suffix}`;
}

export async function getFocusRoomsForParent(
  parentRoomId: string,
  options: { includeArchived?: boolean } = {}
): Promise<Project[]> {
  const conditions = [
    eq(rooms.parent_room_id, parentRoomId),
    eq(rooms.kind, "focus"),
  ];
  if (!options.includeArchived) {
    conditions.push(isNull(rooms.focus_archived_at));
  }

  const rows = await db
    .select()
    .from(rooms)
    .where(and(...conditions))
    .orderBy(asc(rooms.created_at));

  return rows.map(toProject);
}

export async function getActiveFocusRoomForTask(
  parentRoomId: string,
  taskId: string
): Promise<Project | undefined> {
  const [focusRoom] = await db
    .select()
    .from(rooms)
    .where(
      and(
        eq(rooms.parent_room_id, parentRoomId),
        eq(rooms.source_task_id, taskId),
        eq(rooms.kind, "focus"),
        eq(rooms.focus_status, "active"),
        isNull(rooms.focus_archived_at)
      )
    )
    .limit(1);

  return focusRoom ? toProject(focusRoom) : undefined;
}

export async function getFocusRoomByKey(
  parentRoomId: string,
  focusKey: string,
  options: { includeArchived?: boolean } = {}
): Promise<Project | undefined> {
  const conditions = [
    eq(rooms.parent_room_id, parentRoomId),
    eq(rooms.focus_key, focusKey),
    eq(rooms.kind, "focus"),
  ];
  if (!options.includeArchived) {
    conditions.push(isNull(rooms.focus_archived_at));
  }

  const [focusRoom] = await db
    .select()
    .from(rooms)
    .where(and(...conditions))
    .limit(1);

  return focusRoom ? toProject(focusRoom) : undefined;
}

export async function archiveFocusRoom(
  parentRoomId: string,
  focusKey: string
): Promise<{ room: Project; archived: boolean } | null> {
  const focusRoom = await getFocusRoomByKey(parentRoomId, focusKey);
  if (!focusRoom) {
    const archivedFocusRoom = await getFocusRoomByKey(parentRoomId, focusKey, {
      includeArchived: true,
    });
    return archivedFocusRoom ? { room: archivedFocusRoom, archived: false } : null;
  }

  const [updated] = await db
    .update(rooms)
    .set({ focus_archived_at: new Date().toISOString() })
    .where(
      and(
        eq(rooms.id, focusRoom.id),
        isNull(rooms.focus_archived_at)
      )
    )
    .returning();

  if (updated) {
    return { room: toProject(updated), archived: true };
  }

  const current = await getFocusRoomByKey(parentRoomId, focusKey, {
    includeArchived: true,
  });
  return current ? { room: current, archived: false } : null;
}

export async function activateFocusRoom(
  parentRoomId: string,
  focusKey: string
): Promise<{ room: Project; activated: boolean } | null> {
  const focusRoom = await getFocusRoomByKey(parentRoomId, focusKey, {
    includeArchived: true,
  });
  if (!focusRoom) {
    return null;
  }

  if (
    focusRoom.focus_status === "active" &&
    !focusRoom.focus_archived_at &&
    !focusRoom.concluded_at &&
    !focusRoom.conclusion_summary &&
    !focusRoom.conclusion_details
  ) {
    return { room: focusRoom, activated: false };
  }

  const [updated] = await db
    .update(rooms)
    .set({
      focus_archived_at: null,
      focus_status: "active",
      concluded_at: null,
      conclusion_summary: null,
      conclusion_details: null,
    })
    .where(
      and(
        eq(rooms.id, focusRoom.id),
        eq(rooms.parent_room_id, parentRoomId),
        eq(rooms.focus_key, focusKey),
        eq(rooms.kind, "focus")
      )
    )
    .returning();

  return updated ? { room: toProject(updated), activated: true } : null;
}

export async function claimGitRefFocusRoomLifecycleEvent(
  roomId: string,
  eventOrderAt: string
): Promise<Project | null> {
  const [updated] = await db
    .update(rooms)
    .set({ git_lifecycle_event_order_at: eventOrderAt })
    .where(
      and(
        eq(rooms.id, roomId),
        eq(rooms.kind, "focus"),
        sql`(${rooms.git_lifecycle_event_order_at} IS NULL OR ${rooms.git_lifecycle_event_order_at} < ${eventOrderAt})`
      )
    )
    .returning();

  return updated ? toProject(updated) : null;
}

export async function concludeFocusRoom(
  parentRoomId: string,
  focusKey: string,
  summary: string,
  details: FocusRoomConclusionDetails | null = null,
  // Work-lease fence (plan §4.5): concluding a task-backed focus room is a
  // lease-authorized mutation. When the caller holds the task's work lease, the
  // active→concluded UPDATE runs inside the fence tx so a rebound-away
  // predecessor cannot conclude the room after its lease has moved.
  leaseFence?: LeaseFence | null
): Promise<{ room: Project; task: Task | undefined; updated: boolean } | null> {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary) {
    throw new Error("conclusion summary is required");
  }

  const focusRoom = await getFocusRoomByKey(parentRoomId, focusKey);
  if (!focusRoom) {
    return null;
  }

  const task = focusRoom.source_task_id
    ? await getTaskById(parentRoomId, focusRoom.source_task_id)
    : undefined;

  if (focusRoom.focus_status === "concluded") {
    return { room: focusRoom, task, updated: false };
  }

  const applyConclude = async (executor: Pick<typeof db, "update">) => {
    const [row] = await executor
      .update(rooms)
      .set({
        focus_status: "concluded",
        concluded_at: new Date().toISOString(),
        conclusion_summary: normalizedSummary,
        conclusion_details: details,
      })
      .where(and(eq(rooms.id, focusRoom.id), eq(rooms.focus_status, "active")))
      .returning();
    return row;
  };

  const updated = leaseFence
    ? await db.transaction(async (tx) => {
        if (!(await acquireLeaseFenceTx(tx, leaseFence))) throw new LeaseFenceStaleError();
        return applyConclude(tx);
      })
    : await applyConclude(db);

  if (updated) {
    return { room: toProject(updated), task, updated: true };
  }

  const current = await getFocusRoomByKey(parentRoomId, focusKey);
  return current ? { room: current, task, updated: false } : null;
}

export async function updateFocusRoomSettings(
  parentRoomId: string,
  focusKey: string,
  settings: FocusRoomSettingsPatch
): Promise<Project | null> {
  const patch: Partial<Pick<
    typeof rooms.$inferInsert,
    "focus_parent_visibility" | "focus_activity_scope" | "focus_github_event_routing"
  >> = {};

  if (Object.prototype.hasOwnProperty.call(settings, "parent_visibility")) {
    patch.focus_parent_visibility = settings.parent_visibility;
  }
  if (Object.prototype.hasOwnProperty.call(settings, "activity_scope")) {
    patch.focus_activity_scope = settings.activity_scope;
  }
  if (Object.prototype.hasOwnProperty.call(settings, "github_event_routing")) {
    patch.focus_github_event_routing = settings.github_event_routing;
  }

  if (Object.keys(patch).length === 0) {
    return (await getFocusRoomByKey(parentRoomId, focusKey)) ?? null;
  }

  const [updated] = await db
    .update(rooms)
    .set(patch)
    .where(
      and(
        eq(rooms.parent_room_id, parentRoomId),
        eq(rooms.focus_key, focusKey),
        eq(rooms.kind, "focus"),
        isNull(rooms.focus_archived_at)
      )
    )
    .returning();

  return updated ? toProject(updated) : null;
}

export async function createFocusRoomFromIntent(
  parentRoomId: string,
  intentTitle: string,
  options?: { displayName?: string }
): Promise<{ room: Project; created: true }> {
  const parent = await getProjectById(parentRoomId);
  if (!parent) {
    throw new Error("Parent room not found");
  }
  if (parent.kind === "focus") {
    throw new Error("Focus rooms can only be opened from a main room");
  }

  const normalizedTitle = normalizeFocusIntentTitle(intentTitle);
  const display_name = buildFocusRoomDisplayNameFromIntent(normalizedTitle, options?.displayName);

  while (true) {
    const id = await buildFocusRoomId();
    const focus_key = buildAdHocFocusKey(normalizedTitle);
    const created_at = new Date().toISOString();

    try {
      await db.transaction(async (tx) => {
        await tx.insert(rooms).values({
          id,
          display_name,
          kind: "focus",
          parent_room_id: parent.id,
          focus_key,
          source_task_id: null,
          focus_status: "active",
          focus_parent_visibility: DEFAULT_FOCUS_ROOM_SETTINGS.parent_visibility,
          focus_activity_scope: DEFAULT_FOCUS_ROOM_SETTINGS.activity_scope,
          focus_github_event_routing: DEFAULT_FOCUS_ROOM_SETTINGS.github_event_routing,
          created_at,
        });
        await tx
          .delete(id_sequences)
          .where(inArray(id_sequences.name, getRoomScopedSequenceNames(id)));
      });

      const room = await getProjectById(id);
      if (!room) {
        throw new Error("Focus room was created but could not be loaded");
      }

      return { room, created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }
  }
}

export async function createFocusRoomForTask(
  parentRoomId: string,
  taskId: string,
  options?: { displayName?: string; leaseFence?: LeaseFence | null }
): Promise<{ room: Project; task: Task; created: boolean } | null> {
  const parent = await getProjectById(parentRoomId);
  if (!parent) {
    return null;
  }
  if (parent.kind === "focus") {
    throw new Error("Focus rooms can only be opened from a main room");
  }

  const task = await getTaskById(parent.id, taskId);
  if (!task) {
    return null;
  }

  const existing = await getActiveFocusRoomForTask(parent.id, task.id);
  if (existing) {
    return { room: existing, task, created: false };
  }

  const display_name = buildFocusRoomDisplayName(task, options?.displayName);

  while (true) {
    const id = await buildFocusRoomId();
    const created_at = new Date().toISOString();

    try {
      await db.transaction(async (tx) => {
        // Fence the create on the caller's held work lease (plan §4.5): a
        // rebound-away predecessor cannot open a focus room for a task whose
        // lease has moved. Runs inside the same tx as the room insert.
        if (options?.leaseFence && !(await acquireLeaseFenceTx(tx, options.leaseFence))) {
          throw new LeaseFenceStaleError();
        }
        await tx.insert(rooms).values({
          id,
          display_name,
          kind: "focus",
          parent_room_id: parent.id,
          focus_key: task.id,
          source_task_id: task.id,
          focus_status: "active",
          focus_parent_visibility: DEFAULT_FOCUS_ROOM_SETTINGS.parent_visibility,
          focus_activity_scope: DEFAULT_FOCUS_ROOM_SETTINGS.activity_scope,
          focus_github_event_routing: DEFAULT_FOCUS_ROOM_SETTINGS.github_event_routing,
          created_at,
        });
        await tx
          .delete(id_sequences)
          .where(inArray(id_sequences.name, getRoomScopedSequenceNames(id)));
      });

      const room = await getProjectById(id);
      if (!room) {
        throw new Error("Focus room was created but could not be loaded");
      }

      return { room, task, created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const retried = await getActiveFocusRoomForTask(parent.id, task.id);
      if (retried) {
        return { room: retried, task, created: false };
      }
      const keyed = await getFocusRoomByKey(parent.id, task.id);
      if (keyed) {
        return { room: keyed, task, created: false };
      }
    }
  }
}
