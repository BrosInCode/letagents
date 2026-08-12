import { randomBytes } from "node:crypto";

import { ProviderContinuationMissingError } from "./provider-adapter.js";

export type JsonRecord = Record<string, unknown>;
export type OpenCodePart = JsonRecord & {
  id?: unknown;
  messageID?: unknown;
  sessionID?: unknown;
  type?: unknown;
  text?: unknown;
};
export type OpenCodeMessage = {
  info?: JsonRecord;
  parts?: OpenCodePart[];
};
export type OpenCodeMessageError = {
  name: string | null;
  message: string | null;
  statusCode: number | null;
};
export type OpenCodeEvent = {
  id?: unknown;
  type?: unknown;
  properties?: unknown;
};
export type OpenCodeRuntimeAuth = {
  username: string;
  password: string;
};

export type OpenCodeFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

/**
 * OpenCode orders messages by raw string comparison of their IDs, and its
 * agentic loop only exits once the newest user message sorts BELOW the newest
 * assistant message. It accepts caller-supplied user message IDs verbatim, so
 * a caller ID outside its ascending scheme ("msg_" + 12 lowercase-hex chars of
 * unix-ms * 0x1000 + 14 base62 chars) permanently reads as "an unanswered user
 * message newer than every reply" and the model is re-invoked until an
 * external bound aborts the turn.
 */
const NATIVE_ASCENDING_MESSAGE_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export function nativelyOrderedMessageId(value: unknown): boolean {
  return typeof value === "string" && NATIVE_ASCENDING_MESSAGE_ID.test(value);
}

export function mintNativeUserMessageId(timestampMs: number): string {
  // Counter component 0 keeps this ID below every ID OpenCode itself mints in
  // the same millisecond (its internal counter starts at 1), so the assistant
  // replies that follow always sort after the user message that caused them.
  let encoded = BigInt(timestampMs) * BigInt(0x1000);
  const timeBytes = Buffer.alloc(6);
  for (let index = 5; index >= 0; index -= 1) {
    timeBytes[index] = Number(encoded & BigInt(0xff));
    encoded >>= BigInt(8);
  }
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const entropy = randomBytes(14);
  let suffix = "";
  for (const byte of entropy) suffix += alphabet[byte % 62];
  return `msg_${timeBytes.toString("hex")}${suffix}`;
}

function messageTimestamp(message: OpenCodeMessage): number | null {
  const info = record(message.info);
  const time = record(info?.time);
  if (typeof time?.created === "number") return time.created;
  if (typeof time?.completed === "number") return time.completed;
  return null;
}

export function assistantsFor(
  messages: OpenCodeMessage[],
  userMessageId: string,
): OpenCodeMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => {
      const info = record(message.info);
      return info?.role === "assistant" && info.parentID === userMessageId;
    })
    .sort((left, right) => {
      const leftTimestamp = messageTimestamp(left.message);
      const rightTimestamp = messageTimestamp(right.message);
      if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
        return leftTimestamp - rightTimestamp;
      }
      if (leftTimestamp !== null && rightTimestamp === null) return -1;
      if (leftTimestamp === null && rightTimestamp !== null) return 1;
      return left.index - right.index;
    })
    .map(({ message }) => message);
}

export function messageText(message: OpenCodeMessage | null): string | null {
  if (!message) return null;
  const text = (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("")
    .trim();
  return text || null;
}

export function messageCompleted(message: OpenCodeMessage | null): boolean {
  const info = record(message?.info);
  const time = record(info?.time);
  return typeof time?.completed === "number" || Boolean(info?.error);
}

export function messageError(message: OpenCodeMessage | null): OpenCodeMessageError | null {
  const info = record(message?.info);
  const error = record(info?.error);
  if (!error) return null;
  const data = record(error.data);
  return {
    name: typeof error.name === "string" ? error.name : null,
    message: typeof data?.message === "string"
      ? data.message
      : typeof error.message === "string"
        ? error.message
        : null,
    statusCode: typeof data?.statusCode === "number" && Number.isSafeInteger(data.statusCode)
      ? data.statusCode
      : null,
  };
}

export function messageFinishReason(message: OpenCodeMessage | null): string | null {
  if (!message) return null;
  const finish = [...(message.parts ?? [])].reverse().find((part) =>
    part.type === "step-finish" && typeof part.reason === "string");
  return finish && typeof finish.reason === "string" ? finish.reason : null;
}

/**
 * OpenCode can emit several assistant children for one user prompt (for
 * example a tool-call step followed by the actual answer). The room result is
 * the latest completed, non-tool-call assistant child at the session boundary.
 */
export function finalAssistantFor(
  messages: OpenCodeMessage[],
  userMessageId: string,
): OpenCodeMessage | null {
  const completed = assistantsFor(messages, userMessageId).filter(messageCompleted);
  return completed
    .filter((message) => messageFinishReason(message) !== "tool-calls")
    .at(-1)
    ?? completed.at(-1)
    ?? null;
}

export function eventReferencesSession(
  event: OpenCodeEvent,
  sessionId: string,
): boolean {
  const properties = record(event.properties);
  const info = record(properties?.info);
  const part = record(properties?.part);
  const status = record(properties?.status);
  return [
    properties?.sessionID,
    info?.sessionID,
    part?.sessionID,
    status?.sessionID,
  ].some((value) => value === sessionId);
}

function serverStatus(value: unknown, sessionId: string): string {
  const statuses = record(value);
  const status = record(statuses?.[sessionId]);
  return typeof status?.type === "string" ? status.type : "idle";
}

function eventData(block: string): string | null {
  const lines = block.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return data || null;
}

// OpenCode can accept a TCP connection during startup and never answer it,
// and Node's fetch waits ~300s for headers by default. Every control request
// therefore carries its own bounded deadline; callers that poll (health) get
// a short one so their own budget stays authoritative. The event stream is
// intentionally excluded — it is long-lived and caller-aborted.
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const ABORT_REQUEST_TIMEOUT_MS = 10_000;
const EVENT_STREAM_HEADER_TIMEOUT_MS = 10_000;

/**
 * Typed control client for one authenticated OpenCode server.
 *
 * Provider lifecycle stays in the adapter; HTTP shape, authentication, and
 * event framing stay here so live-runtime tests can exercise the same boundary.
 */
export class OpenCodeServerClient {
  constructor(
    readonly url: string,
    readonly auth: OpenCodeRuntimeAuth,
    private readonly fetchImpl: OpenCodeFetch,
  ) {}

  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(
        `${this.url}/global/health`,
        this.authInit({ signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) }),
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  listSessions(): Promise<JsonRecord[]> {
    return this.requestJson<JsonRecord[]>("/session");
  }

  createSession(title: string): Promise<JsonRecord> {
    return this.requestJson<JsonRecord>("/session", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  }

  config(): Promise<JsonRecord> {
    return this.requestJson<JsonRecord>("/config");
  }

  messages(sessionId: string, limit = 64): Promise<OpenCodeMessage[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.requestJson<OpenCodeMessage[]>(
      `/session/${encodeURIComponent(sessionId)}/message?${query}`,
    );
  }

  async status(sessionId: string): Promise<string> {
    return serverStatus(
      await this.requestJson<unknown>("/session/status"),
      sessionId,
    );
  }

  async promptAsync(
    sessionId: string,
    body: JsonRecord,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.url}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      this.authInit({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
      }),
    );
    if (!response.ok) {
      throw new Error(`OpenCode rejected the bounded turn with HTTP ${response.status}.`);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.url}/session/${encodeURIComponent(sessionId)}/abort`,
      this.authInit({ method: "POST", signal: AbortSignal.timeout(ABORT_REQUEST_TIMEOUT_MS) }),
    );
    if (!response.ok) {
      throw new Error(`OpenCode turn abort failed with HTTP ${response.status}.`);
    }
  }

  /**
   * OpenCode's event endpoint is the steady-state observation path. Callers
   * take one bounded transcript snapshot after subscribing to repair any event
   * that raced before the stream became authoritative.
   */
  async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    // Only the header phase gets a deadline of its own: a connection the
    // server accepts but never answers must not consume the caller's entire
    // turn budget. Once headers arrive the stream is long-lived and ends only
    // on caller abort or server close.
    const streamController = new AbortController();
    const abortForCaller = (): void => streamController.abort();
    signal?.addEventListener("abort", abortForCaller, { once: true });
    if (signal?.aborted) streamController.abort();
    const headerTimer = setTimeout(
      () => streamController.abort(new Error("OpenCode event stream did not answer in time.")),
      EVENT_STREAM_HEADER_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.url}/event`,
        this.authInit({
          headers: { accept: "text/event-stream" },
          signal: streamController.signal,
        }),
      );
    } catch (error) {
      signal?.removeEventListener("abort", abortForCaller);
      throw error;
    } finally {
      clearTimeout(headerTimer);
    }
    if (!response.ok || !response.body) {
      signal?.removeEventListener("abort", abortForCaller);
      throw new Error(`OpenCode event stream failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
          buffer = buffer.slice(boundary + separator.length);
          const data = eventData(block);
          if (data && data !== "[DONE]") {
            yield JSON.parse(data) as OpenCodeEvent;
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
      }
    } finally {
      signal?.removeEventListener("abort", abortForCaller);
      await reader.cancel().catch(() => undefined);
    }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetchImpl(
      `${this.url}${path}`,
      this.authInit({
        ...init,
        // After the caller's init so an explicit init.signal cannot silently
        // erase the default deadline; callers wanting a custom bound pass one.
        signal: init.signal ?? AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      }),
    );
    if (response.status === 404 && /^\/session\/[^/]+/.test(path)) {
      const continuationId = decodeURIComponent(path.split("/")[2] || "");
      throw new ProviderContinuationMissingError(continuationId);
    }
    if (!response.ok) {
      throw new Error(`OpenCode request failed with HTTP ${response.status}.`);
    }
    return await response.json() as T;
  }

  private authInit(init: RequestInit): RequestInit {
    return {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(
          `${this.auth.username}:${this.auth.password}`,
        ).toString("base64")}`,
        ...(init.headers ?? {}),
      },
    };
  }
}
