import { randomUUID } from "node:crypto";

function getWebSocketCtor(): typeof WebSocket {
  const ctor = globalThis.WebSocket;
  if (!ctor) {
    throw new Error("Codex app-server sessions require a Node runtime with global WebSocket support.");
  }
  return ctor;
}

const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;

export type RpcRequestId = string | number;
export interface RpcServerRequest {
  readonly id: RpcRequestId;
  readonly method: string;
  readonly params?: unknown;
  readonly connectionId: string;
}

function validId(value: unknown): value is RpcRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeJson(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) pending.push(child);
      Object.freeze(item);
    }
  }
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface ThreadStartResult {
  thread?: { id?: string };
}

export interface TurnStartResult {
  turn?: { id?: string };
}

export interface ThreadReadTurnItem {
  id?: string;
  type?: string;
  text?: string;
  phase?: string;
  status?: string | { status?: string };
  name?: string;
  command?: string;
  content?: Array<{ text?: string }>;
  [key: string]: unknown;
}

export interface ThreadReadTurn {
  id?: string;
  status?: string | { status?: string };
  items?: ThreadReadTurnItem[];
  output?: ThreadReadTurnItem[];
}

export interface ThreadReadResult {
  thread?: {
    id?: string;
    status?: { type?: string } | string;
    turns?: ThreadReadTurn[];
  };
}

export class CodexRpcClient {
  private ws: WebSocket | null = null;
  private connectionId = "";
  private readonly inbound = new Map<RpcRequestId, RpcServerRequest>();
  private readonly requestListeners = new Set<(request: RpcServerRequest) => void>();
  private readonly pendingRequestListeners = new Set<() => void>();
  private pendingRequestsNotificationQueued = false;
  private intentionalClose = false;
  private disconnectNotified = false;
  private readonly disconnectListeners = new Set<() => void>();
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly serverUrl: string,
    private readonly onNotification?: (notification: RpcNotification) => void,
    private readonly requestTimeoutMs = DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  ) {}

  async connect(): Promise<void> {
    const WS = getWebSocketCtor();
    const previous = this.ws;
    this.ws = null;
    this.invalidateRequests();
    previous?.close();
    this.intentionalClose = false;
    this.disconnectNotified = false;
    this.connectionId = randomUUID();
    let connectedSocket: WebSocket;
    await new Promise<void>((resolve, reject) => {
      const ws = new WS(this.serverUrl);
      connectedSocket = ws;
      this.ws = ws;
      let settled = false;

      const rejectConnect = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      ws.onopen = () => {
        if (this.ws !== ws) { rejectConnect(new Error("WebSocket connection replaced")); return; }
        if (!settled) {
          settled = true;
          this.notifyPendingRequestsChanged();
          resolve();
        }
      };
      ws.onerror = () => {
        rejectConnect(new Error(`WebSocket error connecting to ${this.serverUrl}`));
        if (this.ws !== ws) return;
        this.ws = null;
        this.invalidateRequests();
        this.notifyDisconnect();
        ws.close();
      };
      ws.onmessage = (event) => { if (this.ws === ws) this.handleMessage(String(event.data)); };
      ws.onclose = () => {
        rejectConnect(new Error(`WebSocket closed connecting to ${this.serverUrl}`));
        if (this.ws !== ws) return;
        this.ws = null;
        this.invalidateRequests();
        this.notifyDisconnect();
      };
    });

    try {
      if (this.ws !== connectedSocket!) throw new Error("WebSocket connection replaced");
      await this.request("initialize", {
        clientInfo: {
          name: "letagents-desktop-codex-supervisor",
          title: "LetAgents Desktop Codex Supervisor",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      if (this.ws !== connectedSocket!) throw new Error("WebSocket connection replaced");
      this.notify("initialized");
    } catch (error) {
      if (this.ws === connectedSocket!) this.close();
      throw error;
    }
  }

  async request<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Invalid RPC request timeout");
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });
      try {
        this.send(payload);
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) {
          clearTimeout(pending.timeout);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.intentionalClose = true;
    const ws = this.ws;
    this.ws = null;
    this.invalidateRequests();
    ws?.close();
  }

  onRequest(listener: (request: RpcServerRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  listPendingRequests(): readonly RpcServerRequest[] { return [...this.inbound.values()]; }

  currentConnectionId(): string | null {
    const ws = this.ws;
    return ws && ws.readyState === getWebSocketCtor().OPEN ? this.connectionId : null;
  }

  onPendingRequestsChanged(listener: () => void): () => void {
    this.pendingRequestListeners.add(listener);
    return () => this.pendingRequestListeners.delete(listener);
  }

  respond(request: RpcServerRequest, result: unknown): void {
    if (!request || request.connectionId !== this.connectionId || this.inbound.get(request.id) !== request) {
      throw new Error("Codex app-server request is no longer pending on this connection.");
    }
    // Retire before send: a transport exception can leave delivery uncertain,
    // never permission to repeat an approval response.
    this.inbound.delete(request.id);
    this.notifyPendingRequestsChanged();
    this.send({ id: request.id, result });
  }

  private invalidateRequests(): void {
    this.inbound.clear();
    this.notifyPendingRequestsChanged();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebSocket closed"));
    }
    this.pending.clear();
  }

  private notifyPendingRequestsChanged(): void {
    if (this.pendingRequestsNotificationQueued) return;
    this.pendingRequestsNotificationQueued = true;
    // Invalidation only: observers reread the latest map/connection. In
    // particular, no observer may intervene between response retirement and send.
    queueMicrotask(() => {
      this.pendingRequestsNotificationQueued = false;
      for (const listener of [...this.pendingRequestListeners]) {
        if (!this.pendingRequestListeners.has(listener)) continue;
        try { listener(); } catch { /* Observers must not disrupt transport or each other. */ }
      }
    });
  }

  onDisconnect(listener: () => void): () => void {
    if (this.disconnectNotified && !this.intentionalClose) {
      queueMicrotask(listener);
      return () => {};
    }
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (!record(message)) return;
    const hasId = Object.hasOwn(message, "id");
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (Object.hasOwn(message, "method")) {
      if (typeof message.method !== "string" || !message.method || hasResult || hasError) return;
      if (hasId) {
        if (!validId(message.id) || this.inbound.has(message.id)) return;
        freezeJson(message.params);
        const request = Object.freeze({ id: message.id, method: message.method, params: message.params, connectionId: this.connectionId });
        this.inbound.set(request.id, request);
        this.notifyPendingRequestsChanged();
        for (const listener of this.requestListeners) {
          try { listener(request); } catch { /* A consumer failure must not disrupt the transport or other observers. */ }
        }
        return;
      }
      if (message.method === "serverRequest/resolved" && record(message.params) && validId(message.params.requestId)) {
        const request = this.inbound.get(message.params.requestId);
        // Thread-bearing native requests can only be retired by that exact
        // thread. Generic requests without a thread retain ID-only resolution.
        const threadMatches = !record(request?.params) || !Object.hasOwn(request.params, "threadId")
          || (typeof request.params.threadId === "string" && request.params.threadId.length > 0
            && request.params.threadId === message.params.threadId);
        if (request && threadMatches) {
          this.inbound.delete(request.id);
          this.notifyPendingRequestsChanged();
        }
      }
      this.onNotification?.({ method: message.method, params: message.params });
      return;
    }
    if (!hasId || typeof message.id !== "number" || !validId(message.id) || hasResult === hasError) return;
    if (hasError && (!record(message.error) || typeof message.error.message !== "string")) return;
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (hasError) {
      pending.reject(new Error((message.error as { message: string }).message));
      return;
    }

    pending.resolve(message.result);
  }

  private notify(method: string, params?: unknown): void {
    const payload: Record<string, unknown> = { method };
    if (params !== undefined) {
      payload.params = params;
    }
    this.send(payload);
  }

  private notifyDisconnect(): void {
    if (this.intentionalClose || this.disconnectNotified) return;
    this.disconnectNotified = true;
    for (const listener of this.disconnectListeners) listener();
    this.disconnectListeners.clear();
  }

  private send(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== getWebSocketCtor().OPEN) {
      throw new Error("Codex app-server WebSocket is not open.");
    }
    ws.send(JSON.stringify(payload));
  }
}
