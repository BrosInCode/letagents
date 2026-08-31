import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { NativeExecutionObservation, NativeExecutionSubscription } from "../shared/execution-protocol.js";
import { ExecutionProtocolError, executionIdentity, type NativeTurnIdentity } from "./execution-protocol.js";
import { ExecutionShadowStore, type ShadowObserver } from "./execution-shadow-store.js";
import { openDaemonStateObservationDatabase } from "./daemon-state-database.js";
import { sameProviderActionConnectionIdentity, type ProviderActionConnectionRef, type ProviderActionHandle, type ProviderActionPort } from "./provider-action-port.js";

type Row = Record<string, string | number | null>;
type CaptureCode = "source_gap" | "identity_unavailable" | "storage_unavailable" | "retention_limit" | "invalid_observation";
type Runtime = { id: string; generation: string };
type CaptureOptions = {
  provider: Pick<ProviderActionPort, "onExecution">;
  currentHandle(agentId: string): ProviderActionHandle | undefined;
  daemonGeneration(): number;
  diagnostic(agentId: string, code: CaptureCode): void;
};
type Lane = {
  agentId: string; generation: string; handle: ProviderActionHandle;
  subscription: NativeExecutionSubscription | null; observer: ShadowObserver | null;
  pending: Map<number, { event: NativeExecutionObservation; bytes: number }>; bytes: number;
  checkpoints: Map<string, PreparedRuntime>; overflow: boolean; suspended: boolean; diagnostic: CaptureCode | null;
  detached: boolean; frontierStored: boolean; verifiedRuntime: Runtime | null;
  subscriptionFailed: boolean;
};
export type PreparedRuntime = {
  agentId: string; executionGenerationId: string; handle: ProviderActionHandle;
  /** Supplied only by the successful exact prepared-wrapper checkpoint. */
  connection: ProviderActionConnectionRef; configurationRevision: number;
};
const QUEUE_FACTS = 256;
const QUEUE_BYTES = 256 * 1024;
const BATCH_FACTS = 32;
function opaque(kind: string, ...identity: string[]): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}
function runtimeId(agentId: string, generation: string, kind: string, birth: string): string {
  return opaque("runtime", agentId, generation, kind, birth);
}

/**
 * Optional structural capture. Provider callbacks only enqueue bounded data;
 * scheduled, fail-fast SQLite work cannot reject an operational checkpoint.
 * Neither raw streams nor provider/delivery control handles are consumed here.
 */
export class ExecutionCaptureCoordinator {
  private readonly store: ExecutionShadowStore;
  private readonly lanes = new Map<string, Lane>();
  private readonly retiring = new Map<string, Lane>();
  private readonly suspendedAgents = new Set<string>();
  private readonly dirty = new Set<Lane>();
  private scheduled: NodeJS.Immediate | null = null;
  private closed = false;

  /** Production capture is optional; opening failure cannot prevent daemon startup. */
  static open(path: string, provider: CaptureOptions["provider"] | undefined,
    options: Omit<CaptureOptions, "diagnostic" | "provider">): ExecutionCaptureCoordinator | null {
    if (!provider?.onExecution) return null;
    try {
      return new ExecutionCaptureCoordinator(openDaemonStateObservationDatabase(path), {
        ...options, provider, diagnostic: (agentId, code) => console.warn("[execution_capture]", JSON.stringify({ agentId, code })),
      });
    } catch { console.warn("[execution_capture] storage_unavailable"); return null; }
  }

  constructor(private readonly database: DatabaseSync, private readonly options: CaptureOptions) {
    this.store = new ExecutionShadowStore(database);
  }

  /** Does not await adapter loading/subscription or execute any SQLite. */
  install(agentId: string, handle: ProviderActionHandle, generation: string): () => void {
    const prior = this.lanes.get(agentId);
    if (prior) this.detach(prior);
    if (this.closed || this.suspendedAgents.has(agentId) || !this.options.provider.onExecution) return () => {};
    const lane: Lane = { agentId, generation, handle, subscription: null, observer: null,
      pending: new Map(), bytes: 0, checkpoints: new Map(), overflow: false, suspended: false, diagnostic: null,
      detached: false, frontierStored: false, verifiedRuntime: null, subscriptionFailed: false };
    this.lanes.set(agentId, lane);
    // Installation follows the provider's durable dispatch/configuration
    // checkpoint. Preserve its attested birth before an immediate exit or a
    // successor can replace the operational manifest reference.
    if (handle.providerConnection && handle.appliedConfigurationRevision !== undefined) {
      this.prepared({ agentId, executionGenerationId: generation, handle,
        connection: handle.providerConnection, configurationRevision: handle.appliedConfigurationRevision });
    }
    void Promise.resolve().then(() => this.current(lane)
      ? this.options.provider.onExecution!(handle, event => this.enqueue(lane, event)) : null)
      .then(subscription => {
        if (!subscription) return;
        if (!this.owns(lane)) { subscription.dispose(); return; }
        lane.subscription = lane.detached ? this.freezeSubscription(subscription) : subscription;
        this.schedule(lane);
      }).catch(() => {
        lane.subscriptionFailed = true;
        if (this.current(lane)) {
          this.report(lane, "identity_unavailable");
          if (lane.detached && !lane.pending.size) { this.remove(lane); this.refresh(); }
        }
      });
    return () => this.detach(lane);
  }

  /** A post-COMMIT hint only schedules work; it cannot reject that checkpoint. */
  refresh(): void {
    for (const lane of this.retiring.values()) this.schedule(lane);
    for (const lane of this.lanes.values()) this.schedule(lane);
  }

  private schedule(lane: Lane): void {
    if (!this.current(lane) || lane.suspended && !lane.detached) return;
    this.dirty.add(lane);
    if (this.closed || this.scheduled) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      const next = this.dirty.values().next().value;
      if (!next) return;
      this.dirty.delete(next);
      if (this.current(next) && next.subscription && (!next.suspended || next.detached)
        && (next.detached || !this.retiring.has(next.agentId))) {
        try {
          if (this.drain(next)) this.dirty.add(next);
          else if (next.detached && next.frontierStored) {
            this.remove(next);
            const successor = this.lanes.get(next.agentId);
            if (successor) this.dirty.add(successor);
          }
        }
        catch (error) {
          if (error instanceof ExecutionProtocolError) next.suspended = true;
          this.report(next, error instanceof ExecutionProtocolError && error.code === "retention_limit"
            ? "retention_limit" : error instanceof ExecutionProtocolError && error.code === "source_gap"
              ? "source_gap" : error instanceof ExecutionProtocolError ? "invalid_observation" : "storage_unavailable");
        }
      }
      for (const candidate of this.dirty) if (!this.current(candidate) || candidate.suspended && !candidate.detached) this.dirty.delete(candidate);
      const pending = this.dirty.values().next().value;
      if (pending) this.schedule(pending);
    });
    this.scheduled.unref();
  }

  /** Retains the verified birth even if Cursor advances to idle before capture runs. */
  prepared(checkpoint: PreparedRuntime): void {
    const lane = this.lanes.get(checkpoint.agentId);
    if (!lane || !this.current(lane) || lane.suspended || lane.handle !== checkpoint.handle || lane.generation !== checkpoint.executionGenerationId) return;
    const birth = checkpoint.connection.processIdentity;
    if (!birth || checkpoint.connection.pid === null) return;
    if (lane.checkpoints.size >= QUEUE_FACTS && !lane.checkpoints.has(birth)) lane.overflow = true;
    else lane.checkpoints.set(birth, { ...checkpoint, connection: { ...checkpoint.connection } });
    this.schedule(lane);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = null;
    this.dirty.clear();
    const closing = [...this.retiring.values(), ...this.lanes.values()];
    const frontiers = new Map<string, { lane: Lane; source: string; latest: number; token: ShadowObserver | null }>();
    for (const lane of closing) {
      if (!lane.subscription) continue;
      try {
        const subscription = this.freezeSubscription(lane.subscription);
        lane.subscription = subscription;
        const key = JSON.stringify([lane.agentId, subscription.sourceId]);
        const previous = frontiers.get(key);
        const token = lane.observer?.sourceId === subscription.sourceId ? lane.observer : null;
        frontiers.set(key, { lane, source: subscription.sourceId,
          latest: Math.max(previous?.latest ?? 0, subscription.position().latestSequence),
          token: (token?.epoch ?? 0) > (previous?.token?.epoch ?? 0) ? token : previous?.token ?? null });
      } catch { this.report(lane, "identity_unavailable"); }
    }
    // Best-effort shutdown also runs after singleton fence loss. Only an
    // already-admitted observer's CAS can preserve its final watermark; never
    // mint identity or drain work here. Stale/unadmitted/busy stays unavailable.
    for (const { lane, source, latest, token } of frontiers.values()) {
      if (!token) { this.report(lane, "identity_unavailable"); continue; }
      try { this.store.observeSourcePosition(source, token, latest); }
      catch { this.report(lane, "storage_unavailable"); }
    }
    for (const lane of closing) this.remove(lane);
    try { this.database.close(); } catch { console.warn("[execution_capture] close_failed"); }
  }

  private current(lane: Lane): boolean {
    return this.owns(lane) && (lane.detached || this.options.currentHandle(lane.agentId) === lane.handle);
  }
  private owns(lane: Lane): boolean {
    return !this.closed && (this.lanes.get(lane.agentId) === lane || this.retiring.get(lane.agentId) === lane);
  }
  private freezeSubscription(subscription: NativeExecutionSubscription): NativeExecutionSubscription {
    const position = subscription.position();
    try { subscription.dispose(); } catch { /* optional observation cleanup */ }
    return { sourceId: subscription.sourceId, position: () => position, dispose: () => {} };
  }
  private detach(lane: Lane): void {
    if (!this.owns(lane) || lane.detached) return;
    lane.detached = true;
    lane.frontierStored = false;
    if (lane.subscription) lane.subscription = this.freezeSubscription(lane.subscription);
    this.lanes.delete(lane.agentId);
    if (lane.subscriptionFailed && !lane.pending.size) { this.remove(lane); return; }
    if (this.retiring.has(lane.agentId)) {
      // Never accumulate an unbounded retirement queue or silently skip an
      // intermediate source. Operational replacement continues independently.
      this.suspendedAgents.add(lane.agentId);
      this.report(lane, "source_gap");
      this.remove(lane);
      return;
    }
    this.retiring.set(lane.agentId, lane);
    this.schedule(lane);
  }
  private remove(lane: Lane): void {
    this.dirty.delete(lane);
    if (this.lanes.get(lane.agentId) === lane) this.lanes.delete(lane.agentId);
    if (this.retiring.get(lane.agentId) === lane) this.retiring.delete(lane.agentId);
    const subscription = lane.subscription;
    lane.subscription = null;
    try { subscription?.dispose(); } catch { /* optional observation cleanup */ }
    lane.pending.clear(); lane.checkpoints.clear(); lane.bytes = 0;
  }
  private report(lane: Lane, code: CaptureCode): void {
    if (lane.diagnostic === code) return;
    lane.diagnostic = code;
    try { this.options.diagnostic(lane.agentId, code); } catch { /* never turn an observation failure into delivery failure */ }
  }
  private enqueue(lane: Lane, event: NativeExecutionObservation): void {
    if (!this.current(lane) || lane.detached || lane.suspended) return;
    try {
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !executionIdentity.safeParse(event.sourceId).success) {
        lane.overflow = true; this.schedule(lane); return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (bytes > QUEUE_BYTES) lane.overflow = true;
      else if (!lane.pending.has(event.sequence)) {
        lane.pending.set(event.sequence, { event: structuredClone(event), bytes }); lane.bytes += bytes;
        while (lane.pending.size > QUEUE_FACTS || lane.bytes > QUEUE_BYTES) {
          const [sequence, oldest] = lane.pending.entries().next().value!;
          lane.pending.delete(sequence); lane.bytes -= oldest.bytes; lane.overflow = true;
        }
      }
      this.schedule(lane);
    } catch { lane.overflow = true; this.schedule(lane); }
  }
  private row(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.database.prepare(sql).get(...values) as Row | undefined;
  }

  private liveRuntime(lane: Lane): Runtime | null {
    const row = this.row(`SELECT d.provider_execution_generation_id,d.provider_work_attempt_id,d.work_attempt_id,
      d.provider_connection_kind,d.provider_connection_pid,d.provider_process_identity,d.provider_connection_url,d.provider_server_auth_path,
      c.delivery_mode,c.runtime_configuration_revision
      FROM runtime_deployments d JOIN agent_configurations c USING(agent_id) WHERE d.agent_id=?`, lane.agentId);
    if (!row || row.delivery_mode !== "daemon_inbox" || row.provider_execution_generation_id !== lane.generation
      || row.provider_work_attempt_id !== lane.handle.workAttemptId || row.work_attempt_id !== lane.handle.workAttemptId) return null;
    const connection = { kind: row.provider_connection_kind, pid: row.provider_connection_pid,
      processIdentity: row.provider_process_identity, url: row.provider_connection_url, serverAuthPath: row.provider_server_auth_path } as ProviderActionConnectionRef;
    if (!sameProviderActionConnectionIdentity(connection, lane.handle.providerConnection)) return null;
    return this.registerRuntime(lane, connection, Number(row.runtime_configuration_revision));
  }

  private registerRuntime(lane: Lane, connection: ProviderActionConnectionRef, revision: number): Runtime | null {
    if (!connection.processIdentity || connection.pid === null) return null;
    const generation = this.row("SELECT 1 FROM work_attempt_executions WHERE execution_generation_id=? AND work_attempt_id=?", lane.generation, lane.handle.workAttemptId);
    if (!generation) return null;
    const provider = { codex_app_server: "codex", claude_cli: "claude-code", cursor_cli: "cursor", opencode_server: "open-model" } as const;
    const runtime = { id: runtimeId(lane.agentId, lane.generation, connection.kind, connection.processIdentity), generation: lane.generation };
    this.store.registerRuntime({ agentId: lane.agentId, executionGenerationId: runtime.generation, runtimeGenerationId: runtime.id,
      provider: provider[connection.kind], configRevision: revision, createdAtMs: Date.now() });
    return runtime;
  }

  private knownRuntime(lane: Lane, birth: string | undefined, generation = lane.generation): Runtime | null {
    const kind = lane.handle.providerConnection?.kind;
    if (!birth || !kind) return null;
    const id = runtimeId(lane.agentId, generation, kind, birth);
    const runtime = this.row("SELECT runtime_generation_id FROM execution_runtime_generations WHERE agent_id=? AND execution_generation_id=? AND runtime_generation_id=?", lane.agentId, generation, id);
    return runtime ? { id, generation } : null;
  }

  private bind(lane: Lane, subject: Runtime, observer: Runtime, recovery?: NativeTurnIdentity): ShadowObserver {
    const previous = lane.observer;
    if (previous && previous.runtimeGenerationId === subject.id && previous.observerRuntimeGenerationId === observer.id
      && previous.recoveryTurnId === (recovery?.turnId ?? null)) return previous;
    const current = this.row("SELECT observer_epoch FROM execution_observers WHERE agent_id=?", lane.agentId);
    return lane.observer = this.store.bindObserver({ agentId: lane.agentId, subjectRuntimeGenerationId: subject.id,
      observerRuntimeGenerationId: observer.id, sourceId: lane.subscription!.sourceId,
      daemonGenerationId: String(this.options.daemonGeneration()), expectedEpoch: Number(current?.observer_epoch ?? 0), boundAtMs: Date.now(),
      ...(recovery ? { recovery } : {}) });
  }

  private turn(lane: Lane, event: NativeExecutionObservation, observed: Runtime): { runtime: Runtime; identity: NativeTurnIdentity } | null {
    const fact = event.fact;
    if (fact.domain !== "turn" && fact.domain !== "execution") return null;
    const existing = this.row(`SELECT turn_id,execution_generation_id,runtime_generation_id,provider_continuation_id,provider_turn_id
      FROM execution_turns WHERE agent_id=? AND provider_continuation_id=? AND provider_turn_id=?`, lane.agentId, fact.providerContinuationId, fact.providerTurnId);
    if (existing) return { runtime: { id: String(existing.runtime_generation_id), generation: String(existing.execution_generation_id) },
      identity: { turnId: String(existing.turn_id), providerContinuationId: fact.providerContinuationId, providerTurnId: fact.providerTurnId } };
    const binding = this.row(`SELECT b.room_id,b.work_attempt_id,b.origin_execution_generation_id,i.source_message_id,i.created_at
      FROM supervised_agent_provider_turn_bindings b JOIN supervised_agent_inbox i ON i.inbox_item_id=b.inbox_item_id AND i.agent_id=b.agent_id AND i.room_id=b.room_id
      WHERE b.agent_id=? AND b.provider_continuation_id=? AND b.provider_turn_id=?`, lane.agentId, fact.providerContinuationId, fact.providerTurnId);
    if (!binding || binding.work_attempt_id !== lane.handle.workAttemptId || binding.origin_execution_generation_id !== observed.generation) return null;
    const identity = { turnId: opaque("turn", lane.agentId, fact.providerContinuationId, fact.providerTurnId),
      providerContinuationId: fact.providerContinuationId, providerTurnId: fact.providerTurnId };
    const attemptId = this.store.trackMessage({ agentId: lane.agentId, roomId: String(binding.room_id), sourceMessageId: String(binding.source_message_id),
      executionGenerationId: observed.generation, workspaceId: String(binding.work_attempt_id), createdAtMs: Date.parse(String(binding.created_at)) });
    this.store.trackNativeTurn({ agentId: lane.agentId, roomId: String(binding.room_id), executionGenerationId: observed.generation,
      runtimeGenerationId: observed.id, attemptId, ...identity, createdAtMs: event.observedAtMs });
    return { runtime: observed, identity };
  }

  private drain(lane: Lane): boolean {
    if (lane.detached && !lane.pending.size && !lane.checkpoints.size && lane.subscription!.position().latestSequence === 0) {
      lane.frontierStored = true; return false;
    }
    let checkpointCount = 0;
    for (const [birth, checkpoint] of lane.checkpoints) {
      if (checkpointCount++ >= BATCH_FACTS) return true;
      lane.verifiedRuntime = this.registerRuntime(lane, checkpoint.connection, checkpoint.configurationRevision) ?? lane.verifiedRuntime;
      lane.checkpoints.delete(birth);
    }
    const source = lane.subscription!.sourceId;
    const prior = this.row("SELECT source_id,last_source_sequence FROM execution_observers WHERE agent_id=?", lane.agentId);
    // Do not try to re-bind an exited Cursor child merely because the helper
    // replayed its already-committed prefix. Admission below still validates
    // the exact source witness and epoch before accepting anything new.
    if (prior?.source_id === source) this.discardPrefix(lane, Number(prior.last_source_sequence));
    const live = lane.detached ? lane.verifiedRuntime : this.liveRuntime(lane);
    if (live) lane.verifiedRuntime = live;
    const first = lane.pending.values().next().value?.event;
    const observed = first && this.knownRuntime(lane, first.nativeProcessIdentity);
    const initial = observed || live;
    if (!initial) {
      if (!lane.pending.size && prior?.source_id === source && prior.last_source_sequence === lane.subscription!.position().latestSequence) {
        lane.frontierStored = true; return false;
      }
      this.report(lane, "identity_unavailable"); return false;
    }
    let token = lane.observer ?? this.bind(lane, initial, initial);
    const position = lane.subscription!.position();
    if (!Number.isSafeInteger(position.latestSequence) || !Number.isSafeInteger(position.firstRetainedSequence)
      || position.latestSequence < 0 || position.firstRetainedSequence < 1 || position.firstRetainedSequence > position.latestSequence + 1) {
      throw new ExecutionProtocolError("invalid_fact");
    }
    this.store.observeSourcePosition(lane.subscription!.sourceId, token, position.latestSequence);
    lane.frontierStored = true;
    if (lane.suspended) return false;
    const current = this.row("SELECT last_source_sequence FROM execution_observers WHERE agent_id=?", lane.agentId)!;
    let cursor = Number(current.last_source_sequence);
    this.discardPrefix(lane, cursor);
    // Queued live observations can precede the helper's bounded retained suffix.
    const firstAvailable = lane.pending.keys().next().value ?? position.firstRetainedSequence;
    if (lane.overflow || firstAvailable > cursor + 1) {
      lane.suspended = true; lane.pending.clear(); lane.bytes = 0; this.report(lane, "source_gap"); return false;
    }
    let processed = 0;
    for (const [sequence, queued] of lane.pending) {
      if (processed++ >= BATCH_FACTS) return true;
      const event = queued.event;
      if (event.sourceId !== lane.subscription!.sourceId || sequence !== cursor + 1) {
        lane.suspended = true; this.report(lane, "source_gap"); return false;
      }
      let runtime = this.knownRuntime(lane, event.nativeProcessIdentity);
      if (!runtime && (event.fact.domain === "turn" || event.fact.domain === "execution")) {
        const known = this.row("SELECT execution_generation_id FROM execution_turns WHERE agent_id=? AND provider_continuation_id=? AND provider_turn_id=?", lane.agentId, event.fact.providerContinuationId, event.fact.providerTurnId);
        if (known) runtime = this.knownRuntime(lane, event.nativeProcessIdentity, String(known.execution_generation_id));
      }
      if (!runtime) { this.report(lane, "identity_unavailable"); return false; }
      const turn = event.fact.domain === "turn" || event.fact.domain === "execution" ? this.turn(lane, event, runtime) : null;
      if ((event.fact.domain === "turn" || event.fact.domain === "execution") && !turn) { this.report(lane, "identity_unavailable"); return false; }
      const subject = turn?.runtime ?? runtime;
      token = this.bind(lane, subject, runtime, turn && subject.id !== runtime.id ? turn.identity : undefined);
      const result = this.store.ingest(event.sourceId, token, { ...event.fact, ...(turn?.identity ?? {}),
        factId: opaque("fact", lane.agentId, event.sourceId, String(sequence)), agentId: lane.agentId,
        executionGenerationId: subject.generation, runtimeGenerationId: subject.id, observerEpoch: token.epoch,
        sourceSequence: sequence, observedAtMs: event.observedAtMs });
      if (result.status !== "accepted" && result.status !== "duplicate") {
        lane.suspended = true; this.report(lane, result.status === "gap" ? "source_gap" : "retention_limit"); return false;
      }
      cursor = sequence; lane.pending.delete(sequence); lane.bytes -= queued.bytes; lane.diagnostic = null;
    }
    if (cursor < position.latestSequence) { lane.suspended = true; this.report(lane, "source_gap"); }
    return false;
  }

  private discardPrefix(lane: Lane, cursor: number): void {
    for (const [sequence, queued] of lane.pending) {
      if (sequence > cursor) break;
      lane.pending.delete(sequence); lane.bytes -= queued.bytes;
    }
  }
}
