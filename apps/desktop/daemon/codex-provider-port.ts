import type {
  ProviderActionAttachment,
  ProviderActionAttachTerminal,
  ProviderActionCapabilities,
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionRef,
  ProviderRoomTurnRequest,
  ProviderRoomTurnRecoveryRequest,
  ProviderRoomTurnResult,
  ProviderActionSpawn,
  ProviderActionStreamEvent,
  ProviderActionTerminal,
  ProviderTurnControlResult,
} from "./provider-action-port.js";

type NativeHandle = {
  workAttemptId: string;
  pid: number | null;
  providerContinuationId: string | null;
  providerConnection?: ProviderActionHandle["providerConnection"];
  observedState(): ProviderActionHandle["observedState"];
};

type NativeAdapter = {
  capabilities(): ProviderActionCapabilities;
  spawn(input: ProviderActionSpawn): Promise<NativeHandle>;
  attach(input: ProviderActionRef): Promise<NativeHandle | ProviderActionAttachTerminal | null>;
  resume(ref: ProviderActionRef, input: ProviderActionSpawn): Promise<NativeHandle>;
  poke(handle: NativeHandle, message: string): Promise<void>;
  controlTurn(handle: NativeHandle, correction?: string | null, options?: { markDispatched?: () => Promise<void> }): Promise<ProviderTurnControlResult>;
  runRoomTurn?(handle: NativeHandle, request: ProviderRoomTurnRequest, options?: { beforeNativeDispatch?: () => Promise<void>; checkpointTurnStarted?: (turnId: string) => Promise<void>; markDispatched?: () => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderRoomTurnResult>;
  recoverRoomTurn?(handle: NativeHandle, request: ProviderRoomTurnRecoveryRequest, options?: { detachSignal?: AbortSignal }): Promise<ProviderRoomTurnResult>;
  stop(handle: NativeHandle, options?: { force?: boolean; graceMs?: number }): Promise<ProviderActionTerminal>;
  onExit(handle: NativeHandle, listener: (terminal: ProviderActionTerminal) => void): () => void;
  onStream(handle: NativeHandle, listener: (event: ProviderActionStreamEvent) => void): () => void;
};

function publicHandle(handle: NativeHandle): ProviderActionHandle {
  return {
    workAttemptId: handle.workAttemptId,
    pid: handle.pid,
    providerContinuationId: handle.providerContinuationId,
    providerConnection: handle.providerConnection ?? null,
    observedState: handle.observedState(),
  };
}

/**
 * Loads the already-built, Node-only Codex native adapter without importing an
 * Electron module into the daemon compilation unit. In production both trees
 * are immutable siblings in the packaged app. The adapter owns the app-server
 * process; this port merely gives the fenced daemon durable lifecycle authority.
 */
export class CodexProviderActionPort implements ProviderActionPort {
  private adapterPromise: Promise<NativeAdapter> | null = null;
  private readonly handles = new Map<string, NativeHandle>();
  private readonly actions = new Map<string, string>();

  private adapter(): Promise<NativeAdapter> {
    if (!this.adapterPromise) {
      this.adapterPromise = (async () => {
        const adapterUrl = new URL("../dist-electron/main/agents/codex-provider-adapter.js", import.meta.url);
        const loaded = await import(adapterUrl.href) as { CodexProviderAdapter?: new () => NativeAdapter };
        if (!loaded.CodexProviderAdapter) throw new Error("Packaged Codex provider adapter is unavailable.");
        return new loaded.CodexProviderAdapter();
      })();
    }
    return this.adapterPromise;
  }

  async capabilities(): Promise<ProviderActionCapabilities> {
    return (await this.adapter()).capabilities();
  }

  async spawn(request: ProviderActionSpawn): Promise<ProviderActionHandle> {
    const handle = await (await this.adapter()).spawn(request);
    this.remember(request, handle);
    return publicHandle(handle);
  }

  async attach(ref: ProviderActionRef): Promise<ProviderActionHandle | ProviderActionAttachTerminal | null> {
    const current = this.handles.get(ref.workAttemptId);
    if (current) return publicHandle(current);
    const handle = await (await this.adapter()).attach(ref);
    if (!handle || isAttachTerminal(handle)) return handle;
    this.handles.set(ref.workAttemptId, handle);
    return publicHandle(handle);
  }

  async attachAction(actionId: string, workAttemptId: string): Promise<ProviderActionAttachment> {
    if (this.actions.get(actionId) !== workAttemptId) return { state: "absent" };
    const handle = this.handles.get(workAttemptId);
    return handle ? { state: "attached", handle: publicHandle(handle) } : { state: "absent" };
  }

  async resume(ref: ProviderActionRef, request: ProviderActionSpawn): Promise<ProviderActionHandle> {
    const handle = await (await this.adapter()).resume(ref, request);
    this.remember(request, handle);
    return publicHandle(handle);
  }

  async poke(handle: ProviderActionHandle, message: string, options?: { actionId?: string }): Promise<void> {
    const native = this.required(handle);
    await (await this.adapter()).poke(native, message);
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
  }

  async controlTurn(handle: ProviderActionHandle, correction?: string | null, options?: { actionId?: string; markDispatched?: () => Promise<void> }): Promise<ProviderTurnControlResult> {
    const native = this.required(handle);
    const result = await (await this.adapter()).controlTurn(native, correction, {
      markDispatched: options?.markDispatched,
    });
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
    return result;
  }

  async runRoomTurn(handle: ProviderActionHandle, request: ProviderRoomTurnRequest, options?: { beforeNativeDispatch?: () => Promise<void>; checkpointTurnStarted?: (turnId: string) => Promise<void>; markDispatched?: () => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderRoomTurnResult> {
    const adapter = await this.adapter();
    if (!adapter.runRoomTurn) throw new Error("Codex provider adapter does not support bounded room turns.");
    return adapter.runRoomTurn(this.required(handle), request, options);
  }

  async recoverRoomTurn(handle: ProviderActionHandle, request: ProviderRoomTurnRecoveryRequest, options?: { detachSignal?: AbortSignal }): Promise<ProviderRoomTurnResult> {
    const adapter = await this.adapter();
    if (!adapter.recoverRoomTurn) throw new Error("Codex provider adapter does not support bounded room-turn recovery.");
    return adapter.recoverRoomTurn(this.required(handle), request, options);
  }

  async stop(handle: ProviderActionHandle, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal> {
    const native = this.required(handle);
    const terminal = await (await this.adapter()).stop(native, options);
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
    return terminal;
  }

  async onExit(handle: ProviderActionHandle, listener: (terminal: ProviderActionTerminal) => void): Promise<() => void> {
    return (await this.adapter()).onExit(this.required(handle), listener);
  }

  async onStream(handle: ProviderActionHandle, listener: (event: ProviderActionStreamEvent) => void): Promise<() => void> {
    return (await this.adapter()).onStream(this.required(handle), listener);
  }

  private remember(request: ProviderActionSpawn, handle: NativeHandle): void {
    this.handles.set(request.workAttemptId, handle);
    if (request.actionId) this.actions.set(request.actionId, request.workAttemptId);
  }

  private required(handle: ProviderActionHandle): NativeHandle {
    const native = this.handles.get(handle.workAttemptId);
    if (!native || native.pid !== handle.pid || native.providerContinuationId !== handle.providerContinuationId) {
      throw new Error("Provider handle is not owned by the current daemon generation.");
    }
    return native;
  }
}

function isAttachTerminal(value: NativeHandle | ProviderActionAttachTerminal): value is ProviderActionAttachTerminal {
  return "state" in value && value.state === "terminal";
}
