import { encodeRoomIdPath } from "./room-id.js";

const MAX_SSE_FRAME_BYTES = 1024 * 1024;

class SseFrameOverflowError extends Error {
  constructor() {
    super("SSE frame exceeded bounded size");
    this.name = "SseFrameOverflowError";
  }
}

class SseFrameMalformedError extends Error {
  constructor(options?: ErrorOptions) {
    super("SSE frame was malformed", options);
    this.name = "SseFrameMalformedError";
  }
}

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

export interface SseGap {
  room_id?: string;
  project_id?: string;
  event_cursor?: string | null;
  gap: true;
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
  private readonly getAccessToken?: () => string | null | Promise<string | null>;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly eventCursors = new Map<string, string>();

  constructor(apiUrl: string, getAccessToken?: () => string | null | Promise<string | null>) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.getAccessToken = getAccessToken;
  }

  subscribe(
    target: SubscriptionTarget,
    onMessage: (message: Message) => void,
    onGap?: (gap: SseGap) => void,
  ): void {
    const subscriptionKey = target.roomId;
    if (this.subscriptions.has(subscriptionKey)) {
      return;
    }

    const controller = new AbortController();
    const promise = this.consumeStream(target, controller.signal, onMessage, onGap)
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

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken?.();
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
    onMessage: (message: Message) => void,
    onGap?: (gap: SseGap) => void,
  ): Promise<void> {
    let lastEventId: string | null = this.eventCursors.get(target.roomId) ?? null;
    let useLegacyRoute = false;
    let retryMs = 1_000;
    while (!signal.aborted) {
      const baseUrl = useLegacyRoute && target.projectId
        ? `${this.apiUrl}/projects/${encodeURIComponent(target.projectId)}/messages/stream`
        : `${this.apiUrl}/rooms/${encodeRoomIdPath(target.roomId)}/messages/stream`;
      const url = this.withIncludePromptOnly(this.withAgentIdentityQuery(baseUrl, target));
      try {
        lastEventId = await this.openStream(
          url,
          signal,
          target.roomId,
          lastEventId,
          onMessage,
          onGap,
        );
        retryMs = 1_000;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof SseFrameOverflowError || error instanceof SseFrameMalformedError) {
          lastEventId = null;
        }
        if (this.isMissingRouteError(error)) {
          if (!useLegacyRoute && target.projectId) {
            useLegacyRoute = true;
            continue;
          }
          // A missing room/route is terminal. Retrying it forever creates
          // background traffic and can never heal without a new room join.
          throw error;
        }
        console.error(`SSE stream disconnected for room ${target.roomId}:`, error);
      }
      if (signal.aborted) return;
      await waitForRetry(signal, retryMs);
      retryMs = Math.min(Math.ceil(retryMs * 1.5), 30_000);
    }
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
    roomId: string,
    lastEventId: string | null,
    onMessage: (message: Message) => void,
    onGap?: (gap: SseGap) => void,
  ): Promise<string | null> {
    const headers = await this.getHeaders();
    if (signal.aborted) return lastEventId;
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const response = await fetch(
      url,
      {
        headers,
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
    let bufferBytes = 0;

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      bufferBytes += value.byteLength;

      if (bufferBytes > MAX_SSE_FRAME_BYTES) {
        // The cursor is no longer safe: an unterminated/oversize frame may
        // contain an event we could not parse. Force pull-state repair before
        // reconnecting and never retain attacker-controlled remainder bytes.
        this.eventCursors.delete(roomId);
        try {
          onGap?.({ room_id: roomId, event_cursor: null, gap: true });
        } catch (error) {
          console.error("SSE gap callback failed:", error);
        }
        await reader.cancel("SSE frame exceeded bounded size").catch(() => undefined);
        throw new SseFrameOverflowError();
      }

      let boundaryIndex = buffer.indexOf("\n\n");
      let consumedFrame = false;
      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        try {
          lastEventId = this.handleEvent(rawEvent, lastEventId, onMessage, onGap);
        } catch (error) {
          // A complete but malformed typed frame is the same lost-boundary
          // condition as an oversized frame. Never reconnect from its cursor
          // and replay it forever; force the authorized pull-state repair.
          this.eventCursors.delete(roomId);
          try {
            onGap?.({ room_id: roomId, event_cursor: null, gap: true });
          } catch (gapError) {
            console.error("SSE gap callback failed:", gapError);
          }
          await reader.cancel("SSE frame was malformed").catch(() => undefined);
          throw new SseFrameMalformedError({ cause: error });
        }
        this.rememberEventCursor(roomId, lastEventId);
        consumedFrame = true;
        boundaryIndex = buffer.indexOf("\n\n");
      }
      if (consumedFrame) bufferBytes = new TextEncoder().encode(buffer).byteLength;
    }

    const trailing = buffer + decoder.decode();
    if (trailing.trim()) {
      try {
        lastEventId = this.handleEvent(trailing, lastEventId, onMessage, onGap);
      } catch (error) {
        this.eventCursors.delete(roomId);
        try {
          onGap?.({ room_id: roomId, event_cursor: null, gap: true });
        } catch (gapError) {
          console.error("SSE gap callback failed:", gapError);
        }
        throw new SseFrameMalformedError({ cause: error });
      }
      this.rememberEventCursor(roomId, lastEventId);
    }
    return lastEventId;
  }

  private handleEvent(
    rawEvent: string,
    lastEventId: string | null,
    onMessage: (message: Message) => void,
    onGap?: (gap: SseGap) => void,
  ): string | null {
    const normalizedEvent = rawEvent.replace(/\r/g, "");
    const lines = normalizedEvent.split("\n");
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    const frameId = lines.find((line) => line.startsWith("id:"))?.slice(3).trim() || null;
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) {
      return frameId ?? lastEventId;
    }

    // No prompt enrichment here: the only SSE subscriber (room-state.ts) discards
    // the message body, and expanding the room-agent prompt on this background
    // path would consume the once-per-session full-prompt delivery before the
    // agent ever sees it. Prompt expansion happens only on visible tool
    // responses (runtime/messages.ts).
    const payload = JSON.parse(dataLines.join("\n")) as Message & Partial<SseGap>;
    if (eventName === "room_sync") {
      if (payload.gap === true) {
        try {
          onGap?.(payload as SseGap);
        } catch (error) {
          console.error("SSE gap callback failed:", error);
        }
      }
      if (Object.prototype.hasOwnProperty.call(payload, "event_cursor")) {
        return typeof payload.event_cursor === "string" ? payload.event_cursor : null;
      }
      return frameId ?? lastEventId;
    }
    try {
      onMessage(payload);
    } catch (error) {
      console.error("SSE message callback failed:", error);
    }
    return frameId ?? lastEventId;
  }

  private isMissingRouteError(error: unknown): boolean {
    return (
      error instanceof Error &&
      /status 404|status 405|Cannot (GET|POST|PATCH)/.test(error.message)
    );
  }

  private rememberEventCursor(roomId: string, cursor: string | null): void {
    this.eventCursors.delete(roomId);
    if (!cursor) return;
    this.eventCursors.set(roomId, cursor);
    while (this.eventCursors.size > 32) {
      const oldestRoomId = this.eventCursors.keys().next().value as string | undefined;
      if (!oldestRoomId) break;
      this.eventCursors.delete(oldestRoomId);
    }
  }
}

function waitForRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    function finish() {
      signal.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
