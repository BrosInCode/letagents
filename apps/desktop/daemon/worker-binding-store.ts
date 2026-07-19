import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { DaemonStateSchema, openDaemonStateDatabase } from "./daemon-state-database.js";

export interface WorkerSessionBinding {
  entry_id: string;
  room_id: string;
  work_attempt_id: string;
  execution_generation_id: string;
  agent_session_id: string;
  agent_session_token: string;
  api_url: string;
  room_cursor: string | null;
  last_sequence: number;
  last_observed_at_ms: number;
  updated_at: string;
}

type WorkerSessionBindingInput = Omit<WorkerSessionBinding, "room_cursor" | "last_sequence" | "last_observed_at_ms" | "updated_at">;
type Row = Record<string, unknown>;
type Reservation = { reservationId: string; binding: WorkerSessionBinding; bindingEpoch: number; sequence: number; observedAt: string; observedAtMs: number };
type LegacyBindings = { version: 1; bindings: Record<string, WorkerSessionBinding> };
function run(statement: StatementSync, ...values: unknown[]): void { statement.run(...values as never[]); }

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

  constructor(
    readonly legacyJsonPath: string,
    private readonly commitFence?: (commit: () => Promise<void>) => Promise<void>,
    private readonly databasePath = defaultDatabasePath(legacyJsonPath),
  ) {}

  async close(): Promise<void> {
    this.closed = true;
    // Let an already-reserved local DB operation finish; transport is never
    // part of this queue, so handoff does not wait on HTTP.
    await this.initializing?.catch(() => undefined);
    await this.mutations.catch(() => undefined);
    this.database?.close();
    this.database = null;
  }

  async get(entryId: string): Promise<WorkerSessionBinding | null> {
    return this.withMutation(async (database) => this.read(database, entryId));
  }
  async list(): Promise<WorkerSessionBinding[]> {
    return this.withMutation(async (database) => (database.prepare("SELECT * FROM worker_session_bindings ORDER BY entry_id").all() as Row[]).map(rowToBinding));
  }

  async bind(input: WorkerSessionBindingInput): Promise<WorkerSessionBinding> {
    this.validate(input);
    // Test/fence seam must remain outside the SQLite transaction: a stalled
    // pre-commit caller must not lock unrelated manifest work during handoff.
    await this.write(input);
    return this.withMutation(async (database) => this.transaction(database, () => {
      const prior = this.read(database, input.entry_id);
      const sameSession = prior?.agent_session_id === input.agent_session_id;
      const now = new Date().toISOString();
      const epoch = (database.prepare("SELECT binding_epoch FROM worker_session_bindings WHERE entry_id = ?").get(input.entry_id) as Row | undefined)?.binding_epoch;
      const binding: WorkerSessionBinding = {
        ...input, api_url: new URL(input.api_url).origin,
        room_cursor: sameSession ? prior!.room_cursor : null,
        // Credentials may rotate, but the native API's sequence authority is
        // per durable agent entry. Never reuse a journal/API sequence.
        last_sequence: prior?.last_sequence ?? 0,
        last_observed_at_ms: prior?.last_observed_at_ms ?? 0,
        updated_at: now,
      };
      // Any formal bind/rebind establishes a new authority epoch. This makes
      // delayed responses unable to revoke or advance replacement credentials.
      run(database.prepare(`INSERT INTO worker_session_bindings
        (entry_id, room_id, work_attempt_id, execution_generation_id, agent_session_id, agent_session_token, api_url, room_cursor, last_sequence, last_observed_at_ms, binding_epoch, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET room_id=excluded.room_id, work_attempt_id=excluded.work_attempt_id,
          execution_generation_id=excluded.execution_generation_id, agent_session_id=excluded.agent_session_id,
          agent_session_token=excluded.agent_session_token, api_url=excluded.api_url, room_cursor=excluded.room_cursor,
          last_sequence=excluded.last_sequence, last_observed_at_ms=excluded.last_observed_at_ms,
          binding_epoch=excluded.binding_epoch, updated_at=excluded.updated_at`),
        binding.entry_id, binding.room_id, binding.work_attempt_id, binding.execution_generation_id, binding.agent_session_id,
        binding.agent_session_token, binding.api_url, binding.room_cursor, binding.last_sequence, binding.last_observed_at_ms,
        Number(epoch ?? 0) + 1, binding.updated_at);
      return binding;
    }));
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
    return this.withMutation(async (database) => this.transaction(database, () => {
      const current = this.read(database, entryId);
      if (!current || (expectedSessionId && current.agent_session_id !== expectedSessionId) || (expectedExecutionGenerationId && current.execution_generation_id !== expectedExecutionGenerationId)) return false;
      run(database.prepare("DELETE FROM worker_session_bindings WHERE entry_id = ?"), entryId);
      return true;
    }));
  }

  private async reservePublication(entryId: string, observedAtMs: number): Promise<Reservation | null> {
    return this.withMutation(async (database) => this.transaction(database, () => {
      const prior = this.read(database, entryId); if (!prior) return null;
      const row = database.prepare("SELECT binding_epoch FROM worker_session_bindings WHERE entry_id = ?").get(entryId) as Row;
      const now = Date.now(); const candidate = Number.isFinite(observedAtMs) ? Math.min(Math.floor(observedAtMs), now) : now;
      const effective = Math.max(candidate, prior.last_observed_at_ms + 1); const sequence = Math.max(prior.last_sequence + 1, effective); const observedAt = new Date(effective).toISOString(); const id = randomUUID();
      run(database.prepare("UPDATE worker_session_bindings SET last_sequence=?, last_observed_at_ms=?, updated_at=? WHERE entry_id=? AND binding_epoch=?"), sequence, effective, observedAt, entryId, Number(row.binding_epoch));
      run(database.prepare("INSERT INTO worker_binding_publications (reservation_id, entry_id, binding_epoch, execution_generation_id, agent_session_id, sequence, observed_at, observed_at_ms, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)"), id, entryId, Number(row.binding_epoch), prior.execution_generation_id, prior.agent_session_id, sequence, observedAt, effective, observedAt);
      return { reservationId: id, binding: { ...prior, last_sequence: sequence, last_observed_at_ms: effective, updated_at: observedAt }, bindingEpoch: Number(row.binding_epoch), sequence, observedAt, observedAtMs: effective };
    }));
  }

  private async finalizePublication(reservation: Reservation, outcome: "accepted" | "rejected" | "transport_error"): Promise<void> {
    await this.withMutation(async (database) => this.transaction(database, () => {
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
        if (latest?.reservation_id === reservation.reservationId && Number(latest.sequence) === reservation.sequence) run(database.prepare("DELETE FROM worker_session_bindings WHERE entry_id=? AND binding_epoch=? AND execution_generation_id=? AND agent_session_id=?"), reservation.binding.entry_id, reservation.bindingEpoch, reservation.binding.execution_generation_id, reservation.binding.agent_session_id);
      }
    }));
  }

  private async reserveVerification(input: { entryId: string; roomId: string; workAttemptId: string; fromExecutionGenerationId: string; toExecutionGenerationId: string; agentSessionId: string }): Promise<{ kind: "idempotent"; binding: WorkerSessionBinding } | { kind: "reserved"; reservation: Reservation }> {
    return this.withMutation(async (database) => this.transaction(database, () => {
      const prior = this.read(database, input.entryId);
      if (!prior || prior.room_id !== input.roomId || prior.work_attempt_id !== input.workAttemptId || prior.agent_session_id !== input.agentSessionId) throw new Error("Worker binding generation rollover does not match the durable worker identity.");
      if (prior.execution_generation_id === input.toExecutionGenerationId) return { kind: "idempotent", binding: prior };
      if (prior.execution_generation_id !== input.fromExecutionGenerationId) throw new Error("Worker binding generation rollover does not match its terminal predecessor.");
      const epoch = Number((database.prepare("SELECT binding_epoch FROM worker_session_bindings WHERE entry_id=?").get(input.entryId) as Row).binding_epoch);
      const effective = Math.max(Date.now(), prior.last_observed_at_ms + 1); const sequence = Math.max(prior.last_sequence + 1, effective); const observedAt = new Date(effective).toISOString(); const id = randomUUID();
      run(database.prepare("UPDATE worker_session_bindings SET last_sequence=?, last_observed_at_ms=?, updated_at=? WHERE entry_id=? AND binding_epoch=?"), sequence, effective, observedAt, input.entryId, epoch);
      run(database.prepare("INSERT INTO worker_generation_verifications (reservation_id, entry_id, binding_epoch, from_execution_generation_id, to_execution_generation_id, agent_session_id, sequence, observed_at, observed_at_ms, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)"), id, input.entryId, epoch, input.fromExecutionGenerationId, input.toExecutionGenerationId, input.agentSessionId, sequence, observedAt, effective, observedAt);
      return { kind: "reserved", reservation: { reservationId: id, binding: { ...prior, last_sequence: sequence, last_observed_at_ms: effective, updated_at: observedAt }, bindingEpoch: epoch, sequence, observedAt, observedAtMs: effective } };
    }));
  }

  private async finalizeVerification(reservation: Reservation, input: { entryId: string; fromExecutionGenerationId: string; toExecutionGenerationId: string; agentSessionId: string }, accepted: boolean): Promise<{ binding: WorkerSessionBinding; advanced: boolean; accepted: boolean }> {
    return this.withMutation(async (database) => this.transaction(database, () => {
      const current = this.read(database, input.entryId); const now = new Date().toISOString();
      if (!accepted) { run(database.prepare("UPDATE worker_generation_verifications SET state='failed', finalized_at=? WHERE reservation_id=? AND state='reserved'"), now, reservation.reservationId); return { binding: current ?? reservation.binding, advanced: false, accepted: false }; }
      const epoch = current ? Number((database.prepare("SELECT binding_epoch FROM worker_session_bindings WHERE entry_id=?").get(input.entryId) as Row).binding_epoch) : -1;
      if (current && epoch === reservation.bindingEpoch && current.execution_generation_id === input.fromExecutionGenerationId && current.agent_session_id === input.agentSessionId) {
        run(database.prepare("UPDATE worker_session_bindings SET execution_generation_id=?, updated_at=? WHERE entry_id=? AND binding_epoch=? AND execution_generation_id=? AND agent_session_id=?"), input.toExecutionGenerationId, now, input.entryId, epoch, input.fromExecutionGenerationId, input.agentSessionId);
        run(database.prepare("UPDATE worker_generation_verifications SET state='accepted', finalized_at=? WHERE reservation_id=? AND state='reserved'"), now, reservation.reservationId);
        return { binding: this.read(database, input.entryId)!, advanced: true, accepted: true };
      }
      run(database.prepare("UPDATE worker_generation_verifications SET state='lost_race', finalized_at=? WHERE reservation_id=? AND state='reserved'"), now, reservation.reservationId);
      if (current?.execution_generation_id === input.toExecutionGenerationId
        && current.agent_session_id === input.agentSessionId
        && current.room_id === reservation.binding.room_id
        && current.work_attempt_id === reservation.binding.work_attempt_id) return { binding: current, advanced: false, accepted: true };
      return { binding: current ?? reservation.binding, advanced: false, accepted: false };
    }));
  }

  private match(database: DatabaseSync, entryId: string, sessionId: string, generationId: string): WorkerSessionBinding {
    const binding = this.read(database, entryId);
    if (!binding || binding.agent_session_id !== sessionId || binding.execution_generation_id !== generationId) throw new Error("Worker cursor checkpoint does not match the active supervised binding.");
    return binding;
  }
  private async write(_value: unknown): Promise<void> {}
  private read(database: DatabaseSync, entryId: string): WorkerSessionBinding | null { const row = database.prepare("SELECT * FROM worker_session_bindings WHERE entry_id=?").get(entryId) as Row | undefined; return row ? rowToBinding(row) : null; }
  private validate(input: WorkerSessionBindingInput): void { for (const field of ["entry_id", "room_id", "work_attempt_id", "execution_generation_id", "agent_session_id", "agent_session_token", "api_url"] as const) if (!input[field]?.trim()) throw new Error(`Worker binding ${field} is required.`); const url = new URL(input.api_url); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Worker binding api_url must use HTTP or HTTPS."); }
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
    const prior = database.prepare("SELECT 1 FROM migration_records WHERE migration_key=?").get(key);
    if (prior) { await this.finishLegacyBackup(backup); return; }
    const failed = database.prepare("SELECT reason, quarantined_path FROM migration_failures WHERE migration_key=?").get(key) as Row | undefined;
    if (failed) {
      // The durable failure is authoritative; retry only the filesystem
      // housekeeping left behind by a crash/permission error before failing
      // closed again.
      const quarantine = String(failed.quarantined_path);
      try { await rename(this.legacyJsonPath, quarantine); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await chmod(quarantine, 0o600).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      throw new Error(`Legacy worker binding import was previously quarantined: ${String(failed.reason)} (${quarantine}).`);
    }
    let raw: string;
    try { raw = await readFile(this.legacyJsonPath, "utf8"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const checksum = createHash("sha256").update(raw).digest("hex"); let parsed: LegacyBindings;
    try { parsed = JSON.parse(raw) as LegacyBindings; this.validateLegacy(parsed, raw); } catch (error) {
      await this.quarantineLegacyFailure(database, key, checksum, error);
    }
    try { await this.transaction(database, () => {
      if (database.prepare("SELECT 1 FROM migration_records WHERE migration_key=?").get(key)) return;
      if (database.prepare("SELECT 1 FROM migration_failures WHERE migration_key=?").get(key)) throw new Error("Legacy worker binding import is quarantined.");
      const current = readFileSync(this.legacyJsonPath, "utf8");
      if (createHash("sha256").update(current).digest("hex") !== checksum) throw new Error("Legacy worker binding source changed during import.");
      for (const binding of Object.values(parsed.bindings)) {
        run(database.prepare("INSERT INTO worker_session_bindings (entry_id, room_id, work_attempt_id, execution_generation_id, agent_session_id, agent_session_token, api_url, room_cursor, last_sequence, last_observed_at_ms, binding_epoch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)"), binding.entry_id, binding.room_id, binding.work_attempt_id, binding.execution_generation_id, binding.agent_session_id, binding.agent_session_token, new URL(binding.api_url).origin, binding.room_cursor, binding.last_sequence, binding.last_observed_at_ms, binding.updated_at);
      }
      run(database.prepare("INSERT INTO migration_records (migration_key, checksum, imported_at) VALUES (?, ?, ?)"), key, checksum, new Date().toISOString());
    }); } catch (error) { await this.quarantineLegacyFailure(database, key, checksum, error); }
    // Rename only after the committed migration record. Failure is safe and
    // retryable on the next open; the record prevents a second import.
    await this.finishLegacyBackup(backup);
  }
  private async quarantineLegacyFailure(database: DatabaseSync, key: string, checksum: string, error: unknown): Promise<never> {
    const reason = error instanceof Error ? error.message : String(error);
    const quarantine = `${this.legacyJsonPath}.corrupt.${checksum.slice(0, 16)}`;
    await this.transaction(database, () => {
      if (!database.prepare("SELECT 1 FROM migration_failures WHERE migration_key=?").get(key)) {
        run(database.prepare("INSERT INTO migration_failures (migration_key, reason, failed_at, quarantined_path) VALUES (?, ?, ?, ?)"), key, reason, new Date().toISOString(), quarantine);
      }
    });
    try { await rename(this.legacyJsonPath, quarantine); await chmod(quarantine, 0o600); } catch (renameError: unknown) { if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError; }
    throw new Error(`Legacy worker binding import refused: ${reason}`);
  }
  private async finishLegacyBackup(backup: string): Promise<void> {
    // Backup housekeeping is non-authoritative: the committed migration record
    // is the source of truth. Another opener may win the rename between these
    // calls, so ENOENT/EEXIST are successful convergence, not startup errors.
    try { await stat(this.legacyJsonPath); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await chmod(backup, 0o600).catch((chmodError: unknown) => { if ((chmodError as NodeJS.ErrnoException).code !== "ENOENT") throw chmodError; }); return; } throw error; }
    try { await stat(backup); await chmod(backup, 0o600); return; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(this.legacyJsonPath, backup); }
    catch (error: unknown) { if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    await chmod(backup, 0o600).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
  private validateLegacy(value: LegacyBindings, raw: string): void { assertNoDuplicateJsonKeys(raw); if (!value || value.version !== 1 || !value.bindings || Array.isArray(value.bindings)) throw new Error("invalid v1 envelope"); const seen = new Set<string>(); for (const [key, binding] of Object.entries(value.bindings)) { if (key !== binding.entry_id || seen.has(key)) throw new Error("duplicate or mismatched entry id"); seen.add(key); this.validate(binding); if (!Number.isSafeInteger(binding.last_sequence) || binding.last_sequence < 0 || !Number.isSafeInteger(binding.last_observed_at_ms) || binding.last_observed_at_ms < 0 || !Number.isFinite(Date.parse(binding.updated_at)) || (binding.room_cursor !== null && typeof binding.room_cursor !== "string")) throw new Error(`invalid legacy binding ${key}`); } }
}

function rowToBinding(row: Row): WorkerSessionBinding { return { entry_id: String(row.entry_id), room_id: String(row.room_id), work_attempt_id: String(row.work_attempt_id), execution_generation_id: String(row.execution_generation_id), agent_session_id: String(row.agent_session_id), agent_session_token: String(row.agent_session_token), api_url: String(row.api_url), room_cursor: row.room_cursor === null ? null : String(row.room_cursor), last_sequence: Number(row.last_sequence), last_observed_at_ms: Number(row.last_observed_at_ms), updated_at: String(row.updated_at) }; }
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
