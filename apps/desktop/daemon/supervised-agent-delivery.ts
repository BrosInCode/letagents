import type { ProviderActionHandle, ProviderActionPort } from "./provider-action-port.js";
import { SupervisedAgentInboxStore, type InboxActivation, type IngressMessage, type SupervisedInboxItem } from "./supervised-agent-inbox-store.js";

export type SupervisedIngressAgent = {
  agentId: string;
  roomId: string;
  provider: string;
  /** Bound worker API origin; never inferred from a persisted credential. */
  apiUrl: string;
  agentSessionId: string;
  bearer: string;
  handle: ProviderActionHandle;
  /** Exact daemon generation that owns this room worker binding. */
  executionGenerationId: string;
  daemonGeneration: number;
};

/** The bearer is intentionally memory-only and must never be persisted or logged. */
export type SupervisedDeliveryAuthority = Pick<SupervisedIngressAgent, "agentId" | "roomId" | "provider" | "apiUrl" | "agentSessionId" | "bearer" | "executionGenerationId" | "daemonGeneration" | "handle"> & {
  workAttemptId: string;
  providerContinuationId: string | null;
  pid: number | null;
};
export type SupervisedAuthorityRevalidator = (authority: SupervisedDeliveryAuthority) => Promise<boolean> | boolean;

export type SupervisedPollResponse = {
  messages?: Array<Record<string, unknown>>;
  last_observed_message_id?: string | null;
};

export interface SupervisedDeliveryHttp {
  poll(input: { roomId: string; apiUrl: string; bearer: string; afterMessageId: string | null; signal: AbortSignal }): Promise<SupervisedPollResponse>;
  publish(input: { roomId: string; apiUrl: string; bearer: string; text: string; clientMessageId: string; signal: AbortSignal }): Promise<void>;
}

export type SupervisedPollWait = (delayMs: number, signal: AbortSignal) => Promise<void>;

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
  ) {}

  fence(): void {
    this.fenced = true;
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
    return this.pollOnce(agent);
  }

  /** Starts the daemon-owned long-poll loop and normalizes persisted work first. */
  async start(agent: SupervisedIngressAgent, expectedEpoch = this.currentRefreshEpoch(agent.agentId)): Promise<void> {
    const existingLoop = this.loops.get(agent.agentId);
    if (this.fenced || this.stoppingAgents.has(agent.agentId) || expectedEpoch !== this.currentRefreshEpoch(agent.agentId)) return Promise.resolve();
    if (existingLoop && this.loopEpochs.get(agent.agentId) === expectedEpoch) return Promise.resolve();
    // refresh() drains a prior epoch before reaching start(). If an old loop is
    // still registered, it cannot be mistaken for this epoch's successor.
    if (existingLoop) return Promise.resolve();
    // The authority can change while a coalesced drain is settling. Verify the
    // exact route immediately before installation, then re-check the reserved
    // epoch after that await so a newer rebind or external stop wins.
    if (!await this.hasAuthority(agent)
      || this.fenced
      || this.stoppingAgents.has(agent.agentId)
      || expectedEpoch !== this.currentRefreshEpoch(agent.agentId)
      || this.loops.has(agent.agentId)) return;
    const controller = new AbortController();
    this.loopControllers.set(agent.agentId, controller);
    const operation = this.trackAgentWork(agent.agentId, this.track(controller, this.pollLoop(agent, controller)));
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
    // The loop itself is tracked by fenceAndDrain(); callers only need to know
    // that it was installed, not wait for the worker's lifetime.
    return Promise.resolve();
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

  private stopForRefresh(agentId: string): Promise<void> {
    const prior = this.stoppingOperations.get(agentId);
    if (prior) return prior;
    this.stoppingAgents.add(agentId);
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
  }

  private async pollLoop(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    // Recovery must not wait for a potentially hours-long first network poll.
    await this.pump(agent);
    let consecutivePollErrors = 0;
    while (await this.hasAuthority(agent, controller)) {
      try {
        await this.pollOnce(agent, controller);
        consecutivePollErrors = 0;
      } catch {
        consecutivePollErrors += 1;
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
      if (!await this.hasAuthority(agent, controller)) return;
      const cursor = await this.inbox.cursor(agent.agentId);
      const response = await this.http.poll({ roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer, afterMessageId: cursor?.last_observed_message_id ?? null, signal: controller.signal });
      if (!await this.hasAuthority(agent, controller)) return;
      const messages = activatedMessages(response.messages ?? []);
      await this.inbox.ingestPoll({
        agent_id: agent.agentId,
        room_id: agent.roomId,
        expected_cursor: cursor?.last_observed_message_id ?? null,
        last_observed_message_id: stringOrNull(response.last_observed_message_id),
        messages,
      });
      // Ingest can be deliberately slow. Do not create detached delivery work
      // after a stop/rebind changed authority while its commit was pending.
      if (!await this.hasAuthority(agent, controller)) return;
      await this.pump(agent);
    } finally {
      if (this.polling.get(agent.agentId) === controller) this.polling.delete(agent.agentId);
    }
  }

  retry(agent: SupervisedIngressAgent, sourceMessageId: string): Promise<void> {
    if (this.fenced || this.stoppingAgents.has(agent.agentId)) return Promise.resolve();
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

  private async retryOperation(agent: SupervisedIngressAgent, sourceMessageId: string, controller: AbortController): Promise<void> {
    if (!await this.hasAuthority(agent, controller)) return;
    const receipts = await this.inbox.receipts(agent.agentId);
    if (!await this.hasAuthority(agent, controller)) return;
    const item = receipts.find((receipt) => receipt.source_message_id === sourceMessageId && receipt.state === "blocked");
    if (!item) throw new Error("The blocked room delivery is no longer available for this exact agent.");
    if (!await this.hasAuthority(agent, controller)) return;
    await this.inbox.retryBlocked(item.inbox_item_id);
    if (!await this.hasAuthority(agent, controller)) return;
    await this.pump(agent);
  }

  pump(agent: SupervisedIngressAgent): Promise<void> {
    if (this.fenced || this.stoppingAgents.has(agent.agentId) || this.pumping.has(agent.agentId)) return Promise.resolve();
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
      if (!await this.hasAuthority(agent, controller)) return;
      const recoveryContext = this.recoveryContext(agent);
      if (this.startupRecovered.get(agent.agentId) !== recoveryContext) {
        await this.inbox.normalizeStartupRecovery(agent.agentId);
        if (!await this.hasAuthority(agent, controller)) return;
        this.startupRecovered.set(agent.agentId, recoveryContext);
      }
      for (;;) {
        if (!await this.hasAuthority(agent, controller)) return;
        const item = await this.inbox.claimHead(agent.agentId);
        if (!item) return; // blocked, in-flight, or empty: FIFO remains intact.
        await this.deliver(agent, item, controller);
      }
    } finally { /* tracked by pump(), including handoff draining. */ }
  }

  private async deliver(agent: SupervisedIngressAgent, item: SupervisedInboxItem, controller: AbortController): Promise<void> {
    try {
      const persistedReply = persistedReplyText(item.outcome);
      if (persistedReply) {
        if (!await this.hasAuthority(agent, controller)) return;
        await this.inbox.transition(item.inbox_item_id, "awaiting_result", { outcome: item.outcome });
        if (!await this.hasAuthority(agent, controller)) return;
        await this.inbox.transition(item.inbox_item_id, "publishing", { outcome: item.outcome });
        if (!await this.publish(agent, item, persistedReply, controller)) return;
        if (!await this.hasAuthority(agent, controller)) return;
        await this.inbox.transition(item.inbox_item_id, "acknowledged");
        return;
      }
      if (!await this.hasAuthority(agent, controller)) return;
      const turn = this.provider.runRoomTurn?.(agent.handle, {
        inboxItemId: item.inbox_item_id,
        sourceMessage: item.source_message,
        activation: item.activation,
        actionId: item.action_id,
      }, { markDispatched: async () => {
        if (!await this.hasAuthority(agent, controller)) throw new AuthorityLostError();
      } });
      const turnController = new AbortController();
      const relayAbort = () => turnController.abort();
      controller.signal.addEventListener("abort", relayAbort, { once: true });
      let result;
      try { result = turn && await this.track(turnController, turn); }
      finally { controller.signal.removeEventListener("abort", relayAbort); }
      if (!result) throw new Error("Provider does not support bounded room turns.");
      if (!await this.hasAuthority(agent, controller)) return;
      const outcome = result.outcome === "reply" && result.text?.trim()
        ? JSON.stringify({ kind: "reply", text: result.text.trim() })
        : result.outcome === "no_reply" ? JSON.stringify({ kind: "no_reply" }) : null;
      if (outcome) await this.inbox.checkpointTerminalOutcome(item.inbox_item_id, outcome);
      if (!await this.hasAuthority(agent, controller)) return;
      await this.inbox.transition(item.inbox_item_id, "awaiting_result", { provider_turn_id: result.turnId, outcome });
      if (result.outcome === "no_reply") {
        if (!await this.hasAuthority(agent, controller)) return;
        await this.inbox.transition(item.inbox_item_id, "acknowledged_no_reply", { outcome });
        return;
      }
      const text = result.text?.trim();
      if (!text) throw new Error("Provider returned an empty room answer without the no-reply outcome.");
      // The terminal payload is checkpointed before the external publication.
      // A crash after this point retries the same client id without rerunning Codex.
      await this.inbox.transition(item.inbox_item_id, "publishing", { outcome });
      if (!await this.publish(agent, item, text, controller)) return;
      if (!await this.hasAuthority(agent, controller)) return;
      await this.inbox.transition(item.inbox_item_id, "acknowledged");
    } catch (error) {
      if (error instanceof AuthorityLostError || this.fenced || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Room delivery failed.";
      const current = await this.inbox.get(item.inbox_item_id);
      if (!current || current.state === "acknowledged" || current.state === "acknowledged_no_reply") return;
      if (current.attempt_count >= 3) {
        await this.inbox.transition(item.inbox_item_id, "blocked", { last_error: message });
        return;
      }
      if (current.state === "dispatching" || current.state === "awaiting_result" || current.state === "publishing") {
        await this.inbox.transition(item.inbox_item_id, "retryable", { last_error: message });
      }
      await this.sleep(this.retryDelayMs);
      const retryable = await this.inbox.get(item.inbox_item_id);
      if (await this.hasAuthority(agent, controller) && retryable?.state === "retryable") await this.inbox.transition(item.inbox_item_id, "pending");
    }
  }

  private async publish(agent: SupervisedIngressAgent, item: SupervisedInboxItem, text: string, parent: AbortController): Promise<boolean> {
    if (!await this.hasAuthority(agent, parent)) return false;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    parent.signal.addEventListener("abort", relayAbort, { once: true });
    try {
      await this.track(controller, this.http.publish({ roomId: agent.roomId, apiUrl: agent.apiUrl, bearer: agent.bearer, text, clientMessageId: item.reply_client_message_id, signal: controller.signal }));
      return this.hasAuthority(agent, parent);
    } finally { parent.signal.removeEventListener("abort", relayAbort); }
  }

  private async hasAuthority(agent: SupervisedIngressAgent, controller?: AbortController): Promise<boolean> {
    if (this.fenced || this.stoppingAgents.has(agent.agentId) || controller?.signal.aborted) return false;
    const allowed = await this.revalidateAuthority({
      agentId: agent.agentId,
      roomId: agent.roomId,
      apiUrl: agent.apiUrl,
      provider: agent.provider,
      agentSessionId: agent.agentSessionId,
      bearer: agent.bearer,
      workAttemptId: agent.handle.workAttemptId,
      executionGenerationId: agent.executionGenerationId,
      daemonGeneration: agent.daemonGeneration,
      providerContinuationId: agent.handle.providerContinuationId,
      pid: agent.handle.pid,
      handle: agent.handle,
    });
    return allowed && !this.fenced && !this.stoppingAgents.has(agent.agentId) && !controller?.signal.aborted;
  }

  private recoveryContext(agent: SupervisedIngressAgent): string {
    let handleId = this.handleContextIds.get(agent.handle);
    if (!handleId) {
      handleId = this.nextHandleContextId++;
      this.handleContextIds.set(agent.handle, handleId);
    }
    return [
      agent.daemonGeneration, agent.executionGenerationId, agent.roomId, agent.apiUrl,
      agent.agentSessionId, agent.handle.workAttemptId, agent.handle.providerContinuationId,
      agent.handle.pid, handleId,
    ].join("\u0000");
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

class AuthorityLostError extends Error {}

function activatedMessages(messages: readonly Record<string, unknown>[]): IngressMessage[] {
  return messages.flatMap((message) => {
    const activation = message.activation;
    const current = activation && typeof activation === "object" && !Array.isArray(activation)
      ? (activation as Record<string, unknown>).for_current_agent
      : null;
    const id = stringOrNull(message.id);
    if (!id || !current || typeof current !== "object" || Array.isArray(current)) return [];
    return [{ source_message_id: id, source_message: message, activation: current as InboxActivation }];
  });
}

function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }

function persistedReplyText(outcome: string | null): string | null {
  if (!outcome) return null;
  try {
    const parsed = JSON.parse(outcome) as { kind?: unknown; text?: unknown };
    return parsed.kind === "reply" && typeof parsed.text === "string" && parsed.text.trim() ? parsed.text : null;
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
