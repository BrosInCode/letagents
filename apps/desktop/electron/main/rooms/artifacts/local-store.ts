import type {
  DesktopRoomSharedArtifactChangedFile,
  DesktopRoomSharedArtifactDetail,
  DesktopRoomSharedArtifactKind,
  DesktopRoomSharedArtifactProvider,
  DesktopRoomSharedArtifactSource,
} from "../../../ipc-types.js";
import type { RoomArtifactsResponse } from "../snapshot/payloads.js";
import {
  addColumnIfMissing,
  beginImmediate,
  getLocalChatDatabase,
  rollback,
  type SqliteDatabase,
} from "../local-db.js";

type LocalRoomArtifactInput = {
  provider: DesktopRoomSharedArtifactProvider;
  kind: DesktopRoomSharedArtifactKind;
  id?: string | null;
  number?: number | null;
  title?: string | null;
  url?: string | null;
  ref?: string | null;
  state?: string | null;
  detail?: DesktopRoomSharedArtifactDetail | null;
};

type NormalizeLocalArtifactOptions = {
  requireStableIdentity?: boolean;
};

type LocalRoomArtifactRow = {
  room_id: string;
  identity_key: string;
  provider: DesktopRoomSharedArtifactProvider;
  kind: DesktopRoomSharedArtifactKind;
  artifact_id: string | null;
  artifact_number: number | null;
  title: string | null;
  url: string | null;
  ref: string | null;
  state: string | null;
  detail: DesktopRoomSharedArtifactDetail | null;
  source: DesktopRoomSharedArtifactSource;
  first_seen_at: string;
  updated_at: string;
};

const localArtifactProviders = new Set<DesktopRoomSharedArtifactProvider>([
  "git",
  "github",
  "gitlab",
  "bitbucket",
  "unknown",
]);

const localArtifactKinds = new Set<DesktopRoomSharedArtifactKind>([
  "issue",
  "branch",
  "commit",
  "diff",
  "change_summary",
  "pull_request",
  "merge_request",
  "review",
  "check_run",
  "merge",
]);
let schemaInitialized = false;

async function getDb(): Promise<SqliteDatabase> {
  const database = await getLocalChatDatabase();
  if (!schemaInitialized) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS local_room_artifacts (
        room_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        artifact_id TEXT,
        artifact_number INTEGER,
        title TEXT,
        url TEXT,
        ref TEXT,
        state TEXT,
        detail TEXT,
        source TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, identity_key)
      );
      CREATE INDEX IF NOT EXISTS local_room_artifacts_room_kind_idx
        ON local_room_artifacts (room_id, kind, updated_at);
      CREATE INDEX IF NOT EXISTS local_room_artifacts_room_updated_idx
        ON local_room_artifacts (room_id, updated_at);
      CREATE TABLE IF NOT EXISTS local_room_artifact_tasks (
        room_id TEXT NOT NULL,
        artifact_identity_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        source TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, artifact_identity_key, task_id)
      );
      CREATE INDEX IF NOT EXISTS local_room_artifact_tasks_task_idx
        ON local_room_artifact_tasks (room_id, task_id);
    `);
    // Additive migration for local DBs created before the detail column existed.
    addColumnIfMissing(database, "local_room_artifacts", "detail", "TEXT");
    schemaInitialized = true;
  }
  return database;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("artifact.number must be an integer.");
  }
  return value;
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), max));
}

const MAX_LOCAL_CHANGE_SUMMARY_FILES = 200;
const MAX_LOCAL_ARTIFACT_PATH_LENGTH = 1024;
const localChangeSummaryStatuses = new Set([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "typechange",
  "untracked",
  "unknown",
]);

function nonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeLocalChangeSummaryFile(value: unknown): DesktopRoomSharedArtifactChangedFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact.detail.files entries must be objects.");
  }
  const record = value as Record<string, unknown>;
  const path = record.path;
  if (typeof path !== "string" || !path.trim() || path.length > MAX_LOCAL_ARTIFACT_PATH_LENGTH) {
    throw new Error("artifact.detail.files entry has an invalid path.");
  }
  return {
    path,
    previousPath:
      typeof record.previousPath === "string" && record.previousPath.length <= MAX_LOCAL_ARTIFACT_PATH_LENGTH
        ? record.previousPath
        : null,
    status:
      typeof record.status === "string" && localChangeSummaryStatuses.has(record.status)
        ? record.status
        : "unknown",
    additions: nonNegativeCount(record.additions),
    deletions: nonNegativeCount(record.deletions),
    binary: record.binary === true,
    staged: record.staged === true,
    unstaged: record.unstaged === true,
    untracked: record.untracked === true,
  };
}

// Validate + clamp structured detail; only change_summary is supported today.
// Never carries source code.
function normalizeLocalArtifactDetail(
  value: unknown,
): DesktopRoomSharedArtifactDetail | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact.detail must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "change_summary") {
    throw new Error("artifact.detail.type is unsupported.");
  }
  if (record.version !== 1) {
    throw new Error("artifact.detail.version is unsupported.");
  }
  const filesInput = Array.isArray(record.files) ? record.files : [];
  const files = filesInput
    .slice(0, MAX_LOCAL_CHANGE_SUMMARY_FILES)
    .map(normalizeLocalChangeSummaryFile);
  const droppedByCap = Math.max(0, filesInput.length - files.length);
  const changedFileCount = nonNegativeCount(record.changedFileCount);
  const hiddenFileCount = nonNegativeCount(record.hiddenFileCount) + droppedByCap;
  if (changedFileCount !== files.length + hiddenFileCount) {
    throw new Error(
      "artifact.detail is inconsistent: changedFileCount must equal files.length + hiddenFileCount.",
    );
  }
  return {
    type: "change_summary",
    version: 1,
    changedFileCount,
    additions: nonNegativeCount(record.additions),
    deletions: nonNegativeCount(record.deletions),
    stagedFileCount: nonNegativeCount(record.stagedFileCount),
    unstagedFileCount: nonNegativeCount(record.unstagedFileCount),
    untrackedFileCount: nonNegativeCount(record.untrackedFileCount),
    hiddenFileCount,
    files,
  };
}

function parseStoredArtifactDetail(value: unknown): DesktopRoomSharedArtifactDetail | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeLocalArtifactDetail(JSON.parse(value)) ?? null;
  } catch {
    return null;
  }
}

export function validateLocalRoomArtifactInputs(
  artifacts: Record<string, unknown>[],
  options: NormalizeLocalArtifactOptions = {},
): void {
  for (const artifact of artifacts) {
    normalizeLocalArtifact(artifact, options);
  }
}

function normalizeLocalArtifact(
  input: Record<string, unknown>,
  options: NormalizeLocalArtifactOptions = {},
): LocalRoomArtifactInput {
  const provider = stringValue(input.provider);
  const kind = stringValue(input.kind);
  if (!provider || !localArtifactProviders.has(provider as DesktopRoomSharedArtifactProvider)) {
    throw new Error("artifact.provider is invalid.");
  }
  if (!kind || !localArtifactKinds.has(kind as DesktopRoomSharedArtifactKind)) {
    throw new Error("artifact.kind is invalid.");
  }
  const detail =
    input.detail !== undefined ? normalizeLocalArtifactDetail(input.detail) : undefined;
  if (detail?.type === "change_summary" && kind !== "change_summary") {
    throw new Error('artifact.detail of type "change_summary" requires kind "change_summary".');
  }
  if (detail && stringValue(input.state) === "clean") {
    throw new Error('artifact.detail cannot be present while state is "clean".');
  }
  const artifact: LocalRoomArtifactInput = {
    provider: provider as DesktopRoomSharedArtifactProvider,
    kind: kind as DesktopRoomSharedArtifactKind,
    ...(input.id !== undefined ? { id: stringValue(input.id) } : {}),
    ...(input.number !== undefined ? { number: optionalInteger(input.number) } : {}),
    ...(input.title !== undefined ? { title: stringValue(input.title) } : {}),
    ...(input.url !== undefined ? { url: stringValue(input.url) } : {}),
    ...(input.ref !== undefined ? { ref: stringValue(input.ref) } : {}),
    ...(input.state !== undefined ? { state: stringValue(input.state) } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
  const hasStableIdentity = Boolean(
    artifact.url ||
      artifact.id ||
      (artifact.number !== undefined && artifact.number !== null) ||
      artifact.ref,
  );
  if (options.requireStableIdentity !== false && !hasStableIdentity) {
    throw new Error("artifact requires at least one stable identity: url, id, number, or ref.");
  }
  return artifact;
}

export function buildLocalRoomArtifactIdentityKey(
  artifact: Pick<LocalRoomArtifactInput, "provider" | "kind" | "url" | "id" | "number" | "ref" | "title">,
): string {
  if (artifact.url) return `${artifact.provider}:${artifact.kind}:url:${artifact.url}`;
  if (artifact.id) return `${artifact.provider}:${artifact.kind}:id:${artifact.id}`;
  if (artifact.number !== undefined && artifact.number !== null) {
    return `${artifact.provider}:${artifact.kind}:number:${artifact.number}`;
  }
  if (artifact.ref) return `${artifact.provider}:${artifact.kind}:ref:${artifact.ref}`;
  if (artifact.title) return `${artifact.provider}:${artifact.kind}:title:${artifact.title}`;
  return `${artifact.provider}:${artifact.kind}:generic`;
}

function normalizeTaskIds(input: {
  taskId?: string | null;
  linkedTaskIds?: unknown[];
}): string[] {
  const taskIds = new Set<string>();
  const add = (value: unknown, field: string) => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string") throw new Error(`${field} must be a string.`);
    const trimmed = value.trim();
    if (trimmed) taskIds.add(trimmed);
  };
  add(input.taskId, "task_id");
  if ((input.linkedTaskIds?.length || 0) > 32) {
    throw new Error("linked_task_ids cannot contain more than 32 entries.");
  }
  for (const taskId of input.linkedTaskIds || []) {
    add(taskId, "linked_task_ids");
  }
  return [...taskIds];
}

function mapArtifactRow(row: Record<string, unknown>): LocalRoomArtifactRow {
  const provider = stringValue(row.provider) || "unknown";
  const kind = stringValue(row.kind) || "branch";
  const source = stringValue(row.source);
  return {
    room_id: String(row.room_id || ""),
    identity_key: String(row.identity_key || ""),
    provider: localArtifactProviders.has(provider as DesktopRoomSharedArtifactProvider)
      ? provider as DesktopRoomSharedArtifactProvider
      : "unknown",
    kind: localArtifactKinds.has(kind as DesktopRoomSharedArtifactKind)
      ? kind as DesktopRoomSharedArtifactKind
      : "branch",
    artifact_id: stringValue(row.artifact_id),
    artifact_number: typeof row.artifact_number === "number" ? row.artifact_number : null,
    title: stringValue(row.title),
    url: stringValue(row.url),
    ref: stringValue(row.ref),
    state: stringValue(row.state),
    detail: parseStoredArtifactDetail(row.detail),
    source: source === "github_event" || source === "task_workflow_artifact"
      ? source
      : "manual",
    first_seen_at: String(row.first_seen_at || ""),
    updated_at: String(row.updated_at || row.first_seen_at || ""),
  };
}

function toPayload(
  artifact: LocalRoomArtifactRow,
  linkedTaskIds: string[] = [],
): NonNullable<RoomArtifactsResponse["artifacts"]>[number] {
  return {
    room_id: artifact.room_id,
    identity_key: artifact.identity_key,
    provider: artifact.provider,
    kind: artifact.kind,
    artifact_id: artifact.artifact_id,
    artifact_number: artifact.artifact_number,
    title: artifact.title,
    url: artifact.url,
    ref: artifact.ref,
    state: artifact.state,
    detail: artifact.detail,
    source: artifact.source,
    first_seen_at: artifact.first_seen_at,
    updated_at: artifact.updated_at,
    linked_task_ids: linkedTaskIds,
  };
}

export async function publishLocalRoomArtifact(input: {
  roomId: string;
  artifact: Record<string, unknown>;
  taskId?: string | null;
  linkedTaskIds?: unknown[];
}): Promise<{ room_id: string; artifact: NonNullable<RoomArtifactsResponse["artifacts"]>[number] }> {
  return upsertLocalRoomArtifact({
    ...input,
    source: "manual",
    requireStableIdentity: true,
  });
}

export async function publishLocalRoomWorkflowArtifact(input: {
  roomId: string;
  artifact: Record<string, unknown>;
  taskId?: string | null;
  linkedTaskIds?: unknown[];
  replaceLinkedTaskIds?: boolean;
}): Promise<{ room_id: string; artifact: NonNullable<RoomArtifactsResponse["artifacts"]>[number] }> {
  return upsertLocalRoomArtifact({
    ...input,
    source: "task_workflow_artifact",
    requireStableIdentity: true,
  });
}

async function upsertLocalRoomArtifact(input: {
  roomId: string;
  artifact: Record<string, unknown>;
  taskId?: string | null;
  linkedTaskIds?: unknown[];
  replaceLinkedTaskIds?: boolean;
  source: DesktopRoomSharedArtifactSource;
  requireStableIdentity: boolean;
}): Promise<{ room_id: string; artifact: NonNullable<RoomArtifactsResponse["artifacts"]>[number] }> {
  const roomId = input.roomId.trim();
  if (!roomId) throw new Error("Choose a room before publishing an artifact.");
  const artifact = normalizeLocalArtifact(input.artifact, {
    requireStableIdentity: input.requireStableIdentity,
  });
  const identityKey = buildLocalRoomArtifactIdentityKey(artifact);
  const linkedTaskIds = normalizeTaskIds({
    taskId: input.taskId,
    linkedTaskIds: input.linkedTaskIds,
  });
  // Detail write action (null vs undefined distinguished in JS before building SQL):
  //  - clear   : state === "clean" or explicit null -> write NULL
  //  - set     : a provided value                    -> write it
  //  - preserve : omitted                            -> leave the column untouched
  // Preserve omits the `detail` assignment from the UPDATE set so the existing
  // file list is kept without a read-copy-write.
  const detailAction: "set" | "clear" | "preserve" =
    artifact.state === "clean" || artifact.detail === null
      ? "clear"
      : artifact.detail !== undefined
        ? "set"
        : "preserve";
  const detailJson = detailAction === "set" ? JSON.stringify(artifact.detail) : null;
  const detailUpdateClause =
    detailAction === "preserve" ? "" : "detail = excluded.detail,\n          ";
  const database = await getDb();
  const now = new Date().toISOString();
  beginImmediate(database);
  try {
    database
      .prepare(`
        INSERT INTO local_room_artifacts (
          room_id, identity_key, provider, kind, artifact_id, artifact_number,
          title, url, ref, state, detail, source, first_seen_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_id, identity_key) DO UPDATE SET
          provider = excluded.provider,
          kind = excluded.kind,
          artifact_id = CASE
            WHEN local_room_artifacts.source = 'manual' AND excluded.source != 'manual'
              THEN COALESCE(local_room_artifacts.artifact_id, excluded.artifact_id)
            ELSE COALESCE(excluded.artifact_id, local_room_artifacts.artifact_id)
          END,
          artifact_number = CASE
            WHEN local_room_artifacts.source = 'manual' AND excluded.source != 'manual'
              THEN COALESCE(local_room_artifacts.artifact_number, excluded.artifact_number)
            ELSE COALESCE(excluded.artifact_number, local_room_artifacts.artifact_number)
          END,
          title = CASE
            WHEN local_room_artifacts.source = 'manual' AND excluded.source != 'manual'
              THEN COALESCE(local_room_artifacts.title, excluded.title)
            ELSE COALESCE(excluded.title, local_room_artifacts.title)
          END,
          url = CASE
            WHEN local_room_artifacts.source = 'manual' AND excluded.source != 'manual'
              THEN COALESCE(local_room_artifacts.url, excluded.url)
            ELSE COALESCE(excluded.url, local_room_artifacts.url)
          END,
          ref = CASE
            WHEN local_room_artifacts.source = 'manual' AND excluded.source != 'manual'
              THEN COALESCE(local_room_artifacts.ref, excluded.ref)
            ELSE COALESCE(excluded.ref, local_room_artifacts.ref)
          END,
          state = CASE
            WHEN local_room_artifacts.source = 'manual' AND excluded.source != 'manual'
              THEN COALESCE(local_room_artifacts.state, excluded.state)
            ELSE COALESCE(excluded.state, local_room_artifacts.state)
          END,
          ${detailUpdateClause}source = CASE
            WHEN excluded.source = 'manual' OR local_room_artifacts.source = 'manual'
              THEN local_room_artifacts.source
            ELSE excluded.source
          END,
          updated_at = excluded.updated_at
      `)
      .run(
        roomId,
        identityKey,
        artifact.provider,
        artifact.kind,
        artifact.id ?? null,
        artifact.number ?? null,
        artifact.title ?? null,
        artifact.url ?? null,
        artifact.ref ?? null,
        artifact.state ?? null,
        detailJson,
        input.source,
        now,
        now,
      );

    for (const taskId of linkedTaskIds) {
      database
        .prepare(`
          INSERT INTO local_room_artifact_tasks (
            room_id, artifact_identity_key, task_id, source, linked_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(room_id, artifact_identity_key, task_id) DO UPDATE SET
            source = excluded.source,
            updated_at = excluded.updated_at
        `)
        .run(roomId, identityKey, taskId, input.source, now, now);
    }
    if (input.replaceLinkedTaskIds) {
      const deleteBase = `
        DELETE FROM local_room_artifact_tasks
        WHERE room_id = ?
          AND artifact_identity_key = ?
          AND source = ?
      `;
      if (linkedTaskIds.length) {
        const placeholders = linkedTaskIds.map(() => "?").join(", ");
        database
          .prepare(`${deleteBase} AND task_id NOT IN (${placeholders})`)
          .run(roomId, identityKey, input.source, ...linkedTaskIds);
      } else {
        database.prepare(deleteBase).run(roomId, identityKey, input.source);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }

  const published = await getLocalRoomArtifactByIdentityKey(roomId, identityKey);
  if (!published) throw new Error("Local room artifact could not be published.");
  await emitLocalRoomArtifactUpdate(roomId, published);
  return { room_id: roomId, artifact: published };
}

async function emitLocalRoomArtifactUpdate(
  localRoomIdentifier: string,
  artifact: NonNullable<RoomArtifactsResponse["artifacts"]>[number],
): Promise<void> {
  const { emitPersistedLocalRoomArtifactUpdate } = await import("../../room-stream.js");
  emitPersistedLocalRoomArtifactUpdate(localRoomIdentifier, artifact);
}

export async function syncLocalRoomArtifactsForTask(input: {
  roomId: string;
  taskId: string;
  artifacts: Record<string, unknown>[];
}): Promise<NonNullable<RoomArtifactsResponse["artifacts"]>> {
  const roomId = input.roomId.trim();
  const taskId = input.taskId.trim();
  if (!roomId || !taskId) return [];
  const source: DesktopRoomSharedArtifactSource = "task_workflow_artifact";
  const synced: NonNullable<RoomArtifactsResponse["artifacts"]> = [];
  const identityKeys: string[] = [];
  const database = await getDb();
  const previousIdentityKeys = getLocalTaskArtifactIdentityKeys(database, {
    roomId,
    taskId,
    source,
  });

  for (const artifact of input.artifacts) {
    const result = await upsertLocalRoomArtifact({
      roomId,
      artifact,
      taskId,
      source,
      requireStableIdentity: false,
    });
    synced.push(result.artifact);
    const identityKey = result.artifact.identity_key;
    if (!identityKey) throw new Error("Local room artifact could not be linked to the task.");
    identityKeys.push(identityKey);
  }

  const deleteBase = `
    DELETE FROM local_room_artifact_tasks
    WHERE room_id = ?
      AND task_id = ?
      AND source = ?
  `;
  if (identityKeys.length) {
    const placeholders = identityKeys.map(() => "?").join(", ");
    database
      .prepare(`${deleteBase} AND artifact_identity_key NOT IN (${placeholders})`)
      .run(roomId, taskId, source, ...identityKeys);
  } else {
    database.prepare(deleteBase).run(roomId, taskId, source);
  }

  await emitLocalRoomArtifactUpdatesForIdentityKeys(
    roomId,
    previousIdentityKeys.filter((identityKey) => !identityKeys.includes(identityKey)),
  );

  return synced;
}

function getLocalTaskArtifactIdentityKeys(
  database: SqliteDatabase,
  input: { roomId: string; taskId: string; source: DesktopRoomSharedArtifactSource },
): string[] {
  return database
    .prepare(`
      SELECT artifact_identity_key
      FROM local_room_artifact_tasks
      WHERE room_id = ?
        AND task_id = ?
        AND source = ?
      ORDER BY artifact_identity_key ASC
    `)
    .all(input.roomId, input.taskId, input.source)
    .map((row) => stringValue(row.artifact_identity_key))
    .filter((identityKey): identityKey is string => Boolean(identityKey));
}

async function emitLocalRoomArtifactUpdatesForIdentityKeys(
  roomId: string,
  identityKeys: string[],
): Promise<void> {
  for (const identityKey of identityKeys) {
    const artifact = await getLocalRoomArtifactByIdentityKey(roomId, identityKey);
    if (artifact) {
      await emitLocalRoomArtifactUpdate(roomId, artifact);
    }
  }
}

export async function getLocalRoomArtifacts(
  roomId: string,
  options: { taskId?: string | null; limit?: number } = {},
): Promise<RoomArtifactsResponse & { room_id: string }> {
  const trimmedRoomId = roomId.trim();
  const limit = boundedLimit(options.limit, 100, 250);
  if (!trimmedRoomId) return { room_id: trimmedRoomId, artifacts: [] };
  const database = await getDb();
  const taskId = options.taskId?.trim() || null;
  const artifactRows = taskId
    ? database
      .prepare(`
        SELECT a.*
        FROM local_room_artifacts a
        INNER JOIN local_room_artifact_tasks t
          ON a.room_id = t.room_id
          AND a.identity_key = t.artifact_identity_key
          AND t.task_id = ?
        WHERE a.room_id = ?
        ORDER BY a.updated_at DESC, a.identity_key ASC
        LIMIT ?
      `)
      .all(taskId, trimmedRoomId, limit)
      .map(mapArtifactRow)
    : database
      .prepare(`
        SELECT *
        FROM local_room_artifacts
        WHERE room_id = ?
        ORDER BY updated_at DESC, identity_key ASC
        LIMIT ?
      `)
      .all(trimmedRoomId, limit)
      .map(mapArtifactRow);

  const linkedTaskIdsByArtifact = await getLinkedTaskIdsByArtifact(
    database,
    trimmedRoomId,
    artifactRows.map((artifact) => artifact.identity_key),
  );
  return {
    room_id: trimmedRoomId,
    artifacts: artifactRows.map((artifact) =>
      toPayload(artifact, linkedTaskIdsByArtifact.get(artifact.identity_key) || [])
    ),
  };
}

async function getLocalRoomArtifactByIdentityKey(
  roomId: string,
  identityKey: string,
): Promise<NonNullable<RoomArtifactsResponse["artifacts"]>[number] | null> {
  const database = await getDb();
  const row = database
    .prepare("SELECT * FROM local_room_artifacts WHERE room_id = ? AND identity_key = ?")
    .get(roomId, identityKey);
  if (!row) return null;
  const linkedTaskIdsByArtifact = await getLinkedTaskIdsByArtifact(database, roomId, [identityKey]);
  const artifact = mapArtifactRow(row);
  return toPayload(artifact, linkedTaskIdsByArtifact.get(identityKey) || []);
}

async function getLinkedTaskIdsByArtifact(
  database: SqliteDatabase,
  roomId: string,
  identityKeys: string[],
): Promise<Map<string, string[]>> {
  const taskIdsByArtifact = new Map<string, string[]>();
  if (!identityKeys.length) return taskIdsByArtifact;
  const placeholders = identityKeys.map(() => "?").join(", ");
  const rows = database
    .prepare(`
      SELECT artifact_identity_key, task_id
      FROM local_room_artifact_tasks
      WHERE room_id = ? AND artifact_identity_key IN (${placeholders})
      ORDER BY task_id ASC
    `)
    .all(roomId, ...identityKeys);
  for (const row of rows) {
    const identityKey = String(row.artifact_identity_key || "");
    const taskId = stringValue(row.task_id);
    if (!identityKey || !taskId) continue;
    const taskIds = taskIdsByArtifact.get(identityKey) || [];
    taskIds.push(taskId);
    taskIdsByArtifact.set(identityKey, taskIds);
  }
  return taskIdsByArtifact;
}
