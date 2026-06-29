import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  DesktopAccountRoomEntry,
  DesktopLocalRoomInfo,
  DesktopRoomStorageOverrideMode,
  DesktopRoomStorageState,
  DesktopTaskSummary,
} from "../../ipc-types.js";
import {
  localChatDatabasePath,
  localFilesPath,
  resolveRoomStorageMode,
  setRoomStorageMode,
} from "../chat-storage/settings.js";

type SqliteStatement = {
  all: (...params: unknown[]) => Record<string, unknown>[];
  get: (...params: unknown[]) => Record<string, unknown> | undefined;
  run: (...params: unknown[]) => unknown;
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
};

type LocalRoomRow = {
  room_id: string;
  display_name: string;
  cloud_room_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  archived_at: string | null;
  pinned_at: string | null;
};

type LocalTaskRow = {
  room_id: string;
  task_id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  assignee_agent_key: string | null;
  created_by: string | null;
  pr_url: string | null;
  workflow_artifacts_json: string | null;
  workflow_refs_json: string | null;
  synced_cloud_id: string | null;
  sync_key: string | null;
  sync_dirty: number;
  review_lease_id: string | null;
  review_holder_label: string | null;
  review_agent_key: string | null;
  review_agent_session_id: string | null;
  review_updated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LocalTaskInput = {
  title: string;
  description?: string | null;
  createdBy?: string | null;
};

export type LocalTaskPatch = {
  status?: string | null;
  assignee?: string | null;
  assigneeAgentKey?: string | null;
  prUrl?: string | null;
  workflowArtifacts?: DesktopTaskSummary["workflowArtifacts"] | null;
  validateStatus?: boolean;
};

export type LocalReviewLeaseInput = {
  holderLabel?: string | null;
  agentKey?: string | null;
  agentSessionId?: string | null;
  leaseId?: string | null;
};

const require = createRequire(import.meta.url);
let db: SqliteDatabase | null = null;
let initialized = false;

const validLocalTaskTransitions: Record<string, string[]> = {
  proposed: ["accepted", "cancelled"],
  accepted: ["assigned", "cancelled"],
  assigned: ["in_progress", "in_review", "cancelled"],
  in_progress: ["blocked", "in_review", "done", "cancelled"],
  blocked: ["in_progress", "in_review", "cancelled"],
  in_review: ["merged", "in_progress", "blocked", "done", "cancelled"],
  merged: ["done", "accepted"],
  done: ["accepted"],
  cancelled: ["accepted"],
};

async function getDb(): Promise<SqliteDatabase> {
  if (db) return db;
  await mkdir(dirname(localChatDatabasePath), { recursive: true });
  await mkdir(localFilesPath, { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  db = new DatabaseSync(localChatDatabasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (!initialized) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_rooms (
        room_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        cloud_room_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT,
        archived_at TEXT,
        pinned_at TEXT
      );
      CREATE INDEX IF NOT EXISTS local_rooms_updated_idx
        ON local_rooms (updated_at);

      CREATE TABLE IF NOT EXISTS local_task_room_sequences (
        room_id TEXT PRIMARY KEY,
        next_number INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_tasks (
        room_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        assignee TEXT,
        assignee_agent_key TEXT,
        created_by TEXT,
        pr_url TEXT,
        workflow_artifacts_json TEXT,
        workflow_refs_json TEXT,
        synced_cloud_id TEXT,
        sync_key TEXT,
        sync_started_at TEXT,
        sync_dirty INTEGER NOT NULL DEFAULT 0,
        review_lease_id TEXT,
        review_holder_label TEXT,
        review_agent_key TEXT,
        review_agent_session_id TEXT,
        review_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS local_tasks_room_status_idx
        ON local_tasks (room_id, status, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS local_tasks_sync_key_idx
        ON local_tasks (room_id, sync_key)
        WHERE sync_key IS NOT NULL;
    `);
    addColumnIfMissing(db, "local_rooms", "published_at", "TEXT");
    addColumnIfMissing(db, "local_rooms", "archived_at", "TEXT");
    addColumnIfMissing(db, "local_rooms", "pinned_at", "TEXT");
    addColumnIfMissing(db, "local_tasks", "assignee_agent_key", "TEXT");
    addColumnIfMissing(db, "local_tasks", "workflow_artifacts_json", "TEXT");
    addColumnIfMissing(db, "local_tasks", "workflow_refs_json", "TEXT");
    addColumnIfMissing(db, "local_tasks", "sync_started_at", "TEXT");
    addColumnIfMissing(db, "local_tasks", "sync_dirty", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "local_tasks", "review_lease_id", "TEXT");
    addColumnIfMissing(db, "local_tasks", "review_holder_label", "TEXT");
    addColumnIfMissing(db, "local_tasks", "review_agent_key", "TEXT");
    addColumnIfMissing(db, "local_tasks", "review_agent_session_id", "TEXT");
    addColumnIfMissing(db, "local_tasks", "review_updated_at", "TEXT");
    initialized = true;
  }
  return db;
}

function addColumnIfMissing(
  database: SqliteDatabase,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  try {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

function beginImmediate(database: SqliteDatabase): void {
  database.exec("BEGIN IMMEDIATE");
}

function rollback(database: SqliteDatabase): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // SQLite may already have closed the transaction after an error.
  }
}

function mapRoomRow(row: Record<string, unknown>): LocalRoomRow {
  return {
    room_id: String(row.room_id || ""),
    display_name: String(row.display_name || row.room_id || ""),
    cloud_room_id:
      typeof row.cloud_room_id === "string" && row.cloud_room_id.trim()
        ? row.cloud_room_id
        : null,
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    published_at:
      typeof row.published_at === "string" && row.published_at.trim()
        ? row.published_at
        : null,
    archived_at:
      typeof row.archived_at === "string" && row.archived_at.trim()
        ? row.archived_at
        : null,
    pinned_at:
      typeof row.pinned_at === "string" && row.pinned_at.trim()
        ? row.pinned_at
        : null,
  };
}

function mapTaskRow(row: Record<string, unknown>): LocalTaskRow {
  return {
    room_id: String(row.room_id || ""),
    task_id: String(row.task_id || ""),
    title: String(row.title || ""),
    description: typeof row.description === "string" ? row.description : null,
    status: String(row.status || "proposed"),
    assignee: typeof row.assignee === "string" ? row.assignee : null,
    assignee_agent_key:
      typeof row.assignee_agent_key === "string"
        ? row.assignee_agent_key
        : null,
    created_by: typeof row.created_by === "string" ? row.created_by : null,
    pr_url: typeof row.pr_url === "string" ? row.pr_url : null,
    workflow_artifacts_json:
      typeof row.workflow_artifacts_json === "string"
        ? row.workflow_artifacts_json
        : null,
    workflow_refs_json:
      typeof row.workflow_refs_json === "string" ? row.workflow_refs_json : null,
    synced_cloud_id:
      typeof row.synced_cloud_id === "string" ? row.synced_cloud_id : null,
    sync_key: typeof row.sync_key === "string" ? row.sync_key : null,
    sync_dirty: Number(row.sync_dirty || 0),
    review_lease_id:
      typeof row.review_lease_id === "string" ? row.review_lease_id : null,
    review_holder_label:
      typeof row.review_holder_label === "string" ? row.review_holder_label : null,
    review_agent_key:
      typeof row.review_agent_key === "string" ? row.review_agent_key : null,
    review_agent_session_id:
      typeof row.review_agent_session_id === "string"
        ? row.review_agent_session_id
        : null,
    review_updated_at:
      typeof row.review_updated_at === "string" ? row.review_updated_at : null,
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function parseJsonArray<T>(value: string | null, fallback: T[]): T[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function toLocalRoomInfo(row: LocalRoomRow): DesktopLocalRoomInfo {
  return {
    roomIdentifier: row.room_id,
    displayName: row.display_name,
    cloudRoomIdentifier: row.cloud_room_id,
    publishStatus: row.cloud_room_id ? "linked" : "local_only",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

function toTaskSummary(row: LocalTaskRow): DesktopTaskSummary {
  const activeLeases: DesktopTaskSummary["activeLeases"] = [];
  if (row.review_lease_id) {
    activeLeases.push({
      id: row.review_lease_id,
      kind: "review",
      holderLabel: row.review_holder_label,
      agentKey: row.review_agent_key,
      agentSessionId: row.review_agent_session_id,
      status: "active",
      updatedAt: row.review_updated_at,
    });
  }
  return {
    id: row.task_id,
    title: row.title || row.task_id,
    description: row.description,
    status: row.status,
    assignee: row.assignee,
    assigneeAgentKey: row.assignee_agent_key,
    createdBy: row.created_by,
    prUrl: row.pr_url,
    workflowArtifacts: parseJsonArray(row.workflow_artifacts_json, []),
    workflowRefs: parseJsonArray(row.workflow_refs_json, []),
    activeLeases,
    activeLocks: [],
    stalePromptState: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function allocateTaskId(database: SqliteDatabase, roomId: string): string {
  database
    .prepare(`
      INSERT INTO local_task_room_sequences (room_id, next_number)
      SELECT ?, COALESCE(MAX(CAST(SUBSTR(task_id, 6) AS INTEGER)), 0) + 1
      FROM local_tasks
      WHERE room_id = ? AND task_id GLOB 'task_[0-9]*'
      ON CONFLICT(room_id) DO NOTHING
    `)
    .run(roomId, roomId);
  const row = database
    .prepare("SELECT next_number FROM local_task_room_sequences WHERE room_id = ?")
    .get(roomId);
  const number = Number(row?.next_number || 0);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("Local task sequence could not be allocated.");
  }
  database
    .prepare("UPDATE local_task_room_sequences SET next_number = next_number + 1 WHERE room_id = ?")
    .run(roomId);
  return `task_${number}`;
}

function resolveLocalTaskStatus(
  fromStatus: string,
  toStatus?: string | null,
): string {
  const nextStatus = toStatus?.trim();
  if (!nextStatus) return fromStatus;
  if (!validLocalTaskTransitions[fromStatus]?.includes(nextStatus)) {
    throw new Error(
      `Invalid transition: ${fromStatus} -> ${nextStatus}. ` +
        `Allowed: ${validLocalTaskTransitions[fromStatus]?.join(", ") || "none"}`,
    );
  }
  return nextStatus;
}

export async function createLocalRoom(input: {
  displayName?: string | null;
  roomIdentifier?: string | null;
  cloudRoomIdentifier?: string | null;
} = {}): Promise<DesktopLocalRoomInfo> {
  const database = await getDb();
  const now = new Date().toISOString();
  const roomId = input.roomIdentifier?.trim() || `local_${randomUUID()}`;
  const displayName = input.displayName?.trim() || "Local room";
  database
    .prepare(`
      INSERT INTO local_rooms (
        room_id, display_name, cloud_room_id, created_at, updated_at, published_at, archived_at, pinned_at
      )
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(room_id) DO UPDATE SET
        display_name = excluded.display_name,
        cloud_room_id = COALESCE(excluded.cloud_room_id, local_rooms.cloud_room_id),
        updated_at = excluded.updated_at,
        archived_at = NULL
    `)
    .run(roomId, displayName, input.cloudRoomIdentifier || null, now, now);
  const room = await getLocalRoom(roomId);
  if (!room) throw new Error("Local room could not be created.");
  return room;
}

export async function getLocalRoom(
  roomIdentifier: string,
): Promise<DesktopLocalRoomInfo | null> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) return null;
  const database = await getDb();
  const row = database
    .prepare("SELECT * FROM local_rooms WHERE room_id = ? AND archived_at IS NULL")
    .get(trimmedRoomIdentifier);
  return row ? toLocalRoomInfo(mapRoomRow(row)) : null;
}

export async function getLocalRoomByCloudRoom(
  cloudRoomIdentifier: string,
): Promise<DesktopLocalRoomInfo | null> {
  const trimmedRoomIdentifier = cloudRoomIdentifier.trim();
  if (!trimmedRoomIdentifier) return null;
  const database = await getDb();
  const row = database
    .prepare("SELECT * FROM local_rooms WHERE cloud_room_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1")
    .get(trimmedRoomIdentifier);
  return row ? toLocalRoomInfo(mapRoomRow(row)) : null;
}

export async function listLocalRoomEntries(
  options: { includeArchived?: boolean; linkedIdentity?: "local" | "cloud" } = {},
): Promise<DesktopAccountRoomEntry[]> {
  const database = await getDb();
  const rows = database
    .prepare(`
      SELECT *
      FROM local_rooms
      ${options.includeArchived ? "" : "WHERE archived_at IS NULL"}
      ORDER BY updated_at DESC
    `)
    .all()
    .map(mapRoomRow);
  return rows.map((row) => ({
    roomIdentifier:
      options.linkedIdentity === "cloud" && row.cloud_room_id
        ? row.cloud_room_id
        : row.room_id,
    displayName: row.display_name,
    name: row.display_name,
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "admin",
    source: "local",
    pinned: Boolean(row.pinned_at),
    archived: Boolean(row.archived_at),
    canLeave: false,
    canDelete: true,
    deleteReason: null,
    firstOpenedAt: row.created_at,
    lastOpenedAt: row.updated_at,
    latestMessageId: null,
    latestMessageAt: null,
    gitRoom: null,
    focusRooms: [],
  }));
}

export async function archiveLocalRoom(
  roomIdentifier: string,
): Promise<boolean> {
  return setLocalRoomArchived(roomIdentifier, true);
}

export async function getLocalRoomIncludingArchived(
  roomIdentifier: string,
): Promise<DesktopLocalRoomInfo | null> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) return null;
  const database = await getDb();
  const row = database
    .prepare(`
      SELECT *
      FROM local_rooms
      WHERE room_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get(trimmedRoomIdentifier);
  return row ? toLocalRoomInfo(mapRoomRow(row)) : null;
}

export async function getLocalRoomByCloudRoomIncludingArchived(
  cloudRoomIdentifier: string,
): Promise<DesktopLocalRoomInfo | null> {
  const trimmedRoomIdentifier = cloudRoomIdentifier.trim();
  if (!trimmedRoomIdentifier) return null;
  const database = await getDb();
  const row = database
    .prepare(`
      SELECT *
      FROM local_rooms
      WHERE cloud_room_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get(trimmedRoomIdentifier);
  return row ? toLocalRoomInfo(mapRoomRow(row)) : null;
}

async function getLocalRoomForMutationIncludingArchived(
  roomIdentifier: string,
): Promise<DesktopLocalRoomInfo | null> {
  return await getLocalRoomIncludingArchived(roomIdentifier)
    || await getLocalRoomByCloudRoomIncludingArchived(roomIdentifier);
}

export async function updateLocalRoomDisplayName(
  roomIdentifier: string,
  displayName: string,
): Promise<DesktopLocalRoomInfo> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedDisplayName = displayName.trim();
  if (!trimmedRoomIdentifier) throw new Error("Choose a room before renaming it.");
  if (!trimmedDisplayName) throw new Error("Enter a room name.");
  const room = await getLocalRoom(trimmedRoomIdentifier)
    || await getLocalRoomByCloudRoom(trimmedRoomIdentifier);
  if (!room) throw new Error("Local room not found.");
  const database = await getDb();
  const now = new Date().toISOString();
  database
    .prepare(`
      UPDATE local_rooms
      SET display_name = ?, updated_at = ?
      WHERE room_id = ?
    `)
    .run(trimmedDisplayName, now, room.roomIdentifier);
  const updated = await getLocalRoom(room.roomIdentifier);
  if (!updated) throw new Error("Local room could not be renamed.");
  return updated;
}

export async function setLocalRoomArchived(
  roomIdentifier: string,
  archived: boolean,
): Promise<boolean> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) return false;
  const room = await getLocalRoomForMutationIncludingArchived(trimmedRoomIdentifier);
  if (!room) return false;
  const database = await getDb();
  const now = new Date().toISOString();
  database
    .prepare(`
      UPDATE local_rooms
      SET archived_at = ?, updated_at = ?
      WHERE room_id = ?
    `)
    .run(archived ? now : null, now, room.roomIdentifier);
  return true;
}

export async function setLocalRoomPinned(
  roomIdentifier: string,
  pinned: boolean,
): Promise<boolean> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) return false;
  const room = await getLocalRoomForMutationIncludingArchived(trimmedRoomIdentifier);
  if (!room) return false;
  const database = await getDb();
  const now = new Date().toISOString();
  database
    .prepare(`
      UPDATE local_rooms
      SET pinned_at = ?, updated_at = ?
      WHERE room_id = ?
    `)
    .run(pinned ? now : null, now, room.roomIdentifier);
  return true;
}

export async function resolveLocalAwareRoomStorageMode(
  roomIdentifier?: string | null,
): Promise<DesktopRoomStorageState> {
  const resolved = await resolveRoomStorageMode(roomIdentifier);
  const trimmedRoomIdentifier = resolved.roomIdentifier?.trim() || "";
  const localRoom = trimmedRoomIdentifier
    ? await getLocalRoom(trimmedRoomIdentifier)
      || await getLocalRoomByCloudRoom(trimmedRoomIdentifier)
    : null;
  const localOnlyRoom = Boolean(localRoom && !localRoom.cloudRoomIdentifier);
  const requestedIdentifier = resolved.roomIdentifier;
  const requestedLocalRoom = Boolean(
    localRoom?.roomIdentifier &&
      requestedIdentifier &&
      localRoom.roomIdentifier === requestedIdentifier,
  );
  const aliasModes = await Promise.all(
    [
      requestedIdentifier,
      localRoom?.cloudRoomIdentifier,
      localRoom?.roomIdentifier,
    ]
      .filter((value, index, values): value is string =>
        Boolean(value && values.indexOf(value) === index)
      )
      .map((identifier) => resolveRoomStorageMode(identifier)),
  );
  const aliasOverrideMode =
    aliasModes.find((mode) => mode.overrideMode !== "inherit")?.overrideMode
      || "inherit";
  const effectiveMode =
    aliasOverrideMode === "cloud" && !localOnlyRoom
      ? "cloud"
      : localOnlyRoom ||
          requestedLocalRoom ||
          aliasOverrideMode === "local" ||
          (aliasOverrideMode === "inherit" && resolved.defaultMode === "local")
        ? "local"
        : "cloud";
  return {
    ...resolved,
    overrideMode: aliasOverrideMode,
    effectiveMode,
    isLocalRoom: effectiveMode === "local",
    localRoom,
  };
}

export async function setLocalAwareRoomStorageMode(
  roomIdentifier: string,
  mode: DesktopRoomStorageOverrideMode,
): Promise<DesktopRoomStorageState> {
  const localRoom = await getLocalRoom(roomIdentifier)
    || await getLocalRoomByCloudRoom(roomIdentifier);
  if (localRoom?.cloudRoomIdentifier) {
    await setRoomStorageMode(localRoom.roomIdentifier, "inherit");
    await setRoomStorageMode(localRoom.cloudRoomIdentifier, mode);
    return resolveLocalAwareRoomStorageMode(localRoom.cloudRoomIdentifier);
  }

  await setRoomStorageMode(roomIdentifier, mode);
  return resolveLocalAwareRoomStorageMode(roomIdentifier);
}

export function localRoomIdentifierForStorage(
  storage: DesktopRoomStorageState,
  fallbackRoomIdentifier: string,
): string {
  return storage.localRoom?.roomIdentifier || fallbackRoomIdentifier.trim();
}

export function cloudRoomIdentifierForStorage(
  storage: DesktopRoomStorageState,
  fallbackRoomIdentifier: string,
): string {
  return storage.effectiveMode === "cloud" && storage.localRoom?.cloudRoomIdentifier
    ? storage.localRoom.cloudRoomIdentifier
    : fallbackRoomIdentifier.trim();
}

export async function listLocalTasks(roomId: string): Promise<DesktopTaskSummary[]> {
  const database = await getDb();
  return database
    .prepare("SELECT * FROM local_tasks WHERE room_id = ? ORDER BY created_at ASC")
    .all(roomId)
    .map(mapTaskRow)
    .map(toTaskSummary);
}

export async function addLocalTask(
  roomId: string,
  input: LocalTaskInput,
): Promise<DesktopTaskSummary> {
  const trimmedRoomId = roomId.trim();
  const title = input.title.trim();
  if (!trimmedRoomId) throw new Error("Choose a room before adding a task.");
  if (!title) throw new Error("Task title is required.");
  const database = await getDb();
  const now = new Date().toISOString();
  let taskId = "";
  beginImmediate(database);
  try {
    taskId = allocateTaskId(database, trimmedRoomId);
    database
      .prepare(`
        INSERT INTO local_tasks (
          room_id, task_id, title, description, status, assignee, assignee_agent_key,
          created_by, pr_url, workflow_artifacts_json, workflow_refs_json,
          synced_cloud_id, sync_key, sync_started_at, sync_dirty, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'proposed', NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, NULL, 1, ?, ?)
      `)
      .run(
        trimmedRoomId,
        taskId,
        title,
        input.description?.trim() || null,
        input.createdBy || "human",
        `local-task:${trimmedRoomId}:${taskId}`,
        now,
        now,
      );
    touchLocalRoom(database, trimmedRoomId, now);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
  const task = await getLocalTask(trimmedRoomId, taskId);
  if (!task) throw new Error("Local task could not be created.");
  return task;
}

export async function getLocalTask(
  roomId: string,
  taskId: string,
): Promise<DesktopTaskSummary | null> {
  const database = await getDb();
  const row = database
    .prepare("SELECT * FROM local_tasks WHERE room_id = ? AND task_id = ?")
    .get(roomId, taskId);
  return row ? toTaskSummary(mapTaskRow(row)) : null;
}

export async function updateLocalTask(
  roomId: string,
  taskId: string,
  patch: LocalTaskPatch,
): Promise<DesktopTaskSummary> {
  const database = await getDb();
  const currentRow = database
    .prepare("SELECT * FROM local_tasks WHERE room_id = ? AND task_id = ?")
    .get(roomId, taskId);
  if (!currentRow) throw new Error("Task not found.");
  const current = mapTaskRow(currentRow);
  const nextStatus =
    patch.validateStatus === false
      ? patch.status?.trim() || current.status
      : resolveLocalTaskStatus(current.status, patch.status);
  const now = new Date().toISOString();
  const workflowArtifacts =
    patch.workflowArtifacts === undefined
      ? current.workflow_artifacts_json
      : JSON.stringify(patch.workflowArtifacts || []);
  database
    .prepare(`
      UPDATE local_tasks
      SET status = ?,
          assignee = ?,
          assignee_agent_key = ?,
          pr_url = ?,
          workflow_artifacts_json = ?,
          sync_dirty = 1,
          updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
    .run(
      nextStatus,
      patch.assignee === undefined ? current.assignee : patch.assignee,
      patch.assigneeAgentKey === undefined
        ? current.assignee_agent_key
        : patch.assigneeAgentKey,
      patch.prUrl === undefined ? current.pr_url : patch.prUrl,
      workflowArtifacts,
      now,
      roomId,
      taskId,
    );
  touchLocalRoom(database, roomId, now);
  const updated = await getLocalTask(roomId, taskId);
  if (!updated) throw new Error("Task not found.");
  return updated;
}

export async function claimLocalTaskReviewLease(
  roomId: string,
  taskId: string,
  input: LocalReviewLeaseInput,
): Promise<{ task: DesktopTaskSummary; lease: DesktopTaskSummary["activeLeases"][number] }> {
  const database = await getDb();
  const currentRow = database
    .prepare("SELECT * FROM local_tasks WHERE room_id = ? AND task_id = ?")
    .get(roomId, taskId);
  if (!currentRow) throw new Error("Task not found.");
  const current = mapTaskRow(currentRow);
  const actorKey = input.agentKey?.trim() || null;
  const actorSessionId = input.agentSessionId?.trim() || null;
  const holderLabel = input.holderLabel?.trim() || actorKey || "Local reviewer";
  if (
    actorKey &&
    current.assignee_agent_key &&
    current.assignee_agent_key === actorKey
  ) {
    throw new Error("A worker holding the task cannot also claim review authority.");
  }
  if (
    current.review_lease_id &&
    current.review_agent_key &&
    actorKey &&
    current.review_agent_key !== actorKey
  ) {
    throw new Error("Review authority is already held by another local reviewer.");
  }
  const now = new Date().toISOString();
  const leaseId = current.review_lease_id || `local_review_${randomUUID()}`;
  database
    .prepare(`
      UPDATE local_tasks
      SET review_lease_id = ?,
          review_holder_label = ?,
          review_agent_key = ?,
          review_agent_session_id = ?,
          review_updated_at = ?,
          updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
    .run(
      leaseId,
      holderLabel,
      actorKey,
      actorSessionId,
      now,
      now,
      roomId,
      taskId,
    );
  touchLocalRoom(database, roomId, now);
  const task = await getLocalTask(roomId, taskId);
  const lease = task?.activeLeases.find((entry) => entry.id === leaseId);
  if (!task || !lease) throw new Error("Review authority could not be claimed.");
  return { task, lease };
}

export async function releaseLocalTaskReviewLease(
  roomId: string,
  taskId: string,
  input: LocalReviewLeaseInput = {},
): Promise<{
  task: DesktopTaskSummary;
  releasedLease: DesktopTaskSummary["activeLeases"][number] | null;
}> {
  const database = await getDb();
  const currentRow = database
    .prepare("SELECT * FROM local_tasks WHERE room_id = ? AND task_id = ?")
    .get(roomId, taskId);
  if (!currentRow) throw new Error("Task not found.");
  const current = mapTaskRow(currentRow);
  const releasedLease = current.review_lease_id
    ? {
        id: current.review_lease_id,
        kind: "review",
        holderLabel: current.review_holder_label,
        agentKey: current.review_agent_key,
        agentSessionId: current.review_agent_session_id,
        status: "released",
        updatedAt: current.review_updated_at,
      }
    : null;
  if (
    input.leaseId &&
    current.review_lease_id &&
    input.leaseId !== current.review_lease_id
  ) {
    throw new Error("Review lease id did not match the active local review authority.");
  }
  const now = new Date().toISOString();
  database
    .prepare(`
      UPDATE local_tasks
      SET review_lease_id = NULL,
          review_holder_label = NULL,
          review_agent_key = NULL,
          review_agent_session_id = NULL,
          review_updated_at = NULL,
          updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
    .run(now, roomId, taskId);
  touchLocalRoom(database, roomId, now);
  const task = await getLocalTask(roomId, taskId);
  if (!task) throw new Error("Task not found.");
  return { task, releasedLease };
}

export async function importLocalTasks(
  roomId: string,
  tasks: DesktopTaskSummary[],
): Promise<void> {
  if (!tasks.length) return;
  const database = await getDb();
  const now = new Date().toISOString();
  beginImmediate(database);
  try {
    for (const task of tasks) {
      database
        .prepare(`
          INSERT INTO local_tasks (
            room_id, task_id, title, description, status, assignee, assignee_agent_key,
            created_by, pr_url, workflow_artifacts_json, workflow_refs_json,
            synced_cloud_id, sync_key, sync_started_at, sync_dirty, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
          ON CONFLICT(room_id, task_id) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            status = excluded.status,
            assignee = excluded.assignee,
            assignee_agent_key = excluded.assignee_agent_key,
            pr_url = excluded.pr_url,
            workflow_artifacts_json = excluded.workflow_artifacts_json,
            workflow_refs_json = excluded.workflow_refs_json,
            synced_cloud_id = excluded.synced_cloud_id,
            updated_at = excluded.updated_at
        `)
        .run(
          roomId,
          task.id,
          task.title,
          task.description,
          task.status,
          task.assignee,
          task.assigneeAgentKey,
          task.createdBy,
          task.prUrl,
          JSON.stringify(task.workflowArtifacts || []),
          JSON.stringify(task.workflowRefs || []),
          task.id,
          `local-task:${roomId}:${task.id}`,
          task.createdAt || now,
          task.updatedAt || now,
        );
    }
    touchLocalRoom(database, roomId, now);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export async function linkLocalRoomToCloud(input: {
  roomIdentifier: string;
  cloudRoomIdentifier: string;
}): Promise<void> {
  const database = await getDb();
  const now = new Date().toISOString();
  database
    .prepare(`
      UPDATE local_rooms
      SET cloud_room_id = ?, published_at = COALESCE(published_at, ?), updated_at = ?
      WHERE room_id = ?
    `)
    .run(input.cloudRoomIdentifier, now, now, input.roomIdentifier);
}

export async function claimLocalTasksForPublish(
  roomId: string,
): Promise<DesktopTaskSummary[]> {
  const database = await getDb();
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  beginImmediate(database);
  try {
    const rows = database
      .prepare(`
        SELECT *
        FROM local_tasks
        WHERE room_id = ?
          AND (synced_cloud_id IS NULL OR sync_dirty = 1)
          AND (sync_started_at IS NULL OR sync_started_at < ?)
        ORDER BY created_at ASC
      `)
      .all(roomId, staleBefore)
      .map(mapTaskRow);
    for (const row of rows) {
      database
        .prepare(`
          UPDATE local_tasks
          SET sync_started_at = ?
          WHERE room_id = ? AND task_id = ?
        `)
        .run(now, roomId, row.task_id);
    }
    database.exec("COMMIT");
    return rows.map(toTaskSummary);
  } catch (error) {
    rollback(database);
    throw error;
  }
}

export async function markLocalTaskSynced(input: {
  roomId: string;
  taskId: string;
  cloudTaskId: string;
}): Promise<void> {
  const database = await getDb();
  database
    .prepare(`
      UPDATE local_tasks
      SET synced_cloud_id = ?, sync_dirty = 0, sync_started_at = NULL, updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
    .run(input.cloudTaskId, new Date().toISOString(), input.roomId, input.taskId);
}

export async function rememberLocalTaskCloudId(input: {
  roomId: string;
  taskId: string;
  cloudTaskId: string;
}): Promise<void> {
  const database = await getDb();
  database
    .prepare(`
      UPDATE local_tasks
      SET synced_cloud_id = COALESCE(synced_cloud_id, ?), updated_at = ?
      WHERE room_id = ? AND task_id = ?
    `)
    .run(input.cloudTaskId, new Date().toISOString(), input.roomId, input.taskId);
}

export async function releaseLocalTaskPublishClaim(input: {
  roomId: string;
  taskId: string;
}): Promise<void> {
  const database = await getDb();
  database
    .prepare(`
      UPDATE local_tasks
      SET sync_started_at = NULL
      WHERE room_id = ? AND task_id = ?
    `)
    .run(input.roomId, input.taskId);
}

export async function getLocalTaskCloudId(input: {
  roomId: string;
  taskId: string;
}): Promise<string | null> {
  const database = await getDb();
  const row = database
    .prepare(`
      SELECT synced_cloud_id
      FROM local_tasks
      WHERE room_id = ? AND task_id = ?
    `)
    .get(input.roomId, input.taskId);
  return typeof row?.synced_cloud_id === "string" && row.synced_cloud_id.trim()
    ? row.synced_cloud_id
    : null;
}

function touchLocalRoom(
  database: SqliteDatabase,
  roomId: string,
  timestamp: string,
): void {
  database
    .prepare("UPDATE local_rooms SET updated_at = ? WHERE room_id = ?")
    .run(timestamp, roomId);
}
