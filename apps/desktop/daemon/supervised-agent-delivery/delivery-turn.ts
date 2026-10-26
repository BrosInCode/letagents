import { isLocalRoomApi } from "../../../../shared/room-api-origin.mjs";
import { sameProviderActionConnectionIdentity, sameProviderActionConnectionSnapshot, type ProviderActionConnectionRef, type ProviderRoomTurnCheckpointDisposition, type ProviderRoomTurnResult, type RoomTurnImageDelivery } from "../provider-action-port.js";
import { ReplyTurnCompactionObserver } from "../reply-turn-compaction.js";
import { RoomLatencyTrace } from "../room-latency-trace.js";
import { activatingThreadRootId, recentRoomImageMessages, ROOM_TURN_RECENT_MESSAGE_WINDOW, type PreparedRoomTurnAttachments } from "../room-turn-attachments.js";
import { turnStartLatency } from "../turn-start-latency.js";
import { SupervisedAgentInboxStore, type SupervisedInboxItem } from "../supervised-agent-inbox-store.js";
import { SupervisedRoomAuthorizationError } from "./constants.js";
import { SupervisedAgentDeliveryInterrupts } from "./delivery-interrupts.js";
import { AuthorityLostError, persistedAcceptedTerminal, providerFailureDisplayText } from "./helpers.js";
import type { SupervisedIngressAgent } from "./types.js";

/** One admitted inbox item delivered to the provider as a bounded room turn. */
export abstract class SupervisedAgentDeliveryTurn extends SupervisedAgentDeliveryInterrupts {
  protected async deliver(agent: SupervisedIngressAgent, item: SupervisedInboxItem, controller: AbortController): Promise<void> {
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
    let workspaceBaseline: string | null = null;
    const observeWorkspace = async (summary?: string | null) => {
      if (workspaceObserved || item.provider_turn_id) return; // Recovery never reconstructs an old filesystem boundary.
      workspaceObserved = true;
      try { await this.observeSettledWorkspace?.(agent, item.source_message_id, item.inbox_item_id, summary, workspaceBaseline); } catch { /* optional review */ }
    };
    let providerCallEntered = false;
    let nativeDispatchEntered = false;
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
      try { this.observeTurn?.(agent.agentId, { inboxItemId: item.inbox_item_id, sourceMessageId: item.source_message_id }); } catch { /* observation only */ }
    };
    const retryFailure = async (failure: Parameters<SupervisedAgentInboxStore["recordRetryFailure"]>[1]): Promise<void> => {
      if (!await this.hasLaneAuthority(agent, turnController)) return;
      const { item: recorded, attempt } = await this.inbox.recordRetryFailure(item.inbox_item_id, failure);
      if (recorded.state === "blocked") {
        if (failure.domain === "pre_dispatch" && !recorded.provider_turn_id && !recorded.outcome) {
          void this.reportReplyTurnReceipt(agent, recorded, controller, "yield").catch(() => {});
        }
        return;
      }
      await this.sleep(failure.domain === "publication" ? this.retryDelayMs
        : Math.min(2_000, this.retryDelayMs * (2 ** (attempt - 1))));
      const retryable = await this.inbox.get(item.inbox_item_id);
      if (await this.hasLaneAuthority(agent, turnController) && retryable?.state === "retryable") {
        await this.inbox.transition(item.inbox_item_id, "pending");
      }
    };
    /**
     * Set when the saved turn was started by a process that has since ended.
     * A turn that the conversation's own record shows as started and never
     * ended was then cut off by that exit: the adapter says so instead of
     * leaving a result that will never come to be waited for.
     */
    let originProcessEnded = false;
    /** The saved turn's own conversation, when it is not the one this runtime continues. */
    let earlierContinuationId: string | null = null;
    let compactionObserver: ReplyTurnCompactionObserver | null = null;
    let disposeCompactionStream: (() => void) | null = null;
    const closeCompactionObservation = () => {
      compactionObserver?.close();
      try { disposeCompactionStream?.(); } catch { /* Optional scheduling observation. */ }
      disposeCompactionStream = null;
    };
    const startTrace = recovering ? null : turnStartLatency.begin(agent.agentId, item.inbox_item_id, agent.provider);
    let preparedAttachments: PreparedRoomTurnAttachments | null = null;
    let providerTurn: Promise<unknown> | undefined;
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
        void this.reportNoReply(agent, item, controller).catch(() => {});
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
          // An Open Model process starts a new session; the sessions of the
          // processes before it stay in the agent's own runtime directory.
          // Once the process that ran this turn has ended, its replacement
          // reads this exact turn there. Nothing else differs from the binding.
          const readsEarlierConversation = agent.provider === "open-model" && binding !== null && binding !== undefined
            && binding.agent_id === agent.agentId && binding.room_id === agent.roomId
            && binding.work_attempt_id === agent.workAttemptId && binding.provider_turn_id === item.provider_turn_id
            && await this.inbox.providerTurnProcessEnded(item.inbox_item_id, agent.executionGenerationId);
          if (!readsEarlierConversation) {
            await this.inbox.transition(item.inbox_item_id, "blocked", {
              last_error: "The saved provider turn belongs to a different or unverifiable provider authority and was not recovered.",
            });
            return;
          }
          earlierContinuationId = binding!.provider_continuation_id;
          originProcessEnded = true;
        } else if (agent.provider !== "cursor") {
          originProcessEnded = await this.inbox.providerTurnProcessEnded(item.inbox_item_id, agent.executionGenerationId);
        }
        providerTurnOriginExecutionGenerationId = binding.origin_execution_generation_id;
        // Close the read-to-use window: a replacement may have landed while
        // the durable binding was read. This final current-runtime check is
        // immediately followed by the provider call without another await.
        if (!await hasProviderAuthority()) return;
      }
      if (recovering) setActive("responding");
      else {
        // A turn an earlier process left open, whose message has since been
        // settled, would refuse this one in the agent's execution record.
        try { await this.archiveEndedRuntimes?.(agent.agentId); } catch { /* The record is optional; the turn is not. */ }
        if (!await hasProviderAuthority()) return;
        setActive("dispatching");
      }
      let observedContext = recovering
        ? []
        : (await this.inbox.observedContext(agent.agentId, agent.roomId, 30)).map((message) => message.source_message);
      if (!recovering && item.activation.turn && /^msg_[1-9]\d*$/.test(item.source_message_id) && this.http.context) {
        const bearer = agent.bearer;
        const owner = this.loopOwners.get(agent.agentId);
        const fresh = await this.http.context({ roomId: agent.roomId, apiUrl: agent.apiUrl,
          bearer, signal: turnController.signal }).catch((error: unknown) => {
          if (owner && error instanceof SupervisedRoomAuthorizationError && owner.bearer === bearer) {
            const hold = error.status === 401 ? this.bearerHold(agent.agentId, bearer) : null;
            if (hold) this.bearerRevoked(hold);
            else owner.roomRefused = true;
          }
          throw error;
        });
        if (fresh !== null) observedContext = fresh;
      }
      // A continuation that has not had the room's history summary gets it on
      // this turn, before the recent context. It is optional: no summary, an
      // older server or a failed read never delays or fails the turn.
      const historyContinuation = this.continuationOf(agent);
      const historyDue = !recovering && /^msg_[1-9]\d*$/.test(item.source_message_id)
        && Boolean(this.http.historySummary) && !this.historySummaryGiven.get(agent.agentId)?.has(historyContinuation);
      // undefined: the read failed, so the continuation is not marked and a later turn asks again.
      const historySummary = historyDue
        ? await this.http.historySummary!({ roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer,
          signal: turnController.signal }).catch(() => undefined)
        : undefined;
      if (!recovering && this.roomTurnAttachments && /^msg_[1-9]\d*$/.test(item.source_message_id)) {
        // This turn's activating message, then images on recent messages
        // before it that this agent has not received. A file that cannot be
        // given becomes a note in the prompt, never a failed turn; only Stop
        // or retirement ends the preparation early. A recovered turn never
        // comes here, so it never downloads again.
        const handle = agent.handle;
        const delivery: RoomTurnImageDelivery = handle && this.provider.roomTurnImageDelivery
          ? await this.provider.roomTurnImageDelivery(handle).catch(() => null) : null;
        // A thread whose root the room context lacks is read, and only for an
        // agent that can see its images. A context that holds the root holds
        // every later reply too.
        const threadRootId = delivery ? activatingThreadRootId(item.source_message, item.source_message_id) : null;
        const contextHasRoot = observedContext.some(message => message && typeof message === "object"
          && (message as Record<string, unknown>).id === threadRootId);
        const thread = threadRootId && !contextHasRoot && this.http.thread
          ? await this.http.thread({ roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer,
            rootMessageId: threadRootId, beforeMessageId: item.source_message_id,
            limit: ROOM_TURN_RECENT_MESSAGE_WINDOW, signal: turnController.signal }).catch(() => {
            turnController.signal.throwIfAborted();
            return null;
          })
          : null;
        const recentMessages = recentRoomImageMessages({ sourceMessage: item.source_message,
          sourceMessageId: item.source_message_id, context: observedContext, thread, agentSessionId: agent.agentSessionId });
        // What this conversation already has; a new conversation is offered the images again.
        const continuation = agent.handle?.providerContinuationId ?? agent.providerContinuationId;
        const earlierOutcomes = recentMessages.length && continuation
          ? await this.inbox.roomTurnFileOutcomes(agent.agentId, agent.roomId, continuation).catch(() => new Map())
          : new Map();
        preparedAttachments = await this.roomTurnAttachments.prepare({
          delivery,
          localRoom: isLocalRoomApi(agent.apiUrl),
          sourceMessage: item.source_message, sourceMessageId: item.source_message_id,
          recentMessages, earlierOutcomes,
          roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer,
          http: this.http, signal: turnController.signal,
        });
      }

      if (!await hasProviderAuthority()) return;
      // A runtime can itself have ended by the time it reports its turn's
      // exact ending: a crashed Cursor lane, or any provider whose handle
      // failed during the turn. The lane lease and the turn checks still prove
      // that this owner may record a failed or interrupted ending and settle
      // the row. Requiring a healthy runtime for that left the row pending for
      // ever behind an error about delivery authority instead of the
      // provider's own. An answer still needs a runtime the daemon may use.
      const hasTerminalAuthority = (result: ProviderRoomTurnResult): Promise<boolean> =>
        result.outcome === "failed" || result.outcome === "interrupted"
          ? this.hasLaneAuthority(agent, turnController)
          : this.hasExecutionAuthority(agent, turnController);
      // Handoff may abandon observation only after the provider has committed
      // an exact, recoverable native turn boundary. Before then, the provider
      // promise owns preflight/helper cleanup and must settle before drain can
      // release this daemon generation.
      let settledCursorEnding: ProviderRoomTurnCheckpointDisposition | null = null;
      let silenceYieldRegistered = false;
      const checkpointTerminalResult = async (result: ProviderRoomTurnResult): Promise<ProviderRoomTurnCheckpointDisposition> => {
        closeCompactionObservation(); // A terminal edge must cancel the hint before any checkpoint await.
        if (settledCursorEnding) return settledCursorEnding;
        const providerContinuationId = earlierContinuationId ?? agent.handle?.providerContinuationId ?? agent.providerContinuationId;
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
        if (!await hasTerminalAuthority(result)) throw new AuthorityLostError();
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
          task_owner_session_id: this.http.ownedTasks ? agent.agentSessionId : undefined,
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
        const disposition = {
          acceptedResult,
          cleanupRecoveryEvidence: acceptedResult.outcome !== "unreadable",
        };
        // Real adapters checkpoint here before returning. Do not wait for the
        // outer idempotent authority/checkpoint pass to offer this slot.
        if (!recovering && acceptedResult.outcome === "no_reply" && !silenceYieldRegistered) {
          silenceYieldRegistered = true;
          void this.reportReplyTurnReceipt(agent, item, turnController, "settlement_yield").catch(() => {});
        }
        if (agent.provider === "cursor"
          && (acceptedResult.outcome === "failed" || acceptedResult.outcome === "interrupted")) {
          // Settle the row while this lane lease still holds. Right after this
          // callback the adapter retires the crashed lane, and its exit
          // notification removes the live handle the lease depends on.
          await observeWorkspace(null);
          if (await hasTerminalAuthority(acceptedResult)) {
            await this.inbox.transition(item.inbox_item_id, "acknowledged_failed");
            await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
            settledCursorEnding = disposition;
          }
        }
        return disposition;
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
      let baselineObserved = false;
      const beforeDispatch = async () => {
        const firstDispatch = !nativeDispatchEntered;
        nativeDispatchEntered = true;
        if (firstDispatch) startTrace?.mark("provider_entry");
        if (!await this.hasExecutionAuthority(agent, turnController)) throw new AuthorityLostError();
        const continuation = await this.inbox.taskContinuation(item.inbox_item_id);
        if (continuation) {
          const tasks = this.http.ownedTasks
            ? await this.ownedTasks(agent, { taskIds: continuation.tasks?.map((task) => task.id), heldBefore: continuation.heldBefore, signal: turnController.signal })
            : undefined;
          if (!tasks || continuation.agentSessionId !== agent.agentSessionId || continuation.workAttemptId !== agent.workAttemptId
            || continuation.providerContinuationId !== agent.providerContinuationId
            || !continuation.tasks?.length || !continuation.tasks.every((old) => tasks.some((task) => old.id === task.id && old.leaseId === task.leaseId && old.epoch === task.epoch))
            || await this.inbox.taskContinuationHasUncertainEffects(item.inbox_item_id)) {
            throw new Error("Task continuation ownership or prior action evidence changed before dispatch. No task continuation was started.");
          }
        }
        if (!baselineObserved) {
          baselineObserved = true;
          startTrace?.mark("dispatch_checks");
          try { workspaceBaseline = await this.observeStartingWorkspace?.(agent, item.source_message_id, item.inbox_item_id) || null; } catch { /* Optional observation. */ }
          startTrace?.mark("workspace_begin");
        }
        if (!await this.hasExecutionAuthority(agent, turnController)) throw new AuthorityLostError();
        await this.inbox.checkpointDispatchIntent(item.inbox_item_id, this.http.ownedTasks ? agent.agentSessionId : undefined, observedContext);
        // None to give: later turns need not ask. A summary counts as given
        // only once the provider has answered the turn that carried it.
        if (historyDue && historySummary === null) this.markHistorySummaryGiven(agent.agentId, [historyContinuation]);
        if (firstDispatch) startTrace?.mark("dispatch_intent");
      };
      // A turn the execution record holds open is closed there by its ending.
      // One the record never saw start has nothing to close, and its ending
      // would be a fact about a turn the record cannot place.
      const recordEnding = recovering
        && await this.inbox.recordedTurnIsOpen(item.inbox_item_id).catch(() => false);
      if (agent.provider === "codex" && item.activation.turn && this.http.yieldReplyTurn
        && this.provider.onStream && agent.handle && agent.providerContinuationId && agent.providerConnection
        && sameProviderActionConnectionIdentity(agent.providerConnection, agent.handle.providerConnection)) {
        const handle = agent.handle;
        const connection = { ...agent.providerConnection };
        compactionObserver = new ReplyTurnCompactionObserver({ workAttemptId: agent.workAttemptId,
          providerContinuationId: agent.providerContinuationId }, proof => {
          void this.reportReplyTurnReceipt(agent, item, turnController, "compaction_yield", {
            proof, invocationId, recoveryContext, handle, connection,
            originExecutionGenerationId: providerTurnOriginExecutionGenerationId,
          }).catch(() => {});
        });
        try {
          const observer = compactionObserver;
          disposeCompactionStream = await this.provider.onStream(handle, event => {
            try { observer.observe(event); } catch { observer.close(); }
          });
          if (item.provider_turn_id) observer.admit(item.provider_turn_id);
        } catch { closeCompactionObservation(); }
        if (!await hasProviderAuthority()) return;
      }
      if (startTrace) startTrace.providerCalled();
      else turnStartLatency.unmeasuredTurnStarted(agent.agentId);
      providerCallEntered = true;
      const turn = recovering
        ? this.provider.recoverRoomTurn?.(agent.handle, {
          inboxItemId: item.inbox_item_id,
          providerTurnId: item.provider_turn_id!,
          ...(recordEnding ? { recordEnding: true } : {}),
          ...(originProcessEnded ? { originProcessEnded: true } : {}),
          ...(earlierContinuationId ? { providerContinuationId: earlierContinuationId } : {}),
          ...(item.state === "result_recovery" ? { savedAsUnreadable: true } : {}),
        }, { detachSignal: turnController.signal, checkpointProviderState, settleLifecycleBeforeIdle, checkpointTerminalResult })
        : this.provider.runRoomTurn?.(agent.handle, {
        roomId: agent.roomId,
        inboxItemId: item.inbox_item_id,
        sourceMessage: item.source_message,
        activation: item.activation,
        actionId: item.action_id,
        observedContext,
        ...(historySummary ? { historySummary } : {}),
        ...(preparedAttachments?.attachments.length ? { attachments: preparedAttachments.attachments } : {}),
      }, { beforeNativeDispatch: beforeDispatch, markDispatched: async () => {
        await beforeDispatch();
        setActive("responding");
      }, checkpointTurnStarted: async (turnId) => {
        startTrace?.mark("provider_start");
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
        startTrace?.mark("turn_checkpoint");
        admittedProviderTurnId = turnId;
        this.bindInterruptReservationProviderTurn(agent, invocationId, item.inbox_item_id, turnId);
        // Only an acknowledged exact provider turn is projected responding.
        setActive("responding");
        // Cursor additionally checkpoints its wrapper birth before allowing
        // retirement; every other adapter's exact turn id is its recovery key.
        if (agent.provider !== "cursor") markProviderTurnDurablyStarted();
        compactionObserver?.admit(turnId);
      }, checkpointPreparedTurn, checkpointProviderState, settleLifecycleBeforeIdle, markDurableTurnStarted: () => {
        if (agent.provider === "cursor" && this.checkpointPreparedTurn) {
          cursorNativeReleased = true;
        } else {
          markProviderTurnDurablyStarted();
        }
      }, checkpointTerminalResult, detachSignal: turnController.signal });
      providerTurn = turn;
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
      if (providerResult) startTrace?.providerEnded(providerResult.outcome);
      if (providerResult && preparedAttachments?.outcomes.length) {
        // A provider that answered this turn, in any way, had its files: a
        // later turn of the same conversation does not send them again.
        // Remembering them is optional and never fails the turn.
        const continuation = ("providerContinuationId" in providerResult ? providerResult.providerContinuationId : null)
          ?? agent.handle?.providerContinuationId ?? agent.providerContinuationId;
        if (continuation) {
          await this.inbox.recordRoomTurnFiles(item.inbox_item_id, { continuation, files: preparedAttachments.outcomes.map(file => ({
            message_id: file.messageId, attachment_id: file.attachmentId, outcome: file.outcome })) }).catch(() => {});
        }
      }
      if (providerResult && historySummary) {
        this.markHistorySummaryGiven(agent.agentId, [historyContinuation, this.continuationOf(agent),
          "providerContinuationId" in providerResult ? providerResult.providerContinuationId : ""]);
      }
      closeCompactionObservation();
      if (!providerResult) throw new Error("Provider does not support bounded room turns.");
      if (settledCursorEnding) return;
      if (!await (recovering ? hasProviderAuthority() : hasTerminalAuthority(providerResult))) return;
      // Real provider adapters invoke this before releasing their in-memory
      // stream accumulator. The repeat is intentionally idempotent for simple
      // test adapters and future provider implementations.
      const { acceptedResult: result } = await checkpointTerminalResult(providerResult);
      // Review capture and a successful reply may travel together. Keep this
      // lane occupied until capture finishes, before ACK or another local turn.
      const workspaceCapture = observeWorkspace(result.text);
      try {
        if (result.outcome !== "reply") await workspaceCapture;
        const evidence = result.evidence ?? (result.outcome === "unreadable" ? "none" : "transcript");
        const outcome = JSON.stringify({ kind: result.outcome, text: result.text?.trim() || null, evidence });
        if (!await hasTerminalAuthority(result)) return;
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
            await this.inbox.transition(item.inbox_item_id, "blocked", { outcome, last_error: "The result of this turn is still unavailable after re-reading it. No new model turn was started." });
          } else {
            await this.inbox.transition(item.inbox_item_id, "result_recovery", { outcome, last_error: "The result of this turn is unavailable. Checking the existing provider turn without starting a new one." });
          }
          return;
        }
        if (result.outcome === "no_reply") {
          const timing = new RoomLatencyTrace("silent_ack");
          try {
            if (!await this.hasExecutionAuthority(agent, turnController)) return;
            timing.mark("authority");
            await this.inbox.transition(item.inbox_item_id, "acknowledged_no_reply", { outcome });
            timing.mark("database");
            void this.reportNoReply(agent, item, controller).catch(() => {});
            await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
            return;
          } finally { timing.finish(); }
        }
        const text = result.text?.trim();
        if (!text) throw new Error("Provider returned an empty room answer without the no-reply outcome.");
        // The terminal payload is checkpointed before the external publication.
        // A crash after this point retries the same client id without rerunning the provider.
        await this.inbox.transition(item.inbox_item_id, "publishing", { outcome });
        setActive("publishing");
        if (!await this.publish(agent, item, text, controller)) return;
        await workspaceCapture;
        if (!await this.hasExecutionAuthority(agent, controller)) return;
        await this.inbox.checkpointPublication({ inbox_item_id: item.inbox_item_id, room_id: agent.roomId, canonical_message_id: await this.publishedMessageId(agent, item) });
        await this.commitPreparedRoomMove?.({ agent, inboxItemId: item.inbox_item_id });
      } finally {
        // HTTP failure, Stop or authority loss must join before catch/recovery
        // and before releaseWorkspace can remove the capture worker's refs.
        await workspaceCapture;
      }
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
      if ((nativeFailure || acceptedTerminal) && await this.hasLaneAuthority(agent, controller)) await observeWorkspace(acceptedTerminal?.kind === "reply" ? acceptedTerminal.text : null);
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
        void this.reportNoReply(agent, item, controller).catch(() => {});
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
      if (failure.providerFailureCode === "provider_room_tools_unavailable"
        && agent.provider === "codex" && !recovering && !nativeDispatchEntered
        && !current.provider_turn_id && !current.outcome) {
        // This failure is emitted before dispatch intent or turn/start. Keep
        // the exact inbox item for Retry after tool/runtime recovery; do not
        // imply an uncertain model turn or spend the model-attempt budget.
        await this.inbox.transition(item.inbox_item_id, "blocked", { last_error: message });
        return;
      }
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
      if (preparedAttachments) {
        // A staged file stays until the provider turn that reads it has ended.
        // Codex reads its local image after its turn has started, and a
        // detached observation (Stop, retirement) rejects while the native
        // turn may still run: those files are left to the age sweep.
        const { release, abandon } = preparedAttachments;
        if (!providerTurn) void release();
        else void providerTurn.then(() => release(), () => abandon());
      }
      if (startTrace) startTrace.end();
      else if (providerCallEntered) turnStartLatency.unmeasuredTurnEnded(agent.agentId);
      closeCompactionObservation();
      try { await this.releaseWorkspace?.(agent, item.source_message_id, item.inbox_item_id); } catch { /* Optional retention cleanup. */ }
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
        && active.inboxItemId === item.inbox_item_id) {
        this.activeTurns.delete(agent.agentId);
        try { this.observeTurn?.(agent.agentId, { ended: item.inbox_item_id }); } catch { /* observation only */ }
      }
      await restoreProvenUndispatchedClaim();
      const interrupt = this.interruptReservations.get(agent.agentId);
      if (interrupt?.reservation.invocationId === invocationId
        && interrupt.recoveryContext === recoveryContext
        && interrupt.reservation.inboxItemId === item.inbox_item_id
        && interrupt.disposition) {
        this.interruptReservations.delete(agent.agentId);
      }
      // Native idle can arrive while publication or this delivery still owns
      // the lane. Wake the existing guarded convergence after releasing it;
      // settlement itself is not proof that the provider may be replaced.
      this.onDeliverySettled?.(agent.agentId);
    }
  }
}
