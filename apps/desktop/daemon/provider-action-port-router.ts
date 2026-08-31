import type {
  CustodialPollingActivationRequest,
  CustodialPollingActivationOptions,
  ProviderActionAttachment,
  ProviderActionAttachTerminal,
  ProviderActionCapabilities,
  ProviderExactTurnControlResult,
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionRef,
  ProviderRoomTurnCheckpointDisposition,
  ProviderRoomTurnRequest,
  ProviderRoomTurnRecoveryRequest,
  ProviderRoomTurnResult,
  ProviderContinuationRepairRequest,
  ProviderContinuationRepairResult,
  ProviderActionSpawn,
  ProviderActionStreamEvent,
  ProviderActionTerminal,
  ProviderTurnControlResult,
} from "./provider-action-port.js";
import { sameProviderActionConnectionIdentity } from "./provider-action-port.js";
import type { ControlProbeResult, NativeExecutionObservation, NativeExecutionSubscription, NativeTurnBoundary } from "../shared/execution-protocol.js";

type NativeHandle = {
  custodyLaunchAgentSessionId?: string;
  workAttemptId: string;
  pid: number | null;
  providerContinuationId: string | null;
  providerConnection?: ProviderActionHandle["providerConnection"];
  observedState(): ProviderActionHandle["observedState"];
};

export type NativeProviderAdapter = {
  activateCustodialPolling?(handle: NativeHandle, request: CustodialPollingActivationRequest, options: CustodialPollingActivationOptions): Promise<{ providerTurnId: string }>;
  inspectCustodialPollingActivation?(handle: NativeHandle, providerTurnId: string): Promise<{ state: "active" | "unknown" } | { state: "terminal"; outcome: "completed" | "failed" | "interrupted" }>;
  onExecution?(handle: NativeHandle, listener: (event: NativeExecutionObservation) => void): NativeExecutionSubscription;
  probeControl?(handle: NativeHandle): Promise<ControlProbeResult>;
  capabilities(): ProviderActionCapabilities;
  preflightCustodialPolling?(input: { devMcpServerEntryPath?: string }): Promise<void>;
  spawn(input: ProviderActionSpawn): Promise<NativeHandle>;
  attach(input: ProviderActionRef): Promise<NativeHandle | ProviderActionAttachTerminal | null>;
  resume(ref: ProviderActionRef, input: ProviderActionSpawn): Promise<NativeHandle>;
  poke(handle: NativeHandle, message: string): Promise<void>;
  controlTurn(handle: NativeHandle, correction?: string | null, options?: { targetTurnId?: string | null; checkpointTurnStarted?: (turnId: string) => Promise<void>; markDispatched?: () => Promise<void> }): Promise<ProviderTurnControlResult>;
  inspectTurn?(handle: NativeHandle, turnId: string): Promise<"active" | "terminal" | "unknown">;
  inspectTurnBoundary?(handle: NativeHandle): Promise<NativeTurnBoundary>;
  controlExactTurn?(handle: NativeHandle, options: { targetTurnId?: string | null; checkpointTargetTurn: (turnId: string) => Promise<void>; markDispatched: () => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderExactTurnControlResult>;
  runRoomTurn?(handle: NativeHandle, request: ProviderRoomTurnRequest, options?: { beforeNativeDispatch?: () => Promise<void>; checkpointTurnStarted?: (turnId: string) => Promise<void>; checkpointPreparedTurn?: (state: { providerTurnId: string; providerContinuationId: string; providerConnection: NonNullable<ProviderActionHandle["providerConnection"]> }) => Promise<void>; checkpointProviderState?: (state: { providerContinuationId: string; providerConnection: NonNullable<ProviderActionHandle["providerConnection"]> }) => Promise<void>; markDurableTurnStarted?: () => void; checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<ProviderRoomTurnCheckpointDisposition | void>; markDispatched?: () => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderRoomTurnResult>;
  recoverRoomTurn?(handle: NativeHandle, request: ProviderRoomTurnRecoveryRequest, options?: { detachSignal?: AbortSignal; checkpointProviderState?: (state: { providerContinuationId: string; providerConnection: NonNullable<ProviderActionHandle["providerConnection"]> }) => Promise<void>; checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<ProviderRoomTurnCheckpointDisposition | void> }): Promise<ProviderRoomTurnResult>;
  repairContinuation?(handle: NativeHandle, request: ProviderContinuationRepairRequest, options: { checkpointReplacement: (providerContinuationId: string) => Promise<void>; detachSignal?: AbortSignal }): Promise<{
    handle: NativeHandle;
    outcome: "rematerialized" | "replaced";
    previousProviderContinuationId: string;
    replacementProviderContinuationId: string;
  }>;
  stopRef?(ref: ProviderActionRef, options?: { force?: boolean; graceMs?: number }): Promise<ProviderActionTerminal>;
  stop(handle: NativeHandle, options?: { force?: boolean; graceMs?: number }): Promise<ProviderActionTerminal>;
  onExit(handle: NativeHandle, listener: (terminal: ProviderActionTerminal) => void): () => void;
  onStream(handle: NativeHandle, listener: (event: ProviderActionStreamEvent) => void): () => void;
};

export type ProviderAdapterLoader = () => Promise<NativeProviderAdapter>;

function publicHandle(handle: NativeHandle, appliedConfigurationRevision?: number): ProviderActionHandle {
  return {
    workAttemptId: handle.workAttemptId,
    get pid() { return handle.pid; },
    get providerContinuationId() { return handle.providerContinuationId; },
    get providerConnection() { return handle.providerConnection ?? null; },
    ...(appliedConfigurationRevision === undefined ? {} : { appliedConfigurationRevision }),
    ...(handle.custodyLaunchAgentSessionId === undefined ? {} : { custodyLaunchAgentSessionId: handle.custodyLaunchAgentSessionId }),
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
    if (request.pollingContract && provider !== "codex") throw new Error("Custodial polling is only supported by Codex.");
    const handle = await (await this.adapter(provider)).spawn(request);
    this.remember(provider, request, handle);
    return publicHandle(handle, request.configurationRevision);
  }

  async preflightCustodialPolling(input: { provider: string; devMcpServerEntryPath?: string }): Promise<void> {
    const provider = this.requiredProvider(input.provider);
    const devMcpServerEntryPath = input.devMcpServerEntryPath;
    if (provider !== "codex") throw new Error("Custodial polling is only supported by Codex.");
    const adapter = await this.adapter(provider);
    if (!adapter.preflightCustodialPolling) throw new Error("Codex does not expose custodial polling preflight.");
    await adapter.preflightCustodialPolling({ devMcpServerEntryPath });
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
        || (ref.providerConnection
          && !sameProviderActionConnectionIdentity(handle.providerConnection, ref.providerConnection))
      ) return null;
      // The Electron adapter registry is already keyed by the exact work
      // attempt and durable continuation. A predecessor daemon may have
      // omitted a provider connection it did not know how to serialize; the
      // remembered native handle is the authority needed to repair that
      // manifest, never permission to launch a replacement.
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
    if (request.pollingContract && provider !== "codex") throw new Error("Custodial polling is only supported by Codex.");
    const handle = await (await this.adapter(provider)).resume(ref, request);
    this.remember(provider, request, handle);
    return publicHandle(handle, request.configurationRevision);
  }

  async poke(handle: ProviderActionHandle, message: string, options?: { actionId?: string }): Promise<void> {
    const remembered = this.required(handle);
    await (await this.adapter(remembered.provider)).poke(remembered.handle, message);
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
  }

  async controlTurn(handle: ProviderActionHandle, correction?: string | null, options?: { actionId?: string; targetTurnId?: string | null; checkpointTurnStarted?: (turnId: string) => Promise<void>; markDispatched?: () => Promise<void> }): Promise<ProviderTurnControlResult> {
    const remembered = this.required(handle);
    const result = await (await this.adapter(remembered.provider)).controlTurn(remembered.handle, correction, {
      targetTurnId: options?.targetTurnId,
      checkpointTurnStarted: options?.checkpointTurnStarted,
      markDispatched: options?.markDispatched,
    });
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
    return result;
  }

  async inspectTurn(handle: ProviderActionHandle, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const remembered = this.required(handle);
    const adapter = await this.adapter(remembered.provider);
    if (!adapter.inspectTurn) throw new Error(`Provider '${remembered.provider}' does not support exact turn inspection.`);
    return adapter.inspectTurn(remembered.handle, turnId);
  }

  async controlExactTurn(handle: ProviderActionHandle, options: { targetTurnId?: string | null; checkpointTargetTurn: (turnId: string) => Promise<void>; markDispatched: () => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderExactTurnControlResult> {
    const remembered = this.required(handle);
    const adapter = await this.adapter(remembered.provider);
    if (!adapter.controlExactTurn) throw new Error(`Provider '${remembered.provider}' does not support exact turn control.`);
    return adapter.controlExactTurn(remembered.handle, options);
  }

  async inspectTurnBoundary(handle: ProviderActionHandle): Promise<NativeTurnBoundary> {
    const remembered = this.required(handle);
    const expected = handle.providerConnection ? { ...handle.providerConnection } : null;
    const continuation = handle.providerContinuationId;
    const current = () => this.handles.get(handle.workAttemptId) === remembered
      && remembered.handle.providerContinuationId === continuation
      && sameProviderActionConnectionIdentity(expected, remembered.handle.providerConnection);
    if (!current()) return { state: "unknown" };
    const adapter = await this.adapter(remembered.provider);
    if (!current() || !adapter.inspectTurnBoundary) return { state: "unknown" };
    const result = await adapter.inspectTurnBoundary(remembered.handle);
    if (!current() || (result.state !== "unknown"
      && (result.providerContinuationId !== continuation
        || result.nativeProcessIdentity !== expected?.processIdentity))) return { state: "unknown" };
    return result;
  }

  async activateCustodialPolling(handle: ProviderActionHandle, request: CustodialPollingActivationRequest,
    options: CustodialPollingActivationOptions): Promise<{ providerTurnId: string }> {
    const remembered = this.required(handle);
    const connection = structuredClone(handle.providerConnection);
    const continuation = handle.providerContinuationId;
    const current = () => this.handles.get(handle.workAttemptId) === remembered
      && remembered.handle.providerContinuationId === continuation
      && remembered.handle.pid === handle.pid
      && sameProviderActionConnectionIdentity(connection, remembered.handle.providerConnection);
    if (remembered.provider !== "codex" || !current()) throw new Error("Custodial polling activation requires the exact owned Codex runtime.");
    const adapter = await this.adapter(remembered.provider);
    if (!current() || !adapter.activateCustodialPolling) throw new Error("Custodial polling activation is unavailable.");
    return adapter.activateCustodialPolling(remembered.handle, request, {
      ...options,
      beforeNativeDispatch: async () => {
        if (!current()) throw new Error("Custodial polling runtime changed before dispatch.");
        await options.beforeNativeDispatch();
        if (!current()) throw new Error("Custodial polling runtime changed before dispatch.");
      },
    });
  }

  async inspectCustodialPollingActivation(handle: ProviderActionHandle, providerTurnId: string):
    Promise<{ state: "active" | "unknown" } | { state: "terminal"; outcome: "completed" | "failed" | "interrupted" }> {
    const remembered = this.required(handle);
    const connection = structuredClone(handle.providerConnection);
    const continuation = handle.providerContinuationId;
    const current = () => this.handles.get(handle.workAttemptId) === remembered
      && remembered.handle.providerContinuationId === continuation && remembered.handle.pid === handle.pid
      && sameProviderActionConnectionIdentity(connection, remembered.handle.providerConnection);
    if (remembered.provider !== "codex" || !current()) return { state: "unknown" };
    const adapter = await this.adapter(remembered.provider);
    if (!current() || !adapter.inspectCustodialPollingActivation) return { state: "unknown" };
    const result = await adapter.inspectCustodialPollingActivation(remembered.handle, providerTurnId);
    return current() ? result : { state: "unknown" };
  }

  async runRoomTurn(handle: ProviderActionHandle, request: ProviderRoomTurnRequest, options?: { beforeNativeDispatch?: () => Promise<void>; checkpointTurnStarted?: (turnId: string) => Promise<void>; checkpointPreparedTurn?: (state: { providerTurnId: string; providerContinuationId: string; providerConnection: NonNullable<ProviderActionHandle["providerConnection"]> }) => Promise<void>; checkpointProviderState?: (state: { providerContinuationId: string; providerConnection: NonNullable<ProviderActionHandle["providerConnection"]> }) => Promise<void>; markDurableTurnStarted?: () => void; checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<ProviderRoomTurnCheckpointDisposition | void>; markDispatched?: () => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderRoomTurnResult> {
    const remembered = this.required(handle);
    const adapter = await this.adapter(remembered.provider);
    if (!adapter.runRoomTurn) throw new Error(`Provider '${remembered.provider}' does not support bounded room turns.`);
    return adapter.runRoomTurn(remembered.handle, request, options);
  }

  async recoverRoomTurn(handle: ProviderActionHandle, request: ProviderRoomTurnRecoveryRequest, options?: { detachSignal?: AbortSignal; checkpointProviderState?: (state: { providerContinuationId: string; providerConnection: NonNullable<ProviderActionHandle["providerConnection"]> }) => Promise<void>; checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<ProviderRoomTurnCheckpointDisposition | void> }): Promise<ProviderRoomTurnResult> {
    const remembered = this.required(handle);
    const adapter = await this.adapter(remembered.provider);
    if (!adapter.recoverRoomTurn) throw new Error(`Provider '${remembered.provider}' does not support bounded room-turn recovery.`);
    return adapter.recoverRoomTurn(remembered.handle, request, options);
  }

  async repairContinuation(handle: ProviderActionHandle, request: ProviderContinuationRepairRequest, options: { checkpointReplacement: (providerContinuationId: string) => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderContinuationRepairResult> {
    const remembered = this.required(handle);
    const adapter = await this.adapter(remembered.provider);
    if (!adapter.repairContinuation) throw new Error(`Provider '${remembered.provider}' does not support continuation repair.`);
    const repaired = await adapter.repairContinuation(remembered.handle, request, options);
    if (repaired.handle.workAttemptId !== handle.workAttemptId || repaired.handle.pid !== handle.pid
      || !sameProviderActionConnectionIdentity(repaired.handle.providerConnection, handle.providerConnection)) {
      throw new Error("Provider continuation repair changed the verified provider process identity.");
    }
    this.handles.set(handle.workAttemptId, { provider: remembered.provider, handle: repaired.handle });
    return {
      ...repaired,
      handle: publicHandle(repaired.handle, handle.appliedConfigurationRevision),
    };
  }

  async stop(handle: ProviderActionHandle, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal> {
    const remembered = this.required(handle);
    const terminal = await (await this.adapter(remembered.provider)).stop(remembered.handle, options);
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
    return terminal;
  }

  async stopRef(ref: ProviderActionRef, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal> {
    ref = { ...ref, providerConnection: ref.providerConnection && { ...ref.providerConnection } };
    options = options && { ...options };
    const remembered = this.handles.get(ref.workAttemptId);
    const provider = this.resolveProvider(
      remembered?.provider,
      ref.provider,
      providerFromConnection(ref.providerConnection),
    );
    const adapter = await this.adapter(provider);
    // Codex protocol terminals can precede OS death. Its exact-reference path
    // must prove the frozen birth is gone even when a cached handle exists.
    if (provider === "codex" && adapter.stopRef) {
      const terminal = await adapter.stopRef(ref, options);
      if (options?.actionId) this.actions.set(options.actionId, ref.workAttemptId);
      return terminal;
    }
    if (remembered
      && remembered.handle.providerContinuationId === ref.providerContinuationId
      && sameProviderActionConnectionIdentity(remembered.handle.providerConnection, ref.providerConnection)) {
      const terminal = await adapter.stop(remembered.handle, options);
      if (options?.actionId) this.actions.set(options.actionId, ref.workAttemptId);
      return terminal;
    }
    if (!adapter.stopRef) throw new Error(`Provider '${provider}' cannot stop an unattached durable process reference.`);
    const terminal = await adapter.stopRef(ref, options);
    if (options?.actionId) this.actions.set(options.actionId, ref.workAttemptId);
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

  async onExecution(handle: ProviderActionHandle, listener: (event: NativeExecutionObservation) => void): Promise<NativeExecutionSubscription> {
    const remembered = this.required(handle);
    const adapter = await this.adapter(remembered.provider);
    if (!adapter.onExecution) throw new Error(`Provider '${remembered.provider}' does not expose native execution observations.`);
    return adapter.onExecution(remembered.handle, listener);
  }

  async probeControl(handle: ProviderActionHandle): Promise<ControlProbeResult> {
    const remembered = this.required(handle);
    const adapter = await this.adapter(remembered.provider);
    return adapter.probeControl?.(remembered.handle) ?? { state: "unprobeable" };
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
      if (provider === "open-model") {
        const module = await import(new URL("../dist-electron/main/agents/open-model-provider-adapter.js", import.meta.url).href) as { OpenModelProviderAdapter?: new () => NativeProviderAdapter };
        if (module.OpenModelProviderAdapter) return new module.OpenModelProviderAdapter();
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
    if (!remembered
      || remembered.handle.providerContinuationId !== handle.providerContinuationId
      || (remembered.provider !== "cursor" && remembered.handle.pid !== handle.pid)) {
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
  if (connection?.kind === "opencode_server") return "open-model";
  return null;
}
