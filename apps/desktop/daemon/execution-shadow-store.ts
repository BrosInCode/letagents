import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";

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
  expectedEpoch: time, boundAtMs: time, recovery: nativeTurnIdentity.optional(),
});
export type ShadowObserver = Readonly<{
  agentId: string; runtimeGenerationId: string; executionGenerationId: string;
  observerRuntimeGenerationId: string; observerExecutionGenerationId: string;
  daemonGenerationId: string; epoch: number; recoveryTurnId: string | null;
}>;
export type ShadowIngestion =
  | { status: "accepted" | "duplicate"; journalSequence: number; gapPending: boolean }
  | { status: "gap"; expectedSourceSequence: number; observedSourceSequence: number };

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

/**
 * Structural shadow journal only. No production caller is installed in PR2B.
 * This class owns neither the connection nor provider/delivery authority. Its
 * writes are restricted to execution_* tables; no handles for effects exist.
 */
export class ExecutionShadowStore {
  private readonly observers = new WeakSet<ShadowObserver>();
  constructor(private readonly database: DatabaseSync) {}

  private transaction<T>(body: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
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
      const generation = this.row("SELECT * FROM execution_generations WHERE execution_generation_id=?", input.executionGenerationId);
      if (generation && generation.agent_id !== input.agentId) throw new ExecutionProtocolError("identity_mismatch");
      if (!generation) this.insert("execution_generations", {
        execution_generation_id: input.executionGenerationId, agent_id: input.agentId, created_at_ms: input.createdAtMs,
      });
      const existing = this.row("SELECT * FROM execution_runtime_generations WHERE runtime_generation_id=?", input.runtimeGenerationId);
      if (existing) {
        if (existing.agent_id !== input.agentId || existing.execution_generation_id !== input.executionGenerationId
          || existing.provider !== input.provider || existing.config_revision !== input.configRevision || existing.authority_mode !== "typed_shadow") {
          throw new ExecutionProtocolError("identity_mismatch");
        }
        return;
      }
      this.insert("execution_runtime_generations", {
        runtime_generation_id: input.runtimeGenerationId, execution_generation_id: input.executionGenerationId,
        agent_id: input.agentId, provider: input.provider, config_revision: input.configRevision, authority_mode: "typed_shadow",
        runtime_state: "starting", control_state: "connecting", continuation_state: "available", created_at_ms: input.createdAtMs,
      });
    });
  }

  trackMessage(value: z.input<typeof attemptInput>): string {
    const input = validated(attemptInput, value);
    return this.transaction(() => {
      this.required("SELECT 1 FROM execution_generations WHERE agent_id=? AND execution_generation_id=?", input.agentId, input.executionGenerationId);
      let attempt = this.row("SELECT * FROM execution_message_attempts WHERE agent_id=? AND room_id=? AND source_message_id=?",
        input.agentId, input.roomId, input.sourceMessageId);
      if (!attempt) {
        attempt = {
          attempt_id: randomUUID(), agent_id: input.agentId, room_id: input.roomId, source_message_id: input.sourceMessageId,
          state: "active", created_at_ms: input.createdAtMs,
        };
        this.insert("execution_message_attempts", attempt);
      }
      const attemptId = String(attempt.attempt_id);
      const bound = this.row("SELECT * FROM execution_attempt_generations WHERE attempt_id=? AND execution_generation_id=?", attemptId, input.executionGenerationId);
      if (bound && bound.workspace_id !== input.workspaceId) throw new ExecutionProtocolError("identity_mismatch");
      if (!bound) {
        if (attempt.state !== "active") throw new ExecutionProtocolError("attempt_settled");
        this.insert("execution_attempt_generations", {
          attempt_id: attemptId, agent_id: input.agentId, room_id: input.roomId, execution_generation_id: input.executionGenerationId,
          workspace_id: input.workspaceId, created_at_ms: input.createdAtMs,
        });
      }
      return attemptId;
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
        if (existing.attempt_id !== input.attemptId || existing.agent_id !== input.agentId || existing.room_id !== input.roomId
          || existing.execution_generation_id !== input.executionGenerationId || existing.runtime_generation_id !== input.runtimeGenerationId
          || existing.provider_continuation_id !== input.providerContinuationId || existing.provider_turn_id !== input.providerTurnId) {
          throw new ExecutionProtocolError("identity_mismatch");
        }
        return;
      }
      if (attempt.state !== "active") throw new ExecutionProtocolError("attempt_settled");
      if (runtime.runtime_state === "exited" || runtime.authority_mode !== "typed_shadow"
        || this.row("SELECT 1 FROM execution_turns WHERE agent_id=? AND state IN ('none','active','lost')", input.agentId)) {
        throw new ExecutionProtocolError("invalid_transition");
      }
      this.insert("execution_turns", {
        turn_id: input.turnId, attempt_id: input.attemptId, agent_id: input.agentId, room_id: input.roomId,
        execution_generation_id: input.executionGenerationId, runtime_generation_id: input.runtimeGenerationId,
        provider_continuation_id: input.providerContinuationId, provider_turn_id: input.providerTurnId,
        state: "none", side_effects: "none", created_at_ms: input.createdAtMs,
      });
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
      const epoch = input.expectedEpoch + 1;
      this.database.prepare(`INSERT INTO execution_observers(agent_id,execution_generation_id,runtime_generation_id,
        observer_execution_generation_id,observer_runtime_generation_id,daemon_generation_id,observer_epoch,
        last_source_sequence,max_observed_sequence,recovery_turn_id,bound_at_ms) VALUES(?,?,?,?,?,?,?,0,0,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET execution_generation_id=excluded.execution_generation_id,runtime_generation_id=excluded.runtime_generation_id,
        observer_execution_generation_id=excluded.observer_execution_generation_id,observer_runtime_generation_id=excluded.observer_runtime_generation_id,
        daemon_generation_id=excluded.daemon_generation_id,observer_epoch=excluded.observer_epoch,last_source_sequence=0,max_observed_sequence=0,
        recovery_turn_id=excluded.recovery_turn_id,bound_at_ms=excluded.bound_at_ms`)
        .run(input.agentId, subject.execution_generation_id, subject.runtime_generation_id, observer.execution_generation_id,
          observer.runtime_generation_id, input.daemonGenerationId, epoch, input.recovery?.turnId ?? null, input.boundAtMs);
      return Object.freeze({
        agentId: input.agentId, runtimeGenerationId: String(subject.runtime_generation_id), executionGenerationId: String(subject.execution_generation_id),
        observerRuntimeGenerationId: String(observer.runtime_generation_id), observerExecutionGenerationId: String(observer.execution_generation_id),
        daemonGenerationId: input.daemonGenerationId, epoch, recoveryTurnId: input.recovery?.turnId ?? null,
      });
    });
    this.observers.add(token);
    return token;
  }

  ingest(token: ShadowObserver, value: unknown): ShadowIngestion {
    const fact = parseExecutionFact(value);
    if (!this.observers.has(token)) throw new ExecutionProtocolError("stale_observer");
    return this.transaction(() => {
      const current = this.required("SELECT * FROM execution_observers WHERE agent_id=?", token.agentId);
      if (current.observer_epoch !== token.epoch || current.daemon_generation_id !== token.daemonGenerationId
        || current.observer_runtime_generation_id !== token.observerRuntimeGenerationId || fact.observerEpoch !== token.epoch) {
        throw new ExecutionProtocolError("stale_observer");
      }
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
        return { status: "duplicate", journalSequence: Number(duplicate.sequence), gapPending: Number(current.max_observed_sequence) > Number(current.last_source_sequence) };
      }
      const expected = Number(current.last_source_sequence) + 1;
      if (fact.sourceSequence < expected) throw new ExecutionProtocolError("sequence_conflict");
      if (fact.sourceSequence > expected) {
        this.database.prepare("UPDATE execution_observers SET max_observed_sequence=MAX(max_observed_sequence,?) WHERE agent_id=?")
          .run(fact.sourceSequence, fact.agentId);
        return { status: "gap", expectedSourceSequence: expected, observedSourceSequence: fact.sourceSequence };
      }
      let replay = false;
      if (fact.nativeEventId !== undefined) {
        const observations = this.database.prepare(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
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
      const previous = this.projectRuntime(fact.runtimeGenerationId);
      const next = replay ? previous.projection : reduceExecutionFact(previous.projection, fact);
      this.insert("execution_facts", {
        fact_id: fact.factId, agent_id: fact.agentId, execution_generation_id: fact.executionGenerationId, runtime_generation_id: fact.runtimeGenerationId,
        observer_epoch: fact.observerEpoch, source_sequence: fact.sourceSequence, native_event_id: fact.nativeEventId ?? null,
        turn_id: "turnId" in fact ? fact.turnId : null, execution_id: fact.domain === "execution" ? fact.executionId : null,
        domain: fact.domain, kind: fact.kind, state: "state" in fact ? fact.state : null,
        operation: fact.domain === "execution" ? fact.operation : null, outcome: "outcome" in fact ? fact.outcome : null,
        side_effects: fact.sideEffects, output_bytes: "outputBytes" in fact ? fact.outputBytes : null,
        exit_code: "exitCode" in fact ? fact.exitCode ?? null : null, signal_number: "signalNumber" in fact ? fact.signalNumber ?? null : null,
        observed_at_ms: fact.observedAtMs, turn_outcome: "turnOutcome" in fact ? fact.turnOutcome ?? null : null,
        control_evidence: "controlEvidence" in fact ? fact.controlEvidence ?? null : null,
      });
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
      return {
        status: replay ? "duplicate" : "accepted", journalSequence: Number(this.required("SELECT sequence FROM execution_facts WHERE fact_id=?", fact.factId).sequence),
        gapPending: Number(current.max_observed_sequence) > fact.sourceSequence,
      };
    });
  }

  /** History from v18 without typed terminal proof stays explicitly unverified. */
  projectRuntime(runtimeGenerationId: string): { projection: ExecutionProjection; unverifiedFacts: number; lastJournalSequence: number } {
    validated(id, runtimeGenerationId);
    const facts = this.database.prepare(`SELECT f.*,t.provider_continuation_id,t.provider_turn_id FROM execution_facts f
      LEFT JOIN execution_turns t ON t.turn_id=f.turn_id WHERE f.runtime_generation_id=? ORDER BY f.sequence`).all(runtimeGenerationId) as Row[];
    let projection = emptyExecutionProjection();
    let unverifiedFacts = 0;
    const nativeEvents = new Map<string, string>();
    for (const row of facts) {
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
    return { projection, unverifiedFacts, lastJournalSequence: Number(facts.at(-1)?.sequence ?? 0) };
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
