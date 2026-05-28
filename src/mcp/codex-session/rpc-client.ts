function getWebSocketCtor(): typeof WebSocket {
  const ctor = globalThis.WebSocket;
  if (!ctor) {
    throw new Error("Codex live sessions require a Node runtime with global WebSocket support (Node >= 22).");
  }
  return ctor;
}

interface RpcResultEnvelope {
  id?: number;
  method?: string;
  params?: unknown;
  error?: { message?: string } | unknown;
  result?: unknown;
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
  type?: string;
  text?: string;
  phase?: string;
  content?: Array<{ text?: string }>;
}

export interface ThreadReadTurn {
  id?: string;
  status?: string | { status?: string };
  items?: ThreadReadTurnItem[];
  output?: ThreadReadTurnItem[];
}

export interface ThreadReadResult {
  thread?: {
    status?: { type?: string } | string;
    turns?: ThreadReadTurn[];
  };
}

export class RpcClient {
  private readonly serverUrl: string;
  private readonly onNotification?: (notification: RpcNotification) => void;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(serverUrl: string, onNotification?: (notification: RpcNotification) => void) {
    this.serverUrl = serverUrl;
    this.onNotification = onNotification;
  }

  async connect(): Promise<void> {
    const WS = getWebSocketCtor();
    await new Promise<void>((resolve, reject) => {
      const ws = new WS(this.serverUrl);
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`WebSocket error connecting to ${this.serverUrl}`));
      ws.onmessage = (event) => this.handleMessage(String(event.data));
      ws.onclose = () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      };
    });

    await this.request("initialize", {
      clientInfo: { name: "letagents-local-codex-session", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.ws?.send(JSON.stringify({ method: "initialized" }));
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws?.send(JSON.stringify(payload));
    });
  }

  close(): void {
    if (this.ws?.readyState === getWebSocketCtor().OPEN) {
      this.ws.close();
    }
  }

  private handleMessage(raw: string): void {
    let message: RpcResultEnvelope;

    try {
      message = JSON.parse(raw) as RpcResultEnvelope;
    } catch {
      return;
    }

    if (message.id === undefined) {
      if (typeof message.method === "string") {
        this.onNotification?.({ method: message.method, params: message.params });
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          typeof message.error === "object" && message.error && "message" in message.error
            ? String(message.error.message || JSON.stringify(message.error))
            : JSON.stringify(message.error)
        )
      );
      return;
    }

    pending.resolve(message.result);
  }
}
