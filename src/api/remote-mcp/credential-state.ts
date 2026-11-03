import type { McpSessionPersistentState } from "../../mcp/server/runtime/session-scope.js";

/**
 * The state one remote MCP credential keeps for its later sessions, and how a
 * session's state is folded into it. Pure functions: no database, so the
 * route and the unit tests can import them.
 */

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function emptyState(): McpSessionPersistentState {
  return { local: {}, currentRoom: null, fullPromptDelivered: false, pinnedConnections: {} };
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Combine two saves of one session. Maps (agent sessions, workers, room
 * sessions, pinned connections, ...) are unioned key by key; where both have
 * a key, or for single values, `prefer` wins, except that an ended entry
 * stays ended. Nothing either side added is lost.
 */
export function mergeSessionStates(ours: McpSessionPersistentState, theirs: McpSessionPersistentState,
  prefer: "ours" | "theirs"): McpSessionPersistentState {
  const pick = <T>(a: T, b: T): T => (prefer === "ours" ? a : b);
  // An entry that one side ended stays ended: an ended agent session is never revived.
  const pickEntry = (a: unknown, b: unknown): unknown => {
    const endedA = isRecord(a) && Boolean(a.ended_at);
    const endedB = isRecord(b) && Boolean(b.ended_at);
    if (endedA !== endedB) return endedA ? a : b;
    return pick(a, b);
  };
  const unionMap = (a: unknown, b: unknown): unknown => {
    if (!isRecord(a) || !isRecord(b)) return pick(a, b) ?? a ?? b;
    const merged: JsonRecord = { ...a, ...b };
    for (const key of Object.keys(merged)) {
      if (key in a && key in b) merged[key] = pickEntry(a[key], b[key]);
      else merged[key] = key in a ? a[key] : b[key];
    }
    return merged;
  };
  const local: JsonRecord = {};
  for (const key of new Set([...Object.keys(ours.local), ...Object.keys(theirs.local)])) {
    const a = (ours.local as JsonRecord)[key];
    const b = (theirs.local as JsonRecord)[key];
    local[key] = a === undefined ? b : b === undefined ? a : unionMap(a, b);
  }
  return {
    local,
    currentRoom: pick(ours.currentRoom, theirs.currentRoom) ?? ours.currentRoom ?? theirs.currentRoom,
    fullPromptDelivered: ours.fullPromptDelivered || theirs.fullPromptDelivered,
    pinnedConnections: unionMap(ours.pinnedConnections, theirs.pinnedConnections) as McpSessionPersistentState["pinnedConnections"],
  };
}

/** Drop what can never be used again, so the saved state stays small. */
export function pruneState(state: McpSessionPersistentState): void {
  for (const [id, connection] of Object.entries(state.pinnedConnections)) {
    if (connection.ended_at) delete state.pinnedConnections[id];
  }
  const rooms = state.local.room_sessions;
  if (rooms) {
    const keep = Object.entries(rooms)
      .sort(([, a], [, b]) => String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")))
      .slice(0, 32);
    state.local.room_sessions = Object.fromEntries(keep);
  }
}

export function readState(value: unknown): McpSessionPersistentState {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<McpSessionPersistentState>;
  return {
    local: raw.local && typeof raw.local === "object" ? raw.local : {},
    currentRoom: raw.currentRoom ?? null,
    fullPromptDelivered: raw.fullPromptDelivered === true,
    pinnedConnections: raw.pinnedConnections && typeof raw.pinnedConnections === "object" ? raw.pinnedConnections : {},
  };
}

/** The parts of `local` a credential keeps for its later sessions. */
export const CREDENTIAL_LOCAL_KEYS = ["mcp_workers", "agent_sessions", "current_agent_session_ids", "room_sessions"] as const;
/**
 * Workers one credential keeps, with their agent sessions and pinned
 * connections; the least recently seen go first. `LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS`, default 32.
 */
export function credentialMaxWorkers(): number {
  return positiveIntEnv("LETAGENTS_REMOTE_MCP_MAX_CREDENTIAL_WORKERS", 32);
}
const CREDENTIAL_MAX_LEGACY_SESSIONS = 32;
const CREDENTIAL_MAX_ROOM_CURSORS = 32;
/** Rooms kept per worker handle; the least recently seen go first. */
const CREDENTIAL_MAX_ROOMS_PER_WORKER = 16;
/** A new session's seed is kept under this share of the session size cap, so the session has room of its own. */
export const SEED_SHARE_OF_STATE_CAP = 0.5;

function isEnded(entry: unknown): boolean {
  return isRecord(entry) && Boolean(entry.ended_at);
}

/** JSON with sorted keys, so two equal entries compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => (isRecord(inner)
    ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
    : inner));
}

/**
 * What a credential keeps of a session: its worker handles, the live agent
 * sessions and pinned connections those handles (or legacy registrations)
 * point at, and its read cursors. Never the joined room, the prompt flag or
 * an identity: a new chat joins its own room, and identities are per instance.
 * Bounded, so the credential state cannot grow with every call: the least
 * recently seen workers and legacy sessions go first.
 */
export function projectCredentialState(state: McpSessionPersistentState, maxWorkers = credentialMaxWorkers()): McpSessionPersistentState {
  const local = state.local;
  const agentSessions = local.agent_sessions ?? {};
  const pinned = state.pinnedConnections ?? {};
  const seen = (id: string | undefined): string => (id ? String(agentSessions[id]?.last_seen_at ?? agentSessions[id]?.updated_at ?? "") : "");
  const live = (id: string | undefined): id is string => Boolean(id && agentSessions[id] && !agentSessions[id]!.ended_at);

  // A worker's recency is its last recorded use, or else the newest of its sessions.
  const workers = Object.values(local.mcp_workers ?? {})
    .map((worker) => ({
      worker,
      seen: [String(worker.last_used_at ?? ""), ...Object.values(worker.rooms).map((room) => seen(room.session_id))].sort().at(-1) ?? "",
    }))
    .sort((a, b) => b.seen.localeCompare(a.seen))
    .slice(0, Math.max(0, maxWorkers))
    .map(({ worker }) => {
      const rooms = Object.entries(worker.rooms)
        .sort(([, a], [, b]) => seen(b.session_id).localeCompare(seen(a.session_id)))
        .slice(0, CREDENTIAL_MAX_ROOMS_PER_WORKER);
      return { ...worker, rooms: Object.fromEntries(rooms) };
    });
  const legacy = Object.entries(local.current_agent_session_ids ?? {})
    .filter(([, id]) => live(id))
    .sort(([, a], [, b]) => seen(b).localeCompare(seen(a)))
    .slice(0, CREDENTIAL_MAX_LEGACY_SESSIONS);
  const keep = new Set<string>();
  for (const worker of workers) for (const room of Object.values(worker.rooms)) if (live(room.session_id)) keep.add(room.session_id);
  for (const [, id] of legacy) keep.add(id);
  const cursors = Object.entries(local.room_sessions ?? {})
    .sort(([, a], [, b]) => String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")))
    .slice(0, CREDENTIAL_MAX_ROOM_CURSORS);
  return {
    local: {
      ...(workers.length ? { mcp_workers: Object.fromEntries(workers.map((worker) => [worker.worker_id, worker])) } : {}),
      ...(keep.size ? { agent_sessions: Object.fromEntries([...keep].map((id) => [id, agentSessions[id]!])) } : {}),
      ...(legacy.length ? { current_agent_session_ids: Object.fromEntries(legacy) } : {}),
      ...(cursors.length ? { room_sessions: Object.fromEntries(cursors) } : {}),
    },
    currentRoom: null,
    fullPromptDelivered: false,
    pinnedConnections: Object.fromEntries([...keep].filter((id) => pinned[id] && !pinned[id]!.ended_at).map((id) => [id, pinned[id]!])),
  };
}

/**
 * Fold a session's state into its credential's. An entry the session added
 * or changed since its baseline (what it was seeded with, or last folded) wins,
 * except that an ended entry the credential still holds stays ended. An entry
 * the session did not touch keeps the credential's view, so a stale session
 * cannot undo another session's later change (the projection keeps no
 * tombstones; the baseline is what stops a stale re-add). The result is
 * bounded like a projection.
 */
export function foldIntoCredential(credential: McpSessionPersistentState, session: McpSessionPersistentState,
  baseline: McpSessionPersistentState | null, maxWorkers = credentialMaxWorkers()): McpSessionPersistentState {
  const out: McpSessionPersistentState = structuredClone(credential);
  const foldMap = (target: JsonRecord, mine: JsonRecord | undefined, base: JsonRecord | undefined): void => {
    for (const [key, entry] of Object.entries(mine ?? {})) {
      if (base && key in base && canonical(base[key]) === canonical(entry)) continue;
      if (isEnded(target[key]) && !isEnded(entry)) continue;
      target[key] = entry;
    }
  };
  // A worker's rooms fold one room at a time, so two sessions that bind one
  // worker in different rooms both keep their binding.
  const foldWorkers = (target: JsonRecord, mine: JsonRecord | undefined, base: JsonRecord | undefined): void => {
    for (const [workerId, entry] of Object.entries(mine ?? {})) {
      const baseWorker = base?.[workerId];
      if (baseWorker !== undefined && canonical(baseWorker) === canonical(entry)) continue;
      const current = target[workerId];
      if (!isRecord(current) || !isRecord(entry)) {
        target[workerId] = entry;
        continue;
      }
      const { rooms: mineRooms, ...mineRest } = entry as JsonRecord & { rooms?: JsonRecord };
      const merged: JsonRecord = { ...current, ...mineRest, rooms: { ...(current.rooms as JsonRecord | undefined) } };
      foldMap(merged.rooms as JsonRecord, mineRooms, isRecord(baseWorker) ? baseWorker.rooms as JsonRecord | undefined : undefined);
      target[workerId] = merged;
    }
  };
  const outLocal = out.local as JsonRecord;
  for (const key of CREDENTIAL_LOCAL_KEYS) {
    outLocal[key] ??= {};
    const fold = key === "mcp_workers" ? foldWorkers : foldMap;
    fold(outLocal[key] as JsonRecord, (session.local as JsonRecord)[key] as JsonRecord | undefined,
      baseline ? (baseline.local as JsonRecord)[key] as JsonRecord | undefined : undefined);
  }
  foldMap(out.pinnedConnections as unknown as JsonRecord, session.pinnedConnections as unknown as JsonRecord,
    baseline?.pinnedConnections as unknown as JsonRecord | undefined);
  return projectCredentialState(out, maxWorkers);
}

