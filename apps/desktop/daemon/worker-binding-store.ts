import { createHash, randomUUID } from "node:crypto";
import { chmod, link, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DaemonStateSchema, openDaemonStateDatabase } from "./daemon-state-database.js";

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
type Row = Record<string, unknown>;
type Reservation = { reservationId: string; binding: WorkerSessionBinding; bindingEpoch: number; sequence: number; observedAt: string; observedAtMs: number };
type LegacyWorkerSessionBinding = WorkerSessionBindingInput & Pick<WorkerSessionBinding, "room_cursor" | "last_sequence" | "last_observed_at_ms" | "updated_at">;
type LegacyBindings = { version: 1; bindings: Record<string, LegacyWorkerSessionBinding> };
function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }
function checksumOf(raw: string): string { return createHash("sha256").update(raw).digest("hex"); }

/**
 * Daemon-private credentials. The JSON path is accepted only as a one-shot
 * import source; all active state lives in the shared owner-only SQLite DB.
 * Network work is deliberately performed after a tiny reservation transaction.
 */
export class WorkerBindingStore {
  private database: DatabaseSync | null = null;
  private initializing: Promise<DatabaseSync> | null = null;
  private mutations: Promise<void> = Promise.resolve();
  private closed = false;
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
    private readonly commitFence?: (commit: () => Promise<void>) => Promise<void>,
    private readonly databasePath = defaultDatabasePath(legacyJsonPath),
    /** Test-only seam for the narrow committed-record / backup-finalization window. */
    private readonly legacyBackupFinalizationHook?: () => Promise<void>,
  ) {}

  async close(): Promise<void> {
    this.closed = true;
    // Let an already-reserved local DB operation finish; transport is never
    // part of this queue, so handoff does not wait on HTTP.
    await this.initializing?.catch(() => undefined);
    await this.mutations.catch(() => undefined);
    this.database?.close();
    this.database = null;
    this.credentials.clear();
  }

  async get(entryId: string): Promise<WorkerSessionBinding | null> {
    return this.withMutation(async (database) => this.read(database, entryId));
  }
  async list(): Promise<WorkerSessionBinding[]> {
    return this.withMutation(async (database) => (database.prepare("SELECT * FROM worker_session_bindings ORDER BY entry_id").all() as Row[]).map(rowToBinding));
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

  async bind(input: WorkerSessionBindingInput, custodialPolling?: { roomCursor: string | null }): Promise<WorkerSessionBinding> {
    this.validate(input);
    if (custodialPolling && parseRoomMessageNumber(custodialPolling.roomCursor) === null) {
      throw new Error("Custodial polling requires an acknowledged numeric room cursor before binding.");
    }
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
        credential_ref: input.credential_ref?.trim() || randomUUID(), api_url: new URL(input.api_url).origin,
        room_cursor: custodialPolling ? custodialPolling.roomCursor : sameSession ? prior!.room_cursor : null,
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
      });
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
    }));
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
    }));
  }

  async publish<T extends { accepted: boolean }>(entryId: string, observedAtMs: number, operation: (publication: { binding: WorkerSessionBinding; sequence: number; observed_at: string }) => Promise<T>): Promise<(T & { sequence: number; observed_at: string }) | null> {
    const reservation = await this.reservePublication(entryId, observedAtMs);
    if (!reservation) return null;
    let result: T;
    try { result = await operation({ binding: reservation.binding, sequence: reservation.sequence, observed_at: reservation.observedAt }); }
    catch (error) { await this.finalizePublication(reservation, "transport_error"); throw error; }
    await this.finalizePublication(reservation, result.accepted ? "accepted" : "rejected");
    return { ...result, sequence: reservation.sequence, observed_at: reservation.observedAt };
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
    }));
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
      run(database.prepare("UPDATE worker_session_bindings SET last_sequence=?, last_observed_at_ms=?, updated_at=? WHERE entry_id=? AND binding_epoch=?"), sequence, effective, observedAt, entryId, epoch);
      this.upsertWatermark(database, entryId, epoch, sequence, effective, observedAt);
      run(database.prepare("INSERT INTO worker_binding_publications (reservation_id, entry_id, binding_epoch, execution_generation_id, agent_session_id, sequence, observed_at, observed_at_ms, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)"), id, entryId, epoch, prior.execution_generation_id, prior.agent_session_id, sequence, observedAt, effective, observedAt);
      return { reservationId: id, binding: { ...prior, last_sequence: sequence, last_observed_at_ms: effective, updated_at: observedAt }, bindingEpoch: epoch, sequence, observedAt, observedAtMs: effective };
    }));
  }

  private async finalizePublication(reservation: Reservation, outcome: "accepted" | "rejected" | "transport_error"): Promise<void> {
    const revoked = await this.withMutation(async (database) => this.transaction(database, () => {
      // v4's state vocabulary predates transport-error observability. Keep a
      // durable failed reservation, but only an explicit server rejection may
      // revoke authority; timeout/throw must leave it usable.
      const state = outcome === "accepted" ? "accepted" : "failed"; const now = new Date().toISOString();
      run(database.prepare("UPDATE worker_binding_publications SET state=?, finalized_at=? WHERE reservation_id=? AND state='reserved'"), state, now, reservation.reservationId);
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
    }));
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
      run(database.prepare("UPDATE worker_session_bindings SET last_sequence=?, last_observed_at_ms=?, updated_at=? WHERE entry_id=? AND binding_epoch=?"), sequence, effective, observedAt, input.entryId, epoch);
      this.upsertWatermark(database, input.entryId, epoch, sequence, effective, observedAt);
      run(database.prepare("INSERT INTO worker_generation_verifications (reservation_id, entry_id, binding_epoch, from_execution_generation_id, to_execution_generation_id, agent_session_id, sequence, observed_at, observed_at_ms, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)"), id, input.entryId, epoch, input.fromExecutionGenerationId, input.toExecutionGenerationId, input.agentSessionId, sequence, observedAt, effective, observedAt);
      return { kind: "reserved", reservation: { reservationId: id, binding: { ...prior, last_sequence: sequence, last_observed_at_ms: effective, updated_at: observedAt }, bindingEpoch: epoch, sequence, observedAt, observedAtMs: effective } };
    }));
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
      });
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
  private read(database: DatabaseSync, entryId: string): WorkerSessionBinding | null { const row = database.prepare("SELECT * FROM worker_session_bindings WHERE entry_id=?").get(entryId) as Row | undefined; return row ? rowToBinding(row) : null; }
  private readBindingEpoch(database: DatabaseSync, entryId: string): number { return Number((database.prepare("SELECT binding_epoch FROM worker_session_bindings WHERE entry_id=?").get(entryId) as Row).binding_epoch); }
  private readWatermark(database: DatabaseSync, entryId: string): { binding_epoch: number; last_sequence: number; last_observed_at_ms: number } | null {
    const row = database.prepare("SELECT binding_epoch, last_sequence, last_observed_at_ms FROM worker_binding_watermarks WHERE entry_id=?").get(entryId) as Row | undefined;
    return row ? { binding_epoch: Number(row.binding_epoch), last_sequence: Number(row.last_sequence), last_observed_at_ms: Number(row.last_observed_at_ms) } : null;
  }
  private upsertWatermark(database: DatabaseSync, entryId: string, bindingEpoch: number, lastSequence: number, lastObservedAtMs: number, updatedAt: string): void {
    run(database.prepare(`INSERT INTO worker_binding_watermarks (entry_id, binding_epoch, last_sequence, last_observed_at_ms, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET binding_epoch=MAX(worker_binding_watermarks.binding_epoch, excluded.binding_epoch),
        last_sequence=MAX(worker_binding_watermarks.last_sequence, excluded.last_sequence),
        last_observed_at_ms=MAX(worker_binding_watermarks.last_observed_at_ms, excluded.last_observed_at_ms),
        updated_at=CASE WHEN excluded.last_observed_at_ms >= worker_binding_watermarks.last_observed_at_ms THEN excluded.updated_at ELSE worker_binding_watermarks.updated_at END`), entryId, bindingEpoch, lastSequence, lastObservedAtMs, updatedAt);
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
  private validate(input: WorkerSessionBindingInput): void { for (const field of ["entry_id", "room_id", "work_attempt_id", "execution_generation_id", "agent_session_id", "agent_session_token", "api_url"] as const) if (!input[field]?.trim()) throw new Error(`Worker binding ${field} is required.`); if (input.credential_ref !== undefined && !input.credential_ref.trim()) throw new Error("Worker binding credential_ref is required when supplied."); const url = new URL(input.api_url); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Worker binding api_url must use HTTP or HTTPS."); }
  private async withMutation<T>(operation: (database: DatabaseSync) => Promise<T>): Promise<T> { const previous = this.mutations; let release!: () => void; this.mutations = new Promise((resolve) => { release = resolve; }); await previous; try { return await operation(await this.getDatabase()); } finally { release(); } }
  private async transaction<T>(database: DatabaseSync, operation: () => T): Promise<T> {
    let open = false; let committed = false; let result!: T;
    const commit = async () => {
      if (committed || open) throw new Error("Worker binding transaction commit was invoked more than once.");
      database.exec("BEGIN IMMEDIATE"); open = true;
      try {
        result = operation();
        database.exec("COMMIT"); open = false; committed = true;
      } catch (error) {
        if (open) try { database.exec("ROLLBACK"); } catch { /* no-op */ }
        open = false; throw error;
      }
    };
    try {
      if (this.commitFence) await this.commitFence(commit); else await commit();
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
  private async initialize(): Promise<DatabaseSync> { let database: DatabaseSync | null = null; try { database = await openDaemonStateDatabase(this.databasePath, (opened) => new DaemonStateSchema().createSchema(opened)); await this.importLegacy(database); this.database = database; return database; } catch (error) { database?.close(); this.initializing = null; throw error; } }
  private async importLegacy(database: DatabaseSync): Promise<void> {
    const key = `legacy-worker-bindings:${this.legacyJsonPath}`;
    const backup = `${this.legacyJsonPath}.migrated-backup`;
    const prior = database.prepare("SELECT checksum FROM migration_records WHERE migration_key=?").get(key) as Row | undefined;
    if (prior) { await this.finishLegacyBackup(backup, String(prior.checksum)); return; }
    const failed = database.prepare("SELECT reason, quarantined_path FROM migration_failures WHERE migration_key=?").get(key) as Row | undefined;
    if (failed) {
      // The durable failure is authoritative; retry only the filesystem
      // housekeeping left behind by a crash/permission error before failing
      // closed again.
      const quarantine = String(failed.quarantined_path);
      await this.reconcileFailedEvidence(quarantine);
      throw new Error(`Legacy worker binding import was previously quarantined: ${String(failed.reason)} (${quarantine}).`);
    }
    const initialState = await this.legacySourceState();
    let claimed: string | null = null;
    if (initialState.claims.length > 0) {
      // Never prefer a fresh public replacement over pre-existing claimed
      // evidence. A+public-B or multiple claims is ambiguous without a durable
      // verdict, so preserve every byte and fail closed.
      if (initialState.publicPresent || initialState.claims.length !== 1) {
        throw new Error(`Legacy worker binding migration has ambiguous source evidence (${initialState.claims.length} claim(s), public source ${initialState.publicPresent ? "present" : "absent"}).`);
      }
      const concurrent = await this.waitForConcurrentClaim(database, key);
      if (concurrent.kind === "committed") { await this.finishLegacyBackup(backup, concurrent.checksum); return; }
      if (concurrent.kind === "failed") { await this.reconcileFailedEvidence(concurrent.quarantine); throw new Error(`Legacy worker binding import was previously quarantined: ${concurrent.reason} (${concurrent.quarantine}).`); }
      claimed = await this.adoptOrphanClaim();
    } else {
      claimed = await this.captureAndRemoveLegacySource();
    }
    if (!claimed) {
      // A sibling opener may have atomically claimed the source immediately
      // before us. Do not expose an empty binding set while it is making the
      // record authoritative; wait only when a live claim is observable.
      const concurrent = await this.waitForConcurrentClaim(database, key);
      if (concurrent.kind === "committed") { await this.finishLegacyBackup(backup, concurrent.checksum); return; }
      if (concurrent.kind === "failed") { await this.reconcileFailedEvidence(concurrent.quarantine); throw new Error(`Legacy worker binding import was previously quarantined: ${concurrent.reason} (${concurrent.quarantine}).`); }
      if (concurrent.kind === "absent") return;
      claimed = await this.adoptOrphanClaim();
    }
    let raw: string;
    try {
      raw = (await this.readOwnerOnly(claimed))!;
      if (raw === undefined) throw new Error("Claimed legacy worker binding source disappeared before import.");
    } catch (error) { throw error; }
    const checksum = checksumOf(raw); let parsed: LegacyBindings;
    try { parsed = JSON.parse(raw) as LegacyBindings; this.validateLegacy(parsed, raw); } catch (error) {
      await this.quarantineLegacyFailure(database, key, checksum, error, claimed);
    }
    let committedChecksum!: string;
    try {
      // The backup is the recovery material for the upcoming durable record.
      // Persist it (and its directory entry) before the SQLite transaction can
      // make that record authoritative; a crash can now leave either no record
      // or a record with its exact bytes, never a record stranded without A.
      await this.createBackupExclusively(backup, raw, checksum);
      await this.legacyBackupFinalizationHook?.();
    } catch (error) {
      // A valid source must not be permanently classified as corrupt merely
      // because backup media, permissions, or a pre-existing backup is bad.
      // Restore only into an absent public pathname; otherwise retain the
      // claim for deterministic recovery without overwriting a replacement.
      await this.restoreClaimForRetry(claimed);
      throw error;
    }
    try {
      committedChecksum = await this.transaction(database, () => {
      const existing = database.prepare("SELECT checksum FROM migration_records WHERE migration_key=?").get(key) as Row | undefined;
      if (existing) return String(existing.checksum);
      if (database.prepare("SELECT 1 FROM migration_failures WHERE migration_key=?").get(key)) throw new Error("Legacy worker binding import is quarantined.");
      for (const binding of Object.values(parsed.bindings)) {
        run(database.prepare("INSERT INTO worker_session_bindings (entry_id, room_id, work_attempt_id, execution_generation_id, agent_session_id, credential_ref, api_url, room_cursor, last_sequence, last_observed_at_ms, binding_epoch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)"), binding.entry_id, binding.room_id, binding.work_attempt_id, binding.execution_generation_id, binding.agent_session_id, randomUUID(), new URL(binding.api_url).origin, binding.room_cursor, binding.last_sequence, binding.last_observed_at_ms, binding.updated_at);
        this.upsertWatermark(database, binding.entry_id, 1, binding.last_sequence, binding.last_observed_at_ms, binding.updated_at);
      }
      run(database.prepare("INSERT INTO migration_records (migration_key, checksum, imported_at) VALUES (?, ?, ?)"), key, checksum, new Date().toISOString());
      return checksum;
      });
    } catch (error) {
      await this.restoreClaimForRetry(claimed);
      throw error;
    }
    // The claimed inode is no longer needed once its exact backup and durable
    // record exist. A replacement at the public pathname was never touched.
    await unlink(claimed).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    await this.syncDirectory(dirname(claimed));
    if (committedChecksum === checksum) {
      await this.finishLegacyBackup(backup, checksum);
    } else {
      await this.finishLegacyBackup(backup, committedChecksum);
    }
  }
  private async quarantineLegacyFailure(database: DatabaseSync, key: string, checksum: string, error: unknown, claimedPath?: string): Promise<never> {
    const reason = error instanceof Error ? error.message : String(error);
    const quarantine = `${this.legacyJsonPath}.corrupt.${checksum.slice(0, 16)}`;
    await this.transaction(database, () => {
      if (!database.prepare("SELECT 1 FROM migration_failures WHERE migration_key=?").get(key)) {
        run(database.prepare("INSERT INTO migration_failures (migration_key, reason, failed_at, quarantined_path) VALUES (?, ?, ?, ?)"), key, reason, new Date().toISOString(), quarantine);
      }
    });
    const claimed = claimedPath ?? await this.captureAndRemoveLegacySource();
    if (claimed) await this.moveClaimedToQuarantine(claimed, quarantine, checksum.slice(0, 16));
    throw new Error(`Legacy worker binding import refused: ${reason}`);
  }
  private async finishLegacyBackup(backup: string, expectedChecksum: string): Promise<void> {
    const correctBackup = await this.verifyBackup(backup, expectedChecksum);
    if (!correctBackup) {
      // This is only legacy-v4 recovery. Claim first even here: a missing
      // backup must never be rebuilt from a public pathname that can turn A
      // into B between inspection and retirement.
      const evidence = await this.collectClaimedEvidence(true);
      let recovered: string | undefined;
      for (const path of evidence) {
        const raw = await this.readOwnerOnly(path);
        if (raw === undefined) continue;
        if (checksumOf(raw) === expectedChecksum && recovered === undefined) recovered = raw;
      }
      if (recovered === undefined) {
        await this.retireCommittedEvidence(evidence, expectedChecksum);
        throw new Error(`Legacy worker binding migration integrity error: migration record ${expectedChecksum} has no recoverable backup.`);
      }
      await this.createBackupExclusively(backup, recovered, expectedChecksum);
      const unexpected = await this.retireCommittedEvidence(evidence, expectedChecksum);
      if (unexpected.length) throw new Error(`Legacy worker binding migration integrity error: unexpected legacy evidence was quarantined at ${unexpected.join(", ")}.`);
    }

    // A post-record crash may leave one or more unique claim paths. Retire
    // exact duplicates and preserve every differing claim/public replacement.
    const unexpected = await this.retireCommittedEvidence(await this.collectClaimedEvidence(true), expectedChecksum);
    if (unexpected.length) throw new Error(`Legacy worker binding migration integrity error: unexpected legacy evidence was quarantined at ${unexpected.join(", ")}.`);
  }

  /** Returns false only when backup is genuinely absent. A wrong backup is
   * fatal: it must never be overwritten or silently accepted. */
  private async verifyBackup(backup: string, expectedChecksum: string): Promise<boolean> {
    let raw: string;
    try { raw = await readFile(backup, "utf8"); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await chmod(backup, 0o600);
    if (isRedactedLegacyBackup(raw, expectedChecksum)) return true;
    // Builds before the SQLite credential-custody hardening retained the
    // exact imported v1 JSON as their migration backup. Its checksum is the
    // value already committed in SQLite, so it is authoritative legacy
    // evidence—not tampering. Upgrade it atomically to the secret-free proof
    // format before allowing the daemon to continue.
    if (checksumOf(raw) === expectedChecksum) {
      await this.redactExactLegacyBackup(backup, raw, expectedChecksum);
      return true;
    }
    await this.chmodIfPresent(this.legacyJsonPath);
    throw new Error("Legacy worker binding migration integrity error: migrated backup does not match the committed migration record.");
  }

  private async redactExactLegacyBackup(backup: string, raw: string, expectedChecksum: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw) as LegacyBindings;
      this.validateLegacy(parsed, raw);
    } catch {
      throw new Error("Legacy worker binding migration integrity error: checksum-matching backup is not a valid legacy binding envelope.");
    }
    const temporary = `${backup}.redacting.${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(redactedLegacyBackup(raw, expectedChecksum), "utf8");
      await handle.sync();
    } finally { await handle?.close(); }
    try {
      // Re-read immediately before replacement. Concurrent legitimate
      // openers either still see the same exact legacy bytes or have already
      // installed the identical redacted proof; a differing artifact is
      // preserved and fails closed.
      const current = await this.readOwnerOnly(backup);
      if (current === undefined) throw new Error("Legacy worker binding migration integrity error: exact backup disappeared during redaction.");
      if (isRedactedLegacyBackup(current, expectedChecksum)) return;
      if (checksumOf(current) !== expectedChecksum) {
        throw new Error("Legacy worker binding migration integrity error: migrated backup changed during redaction.");
      }
      await rename(temporary, backup);
      await chmod(backup, 0o600);
      await this.syncDirectory(dirname(backup));
      const converted = await this.readOwnerOnly(backup);
      if (converted === undefined || !isRedactedLegacyBackup(converted, expectedChecksum)) {
        throw new Error("Legacy worker binding migration integrity error: redacted backup replacement did not converge.");
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  }

  private async createBackupExclusively(backup: string, raw: string, expectedChecksum: string): Promise<void> {
    if (checksumOf(raw) !== expectedChecksum) throw new Error("Legacy worker binding migration integrity error: captured backup bytes do not match the committed migration record.");
    const temporary = `${backup}.tmp.${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      // Recovery evidence proves the exact imported source without retaining
      // its bearer token in a second filesystem artifact.
      await handle.writeFile(redactedLegacyBackup(raw, expectedChecksum), "utf8");
      await handle.sync();
    } finally { await handle?.close(); }
    try {
      // link(2) is the no-replace atomic convergence primitive that rename(2)
      // is not: another opener can win, but it can never be overwritten.
      await link(temporary, backup);
      await this.syncDirectory(dirname(backup));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
    // Whether we won or converged with another opener, verify the final name
    // against the migration record before treating it as a backup.
    if (!await this.verifyBackup(backup, expectedChecksum)) throw new Error("Legacy worker binding migration integrity error: backup creation did not converge.");
  }

  private async readOwnerOnly(path: string): Promise<string | undefined> {
    try {
      await chmod(path, 0o600);
      const raw = await readFile(path, "utf8");
      await chmod(path, 0o600);
      return raw;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Atomically claims the current source. Once rename succeeds, every later
   * read, backup, and unlink addresses the unique claimed inode instead of a
   * pathname an external writer can replace. */
  private async captureAndRemoveLegacySource(): Promise<string | null> {
    const source = this.legacyJsonPath;
    const holding = `${source}.claimed.${randomUUID()}`;
    try { await rename(source, holding); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    await chmod(holding, 0o600);
    await this.syncDirectory(dirname(holding));
    return holding;
  }

  private async moveClaimedToQuarantine(claimed: string, quarantine: string, expectedChecksumPrefix?: string): Promise<void> {
    if (expectedChecksumPrefix) {
      const raw = await this.readOwnerOnly(claimed);
      if (raw === undefined) return;
      if (!checksumOf(raw).startsWith(expectedChecksumPrefix)) {
        await this.moveToUnexpectedQuarantine(claimed, checksumOf(raw));
        return;
      }
    }
    try {
      await link(claimed, quarantine);
      await chmod(quarantine, 0o600);
      await unlink(claimed);
      await this.syncDirectory(dirname(quarantine));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await chmod(quarantine, 0o600);
      const claimedRaw = await this.readOwnerOnly(claimed);
      const quarantineRaw = await this.readOwnerOnly(quarantine);
      if (claimedRaw === undefined) return;
      if (quarantineRaw === claimedRaw) {
        await unlink(claimed).catch((unlinkError: unknown) => { if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError; });
        await this.syncDirectory(dirname(claimed));
        return;
      }
      await this.moveToUnexpectedQuarantine(claimed, checksumOf(claimedRaw));
    }
  }

  private async reconcileFailedEvidence(quarantine: string): Promise<void> {
    const evidence = await this.collectClaimedEvidence(true);
    const expectedPrefix = /\.corrupt\.([0-9a-f]{16})$/.exec(quarantine)?.[1];
    for (const claimed of evidence) await this.moveClaimedToQuarantine(claimed, quarantine, expectedPrefix);
    await chmod(quarantine, 0o600).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }

  private async collectClaimedEvidence(includePublic: boolean): Promise<string[]> {
    const state = await this.legacySourceState();
    const evidence = [...state.claims];
    if (includePublic && state.publicPresent) {
      const claimed = await this.captureAndRemoveLegacySource();
      if (claimed) evidence.push(claimed);
    }
    return evidence;
  }

  private async retireCommittedEvidence(evidence: string[], expectedChecksum: string): Promise<string[]> {
    const unexpected: string[] = [];
    for (const path of evidence) {
      const raw = await this.readOwnerOnly(path);
      if (raw === undefined) continue;
      if (checksumOf(raw) === expectedChecksum) {
        await unlink(path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
        await this.syncDirectory(dirname(path));
      } else {
        unexpected.push(await this.moveToUnexpectedQuarantine(path, checksumOf(raw)));
      }
    }
    return unexpected;
  }

  private async legacySourceState(): Promise<{ publicPresent: boolean; claims: string[] }> {
    const directory = dirname(this.legacyJsonPath);
    const sourceName = basename(this.legacyJsonPath);
    const prefix = `${sourceName}.claimed.`;
    const names = await readdir(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw error;
    });
    return {
      publicPresent: names.includes(sourceName),
      claims: names.filter((name) => name.startsWith(prefix)).sort().map((name) => `${directory}/${name}`),
    };
  }

  private async restoreClaimForRetry(claimed: string): Promise<void> {
    try {
      // link(2) is no-replace: a concurrent B remains at source and A stays
      // claimed for later recovery instead of being silently overwritten.
      await link(claimed, this.legacyJsonPath);
      await chmod(this.legacyJsonPath, 0o600);
      await unlink(claimed);
      await this.syncDirectory(dirname(claimed));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async moveToUnexpectedQuarantine(path: string, checksum: string): Promise<string> {
    const prefix = `${this.legacyJsonPath}.unexpected.${checksum.slice(0, 16)}`;
    for (;;) {
      const destination = `${prefix}.${randomUUID()}`;
      try {
        // hard-link + unlink is an exclusive move: no pre-existing artifact
        // is overwritten, even under simultaneous openers.
        await link(path, destination);
        await chmod(destination, 0o600);
        await unlink(path);
        await this.syncDirectory(dirname(destination));
        return destination;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
  }

  private async chmodIfPresent(path: string): Promise<void> {
    await chmod(path, 0o600).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async waitForConcurrentClaim(database: DatabaseSync, key: string): Promise<
    | { kind: "committed"; checksum: string }
    | { kind: "failed"; reason: string; quarantine: string }
    | { kind: "orphan" }
    | { kind: "absent" }
  > {
    const prefix = `${basename(this.legacyJsonPath)}.claimed.`;
    let seenClaim = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const names = await readdir(dirname(this.legacyJsonPath)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
        throw error;
      });
      seenClaim ||= names.some((name) => name.startsWith(prefix));
      const record = database.prepare("SELECT checksum FROM migration_records WHERE migration_key=?").get(key) as Row | undefined;
      if (record) return { kind: "committed", checksum: String(record.checksum) };
      const failed = database.prepare("SELECT reason, quarantined_path FROM migration_failures WHERE migration_key=?").get(key) as Row | undefined;
      if (failed) return { kind: "failed", reason: String(failed.reason), quarantine: String(failed.quarantined_path) };
      if (!seenClaim) return { kind: "absent" };
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const failed = database.prepare("SELECT reason, quarantined_path FROM migration_failures WHERE migration_key=?").get(key) as Row | undefined;
    if (failed) return { kind: "failed", reason: String(failed.reason), quarantine: String(failed.quarantined_path) };
    return { kind: "orphan" };
  }
  private async adoptOrphanClaim(): Promise<string> {
    const state = await this.legacySourceState();
    if (state.publicPresent || state.claims.length !== 1) throw new Error(`Legacy worker binding migration has ambiguous orphan evidence (${state.claims.length} claim(s), public source ${state.publicPresent ? "present" : "absent"}).`);
    const claimed = state.claims[0]!;
    const adopted = `${this.legacyJsonPath}.claimed.recovered.${randomUUID()}`;
    try { await rename(claimed, adopted); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Legacy worker binding orphan claim disappeared during recovery."); throw error; }
    await chmod(adopted, 0o600);
    await this.syncDirectory(dirname(adopted));
    return adopted;
  }
  private validateLegacy(value: LegacyBindings, raw: string): void { assertNoDuplicateJsonKeys(raw); if (!value || value.version !== 1 || !value.bindings || Array.isArray(value.bindings)) throw new Error("invalid v1 envelope"); const seen = new Set<string>(); for (const [key, binding] of Object.entries(value.bindings)) { if (key !== binding.entry_id || seen.has(key)) throw new Error("duplicate or mismatched entry id"); seen.add(key); this.validate(binding); if (!Number.isSafeInteger(binding.last_sequence) || binding.last_sequence < 0 || !Number.isSafeInteger(binding.last_observed_at_ms) || binding.last_observed_at_ms < 0 || !Number.isFinite(Date.parse(binding.updated_at)) || (binding.room_cursor !== null && typeof binding.room_cursor !== "string")) throw new Error(`invalid legacy binding ${key}`); } }
}

function rowToBinding(row: Row): WorkerSessionBinding { return { entry_id: String(row.entry_id), room_id: String(row.room_id), work_attempt_id: String(row.work_attempt_id), execution_generation_id: String(row.execution_generation_id), agent_session_id: String(row.agent_session_id), credential_ref: String(row.credential_ref), api_url: String(row.api_url), room_cursor: row.room_cursor === null ? null : String(row.room_cursor), last_sequence: Number(row.last_sequence), last_observed_at_ms: Number(row.last_observed_at_ms), updated_at: String(row.updated_at) }; }

function redactedLegacyBackup(raw: string, checksum: string): string {
  const parsed = JSON.parse(raw) as LegacyBindings;
  const bindings = Object.values(parsed.bindings).map((binding) => ({
    entry_id: binding.entry_id, room_id: binding.room_id, work_attempt_id: binding.work_attempt_id,
    execution_generation_id: binding.execution_generation_id, agent_session_id: binding.agent_session_id,
    api_url: new URL(binding.api_url).origin, room_cursor: binding.room_cursor,
    last_sequence: binding.last_sequence, last_observed_at_ms: binding.last_observed_at_ms, updated_at: binding.updated_at,
  }));
  return `${JSON.stringify({ version: 1, source_checksum: checksum, bindings })}\n`;
}

function isRedactedLegacyBackup(raw: string, checksum: string): boolean {
  try {
    const value = JSON.parse(raw) as { version?: unknown; source_checksum?: unknown; bindings?: unknown };
    return value.version === 1 && value.source_checksum === checksum && Array.isArray(value.bindings)
      && !/agent_session_token|session_token/.test(raw);
  } catch { return false; }
}
function parseRoomMessageNumber(value: string | null): number | null { const match = value && /^msg_(\d+)$/.exec(value); const parsed = match ? Number(match[1]) : NaN; return Number.isSafeInteger(parsed) ? parsed : null; }
function defaultDatabasePath(legacyJsonPath: string): string {
  // SupervisorDaemon always injects the canonical path. Standalone tooling
  // follows the documented daemon-state filename rather than inventing JSON.
  return `${dirname(legacyJsonPath)}/daemon-state.sqlite`;
}

/** Parse just enough JSON structure to reject duplicate decoded object keys
 * before JSON.parse can collapse them (including escaped spellings). */
function assertNoDuplicateJsonKeys(raw: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(raw[index] ?? "")) index += 1; };
  const string = (): string => { const start = index; if (raw[index++] !== '"') throw new Error("invalid JSON string"); let escaped = false; while (index < raw.length) { const char = raw[index++]; if (escaped) { escaped = false; continue; } if (char === "\\") { escaped = true; continue; } if (char === '"') return JSON.parse(raw.slice(start, index)) as string; } throw new Error("unterminated JSON string"); };
  const value = (): void => { whitespace(); const token = raw[index]; if (token === "{") { index += 1; const keys = new Set<string>(); whitespace(); if (raw[index] === "}") { index += 1; return; } while (true) { whitespace(); const key = string(); if (keys.has(key)) throw new Error(`duplicate JSON key ${key}`); keys.add(key); whitespace(); if (raw[index++] !== ":") throw new Error("invalid JSON object"); value(); whitespace(); const separator = raw[index++]; if (separator === "}") return; if (separator !== ",") throw new Error("invalid JSON object"); } } if (token === "[") { index += 1; whitespace(); if (raw[index] === "]") { index += 1; return; } while (true) { value(); whitespace(); const separator = raw[index++]; if (separator === "]") return; if (separator !== ",") throw new Error("invalid JSON array"); } } if (token === '"') { string(); return; } const start = index; while (index < raw.length && !/[\s,}\]]/.test(raw[index]!)) index += 1; JSON.parse(raw.slice(start, index)); };
  value(); whitespace(); if (index !== raw.length) throw new Error("trailing JSON content");
}
