function getWebSocketCtor(): typeof WebSocket {
  const ctor = globalThis.WebSocket;
  if (!ctor) {
    throw new Error("Codex app-server sessions require a Node runtime with global WebSocket support.");
  }
  return ctor;
}

const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;

interface RpcResultEnvelope {
  id?: number | string;
  method?: string;
  params?: unknown;
  error?: { message?: string } | unknown;
  result?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export type RpcServerRequestHandler = (request: RpcServerRequest) => Promise<unknown>;

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

export class CodexRpcClient {
  private ws: WebSocket | null = null;
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
    private readonly onServerRequest?: RpcServerRequestHandler,
  ) {}

  async connect(): Promise<void> {
    const WS = getWebSocketCtor();
    await new Promise<void>((resolve, reject) => {
      const ws = new WS(this.serverUrl);
      this.ws = ws;
      let settled = false;

      const rejectConnect = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      ws.onopen = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.onerror = () => rejectConnect(new Error(`WebSocket error connecting to ${this.serverUrl}`));
      ws.onmessage = (event) => this.handleMessage(String(event.data));
      ws.onclose = () => {
        rejectConnect(new Error(`WebSocket closed connecting to ${this.serverUrl}`));
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      };
    });

    await this.request("initialize", {
      clientInfo: {
        name: "letagents-desktop-codex-supervisor",
        title: "LetAgents Desktop Codex Supervisor",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
        this.close();
      }, this.requestTimeoutMs);
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

    if (typeof message.method === "string") {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (typeof message.id !== "number") {
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
            : JSON.stringify(message.error),
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private async handleServerRequest(request: RpcServerRequest): Promise<void> {
    if (!this.onServerRequest) {
      this.send({
        id: request.id,
        error: { code: -32601, message: `Unsupported Codex app-server request: ${request.method}` },
      });
      return;
    }

    try {
      const result = await this.onServerRequest(request);
      this.send({ id: request.id, result: result ?? {} });
    } catch (error) {
      try {
        this.send({
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } catch {
        // The originating socket may close while a human is answering.
      }
    }
  }

  private notify(method: string, params?: unknown): void {
    const payload: Record<string, unknown> = { method };
    if (params !== undefined) {
      payload.params = params;
    }
    this.send(payload);
  }

  private send(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== getWebSocketCtor().OPEN) {
      throw new Error("Codex app-server WebSocket is not open.");
    }
    ws.send(JSON.stringify(payload));
  }
}
