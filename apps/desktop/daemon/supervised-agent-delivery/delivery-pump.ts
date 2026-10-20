import { sameInboxHead } from "../supervised-agent-inbox-store.js";
import { defaultFollowUpDelayMs, FOLLOW_UP_ENDED, OWNERSHIP_UNVERIFIED_BEFORE_START_DETAIL, OWNERSHIP_UNVERIFIED_DETAIL, taskFailurePolicy, type ContinuityTask } from "../task-continuity.js";
import { SupervisedAgentDeliveryTurn } from "./delivery-turn.js";
import { AGENT_CHANGED_BEFORE_TRY_NOW, AuthorityLostError, noLongerAvailable, pollErrorBackoffMs, providerFailureDisplayText, scheduledFollowUp } from "./helpers.js";
import type { SupervisedIngressAgent } from "./types.js";

/** The FIFO pump, and owner retry, restore and skip of one message. */
export abstract class SupervisedAgentDeliveryPump extends SupervisedAgentDeliveryTurn {
  retry(agent: SupervisedIngressAgent, sourceMessageId: string): Promise<void> {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.isStopping(agent.agentId)) {
      return Promise.reject(new Error("The room delivery binding changed before retry could start."));
    }
    const controller = new AbortController();
    const operation = this.trackAgentWork(agent.agentId, this.track(controller, this.retryOperation(agent, sourceMessageId, controller)));
    const retries = this.retries.get(agent.agentId) ?? new Set<Promise<void>>();
    const controllers = this.auxiliaryControllers.get(agent.agentId) ?? new Set<AbortController>();
    retries.add(operation); controllers.add(controller);
    this.retries.set(agent.agentId, retries); this.auxiliaryControllers.set(agent.agentId, controllers);
    const cleanup = () => {
      retries.delete(operation); controllers.delete(controller);
      if (this.retries.get(agent.agentId) === retries && retries.size === 0) this.retries.delete(agent.agentId);
      if (this.auxiliaryControllers.get(agent.agentId) === controllers && controllers.size === 0) this.auxiliaryControllers.delete(agent.agentId);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }


  protected wakePumpAfterSettlement(agent: SupervisedIngressAgent): void {
    if (agent.handle) this.admissionDemands.set(agent.handle, {});
    const current = this.pumping.get(agent.agentId);
    if (!current) {
      this.schedulePump(agent);
      return;
    }
    if (this.pumpWakeups.get(agent.agentId) === current) return;
    this.pumpWakeups.set(agent.agentId, current);
    // schedulePump intentionally coalesces while a pump is registered. If that
    // pump already observed the formerly-blocked head and is merely resolving,
    // coalescing here would lose the wake. The pump's own cleanup continuation
    // was registered when it was installed; one extra microtask guarantees the
    // registry is clear before installing the successor.
    const wake = () => queueMicrotask(() => {
      if (this.pumpWakeups.get(agent.agentId) !== current) return;
      this.pumpWakeups.delete(agent.agentId);
      this.schedulePump(agent);
    });
    void current.then(wake, wake);
  }

  protected async retryOperation(agent: SupervisedIngressAgent, sourceMessageId: string, controller: AbortController): Promise<void> {
    if (!await this.hasExecutionAuthority(agent, controller)) throw new AuthorityLostError();
    const receipts = await this.inbox.receipts(agent.agentId);
    if (!await this.hasExecutionAuthority(agent, controller)) throw new AuthorityLostError();
    const item = receipts.find((receipt) => receipt.source_message_id === sourceMessageId && receipt.state === "blocked");
    const scheduled = item ? null : scheduledFollowUp(receipts, sourceMessageId);
    if (!item && !scheduled) throw new Error(noLongerAvailable(sourceMessageId, "The blocked room delivery is no longer available for this exact agent."));
    if (!await this.hasExecutionAuthority(agent, controller)) throw new AuthorityLostError();
    if (scheduled) {
      // Try now. The follow-up that waited for its time starts at once, as the attempt it already was.
      await this.inbox.startTaskContinuationNow(scheduled.inbox_item_id);
      if (!await this.hasExecutionAuthority(agent, controller)) throw new Error(AGENT_CHANGED_BEFORE_TRY_NOW);
      this.followUpWaits.get(agent.agentId)?.abort();
      if (!this.wake(agent)) throw new Error(AGENT_CHANGED_BEFORE_TRY_NOW);
      return;
    }
    await this.inbox.retryBlocked(item!.inbox_item_id);
    // The row is now truthfully pending; if authority changed during the
    // durable transition, reject the stale control request rather than claim
    // it began provider work. The successor will recover this pending head.
    if (!await this.hasExecutionAuthority(agent, controller)) {
      throw new Error("The room delivery binding changed before retry could start.");
    }
    // The control RPC acknowledges the durable blocked -> pending transition
    // and installation of tracked work, never the provider turn itself. A
    // A provider turn can outlive Electron's control-RPC timeout by minutes.
    if (!this.wake(agent)) {
      throw new Error("The room delivery binding changed before retry could start.");
    }
  }

  restoreConversation(agent: SupervisedIngressAgent, sourceMessageId: string): Promise<void> {
    if (!this.restoreMissingContinuation || !this.daemonIngressAllowed(agent) || this.fenced || this.isStopping(agent.agentId)) {
      return Promise.reject(new Error("Conversation restoration is unavailable for this exact agent."));
    }
    const controller = new AbortController();
    return this.trackAgentWork(agent.agentId, this.track(controller, this.restoreConversationOperation(agent, sourceMessageId, controller)));
  }

  protected async restoreConversationOperation(agent: SupervisedIngressAgent, sourceMessageId: string, controller: AbortController): Promise<void> {
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
    if (outcome === "restored" && !this.wake(agent)) {
      throw new Error("The room delivery binding changed before the restored message could resume.");
    }
  }

  skipMessage(agent: SupervisedIngressAgent, sourceMessageId: string): Promise<void> {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.isStopping(agent.agentId)) {
      return Promise.reject(new Error("The room delivery binding changed before the message could be skipped."));
    }
    const controller = new AbortController();
    return this.trackAgentWork(agent.agentId, this.track(controller, this.skipMessageOperation(agent, sourceMessageId, controller)));
  }

  protected async skipMessageOperation(agent: SupervisedIngressAgent, sourceMessageId: string, controller: AbortController): Promise<void> {
    if (!await this.hasIngressAuthority(agent, controller)) throw new AuthorityLostError();
    const receipts = await this.inbox.receipts(agent.agentId);
    const item = receipts.find((candidate) => candidate.source_message_id === sourceMessageId && candidate.state === "blocked");
    const scheduled = item ? null : scheduledFollowUp(receipts, sourceMessageId);
    if (scheduled) {
      // Stop trying. Nothing has started for this follow-up, and nothing more starts by itself for its task.
      await this.inbox.stopTaskContinuation(scheduled.inbox_item_id, FOLLOW_UP_ENDED.stoppedByOwner);
      this.followUpWaits.get(agent.agentId)?.abort();
      this.wake(agent);
      return;
    }
    if (!item) throw new Error(noLongerAvailable(sourceMessageId, "The blocked room message is no longer available for this exact agent."));
    // Blocked rows have no live consumer; refuse if this process still has one.
    if (this.activeTurns.get(agent.agentId)?.inboxItemId === item.inbox_item_id
      || this.activeTurnAborts.get(agent.agentId)?.inboxItemId === item.inbox_item_id) {
      throw new Error("This message is still being delivered. Try again once it settles.");
    }
    await this.inbox.skipBlocked(item.inbox_item_id);
    if (!await this.hasIngressAuthority(agent, controller)) {
      throw new Error("The room delivery binding changed after the message was safely skipped.");
    }
    this.wake(agent);
  }

  protected schedulePump(agent: SupervisedIngressAgent): boolean {
    if (this.fenced || this.isStopping(agent.agentId)) return false;
    // pump() registers its controller and operation before its first await, so
    // handoff/refresh still drains this work even though the RPC returns now.
    void this.pump(agent).catch(() => undefined);
    return !this.fenced && !this.isStopping(agent.agentId);
  }

  /** Install tracked FIFO work without making the control RPC wait for the
   * provider turn or publication to finish. */
  wake(agent: SupervisedIngressAgent): boolean {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.isStopping(agent.agentId)) return false;
    this.wakePumpAfterSettlement(agent);
    return !this.fenced && !this.isStopping(agent.agentId);
  }

  pump(agent: SupervisedIngressAgent): Promise<void> {
    if (!this.daemonIngressAllowed(agent) || this.fenced || this.isStopping(agent.agentId) || this.pumping.has(agent.agentId)) return Promise.resolve();
    const controller = new AbortController();
    const operation = this.trackAgentWork(agent.agentId, this.track(controller, this.recoveringPumpOperation(agent, controller)));
    this.pumping.set(agent.agentId, operation);
    this.pumpControllers.set(agent.agentId, controller);
    this.pumpAgents.set(agent.agentId, agent);
    const settle = () => {
      if (this.pumping.get(agent.agentId) === operation) this.pumping.delete(agent.agentId);
      if (this.pumpControllers.get(agent.agentId) === controller) this.pumpControllers.delete(agent.agentId);
      if (this.pumpAgents.get(agent.agentId) === agent && !this.pumping.has(agent.agentId)) this.pumpAgents.delete(agent.agentId);
    };
    void operation.then(settle, settle);
    return operation;
  }

  protected async recoveringPumpOperation(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    let failures = 0;
    while (await this.hasLaneAuthority(agent, controller)) {
      try {
        await this.pumpOperation(agent, controller);
        return;
      } catch (error) {
        if (!await this.hasLaneAuthority(agent, controller)) return;
        failures += 1;
        // Observation owns ingress health. Delivery recovery must neither hide
        // a failed poll nor leave a stale warning after an independent retry.
        if (failures === 1) console.warn(providerFailureDisplayText(
          `Room delivery recovery for ${agent.agentId}: ${error instanceof Error ? error.message : "Room delivery recovery failed."}`,
        ));
        // Fault-only retry belongs to the tracked delivery operation. It must
        // recover even while room intake is waiting on an otherwise idle poll.
        if (!await this.waitForNextPoll(controller, pollErrorBackoffMs(failures))) return;
      }
    }
  }

  protected async pumpOperation(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    try {
      if (!agent.handle || !await this.hasLaneAuthority(agent, controller)) return;
      const recoveryContext = this.recoveryContext(agent);
      if (this.startupRecovered.get(agent.agentId) !== recoveryContext) {
        const recovered = await this.inbox.normalizeStartupRecovery(agent.agentId, {
          resetCheckpointGatedUnstartedDispatch: agent.provider === "cursor",
        });
        if (!await this.hasLaneAuthority(agent, controller)) return;
        this.startupRecovered.set(agent.agentId, recoveryContext);
        if (recovered.some(item => item.state === "acknowledged_no_reply" || item.state === "acknowledged_failed")) {
          this.onDeliverySettled?.(agent.agentId);
        }
      }
      for (;;) {
        if (this.dispatchIsPaused(agent)) return;
        const head = await this.inbox.head(agent.agentId);
        const exactCursorRecovery = agent.provider === "cursor" && Boolean(head?.provider_turn_id);
        if (!(exactCursorRecovery
          ? await this.hasCursorTransitionAuthority(agent, controller)
          : await this.hasExecutionAuthority(agent, controller))) return;
        if (!head && this.http.ownedTasks) {
          const failed = await this.inbox.taskContinuityCandidate(agent.agentId);
          if (failed && failed.room_id === agent.roomId && failed.activation.task_continuity_owner_session_id === agent.agentSessionId) {
            const binding = await this.inbox.providerTurnBinding(failed.inbox_item_id);
            if (binding?.work_attempt_id !== agent.workAttemptId || binding.provider_continuation_id !== agent.providerContinuationId) return;
            const prior = await this.inbox.taskContinuation(failed.inbox_item_id);
            const attempt = (prior?.attempt ?? 0) + 1;
            // Claude's structured fields, and Claude Code's own words, decide for a Claude failure. Any other
            // provider's failure is read as before.
            const claudeCode = agent.provider === "claude-code";
            const policy = taskFailurePolicy(failed.last_error, attempt, await this.inbox.providerRefusedTurn(failed.inbox_item_id),
              await this.inbox.providerResultUnrecognized(failed.inbox_item_id),
              claudeCode ? await this.inbox.claudeApiFailure(failed.inbox_item_id) : null, claudeCode);
            let tasks: ContinuityTask[] = [];
            let lookupError: string | null = null;
            try { tasks = await this.ownedTasks(agent, { taskIds: prior?.tasks?.map((task) => task.id), heldBefore: prior?.heldBefore ?? String(failed.activation.task_continuity_failed_at), signal: controller.signal }); }
            catch { lookupError = OWNERSHIP_UNVERIFIED_DETAIL; }
            if (!await this.hasExecutionAuthority(agent, controller)) return;
            const queued = await this.inbox.enqueueTaskContinuation({ parentId: failed.inbox_item_id,
              agentId: agent.agentId, roomId: agent.roomId, workAttemptId: agent.workAttemptId,
              providerContinuationId: binding.provider_continuation_id, agentSessionId: agent.agentSessionId,
              tasks: lookupError ? null : prior?.tasks ? tasks.filter((task) => prior.tasks!.some((old) => old.id === task.id && old.leaseId === task.leaseId && old.epoch === task.epoch)) : tasks,
              blockReason: lookupError ?? (policy.automatic ? null : policy.detail), detail: policy.detail,
              settleReason: policy.settle ? policy.detail : null, note: policy.note ?? null, kind: policy.kind ?? null,
              delayMs: this.retryDelayMs === 0 ? 0 : policy.delayMs ?? defaultFollowUpDelayMs(attempt),
            });
            if (queued) continue;
          }
          return;
        }
        if (head?.state === "blocked" && head.failure_code === "provider_continuation_missing" && this.restoreMissingContinuation) {
          const restored = await this.restoreMissingContinuation({ agent, item: head, manual: false });
          // A replacement installs a successor handle and starts a successor
          // delivery epoch. This stale pump must retire, while a rematerialized
          // conversation can continue on the current exact handle.
          if (restored !== "restored") return;
          continue;
        }
        if (head?.state === "pending") {
          let continuation = await this.inbox.taskContinuation(head.inbox_item_id);
          if (continuation) {
            if (continuation.workAttemptId !== agent.workAttemptId || continuation.agentSessionId !== agent.agentSessionId
              || continuation.providerContinuationId !== agent.providerContinuationId || head.room_id !== agent.roomId) {
              await this.inbox.finishUnusedTaskContinuation(head.inbox_item_id, FOLLOW_UP_ENDED.agentChanged);
              continue;
            }
            const delay = await this.inbox.taskContinuationDelay(head.inbox_item_id);
            if (delay > 0) {
              const wait = new AbortController();
              const endWithPump = () => wait.abort();
              controller.signal.addEventListener("abort", endWithPump, { once: true });
              // An abort during the reads above has already happened: no event will come for it.
              if (controller.signal.aborted || this.dispatchPaused) wait.abort();
              this.followUpWaits.set(agent.agentId, wait);
              try { await this.waitForPollDelay(delay, wait.signal); } finally {
                controller.signal.removeEventListener("abort", endWithPump);
                if (this.followUpWaits.get(agent.agentId) === wait) this.followUpWaits.delete(agent.agentId);
              }
              // The owner ended the wait. Read the head again: the follow-up is due now, or it is gone.
              if (wait.signal.aborted && !controller.signal.aborted) continue;
            }
            if (!await this.hasExecutionAuthority(agent, controller)) return;
            let tasks: ContinuityTask[];
            try {
              tasks = await this.ownedTasks(agent, { taskIds: continuation.tasks?.map((task) => task.id), heldBefore: continuation.heldBefore, signal: controller.signal });
            } catch {
              if (await this.hasExecutionAuthority(agent, controller)) await this.inbox.transition(head.inbox_item_id, "blocked", { last_error: OWNERSHIP_UNVERIFIED_BEFORE_START_DETAIL });
              return;
            }
            if (!await this.hasExecutionAuthority(agent, controller)) return;
            const retained = continuation.tasks ? tasks.filter((task) => continuation!.tasks!.some((old) => old.id === task.id && old.leaseId === task.leaseId && old.epoch === task.epoch)) : tasks;
            if (!retained.length) {
              await this.inbox.finishUnusedTaskContinuation(head.inbox_item_id, FOLLOW_UP_ENDED.taskNotHeld);
              continue;
            }
            try { continuation = await this.inbox.refreshTaskContinuationSnapshot(head.inbox_item_id, retained); } catch (error) {
              // Its owner stopped it at the moment its time came. That is not a fault: go on with the next head.
              if ((await this.inbox.get(head.inbox_item_id))?.state !== "pending") continue;
              throw error;
            }
            if (await this.inbox.taskContinuationHasUncertainEffects(head.inbox_item_id)) {
              await this.inbox.finishUnusedTaskContinuation(head.inbox_item_id, FOLLOW_UP_ENDED.uncertainEffects);
              return;
            }
          }
        }
        if (head?.state === "pending" && !head.provider_turn_id && !head.outcome && this.canAdmitNewTurn) {
          const demand = this.admissionDemands.get(agent.handle) ?? {};
          this.admissionDemands.set(agent.handle, demand);
          const admitted = await this.canAdmitNewTurn(agent, demand);
          if (!await this.hasExecutionAuthority(agent, controller) || !admitted) return;
        }
        if (this.dispatchIsPaused(agent)) return;
        const item = await this.inbox.claimHead(agent.agentId, head);
        if (!item) {
          // Retry or settlement can change the head during admission's awaits.
          // Inspect it again rather than let uninspected work cross the gate.
          if (!sameInboxHead(head, await this.inbox.head(agent.agentId))) continue;
          return; // blocked, in-flight, or empty: FIFO remains intact.
        }
        if (this.dispatchIsPaused(agent) && !item.provider_turn_id && !item.outcome) {
          // The claim raced the admission pause; no provider invocation began.
          await this.inbox.resetPreNativeHandoff(item.inbox_item_id);
          return;
        }
        await this.deliver(agent, item, controller);
      }
    } finally { /* tracked by pump(), including handoff draining. */ }
  }
}
