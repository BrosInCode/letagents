import { sameProviderActionConnectionSnapshot, type ProviderActionConnectionRef, type ProviderActionHandle, type ProviderActionPort, type ProviderRoomTurnCheckpointDisposition, type ProviderRoomTurnResult } from "./provider-action-port.js";
import { structuredRoomTurnCompletion, SupervisedAgentInboxStore, type InboxActivation, type IngressMessage, type SupervisedInboxItem } from "./supervised-agent-inbox-store.js";
import { redactCredentialText } from "./credential-redaction.js";

function providerFailureDisplayText(message: string): string {
  const normalized = message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\t\n\r ]+/g, " ")
    .trim();
  return redactCredentialText(normalized, 1_024).value;
}

export type SupervisedIngressAgent = {
  agentId: string;
  roomId: string;
  provider: string;
  charter?: string;
  /** Daemon ingress is legal only after durable ownership commits. */
  deliveryMode?: "mcp_polling" | "desktop_events" | "daemon_inbox";
  /** Bound worker API origin; never inferred from a persisted credential. */
  apiUrl: string;
  agentSessionId: string;
  bearer: string;
  /** Provider execution is optional: ingress may continue observing and
   * queueing routed work after the native runtime exits. */
  handle: ProviderActionHandle | null;
  workAttemptId: string;
  providerContinuationId: string | null;
  /** Complete durable provider connection snapshot. A bare PID is not
   * authority because it loses process-birth and transport identity. */
  providerConnection: ProviderActionConnectionRef | null;
  /** Exact daemon generation that owns this room worker binding. */
  executionGenerationId: string;
  daemonGeneration: number;
};

/** The bearer is intentionally memory-only and must never be persisted or logged. */
export type SupervisedDeliveryAuthority = Pick<SupervisedIngressAgent,
  "agentId" | "roomId" | "provider" | "apiUrl" | "agentSessionId" | "bearer" |
  "executionGenerationId" | "daemonGeneration" | "workAttemptId" |
  "providerContinuationId" | "providerConnection" | "handle">;
/**
 * `lane_lease` is the immutable delivery owner. It deliberately excludes a
 * provider's mutable continuation/process snapshot. `settled_provider_state`
 * additionally requires the durable entry, delivery snapshot, and live handle
 * to agree on the complete provider state.
 */
export type SupervisedAuthorityScope = "lane_lease" | "settled_provider_state";
export type SupervisedAuthorityRevalidator = (
  authority: SupervisedDeliveryAuthority,
  scope: SupervisedAuthorityScope,
) => Promise<boolean> | boolean;
/** @deprecated Retained as a constructor compatibility slot; bounded turns never read startup text. */
export type SupervisedTurnConfigurationResolver = (
  authority: SupervisedDeliveryAuthority,
) => Promise<{ charter?: string }>;

export type SupervisedPollResponse = {
  messages?: Array<Record<string, unknown>>;
  /** Durable progress across rows hidden by worker activation authority. */
  last_observed_message_id?: string | null;
  /** REST poll pagination fact. */
  has_more?: boolean;
};

export interface SupervisedDeliveryHttp {
  /** Production admission owns first-cursor creation before provider reachability. */
  admissionOwnsInitialCursor?: boolean;
  poll(input: { roomId: string; apiUrl: string; bearer: string; afterMessageId: string | null; signal: AbortSignal }): Promise<SupervisedPollResponse>;
  /**
   * Read the room tail before the first ever daemon cursor is installed. This
   * is intentionally a separate REST history read: an uninitialised poll
   * means "from the beginning", which must never become a new agent's inbox.
   */
  latest?(input: { roomId: string; apiUrl: string; bearer: string; signal: AbortSignal }): Promise<{ messages?: Array<Record<string, unknown>> }>;
  /** Idempotent remote membership join used by the durable room-move journal. */
  joinRoom?(input: { roomId: string; apiUrl: string; bearer: string; signal: AbortSignal }): Promise<{ roomId: string }>;
  publish(input: {
    roomId: string;
    apiUrl: string;
    bearer: string;
    text: string;
    clientMessageId: string;
    replyTo: string | null;
    threadRootId: string | null;
    signal: AbortSignal;
  }): Promise<{ messageId: string; roomId: string }>;
}

export type SupervisedPollWait = (delayMs: number, signal: AbortSignal) => Promise<void>;
export type SupervisedRoomMoveCommitter = (input: {
  agent: SupervisedIngressAgent;
  inboxItemId: string;
}) => Promise<void>;
export type SupervisedContinuationRestorer = (input: {
  agent: SupervisedIngressAgent;
  item: SupervisedInboxItem;
  manual: boolean;
}) => Promise<"restored" | "replaced" | "authority_changed" | "failed">;
export type SupervisedProviderStateCheckpointer = (input: {
  agent: SupervisedIngressAgent;
  inboxItemId: string;
  providerTurnId: string;
  providerContinuationId: string;
  providerConnection: ProviderActionConnectionRef;
}) => Promise<void>;
export type SupervisedPreparedTurnCheckpointer = (input: {
  agent: SupervisedIngressAgent;
  inboxItemId: string;
  providerTurnId: string;
  providerContinuationId: string;
  providerConnection: ProviderActionConnectionRef;
}) => Promise<void>;
export type SupervisedLifecycleSettler = (agent: SupervisedIngressAgent) => Promise<void>;

/**
 * Process-local lease acquired before a native Stop can affect a provider
 * turn. Its opaque id and action id prevent a stale control continuation from
 * resolving a later delivery that happens to reuse the same agent and row.
 */
export type SupervisedDeliveryInterruptReservation = Readonly<{
  reservationId: number;
  invocationId: number;
  actionId: string;
  inboxItemId: string;
  providerTurnId: string | null;
  agent: SupervisedIngressAgent;
}>;

type ActiveDeliveryInterruptReservation = {
  reservation: SupervisedDeliveryInterruptReservation;
  recoveryContext: string;
  providerTurnId: string | null;
  decision: Promise<"cancelled" | "resume" | "freeze">;
  resolveDecision: (decision: "cancelled" | "resume" | "freeze") => void;
  disposition: "cancelled" | "resume" | "freeze" | null;
};

const SUCCESSFUL_POLL_PACE_MS = 25;
const POLL_ERROR_BACKOFF_BASE_MS = 250;
const POLL_ERROR_BACKOFF_CAP_MS = 30_000;

/**
 * The daemon-owned delivery loop. It intentionally knows no owner credential
 * and no mention grammar: a worker-authenticated poll is the sole activation
 * authority. Callers supply only an exact current binding and in-memory bearer.
 */
export class SupervisedAgentDelivery {
  private readonly polling = new Map<string, AbortController>();
  private readonly pollOperations = new Map<string, Promise<void>>();
  private readonly loops = new Map<string, Promise<void>>();
  private readonly loopEpochs = new Map<string, number>();
  private readonly loopControllers = new Map<string, AbortController>();
  private readonly pumping = new Map<string, Promise<void>>();
  private readonly pumpControllers = new Map<string, AbortController>();
  private readonly retries = new Map<string, Set<Promise<void>>>();
  private readonly retryControllers = new Map<string, Set<AbortController>>();
  private readonly agentWork = new Map<string, Set<Promise<void>>>();
  private readonly stoppingAgents = new Set<string>();
  private readonly stoppingOperations = new Map<string, Promise<void>>();
  private readonly refreshEpochs = new Map<string, number>();
  private readonly controllers = new Set<AbortController>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly startupRecovered = new Map<string, string>();
  /** Runtime-only proof of one actual provider delivery, never reconstructed from inbox state. */
  private readonly activeTurns = new Map<string, { invocationId: number; recoveryContext: string; inboxItemId: string; sourceMessageId: string; providerTurnId: string | null; phase: "dispatching" | "responding" | "publishing"; agent: SupervisedIngressAgent }>();
  private nextDeliveryInvocationId = 1;
  /** Turn-scoped aborts so a Stop/correction can interrupt one turn without retiring the whole pump. */
  private readonly activeTurnAborts = new Map<string, { inboxItemId: string; controller: AbortController }>();
  /** Exact Stop arbitration leases. A delivery failure must not make the same
   * FIFO row runnable while its native interrupt is still being settled. */
  private readonly interruptReservations = new Map<string, ActiveDeliveryInterruptReservation>();
  private nextInterruptReservationId = 1;
  private readonly handleContextIds = new WeakMap<object, number>();
  private nextHandleContextId = 1;
  private fenced = false;

  constructor(
    private readonly inbox: SupervisedAgentInboxStore,
    private readonly provider: ProviderActionPort,
    private readonly http: SupervisedDeliveryHttp,
    private readonly revalidateAuthority: SupervisedAuthorityRevalidator,
    private readonly retryDelayMs = 50,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly waitForPollDelay: SupervisedPollWait = abortablePollDelay,
    private readonly commitPreparedRoomMove?: SupervisedRoomMoveCommitter,
    private readonly _legacyTurnConfigurationResolver?: SupervisedTurnConfigurationResolver,
    private readonly restoreMissingContinuation?: SupervisedContinuationRestorer,
    private readonly checkpointProviderState?: SupervisedProviderStateCheckpointer,
    private readonly checkpointPreparedTurn?: SupervisedPreparedTurnCheckpointer,
    private readonly observeNewSources?: (agent: SupervisedIngressAgent) => ((sourceMessageIds: readonly string[]) => void) | undefined,
    private readonly settleLifecycleBeforeIdle?: SupervisedLifecycleSettler,
    private readonly observeSettledWorkspace?: (agent: SupervisedIngressAgent, sourceMessageId: string) => Promise<void>,
  ) {}

  /**
   * Cursor's terminal result is documented as every assistant delta joined
   * together, so it is evidence that the provider completed, not a public
   * answer. Only the separately journaled exact-turn proposal is publishable.
   */
  private async publicationResult(
    agent: SupervisedIngressAgent,
    result: ProviderRoomTurnResult,
    originExecutionGenerationId: string,
  ): Promise<ProviderRoomTurnResult> {
    if (agent.provider !== "cursor") return result;
    // One bounded upgrade exception: wrappers admitted before the structured
    // completion contract existed have terminal evidence with no contract
    // version. They cannot be rerun, so their already-retired exact aggregate
    // remains the publication source for that one recovered legacy turn.
    if (result.publicationContract === "legacy_cursor_aggregate_v0") return result;
    const proposals = await this.inbox.roomTurnCompletionEffects(
      agent.agentId,
      originExecutionGenerationId,
      result.turnId,
    );
    if (proposals.length !== 1 || proposals[0]!.state !== "completed") {
      if (result.outcome === "failed" || result.outcome === "interrupted") return result;
      return { turnId: result.turnId, outcome: "unreadable", text: null, evidence: "none" };
    }
    const completion = structuredRoomTurnCompletion(proposals[0]!.request);
    if (!completion) {
      if (result.outcome === "failed" || result.outcome === "interrupted") return result;
      return { turnId: result.turnId, outcome: "unreadable", text: null, evidence: "none" };
    }
    return completion.outcome === "no_reply"
      ? { turnId: result.turnId, outcome: "no_reply", text: null, evidence: "stream" }
      : { turnId: result.turnId, outcome: "reply", text: completion.text, evidence: "stream" };
  }

  fence(): void {
    this.fenced = true;
    this.freezeInterruptReservations();
    for (const controller of this.controllers) controller.abort();
    this.polling.clear();
  }

  /** Fence all new authority before cancelling and joining every outstanding operation. */
  async fenceAndDrain(): Promise<void> {
    this.fence();
    // Operations are added only before their first await. A snapshot is enough
    // after the fence because no operation is permitted to create new work.
    await Promise.allSettled([...this.inFlight]);
  }

  poll(agent: SupervisedIngressAgent): Promise<void> {
    if (!this.daemonIngressAllowed(agent)) return Promise.resolve();
    return this.pollOnce(agent);
  }

  /** Starts the daemon-owned long-poll loop and normalizes persisted work first. */
  async start(
    agent: SupervisedIngressAgent,
    expectedEpoch = this.currentRefreshEpoch(agent.agentId),
    replaceMismatchedLoop = true,
  ): Promise<void> {
    for (;;) {
      if (!this.daemonIngressAllowed(agent)
        || this.fenced
        || this.stoppingAgents.has(agent.agentId)
        || expectedEpoch !== this.currentRefreshEpoch(agent.agentId)) return;

      const existingLoop = this.loops.get(agent.agentId);
      if (existingLoop && this.loopEpochs.get(agent.agentId) === expectedEpoch) return;
      if (existingLoop) {
        if (!replaceMismatchedLoop) return;
        // A start that was paused before registration can install a stale loop
        // after a newer refresh already drained. Retire that mismatched epoch,
        // join it, and retry instead of leaving the newest successor asleep.
        this.polling.get(agent.agentId)?.abort();
        this.pumpControllers.get(agent.agentId)?.abort();
        this.loopControllers.get(agent.agentId)?.abort();
        await Promise.allSettled([existingLoop]);
        await Promise.resolve();
        continue;
      }

      // Every await below can admit a newer refresh. Finish the initial
      // authority check before reserving the loop slot, then register the
      // complete startup lifecycle before its health write can settle. That
      // lets stopForRefresh abort and join even a start paused in SQLite.
      if (!await this.hasIngressAuthority(agent)
        || this.fenced
        || this.stoppingAgents.has(agent.agentId)
        || expectedEpoch !== this.currentRefreshEpoch(agent.agentId)) return;
      if (this.loops.has(agent.agentId)) {
        if (!replaceMismatchedLoop) return;
        continue;
      }

      const controller = new AbortController();
      let resolveStarted!: () => void;
      let rejectStarted!: (reason: unknown) => void;
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      const lifecycle = (async () => {
        try {
          let startupFailures = 0;
          for (;;) {
            try {
              await this.inbox.setIngressHealth({ agent_id: agent.agentId, room_id: agent.roomId, execution_generation_id: agent.executionGenerationId, state: "starting" });
              break;
            } catch {
              startupFailures += 1;
              if (!await this.waitForNextPoll(controller, pollErrorBackoffMs(startupFailures))) {
                resolveStarted();
                return;
              }
            }
          }
          if (!await this.hasIngressAuthority(agent, controller)
            || this.fenced
            || this.stoppingAgents.has(agent.agentId)
            || expectedEpoch !== this.currentRefreshEpoch(agent.agentId)) {
            resolveStarted();
            return;
          }
          resolveStarted();
          await this.pollLoop(agent, controller);
        } catch (error) {
          rejectStarted(error);
          throw error;
        }
      })();
      this.loopControllers.set(agent.agentId, controller);
      const operation = this.trackAgentWork(agent.agentId, this.track(controller, lifecycle));
      this.loops.set(agent.agentId, operation);
      this.loopEpochs.set(agent.agentId, expectedEpoch);
      void operation.then(() => {
        if (this.loops.get(agent.agentId) === operation) this.loops.delete(agent.agentId);
        if (this.loopEpochs.get(agent.agentId) === expectedEpoch) this.loopEpochs.delete(agent.agentId);
        if (this.loopControllers.get(agent.agentId) === controller) this.loopControllers.delete(agent.agentId);
      }, () => {
        if (this.loops.get(agent.agentId) === operation) this.loops.delete(agent.agentId);
        if (this.loopEpochs.get(agent.agentId) === expectedEpoch) this.loopEpochs.delete(agent.agentId);
        if (this.loopControllers.get(agent.agentId) === controller) this.loopControllers.delete(agent.agentId);
      });
      // The lifecycle itself is tracked by fenceAndDrain(); callers wait only
      // for startup health/authority to settle, not for the worker's lifetime.
      await started;
      return;
    }
  }

  /**
   * Fill only a genuinely absent loop. This is safe to call from convergence
   * while its per-entry lock is held because it never joins, aborts, or
   * replaces an existing/stopping loop; the lifecycle owner finishes that
   * drain and a later convergence pass fills the resulting absence.
   */
  ensureStarted(agent: SupervisedIngressAgent): Promise<void> {
    if (this.loops.has(agent.agentId) || this.stoppingAgents.has(agent.agentId)) {
      return Promise.resolve();
    }
    return this.start(agent, this.currentRefreshEpoch(agent.agentId), false);
  }

  /** Stop one stale binding before a rebind starts its successor loop. */
  async refresh(agent: SupervisedIngressAgent): Promise<void> {
    const refreshEpoch = this.nextRefreshEpoch(agent.agentId);
    await this.stopForRefresh(agent.agentId);
    // Multiple callers may share one drain. Only the most recent binding may
    // install the successor after it settles; stale refresh continuations are
    // deliberately no-ops instead of stealing the active loop slot.
    if (!this.fenced && refreshEpoch === this.currentRefreshEpoch(agent.agentId)) {
      await this.start(agent, refreshEpoch);
    }
  }

  /** Cancel and join a removed or superseded agent without fencing other workers. */
  stop(agentId: string): Promise<void> {
    // A stop requested outside refresh invalidates any context that was merely
    // waiting on the shared drain; it must not later install a stale loop.
    this.nextRefreshEpoch(agentId);
    return this.stopForRefresh(agentId);
  }

  /**
   * Stop only an idle delivery lane. The two runtime maps deliberately cover
   * both sides of the durable-dispatch boundary: activeTurnAborts is installed
   * before native dispatch, while activeTurns owns the admitted provider turn.
   * Once stoppingAgents is set, no new pump can cross the synchronous fence.
   */
  stopIfIdle(agentId: string): Promise<boolean> {
    if (this.activeTurnAborts.has(agentId)
      || this.activeTurns.has(agentId)
      || this.stoppingOperations.has(agentId)) return Promise.resolve(false);
    return this.startStopOperation(agentId).then(() => true);
  }

  private startStopOperation(agentId: string): Promise<void> {
    this.stoppingAgents.add(agentId);
    this.freezeInterruptReservations(agentId);
    const operation = this.stopOperation(agentId);
    this.stoppingOperations.set(agentId, operation);
    void operation.then(() => {
      if (this.stoppingOperations.get(agentId) === operation) this.stoppingOperations.delete(agentId);
      this.stoppingAgents.delete(agentId);
    }, () => {
      if (this.stoppingOperations.get(agentId) === operation) this.stoppingOperations.delete(agentId);
      this.stoppingAgents.delete(agentId);
    });
    return operation;
  }

  /** Fence old-room observation immediately while allowing the activating
   * delivery continuation to finish its durable room-move commit. */
  pauseIngress(agentId: string): void {
    this.nextRefreshEpoch(agentId);
    this.polling.get(agentId)?.abort();
    this.loopControllers.get(agentId)?.abort();
    // This is called only after the activating inbox row is terminal. Abort
    // the pump controller as well so it cannot claim a later old-room item
    // while the durable membership commit is retrying.
    this.pumpControllers.get(agentId)?.abort();
  }

  private stopForRefresh(agentId: string): Promise<void> {
    const prior = this.stoppingOperations.get(agentId);
    if (prior) return prior;
    return this.startStopOperation(agentId);
  }

  private async stopOperation(agentId: string): Promise<void> {
    this.polling.get(agentId)?.abort();
    this.pumpControllers.get(agentId)?.abort();
    this.loopControllers.get(agentId)?.abort();
    for (const controller of this.retryControllers.get(agentId) ?? []) controller.abort();
    // New work is barred before aborting. Re-check the registry until it is
    // empty so a child that was registered while its parent settled is joined.
    for (;;) {
      const work = [...(this.agentWork.get(agentId) ?? [])];
      if (work.length === 0) break;
      await Promise.allSettled(work);
      // Give identity-guarded cleanup continuations a chance to unregister
      // before deciding whether a child was attached during parent teardown.
      await Promise.resolve();
    }
    this.startupRecovered.delete(agentId);
    this.activeTurns.delete(agentId);
    this.activeTurnAborts.delete(agentId);
    const health = await this.inbox.ingressHealth(agentId);
    if (health) await this.inbox.setIngressHealth({ agent_id: agentId, room_id: health.room_id, execution_generation_id: health.execution_generation_id, state: "stopped", detail: "Ingress stopped by the supervisor." });
  }

  private async pollLoop(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    let consecutivePollErrors = 0;
    while (await this.hasIngressAuthority(agent, controller)) {
      try {
        // Recovery and FIFO work never wait for a potentially hours-long
        // network poll. A transient store/normalization failure is supervised
        // here instead of terminating the only delivery loop.
        await this.pump(agent);
        await this.pollOnce(agent, controller);
        consecutivePollErrors = 0;
      } catch (error) {
        consecutivePollErrors += 1;
        await this.inbox.setIngressHealth({ agent_id: agent.agentId, room_id: agent.roomId, execution_generation_id: agent.executionGenerationId, state: "backoff", detail: error instanceof Error ? error.message : "Room observation failed." });
      }
      const delayMs = consecutivePollErrors
        ? pollErrorBackoffMs(consecutivePollErrors)
        : SUCCESSFUL_POLL_PACE_MS;
      if (!await this.waitForNextPoll(controller, delayMs)) return;
    }
  }

  private pollOnce(agent: SupervisedIngressAgent, parent?: AbortController): Promise<void> {
    if (this.fenced || this.stoppingAgents.has(agent.agentId)) return Promise.resolve();
    const prior = this.polling.get(agent.agentId);
    if (prior) return Promise.resolve();
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    parent?.signal.addEventListener("abort", relayAbort, { once: true });
    this.polling.set(agent.agentId, controller);
    const operation = this.trackAgentWork(agent.agentId, this.track(controller, this.pollOperation(agent, controller)).finally(() => parent?.signal.removeEventListener("abort", relayAbort)));
    this.pollOperations.set(agent.agentId, operation);
    void operation.then(() => {
      if (this.pollOperations.get(agent.agentId) === operation) this.pollOperations.delete(agent.agentId);
    }, () => {
      if (this.pollOperations.get(agent.agentId) === operation) this.pollOperations.delete(agent.agentId);
    });
    return operation;
  }

  private async waitForNextPoll(controller: AbortController, delayMs: number): Promise<boolean> {
    if (controller.signal.aborted || this.fenced) return false;
    await this.waitForPollDelay(delayMs, controller.signal);
    return !controller.signal.aborted && !this.fenced;
  }

  private async pollOperation(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    try {
      if (!await this.hasIngressAuthority(agent, controller)) return;
      let cursor = await this.inbox.cursor(agent.agentId);
      if (!cursor) {
        if (this.http.admissionOwnsInitialCursor) {
          throw new Error("Room delivery is waiting for its admission cursor; provider delivery will not poll history.");
        }
        // New identity: establish a durable boundary at the current tail.
        // The transaction only creates the cursor if one is still absent, so
        // another exact-generation recovery cannot move it backwards. A
        // message that races after this read remains after the cursor and is
        // picked up by the normal poll; history before the read is skipped.
        // Legacy in-memory test adapters predate the REST tail operation and
        // model an empty room. Real daemon ingress always supplies `latest`
        // (see productionSupervisedDeliveryHttp); it is the only production
        // path allowed to establish this boundary.
        const tail = this.http.latest
          ? await this.http.latest({ roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer, signal: controller.signal })
          : { messages: [] as Array<Record<string, unknown>> };
        const tailId = lastMessageId(tail.messages ?? []);
        // Once this generation has observed tail N, N is the only safe first
        // boundary. Commit it even if authority changed during the read: the
        // successor must inherit N rather than re-tail later and skip the
        // messages that raced this observation.
        await this.inbox.bootstrapCursor({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: tailId });
        cursor = await this.inbox.cursor(agent.agentId);
        if (!cursor || !await this.hasIngressAuthority(agent, controller)) return;
      }
      // Freeze nonsecret observation custody before the asynchronous poll.
      // A later grant/room replacement cannot reattribute this source batch.
      let onInserted: ((sourceMessageIds: readonly string[]) => void) | undefined;
      try { onInserted = this.observeNewSources?.(agent); } catch { /* optional observation */ }
      const response = await this.http.poll({ roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer, afterMessageId: cursor?.last_observed_message_id ?? null, signal: controller.signal });
      if (!await this.hasIngressAuthority(agent, controller)) return;
      const messages = activatedMessages(response.messages ?? []);
      await this.inbox.ingestSuccessfulPoll({
        agent_id: agent.agentId,
        room_id: agent.roomId,
        execution_generation_id: agent.executionGenerationId,
        expected_cursor: cursor?.last_observed_message_id ?? null,
        // A worker-authenticated gap page can contain only prompt rows that
        // fresh authority classifies as silent. The server omits those bodies
        // but returns the last durable id so this exact generation advances
        // without re-reading the same hidden row forever.
        last_observed_message_id:
          response.last_observed_message_id ?? lastMessageId(response.messages ?? []),
        messages,
        observed_messages: observedMessages(response.messages ?? []),
        onInserted,
      });
      // Ingest can be deliberately slow. Do not create detached delivery work
      // after a stop/rebind changed authority while its commit was pending.
      if (!await this.hasIngressAuthority(agent, controller)) return;
      await this.pump(agent);
    } finally {
      if (this.polling.get(agent.agentId) === controller) this.polling.delete(agent.agentId);
    }
  }

  retry(agent: SupervisedIngressAgent, sourceMessageId: string): Promise<void> {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.stoppingAgents.has(agent.agentId)) {
      return Promise.reject(new Error("The room delivery binding changed before retry could start."));
    }
    const controller = new AbortController();
    const operation = this.trackAgentWork(agent.agentId, this.track(controller, this.retryOperation(agent, sourceMessageId, controller)));
    const retries = this.retries.get(agent.agentId) ?? new Set<Promise<void>>();
    const controllers = this.retryControllers.get(agent.agentId) ?? new Set<AbortController>();
    retries.add(operation); controllers.add(controller);
    this.retries.set(agent.agentId, retries); this.retryControllers.set(agent.agentId, controllers);
    const cleanup = () => {
      retries.delete(operation); controllers.delete(controller);
      if (this.retries.get(agent.agentId) === retries && retries.size === 0) this.retries.delete(agent.agentId);
      if (this.retryControllers.get(agent.agentId) === controllers && controllers.size === 0) this.retryControllers.delete(agent.agentId);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  activeTurn(agent: SupervisedIngressAgent): { inboxItemId: string; sourceMessageId: string; phase: "dispatching" | "responding" | "publishing" } | null {
    const active = this.activeTurns.get(agent.agentId);
    return active?.recoveryContext === this.recoveryContext(agent)
      ? { inboxItemId: active.inboxItemId, sourceMessageId: active.sourceMessageId, phase: active.phase }
      : null;
  }

  /**
   * Capture the exact delivery owner at the provider's native interrupt edge.
   * The returned agent is the live delivery object, retaining its memory-only
   * bearer and dynamic handle getters even if provider cleanup removes the map
   * before controlTurn returns. Callers must not persist or log it.
   */
  captureActiveDeliveryInterrupt(
    agent: SupervisedIngressAgent,
    actionId: string,
  ): SupervisedDeliveryInterruptReservation | null {
    if (!actionId.trim()) throw new Error("Delivery interrupt reservation requires an exact action id.");
    const active = this.activeTurns.get(agent.agentId);
    if (active?.recoveryContext !== this.recoveryContext(agent)) return null;
    return this.installInterruptReservation({
      agent: active.agent,
      actionId,
      invocationId: active.invocationId,
      inboxItemId: active.inboxItemId,
      providerTurnId: active.providerTurnId,
      recoveryContext: active.recoveryContext,
    });
  }

  private installInterruptReservation(input: {
    agent: SupervisedIngressAgent;
    actionId: string;
    invocationId: number;
    inboxItemId: string;
    providerTurnId: string | null;
    recoveryContext: string;
  }): SupervisedDeliveryInterruptReservation {
    const existing = this.interruptReservations.get(input.agent.agentId);
    if (existing) {
      if (existing.recoveryContext === input.recoveryContext
        && existing.reservation.invocationId === input.invocationId
        && existing.reservation.inboxItemId === input.inboxItemId
        && existing.reservation.actionId === input.actionId) {
        return existing.reservation;
      }
      throw new Error("A different turn-control action already owns this delivery interrupt boundary.");
    }
    let resolveDecision!: ActiveDeliveryInterruptReservation["resolveDecision"];
    const decision = new Promise<"cancelled" | "resume" | "freeze">((resolve) => {
      resolveDecision = resolve;
    });
    const reservation: SupervisedDeliveryInterruptReservation = {
      reservationId: this.nextInterruptReservationId++,
      invocationId: input.invocationId,
      actionId: input.actionId,
      inboxItemId: input.inboxItemId,
      providerTurnId: input.providerTurnId,
      agent: input.agent,
    };
    this.interruptReservations.set(input.agent.agentId, {
      reservation,
      recoveryContext: input.recoveryContext,
      providerTurnId: input.providerTurnId,
      decision,
      resolveDecision,
      disposition: null,
    });
    return reservation;
  }

  /** Resolve an exact native-Stop lease on every provider-control exit. */
  resolveActiveDeliveryInterrupt(
    reservation: SupervisedDeliveryInterruptReservation | null,
    disposition: "cancelled" | "resume" | "freeze",
  ): void {
    if (!reservation) return;
    const active = this.exactInterruptReservation(reservation);
    if (!active) return;
    this.resolveInterruptReservation(active, disposition);
  }

  /** Validate and converge provider runtime before the caller's atomic
   * manifest+FIFO commit. This method intentionally does not settle or wake. */
  async prepareActiveDeliveryInterrupt(
    reservation: SupervisedDeliveryInterruptReservation,
  ): Promise<"interruptible" | "publication_won" | "terminal_won"> {
    const reserved = this.exactInterruptReservation(reservation);
    if (!reserved) throw new Error("Delivery interrupt reservation is stale or belongs to a different turn.");
    const agent = reservation.agent;
    const current = await this.inbox.get(reservation.inboxItemId);
    if (!current
      || current.agent_id !== agent.agentId
      || current.room_id !== agent.roomId
      || (reserved.providerTurnId && current.provider_turn_id !== reserved.providerTurnId)) {
      throw new Error("Delivery interrupt reservation no longer owns its durable FIFO invocation.");
    }
    if (agent.provider === "cursor"
      && current.provider_turn_id
      && ["dispatching", "awaiting_result", "result_recovery"].includes(current.state)
      && agent.handle?.providerContinuationId
      && agent.handle.providerConnection
      && this.checkpointProviderState) {
      await this.checkpointProviderState({
        agent,
        inboxItemId: reservation.inboxItemId,
        providerTurnId: reserved.providerTurnId ?? current.provider_turn_id,
        providerContinuationId: agent.handle.providerContinuationId,
        providerConnection: agent.handle.providerConnection,
      });
    }
    if (await this.inbox.nativeFailure(current.inbox_item_id)) return "terminal_won";
    return ["publishing", "acknowledged", "acknowledged_no_reply"].includes(current.state)
      ? "publication_won"
      : "interruptible";
  }

  /** Release the provider-facing half only after the durable transaction won. */
  finishActiveDeliveryInterrupt(
    reservation: SupervisedDeliveryInterruptReservation | null,
    disposition: "cancelled" | "resume" | "freeze",
  ): void {
    if (!reservation) return;
    const active = this.exactInterruptReservation(reservation);
    if (!active) return;
    if (disposition === "cancelled") {
      const abort = this.activeTurnAborts.get(reservation.agent.agentId);
      if (abort?.inboxItemId === reservation.inboxItemId) abort.controller.abort();
    }
    this.resolveInterruptReservation(active, disposition);
    if (disposition !== "freeze") {
      const agent = reservation.agent.handle
        ? {
          ...reservation.agent,
          providerContinuationId: reservation.agent.handle.providerContinuationId,
          providerConnection: reservation.agent.handle.providerConnection ?? null,
        }
        : reservation.agent;
      this.wakePumpAfterSettlement(agent);
    }
  }

  finishActiveDeliveryInterruptByAction(
    agentId: string,
    actionId: string,
    disposition: "cancelled" | "resume" | "freeze",
  ): boolean {
    const active = this.interruptReservations.get(agentId);
    if (!active || active.reservation.actionId !== actionId) return false;
    this.finishActiveDeliveryInterrupt(active.reservation, disposition);
    return true;
  }

  /**
   * Stop the in-flight turn for this exact agent identity without retiring the
   * pump, so the next FIFO item (e.g. a stop-then-resend correction) can run.
   * Settles the head `cancelled_by_user` if it has not yet committed to
   * publishing, then — only on a successful settlement — aborts the turn-scoped
   * controller so `deliver()` drops its provider-result wait and returns.
   *
   * Ordering matters: the durable cancellation is committed BEFORE the abort. If
   * we aborted first and the cancellation write then failed (e.g. a transient
   * SQLite error), `deliver()` would already have exited on the turn signal,
   * leaving the head stuck `dispatching`/`awaiting_result` with no live consumer
   * to settle or retry it — a stalled FIFO. Settling first means a failed
   * cancellation leaves the in-flight `deliver()` untouched as the sole consumer.
   *
   * The three outcomes are distinct so the caller can report an honest
   * `interrupted`:
   *  - `"settled"`: the interrupt won and the item is `cancelled_by_user`.
   *  - `"published"`: there WAS an active daemon turn but it had already
   *    committed to publishing — the reply stands and the turn was not truly
   *    interrupted (only this case downgrades `interrupted`). No abort: the
   *    publishing turn keeps its own consumer.
   *  - `"no_active_turn"`: no matching daemon delivery turn (e.g. an mcp_polling
   *    agent, or an idle daemon_inbox agent). The provider's own native
   *    interrupt stands; there is no daemon reply to arbitrate.
   *
   * Without an explicit inbox reservation, the identity gate mirrors
   * `activeTurn()` so a stale caller can never abort a successor turn. The
   * reservation form is captured from that same gate at native dispatch and is
   * transactionally checked against its agent, room, and current FIFO head.
   */
  async interruptActiveDelivery(
    agent: SupervisedIngressAgent,
    inboxItemId?: string,
    reservation?: SupervisedDeliveryInterruptReservation,
  ): Promise<"settled" | "published" | "terminal_won" | "no_active_turn"> {
    const active = this.activeTurns.get(agent.agentId);
    const exactActive = active?.recoveryContext === this.recoveryContext(agent) ? active : null;
    // Cursor waits for its wrapper/reaper to settle before reporting a native
    // interrupt. That can let deliver() consume the provider rejection and
    // remove the live-map entry first. The caller therefore captures the exact
    // inbox id at markDispatched and may settle that same durable head here even
    // after its in-memory consumer has exited. Without an explicit reservation,
    // retain the historical live-map-only behavior.
    const reserved = reservation ? this.exactInterruptReservation(reservation) : null;
    if (reservation && (!reserved
      || reservation.agent !== agent
      || reservation.inboxItemId !== inboxItemId)) {
      throw new Error("Delivery interrupt reservation is stale or belongs to a different turn.");
    }
    const targetInboxItemId = reservation?.inboxItemId ?? inboxItemId ?? exactActive?.inboxItemId;
    if (!targetInboxItemId) return "no_active_turn";
    if (!inboxItemId && !exactActive) return "no_active_turn";
    const current = await this.inbox.get(targetInboxItemId);
    if (reserved?.providerTurnId
      && current?.provider_turn_id !== reserved.providerTurnId) {
      throw new Error("Delivery interrupt reservation no longer owns the admitted provider turn.");
    }
    if (agent.provider === "cursor"
      && current?.provider_turn_id
      && ["dispatching", "awaiting_result", "result_recovery"].includes(current.state)
      && agent.handle?.providerContinuationId
      && agent.handle.providerConnection
      && this.checkpointProviderState) {
      // Native Stop waits for the adapter's prepared-wrapper reaper. Before
      // cancellation can destroy the exact recovery row, idempotently converge
      // any committed live wrapper birth to the handle's now-honest idle state.
      // If this fails, cancellation must not proceed: the caller records an
      // uncertain Stop and the exact row remains available for recovery.
      await this.checkpointProviderState({
        agent,
        inboxItemId: targetInboxItemId,
        providerTurnId: reserved?.providerTurnId ?? current.provider_turn_id,
        providerContinuationId: agent.handle.providerContinuationId,
        providerConnection: agent.handle.providerConnection,
      });
    }
    // Durable cancellation first; a rejection here propagates and never detaches
    // the in-flight consumer.
    const settled = await this.inbox.cancelInterruptedTurn(targetInboxItemId, "Stopped by the user.", {
      agent_id: agent.agentId,
      room_id: agent.roomId,
    });
    if (settled?.state !== "cancelled_by_user") {
      // Publication already owns a durable normalized result. Release Stop's
      // arbitration lease so a failed HTTP publish can retry that same payload
      // and client id; this never reruns the provider turn.
      if (reserved) this.resolveInterruptReservation(reserved, "resume");
      if (settled && await this.inbox.nativeFailure(settled.inbox_item_id)) return "terminal_won";
      return "published";
    }
    const abort = this.activeTurnAborts.get(agent.agentId);
    if (abort?.inboxItemId === targetInboxItemId) abort.controller.abort();
    // Dynamic Cursor state may have moved from the now-dead wrapper PID back to
    // idle while controlTurn waited for cleanup. Retain the captured secret but
    // refresh public handle facts before authority validation and FIFO wakeup.
    const wakeAgent = agent.handle
      ? {
        ...agent,
        providerContinuationId: agent.handle.providerContinuationId,
        providerConnection: agent.handle.providerConnection ?? null,
      }
      : agent;
    if (reserved) this.resolveInterruptReservation(reserved, "cancelled");
    this.wakePumpAfterSettlement(wakeAgent);
    return "settled";
  }

  private exactInterruptReservation(
    reservation: SupervisedDeliveryInterruptReservation,
  ): ActiveDeliveryInterruptReservation | null {
    const current = this.interruptReservations.get(reservation.agent.agentId);
    return current
      && current.reservation === reservation
      && current.reservation.reservationId === reservation.reservationId
      && current.reservation.invocationId === reservation.invocationId
      && current.reservation.actionId === reservation.actionId
      && current.reservation.inboxItemId === reservation.inboxItemId
      && current.recoveryContext === this.recoveryContext(reservation.agent)
      ? current
      : null;
  }

  private resolveInterruptReservation(
    active: ActiveDeliveryInterruptReservation,
    disposition: "cancelled" | "resume" | "freeze",
  ): void {
    if (active.disposition) return;
    active.disposition = disposition;
    active.resolveDecision(disposition);
    const reservation = active.reservation;
    const live = this.activeTurns.get(reservation.agent.agentId);
    if (!live
      || live.invocationId !== reservation.invocationId
      || live.recoveryContext !== active.recoveryContext
      || live.inboxItemId !== reservation.inboxItemId) {
      if (this.interruptReservations.get(reservation.agent.agentId) === active) {
        this.interruptReservations.delete(reservation.agent.agentId);
      }
      if (disposition === "resume") this.wakePumpAfterSettlement(reservation.agent);
    }
  }

  private freezeInterruptReservations(agentId?: string): void {
    for (const [candidateAgentId, reservation] of this.interruptReservations) {
      if (agentId !== undefined && candidateAgentId !== agentId) continue;
      this.resolveInterruptReservation(reservation, "freeze");
    }
  }

  private async awaitInterruptReservationDecision(
    agent: SupervisedIngressAgent,
    inboxItemId: string,
  ): Promise<"cancelled" | "resume" | "freeze" | null> {
    const active = this.interruptReservations.get(agent.agentId);
    if (!active
      || active.reservation.invocationId !== this.activeTurns.get(agent.agentId)?.invocationId
      || active.recoveryContext !== this.recoveryContext(agent)
      || active.reservation.inboxItemId !== inboxItemId) return null;
    // Keep the resolved lease installed until deliver()'s finally block has
    // consulted it. In particular, a frozen pre-checkpoint Cursor invocation
    // must not fall through final rollback and become pending again.
    return active.decision;
  }

  private bindInterruptReservationProviderTurn(
    agent: SupervisedIngressAgent,
    invocationId: number,
    inboxItemId: string,
    providerTurnId: string,
  ): void {
    const active = this.interruptReservations.get(agent.agentId);
    if (!active
      || active.recoveryContext !== this.recoveryContext(agent)
      || active.reservation.invocationId !== invocationId
      || active.reservation.inboxItemId !== inboxItemId) return;
    if (active.providerTurnId && active.providerTurnId !== providerTurnId) {
      throw new Error("Delivery interrupt reservation cannot be rebound to a different provider turn.");
    }
    active.providerTurnId = providerTurnId;
    (active.reservation as { providerTurnId: string | null }).providerTurnId = providerTurnId;
  }

  private wakePumpAfterSettlement(agent: SupervisedIngressAgent): void {
    const current = this.pumping.get(agent.agentId);
    if (!current) {
      this.schedulePump(agent);
      return;
    }
    // schedulePump intentionally coalesces while a pump is registered. If that
    // pump already observed the formerly-blocked head and is merely resolving,
    // coalescing here would lose the wake. The pump's own cleanup continuation
    // was registered when it was installed; one extra microtask guarantees the
    // registry is clear before installing the successor.
    const wake = () => queueMicrotask(() => { this.schedulePump(agent); });
    void current.then(wake, wake);
  }

  private async retryOperation(agent: SupervisedIngressAgent, sourceMessageId: string, controller: AbortController): Promise<void> {
    if (!await this.hasExecutionAuthority(agent, controller)) throw new AuthorityLostError();
    const receipts = await this.inbox.receipts(agent.agentId);
    if (!await this.hasExecutionAuthority(agent, controller)) throw new AuthorityLostError();
    const item = receipts.find((receipt) => receipt.source_message_id === sourceMessageId && receipt.state === "blocked");
    if (!item) throw new Error("The blocked room delivery is no longer available for this exact agent.");
    if (!await this.hasExecutionAuthority(agent, controller)) throw new AuthorityLostError();
    await this.inbox.retryBlocked(item.inbox_item_id);
    // The row is now truthfully pending; if authority changed during the
    // durable transition, reject the stale control request rather than claim
    // it began provider work. The successor will recover this pending head.
    if (!await this.hasExecutionAuthority(agent, controller)) {
      throw new Error("The room delivery binding changed before retry could start.");
    }
    // The control RPC acknowledges the durable blocked -> pending transition
    // and installation of tracked work, never the provider turn itself. A
    // A provider turn can outlive Electron's control-RPC timeout by minutes.
    if (!this.schedulePump(agent)) {
      throw new Error("The room delivery binding changed before retry could start.");
    }
  }

  restoreConversation(agent: SupervisedIngressAgent, sourceMessageId: string): Promise<void> {
    if (!this.restoreMissingContinuation || !this.daemonIngressAllowed(agent) || this.fenced || this.stoppingAgents.has(agent.agentId)) {
      return Promise.reject(new Error("Conversation restoration is unavailable for this exact agent."));
    }
    const controller = new AbortController();
    return this.trackAgentWork(agent.agentId, this.track(controller, this.restoreConversationOperation(agent, sourceMessageId, controller)));
  }

  private async restoreConversationOperation(agent: SupervisedIngressAgent, sourceMessageId: string, controller: AbortController): Promise<void> {
    if (!await this.hasExecutionAuthority(agent, controller)) throw new AuthorityLostError();
    const item = (await this.inbox.receipts(agent.agentId)).find((candidate) =>
      candidate.source_message_id === sourceMessageId
      && candidate.state === "blocked"
      && candidate.failure_code === "provider_continuation_missing");
    if (!item) throw new Error("The missing conversation is no longer blocking this exact message.");
    const outcome = await this.restoreMissingContinuation!({ agent, item, manual: true });
    if (outcome === "failed") {
      throw new Error("Couldn't restore this agent's provider conversation.");
    }
    if (outcome === "authority_changed") {
      throw new Error("The agent changed while its conversation was being restored. Refresh and check again.");
    }
    // A replacement continuation installs a successor ingress agent and its
    // own delivery pump. When the original conversation merely rematerializes,
    // this exact agent remains authoritative and the repaired pending head
    // needs an explicit wake-up; otherwise it waits for an unrelated poll.
    if (outcome === "restored" && !this.schedulePump(agent)) {
      throw new Error("The room delivery binding changed before the restored message could resume.");
    }
  }

  skipMessage(agent: SupervisedIngressAgent, sourceMessageId: string): Promise<void> {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.stoppingAgents.has(agent.agentId)) {
      return Promise.reject(new Error("The room delivery binding changed before the message could be skipped."));
    }
    const controller = new AbortController();
    return this.trackAgentWork(agent.agentId, this.track(controller, this.skipMessageOperation(agent, sourceMessageId, controller)));
  }

  private async skipMessageOperation(agent: SupervisedIngressAgent, sourceMessageId: string, controller: AbortController): Promise<void> {
    if (!await this.hasIngressAuthority(agent, controller)) throw new AuthorityLostError();
    const item = (await this.inbox.receipts(agent.agentId)).find((candidate) =>
      candidate.source_message_id === sourceMessageId && candidate.state === "blocked");
    if (!item) throw new Error("The blocked room message is no longer available for this exact agent.");
    await this.inbox.skipBlocked(item.inbox_item_id);
    if (!await this.hasIngressAuthority(agent, controller)) {
      throw new Error("The room delivery binding changed after the message was safely skipped.");
    }
    this.schedulePump(agent);
  }

  private schedulePump(agent: SupervisedIngressAgent): boolean {
    if (this.fenced || this.stoppingAgents.has(agent.agentId)) return false;
    // pump() registers its controller and operation before its first await, so
    // handoff/refresh still drains this work even though the RPC returns now.
    void this.pump(agent).catch(() => undefined);
    return !this.fenced && !this.stoppingAgents.has(agent.agentId);
  }

  /** Install tracked FIFO work without making the control RPC wait for the
   * provider turn or publication to finish. */
  wake(agent: SupervisedIngressAgent): boolean {
    if (!this.daemonIngressAllowed(agent)) return false;
    return this.schedulePump(agent);
  }

  pump(agent: SupervisedIngressAgent): Promise<void> {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.stoppingAgents.has(agent.agentId) || this.pumping.has(agent.agentId)) return Promise.resolve();
    const controller = new AbortController();
    const operation = this.trackAgentWork(agent.agentId, this.track(controller, this.pumpOperation(agent, controller)));
    this.pumping.set(agent.agentId, operation);
    this.pumpControllers.set(agent.agentId, controller);
    void operation.then(() => {
      if (this.pumping.get(agent.agentId) === operation) this.pumping.delete(agent.agentId);
      if (this.pumpControllers.get(agent.agentId) === controller) this.pumpControllers.delete(agent.agentId);
    }, () => {
      if (this.pumping.get(agent.agentId) === operation) this.pumping.delete(agent.agentId);
      if (this.pumpControllers.get(agent.agentId) === controller) this.pumpControllers.delete(agent.agentId);
    });
    return operation;
  }

  private async pumpOperation(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    try {
      if (!agent.handle || !await this.hasLaneAuthority(agent, controller)) return;
      const recoveryContext = this.recoveryContext(agent);
      if (this.startupRecovered.get(agent.agentId) !== recoveryContext) {
        await this.inbox.normalizeStartupRecovery(agent.agentId, {
          resetCheckpointGatedUnstartedDispatch: agent.provider === "cursor",
        });
        if (!await this.hasLaneAuthority(agent, controller)) return;
        this.startupRecovered.set(agent.agentId, recoveryContext);
      }
      for (;;) {
        const head = await this.inbox.head(agent.agentId);
        const exactCursorRecovery = agent.provider === "cursor" && Boolean(head?.provider_turn_id);
        if (!(exactCursorRecovery
          ? await this.hasCursorTransitionAuthority(agent, controller)
          : await this.hasExecutionAuthority(agent, controller))) return;
        if (head?.state === "blocked" && head.failure_code === "provider_continuation_missing" && this.restoreMissingContinuation) {
          const restored = await this.restoreMissingContinuation({ agent, item: head, manual: false });
          // A replacement installs a successor handle and starts a successor
          // delivery epoch. This stale pump must retire, while a rematerialized
          // conversation can continue on the current exact handle.
          if (restored !== "restored") return;
          continue;
        }
        const item = await this.inbox.claimHead(agent.agentId);
        if (!item) return; // blocked, in-flight, or empty: FIFO remains intact.
        await this.deliver(agent, item, controller);
      }
    } finally { /* tracked by pump(), including handoff draining. */ }
  }

  private async deliver(agent: SupervisedIngressAgent, item: SupervisedInboxItem, controller: AbortController): Promise<void> {
    // A new provider invocation is not recoverable merely because its promise
    // has been entered. Detach only after its exact turn id is durable (and,
    // for Cursor, after its wrapper birth is durable too). Recovered work
    // already carries that exact persisted turn identity.
    let providerTurnDurablyStarted = false;
    let resolveProviderTurnDurablyStarted!: () => void;
    const providerTurnDurable = new Promise<void>((resolve) => {
      resolveProviderTurnDurablyStarted = resolve;
    });
    const markProviderTurnDurablyStarted = () => {
      if (providerTurnDurablyStarted) return;
      providerTurnDurablyStarted = true;
      resolveProviderTurnDurablyStarted();
    };
    let cursorNativeReleased = false;
    const invocationId = this.nextDeliveryInvocationId++;
    let admittedProviderTurnId = item.provider_turn_id ?? null;
    let interruptDispositionForFinalizer: "cancelled" | "resume" | "freeze" | null = null;
    if (item.provider_turn_id) markProviderTurnDurablyStarted();
    let workspaceObserved = false;
    const observeWorkspace = async () => {
      if (workspaceObserved) return;
      workspaceObserved = true;
      try { await this.observeSettledWorkspace?.(agent, item.source_message_id); } catch { /* optional review */ }
    };
    let providerCallEntered = false;
    const recovering = Boolean(item.provider_turn_id);
    let providerTurnOriginExecutionGenerationId = agent.executionGenerationId;
    const hasProviderAuthority = () => recovering && agent.provider === "cursor"
      ? this.hasCursorTransitionAuthority(agent, turnController)
      : this.hasExecutionAuthority(agent, turnController);
    const restoreProvenUndispatchedClaim = async () => {
      if (providerTurnDurablyStarted) return;
      if (interruptDispositionForFinalizer === "cancelled"
        || interruptDispositionForFinalizer === "freeze") return;
      const interrupt = this.interruptReservations.get(agent.agentId);
      if (interrupt
        && interrupt.recoveryContext === this.recoveryContext(agent)
        && interrupt.reservation.invocationId === invocationId
        && interrupt.reservation.inboxItemId === item.inbox_item_id
        && interrupt.disposition !== "resume") return;
      const current = await this.inbox.get(item.inbox_item_id);
      if (!current || !["dispatching", "retryable"].includes(current.state) || current.outcome) return;
      if (current.provider_turn_id) {
        // Once an exact Cursor turn and wrapper birth have committed they are
        // one recovery unit, even if retirement lands before the adapter can
        // flip its in-memory durable marker. Never clear that turn here: the
        // exact recovery path must first prove `not_dispatched`, checkpoint
        // live->idle compensation, and only then reset it for redispatch.
        return;
      } else if (!providerCallEntered || agent.provider === "cursor") {
        // Before the provider call there is categorically no native effect.
        // Once Cursor's call is entered, its deferred-release contract gives
        // the same proof after the adapter promise has settled/reaped.
        await this.inbox.resetPreNativeHandoff(item.inbox_item_id);
      }
    };
    if (!agent.handle || !await this.hasLaneAuthority(agent, controller)) {
      await restoreProvenUndispatchedClaim();
      return;
    }
    const recoveryContext = this.recoveryContext(agent);
    // A turn-scoped controller chained off the pump controller: a full stop/
    // retirement (pump abort) still cancels the turn, but a Stop or a
    // stop-then-resend correction can abort just this turn's pre-publish work
    // without tearing down the pump so the next FIFO item can run.
    const turnController = new AbortController();
    const relayPumpAbort = () => turnController.abort();
    if (controller.signal.aborted) turnController.abort();
    else controller.signal.addEventListener("abort", relayPumpAbort, { once: true });
    this.activeTurnAborts.set(agent.agentId, { inboxItemId: item.inbox_item_id, controller: turnController });
    const compensateCursorRuntimeToLiveHandle = async (providerTurnId: string): Promise<void> => {
      if (agent.provider !== "cursor" || !agent.handle || !this.checkpointProviderState) return;
      if (admittedProviderTurnId !== providerTurnId) {
        throw new Error("Cursor runtime compensation belongs to a different delivery invocation.");
      }
      const providerContinuationId = agent.handle.providerContinuationId;
      const providerConnection = agent.handle.providerConnection;
      if (!providerContinuationId || !providerConnection) {
        throw new Error("Cursor undispatched compensation has no exact live provider state.");
      }
      await this.checkpointProviderState({
        agent,
        inboxItemId: item.inbox_item_id,
        providerTurnId,
        providerContinuationId,
        providerConnection,
      });
    };
    const setActive = (phase: "dispatching" | "responding" | "publishing") => {
      this.activeTurns.set(agent.agentId, {
        invocationId,
        recoveryContext,
        inboxItemId: item.inbox_item_id,
        sourceMessageId: item.source_message_id,
        providerTurnId: admittedProviderTurnId,
        phase,
        agent,
      });
    };
    const retryFailure = async (failure: Parameters<SupervisedAgentInboxStore["recordRetryFailure"]>[1]): Promise<void> => {
      if (!await this.hasLaneAuthority(agent, turnController)) return;
      const { item: recorded, attempt } = await this.inbox.recordRetryFailure(item.inbox_item_id, failure);
      if (recorded.state === "blocked") return;
      await this.sleep(failure.domain === "publication" ? this.retryDelayMs
        : Math.min(2_000, this.retryDelayMs * (2 ** (attempt - 1))));
      const retryable = await this.inbox.get(item.inbox_item_id);
      if (await this.hasLaneAuthority(agent, turnController) && retryable?.state === "retryable") {
        await this.inbox.transition(item.inbox_item_id, "pending");
      }
    };
    try {
      if (await this.inbox.nativeFailure(item.inbox_item_id)) {
        if (!await this.hasLaneAuthority(agent, controller)) return;
        await this.inbox.transition(item.inbox_item_id, "acknowledged_failed");
        await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
        return;
      }
      const persistedTerminal = persistedAcceptedTerminal(item.outcome);
      if (persistedTerminal?.kind === "reply") {
        setActive("publishing");
        if (!await this.hasLaneAuthority(agent, controller)) return;
        if (item.state === "dispatching") {
          await this.inbox.transition(item.inbox_item_id, "awaiting_result", { outcome: item.outcome });
        }
        if (!await this.hasLaneAuthority(agent, controller)) return;
        await this.inbox.transition(item.inbox_item_id, "publishing", { outcome: item.outcome });
        if (!await this.publish(agent, item, persistedTerminal.text, controller)) return;
        if (!await this.hasLaneAuthority(agent, controller)) return;
        await this.inbox.checkpointPublication({ inbox_item_id: item.inbox_item_id, room_id: agent.roomId, canonical_message_id: await this.publishedMessageId(agent, item) });
        await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
        return;
      }
      if (persistedTerminal?.kind === "no_reply") {
        // The daemon's normalized terminal checkpoint is the publication
        // authority. Cursor may subsequently throw while retiring either of
        // its two journal files, including after one unlink already landed;
        // never make provider recovery depend on that now-partial journal.
        if (!await this.hasExecutionAuthority(agent, turnController)) return;
        if (item.state === "dispatching") {
          await this.inbox.transition(item.inbox_item_id, "awaiting_result", { outcome: item.outcome });
        }
        if (!await this.hasExecutionAuthority(agent, turnController)) return;
        await this.inbox.transition(item.inbox_item_id, "acknowledged_no_reply", { outcome: item.outcome });
        await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
        return;
      }
      if (!await hasProviderAuthority()) return;
      if (recovering) {
        const binding = await this.inbox.providerTurnBinding(item.inbox_item_id);
        const currentContinuation = agent.handle?.providerContinuationId ?? agent.providerContinuationId;
        if (!binding
          || binding.agent_id !== agent.agentId
          || binding.room_id !== agent.roomId
          || binding.work_attempt_id !== agent.workAttemptId
          || binding.provider_continuation_id !== currentContinuation
          || binding.provider_turn_id !== item.provider_turn_id) {
          await this.inbox.transition(item.inbox_item_id, "blocked", {
            last_error: "The saved provider turn belongs to a different or unverifiable provider authority and was not recovered.",
          });
          return;
        }
        providerTurnOriginExecutionGenerationId = binding.origin_execution_generation_id;
        // Close the read-to-use window: a replacement may have landed while
        // the durable binding was read. This final current-runtime check is
        // immediately followed by the provider call without another await.
        if (!await hasProviderAuthority()) return;
      }
      if (recovering) setActive("responding");
      else setActive("dispatching");
      const observedContext = recovering
        ? []
        : (await this.inbox.observedContext(agent.agentId, agent.roomId, 30)).map((message) => message.source_message);
      if (!await hasProviderAuthority()) return;
      // Handoff may abandon observation only after the provider has committed
      // an exact, recoverable native turn boundary. Before then, the provider
      // promise owns preflight/helper cleanup and must settle before drain can
      // release this daemon generation.
      const checkpointTerminalResult = async (result: ProviderRoomTurnResult): Promise<ProviderRoomTurnCheckpointDisposition> => {
        const providerContinuationId = agent.handle?.providerContinuationId ?? agent.providerContinuationId;
        if (result.outcome === "failed" || result.outcome === "interrupted") {
          // Failure is exact native evidence, never an exception classifier or
          // a terminal callback that fabricates the missing dispatch boundary.
          const binding = await this.inbox.providerTurnBinding(item.inbox_item_id);
          if (!binding || !admittedProviderTurnId || admittedProviderTurnId !== result.turnId
            || binding.agent_id !== agent.agentId || binding.room_id !== agent.roomId
            || binding.work_attempt_id !== agent.workAttemptId
            || binding.origin_execution_generation_id !== providerTurnOriginExecutionGenerationId
            || binding.provider_turn_id !== result.turnId
            || binding.provider_continuation_id !== providerContinuationId
            || result.providerContinuationId !== providerContinuationId) {
            throw new Error("Native failure does not match the exact admitted provider turn and continuation.");
          }
        }
        const publicationResult = await this.publicationResult(
          agent,
          result,
          providerTurnOriginExecutionGenerationId,
        );
        if (!await this.hasExecutionAuthority(agent, turnController)) throw new AuthorityLostError();
        // New turns already checkpoint through checkpointTurnStarted. This
        // idempotent edge keeps provider-neutral adapters equally strict.
        if (admittedProviderTurnId && admittedProviderTurnId !== publicationResult.turnId) {
          throw new Error("Provider terminal result belongs to a different delivery invocation.");
        }
        if (item.state !== "result_recovery") {
          if (!providerContinuationId) throw new Error("Provider turn terminal checkpoint has no exact continuation authority.");
          await this.inbox.checkpointTurnStarted(item.inbox_item_id, publicationResult.turnId, {
            work_attempt_id: agent.workAttemptId,
            origin_execution_generation_id: providerTurnOriginExecutionGenerationId,
            provider_continuation_id: providerContinuationId,
          });
        }
        admittedProviderTurnId = publicationResult.turnId;
        this.bindInterruptReservationProviderTurn(agent, invocationId, item.inbox_item_id, publicationResult.turnId);
        const evidence = publicationResult.evidence ?? (publicationResult.outcome === "unreadable" ? "none" : "transcript");
        const failureDetail = (publicationResult.outcome === "failed" || publicationResult.outcome === "interrupted")
          && publicationResult.error?.trim()
          ? providerFailureDisplayText(publicationResult.error)
          : null;
        const terminalEvidence = publicationResult.outcome === "failed" || publicationResult.outcome === "interrupted"
          ? { ...publicationResult, error: failureDetail || undefined }
          : publicationResult;
        const checkpointed = await this.inbox.checkpointNormalizedTerminal({
          inbox_item_id: item.inbox_item_id,
          agent_id: agent.agentId,
          execution_generation_id: providerTurnOriginExecutionGenerationId,
          provider_turn_id: publicationResult.turnId,
          outcome: publicationResult.outcome,
          text: publicationResult.text?.trim() || null,
          evidence,
          failure_detail: failureDetail,
          terminal_evidence: terminalEvidence,
        });
        // A late failure or unreadable re-read cannot replace a definitive
        // checkpoint. Return the durable winner to the adapter and caller.
        const saved = JSON.parse(checkpointed.outcome!) as { kind: ProviderRoomTurnResult["outcome"]; text: string | null; evidence: "stream" | "transcript" | "none" };
        let acceptedResult: ProviderRoomTurnResult = publicationResult;
        if (saved.kind === "reply" && saved.text && (publicationResult.outcome !== "reply" || publicationResult.text !== saved.text)) {
          acceptedResult = { turnId: publicationResult.turnId, outcome: "reply", text: saved.text,
            evidence: saved.evidence === "none" ? undefined : saved.evidence };
        } else if (saved.kind === "no_reply" && publicationResult.outcome !== "no_reply") {
          acceptedResult = { turnId: publicationResult.turnId, outcome: "no_reply", text: null,
            evidence: saved.evidence === "none" ? undefined : saved.evidence };
        } else if (saved.kind === "failed" || saved.kind === "interrupted") {
          if (!providerContinuationId || !await this.inbox.nativeFailure(item.inbox_item_id) || saved.evidence === "none") {
            throw new Error("Native failure lost its durable terminal proof.");
          }
          acceptedResult = { turnId: publicationResult.turnId, providerContinuationId,
            outcome: saved.kind, text: null, evidence: saved.evidence,
            ...(checkpointed.last_error?.trim() ? { error: checkpointed.last_error } : {}) };
        }
        return {
          acceptedResult,
          cleanupRecoveryEvidence: acceptedResult.outcome !== "unreadable",
        };
      };
      const checkpointProviderState = async (state: {
        providerContinuationId: string;
        providerConnection: ProviderActionConnectionRef;
      }): Promise<void> => {
        const expectedCursorConnection = agent.providerConnection?.kind === "cursor_cli"
          ? agent.providerConnection
          : null;
        const sameContinuation = state.providerContinuationId === agent.providerContinuationId;
        const initializesPendingContinuation = Boolean(agent.providerContinuationId?.startsWith("cursor-pending:"))
          && !state.providerContinuationId.startsWith("cursor-pending:");
        const nextCursorConnection = state.providerConnection.kind === "cursor_cli"
          ? state.providerConnection
          : null;
        const completesAdmittedCursorTransition = agent.provider === "cursor"
          && Boolean(expectedCursorConnection)
          && Boolean(nextCursorConnection)
          && agent.providerConnection?.kind === "cursor_cli"
          && agent.providerConnection.pid !== null
          && Boolean(agent.providerConnection.processIdentity?.trim())
          && (sameContinuation || initializesPendingContinuation)
          && (nextCursorConnection!.pid === null
            ? (nextCursorConnection!.processIdentity ?? null) === null && sameContinuation
            : sameProviderActionConnectionSnapshot(expectedCursorConnection, nextCursorConnection));
        // Handoff fences new work, but it must still drain the exact init or
        // live->idle completion of a wrapper this generation already admitted.
        // Main repeats the full lane/turn CAS under the still-held singleton
        // before allowing this narrow exception.
        if ((this.fenced || turnController.signal.aborted) && !completesAdmittedCursorTransition) {
          throw new AuthorityLostError();
        }
        if (!this.checkpointProviderState) {
          throw new Error("Dynamic provider state checkpointing is unavailable.");
        }
        const exactProviderTurnId = admittedProviderTurnId;
        if (!exactProviderTurnId) {
          throw new Error("Dynamic provider state requires an exact durable provider turn.");
        }
        const current = await this.inbox.get(item.inbox_item_id);
        if (current?.provider_turn_id !== exactProviderTurnId) {
          throw new Error("Dynamic provider state no longer belongs to this delivery invocation.");
        }
        await this.checkpointProviderState({
          agent,
          inboxItemId: item.inbox_item_id,
          providerTurnId: exactProviderTurnId,
          ...state,
        });
        if (agent.provider === "cursor" && cursorNativeReleased && state.providerConnection.pid !== null) {
          // Prepared wrapper+turn is crash-recoverable, but handoff remains
          // joined until Cursor's init identity is also durable. This prevents
          // the fenced old callback from killing a released native turn.
          markProviderTurnDurablyStarted();
        }
      };
      const checkpointPreparedTurn = async (state: {
        providerTurnId: string;
        providerContinuationId: string;
        providerConnection: ProviderActionConnectionRef;
      }): Promise<void> => {
        if (agent.provider !== "cursor" || this.fenced || turnController.signal.aborted) {
          throw new AuthorityLostError();
        }
        if (!await this.hasCursorTransitionAuthority(agent, turnController)) {
          throw new AuthorityLostError();
        }
        if (!this.checkpointPreparedTurn) {
          throw new Error("Atomic Cursor prepared-turn checkpointing is unavailable.");
        }
        await this.checkpointPreparedTurn({ agent, inboxItemId: item.inbox_item_id, ...state });
        admittedProviderTurnId = state.providerTurnId;
        this.bindInterruptReservationProviderTurn(agent, invocationId, item.inbox_item_id, state.providerTurnId);
        setActive("responding");
      };
      const settleLifecycleBeforeIdle = async (): Promise<void> => {
        if (agent.provider !== "cursor") return;
        if (!this.settleLifecycleBeforeIdle) {
          throw new Error("Cursor lifecycle settlement is unavailable.");
        }
        await this.settleLifecycleBeforeIdle(agent);
      };
      providerCallEntered = true;
      const turn = recovering
        ? this.provider.recoverRoomTurn?.(agent.handle, {
          inboxItemId: item.inbox_item_id,
          providerTurnId: item.provider_turn_id!,
        }, { detachSignal: turnController.signal, checkpointProviderState, settleLifecycleBeforeIdle, checkpointTerminalResult })
        : this.provider.runRoomTurn?.(agent.handle, {
        inboxItemId: item.inbox_item_id,
        sourceMessage: item.source_message,
        activation: item.activation,
        actionId: item.action_id,
        observedContext,
      }, { beforeNativeDispatch: async () => {
        if (!await this.hasExecutionAuthority(agent, turnController)) throw new AuthorityLostError();
        // The provider cannot call turn/start until this durable causal edge
        // has committed. Dispatching remains truthful until its exact native
        // turn id has also been checkpointed below.
        await this.inbox.checkpointDispatchIntent(item.inbox_item_id);
      }, markDispatched: async () => {
        // Compatibility only for a pre-checkpoint adapter during upgrade. It
        // retains the truthful activity projection but cannot replace the
        // exact turn-id callback implemented by the bounded-turn adapter.
        if (!await this.hasExecutionAuthority(agent, turnController)) throw new AuthorityLostError();
        await this.inbox.checkpointDispatchIntent(item.inbox_item_id);
        setActive("responding");
      }, checkpointTurnStarted: async (turnId) => {
        // A provider that already entered its native operation may receive an
        // exact turn id while a full pump retirement is draining it. Commit
        // that recovery key before the successor starts. User Stop aborts only
        // turnController (not the pump controller) and therefore cannot use
        // this retirement-only finalization path.
        // Cursor prepares a paused wrapper before this callback. Its live
        // handle therefore carries the candidate wrapper connection while the
        // manifest and delivery snapshot still carry the old idle connection.
        // Validate immutable ownership plus that old durable snapshot here;
        // checkpointProviderState performs the exact old->new CAS next.
        const stillAuthorized = agent.provider === "cursor"
          ? await this.hasCursorTransitionAuthority(agent, turnController)
          : await this.hasExecutionAuthority(agent, turnController);
        // Re-check the pump abort after async authority validation: retirement
        // can land while that validation is awaiting storage. A non-Cursor
        // native turn already admitted by this generation must still persist
        // its exact recovery key before the successor normalizes the row.
        const finalizingAdmittedTurnDuringRetirement = agent.provider !== "cursor" && controller.signal.aborted;
        if (!stillAuthorized && !finalizingAdmittedTurnDuringRetirement) throw new AuthorityLostError();
        const providerContinuationId = agent.handle?.providerContinuationId ?? agent.providerContinuationId;
        if (!providerContinuationId) throw new Error("Provider turn start has no exact continuation authority.");
        await this.inbox.checkpointTurnStarted(item.inbox_item_id, turnId, {
          work_attempt_id: agent.workAttemptId,
          origin_execution_generation_id: agent.executionGenerationId,
          provider_continuation_id: providerContinuationId,
        });
        admittedProviderTurnId = turnId;
        this.bindInterruptReservationProviderTurn(agent, invocationId, item.inbox_item_id, turnId);
        // Only an acknowledged exact provider turn is projected responding.
        setActive("responding");
        // Cursor additionally checkpoints its wrapper birth before allowing
        // retirement; every other adapter's exact turn id is its recovery key.
        if (agent.provider !== "cursor") markProviderTurnDurablyStarted();
      }, checkpointPreparedTurn, checkpointProviderState, settleLifecycleBeforeIdle, markDurableTurnStarted: () => {
        if (agent.provider === "cursor" && this.checkpointPreparedTurn) {
          cursorNativeReleased = true;
        } else {
          markProviderTurnDurablyStarted();
        }
      }, checkpointTerminalResult, detachSignal: turnController.signal });
      // Native provider turns are intentionally not cancelable by the daemon:
      // a handoff must retire our authority, not kill a user's provider process.
      // Once an exact turn is durable, race its result with retirement. Before
      // that boundary, keep the pump in the drain group until the adapter has
      // aborted and reaped any preflight/helper processes.
      const providerResult = turn && await this.awaitProviderResultOrRetirement(
        turn,
        turnController,
        () => !providerTurnDurablyStarted,
        providerTurnDurable,
      );
      if (!providerResult) throw new Error("Provider does not support bounded room turns.");
      if (!await hasProviderAuthority()) return;
      // Real provider adapters invoke this before releasing their in-memory
      // stream accumulator. The repeat is intentionally idempotent for simple
      // test adapters and future provider implementations.
      const { acceptedResult: result } = await checkpointTerminalResult(providerResult);
      // Optional review evidence is captured before another turn can mutate this workspace.
      // Failure must not change the provider result or cause the turn to be rerun.
      await observeWorkspace();
      const evidence = result.evidence ?? (result.outcome === "unreadable" ? "none" : "transcript");
      const outcome = JSON.stringify({ kind: result.outcome, text: result.text?.trim() || null, evidence });
      if (!await this.hasExecutionAuthority(agent, turnController)) return;
      if (result.outcome === "failed" || result.outcome === "interrupted") {
        await this.inbox.transition(item.inbox_item_id, "acknowledged_failed");
        await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
        return;
      }
      if (item.state !== "result_recovery") {
        await this.inbox.transition(item.inbox_item_id, "awaiting_result", { provider_turn_id: result.turnId, outcome });
      }
      if (result.outcome === "unreadable") {
        if (item.state === "result_recovery") {
          await this.inbox.transition(item.inbox_item_id, "blocked", { outcome, last_error: "The provider completed, but its final answer is still unreadable. The same turn was re-read and was not rerun." });
        } else {
          await this.inbox.transition(item.inbox_item_id, "result_recovery", { outcome, last_error: "The provider completed, but its final answer could not be read. Re-reading the same completed turn." });
        }
        return;
      }
      if (result.outcome === "no_reply") {
        if (!await this.hasExecutionAuthority(agent, turnController)) return;
        await this.inbox.transition(item.inbox_item_id, "acknowledged_no_reply", { outcome });
        await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
        return;
      }
      const text = result.text?.trim();
      if (!text) throw new Error("Provider returned an empty room answer without the no-reply outcome.");
      // The terminal payload is checkpointed before the external publication.
      // A crash after this point retries the same client id without rerunning the provider.
      await this.inbox.transition(item.inbox_item_id, "publishing", { outcome });
      setActive("publishing");
      if (!await this.publish(agent, item, text, controller)) return;
      if (!await this.hasExecutionAuthority(agent, controller)) return;
      await this.inbox.checkpointPublication({ inbox_item_id: item.inbox_item_id, room_id: agent.roomId, canonical_message_id: await this.publishedMessageId(agent, item) });
      await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
    } catch (error) {
      // A turn-scoped abort (Stop / stop-then-resend) is a clean interruption,
      // not a delivery failure: the item is settled `cancelled_by_user` by
      // `interruptActiveDelivery`, so never fall through to retry/block it.
      if (this.fenced || controller.signal.aborted || turnController.signal.aborted) return;
      if (error instanceof AuthorityLostError
        && !await this.hasLaneAuthority(agent, turnController)) {
        // A genuinely retired owner must not mutate the FIFO. Its successor
        // normalizes the durable pre-native state. An exact owner whose
        // settled provider snapshot drifted continues below into the bounded
        // retry path instead of silently orphaning `dispatching` forever.
        return;
      }
      const message = error instanceof Error && error.message
        ? error.message
        : "Room delivery failed before provider authority could be checkpointed.";
      // Native Stop arbitration owns this exact invocation before it can
      // signal the provider. Do not turn any resulting rejection into
      // retryable/pending/blocked work until the control path decides whether
      // cancellation won, was not applied, or is uncertain. This is an
      // ordering barrier, not a timing delay: the same FIFO row cannot be
      // redispatched behind a Stop that already targeted its old wrapper.
      const interruptDisposition = await this.awaitInterruptReservationDecision(
        agent,
        item.inbox_item_id,
      );
      interruptDispositionForFinalizer = interruptDisposition;
      if (interruptDisposition === "cancelled" || interruptDisposition === "freeze") return;
      const current = await this.inbox.get(item.inbox_item_id);
      if (!current || current.state === "acknowledged" || current.state === "acknowledged_no_reply" || current.state === "acknowledged_failed" || current.state === "cancelled_by_user" || current.state === "cancelled_by_room_move") return;
      // A turn-scoped abort that landed during the async read above is a user
      // interrupt, not a delivery failure: leave the head for interruptActiveDelivery
      // to settle rather than retrying/blocking (and rerunning) the stopped turn.
      if (turnController.signal.aborted) return;
      const nativeFailure = await this.inbox.nativeFailure(current.inbox_item_id);
      const acceptedTerminal = persistedAcceptedTerminal(current.outcome);
      // Some adapters commit a terminal result and then reject during cleanup.
      // Their workspace is settled too; observe it before advancing the FIFO.
      if ((nativeFailure || acceptedTerminal) && await this.hasLaneAuthority(agent, controller)) await observeWorkspace();
      if (nativeFailure) {
        if (!await this.hasLaneAuthority(agent, controller)) return;
        await this.inbox.transition(item.inbox_item_id, "acknowledged_failed", {
          last_error: current.last_error?.trim() || providerFailureDisplayText(message),
        });
        await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
        return;
      }
      if (acceptedTerminal?.kind === "no_reply"
        && ["dispatching", "awaiting_result", "result_recovery"].includes(current.state)) {
        // The normalized terminal checkpoint committed before provider-journal
        // retirement failed. It is already authoritative; consuming another
        // result-recovery retry here could block the row one instruction before
        // the normal fast-forward sees it.
        if (!await this.hasExecutionAuthority(agent, turnController)) return;
        if (current.state === "dispatching") {
          await this.inbox.transition(item.inbox_item_id, "awaiting_result", { outcome: current.outcome });
        }
        if (!await this.hasExecutionAuthority(agent, turnController)) return;
        await this.inbox.transition(item.inbox_item_id, "acknowledged_no_reply", { outcome: current.outcome });
        await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
        return;
      }
      if (acceptedTerminal?.kind === "reply"
        && ["dispatching", "awaiting_result", "result_recovery"].includes(current.state)) {
        // Publication is independent of fallible provider-journal cleanup.
        // Publish the already-normalized answer now, before classifying the
        // cleanup exception as a provider recovery failure.
        setActive("publishing");
        if (!await this.hasLaneAuthority(agent, controller)) return;
        if (current.state === "dispatching") {
          await this.inbox.transition(item.inbox_item_id, "awaiting_result", { outcome: current.outcome });
        }
        await this.inbox.transition(item.inbox_item_id, "publishing", { outcome: current.outcome });
        try {
          if (!await this.publish(agent, item, acceptedTerminal.text, controller)) return;
          if (!await this.hasLaneAuthority(agent, controller)) return;
          await this.inbox.checkpointPublication({
            inbox_item_id: item.inbox_item_id,
            room_id: agent.roomId,
            canonical_message_id: await this.publishedMessageId(agent, item),
          });
          await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
        } catch (publicationError) {
          const publishing = await this.inbox.get(item.inbox_item_id);
          if (publishing?.state !== "publishing") throw publicationError;
          await retryFailure({
            domain: "publication", error: publicationError instanceof Error ? publicationError.message : String(publicationError),
          });
        }
        return;
      }
      const failure = error as { providerFailureCode?: unknown; providerContinuationId?: unknown };
      if (failure.providerFailureCode === "provider_continuation_missing"
        && current.attempt_count === 0
        && !current.provider_turn_id
        && !current.outcome) {
        const missingContinuation = typeof failure.providerContinuationId === "string"
          ? failure.providerContinuationId
          : agent.providerContinuationId;
        if (!missingContinuation || missingContinuation !== agent.providerContinuationId) {
          await this.inbox.transition(item.inbox_item_id, "blocked", {
            last_error: "The provider reported a different missing conversation. Automatic restoration was refused.",
          });
          return;
        }
        const blocked = await this.inbox.transition(item.inbox_item_id, "blocked", {
          failure_code: "provider_continuation_missing",
          last_error: "The saved provider conversation is unavailable. Restoring it before any model work starts.",
        });
        if (this.restoreMissingContinuation) {
          await this.restoreMissingContinuation({ agent, item: blocked, manual: false });
        }
        return;
      }
      if ((error as { roomTurnRecoveryOutcome?: unknown })?.roomTurnRecoveryOutcome === "not_dispatched") {
        if (!current.provider_turn_id) {
          if (agent.provider !== "cursor") {
            await this.inbox.transition(item.inbox_item_id, "blocked", {
              last_error: "Provider reported an undispatched turn without an exact durable turn id.",
            });
            return;
          }
          await retryFailure({ domain: "pre_dispatch", error: message });
          return;
        }
        try {
          await compensateCursorRuntimeToLiveHandle(current.provider_turn_id);
        } catch (compensationError) {
          await retryFailure({
            domain: "result_recovery",
            error: `Prepared Cursor wrapper was reaped, but idle-state compensation must retry: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
          });
          return;
        }
        await retryFailure({ domain: "pre_dispatch", error: message, resetUndispatchedTurnId: current.provider_turn_id });
        return;
      }
      if (["ambiguous", "terminal_failure"].includes(
        String((error as { roomTurnRecoveryOutcome?: unknown })?.roomTurnRecoveryOutcome ?? ""),
      )) {
        await this.inbox.transition(item.inbox_item_id, "blocked", { last_error: message });
        return;
      }
      if (current.state === "publishing") {
        await retryFailure({ domain: "publication", error: message });
        return;
      }
      if (current.provider_turn_id) {
        // Startup and newly acknowledged turns can both be dispatching here.
        // Their exact binding, not the UI state or model-turn count, identifies
        // recovery work; never spend its budget on publication or a new prompt.
        await retryFailure({ domain: "result_recovery", error: message });
        return;
      }
      if (providerCallEntered && !current.provider_turn_id && !current.outcome && agent.provider !== "cursor") {
        // A lost native acknowledgement or failed turn-id checkpoint leaves
        // no exact recovery key, not proof that the prompt was never sent.
        // Cursor alone checkpoints its paused wrapper before native release;
        // its settled, evidence-free invocation remains safe to retry below.
        await this.inbox.transition(item.inbox_item_id, "blocked", {
          last_error: `The provider may have started this work, but its exact turn could not be saved. Automatic retry was stopped to avoid running it twice: ${message}`,
        });
        return;
      }
      await retryFailure({ domain: "pre_dispatch", error: message });
    } finally {
      controller.signal.removeEventListener("abort", relayPumpAbort);
      const abort = this.activeTurnAborts.get(agent.agentId);
      if (abort?.inboxItemId === item.inbox_item_id && abort.controller === turnController) this.activeTurnAborts.delete(agent.agentId);
      const pendingInterrupt = this.interruptReservations.get(agent.agentId);
      if (interruptDispositionForFinalizer === null
        && pendingInterrupt?.reservation.invocationId === invocationId
        && pendingInterrupt.recoveryContext === recoveryContext
        && pendingInterrupt.reservation.inboxItemId === item.inbox_item_id) {
        // Even a successful provider/publication path cannot advance to a
        // successor row until the action journal and FIFO effects commit
        // together. Fence/refresh resolves this fail-closed as freeze.
        interruptDispositionForFinalizer = await pendingInterrupt.decision;
      }
      const active = this.activeTurns.get(agent.agentId);
      if (active?.invocationId === invocationId
        && active.recoveryContext === recoveryContext
        && active.inboxItemId === item.inbox_item_id) this.activeTurns.delete(agent.agentId);
      await restoreProvenUndispatchedClaim();
      const interrupt = this.interruptReservations.get(agent.agentId);
      if (interrupt?.reservation.invocationId === invocationId
        && interrupt.recoveryContext === recoveryContext
        && interrupt.reservation.inboxItemId === item.inbox_item_id
        && interrupt.disposition) {
        this.interruptReservations.delete(agent.agentId);
      }
    }
  }

  private readonly publishedIds = new Map<string, string>();
  private async publish(agent: SupervisedIngressAgent, item: SupervisedInboxItem, text: string, parent: AbortController): Promise<boolean> {
    if (!await this.hasLaneAuthority(agent, parent)) return false;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    parent.signal.addEventListener("abort", relayAbort, { once: true });
    try {
      const replyTarget = supervisedReplyTargetForSourceMessage(item.source_message);
      const publication = await this.track(controller, this.http.publish({
        roomId: agent.roomId,
        apiUrl: agent.apiUrl,
        bearer: agent.bearer,
        text,
        clientMessageId: item.reply_client_message_id,
        replyTo: replyTarget.replyTo,
        threadRootId: replyTarget.threadRootId,
        signal: controller.signal,
      }));
      if (!publication.messageId?.trim() || !publication.roomId?.trim() || publication.roomId !== agent.roomId) throw new Error("Room publication did not return a nonempty canonical message id in the matching room.");
      this.publishedIds.set(item.inbox_item_id, publication.messageId);
      const current = await this.hasLaneAuthority(agent, parent);
      if (!current) this.publishedIds.delete(item.inbox_item_id);
      return current;
    } catch (error) { this.publishedIds.delete(item.inbox_item_id); throw error; }
    finally { parent.signal.removeEventListener("abort", relayAbort); }
  }
  private async publishedMessageId(agent: SupervisedIngressAgent, item: SupervisedInboxItem): Promise<string> {
    const id = this.publishedIds.get(item.inbox_item_id);
    if (!id) throw new Error("Room publication acknowledgement was lost before its canonical identity could be checkpointed.");
    this.publishedIds.delete(item.inbox_item_id);
    return id;
  }

  private awaitProviderResultOrRetirement<T>(
    providerTurn: Promise<T>,
    controller: AbortController,
    waitForProviderOnRetirement: () => boolean,
    providerTurnDurable: Promise<void>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let retired = false;
      let waitsForProviderAfterRetirement = false;
      const finish = (callback: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", retire);
        callback(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", retire);
        reject(error);
      };
      const retire = () => {
        retired = true;
        waitsForProviderAfterRetirement = waitForProviderOnRetirement();
        if (!waitsForProviderAfterRetirement) {
          fail(new AuthorityLostError());
          return;
        }
        // The turn can cross its exact durable boundary while retirement is
        // waiting for pre-checkpoint cleanup. Detach at that moment instead of
        // retaining a now-recoverable native turn until its model result.
        void providerTurnDurable.then(() => {
          if (retired) fail(new AuthorityLostError());
        });
      };
      if (controller.signal.aborted) retire();
      else controller.signal.addEventListener("abort", retire, { once: true });
      // Before a durable native turn exists, retirement waits for the provider
      // to finish aborting and reaping its preparation helpers. After that
      // boundary, these handlers merely observe a late settlement so a user's
      // native turn can outlive this daemon without an unhandled rejection.
      void providerTurn.then(
        (result) => retired ? fail(new AuthorityLostError()) : finish(resolve, result),
        (error) => retired && !waitsForProviderAfterRetirement
          ? fail(new AuthorityLostError())
          : fail(error),
      );
    });
  }

  private async hasIngressAuthority(
    agent: SupervisedIngressAgent,
    controller?: AbortController,
    scope: SupervisedAuthorityScope = "lane_lease",
  ): Promise<boolean> {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.stoppingAgents.has(agent.agentId) || controller?.signal.aborted) return false;
    const allowed = await this.revalidateAuthority({
      agentId: agent.agentId,
      roomId: agent.roomId,
      apiUrl: agent.apiUrl,
      provider: agent.provider,
      agentSessionId: agent.agentSessionId,
      bearer: agent.bearer,
      workAttemptId: agent.workAttemptId,
      executionGenerationId: agent.executionGenerationId,
      daemonGeneration: agent.daemonGeneration,
      providerContinuationId: agent.providerContinuationId,
      providerConnection: agent.providerConnection,
      handle: agent.handle,
    }, scope);
    return allowed && !this.fenced && !this.stoppingAgents.has(agent.agentId) && !controller?.signal.aborted;
  }

  private async hasExecutionAuthority(agent: SupervisedIngressAgent, controller?: AbortController): Promise<boolean> {
    return Boolean(agent.handle)
      && await this.hasIngressAuthority(agent, controller, "settled_provider_state");
  }

  private async hasLaneAuthority(agent: SupervisedIngressAgent, controller?: AbortController): Promise<boolean> {
    return await this.hasIngressAuthority(agent, controller, "lane_lease");
  }

  private async hasCursorTransitionAuthority(agent: SupervisedIngressAgent, controller?: AbortController): Promise<boolean> {
    return agent.provider === "cursor"
      && Boolean(agent.handle)
      && await this.hasIngressAuthority(agent, controller, "lane_lease");
  }

  private recoveryContext(agent: SupervisedIngressAgent): string {
    if (!agent.handle) return [agent.daemonGeneration, agent.executionGenerationId, agent.roomId, agent.agentSessionId, "no-provider"].join("\u0000");
    let handleId = this.handleContextIds.get(agent.handle);
    if (!handleId) {
      handleId = this.nextHandleContextId++;
      this.handleContextIds.set(agent.handle, handleId);
    }
    // Cursor checkpoints a new continuation/PID on this same handle while a
    // bounded turn is live. Those per-turn facts are authority evidence, but
    // not delivery-owner identity: including them here would make the exact
    // live map reject its own post-checkpoint agent. Generation, binding,
    // workspace, API origin, and handle identity remain immutable fences.
    return [
      agent.daemonGeneration, agent.executionGenerationId, agent.roomId, agent.apiUrl,
      agent.agentSessionId, agent.workAttemptId, handleId,
    ].join("\u0000");
  }

  private daemonIngressAllowed(agent: SupervisedIngressAgent): boolean {
    // The durable delivery mode is the sole ingress-ownership fact. Provider
    // identity must never create a second poller for an mcp_polling worker.
    return agent.deliveryMode === "daemon_inbox";
  }

  private currentRefreshEpoch(agentId: string): number { return this.refreshEpochs.get(agentId) ?? 0; }

  private nextRefreshEpoch(agentId: string): number {
    const epoch = this.currentRefreshEpoch(agentId) + 1;
    this.refreshEpochs.set(agentId, epoch);
    return epoch;
  }

  private trackAgentWork<T>(agentId: string, operation: Promise<T>): Promise<T> {
    const work = this.agentWork.get(agentId) ?? new Set<Promise<void>>();
    work.add(operation as Promise<void>);
    this.agentWork.set(agentId, work);
    const cleanup = () => {
      work.delete(operation as Promise<void>);
      if (this.agentWork.get(agentId) === work && work.size === 0) this.agentWork.delete(agentId);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private track<T>(controller: AbortController, operation: Promise<T>): Promise<T> {
    this.controllers.add(controller);
    this.inFlight.add(operation);
    return operation.finally(() => {
      this.controllers.delete(controller);
      this.inFlight.delete(operation);
    });
  }
}

export type SupervisedReplyTarget = {
  replyTo: string | null;
  threadRootId: string | null;
};

/**
 * Supervised replies inherit only real thread membership. Current room rows
 * identify top-level quote replies with thread_root_id equal to their own id;
 * carrying quote-only reply_to metadata forward would incorrectly pull the
 * provider response into a thread.
 */
export function supervisedReplyTargetForSourceMessage(sourceMessage: unknown): SupervisedReplyTarget {
  if (!sourceMessage || typeof sourceMessage !== "object" || Array.isArray(sourceMessage)) {
    return { replyTo: null, threadRootId: null };
  }
  const source = sourceMessage as Record<string, unknown>;
  const sourceId = stringOrNull(source.id);
  const thread = source.thread && typeof source.thread === "object" && !Array.isArray(source.thread)
    ? source.thread as Record<string, unknown>
    : null;
  const threadRootId = stringOrNull(source.thread_root_id)
    ?? stringOrNull(source.threadRootId)
    ?? stringOrNull(thread?.root_message_id);
  const isThreadReply = threadRootId !== null
    && sourceId !== null
    && threadRootId !== sourceId
    && (thread?.is_thread_reply !== false);
  return isThreadReply
    ? { replyTo: sourceId, threadRootId }
    : { replyTo: null, threadRootId: null };
}

class AuthorityLostError extends Error {
  constructor() {
    super("Supervised delivery authority changed before the provider turn became durable.");
  }
}

function activatedMessages(messages: readonly Record<string, unknown>[]): IngressMessage[] {
  return messages.flatMap((message) => {
    const activation = message.activation;
    const current = activation && typeof activation === "object" && !Array.isArray(activation)
      ? (activation as Record<string, unknown>).for_current_agent
      : null;
    const id = stringOrNull(message.id);
    // This is the server's routing decision. Do not infer activation from
    // mention-looking text and do not enqueue `silent`/`unaddressed`/unknown
    // decisions: they are observed solely by cursor progress.
    if (!id || !current || typeof current !== "object" || Array.isArray(current)
      || (current as Record<string, unknown>).decision !== "activate") return [];
    return [{ source_message_id: id, source_message: message, activation: current as InboxActivation }];
  });
}

function observedMessages(messages: readonly Record<string, unknown>[]) {
  return messages.flatMap((message) => {
    const id = stringOrNull(message.id);
    if (!id) return [];
    const activation = message.activation;
    const current = activation && typeof activation === "object" && !Array.isArray(activation)
      ? (activation as Record<string, unknown>).for_current_agent
      : null;
    const normalized = current && typeof current === "object" && !Array.isArray(current)
      ? current as InboxActivation
      : {};
    const decision = typeof normalized.decision === "string" ? normalized.decision : "unknown";
    return [{ source_message_id: id, source_message: message, activation: normalized, activation_decision: decision }];
  });
}

function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }

function lastMessageId(messages: readonly Record<string, unknown>[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = stringOrNull(messages[index]?.id);
    if (id) return id;
  }
  return null;
}

function persistedAcceptedTerminal(outcome: string | null):
  | { kind: "reply"; text: string }
  | { kind: "no_reply"; text: null }
  | null {
  if (!outcome) return null;
  try {
    const parsed = JSON.parse(outcome) as { kind?: unknown; text?: unknown };
    if (parsed.kind === "reply" && typeof parsed.text === "string" && parsed.text.trim()) {
      return { kind: "reply", text: parsed.text };
    }
    return parsed.kind === "no_reply" && (parsed.text === null || parsed.text === undefined)
      ? { kind: "no_reply", text: null }
      : null;
  } catch { return null; }
}

function pollErrorBackoffMs(consecutiveErrors: number): number {
  const exponent = Math.max(0, Math.min(30, consecutiveErrors - 1));
  return Math.min(POLL_ERROR_BACKOFF_CAP_MS, POLL_ERROR_BACKOFF_BASE_MS * (2 ** exponent));
}

/** An abortable delay that releases its signal listener on either completion path. */
function abortablePollDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    // An abort between the first check and listener registration is still
    // observed, and uses the same cleanup path as a completed timer.
    if (signal.aborted) finish();
  });
}
