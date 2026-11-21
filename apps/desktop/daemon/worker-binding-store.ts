import { RoomLatencyTrace } from "./room-latency-trace.js";
import { roomApiOrigin, isLocalRoomApi } from "../../../shared/room-api-origin.mjs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { cursorLaneRetirementSchema, type CursorLaneRetirement } from "./runtime-recovery-journal.js";
import { PreparedReadStatements } from "./prepared-reads.js";
import type { DaemonCommitNotification } from "./daemon-authority.js";

import { DaemonStateSchema, openDaemonStateDatabase } from "./daemon-state-database.js";
import {
  entriesOverPublicationRetention,
  prunePublicationsForEntry,
  RETAINED_WORKER_BINDING_PUBLICATIONS_PER_ENTRY,
  WORKER_BINDING_PUBLICATIONS_PRUNE_INTERVAL,
} from "./worker-binding-retention.js";

export interface WorkerSessionBinding {
  entry_id: string;
  room_id: string;
  work_attempt_id: string;
  execution_generation_id: string;
  agent_session_id: string;
  /** Opaque durable handle only. The credential itself is process memory. */
  credential_ref: string;
  api_url: string;
  room_cursor: string | null;
  last_sequence: number;
  last_observed_at_ms: number;
  updated_at: string;
}

export type WorkerSessionBindingInput = Omit<WorkerSessionBinding, "credential_ref" | "room_cursor" | "last_sequence" | "last_observed_at_ms" | "updated_at"> & {
  agent_session_token: string;
  /** Server-issued opaque bearer id.  It is safe to persist, unlike the bearer. */
  credential_ref?: string;
};
export type SupervisedWorkerSession = {
  agent_id: string;
  room_id: string;
  agent_session_id: string;
  execution_generation_id: string;
  credential_ref: string;
  expires_at: string | null;
  updated_at: string;
};
export type SupervisedWorkerMintState = {
  agent_id: string;
  room_id: string;
  agent_instance_id: string;
  phase: "never_minted" | "minting_unknown" | "exact";
  agent_session_id: string | null;
  updated_at: string;
};
/** An exact launch authority receipt, retained after mutable bindings rotate. */
export type WorkerExecutionBinding = {
  entry_id: string; room_id: string; api_url: string; grant_id: string;
  work_attempt_id: string; execution_generation_id: string; agent_session_id: string; agent_key: string;
};
export type WorkerExecutionPredecessor = {
  execution_generation_id: string; agent_session_id: string;
  authority: WorkerExecutionBinding | null;
  legacy_recovery_complete?: boolean;
  cursor_lane_retirement?: CursorLaneRetirement;
};
type Row = Record<string, unknown>;
type Reservation = { reservationId: string; binding: WorkerSessionBinding; bindingEpoch: number; sequence: number; observedAt: string; observedAtMs: number };
function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }

/**
 * Daemon-private worker binding state stored in the process's single shared
 * SQLite database. Network work is performed after a tiny reservation
 * transaction.
 */
export class WorkerBindingStore {
  private database: DatabaseSync | null = null;
  private ownsDatabase = false;
  private initializing: Promise<DatabaseSync> | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private closed = false;
  private writeFence: (() => void) | null = null;
  private readonly reads = new PreparedReadStatements({
    list: "SELECT * FROM worker_session_bindings ORDER BY entry_id",
    binding: "SELECT * FROM worker_session_bindings WHERE entry_id=?",
    epoch: "SELECT binding_epoch FROM worker_session_bindings WHERE entry_id=?",
    // Run on every publication (each heartbeat). Statements finish synchronously.
    watermark: "SELECT binding_epoch, last_sequence, last_observed_at_ms FROM worker_binding_watermarks WHERE entry_id=?",
    advanceBinding: "UPDATE worker_session_bindings SET last_sequence=?, last_observed_at_ms=?, updated_at=? WHERE entry_id=? AND binding_epoch=?",
    upsertWatermark: `INSERT INTO worker_binding_watermarks (entry_id, binding_epoch, last_sequence, last_observed_at_ms, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET binding_epoch=MAX(worker_binding_watermarks.binding_epoch, excluded.binding_epoch),
        last_sequence=MAX(worker_binding_watermarks.last_sequence, excluded.last_sequence),
        last_observed_at_ms=MAX(worker_binding_watermarks.last_observed_at_ms, excluded.last_observed_at_ms),
        updated_at=CASE WHEN excluded.last_observed_at_ms >= worker_binding_watermarks.last_observed_at_ms THEN excluded.updated_at ELSE worker_binding_watermarks.updated_at END`,
    reservePublication: "INSERT INTO worker_binding_publications (reservation_id, entry_id, binding_epoch, execution_generation_id, agent_session_id, sequence, observed_at, observed_at_ms, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)",
    finalizePublication: "UPDATE worker_binding_publications SET state=?, finalized_at=? WHERE reservation_id=? AND state='reserved'",
  });
  /** Publications finalized for an entry since its journal was last compacted. */
  private readonly publicationsSinceCompaction = new Map<string, number>();
  /** Deliberately instance-local: reopening a daemon cannot recover a secret. */
  private readonly credentials = new Map<string, {
    entry_id: string;
    agent_session_id: string;
    execution_generation_id: string;
    binding_epoch: number;
    token: string;
  }>();

  constructor(
    readonly legacyJsonPath: string,
    private readonly commitFence?: (commit: () => Promise<void>, notification?: DaemonCommitNotification) => Promise<void>,
    private readonly databasePath = defaultDatabasePath(legacyJsonPath),
  ) {}

  /** Attach the process's single shared SQLite handle without taking ownership of closing it. */
  attachDatabase(database: DatabaseSync, writeFence?: () => void): void {
    this.reads.clear();
    this.database = database;
    this.ownsDatabase = false;
    this.initializing = null;
    this.closed = false;
    if (writeFence) this.writeFence = writeFence;
  }

  bindWriteFence(writeFence: () => void): void {
    this.writeFence = writeFence;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Let an already-reserved local DB operation finish; transport is never
    // part of this queue, so handoff does not wait on HTTP.
    await this.initializing?.catch(() => undefined);
    await this.mutations.catch(() => undefined);
    this.reads.clear();
    if (this.ownsDatabase) this.database?.close();
    this.database = null;
    this.ownsDatabase = false;
    this.initializing = null;
    this.credentials.clear();
  }

  async get(entryId: string): Promise<WorkerSessionBinding | null> {
    return this.withMutation(async (database) => this.read(database, entryId));
  }
  async list(): Promise<WorkerSessionBinding[]> {
    return this.withMutation(async (database) => (this.reads.get(database, "list").all() as Row[]).map(rowToBinding));
  }

  /** Commit the uncertainty boundary before any remote mint request is sent. */
  async beginSupervisedWorkerSessionMint(input: {
    agent_id: string;
    room_id: string;
    agent_instance_id: string;
  }): Promise<SupervisedWorkerMintState> {
    for (const field of ["agent_id", "room_id", "agent_instance_id"] as const) {
      if (!input[field].trim()) throw new Error(`Supervised worker mint ${field} is required.`);
    }
    return this.withMutation(async (database) => this.transaction(database, () => {
      const updatedAt = new Date().toISOString();
      run(database.prepare(`
        INSERT INTO supervised_worker_mint_states
          (agent_id,room_id,agent_instance_id,phase,agent_session_id,updated_at)
        VALUES (?,?,?,'minting_unknown',NULL,?)
        ON CONFLICT(agent_id) DO UPDATE SET
          room_id=excluded.room_id,agent_instance_id=excluded.agent_instance_id,
          phase='minting_unknown',agent_session_id=NULL,updated_at=excluded.updated_at
      `), input.agent_id, input.room_id, input.agent_instance_id, updatedAt);
      return this.readSupervisedWorkerMintState(database, input.agent_id)!;
    }));
  }

  /**
   * A successful idempotent POST response becomes durable before its bearer is
   * cached or any provider-generation metadata is written.
   */
  async recordExactSupervisedWorkerSessionMint(input: {
    agent_id: string;
    room_id: string;
    agent_instance_id: string;
    agent_session_id: string;
  }): Promise<SupervisedWorkerMintState> {
    for (const field of ["agent_id", "room_id", "agent_instance_id", "agent_session_id"] as const) {
      if (!input[field].trim()) throw new Error(`Supervised worker mint ${field} is required.`);
    }
    return this.withMutation(async (database) => this.transaction(database, () => {
      const current = this.readSupervisedWorkerMintState(database, input.agent_id);
      if (!current || current.room_id !== input.room_id
        || current.agent_instance_id !== input.agent_instance_id
        || (current.phase !== "minting_unknown"
          && !(current.phase === "exact" && current.agent_session_id === input.agent_session_id))) {
        throw new Error("Supervised worker mint response is stale or lacks its durable pre-POST fence.");
      }
      run(database.prepare(`
        UPDATE supervised_worker_mint_states
        SET phase='exact',agent_session_id=?,updated_at=?
        WHERE agent_id=?
      `), input.agent_session_id, new Date().toISOString(), input.agent_id);
      return this.readSupervisedWorkerMintState(database, input.agent_id)!;
    }));
  }

  async supervisedWorkerMintState(agentId: string): Promise<SupervisedWorkerMintState | null> {
    return this.withMutation(async (database) => this.readSupervisedWorkerMintState(database, agentId));
  }

  /** Public session metadata only; the raw bearer deliberately has no durable home. */
  async recordSupervisedWorkerSession(input: Omit<SupervisedWorkerSession, "updated_at">): Promise<SupervisedWorkerSession> {
    for (const field of ["agent_id", "room_id", "agent_session_id", "execution_generation_id", "credential_ref"] as const) {
      if (!input[field].trim()) throw new Error(`Supervised worker session ${field} is required.`);
    }
    return this.withMutation(async (database) => this.transaction(database, () => {
      const session: SupervisedWorkerSession = { ...input, updated_at: new Date().toISOString() };
      run(database.prepare(`INSERT INTO supervised_worker_sessions
        (agent_id, room_id, agent_session_id, execution_generation_id, credential_ref, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET room_id=excluded.room_id, agent_session_id=excluded.agent_session_id,
          execution_generation_id=excluded.execution_generation_id, credential_ref=excluded.credential_ref,
          expires_at=excluded.expires_at, updated_at=excluded.updated_at`),
      session.agent_id, session.room_id, session.agent_session_id, session.execution_generation_id,
      session.credential_ref, session.expires_at, session.updated_at);
      return session;
    }));
  }

  async supervisedWorkerSession(agentId: string): Promise<SupervisedWorkerSession | null> {
    return this.withMutation(async (database) => {
      const row = database.prepare("SELECT * FROM supervised_worker_sessions WHERE agent_id=?").get(agentId) as Row | undefined;
      return row ? {
        agent_id: String(row.agent_id), room_id: String(row.room_id), agent_session_id: String(row.agent_session_id),
        execution_generation_id: String(row.execution_generation_id), credential_ref: String(row.credential_ref),
        expires_at: typeof row.expires_at === "string" ? row.expires_at : null, updated_at: String(row.updated_at),
      } : null;
    });
  }

  /** Persist before the provider can receive this session, not on its first heartbeat. */
  async recordExecutionBinding(input: WorkerExecutionBinding): Promise<void> {
    for (const value of Object.values(input)) if (!value.trim()) throw new Error("Worker execution custody requires exact identity.");
    await this.withMutation(async database => this.transaction(database, () => {
      const execution = database.prepare("SELECT work_attempt_id FROM work_attempt_executions WHERE execution_generation_id=?")
        .get(input.execution_generation_id);
      if (execution?.work_attempt_id !== input.work_attempt_id) throw new Error("Worker execution custody belongs to a different attempt.");
      const prior = database.prepare("SELECT * FROM worker_execution_bindings WHERE entry_id=? AND execution_generation_id=? AND agent_session_id=? AND grant_id=?")
        .get(input.entry_id, input.execution_generation_id, input.agent_session_id, input.grant_id);
      if (prior) {
        if (Object.entries(input).some(([key, value]) => prior[key] !== value)) throw new Error("Worker execution custody is immutable.");
        return;
      }
      database.prepare("INSERT INTO worker_execution_bindings VALUES(?,?,?,?,?,?,?,?,?)").run(
        input.entry_id, input.room_id, input.api_url, input.grant_id, input.work_attempt_id,
        input.execution_generation_id, input.agent_session_id, input.agent_key, new Date().toISOString());
    }));
  }

  async executionPredecessors(entryId: string, workAttemptId: string, roomId: string): Promise<WorkerExecutionPredecessor[]> {
    return this.withMutation(async database => {
      const exact = database.prepare("SELECT * FROM worker_execution_bindings WHERE entry_id=? AND work_attempt_id=?")
        .all(entryId, workAttemptId);
      const records: WorkerExecutionPredecessor[] = exact.map(row => ({
        execution_generation_id: String(row.execution_generation_id), agent_session_id: String(row.agent_session_id),
        authority: Object.fromEntries(Object.keys(row).filter(key => key !== "recorded_at").map(key => [key, String(row[key])])) as WorkerExecutionBinding,
      }));
      // Older clients retained publication/verification reservations, not launch
      // receipts. Reuse only exact generations in a completed recovery for this
      // same room and attempt; never manufacture a historical launch receipt.
      const legacy = database.prepare(`SELECT p.execution_generation_id,p.agent_session_id, MAX(CASE WHEN r.phase='complete' AND r.room_id=?
        AND json_extract(r.provider_ref_json,'$.work_attempt_id')=e.work_attempt_id THEN 1 ELSE 0 END) AS recovered FROM (
        SELECT entry_id,execution_generation_id,agent_session_id FROM worker_binding_publications WHERE entry_id=?
        UNION SELECT entry_id,from_execution_generation_id,agent_session_id FROM worker_generation_verifications WHERE entry_id=?
        UNION SELECT entry_id,to_execution_generation_id,agent_session_id FROM worker_generation_verifications WHERE entry_id=?
      ) p JOIN work_attempt_executions e ON e.execution_generation_id=p.execution_generation_id
      LEFT JOIN agent_runtime_recoveries r ON r.agent_id=p.entry_id AND r.execution_generation_id=p.execution_generation_id
      WHERE e.work_attempt_id=?
      GROUP BY p.execution_generation_id,p.agent_session_id`).all(roomId, entryId, entryId, entryId, workAttemptId);
      for (const row of legacy) {
        if (!records.some(record => record.execution_generation_id === row.execution_generation_id && record.agent_session_id === row.agent_session_id)) {
          records.push({ execution_generation_id: String(row.execution_generation_id), agent_session_id: String(row.agent_session_id), authority: null, legacy_recovery_complete: Boolean(row.recovered) });
        }
      }
      const recoveries = database.prepare(`SELECT provider_ref_json FROM agent_runtime_recoveries
        WHERE agent_id=? AND room_id=? AND mode='fresh' AND phase='complete'
          AND json_extract(provider_ref_json,'$.work_attempt_id')=?`).all(entryId, roomId, workAttemptId);
      for (const row of recoveries) {
        const ref = JSON.parse(String(row.provider_ref_json));
        const parsed = cursorLaneRetirementSchema.safeParse(ref.cursor_lane_retirement);
        if (!parsed.success) continue;
        const receipt = parsed.data;
        if (receipt.provider_continuation_id !== ref.provider_continuation_id) continue;
        const matching = records.filter(record => record.execution_generation_id === receipt.execution_generation_id
          && record.agent_session_id === receipt.agent_session_id);
        if (receipt.entry_id !== entryId || receipt.room_id !== roomId || receipt.work_attempt_id !== workAttemptId
          || !matching.some(record => record.authority?.api_url === receipt.api_url
            && record.authority.grant_id === receipt.grant_id && record.authority.agent_key === receipt.agent_key)) continue;
        // Grant rotation retains multiple receipts for one execution/session.
        // The exact acknowledged grant proves that lane, never another execution.
        for (const record of matching) if (record.authority) record.cursor_lane_retirement = receipt;
      }
      return records;
    });
  }

  /**
   * Remove only the live room authority for a retired durable agent. Historical
   * publication watermarks remain intact, so a later resume cannot reuse an
   * old sequence even though it mints a fresh worker session.
   */
  async retireSupervisedWorkerAuthority(
    agentId: string,
    expectedSessionId: string | null,
  ): Promise<void> {
    const retiredCredentialRefs = await this.withMutation(async (database) => this.transaction(database, () => {
      const session = database.prepare("SELECT agent_session_id,credential_ref FROM supervised_worker_sessions WHERE agent_id=?")
        .get(agentId) as Row | undefined;
      const binding = database.prepare("SELECT agent_session_id,credential_ref FROM worker_session_bindings WHERE entry_id=?")
        .get(agentId) as Row | undefined;
      const observedIds = new Set(
        [session?.agent_session_id, binding?.agent_session_id]
          .filter((value): value is string => typeof value === "string" && Boolean(value.trim())),
      );
      if (expectedSessionId) {
        if (observedIds.size > 0 && (observedIds.size !== 1 || !observedIds.has(expectedSessionId))) {
          throw new Error("Retired worker authority changed before local cleanup.");
        }
      } else if (observedIds.size > 0) {
        throw new Error("Retired worker authority requires an exact server-session acknowledgement.");
      }
      run(database.prepare("DELETE FROM worker_session_bindings WHERE entry_id=?"), agentId);
      run(database.prepare("DELETE FROM supervised_worker_sessions WHERE agent_id=?"), agentId);
      run(database.prepare("DELETE FROM supervised_worker_mint_states WHERE agent_id=?"), agentId);
      return [session?.credential_ref, binding?.credential_ref]
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
    }));
    for (const credentialRef of retiredCredentialRefs) this.credentials.delete(credentialRef);
  }

  async bind(input: WorkerSessionBindingInput): Promise<WorkerSessionBinding> {
    this.validate(input);
    // Test/fence seam must remain outside the SQLite transaction: a stalled
    // pre-commit caller must not lock unrelated manifest work during handoff.
    await this.write(input);
    return this.withMutation(async (database) => {
      const bound = await this.transaction(database, () => {
      const prior = this.read(database, input.entry_id);
      const watermark = this.readWatermark(database, input.entry_id);
      const sameSession = prior?.agent_session_id === input.agent_session_id;
      const now = new Date().toISOString();
      const nextEpoch = Math.max(prior ? this.readBindingEpoch(database, input.entry_id) : 0, watermark?.binding_epoch ?? 0) + 1;
      const binding: WorkerSessionBinding = {
        entry_id: input.entry_id, room_id: input.room_id, work_attempt_id: input.work_attempt_id,
        execution_generation_id: input.execution_generation_id, agent_session_id: input.agent_session_id,
        credential_ref: input.credential_ref?.trim() || randomUUID(), api_url: roomApiOrigin(input.api_url),
        room_cursor: sameSession ? prior!.room_cursor : null,
        // Credentials may rotate, but the native API's sequence authority is
        // per durable agent entry. Never reuse a journal/API sequence.
        last_sequence: Math.max(prior?.last_sequence ?? 0, watermark?.last_sequence ?? 0),
        last_observed_at_ms: Math.max(prior?.last_observed_at_ms ?? 0, watermark?.last_observed_at_ms ?? 0),
        updated_at: now,
      };
      // Any formal bind/rebind establishes a new authority epoch. This makes
      // delayed responses unable to revoke or advance replacement credentials.
      run(database.prepare(`INSERT INTO worker_session_bindings
        (entry_id, room_id, work_attempt_id, execution_generation_id, agent_session_id, credential_ref, api_url, room_cursor, last_sequence, last_observed_at_ms, binding_epoch, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET room_id=excluded.room_id, work_attempt_id=excluded.work_attempt_id,
          execution_generation_id=excluded.execution_generation_id, agent_session_id=excluded.agent_session_id,
          credential_ref=excluded.credential_ref, api_url=excluded.api_url, room_cursor=excluded.room_cursor,
          last_sequence=excluded.last_sequence, last_observed_at_ms=excluded.last_observed_at_ms,
          binding_epoch=excluded.binding_epoch, updated_at=excluded.updated_at`),
        binding.entry_id, binding.room_id, binding.work_attempt_id, binding.execution_generation_id, binding.agent_session_id,
        binding.credential_ref, binding.api_url, binding.room_cursor, binding.last_sequence, binding.last_observed_at_ms,
        nextEpoch, binding.updated_at);
      this.upsertWatermark(database, input.entry_id, nextEpoch, binding.last_sequence, binding.last_observed_at_ms, binding.updated_at);
      return { binding, bindingEpoch: nextEpoch, priorCredentialRef: prior?.credential_ref ?? null };
      }, { captureAgentId: input.entry_id });
      // SQLite is committed but this entry remains inside the same mutation
      // queue, so a concurrent credential install cannot be overwritten by a
      // stale formal bind's delayed vault write.
      if (bound.priorCredentialRef) this.credentials.delete(bound.priorCredentialRef);
      this.credentials.set(bound.binding.credential_ref, {
        entry_id: bound.binding.entry_id,
        agent_session_id: bound.binding.agent_session_id,
        execution_generation_id: bound.binding.execution_generation_id,
        binding_epoch: bound.bindingEpoch,
        token: input.agent_session_token,
      });
      return bound.binding;
    });
  }

  async checkpointCursor(entryId: string, agentSessionId: string, executionGenerationId: string, roomCursor: string): Promise<WorkerSessionBinding> {
    for (const [field, value] of Object.entries({ entryId, agentSessionId, executionGenerationId, roomCursor })) if (!value.trim()) throw new Error(`Worker cursor checkpoint ${field} is required.`);
    return this.withMutation(async (database) => this.transaction(database, () => {
      const prior = this.match(database, entryId, agentSessionId, executionGenerationId);
      if (prior.room_cursor === roomCursor) return prior;
      run(database.prepare("UPDATE worker_session_bindings SET room_cursor = ?, updated_at = ? WHERE entry_id = ? AND agent_session_id = ? AND execution_generation_id = ?"), roomCursor, new Date().toISOString(), entryId, agentSessionId, executionGenerationId);
      return this.read(database, entryId)!;
    }, { captureAgentId: entryId }));
  }

  async checkpointCursorMonotonic(entryId: string, agentSessionId: string, executionGenerationId: string, roomCursor: string): Promise<{ binding: WorkerSessionBinding; advanced: boolean }> {
    const candidate = parseRoomMessageNumber(roomCursor);
    if (candidate === null) throw new Error("Compatibility worker cursor must be a numeric room message id.");
    return this.withMutation(async (database) => this.transaction(database, () => {
      const prior = this.match(database, entryId, agentSessionId, executionGenerationId);
      const existing = parseRoomMessageNumber(prior.room_cursor);
      if (prior.room_cursor !== null && (existing === null || candidate <= existing)) return { binding: prior, advanced: false };
      run(database.prepare("UPDATE worker_session_bindings SET room_cursor = ?, updated_at = ? WHERE entry_id = ? AND agent_session_id = ? AND execution_generation_id = ?"), roomCursor, new Date().toISOString(), entryId, agentSessionId, executionGenerationId);
      return { binding: this.read(database, entryId)!, advanced: true };
    }, { captureAgentId: entryId }));
  }

  async publish<T extends { accepted: boolean }>(entryId: string, observedAtMs: number, operation: (publication: { binding: WorkerSessionBinding; sequence: number; observed_at: string }) => Promise<T>): Promise<(T & { sequence: number; observed_at: string }) | null> {
    const reservation = await this.reservePublication(entryId, observedAtMs);
    if (!reservation) return null;
    let result: T;
    try { result = await operation({ binding: reservation.binding, sequence: reservation.sequence, observed_at: reservation.observedAt }); }
    catch (error) { await this.finalizePublication(reservation, "transport_error"); throw error; }
    await this.finalizePublication(reservation, result.accepted ? "accepted" : "rejected");
    await this.compactPublicationsAfterFinalize(entryId);
    return { ...result, sequence: reservation.sequence, observed_at: reservation.observedAt };
  }

  /**
   * Compact every over-retention publication journal once, at open. A daemon
   * that has been running for months can hold hundreds of thousands of
   * republication rows, and their page-cache misses are what make the
   * synchronous reads on this database expensive.
   */
  async compactRetainedPublications(retained = RETAINED_WORKER_BINDING_PUBLICATIONS_PER_ENTRY): Promise<{ entries: number; deleted: number }> {
    const entries = await this.withMutation(async (database) => entriesOverPublicationRetention(database, retained));
    let deleted = 0;
    for (const entryId of entries) {
      for (let pass = 0; pass < 32; pass += 1) {
        // One mutation (and one transaction) per pass. Retention must never
        // hold the store's mutation queue, or a real publication or cursor
        // checkpoint would wait behind a bulk delete on first launch.
        const result = await this.withMutation(async (database) =>
          this.transaction(database, () => prunePublicationsForEntry(database, entryId, retained), { captureAgentId: false }));
        deleted += result.deleted;
        if (!result.truncated || result.deleted === 0) break;
      }
    }
    return { entries: entries.length, deleted };
  }

  /**
   * Compaction is driven by the writes that cause the growth, so an idle daemon
   * performs no retention work and no timer polls this table. A failure here is
   * never authority: the reservation has already been finalized durably.
   */
  private async compactPublicationsAfterFinalize(entryId: string): Promise<void> {
    const since = (this.publicationsSinceCompaction.get(entryId) ?? 0) + 1;
    if (since < WORKER_BINDING_PUBLICATIONS_PRUNE_INTERVAL) {
      this.publicationsSinceCompaction.set(entryId, since);
      return;
    }
    this.publicationsSinceCompaction.set(entryId, 0);
    try {
      await this.withMutation(async (database) => this.transaction(database, () => prunePublicationsForEntry(database, entryId), { captureAgentId: false }));
    } catch { /* Retention is opportunistic; the next publication retries it. */ }
  }

  async verifyAndAdvanceExecutionGeneration<T extends { accepted: boolean }>(input: { entryId: string; roomId: string; workAttemptId: string; fromExecutionGenerationId: string; toExecutionGenerationId: string; agentSessionId: string }, operation: (publication: { binding: Readonly<WorkerSessionBinding>; sequence: number; observed_at: string }) => Promise<T>): Promise<{ binding: WorkerSessionBinding; advanced: boolean; accepted: boolean }> {
    for (const [field, value] of Object.entries(input)) if (!value.trim()) throw new Error(`Worker binding generation rollover ${field} is required.`);
    if (input.fromExecutionGenerationId === input.toExecutionGenerationId) throw new Error("Worker binding generation rollover requires a successor execution generation.");
    const reserved = await this.reserveVerification(input);
    if (reserved.kind === "idempotent") return { binding: reserved.binding, advanced: false, accepted: true };
    let result: T;
    try { result = await operation({ binding: reserved.reservation.binding, sequence: reserved.reservation.sequence, observed_at: reserved.reservation.observedAt }); }
    catch (error) { await this.finalizeVerification(reserved.reservation, input, false); throw error; }
    return this.finalizeVerification(reserved.reservation, input, result.accepted);
  }

  async unbind(entryId: string, expectedSessionId?: string, expectedExecutionGenerationId?: string): Promise<boolean> {
    const result = await this.withMutation(async (database) => this.transaction(database, () => {
      const current = this.read(database, entryId);
      if (!current || (expectedSessionId && current.agent_session_id !== expectedSessionId) || (expectedExecutionGenerationId && current.execution_generation_id !== expectedExecutionGenerationId)) return { removed: false, credentialRef: null as string | null };
      run(database.prepare("DELETE FROM worker_session_bindings WHERE entry_id = ?"), entryId);
      return { removed: true, credentialRef: current.credential_ref };
    }, { captureAgentId: entryId }));
    if (result.credentialRef) this.credentials.delete(result.credentialRef);
    return result.removed;
  }

  /** Returns the exact in-memory credential, never a persisted value. */
  async credentialFor(input: {
    entry_id: string;
    agent_session_id: string;
    execution_generation_id: string;
  }): Promise<string | null> {
    return this.withMutation(async (database) => {
      const binding = this.read(database, input.entry_id);
      if (!binding
        || binding.agent_session_id !== input.agent_session_id
        || binding.execution_generation_id !== input.execution_generation_id) return null;
      const epoch = this.readBindingEpoch(database, input.entry_id);
      const credential = this.credentials.get(binding.credential_ref);
      if (!credential
        || credential.entry_id !== binding.entry_id
        || credential.agent_session_id !== binding.agent_session_id
        || credential.execution_generation_id !== binding.execution_generation_id
        || credential.binding_epoch !== epoch) return null;
      return credential.token;
    });
  }

  /** Electron re-delivers a rotated token after the daemon has proved identity.
   * The value never reaches SQLite; it is cleared on process exit or binding change. */
  async installCredential(input: {
    entry_id: string;
    agent_session_id: string;
    execution_generation_id: string;
    agent_session_token: string;
  }): Promise<boolean> {
    if (!input.agent_session_token.trim()) throw new Error("Worker credential is required.");
    return this.withMutation(async (database) => {
      const binding = this.read(database, input.entry_id);
      if (!binding || binding.agent_session_id !== input.agent_session_id || binding.execution_generation_id !== input.execution_generation_id) return false;
      this.credentials.set(binding.credential_ref, {
        entry_id: binding.entry_id,
        agent_session_id: binding.agent_session_id,
        execution_generation_id: binding.execution_generation_id,
        binding_epoch: this.readBindingEpoch(database, binding.entry_id),
        token: input.agent_session_token,
      });
      return true;
    });
  }

  private async reservePublication(entryId: string, observedAtMs: number): Promise<Reservation | null> {
    return this.withMutation(async (database) => this.transaction(database, () => {
      const prior = this.read(database, entryId); if (!prior) return null;
      const epoch = this.readBindingEpoch(database, entryId);
      const now = Date.now(); const candidate = Number.isFinite(observedAtMs) ? Math.min(Math.floor(observedAtMs), now) : now;
      const effective = Math.max(candidate, prior.last_observed_at_ms + 1); const sequence = Math.max(prior.last_sequence + 1, effective); const observedAt = new Date(effective).toISOString(); const id = randomUUID();
      run(this.reads.get(database, "advanceBinding"),sequence, effective, observedAt, entryId, epoch);
      this.upsertWatermark(database, entryId, epoch, sequence, effective, observedAt);
      run(this.reads.get(database, "reservePublication"), id, entryId, epoch, prior.execution_generation_id, prior.agent_session_id, sequence, observedAt, effective, observedAt);
      return { reservationId: id, binding: { ...prior, last_sequence: sequence, last_observed_at_ms: effective, updated_at: observedAt }, bindingEpoch: epoch, sequence, observedAt, observedAtMs: effective };
    }, { captureAgentId: false }));
  }

  private async finalizePublication(reservation: Reservation, outcome: "accepted" | "rejected" | "transport_error"): Promise<void> {
    const revoked = await this.withMutation(async (database) => this.transaction(database, () => {
      // v4's state vocabulary predates transport-error observability. Keep a
      // durable failed reservation, but only an explicit server rejection may
      // revoke authority; timeout/throw must leave it usable.
      const state = outcome === "accepted" ? "accepted" : "failed"; const now = new Date().toISOString();
      run(this.reads.get(database, "finalizePublication"), state, now, reservation.reservationId);
      // Rejection revokes only the exact still-current authority and only if no
      // later reservation exists. A delayed N response can never erase N+1.
      if (outcome === "rejected") {
        const latest = database.prepare(`SELECT reservation_id, sequence FROM (
          SELECT reservation_id, sequence FROM worker_binding_publications WHERE entry_id=?
          UNION ALL SELECT reservation_id, sequence FROM worker_generation_verifications WHERE entry_id=?
        ) ORDER BY sequence DESC LIMIT 1`).get(reservation.binding.entry_id, reservation.binding.entry_id) as Row | undefined;
        if (latest?.reservation_id === reservation.reservationId && Number(latest.sequence) === reservation.sequence) {
          run(database.prepare("DELETE FROM worker_session_bindings WHERE entry_id=? AND binding_epoch=? AND execution_generation_id=? AND agent_session_id=?"), reservation.binding.entry_id, reservation.bindingEpoch, reservation.binding.execution_generation_id, reservation.binding.agent_session_id);
          return reservation.binding.credential_ref;
        }
      }
      return null;
    }, { captureAgentId: outcome === "rejected" ? reservation.binding.entry_id : false }));
    if (revoked) this.credentials.delete(revoked);
  }

  private async reserveVerification(input: { entryId: string; roomId: string; workAttemptId: string; fromExecutionGenerationId: string; toExecutionGenerationId: string; agentSessionId: string }): Promise<{ kind: "idempotent"; binding: WorkerSessionBinding } | { kind: "reserved"; reservation: Reservation }> {
    return this.withMutation(async (database) => this.transaction(database, () => {
      const prior = this.read(database, input.entryId);
      if (!prior || prior.room_id !== input.roomId || prior.work_attempt_id !== input.workAttemptId || prior.agent_session_id !== input.agentSessionId) throw new Error("Worker binding generation rollover does not match the durable worker identity.");
      if (prior.execution_generation_id === input.toExecutionGenerationId) return { kind: "idempotent", binding: prior };
      if (prior.execution_generation_id !== input.fromExecutionGenerationId) throw new Error("Worker binding generation rollover does not match its terminal predecessor.");
      const epoch = this.readBindingEpoch(database, input.entryId);
      const effective = Math.max(Date.now(), prior.last_observed_at_ms + 1); const sequence = Math.max(prior.last_sequence + 1, effective); const observedAt = new Date(effective).toISOString(); const id = randomUUID();
      run(this.reads.get(database, "advanceBinding"),sequence, effective, observedAt, input.entryId, epoch);
      this.upsertWatermark(database, input.entryId, epoch, sequence, effective, observedAt);
      run(database.prepare("INSERT INTO worker_generation_verifications (reservation_id, entry_id, binding_epoch, from_execution_generation_id, to_execution_generation_id, agent_session_id, sequence, observed_at, observed_at_ms, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)"), id, input.entryId, epoch, input.fromExecutionGenerationId, input.toExecutionGenerationId, input.agentSessionId, sequence, observedAt, effective, observedAt);
      return { kind: "reserved", reservation: { reservationId: id, binding: { ...prior, last_sequence: sequence, last_observed_at_ms: effective, updated_at: observedAt }, bindingEpoch: epoch, sequence, observedAt, observedAtMs: effective } };
    }, { captureAgentId: input.entryId }));
  }

  private async finalizeVerification(reservation: Reservation, input: { entryId: string; fromExecutionGenerationId: string; toExecutionGenerationId: string; agentSessionId: string }, accepted: boolean): Promise<{ binding: WorkerSessionBinding; advanced: boolean; accepted: boolean }> {
    return this.withMutation(async (database) => {
      const result = await this.transaction(database, () => {
      const current = this.read(database, input.entryId); const now = new Date().toISOString();
      if (!accepted) { run(database.prepare("UPDATE worker_generation_verifications SET state='failed', finalized_at=? WHERE reservation_id=? AND state='reserved'"), now, reservation.reservationId); return { binding: current ?? reservation.binding, advanced: false, accepted: false }; }
      const epoch = current ? this.readBindingEpoch(database, input.entryId) : -1;
      if (current && epoch === reservation.bindingEpoch && current.execution_generation_id === input.fromExecutionGenerationId && current.agent_session_id === input.agentSessionId) {
        run(database.prepare("UPDATE worker_session_bindings SET execution_generation_id=?, updated_at=? WHERE entry_id=? AND binding_epoch=? AND execution_generation_id=? AND agent_session_id=?"), input.toExecutionGenerationId, now, input.entryId, epoch, input.fromExecutionGenerationId, input.agentSessionId);
        run(database.prepare("UPDATE worker_generation_verifications SET state='accepted', finalized_at=? WHERE reservation_id=? AND state='reserved'"), now, reservation.reservationId);
        const binding = this.read(database, input.entryId)!;
        return { binding, advanced: true, accepted: true };
      }
      run(database.prepare("UPDATE worker_generation_verifications SET state='lost_race', finalized_at=? WHERE reservation_id=? AND state='reserved'"), now, reservation.reservationId);
      if (current?.execution_generation_id === input.toExecutionGenerationId
        && current.agent_session_id === input.agentSessionId
        && current.room_id === reservation.binding.room_id
        && current.work_attempt_id === reservation.binding.work_attempt_id) return { binding: current, advanced: false, accepted: true };
      return { binding: current ?? reservation.binding, advanced: false, accepted: false };
      }, { captureAgentId: input.entryId });
      // Commit happened, but the mutation mutex is still held. Move the vault
      // authority before another operation can unbind/rebind the same entry.
      if (result.advanced) {
        const credential = this.credentials.get(result.binding.credential_ref);
        if (credential && credential.entry_id === result.binding.entry_id
          && credential.agent_session_id === result.binding.agent_session_id
          && credential.binding_epoch === this.readBindingEpoch(database, result.binding.entry_id)
          && credential.execution_generation_id === input.fromExecutionGenerationId) {
          this.credentials.set(result.binding.credential_ref, { ...credential, execution_generation_id: result.binding.execution_generation_id });
        }
      }
      return result;
    });
  }

  private match(database: DatabaseSync, entryId: string, sessionId: string, generationId: string): WorkerSessionBinding {
    const binding = this.read(database, entryId);
    if (!binding || binding.agent_session_id !== sessionId || binding.execution_generation_id !== generationId) throw new Error("Worker cursor checkpoint does not match the active supervised binding.");
    return binding;
  }
  private async write(_value: unknown): Promise<void> {}
  private read(database: DatabaseSync, entryId: string): WorkerSessionBinding | null { const row = this.reads.get(database, "binding").get(entryId) as Row | undefined; return row ? rowToBinding(row) : null; }
  private readBindingEpoch(database: DatabaseSync, entryId: string): number { return Number((this.reads.get(database, "epoch").get(entryId) as Row).binding_epoch); }
  private readWatermark(database: DatabaseSync, entryId: string): { binding_epoch: number; last_sequence: number; last_observed_at_ms: number } | null {
    const row = this.reads.get(database, "watermark").get(entryId) as Row | undefined;
    return row ? { binding_epoch: Number(row.binding_epoch), last_sequence: Number(row.last_sequence), last_observed_at_ms: Number(row.last_observed_at_ms) } : null;
  }
  private upsertWatermark(database: DatabaseSync, entryId: string, bindingEpoch: number, lastSequence: number, lastObservedAtMs: number, updatedAt: string): void {
    run(this.reads.get(database, "upsertWatermark"), entryId, bindingEpoch, lastSequence, lastObservedAtMs, updatedAt);
  }
  private readSupervisedWorkerMintState(database: DatabaseSync, agentId: string): SupervisedWorkerMintState | null {
    const row = database.prepare("SELECT * FROM supervised_worker_mint_states WHERE agent_id=?").get(agentId) as Row | undefined;
    return row ? {
      agent_id: String(row.agent_id), room_id: String(row.room_id),
      agent_instance_id: String(row.agent_instance_id),
      phase: String(row.phase) as SupervisedWorkerMintState["phase"],
      agent_session_id: typeof row.agent_session_id === "string" ? row.agent_session_id : null,
      updated_at: String(row.updated_at),
    } : null;
  }
  private validate(input: WorkerSessionBindingInput): void { for (const field of ["entry_id", "room_id", "work_attempt_id", "execution_generation_id", "agent_session_id", "agent_session_token", "api_url"] as const) if (!input[field]?.trim()) throw new Error(`Worker binding ${field} is required.`); if (input.credential_ref !== undefined && !input.credential_ref.trim()) throw new Error("Worker binding credential_ref is required when supplied."); const url = new URL(input.api_url); if (!isLocalRoomApi(input.api_url) && url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Worker binding api_url must use HTTP or HTTPS."); }
  private async withMutation<T>(operation: (database: DatabaseSync) => Promise<T>): Promise<T> {
    const timing = new RoomLatencyTrace("worker_binding_store");
    const previous = this.mutations;
    let release!: () => void;
    this.mutations = new Promise((resolve) => { release = resolve; });
    await previous;
    timing.mark("queue_wait");
    try {
      const database = await this.getDatabase();
      timing.mark("database");
      return await operation(database);
    } finally {
      release();
      timing.mark("operation");
      timing.finish();
    }
  }
  private async transaction<T>(database: DatabaseSync, operation: () => T, notification?: DaemonCommitNotification): Promise<T> {
    let open = false; let committed = false; let result!: T;
    const commit = async () => {
      if (committed || open) throw new Error("Worker binding transaction commit was invoked more than once.");
      database.exec("BEGIN IMMEDIATE"); open = true;
      try {
        this.writeFence?.();
        result = operation();
        database.exec("COMMIT"); open = false; committed = true;
      } catch (error) {
        if (open) try { database.exec("ROLLBACK"); } catch { /* no-op */ }
        open = false; throw error;
      }
    };
    try {
      if (this.commitFence) await this.commitFence(commit, notification); else await commit();
      if (!committed) throw new Error("Worker binding commit fence returned without committing.");
      return result;
    } catch (error) {
      // A fence may accidentally call its supplied commit then throw/retry.
      // Once SQLite has committed, never report a durable success as failure.
      if (committed) return result;
      if (open) try { database.exec("ROLLBACK"); } catch { /* no-op */ }
      throw error;
    }
  }
  private async getDatabase(): Promise<DatabaseSync> { if (this.closed) throw new Error("WorkerBindingStore is closed."); if (this.database) return this.database; if (!this.initializing) this.initializing = this.initialize(); return this.initializing; }
  private async initialize(): Promise<DatabaseSync> {
    let database: DatabaseSync | null = null;
    try {
      database = await openDaemonStateDatabase(this.databasePath, (opened) => new DaemonStateSchema().createSchema(opened));
      this.database = database;
      this.ownsDatabase = true;
      return database;
    } catch (error) {
      database?.close();
      this.initializing = null;
      throw error;
    }
  }
}

function rowToBinding(row: Row): WorkerSessionBinding { return { entry_id: String(row.entry_id), room_id: String(row.room_id), work_attempt_id: String(row.work_attempt_id), execution_generation_id: String(row.execution_generation_id), agent_session_id: String(row.agent_session_id), credential_ref: String(row.credential_ref), api_url: String(row.api_url), room_cursor: row.room_cursor === null ? null : String(row.room_cursor), last_sequence: Number(row.last_sequence), last_observed_at_ms: Number(row.last_observed_at_ms), updated_at: String(row.updated_at) }; }

function parseRoomMessageNumber(value: string | null): number | null { const match = value && /^msg_(\d+)$/.exec(value); const parsed = match ? Number(match[1]) : NaN; return Number.isSafeInteger(parsed) ? parsed : null; }
function defaultDatabasePath(legacyJsonPath: string): string {
  // SupervisorDaemon always injects the canonical path. Standalone tooling
  // follows the documented daemon-state filename rather than inventing JSON.
  return `${dirname(legacyJsonPath)}/daemon-state.sqlite`;
}
