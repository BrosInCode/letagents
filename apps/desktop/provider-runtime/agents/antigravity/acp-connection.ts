/**
 * JSON-RPC 2.0 over newline-delimited stdio, as the Agent Client Protocol
 * (ACP) uses it between a client and `agy acp`. One JSON document per line in
 * each direction. The agent also sends requests of its own (permission
 * prompts), which the owner of the connection answers.
 */

/** The line channel of a child process: what this connection reads and writes. */
export interface AcpLineChannel {
  onLine(listener: (line: string) => void): () => void;
  writeLine(json: string): void;
  onDisconnect(listener: () => void): () => void;
}

export type AcpJsonRecord = Record<string, unknown>;

/** An error response from the agent, kept with its JSON-RPC code. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

/** The connection closed (or timed out) before the agent answered. */
export class AcpConnectionClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpConnectionClosedError";
  }
}

export interface AcpConnectionHandlers {
  /** A notification from the agent (no id), such as `session/update`. */
  onNotification?(method: string, params: AcpJsonRecord | null): void;
  /**
   * A request from the agent. Resolve with the result, or throw an AcpRpcError
   * to answer with that error. A method no handler takes is answered -32601.
   */
  onRequest?(method: string, params: AcpJsonRecord | null, id: string | number): Promise<unknown> | unknown;
  /** A stdout line that is not JSON: agy prints its sign-in link this way. */
  onNonJsonLine?(line: string): void;
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError: Error | null = null;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly channel: AcpLineChannel, private readonly handlers: AcpConnectionHandlers = {}) {
    this.unsubscribe.push(channel.onLine((line) => this.receive(line)));
    this.unsubscribe.push(channel.onDisconnect(() => this.close(new AcpConnectionClosedError("Antigravity closed its connection."))));
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  /** Send a request and wait for its result. A timeout rejects it, but the agent may still act on it. */
  request<T = unknown>(method: string, params: AcpJsonRecord, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (value: unknown) => void, reject, timer: null };
      if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
        entry.timer = setTimeout(() => {
          if (this.pending.get(id) !== entry) return;
          this.pending.delete(id);
          reject(new AcpConnectionClosedError(`Antigravity did not answer ${method} within ${Math.round(options.timeoutMs! / 1000)} s.`));
        }, Math.max(0, options.timeoutMs));
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      try {
        this.channel.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Send a notification (no answer), such as `session/cancel`. */
  notify(method: string, params: AcpJsonRecord): void {
    if (this.closedError) throw this.closedError;
    this.channel.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** Reject every waiting request. Later requests fail at once. */
  close(reason: Error): void {
    if (this.closedError) return;
    this.closedError = reason;
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      try { unsubscribe(); } catch { /* already gone */ }
    }
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(reason);
    }
  }

  private receive(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let message: unknown;
    try {
      message = line.startsWith("{") ? JSON.parse(line) : undefined;
    } catch {
      message = undefined;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.handlers.onNonJsonLine?.(line);
      return;
    }
    const record = message as AcpJsonRecord;
    const method = typeof record.method === "string" ? record.method : null;
    const hasId = typeof record.id === "number" || typeof record.id === "string";
    const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
      ? record.params as AcpJsonRecord
      : null;
    if (method && hasId) {
      void this.answer(record.id as string | number, method, params);
      return;
    }
    if (method) {
      try { this.handlers.onNotification?.(method, params); } catch { /* a listener cannot break the stream */ }
      return;
    }
    if (typeof record.id !== "number") return;
    const entry = this.pending.get(record.id);
    if (!entry) return;
    this.pending.delete(record.id);
    if (entry.timer) clearTimeout(entry.timer);
    const error = record.error && typeof record.error === "object" ? record.error as AcpJsonRecord : null;
    if (error) {
      const code = typeof error.code === "number" ? error.code : INTERNAL_ERROR;
      const text = typeof error.message === "string" && error.message.trim() ? error.message.trim() : `Antigravity refused ${entry.method}.`;
      entry.reject(new AcpRpcError(text, code, error.data));
      return;
    }
    entry.resolve(record.result ?? null);
  }

  private async answer(id: string | number, method: string, params: AcpJsonRecord | null): Promise<void> {
    let response: AcpJsonRecord;
    try {
      if (!this.handlers.onRequest) throw new AcpRpcError(`Method not supported: ${method}`, METHOD_NOT_FOUND);
      const result = await this.handlers.onRequest(method, params, id);
      response = { jsonrpc: "2.0", id, result: result ?? null };
    } catch (error) {
      const code = error instanceof AcpRpcError ? error.code : INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : String(error);
      response = { jsonrpc: "2.0", id, error: { code, message } };
    }
    if (this.closedError) return;
    try {
      this.channel.writeLine(JSON.stringify(response));
    } catch {
      // The pipe is gone; the exit observation stays authoritative.
    }
  }
}

/** A plain object from an unknown value, or null. */
export function acpRecord(value: unknown): AcpJsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AcpJsonRecord : null;
}

/** A trimmed non-empty string, or null. */
export function acpString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
