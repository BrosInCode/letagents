import type {
  ProviderActionAttachment,
  ProviderActionAttachTerminal,
  ProviderActionCapabilities,
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionRef,
  ProviderRoomTurnRequest,
  ProviderRoomTurnResult,
  ProviderActionSpawn,
  ProviderActionStreamEvent,
  ProviderActionTerminal,
  ProviderTurnControlResult,
} from "./provider-action-port.js";
import { sameProviderActionConnectionIdentity } from "./provider-action-port.js";

type NativeHandle = {
  workAttemptId: string;
  pid: number | null;
  providerContinuationId: string | null;
  providerConnection?: ProviderActionHandle["providerConnection"];
  observedState(): ProviderActionHandle["observedState"];
};

export type NativeProviderAdapter = {
  capabilities(): ProviderActionCapabilities;
  spawn(input: ProviderActionSpawn): Promise<NativeHandle>;
  attach(input: ProviderActionRef): Promise<NativeHandle | ProviderActionAttachTerminal | null>;
  resume(ref: ProviderActionRef, input: ProviderActionSpawn): Promise<NativeHandle>;
  poke(handle: NativeHandle, message: string): Promise<void>;
  controlTurn(handle: NativeHandle, correction?: string | null, options?: { markDispatched?: () => Promise<void> }): Promise<ProviderTurnControlResult>;
  runRoomTurn?(handle: NativeHandle, request: ProviderRoomTurnRequest, options?: { markDispatched?: () => Promise<void> }): Promise<ProviderRoomTurnResult>;
  stop(handle: NativeHandle, options?: { force?: boolean; graceMs?: number }): Promise<ProviderActionTerminal>;
  onExit(handle: NativeHandle, listener: (terminal: ProviderActionTerminal) => void): () => void;
  onStream(handle: NativeHandle, listener: (event: ProviderActionStreamEvent) => void): () => void;
};

export type ProviderAdapterLoader = () => Promise<NativeProviderAdapter>;

function publicHandle(handle: NativeHandle): ProviderActionHandle {
  return {
    workAttemptId: handle.workAttemptId,
    pid: handle.pid,
    providerContinuationId: handle.providerContinuationId,
    providerConnection: handle.providerConnection ?? null,
    get observedState() { return handle.observedState(); },
  };
}

/**
 * Daemon-safe provider router. Adapters remain in the Electron build tree, but
 * this immutable sibling only imports their Node-native lifecycle boundary.
 */
export class ProviderActionPortRouter implements ProviderActionPort {
  private readonly adapters = new Map<string, Promise<NativeProviderAdapter>>();
  private readonly handles = new Map<string, { provider: string; handle: NativeHandle }>();
  private readonly actions = new Map<string, string>();

  constructor(private readonly adapterLoaders: Readonly<Record<string, ProviderAdapterLoader>> = {}) {}

  async capabilities(workAttemptId: string, requestedProvider?: string): Promise<ProviderActionCapabilities> {
    const provider = this.resolveProvider(this.handles.get(workAttemptId)?.provider, requestedProvider);
    return (await this.adapter(provider)).capabilities();
  }

  async spawn(request: ProviderActionSpawn): Promise<ProviderActionHandle> {
    const provider = this.requiredProvider(request.provider);
    const handle = await (await this.adapter(provider)).spawn(request);
    this.remember(provider, request, handle);
    return publicHandle(handle);
  }

  async attach(ref: ProviderActionRef): Promise<ProviderActionHandle | ProviderActionAttachTerminal | null> {
    const remembered = this.handles.get(ref.workAttemptId);
    const provider = this.resolveProvider(
      remembered?.provider,
      ref.provider,
      providerFromConnection(ref.providerConnection),
    );
    if (remembered) {
      const handle = remembered.handle;
      if (
        handle.providerContinuationId !== ref.providerContinuationId
        || !sameProviderActionConnectionIdentity(handle.providerConnection, ref.providerConnection)
      ) return null;
      return publicHandle(handle);
    }
    const handle = await (await this.adapter(provider)).attach(ref);
    if (!handle || isAttachTerminal(handle)) return handle;
    this.handles.set(ref.workAttemptId, { provider, handle });
    return publicHandle(handle);
  }

  async attachAction(actionId: string, workAttemptId: string): Promise<ProviderActionAttachment> {
    if (this.actions.get(actionId) !== workAttemptId) return { state: "absent" };
    const remembered = this.handles.get(workAttemptId);
    return remembered ? { state: "attached", handle: publicHandle(remembered.handle) } : { state: "absent" };
  }

  async resume(ref: ProviderActionRef, request: ProviderActionSpawn): Promise<ProviderActionHandle> {
    const provider = this.resolveProvider(
      this.handles.get(request.workAttemptId)?.provider,
      request.provider,
      ref.provider,
      providerFromConnection(ref.providerConnection),
    );
    const handle = await (await this.adapter(provider)).resume(ref, request);
    this.remember(provider, request, handle);
    return publicHandle(handle);
  }

  async poke(handle: ProviderActionHandle, message: string, options?: { actionId?: string }): Promise<void> {
    const remembered = this.required(handle);
    await (await this.adapter(remembered.provider)).poke(remembered.handle, message);
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
  }

  async controlTurn(handle: ProviderActionHandle, correction?: string | null, options?: { actionId?: string; markDispatched?: () => Promise<void> }): Promise<ProviderTurnControlResult> {
    const remembered = this.required(handle);
    const result = await (await this.adapter(remembered.provider)).controlTurn(remembered.handle, correction, {
      markDispatched: options?.markDispatched,
    });
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
    return result;
  }

  async runRoomTurn(handle: ProviderActionHandle, request: ProviderRoomTurnRequest, options?: { markDispatched?: () => Promise<void> }): Promise<ProviderRoomTurnResult> {
    const remembered = this.required(handle);
    const adapter = await this.adapter(remembered.provider);
    if (!adapter.runRoomTurn) throw new Error(`Provider '${remembered.provider}' does not support bounded room turns.`);
    return adapter.runRoomTurn(remembered.handle, request, options);
  }

  async stop(handle: ProviderActionHandle, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal> {
    const remembered = this.required(handle);
    const terminal = await (await this.adapter(remembered.provider)).stop(remembered.handle, options);
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
    return terminal;
  }

  async onExit(handle: ProviderActionHandle, listener: (terminal: ProviderActionTerminal) => void): Promise<() => void> {
    const remembered = this.required(handle);
    return (await this.adapter(remembered.provider)).onExit(remembered.handle, listener);
  }

  async onStream(handle: ProviderActionHandle, listener: (event: ProviderActionStreamEvent) => void): Promise<() => void> {
    const remembered = this.required(handle);
    return (await this.adapter(remembered.provider)).onStream(remembered.handle, listener);
  }

  private adapter(provider: string): Promise<NativeProviderAdapter> {
    const current = this.adapters.get(provider);
    if (current) return current;
    const loaded = (async () => {
      const loader = this.adapterLoaders[provider];
      if (loader) return loader();
      if (provider === "codex") {
        const module = await import(new URL("../dist-electron/main/agents/codex-provider-adapter.js", import.meta.url).href) as { CodexProviderAdapter?: new () => NativeProviderAdapter };
        if (module.CodexProviderAdapter) return new module.CodexProviderAdapter();
      }
      if (provider === "claude-code") {
        const module = await import(new URL("../dist-electron/main/agents/claude-code-provider-adapter.js", import.meta.url).href) as { ClaudeCodeProviderAdapter?: new () => NativeProviderAdapter };
        if (module.ClaudeCodeProviderAdapter) return new module.ClaudeCodeProviderAdapter();
      }
      if (provider === "cursor") {
        const module = await import(new URL("../dist-electron/main/agents/cursor-provider-adapter.js", import.meta.url).href) as { CursorProviderAdapter?: new () => NativeProviderAdapter };
        if (module.CursorProviderAdapter) return new module.CursorProviderAdapter();
      }
      throw new Error(`No supervised native adapter is available for ${provider}.`);
    })();
    this.adapters.set(provider, loaded);
    return loaded;
  }

  private requiredProvider(provider: string | null | undefined): string {
    return this.resolveProvider(provider);
  }

  /** Every durable identity source must agree; provider selection is never a mutable handle hint. */
  private resolveProvider(...candidates: Array<string | null | undefined>): string {
    const providers = [...new Set(candidates
      .map((candidate) => candidate?.trim().toLowerCase())
      .filter((candidate): candidate is string => Boolean(candidate)))];
    if (!providers.length) throw new Error("Provider identity is required for supervised lifecycle control.");
    if (providers.length > 1) {
      throw new Error(`Conflicting provider identities for supervised lifecycle control: ${providers.join(", ")}.`);
    }
    return providers[0]!;
  }

  private remember(provider: string, request: ProviderActionSpawn, handle: NativeHandle): void {
    this.handles.set(request.workAttemptId, { provider, handle });
    if (request.actionId) this.actions.set(request.actionId, request.workAttemptId);
  }

  private required(handle: ProviderActionHandle): { provider: string; handle: NativeHandle } {
    const remembered = this.handles.get(handle.workAttemptId);
    if (!remembered || remembered.handle.pid !== handle.pid || remembered.handle.providerContinuationId !== handle.providerContinuationId) {
      throw new Error("Provider handle is not owned by the current daemon generation.");
    }
    return remembered;
  }
}

function isAttachTerminal(value: NativeHandle | ProviderActionAttachTerminal): value is ProviderActionAttachTerminal {
  return "state" in value && value.state === "terminal";
}

function providerFromConnection(connection: ProviderActionRef["providerConnection"]): string | null {
  if (connection?.kind === "codex_app_server") return "codex";
  if (connection?.kind === "claude_cli") return "claude-code";
  if (connection?.kind === "cursor_cli") return "cursor";
  return null;
}
