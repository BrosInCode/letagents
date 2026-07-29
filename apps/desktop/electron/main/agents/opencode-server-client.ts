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

export function assistantFor(
  messages: OpenCodeMessage[],
  userMessageId: string,
): OpenCodeMessage | null {
  return messages.find((message) => {
    const info = record(message.info);
    return info?.role === "assistant" && info.parentID === userMessageId;
  }) ?? null;
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
        this.authInit({}),
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
      }),
    );
    if (!response.ok) {
      throw new Error(`OpenCode rejected the bounded turn with HTTP ${response.status}.`);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.url}/session/${encodeURIComponent(sessionId)}/abort`,
      this.authInit({ method: "POST" }),
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
    const response = await this.fetchImpl(
      `${this.url}/event`,
      this.authInit({
        headers: { accept: "text/event-stream" },
        signal,
      }),
    );
    if (!response.ok || !response.body) {
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
