import type { ProviderActionHandle, ProviderActionPort } from "./provider-action-port.js";
import { SupervisedAgentInboxStore, type InboxActivation, type IngressMessage, type SupervisedInboxItem } from "./supervised-agent-inbox-store.js";

export type SupervisedIngressAgent = {
  agentId: string;
  roomId: string;
  bearer: string;
  handle: ProviderActionHandle;
  /** Exact daemon generation that owns this room worker binding. */
  executionGenerationId: string;
};

export type SupervisedDeliveryAuthority = Pick<SupervisedIngressAgent, "agentId" | "roomId" | "executionGenerationId"> & {
  workAttemptId: string;
};
export type SupervisedAuthorityRevalidator = (authority: SupervisedDeliveryAuthority) => Promise<boolean> | boolean;

export type SupervisedPollResponse = {
  messages?: Array<Record<string, unknown>>;
  last_observed_message_id?: string | null;
};

export interface SupervisedDeliveryHttp {
  poll(input: { roomId: string; bearer: string; afterMessageId: string | null; signal: AbortSignal }): Promise<SupervisedPollResponse>;
  publish(input: { roomId: string; bearer: string; text: string; clientMessageId: string; signal: AbortSignal }): Promise<void>;
}

/**
 * The daemon-owned delivery loop. It intentionally knows no owner credential
 * and no mention grammar: a worker-authenticated poll is the sole activation
 * authority. Callers supply only an exact current binding and in-memory bearer.
 */
export class SupervisedAgentDelivery {
  private readonly polling = new Map<string, AbortController>();
  private readonly pumping = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly startupRecovered = new Set<string>();
  private fenced = false;

  constructor(
    private readonly inbox: SupervisedAgentInboxStore,
    private readonly provider: ProviderActionPort,
    private readonly http: SupervisedDeliveryHttp,
    private readonly revalidateAuthority: SupervisedAuthorityRevalidator,
    private readonly retryDelayMs = 50,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    if (this.fenced) return Promise.resolve();
    const prior = this.polling.get(agent.agentId);
    if (prior) return Promise.resolve();
    const controller = new AbortController();
    this.polling.set(agent.agentId, controller);
    return this.track(controller, this.pollOperation(agent, controller));
  }

  private async pollOperation(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    try {
      if (!await this.hasAuthority(agent, controller)) return;
      const cursor = await this.inbox.cursor(agent.agentId);
      const response = await this.http.poll({ roomId: agent.roomId, bearer: agent.bearer, afterMessageId: cursor?.last_observed_message_id ?? null, signal: controller.signal });
      if (!await this.hasAuthority(agent, controller)) return;
      const messages = activatedMessages(response.messages ?? []);
      await this.inbox.ingestPoll({
        agent_id: agent.agentId,
        room_id: agent.roomId,
        expected_cursor: cursor?.last_observed_message_id ?? null,
        last_observed_message_id: stringOrNull(response.last_observed_message_id),
        messages,
      });
      void this.pump(agent);
    } finally {
      if (this.polling.get(agent.agentId) === controller) this.polling.delete(agent.agentId);
    }
  }

  async retry(agent: SupervisedIngressAgent, sourceMessageId: string): Promise<void> {
    if (!await this.hasAuthority(agent)) return;
    const receipts = await this.inbox.receipts(agent.agentId);
    const item = receipts.find((receipt) => receipt.source_message_id === sourceMessageId && receipt.state === "blocked");
    if (!item) throw new Error("The blocked room delivery is no longer available for this exact agent.");
    await this.inbox.retryBlocked(item.inbox_item_id);
    await this.pump(agent);
  }

  pump(agent: SupervisedIngressAgent): Promise<void> {
    if (this.fenced || this.pumping.has(agent.agentId)) return Promise.resolve();
    const controller = new AbortController();
    const operation = this.track(controller, this.pumpOperation(agent, controller));
    this.pumping.set(agent.agentId, operation);
    void operation.then(() => {
      if (this.pumping.get(agent.agentId) === operation) this.pumping.delete(agent.agentId);
    }, () => {
      if (this.pumping.get(agent.agentId) === operation) this.pumping.delete(agent.agentId);
    });
    return operation;
  }

  private async pumpOperation(agent: SupervisedIngressAgent, controller: AbortController): Promise<void> {
    try {
      if (!await this.hasAuthority(agent, controller)) return;
      if (!this.startupRecovered.has(agent.agentId)) {
        await this.inbox.normalizeStartupRecovery(agent.agentId);
        if (!await this.hasAuthority(agent, controller)) return;
        this.startupRecovered.add(agent.agentId);
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
      await this.track(controller, this.http.publish({ roomId: agent.roomId, bearer: agent.bearer, text, clientMessageId: item.reply_client_message_id, signal: controller.signal }));
      return this.hasAuthority(agent, parent);
    } finally { parent.signal.removeEventListener("abort", relayAbort); }
  }

  private async hasAuthority(agent: SupervisedIngressAgent, controller?: AbortController): Promise<boolean> {
    if (this.fenced || controller?.signal.aborted) return false;
    const allowed = await this.revalidateAuthority({
      agentId: agent.agentId,
      roomId: agent.roomId,
      workAttemptId: agent.handle.workAttemptId,
      executionGenerationId: agent.executionGenerationId,
    });
    return allowed && !this.fenced && !controller?.signal.aborted;
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
