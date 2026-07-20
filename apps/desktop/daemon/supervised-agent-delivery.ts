import type { ProviderActionHandle, ProviderActionPort } from "./provider-action-port.js";
import { SupervisedAgentInboxStore, type InboxActivation, type IngressMessage, type SupervisedInboxItem } from "./supervised-agent-inbox-store.js";

export type SupervisedIngressAgent = {
  agentId: string;
  roomId: string;
  bearer: string;
  handle: ProviderActionHandle;
};

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
  private readonly pumping = new Set<string>();
  private fenced = false;

  constructor(
    private readonly inbox: SupervisedAgentInboxStore,
    private readonly provider: ProviderActionPort,
    private readonly http: SupervisedDeliveryHttp,
    private readonly retryDelayMs = 50,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  fence(): void {
    this.fenced = true;
    for (const controller of this.polling.values()) controller.abort();
    this.polling.clear();
  }

  async poll(agent: SupervisedIngressAgent): Promise<void> {
    if (this.fenced) return;
    const prior = this.polling.get(agent.agentId);
    if (prior) return;
    const controller = new AbortController();
    this.polling.set(agent.agentId, controller);
    try {
      const cursor = await this.inbox.cursor(agent.agentId);
      const response = await this.http.poll({ roomId: agent.roomId, bearer: agent.bearer, afterMessageId: cursor?.last_observed_message_id ?? null, signal: controller.signal });
      if (this.fenced || controller.signal.aborted) return;
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
    const receipts = await this.inbox.receipts(agent.agentId);
    const item = receipts.find((receipt) => receipt.source_message_id === sourceMessageId && receipt.state === "blocked");
    if (!item) throw new Error("The blocked room delivery is no longer available for this exact agent.");
    await this.inbox.retryBlocked(item.inbox_item_id);
    await this.pump(agent);
  }

  async pump(agent: SupervisedIngressAgent): Promise<void> {
    if (this.fenced || this.pumping.has(agent.agentId)) return;
    this.pumping.add(agent.agentId);
    try {
      for (;;) {
        if (this.fenced) return;
        const item = await this.inbox.claimHead(agent.agentId);
        if (!item) return; // blocked, in-flight, or empty: FIFO remains intact.
        await this.deliver(agent, item);
      }
    } finally {
      this.pumping.delete(agent.agentId);
    }
  }

  private async deliver(agent: SupervisedIngressAgent, item: SupervisedInboxItem): Promise<void> {
    try {
      const persistedReply = persistedReplyText(item.outcome);
      if (persistedReply) {
        await this.inbox.transition(item.inbox_item_id, "awaiting_result", { outcome: item.outcome });
        await this.inbox.transition(item.inbox_item_id, "publishing", { outcome: item.outcome });
        await this.http.publish({ roomId: agent.roomId, bearer: agent.bearer, text: persistedReply, clientMessageId: item.reply_client_message_id, signal: new AbortController().signal });
        await this.inbox.transition(item.inbox_item_id, "acknowledged");
        return;
      }
      const result = await this.provider.runRoomTurn?.(agent.handle, {
        inboxItemId: item.inbox_item_id,
        sourceMessage: item.source_message,
        activation: item.activation,
        actionId: item.action_id,
      }, { markDispatched: async () => undefined });
      if (!result) throw new Error("Provider does not support bounded room turns.");
      await this.inbox.transition(item.inbox_item_id, "awaiting_result", { provider_turn_id: result.turnId });
      if (result.outcome === "no_reply") {
        await this.inbox.transition(item.inbox_item_id, "acknowledged_no_reply", { outcome: "no_reply" });
        return;
      }
      const text = result.text?.trim();
      if (!text) throw new Error("Provider returned an empty room answer without the no-reply outcome.");
      // The terminal payload is checkpointed before the external publication.
      // A crash after this point retries the same client id without rerunning Codex.
      const outcome = JSON.stringify({ kind: "reply", text });
      await this.inbox.transition(item.inbox_item_id, "publishing", { outcome });
      await this.http.publish({ roomId: agent.roomId, bearer: agent.bearer, text, clientMessageId: item.reply_client_message_id, signal: new AbortController().signal });
      await this.inbox.transition(item.inbox_item_id, "acknowledged");
    } catch (error) {
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
      if (!this.fenced && retryable?.state === "retryable") await this.inbox.transition(item.inbox_item_id, "pending");
    }
  }
}

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
