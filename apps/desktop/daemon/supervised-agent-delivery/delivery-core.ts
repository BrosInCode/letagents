import { performance } from "node:perf_hooks";
import type { ProviderActionHandle, ProviderActionPort, ProviderRoomTurnResult } from "../provider-action-port.js";
import type { RoomTurnAttachmentStager } from "../room-turn-attachments.js";
import { structuredRoomTurnCompletion, SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import type { ContinuityTask } from "../task-continuity.js";
import { abortablePollDelay } from "./helpers.js";
import type { ActiveDeliveryInterruptReservation, BearerRotationHold, SupervisedAuthorityRevalidator, SupervisedAuthorityScope, SupervisedContinuationRestorer, SupervisedDeliveryHttp, SupervisedIngressAgent, SupervisedLifecycleSettler, SupervisedPollWait, SupervisedPreparedTurnCheckpointer, SupervisedProviderStateCheckpointer, SupervisedReplyAttachmentSpool, SupervisedRoomMoveCommitter, SupervisedTurnConfigurationResolver } from "./types.js";

/** Delivery state, constructor dependencies, and the authority and tracking helpers every layer shares. */
export abstract class SupervisedAgentDeliveryCore {
  protected readonly polling = new Map<string, AbortController>();
  protected readonly pollOperations = new Map<string, Promise<void>>();
  protected readonly loops = new Map<string, Promise<void>>();
  protected readonly loopEpochs = new Map<string, number>();
  /** Memory-only registration identity; only a same-session bearer rotation
   * changes it in place. The bearer is never logged or persisted. */
  /**
   * The provider continuations each agent got the room history summary in
   * (or had none to get). A new continuation (a new agent, or one a restart
   * could not resume) gets it on its next turn; one that has it does not. A
   * continuation whose id changes during its first turn (Cursor's pending id)
   * is recorded under both ids.
   */
  protected readonly historySummaryGiven = new Map<string, Set<string>>();

  protected continuationOf(agent: SupervisedIngressAgent): string {
    return agent.handle?.providerContinuationId ?? agent.providerContinuationId ?? "";
  }

  protected markHistorySummaryGiven(agentId: string, continuations: readonly string[]): void {
    const given = this.historySummaryGiven.get(agentId) ?? new Set<string>();
    for (const continuation of continuations) if (continuation) given.add(continuation);
    // A few recent ids are enough; older continuations are not resumed.
    while (given.size > 4) given.delete(given.values().next().value!);
    if (!given.size) return;
    // Most recent last; a daemon supervises far fewer agents than this.
    this.historySummaryGiven.delete(agentId);
    this.historySummaryGiven.set(agentId, given);
    while (this.historySummaryGiven.size > 256) this.historySummaryGiven.delete(this.historySummaryGiven.keys().next().value!);
  }
  protected readonly loopOwners = new Map<string, { context: string; bearer: string; agent: SupervisedIngressAgent; roomRefused?: boolean }>();
  /** Lanes whose bearer a same-session rotation is replacing; see holdIngressForBearerRotation. */
  protected readonly bearerRotations = new Map<string, BearerRotationHold>();
  protected readonly loopControllers = new Map<string, AbortController>();
  protected readonly pumping = new Map<string, Promise<void>>();
  /** The live agent object each pump (and its admitted turn) authorizes with. */
  protected readonly pumpAgents = new Map<string, SupervisedIngressAgent>();
  /** Orders refreshes that await authority, so only the newest decides the lane. */
  protected readonly refreshCalls = new Map<string, number>();
  protected nextRefreshCall = 1;
  protected readonly pumpWakeups = new Map<string, Promise<void>>();
  /** Delivery demand survives internal ingress restart on the same handle. */
  protected readonly admissionDemands = new WeakMap<ProviderActionHandle, object>();
  protected readonly pumpControllers = new Map<string, AbortController>();
  /** The wait of each agent's scheduled follow-up. Its owner ends it early with Try now or Stop trying. */
  protected readonly followUpWaits = new Map<string, AbortController>();
  protected readonly retries = new Map<string, Set<Promise<void>>>();
  protected readonly auxiliaryControllers = new Map<string, Set<AbortController>>();
  protected readonly agentWork = new Map<string, Set<Promise<void>>>();
  protected readonly stoppingAgents = new Set<string>();
  protected readonly idleReservations = new Set<string>();
  protected readonly stoppingOperations = new Map<string, Promise<void>>();
  protected readonly refreshEpochs = new Map<string, number>();
  protected readonly controllers = new Set<AbortController>();
  protected readonly inFlight = new Set<Promise<unknown>>();
  protected readonly startupRecovered = new Map<string, string>();
  /** Runtime-only proof of one actual provider delivery, never reconstructed from inbox state. */
  protected readonly activeTurns = new Map<string, { invocationId: number; recoveryContext: string; inboxItemId: string; sourceMessageId: string; providerTurnId: string | null; phase: "dispatching" | "responding" | "publishing"; agent: SupervisedIngressAgent }>();
  protected nextDeliveryInvocationId = 1;
  /** Turn-scoped aborts so a Stop/correction can interrupt one turn without retiring the whole pump. */
  protected readonly activeTurnAborts = new Map<string, { inboxItemId: string; controller: AbortController }>();
  /** Exact Stop arbitration leases. A delivery failure must not make the same
   * FIFO row runnable while its native interrupt is still being settled. */
  protected readonly interruptReservations = new Map<string, ActiveDeliveryInterruptReservation>();
  protected nextInterruptReservationId = 1;
  protected readonly handleContextIds = new WeakMap<object, number>();
  protected nextHandleContextId = 1;
  protected fenced = false;
  protected dispatchPaused = false;
  protected readonly pausedDispatchAgents = new Map<string, SupervisedIngressAgent>();

  constructor(
    protected readonly inbox: SupervisedAgentInboxStore,
    protected readonly provider: ProviderActionPort,
    protected readonly http: SupervisedDeliveryHttp,
    protected readonly revalidateAuthority: SupervisedAuthorityRevalidator,
    protected readonly retryDelayMs = 50,
    protected readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    protected readonly waitForPollDelay: SupervisedPollWait = abortablePollDelay,
    protected readonly commitPreparedRoomMove?: SupervisedRoomMoveCommitter,
    protected readonly _legacyTurnConfigurationResolver?: SupervisedTurnConfigurationResolver,
    protected readonly restoreMissingContinuation?: SupervisedContinuationRestorer,
    protected readonly checkpointProviderState?: SupervisedProviderStateCheckpointer,
    protected readonly checkpointPreparedTurn?: SupervisedPreparedTurnCheckpointer,
    protected readonly observeNewSources?: (agent: SupervisedIngressAgent) => ((sourceMessageIds: readonly string[]) => void) | undefined,
    protected readonly settleLifecycleBeforeIdle?: SupervisedLifecycleSettler,
    protected readonly observeSettledWorkspace?: (agent: SupervisedIngressAgent, sourceMessageId: string, inboxItemId: string, summary?: string | null, baseline?: string | null) => Promise<void>,
    protected readonly observeStartingWorkspace?: (agent: SupervisedIngressAgent, sourceMessageId: string, inboxItemId: string) => Promise<string | null | void>,
    protected readonly releaseWorkspace?: (agent: SupervisedIngressAgent, sourceMessageId: string, inboxItemId: string) => Promise<void>,
    protected readonly onDeliverySettled?: (agentId: string) => void,
    protected readonly canAdmitNewTurn?: (agent: SupervisedIngressAgent, demand: object) => Promise<boolean>,
    /** Archive, in the agent's execution record, what its ended runtimes left open and no message still needs. */
    protected readonly archiveEndedRuntimes?: (agentId: string) => Promise<void>,
    protected readonly replyAttachmentSpool?: SupervisedReplyAttachmentSpool,
    /** Prepares the activating message's images for one turn; absent, no turn carries any. */
    protected readonly roomTurnAttachments?: Pick<RoomTurnAttachmentStager, "prepare">,
    /** Told when a delivered turn starts (for a room message) and when it ends, for the room's live view. */
    protected readonly observeTurn?: (agentId: string, change: { inboxItemId: string; sourceMessageId: string } | { ended: string | null }) => void,
  ) {}

  /**
   * Cursor's terminal result is documented as every assistant delta joined
   * together, so it is evidence that the provider completed, not a public
   * answer. Only the separately journaled exact-turn proposal is publishable.
   */
  protected async publicationResult(
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
    // The wrapper could not prove this turn's authority ended, so even its
    // journaled proposal stays unpublished. The turn is settled as lost, and its
    // reason says truthfully what happens to the agent next.
    if (result.outcome === "interrupted" && result.authorityUnproven) {
      const outlook = await agent.laneOutlook?.().catch(() => undefined);
      const next = outlook === "restarts" ? "LetAgents restarts the agent."
        : outlook === "needs_owner"
          ? "Automatic recovery was stopped after repeated provider exits. The agent needs you to recover it."
          : "";
      return { ...result, error: [result.error, next].filter(Boolean).join(" ") };
    }
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



  protected dispatchIsPaused(agent: SupervisedIngressAgent): boolean {
    if (!this.dispatchPaused) return false;
    this.pausedDispatchAgents.set(agent.agentId, agent);
    return true;
  }

  /**
   * The server revokes the old bearer at a same-session rotation. A lookup
   * that was already in flight then fails although the agent now holds a
   * valid bearer, so retry it once with the adopted one before treating the
   * ownership as unverifiable.
   */
  protected async ownedTasks(
    agent: SupervisedIngressAgent,
    input: { taskIds?: readonly string[]; heldBefore?: string; signal: AbortSignal },
  ): Promise<ContinuityTask[]> {
    if (!this.http.ownedTasks) throw new Error("Task ownership lookup is unavailable.");
    const bearer = agent.bearer;
    try {
      return await this.http.ownedTasks({ ...agent, ...input });
    } catch (error) {
      if (agent.bearer === bearer || input.signal.aborted) throw error;
      return this.http.ownedTasks({ ...agent, ...input });
    }
  }


  protected isStopping(agentId: string): boolean {
    return this.stoppingAgents.has(agentId) || this.idleReservations.has(agentId);
  }


  protected async waitForNextPoll(controller: AbortController, delayMs: number): Promise<boolean> {
    if (controller.signal.aborted || this.fenced) return false;
    await this.waitForPollDelay(delayMs, controller.signal);
    return !controller.signal.aborted && !this.fenced;
  }


  /**
   * The rotation hold on `bearer`. A hold past its time, or one the lane has
   * moved past by adopting another bearer, ends here; a late answer for an
   * older bearer leaves a newer hold alone.
   */
  protected bearerHold(agentId: string, bearer: string): BearerRotationHold | null {
    const hold = this.bearerRotations.get(agentId);
    if (!hold) return null;
    const ownerBearer = this.loopOwners.get(agentId)?.bearer;
    if (performance.now() >= hold.until || (ownerBearer !== undefined && ownerBearer !== hold.bearer)) {
      this.bearerRotations.delete(agentId);
      return null;
    }
    return hold.bearer === bearer ? hold : null;
  }

  /** The held bearer was refused: the lane now waits, at most `maxHoldMs` more. */
  protected bearerRevoked(hold: BearerRotationHold): void {
    if (hold.revoked) return;
    hold.revoked = true;
    hold.until = Math.min(hold.until, performance.now() + hold.maxHoldMs);
  }


  protected async hasIngressAuthority(
    agent: SupervisedIngressAgent,
    controller?: AbortController,
    scope: SupervisedAuthorityScope = "lane_lease",
  ): Promise<boolean> {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.isStopping(agent.agentId) || controller?.signal.aborted) return false;
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
    return allowed && !this.fenced && !this.isStopping(agent.agentId) && !controller?.signal.aborted;
  }

  protected async hasExecutionAuthority(agent: SupervisedIngressAgent, controller?: AbortController): Promise<boolean> {
    return Boolean(agent.handle)
      && await this.hasIngressAuthority(agent, controller, "settled_provider_state");
  }

  protected async hasLaneAuthority(agent: SupervisedIngressAgent, controller?: AbortController): Promise<boolean> {
    return await this.hasIngressAuthority(agent, controller, "lane_lease");
  }

  protected async hasCursorTransitionAuthority(agent: SupervisedIngressAgent, controller?: AbortController): Promise<boolean> {
    return agent.provider === "cursor"
      && Boolean(agent.handle)
      && await this.hasIngressAuthority(agent, controller, "lane_lease");
  }

  protected recoveryContext(agent: SupervisedIngressAgent): string {
    let handleId = agent.handle ? this.handleContextIds.get(agent.handle) : undefined;
    if (agent.handle && !handleId) {
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
      agent.agentSessionId, agent.workAttemptId, agent.provider, handleId ?? "no-provider",
    ].join("\u0000");
  }

  protected daemonIngressAllowed(agent: SupervisedIngressAgent): boolean {
    // The durable delivery mode is the sole ingress-ownership fact. Provider
    // identity must never create a second poller for an mcp_polling worker.
    return agent.deliveryMode === "daemon_inbox";
  }

  protected currentRefreshEpoch(agentId: string): number { return this.refreshEpochs.get(agentId) ?? 0; }

  protected nextRefreshEpoch(agentId: string): number {
    const epoch = this.currentRefreshEpoch(agentId) + 1;
    this.refreshEpochs.set(agentId, epoch);
    return epoch;
  }

  protected trackAgentWork<T>(agentId: string, operation: Promise<T>): Promise<T> {
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

  protected track<T>(controller: AbortController, operation: Promise<T>): Promise<T> {
    this.controllers.add(controller);
    this.inFlight.add(operation);
    return operation.finally(() => {
      this.controllers.delete(controller);
      this.inFlight.delete(operation);
    });
  }

  protected readonly publishedIds = new Map<string, string>();

  /** Implemented by the pump layer; interrupt settlement wakes the pump. */
  protected abstract wakePumpAfterSettlement(agent: SupervisedIngressAgent): void;
}
