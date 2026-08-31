import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { RetainedExecutionDetail } from "../shared/execution-protocol.js";

import { combineSideEffects, executionIdentity as id, ExecutionProtocolError, nativeTurnIdentity, parseExecutionFact, type ExecutionFact, type SideEffectState } from "./execution-protocol.js";
import { emptyExecutionProjection, reduceExecutionFact, type ExecutionProjection } from "./execution-reducer.js";

type Row = Record<string, string | number | null>;
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runtimeInput = z.strictObject({
  agentId: id, executionGenerationId: id, runtimeGenerationId: id,
  provider: z.enum(["codex", "claude-code", "cursor", "open-model"]), configRevision: time.min(1), createdAtMs: time,
});
const attemptInput = z.strictObject({ agentId: id, roomId: id, sourceMessageId: id, executionGenerationId: id, workspaceId: id, createdAtMs: time });
const turnInput = z.strictObject({
  ...nativeTurnIdentity.shape, attemptId: id, agentId: id, roomId: id, executionGenerationId: id, runtimeGenerationId: id, createdAtMs: time,
});
const observerInput = z.strictObject({
  agentId: id, subjectRuntimeGenerationId: id, observerRuntimeGenerationId: id, daemonGenerationId: id,
  sourceId: id, expectedEpoch: time, boundAtMs: time, recovery: nativeTurnIdentity.optional(),
});
export type ShadowObserver = Readonly<{
  agentId: string; runtimeGenerationId: string; executionGenerationId: string;
  observerRuntimeGenerationId: string; observerExecutionGenerationId: string;
  daemonGenerationId: string; epoch: number; recoveryTurnId: string | null;
  sourceId: string;
  /** Durable cursor snapshot at admission; skip this source's committed replay prefix. */
  lastSourceSequence: number; maxObservedSequence: number;
}>;
export type ShadowIngestion =
  | { status: "accepted" | "duplicate"; journalSequence: number; gapPending: boolean }
  | { status: "gap"; expectedSourceSequence: number; observedSourceSequence: number }
  | { status: "retention_limit"; limit: "facts" | "bytes"; expectedSourceSequence: number; observedSourceSequence: number };
type RuntimeProjection = { projection: ExecutionProjection; unverifiedFacts: number; lastJournalSequence: number };
type RetainedBudget = { facts: number; bytes: number };
// Count nested entries, not just runtimes: one long-lived runtime can have many
// turns and operations. Every retained identity is protocol-bounded to 512 chars.
const MAX_CACHED_RUNTIMES = 16;
const MAX_CACHED_ENTRIES = 4096;
const MAX_CACHED_AGENT_BUDGETS = 16;
const MAX_RETAINED_FACTS_PER_AGENT = 10_000;
const MAX_RETAINED_BYTES_PER_AGENT = 50 * 1024 * 1024;
// A logical retention budget: stored TEXT bytes plus a conservative fixed
// allowance for each fact's scalar fields and bookkeeping. This is neither
// provider output/wire bytes nor the physical shared SQLite/index/WAL size.
const FACT_BOOKKEEPING_BYTES = 256;
const FACT_TEXT_COLUMNS = ["fact_id", "agent_id", "execution_generation_id", "runtime_generation_id", "native_event_id",
  "turn_id", "execution_id", "domain", "kind", "state", "operation", "outcome", "side_effects", "turn_outcome", "control_evidence"] as const;
const FACT_BYTE_COST_SQL = `${FACT_BOOKKEEPING_BYTES}+${FACT_TEXT_COLUMNS.map((column) => `length(CAST(COALESCE(${column},'') AS BLOB))`).join("+")}`;

function factBytes(row: Row): number {
  return FACT_BOOKKEEPING_BYTES + FACT_TEXT_COLUMNS.reduce((bytes, column) => bytes + Buffer.byteLength(String(row[column] ?? ""), "utf8"), 0);
}
function exceededBudget(budget: RetainedBudget): "facts" | "bytes" | null {
  return budget.facts > MAX_RETAINED_FACTS_PER_AGENT ? "facts" : budget.bytes > MAX_RETAINED_BYTES_PER_AGENT ? "bytes" : null;
}

function validated<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ExecutionProtocolError("invalid_fact");
  return result.data;
}

function nativeEventKey(fact: ExecutionFact): string | null {
  return fact.nativeEventId === undefined ? null : JSON.stringify([
    fact.agentId, fact.runtimeGenerationId, "turnId" in fact ? fact.turnId : null,
    "executionId" in fact ? fact.executionId : null, fact.domain, fact.kind, fact.nativeEventId,
  ]);
}
function semanticFact(fact: ExecutionFact): string {
  const { factId: _id, observerEpoch: _epoch, sourceSequence: _sequence, observedAtMs: _time, ...semantic } = fact;
  return JSON.stringify(semantic);
}
function unverifiedHistoricalFact(row: Row): boolean {
  return (row.domain === "turn" && row.state === "terminal" && row.turn_outcome === null)
    || ((row.domain === "runtime" && row.state === "exited" || row.domain === "control" && row.state === "lost") && row.control_evidence === null);
}

/** Shared structural identity; neither this recipe nor these rows grant execution authority. */
export function executionStorageIdentity(kind: string, ...identity: string[]): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Caller owns the transaction. Preserve existing projections, including lagging terminal state. */
export function materializeExecutionIdentity(database: DatabaseSync, value: {
  runtime: z.input<typeof runtimeInput>; message: z.input<typeof attemptInput>;
  turn: Omit<z.input<typeof turnInput>, "attemptId">;
}): void {
  const runtime = validated(runtimeInput, value.runtime);
  const message = validated(attemptInput, value.message);
  const turn = validated(turnInput.omit({ attemptId: true }), value.turn);
  if (!database.isTransaction || runtime.agentId !== message.agentId || runtime.agentId !== turn.agentId
    || runtime.executionGenerationId !== message.executionGenerationId || runtime.executionGenerationId !== turn.executionGenerationId
    || runtime.runtimeGenerationId !== turn.runtimeGenerationId || message.roomId !== turn.roomId) {
    throw new ExecutionProtocolError("identity_mismatch");
  }
  materializeRuntime(database, runtime);
  const attemptId = materializeMessage(database, message);
  materializeTurn(database, { ...turn, attemptId });
}

function exactRow(database: DatabaseSync, table: string, key: string, value: string,
  fields: Record<string, SQLInputValue>): boolean {
  const row = database.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(value);
  if (!row) return false;
  if (Object.entries(fields).some(([column, expected]) => row[column] !== expected)) throw new ExecutionProtocolError("identity_mismatch");
  return true;
}
function insertIdentity(database: DatabaseSync, table: string, fields: Record<string, SQLInputValue>): void {
  database.prepare(`INSERT INTO ${table}(${Object.keys(fields).join(",")}) VALUES(${Object.keys(fields).map(() => "?").join(",")})`)
    .run(...Object.values(fields));
}
function materializeRuntime(database: DatabaseSync, input: z.output<typeof runtimeInput>): void {
  if (!exactRow(database, "execution_generations", "execution_generation_id", input.executionGenerationId, { agent_id: input.agentId })) {
    insertIdentity(database, "execution_generations", { execution_generation_id: input.executionGenerationId, agent_id: input.agentId, created_at_ms: input.createdAtMs });
  }
  const fields = { runtime_generation_id: input.runtimeGenerationId, execution_generation_id: input.executionGenerationId,
    agent_id: input.agentId, provider: input.provider, config_revision: input.configRevision };
  if (!exactRow(database, "execution_runtime_generations", "runtime_generation_id", input.runtimeGenerationId, fields)) {
    insertIdentity(database, "execution_runtime_generations", { ...fields, authority_mode: "typed_shadow", runtime_state: "starting",
      control_state: "connecting", continuation_state: "available", created_at_ms: input.createdAtMs });
  }
}
function materializeMessage(database: DatabaseSync, input: z.output<typeof attemptInput>): string {
  const attempt = database.prepare("SELECT attempt_id FROM execution_message_attempts WHERE agent_id=? AND room_id=? AND source_message_id=?")
    .get(input.agentId, input.roomId, input.sourceMessageId);
  const attemptId = attempt ? String(attempt.attempt_id) : randomUUID();
  if (!attempt) insertIdentity(database, "execution_message_attempts", { attempt_id: attemptId, agent_id: input.agentId,
    room_id: input.roomId, source_message_id: input.sourceMessageId, state: "active", created_at_ms: input.createdAtMs });
  const bound = database.prepare("SELECT workspace_id FROM execution_attempt_generations WHERE attempt_id=? AND execution_generation_id=?")
    .get(attemptId, input.executionGenerationId);
  if (bound && bound.workspace_id !== input.workspaceId) throw new ExecutionProtocolError("identity_mismatch");
  if (!bound) insertIdentity(database, "execution_attempt_generations", { attempt_id: attemptId, agent_id: input.agentId,
    room_id: input.roomId, execution_generation_id: input.executionGenerationId, workspace_id: input.workspaceId, created_at_ms: input.createdAtMs });
  return attemptId;
}
function materializeTurn(database: DatabaseSync, input: z.output<typeof turnInput>): void {
  const fields = { turn_id: input.turnId, attempt_id: input.attemptId, agent_id: input.agentId, room_id: input.roomId,
    execution_generation_id: input.executionGenerationId, runtime_generation_id: input.runtimeGenerationId,
    provider_continuation_id: input.providerContinuationId, provider_turn_id: input.providerTurnId };
  if (!exactRow(database, "execution_turns", "turn_id", input.turnId, fields)) {
    insertIdentity(database, "execution_turns", { ...fields, state: "none", side_effects: "none", created_at_ms: input.createdAtMs });
  }
}

/**
 * Structural shadow journal only; lifecycle and delivery authority stay separate.
 * This class owns neither the connection nor provider/delivery authority. Its
 * writes are restricted to execution_* tables; no handles for effects exist.
 */
export class ExecutionShadowStore {
  private readonly observers = new WeakSet<ShadowObserver>();
  private readonly projections = new Map<string, { value: RuntimeProjection; weight: number }>();
  private readonly budgets = new Map<string, RetainedBudget>();
  private projectionWeight = 0;
  private projectionStamp: string | null = null;
  constructor(private readonly database: DatabaseSync) {}

  private transaction<T>(body: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.synchronizeCaches();
      const result = body();
      // Own metadata/cursor writes do not invalidate fact budgets or replay.
      // Capture before COMMIT; an external commit afterwards must invalidate us.
      const stamp = this.databaseStamp();
      this.database.exec("COMMIT");
      this.projectionStamp = stamp;
      return result;
    }
    catch (error) { this.clearProjections(); this.database.exec("ROLLBACK"); throw error; }
  }

  private databaseStamp(): string {
    // data_version detects other connections; total_changes also detects a
    // second store sharing this connection (including rolled-back writes).
    // schema_version prevents a same-connection DDL change being hidden by cache.
    const stamp = this.required("SELECT total_changes() AS changes,data_version,schema_version FROM pragma_data_version,pragma_schema_version");
    return `${stamp.changes}:${stamp.data_version}:${stamp.schema_version}`;
  }
  private clearProjections(): void {
    this.projections.clear();
    this.budgets.clear();
    this.projectionWeight = 0;
    this.projectionStamp = null;
  }
  private synchronizeCaches(): void {
    const stamp = this.databaseStamp();
    if (stamp !== this.projectionStamp) { this.clearProjections(); this.projectionStamp = stamp; }
  }
  private rememberBudget(agentId: string, budget: RetainedBudget): void {
    this.budgets.delete(agentId);
    if (this.budgets.size >= MAX_CACHED_AGENT_BUDGETS) this.budgets.delete(this.budgets.keys().next().value!);
    this.budgets.set(agentId, budget);
  }
  private retainedBudget(agentId: string): RetainedBudget {
    this.synchronizeCaches();
    let budget = this.budgets.get(agentId);
    if (!budget) {
      // Aggregate in SQLite, not a JS array. The extra row proves oversize
      // without scanning an arbitrarily large pre-existing agent journal.
      const row = this.required(`SELECT COUNT(*) AS facts,COALESCE(SUM(${FACT_BYTE_COST_SQL}),0) AS bytes
        FROM (SELECT ${FACT_TEXT_COLUMNS.join(",")} FROM execution_facts WHERE agent_id=? LIMIT ${MAX_RETAINED_FACTS_PER_AGENT + 1})`, agentId);
      budget = { facts: Number(row.facts), bytes: Number(row.bytes) };
    }
    this.rememberBudget(agentId, budget);
    return budget;
  }
  private rememberProjection(runtimeId: string, value: RuntimeProjection): void {
    const old = this.projections.get(runtimeId);
    if (old) { this.projectionWeight -= old.weight; this.projections.delete(runtimeId); }
    let weight = 1 + value.projection.turns.size * 4;
    for (const turn of value.projection.turns.values()) weight += turn.operations.size;
    if (weight > MAX_CACHED_ENTRIES) return;
    while (this.projections.size >= MAX_CACHED_RUNTIMES || this.projectionWeight + weight > MAX_CACHED_ENTRIES) {
      const oldest = this.projections.keys().next().value!;
      this.projectionWeight -= this.projections.get(oldest)!.weight;
      this.projections.delete(oldest);
    }
    this.projections.set(runtimeId, { value, weight });
    this.projectionWeight += weight;
  }
  private cachedProjection(runtimeId: string): RuntimeProjection {
    this.synchronizeCaches();
    const runtime = this.row("SELECT agent_id FROM execution_runtime_generations WHERE runtime_generation_id=?", runtimeId);
    if (runtime && exceededBudget(this.retainedBudget(String(runtime.agent_id)))) throw new ExecutionProtocolError("retention_limit");
    const cached = this.projections.get(runtimeId);
    if (cached) {
      this.projections.delete(runtimeId);
      this.projections.set(runtimeId, cached);
      return cached.value;
    }
    const value = this.replayRuntime(runtimeId);
    this.rememberProjection(runtimeId, value);
    return value;
  }
  private row(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.database.prepare(sql).get(...values) as Row | undefined;
  }
  private required(sql: string, ...values: SQLInputValue[]): Row {
    const row = this.row(sql, ...values);
    if (!row) throw new ExecutionProtocolError("identity_mismatch");
    return row;
  }
  private insert(table: string, row: Record<string, SQLInputValue>): void {
    // Table/column names are internal constants, never protocol input.
    this.database.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  }

  registerRuntime(value: z.input<typeof runtimeInput>): void {
    const input = validated(runtimeInput, value);
    this.transaction(() => {
      const existing = this.row("SELECT * FROM execution_runtime_generations WHERE runtime_generation_id=?", input.runtimeGenerationId);
      if (existing && existing.authority_mode !== "typed_shadow") throw new ExecutionProtocolError("identity_mismatch");
      materializeRuntime(this.database, input);
    });
  }

  trackMessage(value: z.input<typeof attemptInput>): string {
    const input = validated(attemptInput, value);
    return this.transaction(() => {
      this.required("SELECT 1 FROM execution_generations WHERE agent_id=? AND execution_generation_id=?", input.agentId, input.executionGenerationId);
      const attempt = this.row("SELECT * FROM execution_message_attempts WHERE agent_id=? AND room_id=? AND source_message_id=?",
        input.agentId, input.roomId, input.sourceMessageId);
      if (attempt && attempt.state !== "active"
        && !this.row("SELECT 1 FROM execution_attempt_generations WHERE attempt_id=? AND execution_generation_id=?", attempt.attempt_id, input.executionGenerationId)) {
        throw new ExecutionProtocolError("attempt_settled");
      }
      return materializeMessage(this.database, input);
    });
  }

  /** Records a known exact native identity; does not request or start a turn. */
  trackNativeTurn(value: z.input<typeof turnInput>): void {
    const input = validated(turnInput, value);
    this.transaction(() => {
      const attempt = this.required("SELECT * FROM execution_message_attempts WHERE attempt_id=? AND agent_id=? AND room_id=?",
        input.attemptId, input.agentId, input.roomId);
      this.required("SELECT 1 FROM execution_attempt_generations WHERE attempt_id=? AND execution_generation_id=?", input.attemptId, input.executionGenerationId);
      const runtime = this.required("SELECT * FROM execution_runtime_generations WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=?",
        input.agentId, input.executionGenerationId, input.runtimeGenerationId);
      const existing = this.row("SELECT * FROM execution_turns WHERE turn_id=?", input.turnId);
      if (existing) {
        materializeTurn(this.database, input);
        return;
      }
      if (attempt.state !== "active") throw new ExecutionProtocolError("attempt_settled");
      if (runtime.runtime_state === "exited" || runtime.authority_mode !== "typed_shadow"
        || this.row("SELECT 1 FROM execution_turns WHERE agent_id=? AND state IN ('none','active','lost')", input.agentId)) {
        throw new ExecutionProtocolError("invalid_transition");
      }
      materializeTurn(this.database, input);
    });
  }

  /**
   * Caller supplies independently verified native identity, never stream text.
   * CAS fences concurrent/replaced observers. Recovery compares every retained
   * turn field; a newer runtime cannot relabel old-turn facts as its own work.
   */
  bindObserver(value: z.input<typeof observerInput>): ShadowObserver {
    const input = validated(observerInput, value);
    const token = this.transaction((): ShadowObserver => {
      const subject = this.required("SELECT * FROM execution_runtime_generations WHERE agent_id=? AND runtime_generation_id=?", input.agentId, input.subjectRuntimeGenerationId);
      const observer = this.required("SELECT * FROM execution_runtime_generations WHERE agent_id=? AND runtime_generation_id=?", input.agentId, input.observerRuntimeGenerationId);
      if (observer.runtime_state === "exited" || observer.authority_mode !== "typed_shadow" || subject.authority_mode !== "typed_shadow"
        || observer.provider !== subject.provider) throw new ExecutionProtocolError("identity_mismatch");
      if (input.recovery) {
        this.required(`SELECT 1 FROM execution_turns WHERE turn_id=? AND agent_id=? AND execution_generation_id=?
          AND runtime_generation_id=? AND provider_continuation_id=? AND provider_turn_id=?`,
        input.recovery.turnId, input.agentId, subject.execution_generation_id, subject.runtime_generation_id,
        input.recovery.providerContinuationId, input.recovery.providerTurnId);
      } else if (subject.runtime_generation_id !== observer.runtime_generation_id) throw new ExecutionProtocolError("identity_mismatch");
      const current = this.row("SELECT * FROM execution_observers WHERE agent_id=?", input.agentId);
      if ((current?.observer_epoch ?? 0) !== input.expectedEpoch || input.expectedEpoch === Number.MAX_SAFE_INTEGER) {
        throw new ExecutionProtocolError("stale_observer");
      }
      // A migrated cursor has no known source. Neither a new subscription nor
      // a matching process birth can prove its provenance retroactively.
      if (current && current.source_id === null) throw new ExecutionProtocolError("source_unverified");
      if (current && !this.row("SELECT 1 FROM execution_observer_sources WHERE agent_id=? AND source_id=?", input.agentId, current.source_id)) {
        throw new ExecutionProtocolError("source_unverified");
      }
      const sameSource = current?.source_id === input.sourceId;
      // Retain admission IDs independently of fact retention. Otherwise A→B→A
      // could reset A's cursor and count its old output again under a new epoch.
      if (!sameSource && this.row("SELECT 1 FROM execution_observer_sources WHERE agent_id=? AND source_id=?", input.agentId, input.sourceId)) {
        throw new ExecutionProtocolError("stale_observer");
      }
      if (!current && (this.row("SELECT 1 FROM execution_observer_sources WHERE agent_id=? LIMIT 1", input.agentId)
        || this.row("SELECT 1 FROM execution_facts WHERE agent_id=? LIMIT 1", input.agentId))) {
        throw new ExecutionProtocolError("source_unverified");
      }
      if (current && !sameSource && Number(current.max_observed_sequence) > Number(current.last_source_sequence)) {
        throw new ExecutionProtocolError("source_gap");
      }
      const lastSourceSequence = sameSource ? Number(current.last_source_sequence) : 0;
      const maxObservedSequence = sameSource ? Number(current.max_observed_sequence) : 0;
      const epoch = input.expectedEpoch + 1;
      this.database.prepare(`INSERT INTO execution_observers(agent_id,execution_generation_id,runtime_generation_id,
        observer_execution_generation_id,observer_runtime_generation_id,daemon_generation_id,observer_epoch,
        last_source_sequence,max_observed_sequence,recovery_turn_id,bound_at_ms,source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET execution_generation_id=excluded.execution_generation_id,runtime_generation_id=excluded.runtime_generation_id,
        observer_execution_generation_id=excluded.observer_execution_generation_id,observer_runtime_generation_id=excluded.observer_runtime_generation_id,
        daemon_generation_id=excluded.daemon_generation_id,observer_epoch=excluded.observer_epoch,
        last_source_sequence=excluded.last_source_sequence,max_observed_sequence=excluded.max_observed_sequence,
        recovery_turn_id=excluded.recovery_turn_id,bound_at_ms=excluded.bound_at_ms,source_id=excluded.source_id`)
        .run(input.agentId, subject.execution_generation_id, subject.runtime_generation_id, observer.execution_generation_id,
          observer.runtime_generation_id, input.daemonGenerationId, epoch, lastSourceSequence, maxObservedSequence,
          input.recovery?.turnId ?? null, input.boundAtMs, input.sourceId);
      if (!sameSource) this.insert("execution_observer_sources", { agent_id: input.agentId, source_id: input.sourceId });
      return Object.freeze({
        agentId: input.agentId, runtimeGenerationId: String(subject.runtime_generation_id), executionGenerationId: String(subject.execution_generation_id),
        observerRuntimeGenerationId: String(observer.runtime_generation_id), observerExecutionGenerationId: String(observer.execution_generation_id),
        daemonGenerationId: input.daemonGenerationId, epoch, recoveryTurnId: input.recovery?.turnId ?? null,
        sourceId: input.sourceId, lastSourceSequence, maxObservedSequence,
      });
    });
    this.observers.add(token);
    return token;
  }

  /** Remember observed-but-not-yet-admitted positions without inventing a fact. */
  observeSourcePosition(sourceId: string, token: ShadowObserver, latestSequence: number): void {
    validated(time, latestSequence);
    this.transaction(() => {
      const current = this.currentObserver(sourceId, token);
      if (latestSequence < Number(current.last_source_sequence)) throw new ExecutionProtocolError("source_gap");
      this.database.prepare("UPDATE execution_observers SET max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?")
        .run(latestSequence, token.agentId);
    });
  }

  private currentObserver(sourceId: string, token: ShadowObserver): Row {
    if (!this.observers.has(token)) throw new ExecutionProtocolError("stale_observer");
    if (validated(id, sourceId) !== token.sourceId) throw new ExecutionProtocolError("identity_mismatch");
    const current = this.required("SELECT * FROM execution_observers WHERE agent_id=?", token.agentId);
    if (current.observer_epoch !== token.epoch || current.daemon_generation_id !== token.daemonGenerationId
      || current.source_id !== token.sourceId || current.observer_runtime_generation_id !== token.observerRuntimeGenerationId) {
      throw new ExecutionProtocolError("stale_observer");
    }
    if (!this.row("SELECT 1 FROM execution_observer_sources WHERE agent_id=? AND source_id=?", token.agentId, sourceId)) {
      throw new ExecutionProtocolError("source_unverified");
    }
    return current;
  }

  /** sourceId must come from the observation, not be copied from the token. */
  ingest(sourceId: string, token: ShadowObserver, value: unknown): ShadowIngestion {
    const fact = parseExecutionFact(value);
    if (!this.observers.has(token)) throw new ExecutionProtocolError("stale_observer");
    if (validated(id, sourceId) !== token.sourceId) throw new ExecutionProtocolError("identity_mismatch");
    let committed: { value: RuntimeProjection; budget: RetainedBudget; stamp: string } | undefined;
    const result = this.transaction<ShadowIngestion>(() => {
      const current = this.currentObserver(sourceId, token);
      if (fact.observerEpoch !== token.epoch) throw new ExecutionProtocolError("stale_observer");
      if (fact.agentId !== token.agentId) throw new ExecutionProtocolError("identity_mismatch");
      let retainedTurn: Row | undefined;
      if (fact.domain === "turn" || fact.domain === "execution") {
        if (fact.runtimeGenerationId !== token.runtimeGenerationId || fact.executionGenerationId !== token.executionGenerationId
          || (token.recoveryTurnId !== null && token.recoveryTurnId !== fact.turnId)) throw new ExecutionProtocolError("identity_mismatch");
        retainedTurn = this.required(`SELECT * FROM execution_turns WHERE turn_id=? AND agent_id=? AND execution_generation_id=?
          AND runtime_generation_id=? AND provider_continuation_id=? AND provider_turn_id=?`, fact.turnId, fact.agentId,
        fact.executionGenerationId, fact.runtimeGenerationId, fact.providerContinuationId, fact.providerTurnId);
      } else if (fact.runtimeGenerationId !== token.observerRuntimeGenerationId || fact.executionGenerationId !== token.observerExecutionGenerationId) {
        throw new ExecutionProtocolError("identity_mismatch");
      }
      const duplicate = this.row(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
        LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.fact_id=? OR (f.agent_id=? AND f.observer_epoch=? AND f.source_sequence=?)`,
      fact.factId, fact.agentId, fact.observerEpoch, fact.sourceSequence);
      if (duplicate) {
        if (JSON.stringify(this.decodeFact(duplicate)) !== JSON.stringify(fact)) throw new ExecutionProtocolError("sequence_conflict");
        // An exact stored witness consumes no capacity. A native-event replay
        // at a new source position still needs its own durable row below.
        return { status: "duplicate", journalSequence: Number(duplicate.sequence), gapPending: Number(current.max_observed_sequence) > Number(current.last_source_sequence) };
      }
      const expected = Number(current.last_source_sequence) + 1;
      if (fact.sourceSequence < expected) throw new ExecutionProtocolError("sequence_conflict");
      const stored: Row = {
        fact_id: fact.factId, agent_id: fact.agentId, execution_generation_id: fact.executionGenerationId, runtime_generation_id: fact.runtimeGenerationId,
        observer_epoch: fact.observerEpoch, source_sequence: fact.sourceSequence, native_event_id: fact.nativeEventId ?? null,
        turn_id: "turnId" in fact ? fact.turnId : null, execution_id: fact.domain === "execution" ? fact.executionId : null,
        domain: fact.domain, kind: fact.kind, state: "state" in fact ? fact.state : null,
        operation: fact.domain === "execution" ? fact.operation : null, outcome: "outcome" in fact ? fact.outcome : null,
        side_effects: fact.sideEffects, output_bytes: "outputBytes" in fact ? fact.outputBytes : null,
        exit_code: "exitCode" in fact ? fact.exitCode ?? null : null, signal_number: "signalNumber" in fact ? fact.signalNumber ?? null : null,
        observed_at_ms: fact.observedAtMs, turn_outcome: "turnOutcome" in fact ? fact.turnOutcome ?? null : null,
        control_evidence: "controlEvidence" in fact ? fact.controlEvidence ?? null : null,
      };
      const retained = this.retainedBudget(fact.agentId);
      const budget = { facts: retained.facts + 1, bytes: retained.bytes + factBytes(stored) };
      const limit = exceededBudget(budget);
      if (limit) {
        // Capture is suspended, not provider work. Remember the unaccepted
        // source position so neither rebind nor a new source can erase the gap.
        this.database.prepare("UPDATE execution_observers SET max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?")
          .run(fact.sourceSequence, fact.agentId);
        return { status: "retention_limit", limit, expectedSourceSequence: expected, observedSourceSequence: fact.sourceSequence };
      }
      if (fact.sourceSequence > expected) {
        this.database.prepare("UPDATE execution_observers SET max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?")
          .run(fact.sourceSequence, fact.agentId);
        return { status: "gap", expectedSourceSequence: expected, observedSourceSequence: fact.sourceSequence };
      }
      let replay = false;
      if (fact.nativeEventId !== undefined) {
        const observations = this.database.prepare(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
          LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.runtime_generation_id=? AND f.native_event_id=?
          AND f.domain=? AND f.kind=? AND f.turn_id IS ? AND f.execution_id IS ? ORDER BY f.sequence`).iterate(
          fact.runtimeGenerationId, fact.nativeEventId, fact.domain, fact.kind, "turnId" in fact ? fact.turnId : null,
          fact.domain === "execution" ? fact.executionId : null,
        ) as Iterable<Row>;
        for (const observation of observations) {
          if (unverifiedHistoricalFact(observation)) continue;
          if (semanticFact(this.decodeFact(observation)) !== semanticFact(fact)) throw new ExecutionProtocolError("sequence_conflict");
          replay = true;
        }
      }
      // Replayed evidence observes history; only new facts request transitions.
      // Keep identity fences above deduplication, lifecycle fences below it.
      if (!replay) {
        if (retainedTurn?.state === "lost" && fact.domain === "turn" && fact.state === "active" && token.recoveryTurnId !== fact.turnId) {
          throw new ExecutionProtocolError("identity_mismatch");
        }
        if ((retainedTurn?.state === "terminal" && fact.domain === "turn" && fact.state !== "terminal")
          || ((retainedTurn?.state === "terminal" || retainedTurn?.state === "lost") && fact.domain === "execution" && fact.kind !== "completed")
          || (fact.domain === "runtime" && fact.state !== "exited"
            && this.required("SELECT runtime_state FROM execution_runtime_generations WHERE runtime_generation_id=?", fact.runtimeGenerationId).runtime_state === "exited")) {
          throw new ExecutionProtocolError("invalid_transition");
        }
      }
      const previous = this.cachedProjection(fact.runtimeGenerationId);
      const next = replay ? previous.projection : reduceExecutionFact(previous.projection, fact);
      this.insert("execution_facts", stored);
      this.database.prepare("UPDATE execution_observers SET last_source_sequence=?,max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?")
        .run(fact.sourceSequence, fact.sourceSequence, fact.agentId);
      if (!replay && fact.domain === "runtime") {
        this.database.prepare(`UPDATE execution_runtime_generations SET runtime_state=?,
          ended_at_ms=CASE WHEN ?='exited' THEN COALESCE(ended_at_ms,MAX(created_at_ms,?)) ELSE NULL END WHERE runtime_generation_id=?`)
          .run(next.runtime, next.runtime, fact.observedAtMs, fact.runtimeGenerationId);
      } else if (!replay && fact.domain === "control") {
        this.database.prepare("UPDATE execution_runtime_generations SET control_state=? WHERE runtime_generation_id=?").run(next.control, fact.runtimeGenerationId);
      } else if (!replay && fact.domain === "continuation") {
        this.database.prepare("UPDATE execution_runtime_generations SET continuation_state=? WHERE runtime_generation_id=?").run(next.continuation, fact.runtimeGenerationId);
      } else if (!replay && (fact.domain === "turn" || fact.domain === "execution")) {
        const turn = next.turns.get(fact.turnId)!;
        const sideEffects = combineSideEffects(retainedTurn!.side_effects as SideEffectState, turn.sideEffects);
        if (fact.domain === "execution") {
          // Late tool outcomes cannot rewrite independent native-turn state,
          // including migrated terminals whose exact outcome remains unknown.
          this.database.prepare("UPDATE execution_turns SET side_effects=? WHERE turn_id=?").run(sideEffects, fact.turnId);
        } else {
          this.database.prepare(`UPDATE execution_turns SET state=?,side_effects=?,
            ended_at_ms=CASE WHEN ? IN ('terminal','lost') THEN COALESCE(ended_at_ms,MAX(created_at_ms,?)) ELSE NULL END WHERE turn_id=?`)
            .run(turn.state, sideEffects, turn.state, fact.observedAtMs, fact.turnId);
        }
      }
      const journalSequence = Number(this.required("SELECT sequence FROM execution_facts WHERE fact_id=?", fact.factId).sequence);
      // Capture under the write transaction, never bless an external commit
      // racing after COMMIT. Publish this candidate to the cache only on success.
      committed = { value: { projection: next, unverifiedFacts: previous.unverifiedFacts, lastJournalSequence: journalSequence }, budget, stamp: this.databaseStamp() };
      return {
        status: replay ? "duplicate" : "accepted", journalSequence,
        gapPending: Number(current.max_observed_sequence) > fact.sourceSequence,
      };
    });
    if (committed) {
      this.projectionStamp = committed.stamp;
      this.rememberProjection(fact.runtimeGenerationId, committed.value);
      this.rememberBudget(fact.agentId, committed.budget);
    }
    return result;
  }

  /** A bounded, coherent view of retained evidence, never provider authority. */
  retainedMessageExecution(agentId: string, roomId: string, sourceMessageId: string): RetainedExecutionDetail {
    let ownsSnapshot = false;
    try {
      validated(id, agentId); validated(id, roomId); validated(id, sourceMessageId);
      if (!this.database.isTransaction) { this.database.exec("BEGIN"); ownsSnapshot = true; }
      this.clearProjections();
      if (exceededBudget(this.retainedBudget(agentId))) throw new ExecutionProtocolError("retention_limit");
      // Bound the driving relation before filtering. Approval-only identities
      // are not capped; starting from turns would make LIMIT 33 an output-only bound.
      const rows = this.database.prepare(`WITH captured AS MATERIALIZED (
          SELECT agent_id,turn_id,runtime_generation_id,domain FROM execution_facts
          INDEXED BY execution_facts_agent_sequence WHERE agent_id=? ORDER BY sequence LIMIT ${MAX_RETAINED_FACTS_PER_AGENT + 1}
        ) SELECT DISTINCT t.turn_id,t.runtime_generation_id,t.created_at_ms FROM captured f
        CROSS JOIN execution_turns t ON t.turn_id=f.turn_id AND t.agent_id=f.agent_id AND t.runtime_generation_id=f.runtime_generation_id
        CROSS JOIN execution_message_attempts a ON a.attempt_id=t.attempt_id AND a.agent_id=t.agent_id AND a.room_id=t.room_id
        CROSS JOIN execution_attempt_generations g ON g.attempt_id=a.attempt_id AND g.execution_generation_id=t.execution_generation_id
          AND g.agent_id=a.agent_id AND g.room_id=a.room_id
        WHERE f.domain IN ('turn','execution') AND a.room_id=? AND a.source_message_id=?
        ORDER BY t.created_at_ms DESC,t.turn_id DESC LIMIT 33`).all(agentId, roomId, sourceMessageId) as Row[];
      let result: RetainedExecutionDetail = { availability: "not_captured" };
      if (rows.length) {
        const turns: Extract<RetainedExecutionDetail, { availability: "available" }>["turns"] = [];
        const runtimes = new Map<string, RuntimeProjection>();
        const observer = this.row("SELECT last_source_sequence,max_observed_sequence,source_id FROM execution_observers WHERE agent_id=?", agentId);
        let evidenceIncomplete = !observer || observer.source_id === null
          || Number(observer.max_observed_sequence) > Number(observer.last_source_sequence);
        let truncated = rows.length > 32;
        let operationsLeft = 128;
        for (const row of rows.slice(0, 32)) {
          const runtimeId = String(row.runtime_generation_id);
          let runtime = runtimes.get(runtimeId);
          if (!runtime) {
            if (runtimes.size >= 8) { truncated = true; break; }
            runtime = this.projectRuntime(runtimeId); runtimes.set(runtimeId, runtime);
          }
          evidenceIncomplete ||= runtime.unverifiedFacts > 0;
          const turn = runtime.projection.turns.get(String(row.turn_id));
          if (!turn) { evidenceIncomplete = true; continue; }
          const operations = [...turn.operations.entries()].slice(0, operationsLeft).map(([executionId, operation]) => ({
            executionId, operation: operation.operation, outcome: operation.outcome, startObserved: operation.startObserved,
            outputBytes: operation.outputBytes, sideEffects: operation.sideEffects, exitCode: operation.exitCode, signalNumber: operation.signalNumber,
          }));
          if (operations.length < turn.operations.size) truncated = true;
          operationsLeft -= operations.length;
          turns.push({ turnId: turn.turnId, state: turn.state, outcome: turn.outcome, operations });
        }
        result = { availability: "available", truncated, evidenceIncomplete, turns };
      }
      if (ownsSnapshot) { this.database.exec("COMMIT"); ownsSnapshot = false; }
      return result;
    } catch {
      if (ownsSnapshot) { try { this.database.exec("ROLLBACK"); } catch { /* Preserve optional-read isolation. */ } }
      return { availability: "unavailable" };
    } finally {
      this.clearProjections();
    }
  }

  /** History from v18 without typed terminal proof stays explicitly unverified. */
  projectRuntime(runtimeGenerationId: string): RuntimeProjection {
    validated(id, runtimeGenerationId);
    // The connection is caller-owned. Never cache a caller's uncommitted view:
    // its later ROLLBACK need not change SQLite's total_changes counter.
    if (this.database.isTransaction) {
      this.clearProjections();
      try { return this.replayRuntime(runtimeGenerationId); }
      finally { this.clearProjections(); }
    }
    // Capacity is agent-wide, replay is runtime-specific. Both must see the
    // same snapshot when another connection appends to a different runtime.
    this.database.exec("BEGIN");
    try {
      // ReadonlyMap is compile-time only; no public object may alias cache state.
      const result = structuredClone(this.cachedProjection(runtimeGenerationId));
      const stamp = this.databaseStamp();
      this.database.exec("COMMIT");
      // Never bless a concurrent writer's newer stamp after releasing our view.
      this.projectionStamp = stamp;
      return result;
    } catch (error) { this.clearProjections(); this.database.exec("ROLLBACK"); throw error; }
  }

  private replayRuntime(runtimeGenerationId: string): RuntimeProjection {
    const runtime = this.row("SELECT agent_id FROM execution_runtime_generations WHERE runtime_generation_id=?", runtimeGenerationId);
    if (runtime && exceededBudget(this.retainedBudget(String(runtime.agent_id)))) throw new ExecutionProtocolError("retention_limit");
    const facts = this.database.prepare(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
      LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.runtime_generation_id=? ORDER BY f.sequence LIMIT ${MAX_RETAINED_FACTS_PER_AGENT + 1}`)
      .iterate(runtimeGenerationId) as Iterable<Row>;
    let projection = emptyExecutionProjection();
    let unverifiedFacts = 0;
    let lastJournalSequence = 0;
    const replayBudget = { facts: 0, bytes: 0 };
    const nativeEvents = new Map<string, string>();
    for (const row of facts) {
      replayBudget.facts++;
      replayBudget.bytes += factBytes(row);
      if (exceededBudget(replayBudget)) throw new ExecutionProtocolError("retention_limit");
      lastJournalSequence = Number(row.sequence);
      if (unverifiedHistoricalFact(row)) {
        unverifiedFacts += 1;
        continue;
      }
      const fact = this.decodeFact(row);
      const key = nativeEventKey(fact);
      if (key !== null) {
        const previous = nativeEvents.get(key);
        const semantic = semanticFact(fact);
        if (previous !== undefined) {
          if (previous !== semantic) throw new ExecutionProtocolError("sequence_conflict");
          continue;
        }
        nativeEvents.set(key, semantic);
      }
      projection = reduceExecutionFact(projection, fact);
    }
    return { projection, unverifiedFacts, lastJournalSequence };
  }

  private decodeFact(row: Row): ExecutionFact {
    const value: Record<string, unknown> = {
      factId: row.fact_id, agentId: row.agent_id, executionGenerationId: row.execution_generation_id, runtimeGenerationId: row.runtime_generation_id,
      observerEpoch: row.observer_epoch, sourceSequence: row.source_sequence, observedAtMs: row.observed_at_ms,
      ...(row.native_event_id === null ? {} : { nativeEventId: row.native_event_id }), domain: row.domain, kind: row.kind, sideEffects: row.side_effects,
    };
    if (row.domain === "turn" || row.domain === "execution") Object.assign(value, {
      turnId: row.turn_id, providerContinuationId: row.provider_continuation_id, providerTurnId: row.provider_turn_id,
    });
    if (row.domain === "execution") {
      Object.assign(value, { executionId: row.execution_id, operation: row.operation });
      if (row.kind === "output") value.outputBytes = row.output_bytes;
      if (row.kind === "completed") Object.assign(value, {
        outcome: row.outcome,
        ...(row.exit_code === null ? {} : { exitCode: row.exit_code }), ...(row.signal_number === null ? {} : { signalNumber: row.signal_number }),
      });
    } else {
      value.state = row.state;
      if (row.turn_outcome !== null) value.turnOutcome = row.turn_outcome;
      if (row.control_evidence !== null) value.controlEvidence = row.control_evidence;
    }
    return parseExecutionFact(value);
  }
}
