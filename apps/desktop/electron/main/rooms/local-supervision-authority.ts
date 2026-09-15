import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { LOCAL_ROOM_API_ORIGIN } from "../../../../../shared/room-api-origin.mjs";
import { localChatDatabasePath, readLocalProfileId } from "../chat-storage/settings.js";
import { getOrCreateDesktopHostId, saveAgentSession, markAgentSessionEnded, type StoredAgentSessionState } from "../agents/state.js";
import { beginImmediate, rollback } from "./local-db.js";
import { getLocalRoom, getLocalTaskDatabase } from "./local-store.js";
import { endLocalWorkerLeases } from "../../../../../shared/local-work-leases.mjs";

// Local authority belongs to this user's local database, never a cloud account.
// Only public identity and revocation state live in SQLite; bearers are derived
// from an owner-only key and are not stored in the shared agent-state file.
let schema: Promise<void> | undefined;
let signingKey: Promise<Buffer> | undefined;
export async function localSupervisionDatabase() {
  const db = await getLocalTaskDatabase();
  schema ??= Promise.resolve().then(() => db.exec(`
    CREATE TABLE IF NOT EXISTS local_supervisor_grants (
      entry_id TEXT NOT NULL, room_id TEXT NOT NULL, agent_key TEXT NOT NULL,
      grant_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, installation_id TEXT NOT NULL,
      display_name TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS local_supervisor_active_entry ON local_supervisor_grants(entry_id) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS local_supervisor_sessions (
      session_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES local_supervisor_grants(grant_id),
      instance_id TEXT NOT NULL, public_json TEXT NOT NULL, ended_at TEXT,
      native_sequence INTEGER NOT NULL DEFAULT 0, native_observed_at TEXT, native_status TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS local_supervisor_live_instance ON local_supervisor_sessions(grant_id,instance_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS local_supervisor_work (
      room_id TEXT NOT NULL, source_message_id TEXT NOT NULL, agent_key TEXT NOT NULL,
      attempt_id TEXT NOT NULL, revision INTEGER NOT NULL, summary_json TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(room_id, source_message_id, agent_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS local_supervisor_work_review_pages (
      attempt_id TEXT NOT NULL, page_index INTEGER NOT NULL, page_json TEXT NOT NULL,
      PRIMARY KEY(attempt_id, page_index)
    ) STRICT;
  `)).catch((error) => { schema = undefined; throw error; });
  await schema;
  return db;
}

async function key(): Promise<Buffer> {
  signingKey ??= (async () => {
    await localSupervisionDatabase(); // creates the parent directory
    const path = `${localChatDatabasePath}.supervisor-key`;
    try { await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await chmod(path, 0o600);
    const value = await readFile(path);
    if (value.length !== 32) throw new Error("The local supervisor authority key is invalid.");
    return value;
  })().catch((error) => { signingKey = undefined; throw error; });
  return signingKey;
}
async function token(kind: "grant" | "worker", id: string): Promise<string> {
  return `local_${kind}_${createHmac("sha256", await key()).update(`${kind}\0${id}`).digest("hex")}`;
}
async function matches(kind: "grant" | "worker", id: string, supplied: string): Promise<boolean> {
  const expected = Buffer.from(await token(kind, id));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function prepareLocalSupervisorGrant(input: { entryId: string; roomId: string; displayName: string; provider: string }) {
  if (!/^supervised_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.entryId)
    || !input.roomId.trim() || !await getLocalRoom(input.roomId)) throw new Error("Choose an available local room for this agent.");
  const db = await localSupervisionDatabase();
  const hostId = getOrCreateDesktopHostId();
  const installationId = `local:${await readLocalProfileId()}`;
  db.prepare(`INSERT INTO local_supervisor_grants(entry_id,room_id,agent_key,grant_id,host_id,installation_id,display_name,provider,created_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(input.entryId, input.roomId,
    `local/supervised/${input.entryId}`, `local_grant_${randomUUID()}`, hostId, installationId,
    input.displayName, input.provider, new Date().toISOString());
  const row = db.prepare("SELECT * FROM local_supervisor_grants WHERE entry_id=? AND revoked_at IS NULL").get(input.entryId)!;
  if (row.room_id !== input.roomId || row.provider !== input.provider || row.revoked_at
    || row.host_id !== hostId || row.installation_id !== installationId) throw new Error("Local agent authority does not match its saved room and installation.");
  // A profile rename changes presentation, never durable agent identity.
  db.prepare("UPDATE local_supervisor_grants SET display_name=? WHERE entry_id=? AND revoked_at IS NULL").run(input.displayName, input.entryId);
  if (row.display_name !== input.displayName) {
    for (const active of db.prepare("SELECT session_id,public_json FROM local_supervisor_sessions WHERE grant_id=? AND ended_at IS NULL").all(row.grant_id)) {
      const session = JSON.parse(String(active.public_json)) as StoredAgentSessionState;
      session.display_name = input.displayName;
      session.actor_label = `${input.displayName} | Your agent | ${session.ide_label}`;
      db.prepare("UPDATE local_supervisor_sessions SET public_json=? WHERE session_id=?").run(JSON.stringify(session), active.session_id);
      saveAgentSession(session);
    }
  }
  return {
    entryId: input.entryId, roomId: input.roomId, agentKey: String(row.agent_key), grantId: String(row.grant_id),
    supervisorGrant: await token("grant", String(row.grant_id)), grantGeneration: 1,
    apiUrl: LOCAL_ROOM_API_ORIGIN, hostId, installationId,
    ownerAccountId: null, scopeKey: null, expiresAt: "2100-01-01T00:00:00.000Z",
  };
}

export async function authorizeLocalHost(grantId: string, bearer: string, generation: number) {
  const db = await localSupervisionDatabase();
  const row = db.prepare("SELECT * FROM local_supervisor_grants WHERE grant_id=? AND revoked_at IS NULL").get(grantId);
  if (!row || generation !== 1 || !await matches("grant", grantId, bearer)) throw new Error("Local supervisor grant is unavailable.");
  if (!await getLocalRoom(String(row.room_id))) throw new Error("This local room is no longer available.");
  return row;
}

export async function createLocalSupervisorSession(grant: Record<string, unknown>, input: {
  room_id: string; agent_key: string; agent_instance_id: string; runtime: string; display_name: string; ide_label: string;
}) {
  if (input.room_id !== grant.room_id || input.agent_key !== grant.agent_key || input.runtime !== grant.provider
    || typeof input.agent_instance_id !== "string" || !input.agent_instance_id.trim()) throw new Error("Local worker scope does not match its grant.");
  const db = await localSupervisionDatabase();
  const now = new Date().toISOString();
  const identity = {
    session_id: `local_agent_session_${randomUUID()}`, session_token: "", room_id: input.room_id,
    session_kind: "worker" as const, runtime: input.runtime, agent_key: input.agent_key,
    agent_instance_id: input.agent_instance_id, display_name: String(grant.display_name), owner_label: "You",
    ide_label: input.ide_label, actor_label: `${grant.display_name} | Your agent | ${input.ide_label}`,
    host_id: String(grant.host_id), host_kind: "desktop", host_label: "This Mac",
    liveness_capability: "native", created_at: now, updated_at: now, last_seen_at: now, ended_at: null,
  };
  beginImmediate(db);
  let session: typeof identity;
  try {
    if (!db.prepare("SELECT 1 FROM local_supervisor_grants WHERE grant_id=? AND revoked_at IS NULL").get(grant.grant_id)) {
      throw new Error("Local supervisor grant ended before worker registration.");
    }
    db.prepare(`INSERT INTO local_supervisor_sessions(session_id,grant_id,instance_id,public_json)
      VALUES(?,?,?,?) ON CONFLICT DO NOTHING`).run(identity.session_id, grant.grant_id, input.agent_instance_id, JSON.stringify(identity));
    const row = db.prepare("SELECT * FROM local_supervisor_sessions WHERE grant_id=? AND instance_id=? AND ended_at IS NULL").get(grant.grant_id, input.agent_instance_id)!;
    if (row.ended_at) throw new Error("This exact local worker instance has ended.");
    session = JSON.parse(String(row.public_json)) as typeof identity;
    db.exec("COMMIT");
  } catch (error) { rollback(db); throw error; }
  saveAgentSession(session); // public attribution remains available to the desktop and history publishing
  return { ...session, worker_bearer: await token("worker", session.session_id),
    worker_bearer_id: `local_bearer_${session.session_id}`, worker_bearer_expires_at: null };
}

export async function authorizeLocalWorker(roomId: string, bearer: string, sessionId?: string) {
  const db = await localSupervisionDatabase();
  const rows = db.prepare(`SELECT s.* FROM local_supervisor_sessions s JOIN local_supervisor_grants g USING(grant_id)
    WHERE g.room_id=? AND g.revoked_at IS NULL AND s.ended_at IS NULL`).all(roomId);
  for (const row of rows) {
    if (sessionId && row.session_id !== sessionId) continue;
    if (await matches("worker", String(row.session_id), bearer)) {
      if (!await getLocalRoom(roomId)) throw new Error("This local room is no longer available.");
      return JSON.parse(String(row.public_json)) as StoredAgentSessionState & {
        agent_key: string; agent_instance_id: string; display_name: string; actor_label: string;
      };
    }
  }
  throw new Error("Local worker authority is unavailable for this room.");
}

export async function endLocalSupervisorSession(grantId: string, sessionId: string) {
  const db = await localSupervisionDatabase();
  const now = new Date().toISOString();
  beginImmediate(db);
  try {
    const row = db.prepare("SELECT session_id FROM local_supervisor_sessions WHERE grant_id=? AND session_id=?").get(grantId, sessionId);
    if (!row) throw new Error("Local worker session does not belong to this grant.");
    db.prepare("UPDATE local_supervisor_sessions SET ended_at=COALESCE(ended_at,?) WHERE session_id=?").run(now, sessionId);
    endLocalWorkerLeases(db, sessionId, now);
    db.exec("COMMIT");
  } catch (error) { rollback(db); throw error; }
  markAgentSessionEnded(sessionId, now);
}

export async function revokeLocalSupervisorEntry(entryId: string, sessionId?: string | null): Promise<void> {
  const db = await localSupervisionDatabase();
  const now = new Date().toISOString();
  let sessions: Record<string, unknown>[];
  beginImmediate(db);
  try {
    const grants = db.prepare("SELECT * FROM local_supervisor_grants WHERE entry_id=?").all(entryId);
    if (!grants.length) throw new Error("Local supervisor grant was not found.");
    sessions = grants.flatMap((grant) => db.prepare("SELECT session_id,grant_id FROM local_supervisor_sessions WHERE grant_id=?").all(grant.grant_id));
    if (sessionId && !sessions.some((row) => row.session_id === sessionId)) throw new Error("Local revocation does not match this worker session.");
    db.prepare("UPDATE local_supervisor_grants SET revoked_at=COALESCE(revoked_at,?) WHERE entry_id=?").run(now, entryId);
    for (const session of sessions) {
      db.prepare("UPDATE local_supervisor_sessions SET ended_at=COALESCE(ended_at,?) WHERE session_id=?").run(now, session.session_id);
      endLocalWorkerLeases(db, String(session.session_id), now);
    }
    db.exec("COMMIT");
  } catch (error) { rollback(db); throw error; }
  for (const session of sessions) markAgentSessionEnded(String(session.session_id), now);
}


/** Local presence comes from daemon observations, never cloud login or a desktop timer. */
export async function readLocalSupervisorPresence(roomId: string): Promise<Pick<import("../../ipc-types.js").DesktopRoomSnapshot, "participants" | "presence">> {
  const db = await localSupervisionDatabase();
  const rows = db.prepare(`SELECT s.*,g.agent_key,g.revoked_at FROM local_supervisor_sessions s
    JOIN local_supervisor_grants g USING(grant_id) WHERE g.room_id=?
    ORDER BY json_extract(s.public_json,'$.created_at') DESC,s.session_id DESC`).all(roomId);
  const result: Pick<import("../../ipc-types.js").DesktopRoomSnapshot, "participants" | "presence"> = { participants: [], presence: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    const identity = JSON.parse(String(row.public_json)) as StoredAgentSessionState;
    const agentKey = String(row.agent_key);
    if (seen.has(agentKey)) continue;
    seen.add(agentKey);
    const lastSeen = String(row.native_observed_at || identity.last_seen_at || identity.created_at);
    const activityState = row.ended_at || row.revoked_at ? "offline" : Date.now() - Date.parse(lastSeen) < 45_000 ? "active" : "away";
    result.participants.push({ participantKey: `agent:${agentKey}`, kind: "agent", agentKey,
      displayName: identity.display_name || "Agent", actorLabel: identity.actor_label || "Agent", ownerLabel: "You", ideLabel: identity.ide_label || null,
      githubLogin: null, hiddenAt: null, activityState, lastSeenAt: lastSeen,
      lastRoomActivityAt: null, lastLiveHeartbeatAt: row.native_observed_at ? lastSeen : null, sourceFlags: ["presence"] });
    if (row.ended_at || row.revoked_at) continue;
    result.presence.push({ roomId, agentKey, agentInstanceId: identity.agent_instance_id || null,
      agentSessionId: identity.session_id, sessionKind: "worker", runtime: identity.runtime || "unknown",
      displayName: identity.display_name || "Agent", actorLabel: identity.actor_label || "Agent", ownerLabel: "You", ideLabel: identity.ide_label || null,
      repoBranch: null, status: row.native_status === "working" ? "working" : "idle", statusText: null,
      lastHeartbeatAt: lastSeen, freshness: activityState === "active" ? "active" : "stale", activityState,
      sourceFlags: ["presence"], livenessObservation: null });
  }
  return result;
}
