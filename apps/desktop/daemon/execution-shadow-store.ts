import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { z } from "zod";
import type { RetainedExecutionDetail } from "../shared/execution-protocol.js";
import { parseRoomAgentWorkSummary, ROOM_WORK_OPERATION_OUTCOMES, type RoomAgentWorkSummary } from "../../../shared/room-agent-work.mjs";

import { combineSideEffects, executionIdentity as id, ExecutionProtocolError, nativeTurnIdentity, parseExecutionFact, type ExecutionFact, type SideEffectState } from "./execution-protocol.js";
import { emptyExecutionProjection, reduceParsedExecutionFact, type ExecutionProjection } from "./execution-reducer.js";
import { isTypedCaptureAuthority, lifecycleAuthorityModeSchema, type LifecycleAuthorityMode } from "./lifecycle-authority-mode.js";
import { executionRecordWindowStart, hasRuntimeRecoveryBoundary, recoveredRuntime, runtimeRecoveryStorageAvailable } from "./runtime-recovery-journal.js";
import { LifecycleProjectionLedger, type LifecycleProjectionDiagnostics, type LifecycleProjectionObservation,
  type LifecycleProjectionProvider } from "./lifecycle-projection-ledger.js";

type Row = Record<string, string | number | null>;
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runtimeInput = z.strictObject({
  agentId: id, executionGenerationId: id, runtimeGenerationId: id,
  provider: z.enum(["codex", "claude-code", "cursor", "open-model"]), authorityMode: lifecycleAuthorityModeSchema,
  configRevision: time.min(1), createdAtMs: time,
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
export type CapturedRoomWorkSummary =
  | { availability: "not_captured" | "unavailable" }
  | { availability: "available"; attemptId: string; summary: RoomAgentWorkSummary };
type RetainedBudget = { facts: number; bytes: number };
/** `replay` counts every journal row the projection reduced, as replayRows bounds them. */
type CachedRuntime = { value: RuntimeProjection; replay: RetainedBudget; epoch: number; weight: number };
/** `last` is the newest counted sequence in the record window that starts after `windowStart`. */
type CachedBudget = { budget: RetainedBudget; windowStart: number; last: number; epoch: number };
type ReplayState = RuntimeProjection & { replay: RetainedBudget };
// Count nested entries, not just runtimes: one long-lived runtime can have many
// turns and operations. Every retained identity is protocol-bounded to 512 chars.
const MAX_CACHED_RUNTIMES = 16;
const MAX_CACHED_ENTRIES = 4096;
const MAX_CACHED_AGENT_BUDGETS = 16;
const MAX_CACHED_STATEMENTS = 64;
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

function lifecycleEffectKind(
  fact: ExecutionFact,
  provider: string,
): "none" | "manifest_working" | "manifest_idle" | "manifest_failed" {
  if (fact.domain === "runtime" && fact.state === "ready") return "manifest_idle";
  if (fact.domain === "runtime" && fact.state === "exited") {
    // Cursor owns one short-lived child per turn. Its normal exit closes
    // history; only the validated turn outcome owns the reusable lane.
    return provider === "cursor" ? "none" : "manifest_failed";
  }
  if (fact.domain !== "turn") return "none";
  if (fact.state === "active") return "manifest_working";
  if (fact.state === "terminal") return "manifest_idle";
  if (fact.state === "lost" && provider === "cursor") return "manifest_failed";
  return "none";
}
function unverifiedHistoricalFact(row: Row): boolean {
  return (row.domain === "turn" && row.state === "terminal" && row.turn_outcome === null)
    || ((row.domain === "runtime" && row.state === "exited" || row.domain === "control" && row.state === "lost") && row.control_evidence === null);
}

/** Shared structural identity; neither this recipe nor these rows grant execution authority. */
export function executionStorageIdentity(kind: string, ...identity: string[]): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Exact native runtime identity. PID and OS birth evidence are inseparable. */
export function executionRuntimeStorageIdentity(
  agentId: string,
  executionGenerationId: string,
  connectionKind: string,
  pid: number,
  processIdentity: string,
): string {
  if (![agentId, executionGenerationId, connectionKind, processIdentity]
    .every((value) => typeof value === "string" && value.trim().length > 0)
    || !Number.isSafeInteger(pid) || pid < 1) {
    throw new ExecutionProtocolError("identity_mismatch");
  }
  return executionStorageIdentity(
    "runtime",
    agentId,
    executionGenerationId,
    connectionKind,
    String(pid),
    processIdentity,
  );
}

/** Caller owns the transaction. Preserve existing projections, including lagging terminal state. */
export function materializeExecutionIdentity(database: DatabaseSync, value: {
  runtime: z.input<typeof runtimeInput>; message: z.input<typeof attemptInput>;
  turn: Omit<z.input<typeof turnInput>, "attemptId">;
}): LifecycleAuthorityMode {
  const runtime = validated(runtimeInput, value.runtime);
  const message = validated(attemptInput, value.message);
  const turn = validated(turnInput.omit({ attemptId: true }), value.turn);
  if (!database.isTransaction || runtime.agentId !== message.agentId || runtime.agentId !== turn.agentId
    || runtime.executionGenerationId !== message.executionGenerationId || runtime.executionGenerationId !== turn.executionGenerationId
    || runtime.runtimeGenerationId !== turn.runtimeGenerationId || message.roomId !== turn.roomId) {
    throw new ExecutionProtocolError("identity_mismatch");
  }
  const authorityMode = materializeRuntimeIdentity(database, runtime);
  const attemptId = materializeMessage(database, message);
  materializeTurn(database, { ...turn, attemptId });
  return authorityMode;
}

/** Caller owns the transaction; the first exact native birth freezes authority. */
export function materializeRuntimeIdentity(
  database: DatabaseSync,
  value: z.input<typeof runtimeInput>,
): LifecycleAuthorityMode {
  const input = validated(runtimeInput, value);
  if (!database.isTransaction) throw new ExecutionProtocolError("identity_mismatch");
  return materializeRuntime(database, input);
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
/** First exact materialization freezes authority; later policy requests can only observe it. */
function materializeRuntime(database: DatabaseSync, input: z.output<typeof runtimeInput>): LifecycleAuthorityMode {
  if (!exactRow(database, "execution_generations", "execution_generation_id", input.executionGenerationId, { agent_id: input.agentId })) {
    insertIdentity(database, "execution_generations", { execution_generation_id: input.executionGenerationId, agent_id: input.agentId, created_at_ms: input.createdAtMs });
  }
  const fields = { runtime_generation_id: input.runtimeGenerationId, execution_generation_id: input.executionGenerationId,
    agent_id: input.agentId, provider: input.provider, config_revision: input.configRevision };
  const existing = database.prepare("SELECT * FROM execution_runtime_generations WHERE runtime_generation_id=?").get(input.runtimeGenerationId);
  if (existing) {
    if (Object.entries(fields).some(([column, expected]) => existing[column] !== expected)) throw new ExecutionProtocolError("identity_mismatch");
    const authorityMode = lifecycleAuthorityModeSchema.safeParse(existing.authority_mode);
    if (!authorityMode.success) throw new ExecutionProtocolError("identity_mismatch");
    return authorityMode.data;
  }
  insertIdentity(database, "execution_runtime_generations", { ...fields, authority_mode: input.authorityMode, runtime_state: "starting",
    control_state: "connecting", continuation_state: "available", created_at_ms: input.createdAtMs });
  return input.authorityMode;
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
  private readonly projections = new Map<string, CachedRuntime>();
  private readonly budgets = new Map<string, CachedBudget>();
  private readonly statements = new Map<string, StatementSync>();
  private projectionWeight = 0;
  /**
   * Cache entries carry the epoch they were last proven against. The epoch
   * moves whenever the database stamp moves for a reason this store did not
   * itself commit. An entry from an older epoch is not dropped: it is checked
   * against its own journal key (see revalidateRuntime / retainedBudget).
   */
  private cacheEpoch = 0;
  private cacheStamp: string | null = null;
  private schemaVersion: number | null = null;
  private readonly lifecycleProjection: LifecycleProjectionLedger;
  constructor(private readonly database: DatabaseSync) {
    this.lifecycleProjection = new LifecycleProjectionLedger(database);
  }

  private transaction<T>(body: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.synchronizeCaches();
      const result = body();
      // Own metadata/cursor writes do not invalidate fact budgets or replay.
      // Capture before COMMIT; an external commit afterwards must invalidate us.
      const stamp = this.databaseStamp();
      this.database.exec("COMMIT");
      this.cacheStamp = stamp;
      return result;
    }
    catch (error) { this.clearProjections(); this.database.exec("ROLLBACK"); throw error; }
  }

  private databaseStamp(): string {
    // data_version detects other connections; total_changes also detects a
    // second store sharing this connection (including rolled-back writes).
    // schema_version prevents a same-connection DDL change being hidden by cache.
    const stamp = this.required("SELECT total_changes() AS changes,data_version,schema_version FROM pragma_data_version,pragma_schema_version");
    const schemaVersion = Number(stamp.schema_version);
    if (this.schemaVersion !== null && this.schemaVersion !== schemaVersion) {
      // DDL can change what any cached projection or statement means.
      this.clearProjections();
      this.statements.clear();
    }
    this.schemaVersion = schemaVersion;
    return `${stamp.changes}:${stamp.data_version}:${schemaVersion}`;
  }
  private clearProjections(): void {
    this.projections.clear();
    this.budgets.clear();
    this.projectionWeight = 0;
    this.cacheStamp = null;
  }
  private synchronizeCaches(): void {
    const stamp = this.databaseStamp();
    // Someone else wrote (another connection, or another user of this one).
    // Keep the entries but make each prove its own journal key before use.
    if (stamp !== this.cacheStamp) { this.cacheEpoch++; this.cacheStamp = stamp; }
  }
  private rememberBudget(agentId: string, entry: CachedBudget): void {
    this.budgets.delete(agentId);
    if (this.budgets.size >= MAX_CACHED_AGENT_BUDGETS) this.budgets.delete(this.budgets.keys().next().value!);
    this.budgets.set(agentId, entry);
  }
  private retainedBudget(agentId: string): CachedBudget {
    this.synchronizeCaches();
    let entry = this.budgets.get(agentId);
    if (entry && entry.epoch !== this.cacheEpoch) entry = this.revalidateBudget(agentId, entry);
    if (!entry) {
      const windowStart = executionRecordWindowStart(this.database, agentId);
      // Aggregate in SQLite, not a JS array. The extra row proves oversize
      // without scanning an arbitrarily large pre-existing agent journal.
      // Only the agent's current record window counts: see its start.
      // Fresh prepare: a cold count is rare, and tests observe it by its SQL.
      const row = this.database.prepare(`SELECT COUNT(*) AS facts,COALESCE(SUM(${FACT_BYTE_COST_SQL}),0) AS bytes,COALESCE(MAX(sequence),0) AS last
        FROM (SELECT sequence,${FACT_TEXT_COLUMNS.join(",")} FROM execution_facts WHERE agent_id=? AND sequence>? LIMIT ${MAX_RETAINED_FACTS_PER_AGENT + 1})`)
        .get(agentId, windowStart) as Row;
      entry = { budget: { facts: Number(row.facts), bytes: Number(row.bytes) }, windowStart, last: Number(row.last), epoch: this.cacheEpoch };
    }
    this.rememberBudget(agentId, entry);
    return entry;
  }
  /**
   * An older-epoch budget is still exact when its record window starts at
   * the same fact and every fact it counted is still there. The journal key
   * proves the second part: the window holds exactly the counted facts plus
   * those newer than `last`. Facts are immutable (a trigger refuses UPDATE)
   * and AUTOINCREMENT never reuses a sequence, so newer facts are appends and
   * are added on. A deleted fact breaks the count and forces a recount. (Not
   * caught: a fact deleted and another inserted with that same explicit old
   * sequence; nothing writes facts that way.)
   */
  private revalidateBudget(agentId: string, entry: CachedBudget): CachedBudget | undefined {
    if (exceededBudget(entry.budget)) return undefined;
    const windowStart = executionRecordWindowStart(this.database, agentId);
    if (windowStart !== entry.windowStart) return undefined;
    const key = this.required(`SELECT COUNT(*) AS seen,COALESCE(MAX(sequence),0) AS last
      FROM (SELECT sequence FROM execution_facts WHERE agent_id=? AND sequence>? LIMIT ${MAX_RETAINED_FACTS_PER_AGENT + 1})`,
    agentId, windowStart);
    const seen = Number(key.seen);
    const last = Number(key.last);
    if (seen > MAX_RETAINED_FACTS_PER_AGENT || last < entry.last) return undefined;
    if (last === entry.last) return seen === entry.budget.facts ? { ...entry, epoch: this.cacheEpoch } : undefined;
    const added = this.required(`SELECT COUNT(*) AS added,COALESCE(SUM(${FACT_BYTE_COST_SQL}),0) AS bytes
      FROM execution_facts WHERE agent_id=? AND sequence>?`, agentId, Math.max(entry.last, windowStart));
    if (entry.budget.facts + Number(added.added) !== seen) return undefined;
    return { budget: { facts: seen, bytes: entry.budget.bytes + Number(added.bytes) }, windowStart, last, epoch: this.cacheEpoch };
  }
  private rememberProjection(runtimeId: string, entry: Omit<CachedRuntime, "weight">): void {
    const old = this.projections.get(runtimeId);
    if (old) { this.projectionWeight -= old.weight; this.projections.delete(runtimeId); }
    let weight = 1 + entry.value.projection.turns.size * 4;
    for (const turn of entry.value.projection.turns.values()) weight += turn.operations.size;
    if (weight > MAX_CACHED_ENTRIES) return;
    while (this.projections.size >= MAX_CACHED_RUNTIMES || this.projectionWeight + weight > MAX_CACHED_ENTRIES) {
      const oldest = this.projections.keys().next().value!;
      this.projectionWeight -= this.projections.get(oldest)!.weight;
      this.projections.delete(oldest);
    }
    this.projections.set(runtimeId, { ...entry, weight });
    this.projectionWeight += weight;
  }
  private cachedProjection(runtimeId: string): CachedRuntime | Omit<CachedRuntime, "weight"> {
    this.synchronizeCaches();
    const runtime = this.row("SELECT agent_id FROM execution_runtime_generations WHERE runtime_generation_id=?", runtimeId);
    if (runtime && exceededBudget(this.retainedBudget(String(runtime.agent_id)).budget)) throw new ExecutionProtocolError("retention_limit");
    const cached = this.projections.get(runtimeId);
    if (cached) {
      const current = cached.epoch === this.cacheEpoch ? cached : this.revalidateRuntime(runtimeId, cached);
      if (current) {
        this.rememberProjection(runtimeId, current);
        return current;
      }
      this.projectionWeight -= cached.weight;
      this.projections.delete(runtimeId);
    }
    const entry = { ...this.replayRuntime(runtimeId), epoch: this.cacheEpoch };
    this.rememberProjection(runtimeId, entry);
    return entry;
  }
  /**
   * An older-epoch projection is still exact when every fact it reduced is
   * still there, by the same journal key as revalidateBudget: this runtime's
   * facts are exactly the reduced ones plus those newer than its last
   * journal sequence. Those newer facts (for example from another
   * connection) are reduced on top of it, in journal order and with the same
   * native-event deduplication as a full replay. A deleted fact breaks the
   * count and the runtime replays from the start.
   */
  private revalidateRuntime(runtimeId: string, cached: CachedRuntime): Omit<CachedRuntime, "weight"> | undefined {
    const last = cached.value.lastJournalSequence;
    const key = this.required(`SELECT COUNT(*) AS seen,COALESCE(MAX(sequence),0) AS last
      FROM (SELECT sequence FROM execution_facts WHERE runtime_generation_id=? LIMIT ${MAX_RETAINED_FACTS_PER_AGENT + 1})`, runtimeId);
    const seen = Number(key.seen);
    if (seen > MAX_RETAINED_FACTS_PER_AGENT || Number(key.last) < last) return undefined;
    if (Number(key.last) === last) return seen === cached.replay.facts ? { ...cached, epoch: this.cacheEpoch } : undefined;
    const rows = this.database.prepare(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
      LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.runtime_generation_id=? AND f.sequence>? ORDER BY f.sequence
      LIMIT ${MAX_RETAINED_FACTS_PER_AGENT + 1}`).all(runtimeId, last) as Row[];
    if (cached.replay.facts + rows.length !== seen) return undefined;
    const state = { projection: cached.value.projection, unverifiedFacts: cached.value.unverifiedFacts,
      lastJournalSequence: last, replay: { ...cached.replay } };
    this.replayInto(state, rows, (row, fact) => this.firstRetainedNativeEvent(row, fact));
    return { value: { projection: state.projection, unverifiedFacts: state.unverifiedFacts, lastJournalSequence: state.lastJournalSequence },
      replay: state.replay, epoch: this.cacheEpoch };
  }
  /** The first earlier verified witness of this native event, as a full replay would have kept it. */
  private firstRetainedNativeEvent(row: Row, fact: ExecutionFact): string | undefined {
    const earlier = this.database.prepare(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
      LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.runtime_generation_id=? AND f.native_event_id=?
      AND f.domain=? AND f.kind=? AND f.turn_id IS ? AND f.execution_id IS ? AND f.sequence<? ORDER BY f.sequence`).iterate(
      fact.runtimeGenerationId, fact.nativeEventId!, fact.domain, fact.kind, "turnId" in fact ? fact.turnId : null,
      fact.domain === "execution" ? fact.executionId : null, Number(row.sequence),
    ) as Iterable<Row>;
    for (const candidate of earlier) {
      if (unverifiedHistoricalFact(candidate)) continue;
      return semanticFact(this.decodeFact(candidate));
    }
    return undefined;
  }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      // Every SQL text here is a constant of this module, so the set is
      // small; the bound only guards against a future dynamic caller.
      if (this.statements.size >= MAX_CACHED_STATEMENTS) this.statements.clear();
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  /** Reused statements: callers finish get/run synchronously and never iterate them. */
  private run(sql: string, ...values: SQLInputValue[]): void {
    this.statement(sql).run(...values);
  }
  private row(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...values) as Row | undefined;
  }
  private required(sql: string, ...values: SQLInputValue[]): Row {
    const row = this.row(sql, ...values);
    if (!row) throw new ExecutionProtocolError("identity_mismatch");
    return row;
  }
  private insert(table: string, row: Record<string, SQLInputValue>): void {
    // Table/column names are internal constants, never protocol input.
    this.run(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`,
      ...Object.values(row));
  }

  registerRuntime(value: z.input<typeof runtimeInput>): LifecycleAuthorityMode {
    const input = validated(runtimeInput, value);
    return this.transaction(() => materializeRuntimeIdentity(this.database, input));
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
      if (runtime.runtime_state === "exited" || !isTypedCaptureAuthority(runtime.authority_mode)
        || this.row(runtimeRecoveryStorageAvailable(this.database) ? `SELECT 1 FROM execution_turns t WHERE t.agent_id=? AND t.state IN ('none','active','lost')
          AND NOT EXISTS (SELECT 1 FROM agent_runtime_recoveries r WHERE r.agent_id=t.agent_id
            AND r.runtime_generation_id=t.runtime_generation_id AND r.phase IN ('stopped','complete'))`
          : "SELECT 1 FROM execution_turns WHERE agent_id=? AND state IN ('none','active','lost')", input.agentId)) {
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
      // Cursor recovery may observe a shadow-born turn from a typed-born child
      // (or the reverse); each exact runtime keeps its own frozen authority.
      if (observer.runtime_state === "exited" || !isTypedCaptureAuthority(observer.authority_mode) || !isTypedCaptureAuthority(subject.authority_mode)
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
      const recoveredBoundary = current && hasRuntimeRecoveryBoundary(this.database, input.agentId,
        String(current.observer_runtime_generation_id), input.observerRuntimeGenerationId, current.source_id as string | null);
      if (current && current.source_id === null && !recoveredBoundary) throw new ExecutionProtocolError("source_unverified");
      if (current && !recoveredBoundary && !this.row("SELECT 1 FROM execution_observer_sources WHERE agent_id=? AND source_id=?", input.agentId, current.source_id)) {
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
      if (current && !sameSource && !recoveredBoundary && Number(current.max_observed_sequence) > Number(current.last_source_sequence)) {
        throw new ExecutionProtocolError("source_gap");
      }
      const lastSourceSequence = sameSource ? Number(current.last_source_sequence) : 0;
      const maxObservedSequence = sameSource ? Number(current.max_observed_sequence) : 0;
      const epoch = input.expectedEpoch + 1;
      this.run(`INSERT INTO execution_observers(agent_id,execution_generation_id,runtime_generation_id,
        observer_execution_generation_id,observer_runtime_generation_id,daemon_generation_id,observer_epoch,
        last_source_sequence,max_observed_sequence,recovery_turn_id,bound_at_ms,source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET execution_generation_id=excluded.execution_generation_id,runtime_generation_id=excluded.runtime_generation_id,
        observer_execution_generation_id=excluded.observer_execution_generation_id,observer_runtime_generation_id=excluded.observer_runtime_generation_id,
        daemon_generation_id=excluded.daemon_generation_id,observer_epoch=excluded.observer_epoch,
        last_source_sequence=excluded.last_source_sequence,max_observed_sequence=excluded.max_observed_sequence,
        recovery_turn_id=excluded.recovery_turn_id,bound_at_ms=excluded.bound_at_ms,source_id=excluded.source_id`,
        input.agentId, subject.execution_generation_id, subject.runtime_generation_id, observer.execution_generation_id,
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
    // Most post-commit refreshes see the same retained source position. Still
    // validate the live observer and admission; the token alone is no cache of
    // authority. A no-op need not acquire SQLite's writer lock or change its
    // page/cache stamps.
    const observed = this.currentObserver(sourceId, token);
    if (latestSequence < Number(observed.last_source_sequence)) throw new ExecutionProtocolError("source_gap");
    if (latestSequence <= Number(observed.max_observed_sequence)) return;
    this.transaction(() => {
      // Another connection can replace the observer or advance its cursor
      // between the read above and BEGIN IMMEDIATE. Revalidate under the lock.
      const current = this.currentObserver(sourceId, token);
      if (latestSequence < Number(current.last_source_sequence)) throw new ExecutionProtocolError("source_gap");
      if (latestSequence <= Number(current.max_observed_sequence)) return;
      this.run("UPDATE execution_observers SET max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?", latestSequence, token.agentId);
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
    let committed: { runtime: Omit<CachedRuntime, "weight">; budget: CachedBudget } | undefined;
    const result = this.transaction<ShadowIngestion>(() => {
      const current = this.currentObserver(sourceId, token);
      if (fact.observerEpoch !== token.epoch) throw new ExecutionProtocolError("stale_observer");
      if (fact.agentId !== token.agentId) throw new ExecutionProtocolError("identity_mismatch");
      let retainedTurn: Row | undefined;
      let retainedRuntime: Row | undefined;
      if (fact.domain === "turn" || fact.domain === "execution") {
        if (fact.runtimeGenerationId !== token.runtimeGenerationId || fact.executionGenerationId !== token.executionGenerationId
          || (token.recoveryTurnId !== null && token.recoveryTurnId !== fact.turnId)) throw new ExecutionProtocolError("identity_mismatch");
        retainedTurn = this.required(`SELECT * FROM execution_turns WHERE turn_id=? AND agent_id=? AND execution_generation_id=?
          AND runtime_generation_id=? AND provider_continuation_id=? AND provider_turn_id=?`, fact.turnId, fact.agentId,
        fact.executionGenerationId, fact.runtimeGenerationId, fact.providerContinuationId, fact.providerTurnId);
        retainedRuntime = this.required("SELECT * FROM execution_runtime_generations WHERE runtime_generation_id=?", fact.runtimeGenerationId);
      } else if (fact.runtimeGenerationId !== token.observerRuntimeGenerationId || fact.executionGenerationId !== token.observerExecutionGenerationId) {
        throw new ExecutionProtocolError("identity_mismatch");
      }
      // Same rows as `fact_id=? OR (agent_id=? AND observer_epoch=? AND
      // source_sequence=?)`, in the order that OR plan returns them: fact_id
      // first, then journal order. The second probe reaches the unique
      // (runtime, epoch, source) key through the agent's own runtimes (every
      // fact's runtime belongs to its agent by foreign key) instead of
      // reading every retained fact of the agent.
      const duplicate = this.row(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
        LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.fact_id=?`, fact.factId)
        ?? this.row(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_runtime_generations r
          CROSS JOIN execution_facts f ON f.runtime_generation_id=r.runtime_generation_id AND f.observer_epoch=? AND f.source_sequence=?
          LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE r.agent_id=? AND f.agent_id=? ORDER BY f.sequence LIMIT 1`,
        fact.observerEpoch, fact.sourceSequence, fact.agentId, fact.agentId);
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
      const storedBytes = factBytes(stored);
      const budget = { facts: retained.budget.facts + 1, bytes: retained.budget.bytes + storedBytes };
      const limit = exceededBudget(budget);
      if (limit) {
        // Capture is suspended, not provider work. Remember the unaccepted
        // source position so neither rebind nor a new source can erase the gap.
        this.run("UPDATE execution_observers SET max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?", fact.sourceSequence, fact.agentId);
        return { status: "retention_limit", limit, expectedSourceSequence: expected, observedSourceSequence: fact.sourceSequence };
      }
      if (fact.sourceSequence > expected) {
        this.run("UPDATE execution_observers SET max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?", fact.sourceSequence, fact.agentId);
        return { status: "gap", expectedSourceSequence: expected, observedSourceSequence: fact.sourceSequence };
      }
      let replay = false;
      if (fact.nativeEventId !== undefined) {
        const observations = this.statement(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
          LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.runtime_generation_id=? AND f.native_event_id=?
          AND f.domain=? AND f.kind=? AND f.turn_id IS ? AND f.execution_id IS ? ORDER BY f.sequence`).all(
          fact.runtimeGenerationId, fact.nativeEventId, fact.domain, fact.kind, "turnId" in fact ? fact.turnId : null,
          fact.domain === "execution" ? fact.executionId : null,
        ) as Row[];
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
      const next = replay ? previous.value.projection : reduceParsedExecutionFact(previous.value.projection, fact);
      this.insert("execution_facts", stored);
      const journalSequence = Number(this.required("SELECT sequence FROM execution_facts WHERE fact_id=?", fact.factId).sequence);
      if (fact.domain !== "execution") {
        const subjectRuntime = retainedRuntime ?? this.required(
          "SELECT * FROM execution_runtime_generations WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=?",
          fact.agentId, fact.executionGenerationId, fact.runtimeGenerationId,
        );
        const observerRuntime = this.required(
          "SELECT * FROM execution_runtime_generations WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=?",
          fact.agentId, current.observer_execution_generation_id, current.observer_runtime_generation_id,
        );
        const effectKind = replay ? "none" : lifecycleEffectKind(fact, String(subjectRuntime.provider));
        const operational = subjectRuntime.authority_mode === "typed"
          && observerRuntime.authority_mode === "typed"
          && effectKind !== "none";
        const state = operational ? "pending"
          : subjectRuntime.authority_mode === "typed_shadow" || observerRuntime.authority_mode === "typed_shadow"
            ? "shadowed" : "applied";
        this.insert("execution_lifecycle_effects", {
          fact_id: fact.factId,
          fact_sequence: journalSequence,
          agent_id: fact.agentId,
          observer_execution_generation_id: current.observer_execution_generation_id,
          observer_runtime_generation_id: current.observer_runtime_generation_id,
          observer_epoch: fact.observerEpoch,
          subject_authority_mode: subjectRuntime.authority_mode,
          observer_authority_mode: observerRuntime.authority_mode,
          effect_kind: effectKind,
          state,
          created_at_ms: fact.observedAtMs,
          disposed_at_ms: operational ? null : fact.observedAtMs,
        });
      }
      this.recordLifecycleProjection(fact, retainedTurn, retainedRuntime);
      this.run("UPDATE execution_observers SET last_source_sequence=?,max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?",
        fact.sourceSequence, fact.sourceSequence, fact.agentId);
      if (!replay && fact.domain === "runtime") {
        this.run(`UPDATE execution_runtime_generations SET runtime_state=?,
          ended_at_ms=CASE WHEN ?='exited' THEN COALESCE(ended_at_ms,MAX(created_at_ms,?)) ELSE NULL END WHERE runtime_generation_id=?`,
        next.runtime, next.runtime, fact.observedAtMs, fact.runtimeGenerationId);
      } else if (!replay && fact.domain === "control") {
        this.run("UPDATE execution_runtime_generations SET control_state=? WHERE runtime_generation_id=?", next.control, fact.runtimeGenerationId);
      } else if (!replay && fact.domain === "continuation") {
        this.run("UPDATE execution_runtime_generations SET continuation_state=? WHERE runtime_generation_id=?", next.continuation, fact.runtimeGenerationId);
      } else if (!replay && (fact.domain === "turn" || fact.domain === "execution")) {
        const turn = next.turns.get(fact.turnId)!;
        const sideEffects = combineSideEffects(retainedTurn!.side_effects as SideEffectState, turn.sideEffects);
        if (fact.domain === "execution") {
          // Late tool outcomes cannot rewrite independent native-turn state,
          // including migrated terminals whose exact outcome remains unknown.
          this.run("UPDATE execution_turns SET side_effects=? WHERE turn_id=?", sideEffects, fact.turnId);
        } else {
          this.run(`UPDATE execution_turns SET state=?,side_effects=?,
            ended_at_ms=CASE WHEN ? IN ('terminal','lost') THEN COALESCE(ended_at_ms,MAX(created_at_ms,?)) ELSE NULL END WHERE turn_id=?`,
          turn.state, sideEffects, turn.state, fact.observedAtMs, fact.turnId);
        }
      }
      // Capture under the write transaction, never bless an external commit
      // racing after COMMIT. Publish this candidate to the cache only on success.
      // The candidate becomes current only if COMMIT succeeds; transaction()
      // then records this write's stamp, so later foreign writes still show.
      committed = {
        runtime: { value: { projection: next, unverifiedFacts: previous.value.unverifiedFacts, lastJournalSequence: journalSequence },
          replay: { facts: previous.replay.facts + 1, bytes: previous.replay.bytes + storedBytes }, epoch: this.cacheEpoch },
        budget: { budget, windowStart: retained.windowStart, last: journalSequence, epoch: this.cacheEpoch },
      };
      return {
        status: replay ? "duplicate" : "accepted", journalSequence,
        gapPending: Number(current.max_observed_sequence) > fact.sourceSequence,
      };
    });
    if (committed) {
      this.rememberProjection(fact.runtimeGenerationId, committed.runtime);
      this.rememberBudget(fact.agentId, committed.budget);
    }
    return result;
  }

  recordLegacyLifecycle(value: LifecycleProjectionObservation): void {
    this.lifecycleProjection.recordLegacy(value);
  }

  recordLifecycleProjectionUnavailable(provider: LifecycleProjectionProvider, count: number): void {
    this.lifecycleProjection.recordUnavailable(provider, count);
  }

  lifecycleProjectionDiagnostics(): LifecycleProjectionDiagnostics {
    return this.lifecycleProjection.diagnostics();
  }

  private recordLifecycleProjection(fact: ExecutionFact, retainedTurn: Row | undefined, retainedRuntime: Row | undefined): void {
    if (fact.domain !== "turn" || fact.nativeEventId === undefined
      || (fact.state !== "active" && fact.state !== "terminal") || !retainedTurn || !retainedRuntime) return;
    const provider = String(retainedRuntime.provider);
    if (!(["codex", "claude-code", "cursor", "open-model"] as const).includes(provider as LifecycleProjectionProvider)) return;
    const generation = this.required(`SELECT workspace_id FROM execution_attempt_generations
      WHERE attempt_id=? AND execution_generation_id=? AND agent_id=?`, retainedTurn.attempt_id,
    fact.executionGenerationId, fact.agentId);
    this.lifecycleProjection.recordTypedInCurrentTransaction({
      agentId: fact.agentId,
      provider: provider as LifecycleProjectionProvider,
      workAttemptId: String(generation.workspace_id),
      executionGenerationId: fact.executionGenerationId,
      nativeEventId: fact.nativeEventId,
      phase: fact.state === "active" ? "turn_active" : "turn_terminal",
      state: fact.state === "active" ? "working" : "terminal",
    });
  }

  /**
   * Whether the agent's record holds more facts than one window's worth: it
   * has rolled over at a recovery boundary into a later window.
   */
  private recordRolledOver(agentId: string): boolean {
    return Boolean(this.row(`SELECT 1 FROM execution_facts INDEXED BY execution_facts_agent_sequence
      WHERE agent_id=? ORDER BY sequence DESC LIMIT 1 OFFSET ${MAX_RETAINED_FACTS_PER_AGENT}`, agentId));
  }

  /** A bounded, coherent view of retained evidence, never provider authority. */
  retainedMessageExecution(agentId: string, roomId: string, sourceMessageId: string): RetainedExecutionDetail {
    let ownsSnapshot = false;
    try {
      validated(id, agentId); validated(id, roomId); validated(id, sourceMessageId);
      if (!this.database.isTransaction) { this.database.exec("BEGIN"); ownsSnapshot = true; }
      this.clearProjections();
      if (exceededBudget(this.retainedBudget(agentId).budget)) throw new ExecutionProtocolError("retention_limit");
      // Bound the driving relation before filtering. Approval-only identities
      // are not capped; starting from turns would make LIMIT 33 an output-only bound.
      // A record that has rolled over into later windows holds more facts than
      // that bound, and a message in an earlier window is then found through
      // its own turns instead, or it would read as never saved.
      const rows = (this.recordRolledOver(agentId) ? this.database.prepare(`SELECT DISTINCT t.turn_id,t.runtime_generation_id,t.created_at_ms
        FROM execution_message_attempts a
        CROSS JOIN execution_turns t ON t.agent_id=a.agent_id AND t.attempt_id=a.attempt_id AND t.room_id=a.room_id
        CROSS JOIN execution_attempt_generations g ON g.attempt_id=a.attempt_id AND g.execution_generation_id=t.execution_generation_id
          AND g.agent_id=a.agent_id AND g.room_id=a.room_id
        WHERE a.agent_id=? AND a.room_id=? AND a.source_message_id=?
          AND EXISTS (SELECT 1 FROM execution_facts f INDEXED BY execution_facts_turn_sequence WHERE f.turn_id=t.turn_id
            AND f.agent_id=t.agent_id AND f.runtime_generation_id=t.runtime_generation_id AND f.domain IN ('turn','execution'))
        ORDER BY t.created_at_ms DESC,t.turn_id DESC LIMIT 33`).all(agentId, roomId, sourceMessageId)
        : this.database.prepare(`WITH captured AS MATERIALIZED (
          SELECT agent_id,turn_id,runtime_generation_id,domain FROM execution_facts
          INDEXED BY execution_facts_agent_sequence WHERE agent_id=? ORDER BY sequence DESC LIMIT ${MAX_RETAINED_FACTS_PER_AGENT}
        ) SELECT DISTINCT t.turn_id,t.runtime_generation_id,t.created_at_ms FROM captured f
        CROSS JOIN execution_turns t ON t.turn_id=f.turn_id AND t.agent_id=f.agent_id AND t.runtime_generation_id=f.runtime_generation_id
        CROSS JOIN execution_message_attempts a ON a.attempt_id=t.attempt_id AND a.agent_id=t.agent_id AND a.room_id=t.room_id
        CROSS JOIN execution_attempt_generations g ON g.attempt_id=a.attempt_id AND g.execution_generation_id=t.execution_generation_id
          AND g.agent_id=a.agent_id AND g.room_id=a.room_id
        WHERE f.domain IN ('turn','execution') AND a.room_id=? AND a.source_message_id=?
        ORDER BY t.created_at_ms DESC,t.turn_id DESC LIMIT 33`).all(agentId, roomId, sourceMessageId)) as Row[];
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
          const recovered = recoveredRuntime(this.database, agentId, runtimeId);
          evidenceIncomplete ||= recovered?.incomplete ?? false;
          const turn = runtime.projection.turns.get(String(row.turn_id));
          if (!turn) { evidenceIncomplete = true; continue; }
          const operations = [...turn.operations.entries()].slice(0, operationsLeft).map(([executionId, operation]) => ({
            executionId, operation: operation.operation, outcome: operation.outcome, startObserved: operation.startObserved,
            outputBytes: operation.outputBytes, sideEffects: operation.sideEffects, exitCode: operation.exitCode, signalNumber: operation.signalNumber,
          }));
          if (operations.length < turn.operations.size) truncated = true;
          operationsLeft -= operations.length;
          const lost = Boolean(recovered && turn.state !== "terminal");
          evidenceIncomplete ||= lost;
          turns.push({ turnId: turn.turnId, state: lost ? "lost" : turn.state, outcome: turn.outcome, operations });
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

  /**
   * Room-safe recorded evidence, not liveness or permission to publish it.
   * Aggregate the retained journal, not the Inspector's truncated display.
   * The caller must separately establish cloud receipt/publisher custody.
   */
  roomWorkSummary(agentId: string, roomId: string, sourceMessageId: string): CapturedRoomWorkSummary {
    let ownsSnapshot = false;
    try {
      validated(id, agentId); validated(id, roomId); validated(id, sourceMessageId);
      if (!this.database.isTransaction) { this.database.exec("BEGIN"); ownsSnapshot = true; }
      this.clearProjections();
      if (exceededBudget(this.retainedBudget(agentId).budget)) throw new ExecutionProtocolError("retention_limit");
      const attempt = this.row("SELECT attempt_id,state,conclusion FROM execution_message_attempts WHERE agent_id=? AND room_id=? AND source_message_id=?",
        agentId, roomId, sourceMessageId);
      let result: CapturedRoomWorkSummary = { availability: "not_captured" };
      if (attempt) {
        const observer = this.row("SELECT source_id,last_source_sequence,max_observed_sequence FROM execution_observers WHERE agent_id=?", agentId);
        let incomplete = !observer || observer.source_id === null || Number(observer.max_observed_sequence) > Number(observer.last_source_sequence);
        const counts = Object.fromEntries(ROOM_WORK_OPERATION_OUTCOMES.map(outcome => [outcome, 0])) as RoomAgentWorkSummary["operation_counts"];
        let captured = false;
        let runtimeRows: Row[] = [];
        const summarizeRuntime = () => {
          const selected = new Set(runtimeRows.filter(row => row.message_attempt_id === attempt.attempt_id
            && (row.domain === "turn" || row.domain === "execution")).map(row => String(row.turn_id)));
          if (!selected.size) return;
          captured = true;
          const runtime = this.replayRows(runtimeRows);
          incomplete ||= runtime.unverifiedFacts > 0;
          // Only a runtime's most recent window's worth is replayed: what it recorded before then is not counted.
          incomplete ||= Number(runtimeRows[0]!.runtime_facts ?? 0) > MAX_RETAINED_FACTS_PER_AGENT;
          const recovered = recoveredRuntime(this.database, agentId, String(runtimeRows[0]!.runtime_generation_id));
          incomplete ||= recovered?.incomplete ?? false;
          for (const turnId of selected) {
            const turn = runtime.projection.turns.get(turnId);
            if (!turn) { incomplete = true; continue; }
            incomplete ||= Boolean(recovered && turn.state !== "terminal");
            for (const operation of turn.operations.values()) counts[operation.outcome ?? "unresolved"]++;
          }
        };
        // Bound facts before joins. Approval-only turn identities have no fact
        // cap and must never become the driving relation. Grouping once avoids
        // an N+1 full runtime replay for messages spanning many generations.
        // A record that has rolled over into later windows is read for the
        // runtimes this message ran on, each up to one window's worth of its
        // most recent facts, as a runtime's replay needs: a message in an
        // earlier window would otherwise read as never saved.
        const rows = (this.recordRolledOver(agentId) ? this.database.prepare(`WITH runtimes AS MATERIALIZED (
            SELECT DISTINCT runtime_generation_id FROM execution_turns WHERE agent_id=? AND attempt_id=?
          ), recent AS MATERIALIZED (
            SELECT * FROM (SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.runtime_generation_id ORDER BY f.sequence DESC) AS recency,
                COUNT(*) OVER (PARTITION BY f.runtime_generation_id) AS runtime_facts
              FROM execution_facts f INDEXED BY execution_facts_agent_sequence
              WHERE f.agent_id=? AND f.runtime_generation_id IN (SELECT runtime_generation_id FROM runtimes))
            WHERE recency <= ${MAX_RETAINED_FACTS_PER_AGENT}
          ) SELECT f.*,t.provider_continuation_id,t.provider_turn_id,t.attempt_id AS message_attempt_id
          FROM recent f LEFT JOIN execution_turns t ON t.turn_id=f.turn_id AND t.agent_id=f.agent_id
            AND t.execution_generation_id=f.execution_generation_id AND t.runtime_generation_id=f.runtime_generation_id
          ORDER BY f.runtime_generation_id,f.sequence`).iterate(agentId, attempt.attempt_id, agentId)
          : this.database.prepare(`WITH captured AS MATERIALIZED (
            SELECT * FROM execution_facts INDEXED BY execution_facts_agent_sequence
            WHERE agent_id=? ORDER BY sequence DESC LIMIT ${MAX_RETAINED_FACTS_PER_AGENT}
          ) SELECT f.*,t.provider_continuation_id,t.provider_turn_id,t.attempt_id AS message_attempt_id
          FROM captured f LEFT JOIN execution_turns t ON t.turn_id=f.turn_id AND t.agent_id=f.agent_id
            AND t.execution_generation_id=f.execution_generation_id AND t.runtime_generation_id=f.runtime_generation_id
          ORDER BY f.runtime_generation_id,f.sequence`).iterate(agentId)) as Iterable<Row>;
        for (const row of rows) {
          if (runtimeRows.length && runtimeRows[0]!.runtime_generation_id !== row.runtime_generation_id) {
            summarizeRuntime(); runtimeRows = [];
          }
          runtimeRows.push(row);
        }
        summarizeRuntime();
        if (captured) {
          const state = attempt.state === "cleanly_concluded"
            ? attempt.conclusion === "replied" ? "completed" : "completed_no_reply" : attempt.state;
          const summary = parseRoomAgentWorkSummary({ version: 1, recorded_state: state, evidence_incomplete: incomplete,
            // Neither message creation nor reply-publication time is an exact
            // execution duration. Do not manufacture revisions from a clock.
            elapsed_ms: null, operation_counts: counts });
          if (!summary) throw new ExecutionProtocolError("invalid_fact");
          result = { availability: "available", attemptId: String(attempt.attempt_id), summary };
        }
      }
      if (ownsSnapshot) { this.database.exec("COMMIT"); ownsSnapshot = false; }
      return result;
    } catch {
      if (ownsSnapshot) { try { this.database.exec("ROLLBACK"); } catch { /* Optional read isolation. */ } }
      return { availability: "unavailable" };
    } finally { this.clearProjections(); }
  }

  /** History from v18 without typed terminal proof stays explicitly unverified. */
  projectRuntime(runtimeGenerationId: string): RuntimeProjection {
    validated(id, runtimeGenerationId);
    // The connection is caller-owned. Never cache a caller's uncommitted view:
    // its later ROLLBACK need not change SQLite's total_changes counter.
    if (this.database.isTransaction) {
      this.clearProjections();
      try { return this.replayRuntime(runtimeGenerationId).value; }
      finally { this.clearProjections(); }
    }
    // Capacity is agent-wide, replay is runtime-specific. Both must see the
    // same snapshot when another connection appends to a different runtime.
    this.database.exec("BEGIN");
    try {
      // ReadonlyMap is compile-time only; no public object may alias cache state.
      const result = structuredClone(this.cachedProjection(runtimeGenerationId).value);
      const stamp = this.databaseStamp();
      this.database.exec("COMMIT");
      // Never bless a concurrent writer's newer stamp after releasing our view.
      this.cacheStamp = stamp;
      return result;
    } catch (error) { this.clearProjections(); this.database.exec("ROLLBACK"); throw error; }
  }

  private replayRuntime(runtimeGenerationId: string): { value: RuntimeProjection; replay: RetainedBudget } {
    const runtime = this.row("SELECT agent_id FROM execution_runtime_generations WHERE runtime_generation_id=?", runtimeGenerationId);
    if (runtime && exceededBudget(this.retainedBudget(String(runtime.agent_id)).budget)) throw new ExecutionProtocolError("retention_limit");
    const facts = this.database.prepare(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
      LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.runtime_generation_id=? ORDER BY f.sequence LIMIT ${MAX_RETAINED_FACTS_PER_AGENT + 1}`)
      .iterate(runtimeGenerationId) as Iterable<Row>;
    const state = this.replayFrom(facts);
    return { value: { projection: state.projection, unverifiedFacts: state.unverifiedFacts, lastJournalSequence: state.lastJournalSequence },
      replay: state.replay };
  }

  /** Both host detail and room counts use the same typed replay and deduplication. */
  private replayRows(facts: Iterable<Row>): RuntimeProjection {
    const { projection, unverifiedFacts, lastJournalSequence } = this.replayFrom(facts);
    return { projection, unverifiedFacts, lastJournalSequence };
  }

  private replayFrom(facts: Iterable<Row>): ReplayState {
    const state: ReplayState = { projection: emptyExecutionProjection(), unverifiedFacts: 0, lastJournalSequence: 0, replay: { facts: 0, bytes: 0 } };
    const nativeEvents = new Map<string, string>();
    this.replayInto(state, facts, (_row, _fact, key, semantic) => {
      const previous = nativeEvents.get(key);
      if (previous === undefined) nativeEvents.set(key, semantic);
      return previous;
    });
    return state;
  }

  /**
   * Reduce journal rows in sequence order onto `state`. `earlier` returns the
   * first earlier verified witness of the same native event, if any: a later
   * witness must match it and is then skipped, never reduced twice.
   */
  private replayInto(state: ReplayState, facts: Iterable<Row>,
    earlier: (row: Row, fact: ExecutionFact, key: string, semantic: string) => string | undefined): void {
    for (const row of facts) {
      state.replay.facts++;
      state.replay.bytes += factBytes(row);
      if (exceededBudget(state.replay)) throw new ExecutionProtocolError("retention_limit");
      state.lastJournalSequence = Number(row.sequence);
      if (unverifiedHistoricalFact(row)) {
        state.unverifiedFacts += 1;
        continue;
      }
      const fact = this.decodeFact(row);
      const key = nativeEventKey(fact);
      if (key !== null) {
        const semantic = semanticFact(fact);
        const previous = earlier(row, fact, key, semantic);
        if (previous !== undefined) {
          if (previous !== semantic) throw new ExecutionProtocolError("sequence_conflict");
          continue;
        }
      }
      state.projection = reduceParsedExecutionFact(state.projection, fact);
    }
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
