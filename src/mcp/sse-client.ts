import { encodeRoomIdPath } from "./room-id.js";
import { buildRoomAgentPrompt, normalizeAgentPromptKind } from "../shared/room-agent-prompts.js";

export interface Message {
  id: string;
  sender: string;
  text: string;
  agent_prompt_kind?: string | null;
  visible_text?: string;
  agent_prompt?: string;
  prompt_injected?: boolean;
  timestamp: string;
}

interface Subscription {
  controller: AbortController;
  promise: Promise<void>;
}

interface SubscriptionTarget {
  roomId: string;
  projectId?: string | null;
  agentIdentity?: {
    actorLabel: string;
    actorKey: string | null;
    actorInstanceId?: string | null;
  } | null;
}

export class SseClient {
  private readonly apiUrl: string;
  private readonly getAccessToken?: () => string | null;
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(apiUrl: string, getAccessToken?: () => string | null) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.getAccessToken = getAccessToken;
  }

  subscribe(target: SubscriptionTarget, onMessage: (message: Message) => void): void {
    const subscriptionKey = target.roomId;
    if (this.subscriptions.has(subscriptionKey)) {
      return;
    }

    const controller = new AbortController();
    const promise = this.consumeStream(target, controller.signal, onMessage)
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        console.error(`SSE subscription failed for room ${target.roomId}:`, error);
      })
      .finally(() => {
        const current = this.subscriptions.get(subscriptionKey);
        if (current?.controller === controller) {
          this.subscriptions.delete(subscriptionKey);
        }
      });

    this.subscriptions.set(subscriptionKey, { controller, promise });
  }

  unsubscribe(roomId: string): void {
    const subscription = this.subscriptions.get(roomId);
    if (!subscription) {
      return;
    }

    subscription.controller.abort();
    this.subscriptions.delete(roomId);
  }

  unsubscribeAll(): void {
    for (const roomId of this.subscriptions.keys()) {
      this.unsubscribe(roomId);
    }
  }

  private getHeaders(): Record<string, string> {
    const token = this.getAccessToken?.();
    if (!token) {
      return { Accept: "text/event-stream" };
    }

    return {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    };
  }

  private async consumeStream(
    target: SubscriptionTarget,
    signal: AbortSignal,
    onMessage: (message: Message) => void
  ): Promise<void> {
    try {
      await this.openStream(
        this.withIncludePromptOnly(
          this.withAgentIdentityQuery(
            `${this.apiUrl}/rooms/${encodeRoomIdPath(target.roomId)}/messages/stream`,
            target
          )
        ),
        signal,
        onMessage
      );
      return;
    } catch (error) {
      if (!target.projectId || !this.isMissingRouteError(error)) {
        throw error;
      }
    }

    await this.openStream(
      this.withIncludePromptOnly(
        this.withAgentIdentityQuery(
          `${this.apiUrl}/projects/${encodeURIComponent(target.projectId)}/messages/stream`,
          target
        )
      ),
      signal,
      onMessage
    );
  }

  private withIncludePromptOnly(url: string): string {
    return `${url}${url.includes("?") ? "&" : "?"}include_prompt_only=1`;
  }

  private withAgentIdentityQuery(url: string, target: SubscriptionTarget): string {
    const actorLabel = target.agentIdentity?.actorLabel?.trim();
    const actorKey = target.agentIdentity?.actorKey?.trim();
    if (!actorLabel || !actorKey) {
      return url;
    }

    const params = new URLSearchParams();
    params.set("actor_label", actorLabel);
    params.set("actor_key", actorKey);
    if (target.agentIdentity?.actorInstanceId?.trim()) {
      params.set("actor_instance_id", target.agentIdentity.actorInstanceId.trim());
    }

    return `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
  }

  private async openStream(
    url: string,
    signal: AbortSignal,
    onMessage: (message: Message) => void
  ): Promise<void> {
    const response = await fetch(
      url,
      {
        headers: this.getHeaders(),
        signal,
      }
    );

    if (!response.ok) {
      throw new Error(`SSE request failed with status ${response.status}`);
    }

    if (!response.body) {
      throw new Error("SSE response body is missing");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        this.handleEvent(rawEvent, onMessage);
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }

    const trailing = buffer + decoder.decode();
    if (trailing.trim()) {
      this.handleEvent(trailing, onMessage);
    }
  }

  private handleEvent(rawEvent: string, onMessage: (message: Message) => void): void {
    const normalizedEvent = rawEvent.replace(/\r/g, "");
    const dataLines = normalizedEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) {
      return;
    }

    onMessage(this.enrichPromptMetadata(JSON.parse(dataLines.join("\n")) as Message));
  }

  private enrichPromptMetadata(message: Message): Message {
    const kind = normalizeAgentPromptKind(message.agent_prompt_kind);
    if (!kind) {
      return message;
    }

    return {
      ...message,
      visible_text: message.text,
      agent_prompt: buildRoomAgentPrompt(kind),
      prompt_injected: kind === "inline",
    };
  }

  private isMissingRouteError(error: unknown): boolean {
    return (
      error instanceof Error &&
      /status 404|status 405|Cannot (GET|POST|PATCH)/.test(error.message)
    );
  }
}
