import { createHash, randomUUID } from "node:crypto";
import type {
  ProviderActionAttachment,
  ProviderActionAttachTerminal,
  ProviderActionCapabilities,
  ProviderExactTurnControlResult,
  ProviderActionHandle,
  ProviderActionPort,
  ProviderActionRef,
  ProviderRuntimeCustody,
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
  RoomTurnImageDelivery,
  RoomTurnFileAccess,
} from "./provider-action-port.js";
import { sameProviderActionConnectionIdentity, sameProviderActionConnectionSnapshot } from "./provider-action-port.js";
import { assertPlainWireValue } from "#daemon-contract/index.js";
import { devMcpServerEntryFromEnv } from "./dev-spawn-options.js";
import type { ControlProbeResult, NativeExecutionObservation, NativeExecutionSubscription, NativeTurnBoundary } from "../shared/execution-protocol.js";
import type { ClaudeNativePermissionRequest, CodexNativePermissionRequest, OpenCodeNativePermissionRequest, ProviderPermissionRequest, ProviderPermissionObservation, ProviderPermissionCorrelation, ProviderPermissionDispatchOptions, ProviderPermissionReply } from "../shared/provider-permissions.js";

import type { SupervisedProviderAdapter } from "#provider-runtime/agents/provider-adapter.js";
import {
  ProviderRuntimeBoundary, providerErrorData, PROVIDER_STEP_ANSWER_BODY_SCHEMAS, ROOM_TURN_RECOVERY_STEP_NAMES, ROOM_TURN_STEP_NAMES, type ProviderEventEnvelope, type ProviderEventKind,
  type ProviderPermissionToken, type ProviderRuntimeRef, type ProviderRuntimeSnapshot, type ProviderStepName,
} from "#provider-runtime/agents/provider-runtime-boundary.js";
import type { ProviderRoomTurnRequest as ProviderBoundaryRoomTurnRequest } from "#provider-runtime/agents/provider-adapter.js";
import type { ProviderNativePermissionEvent } from "#provider-runtime/agents/provider-adapter.js";

/** What the router keeps for a work attempt: the provider, its data boundary and the reference of the installed runtime. */
type Remembered = { provider: string; boundary: ProviderRuntimeBoundary; runtime: ProviderRuntimeRef | null };
type Installed = Remembered & { runtime: ProviderRuntimeRef };
type StepEnvelope = Extract<ProviderEventEnvelope, { kind: "step" }>;
/** What the daemon does at each step of one operation. A step with no entry is answered at once. */
type StepHandlers = Partial<Record<ProviderStepName, (body: unknown) => unknown>>;
type ProviderConnection = NonNullable<ProviderActionHandle["providerConnection"]>;
/** The daemon's functions that a room turn and its recovery share. */
type RoomTurnCallbacks = {
  detachSignal?: AbortSignal;
  checkpointProviderState?: (state: { providerContinuationId: string; providerConnection: ProviderConnection }) => Promise<void>;
  settleLifecycleBeforeIdle?: () => Promise<void>;
  checkpointTerminalResult?: (result: ProviderRoomTurnResult) => Promise<ProviderRoomTurnCheckpointDisposition | void>;
};

/** The steps that a room turn and its recovery share. Only a function that the daemon gave makes a step. */
function roomTurnHandlers(options: RoomTurnCallbacks | undefined): StepHandlers {
  return {
    ...(options?.checkpointProviderState ? {
      checkpoint_provider_state: (body: unknown) => options.checkpointProviderState!({ providerContinuationId: stepText(body, "providerContinuationId"), providerConnection: stepConnection(body) }),
    } : {}),
    ...(options?.settleLifecycleBeforeIdle ? { settle_lifecycle_before_idle: () => options.settleLifecycleBeforeIdle!() } : {}),
    ...(options?.checkpointTerminalResult ? {
      checkpoint_terminal_result: (body: unknown) => options.checkpointTerminalResult!((body as { result: ProviderRoomTurnResult }).result),
    } : {}),
  };
}

/**
 * A step answer is JSON, and JSON has no `undefined`: `JSON.stringify` leaves such a property out. The daemon's
 * functions build plain objects, where an optional field can be present with the value `undefined` (for example
 * `evidence: undefined`). Leave those properties out here, as a JSON transport would, so that the boundary does not
 * refuse an answer that the daemon has already saved.
 *
 * Call this only on a value that `assertPlainWireValue` (with `allowUndefinedProperties`) accepted: that check reads
 * no getter and refuses accessors, symbol keys, other prototypes and cycles. This copy then only drops the
 * `undefined` properties of plain objects.
 */
function withoutUndefinedProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefinedProperties);
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => [key, withoutUndefinedProperties(field)]));
}

/** The names of the steps that the daemon answers, in the order of the operation's list. */
function stepNames<S extends ProviderStepName>(handlers: StepHandlers, steps: readonly S[]): S[] {
  return steps.filter((step) => handlers[step] !== undefined);
}

/** The connection of a step body, as the boundary checked it. */
function stepConnection(body: unknown): NonNullable<ProviderActionHandle["providerConnection"]> {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>).providerConnection : undefined;
  if (typeof value !== "object" || value === null) throw new Error("The provider step has no 'providerConnection'.");
  return value as NonNullable<ProviderActionHandle["providerConnection"]>;
}

/**
 * The room turn request as the boundary takes it: an image in memory crosses as base64 text. The daemon encodes
 * each image one time, here; the adapters that read images in memory gave base64 text to their provider before too.
 */
function boundaryRoomTurnRequest(request: ProviderRoomTurnRequest): ProviderBoundaryRoomTurnRequest {
  if (!request.attachments) return request as ProviderBoundaryRoomTurnRequest;
  return {
    ...request,
    attachments: request.attachments.map(({ image, ...attachment }) => image === undefined ? attachment : {
      ...attachment,
      image: {
        mimeType: image.mimeType,
        ...(image.data ? { base64: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString("base64") } : {}),
        ...(image.path !== undefined ? { path: image.path } : {}),
      },
    }),
  } as ProviderBoundaryRoomTurnRequest;
}

/** One text field of a step body. The boundary checks the body; the daemon does not act on a value it cannot read. */
function stepText(body: unknown, field: string): string {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "string" || !value) throw new Error(`The provider step has no '${field}'.`);
  return value;
}

/**
 * The contract between the daemon and a provider adapter. Its one definition
 * is in the provider runtime package; the four adapter classes implement it
 * there. This name stays for the daemon code and its tests.
 */
export type NativeProviderAdapter = SupervisedProviderAdapter;

export type ProviderAdapterLoader = () => Promise<NativeProviderAdapter>;

type BundledRuntimeVerifier = () => Promise<void>;

/**
 * The adapters' own sealed-runtime check, run once in the background from the
 * provider runtime; see warmLetAgentsMcpRuntime. A build without that
 * module (a partial dist-provider-runtime) has nothing to warm; its
 * launches still verify the runtime themselves, as every launch does.
 */
const bundledRuntimeVerifierFromBuild: BundledRuntimeVerifier = async () => {
  let module: { warmLetAgentsMcpRuntime?: (input: { devEntryPath?: string }) => Promise<void> };
  try {
    module = await import("#provider-runtime/agents/letagents-mcp-runtime.js");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    // Only a packaged app has a bundled runtime; there a missing module means every launch pays the first hash.
    if (typeof (process as { resourcesPath?: unknown }).resourcesPath === "string") console.warn("[runtime_verify]", "the provider runtime's MCP runtime module is missing; launches verify the runtime themselves");
    return;
  }
  if (typeof module.warmLetAgentsMcpRuntime !== "function") return;
  await module.warmLetAgentsMcpRuntime({ devEntryPath: devMcpServerEntryFromEnv() ?? undefined });
};

/**
 * The daemon's view of one runtime. It holds the runtime reference, not a
 * provider object. Its four changing fields ask the boundary for the state of
 * that exact runtime at each read; after the boundary forgets the runtime,
 * they keep the last state that was read.
 */
function publicHandle(boundary: ProviderRuntimeBoundary, installed: ProviderRuntimeSnapshot, appliedConfigurationRevision?: number): ProviderActionHandle {
  let last = installed;
  const now = () => (last = boundary.inspectIfHeld(installed.ref) ?? last);
  const token: OriginToken = Object.freeze({});
  handleOrigins.set(token, { boundary, runtime: installed.ref });
  const handle: ProviderActionHandle & { [RUNTIME_ORIGIN]: OriginToken } = {
    [RUNTIME_ORIGIN]: token,
    workAttemptId: installed.ref.workAttemptId,
    ...(installed.managedLaunchContract ? { managedLaunchContract: installed.managedLaunchContract } : {}),
    get pid() { return now().pid; },
    get providerContinuationId() { return now().providerContinuationId; },
    get providerConnection() { return now().providerConnection; },
    ...(appliedConfigurationRevision === undefined ? {} : { appliedConfigurationRevision }),
    ...(installed.launchNotices?.length ? { launchNotices: [...installed.launchNotices] } : {}),
    ...(installed.ownerSetup === true ? { ownerSetup: true as const } : {}),
    get observedState() { return now().observedState; },
  };
  return handle;
}

/**
 * The runtime that a handle of this module was made for. A call names its
 * runtime by this record and by nothing that the handle shows: the fields of a
 * handle can be equal for two runtimes of one work attempt.
 *
 * The handle holds an empty token under a symbol that only this module has,
 * as an enumerable property, so a copy of a handle (`{ ...handle }`) names the
 * same runtime as the handle. The record is found by the identity of the
 * token, and it is kept here: the handle gives no way to the boundary. An
 * object that was not copied from a handle has no token of this module, so it
 * names no runtime.
 */
type HandleOrigin = { readonly boundary: ProviderRuntimeBoundary; readonly runtime: ProviderRuntimeRef };
type OriginToken = Readonly<Record<string, never>>;
const RUNTIME_ORIGIN: unique symbol = Symbol("letagents.providerRuntimeOrigin");
const handleOrigins = new WeakMap<OriginToken, HandleOrigin>();

function originOf(handle: ProviderActionHandle): HandleOrigin | undefined {
  const token = (handle as { [RUNTIME_ORIGIN]?: unknown } | null)?.[RUNTIME_ORIGIN];
  return typeof token === "object" && token !== null ? handleOrigins.get(token as OriginToken) : undefined;
}

/**
 * Daemon-safe provider router. The adapters are in the provider runtime
 * package; this router imports only their Node-native lifecycle boundary, by
 * the package import name, at the first use of each provider.
 */
export class ProviderActionPortRouter implements ProviderActionPort {
  private readonly boundaries = new Map<string, Promise<ProviderRuntimeBoundary>>();
  private readonly handles = new Map<string, Remembered>();
  private readonly actions = new Map<string, string>();
  /**
   * Whether each runtime's process has exited, by runtime id. A remembered runtime that has exited stays
   * remembered for custody, and is never attached again. `replaced` is set when the router names another
   * runtime for the work attempt; a runtime that is both is forgotten by the boundary.
   */
  private readonly exits = new Map<string, { exited: boolean; replaced: boolean }>();
  /**
   * Who gets the events of each subscription, and of each start that is in progress, by the id that this router
   * made. The boundaries give all events to one sink; this map is the only link from an event to daemon code.
   */
  private readonly eventListeners = new Map<string, (event: ProviderEventEnvelope) => void>();
  /** The start listener of each runtime that was started with hints, by runtime id. */
  private readonly startListeners = new Map<string, string>();
  /** The operations that wait for this daemon at their steps, by operation id. */
  private readonly stepHandlers = new Map<string, (event: StepEnvelope) => void>();
  /** The token of each permission request that an event named. The request itself stays with the boundary. */
  private readonly permissionTokens = new WeakMap<object, string>();

  constructor(
    private readonly adapterLoaders: Readonly<Record<string, ProviderAdapterLoader>> = {},
    private readonly bundledRuntimeVerifier: BundledRuntimeVerifier = bundledRuntimeVerifierFromBuild,
  ) {}

  verifyBundledRuntime(): Promise<void> {
    return this.bundledRuntimeVerifier();
  }

  compactionProgress(workAttemptId: string, provider: string): { state: "compacting"; startedAt: string } | null {
    const current = this.handles.get(workAttemptId);
    if (!current || current.provider !== provider) return null;
    return current.boundary.compactionProgress(workAttemptId);
  }

  runtimeCustody(workAttemptId: string, provider: string): ProviderRuntimeCustody {
    const remembered = this.handles.get(workAttemptId);
    if (!remembered) return { state: "absent" };
    if (remembered.provider !== provider) return { state: "unknown" };
    const installed = remembered.runtime ? remembered.boundary.inspectIfHeld(remembered.runtime) : null;
    const state = remembered.boundary.runtimeCustody(workAttemptId, installed?.ref);
    if (state === "unknown") return { state: "unknown" };
    if (state === "absent") return installed
      ? { state: "retired", handle: publicHandle(remembered.boundary, installed) } : { state: "absent" };
    if (!installed || installed.ref.workAttemptId !== workAttemptId) return { state: "unknown" };
    return { state: "owned", handle: publicHandle(remembered.boundary, installed) };
  }

  private rememberAcquisition(provider: string, boundary: ProviderRuntimeBoundary, workAttemptId: string): void {
    const previous = this.handles.get(workAttemptId);
    this.resolveProvider(previous?.provider, provider);
    if (previous && previous.boundary !== boundary) throw new Error("Provider custody owner changed for the same work attempt.");
    this.handles.set(workAttemptId, { provider, boundary, runtime: previous?.runtime ?? null });
  }

  async capabilities(workAttemptId: string, requestedProvider?: string): Promise<ProviderActionCapabilities> {
    const provider = this.resolveProvider(this.handles.get(workAttemptId)?.provider, requestedProvider);
    const boundary = await this.boundary(provider);
    return { ...boundary.capabilities(), exactProcessStop: boundary.has("stopRef") };
  }

  async spawn(request: ProviderActionSpawn): Promise<ProviderActionHandle> {
    const provider = this.resolveProvider(this.handles.get(request.workAttemptId)?.provider, request.provider);
    const boundary = await this.boundary(provider);
    this.rememberAcquisition(provider, boundary, request.workAttemptId);
    const { onProgress, onNativeStarted, ...data } = request;
    const runtime = await this.withStartHints({ onProgress, onNativeStarted }, (options) => boundary.spawn(data, options));
    this.remember(provider, boundary, request, runtime);
    return publicHandle(boundary, runtime, request.configurationRevision);
  }

  async attach(ref: ProviderActionRef): Promise<ProviderActionHandle | ProviderActionAttachTerminal | null> {
    const remembered = this.handles.get(ref.workAttemptId);
    const provider = this.resolveProvider(
      remembered?.provider,
      ref.provider,
      providerFromConnection(ref.providerConnection),
    );
    // A handle whose process has exited is evidence of that exit, not a
    // runtime. The adapter answers for it from the durable reference, as it
    // does for a daemon that never held the handle.
    const installed = remembered?.runtime ? remembered.boundary.inspectIfHeld(remembered.runtime) : null;
    if (remembered && installed && !this.exits.get(installed.ref.runtimeId)?.exited) {
      const handle = installed;
      if (
        handle.providerContinuationId !== ref.providerContinuationId
        || (handle.lifecycleAuthorityMode !== undefined
          && handle.lifecycleAuthorityMode !== (ref.lifecycleAuthorityMode ?? "typed"))
        || (ref.providerConnection
          && !sameProviderActionConnectionIdentity(handle.providerConnection, ref.providerConnection))
      ) return null;
      // The Electron adapter registry is already keyed by the exact work
      // attempt and durable continuation. A predecessor daemon may have
      // omitted a provider connection it did not know how to serialize; the
      // remembered native handle is the authority needed to repair that
      // manifest, never permission to launch a replacement.
      if (provider === "codex" && ref.launchPolicy !== undefined) {
        const bound = await (await this.boundary(provider)).attach({
          ...ref, providerConnection: ref.providerConnection ?? handle.providerConnection,
        });
        // The adapter can stop a runtime that fails a check against the policy it is given
        // here. Its proof that the process is gone is then the answer, as at a first attach.
        if (bound.state !== "attached" || bound.runtime.ref.runtimeId !== handle.ref.runtimeId) {
          // A runtime that is not the installed one is not named by the router, so the boundary forgets it.
          if (bound.state === "attached") remembered.boundary.release(bound.runtime.ref);
          return bound.state === "terminal" ? attachTerminal(bound) : null;
        }
      }
      return publicHandle(remembered.boundary, handle);
    }
    const boundary = await this.boundary(provider);
    this.rememberAcquisition(provider, boundary, ref.workAttemptId);
    const attached = await boundary.attach(ref);
    if (attached.state === "absent") return null;
    if (attached.state === "terminal") return attachTerminal(attached);
    this.install(ref.workAttemptId, { provider, boundary, runtime: attached.runtime.ref });
    this.watchExit(boundary, attached.runtime.ref);
    return publicHandle(boundary, attached.runtime);
  }

  async attachAction(actionId: string, workAttemptId: string): Promise<ProviderActionAttachment> {
    if (this.actions.get(actionId) !== workAttemptId) return { state: "absent" };
    const remembered = this.handles.get(workAttemptId);
    const installed = remembered?.runtime ? remembered.boundary.inspectIfHeld(remembered.runtime) : null;
    return remembered && installed ? { state: "attached", handle: publicHandle(remembered.boundary, installed) } : { state: "absent" };
  }

  async resume(ref: ProviderActionRef, request: ProviderActionSpawn): Promise<ProviderActionHandle> {
    const provider = this.resolveProvider(
      this.handles.get(request.workAttemptId)?.provider,
      request.provider,
      ref.provider,
      providerFromConnection(ref.providerConnection),
    );
    const boundary = await this.boundary(provider);
    this.rememberAcquisition(provider, boundary, request.workAttemptId);
    const { onProgress, onNativeStarted, ...data } = request;
    const runtime = await this.withStartHints({ onProgress, onNativeStarted }, (options) => boundary.resume(ref, data, options));
    this.remember(provider, boundary, request, runtime);
    return publicHandle(boundary, runtime, request.configurationRevision);
  }

  async poke(handle: ProviderActionHandle, message: string, options?: { actionId?: string }): Promise<void> {
    const remembered = this.required(handle);
    await (await this.boundary(remembered.provider)).poke(remembered.runtime, message);
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
  }

  async controlTurn(handle: ProviderActionHandle, correction?: string | null, options?: { actionId?: string; targetTurnId?: string | null; checkpointTurnStarted?: (turnId: string) => Promise<void>; markDispatched?: () => Promise<void> }): Promise<ProviderTurnControlResult> {
    const remembered = this.required(handle);
    const boundary = await this.boundary(remembered.provider);
    const result = await this.withSteps(boundary, {
      checkpoint_turn_started: (body) => options?.checkpointTurnStarted?.(stepText(body, "turnId")),
      mark_dispatched: () => options?.markDispatched?.(),
    }, undefined, (operation) => boundary.controlTurn(remembered.runtime, correction, { ...operation, targetTurnId: options?.targetTurnId }));
    if (options?.actionId) this.actions.set(options.actionId, handle.workAttemptId);
    return result;
  }

  async inspectTurn(handle: ProviderActionHandle, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const remembered = this.required(handle);
    const boundary = await this.boundary(remembered.provider);
    if (!boundary.has("inspectTurn")) throw new Error(`Provider '${remembered.provider}' does not support exact turn inspection.`);
    return boundary.inspectTurn(remembered.runtime, turnId);
  }

  async controlExactTurn(handle: ProviderActionHandle, options: { targetTurnId?: string | null; checkpointTargetTurn: (turnId: string) => Promise<void>; markDispatched: () => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderExactTurnControlResult> {
    const remembered = this.required(handle);
    const boundary = await this.boundary(remembered.provider);
    if (!boundary.has("controlExactTurn")) throw new Error(`Provider '${remembered.provider}' does not support exact turn control.`);
    return this.withSteps(boundary, {
      checkpoint_target_turn: (body) => options.checkpointTargetTurn(stepText(body, "turnId")),
      mark_dispatched: () => options.markDispatched(),
    }, options.detachSignal, (operation) => boundary.controlExactTurn(remembered.runtime, { ...operation, targetTurnId: options.targetTurnId }));
  }

  async inspectTurnBoundary(handle: ProviderActionHandle): Promise<NativeTurnBoundary> {
    const remembered = this.required(handle);
    const expected = handle.providerConnection ? { ...handle.providerConnection } : null;
    const continuation = handle.providerContinuationId;
    const current = () => {
      if (this.handles.get(handle.workAttemptId) !== remembered) return false;
      const now = remembered.boundary.inspectIfHeld(remembered.runtime);
      return now !== null && now.providerContinuationId === continuation
        && sameProviderActionConnectionIdentity(expected, now.providerConnection);
    };
    if (!current()) return { state: "unknown" };
    const boundary = await this.boundary(remembered.provider);
    if (!current() || !boundary.has("inspectTurnBoundary")) return { state: "unknown" };
    const result = await boundary.inspectTurnBoundary(remembered.runtime);
    if (!current() || (result.state !== "unknown"
      && (result.providerContinuationId !== continuation
        || result.nativeProcessIdentity !== expected?.processIdentity))) return { state: "unknown" };
    return result;
  }

  private permissionBinding(handle: ProviderActionHandle) {
    const remembered = this.required(handle);
    const connection = structuredClone(handle.providerConnection);
    const continuation = handle.providerContinuationId;
    const current = () => {
      if (this.handles.get(handle.workAttemptId) !== remembered) return false;
      const now = remembered.boundary.inspectIfHeld(remembered.runtime);
      return now !== null && now.pid === handle.pid && now.providerContinuationId === continuation
        && sameProviderActionConnectionIdentity(connection, now.providerConnection)
        && sameProviderActionConnectionIdentity(connection, handle.providerConnection);
    };
    return { remembered, connection, continuation, current };
  }

  async observePermissions(handle: ProviderActionHandle, listener: (event: ProviderPermissionObservation) => void, signal: AbortSignal): Promise<void> {
    const binding = this.permissionBinding(handle);
    const { remembered, current } = binding;
    const notify = (event: ProviderPermissionObservation) => { try { listener(event); } catch { /* Observer cannot control providers. */ } };
    const boundary = await this.boundary(remembered.provider);
    if (signal.aborted) return;
    if (!current() || !["codex", "open-model", "claude-code", "antigravity"].includes(remembered.provider) || !boundary.has("observePermissions")) { notify({ type: "unavailable" }); return; }
    // The native connection id of the last snapshot, read as the boundary reads it (no id is ""), or null when
    // no snapshot is current. The daemon's connection id of a provider other than Codex is made from the process
    // connection only, so a change of the native id is reported as a lost lane first.
    let nativeConnectionId: string | null = null;
    await this.observeNativePermissions(boundary, remembered.runtime, signal, (event, tokens) => {
      if (signal.aborted) return;
      if (event.type !== "request_closed") {
        const previous = nativeConnectionId;
        nativeConnectionId = event.type !== "snapshot" ? null
          : typeof event.connectionId === "string" ? event.connectionId : "";
        if (remembered.provider !== "codex" && previous !== null && nativeConnectionId !== null
          && previous !== nativeConnectionId && current()) notify({ type: "degraded" });
      }
      if (!current()) { notify({ type: "unavailable" }); return; }
      if (event.type === "request_closed") {
        if (remembered.provider === "codex" && "method" in event.request)
          notify({ type: "request_closed", request: { provider: "codex", native: event.request } });
        else if (remembered.provider === "claude-code" && "providerTurnId" in event && "request" in event.request)
          notify({ type: "request_closed", request: { provider: "claude-code", native: event.request },
            providerContinuationId: event.providerContinuationId, providerTurnId: event.providerTurnId });
        else if (remembered.provider === "antigravity" && "providerTurnId" in event && "request" in event.request)
          notify({ type: "request_closed", request: { provider: "antigravity", native: event.request },
            providerContinuationId: event.providerContinuationId, providerTurnId: event.providerTurnId });
        return;
      }
      if (event.type !== "snapshot") { notify(event); return; }
      // Empty Codex snapshots still attest a live RPC connection. A pending
      // request cannot supply that authority once the final request closes.
      const connectionId = remembered.provider === "codex" ? event.connectionId
        : createHash("sha256").update(JSON.stringify(binding.connection)).digest("hex");
      if (typeof connectionId !== "string" || !connectionId.trim()
        || (remembered.provider === "codex" && event.requests.some(native =>
          (native as CodexNativePermissionRequest).connectionId !== connectionId))) {
        notify({ type: "degraded" });
        return;
      }
      const requests: ProviderPermissionRequest[] = event.requests.map(native => remembered.provider === "codex"
        ? { provider: "codex", native: native as CodexNativePermissionRequest }
        : remembered.provider === "claude-code"
          ? { provider: "claude-code", native: structuredClone(native as ClaudeNativePermissionRequest) }
          : remembered.provider === "antigravity"
            ? { provider: "antigravity", native: structuredClone(native as ClaudeNativePermissionRequest) }
            : { provider: "open-model", native: structuredClone(native as OpenCodeNativePermissionRequest) });
      // The daemon keeps the request for its own reading. For the boundary, the token is the name of the request.
      requests.forEach((request, index) => { if (tokens[index]) this.permissionTokens.set(request.native, tokens[index]!); });
      notify({ type: "snapshot", requests, connectionId });
    });
  }

  /**
   * One permission subscription for as long as the signal is not aborted. The promise settles as the adapter's own
   * promise did: it resolves when the adapter's observation call returns, and it rejects when that call fails. The
   * listener stays until the abort in the two cases, as before.
   */
  private observeNativePermissions(
    boundary: ProviderRuntimeBoundary,
    runtime: ProviderRuntimeRef,
    signal: AbortSignal,
    listener: (event: ProviderNativePermissionEvent, tokens: readonly string[]) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      // The abort ends the subscription, so the adapter's own end can no longer arrive as an event. The promise
      // resolves here, as the adapter's promise resolved at the abort.
      const stop = () => { this.eventListeners.delete(id); boundary.unsubscribe(id); resolve(); };
      this.eventListeners.set(id, (event) => {
        if (event.kind !== "permissions") return;
        const body = event.body as ProviderNativePermissionEvent | { type: "settled"; outcome: "ended" | "failed"; message?: string };
        if (body.type !== "settled") { listener(body, event.permissionTokens ?? []); return; }
        if (body.outcome === "failed") reject(new Error(body.message ?? "failed")); else resolve();
      });
      try {
        boundary.subscribe(runtime, "permissions", id);
      } catch (error) {
        this.eventListeners.delete(id);
        reject(error);
        return;
      }
      if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
    });
  }

  async correlatePermissionTurn(handle: ProviderActionHandle, request: ProviderPermissionRequest, options: { roomTurnId?: string } = {}): Promise<ProviderPermissionCorrelation> {
    try {
      const { remembered, current, continuation } = this.permissionBinding(handle);
      if (!current() || request.provider !== remembered.provider) return { outcome: "correlation_unproven" };
      if (request.provider === "codex") {
        const params = request.native.params as Record<string, unknown> | null;
        if (request.native.method === "mcpServer/elicitation/request") {
          const boundary = await this.boundary(remembered.provider);
          if (!current() || !boundary.has("inspectPermissionMcpToolCall")) return { outcome: "correlation_unproven" };
          const proposal = await boundary.inspectPermissionMcpToolCall(remembered.runtime, this.named(remembered.runtime, request.native));
          if (!current() || !proposal || proposal.threadId !== continuation
            || typeof proposal.turnId !== "string" || !proposal.turnId.trim() || proposal.turnId.length > 512) {
            return { outcome: "correlation_unproven" };
          }
          // Arbitrary MCP tool execution uses the existing host-only command
          // authority. It is never eligible for delegated file-change approval.
          return { outcome: "correlated", providerContinuationId: continuation!, providerTurnId: proposal.turnId, kind: "command" };
        }
        const kind = request.native.method === "item/commandExecution/requestApproval" ? "command"
          : request.native.method === "item/fileChange/requestApproval" ? "file_change"
            : request.native.method === "item/permissions/requestApproval" ? "network" : null;
        if (!kind || !params || Array.isArray(params) || params.threadId !== continuation
          || typeof params.turnId !== "string" || !params.turnId.trim() || params.turnId.length > 512
          || typeof params.itemId !== "string" || !params.itemId.trim() || params.itemId.length > 512
          || !Number.isSafeInteger(params.startedAtMs) || (params.startedAtMs as number) < 0) return { outcome: "correlation_unproven" };
        if (kind === "network") {
          const boundary = await this.boundary(remembered.provider);
          if (!current() || !boundary.has("inspectPermissionProfile")) return { outcome: "correlation_unproven" };
          const profile = await boundary.inspectPermissionProfile(remembered.runtime, this.named(remembered.runtime, request.native));
          if (!current() || !profile) return { outcome: "correlation_unproven" };
        }
        if (kind === "file_change") {
          const boundary = await this.boundary(remembered.provider);
          if (!current() || !boundary.has("inspectPermissionFileChanges")) return { outcome: "correlation_unproven" };
          const fileChanges = await boundary.inspectPermissionFileChanges(remembered.runtime, this.named(remembered.runtime, request.native));
          if (!current() || !fileChanges?.length) return { outcome: "correlation_unproven" };
          return { outcome: "correlated", providerContinuationId: continuation!, providerTurnId: params.turnId, kind, fileChanges };
        }
        return { outcome: "correlated", providerContinuationId: continuation!, providerTurnId: params.turnId, kind };
      }
      const expected = structuredClone(request.native);
      const kind = request.provider === "claude-code" ? "command"
        : request.provider === "antigravity" ? antigravityApprovalKind(request.native.request.tool_name)
        : (expected as OpenCodeNativePermissionRequest).permission === "bash" ? "command"
          : (expected as OpenCodeNativePermissionRequest).permission === "edit" ? "file_change" : null;
      if (!kind) return { outcome: "correlation_unproven" };
      const boundary = await this.boundary(remembered.provider);
      if (!current() || !boundary.has("correlatePermissionTurn")) return { outcome: "correlation_unproven" };
      const result = await boundary.correlatePermissionTurn(remembered.runtime, expected,
        request.provider === "open-model" && options.roomTurnId ? { roomTurnId: options.roomTurnId } : undefined);
      if (!current() || result.outcome !== "correlated" || result.providerContinuationId !== continuation) return { outcome: "correlation_unproven" };
      return { outcome: "correlated", providerContinuationId: result.providerContinuationId, providerTurnId: result.providerTurnId, kind };
    } catch { return { outcome: "correlation_unproven" }; }
  }

  async replyPermission(handle: ProviderActionHandle, request: ProviderPermissionRequest, reply: "once" | "reject", options: ProviderPermissionDispatchOptions): Promise<ProviderPermissionReply> {
    const { remembered, current } = this.permissionBinding(handle);
    const assertCurrent = () => {
      if (!current() || request.provider !== remembered.provider) throw Object.assign(new Error("Permission provider binding changed."), { outcome: "not_dispatched" });
    };
    assertCurrent();
    const named = this.named(remembered.runtime, request.native);
    const native = "token" in named ? named : request.provider === "codex" ? request.native : structuredClone(request.native);
    const boundary = await this.boundary(remembered.provider);
    assertCurrent();
    if (!boundary.has("replyPermission") || typeof options?.beforeNativeDispatch !== "function") throw Object.assign(new Error("Permission dispatch is unsupported."), { outcome: "not_dispatched" });
    let admitted = false;
    const result = await this.withSteps(boundary, {
      before_native_dispatch: async () => { assertCurrent(); await options.beforeNativeDispatch(); assertCurrent(); },
      assert_native_dispatch: () => { assertCurrent(); options.assertNativeDispatch?.(); admitted = true; },
    }, undefined, (operation) => boundary.replyPermission(remembered.runtime, native, reply, {
      ...operation,
      ...(options.expectedFileChanges === undefined ? {} : { expectedFileChanges: options.expectedFileChanges }),
    })).catch(error => {
      if (admitted && !current()) throw Object.assign(new Error("Permission dispatch cannot be confirmed."), { outcome: "uncertain" });
      throw error;
    });
    if (!admitted || !current()) throw Object.assign(new Error("Permission dispatch cannot be confirmed."), { outcome: "uncertain" });
    if ((request.provider === "codex" || request.provider === "claude-code" || request.provider === "antigravity")
      && result.outcome === "sent") return { outcome: "sent_unacknowledged", nativeScope: "request" };
    if (request.provider === "open-model" && result.outcome === "processed") return { outcome: "native_processed", nativeScope: result.nativeScope };
    throw Object.assign(new Error("Permission dispatch returned unexpected evidence."), { outcome: "uncertain" });
  }

  async runRoomTurn(handle: ProviderActionHandle, request: ProviderRoomTurnRequest, options?: RoomTurnCallbacks & { beforeNativeDispatch?: () => Promise<void>; checkpointTurnStarted?: (turnId: string) => Promise<void>; checkpointPreparedTurn?: (state: { providerTurnId: string; providerContinuationId: string; providerConnection: NonNullable<ProviderActionHandle["providerConnection"]> }) => Promise<void>; markDurableTurnStarted?: () => void; markDispatched?: () => Promise<void> }): Promise<ProviderRoomTurnResult> {
    const remembered = this.required(handle);
    const boundary = await this.boundary(remembered.provider);
    if (!boundary.has("runRoomTurn")) throw new Error(`Provider '${remembered.provider}' does not support bounded room turns.`);
    // The adapters call `beforeNativeDispatch`; the old name is the same point.
    const beforeNativeDispatch = options?.beforeNativeDispatch ?? options?.markDispatched;
    const handlers: StepHandlers = {
      ...roomTurnHandlers(options),
      ...(beforeNativeDispatch ? { before_native_dispatch: () => beforeNativeDispatch() } : {}),
      ...(options?.checkpointTurnStarted ? { checkpoint_turn_started: (body: unknown) => options.checkpointTurnStarted!(stepText(body, "turnId")) } : {}),
      ...(options?.checkpointPreparedTurn ? {
        checkpoint_prepared_turn: (body: unknown) => options.checkpointPreparedTurn!({
          providerTurnId: stepText(body, "providerTurnId"), providerContinuationId: stepText(body, "providerContinuationId"), providerConnection: stepConnection(body),
        }),
      } : {}),
      ...(options?.markDurableTurnStarted ? { mark_durable_turn_started: () => options.markDurableTurnStarted!() } : {}),
    };
    const boundaryRequest = boundaryRoomTurnRequest(request);
    return this.withSteps(boundary, handlers, options?.detachSignal, (operation) => boundary.runRoomTurn(remembered.runtime, boundaryRequest, {
      ...operation, steps: stepNames(handlers, ROOM_TURN_STEP_NAMES),
    }));
  }

  /** Asked for one turn only; an unknown or replaced handle takes no images. */
  async roomTurnImageDelivery(handle: ProviderActionHandle): Promise<RoomTurnImageDelivery> {
    let remembered: ReturnType<ProviderActionPortRouter["required"]>;
    try { remembered = this.required(handle); } catch { return null; }
    const boundary = await this.boundary(remembered.provider);
    return boundary.has("roomTurnImageDelivery") ? boundary.roomTurnImageDelivery(remembered.runtime) ?? null : null;
  }

  /** Asked for one turn only; an unknown or replaced handle opens no files. */
  async roomTurnFileAccess(handle: ProviderActionHandle): Promise<RoomTurnFileAccess> {
    let remembered: ReturnType<ProviderActionPortRouter["required"]>;
    try { remembered = this.required(handle); } catch { return null; }
    const boundary = await this.boundary(remembered.provider);
    return boundary.has("roomTurnFileAccess") ? boundary.roomTurnFileAccess(remembered.runtime) ?? null : null;
  }

  async recoverRoomTurn(handle: ProviderActionHandle, request: ProviderRoomTurnRecoveryRequest, options?: RoomTurnCallbacks): Promise<ProviderRoomTurnResult> {
    const remembered = this.required(handle);
    const boundary = await this.boundary(remembered.provider);
    if (!boundary.has("recoverRoomTurn")) throw new Error(`Provider '${remembered.provider}' does not support bounded room-turn recovery.`);
    const handlers = roomTurnHandlers(options);
    return this.withSteps(boundary, handlers, options?.detachSignal, (operation) => boundary.recoverRoomTurn(remembered.runtime, request, {
      ...operation, steps: stepNames(handlers, ROOM_TURN_RECOVERY_STEP_NAMES),
    }));
  }

  async repairContinuation(handle: ProviderActionHandle, request: ProviderContinuationRepairRequest, options: { checkpointReplacement: (providerContinuationId: string) => Promise<void>; detachSignal?: AbortSignal }): Promise<ProviderContinuationRepairResult> {
    const remembered = this.required(handle);
    // Public handles expose live getters. Freeze the authority being repaired
    // before an adapter can mutate its native handle or yield to a replacement.
    const workAttemptId = handle.workAttemptId;
    const pid = handle.pid;
    const connection = structuredClone(handle.providerConnection);
    const continuation = handle.providerContinuationId;
    const assertOwned = () => {
      if (options.detachSignal?.aborted || this.handles.get(workAttemptId) !== remembered) {
        throw new Error("Provider ownership changed during continuation repair.");
      }
    };
    const boundary = await this.boundary(remembered.provider);
    assertOwned();
    if (!boundary.has("repairContinuation")) throw new Error(`Provider '${remembered.provider}' does not support continuation repair.`);
    let repairId = "";
    const { runtime, noticesAwaitAcknowledgement, ...result } = await this.withSteps(boundary, {
      checkpoint_replacement: (body) => options.checkpointReplacement(stepText(body, "providerContinuationId")),
    }, options.detachSignal, (operation) => { repairId = operation.operationId; return boundary.repairContinuation(remembered.runtime, request, operation); });
    // The adapter's wait for "the lines are recorded" is a data call that names the repair.
    const repaired = { ...result, ...(noticesAwaitAcknowledgement ? { noticesRecorded: () => boundary.acknowledgeRepairNotices(repairId) } : {}) };
    assertOwned();
    if (runtime.ref.workAttemptId !== workAttemptId || runtime.pid !== pid
      || !sameProviderActionConnectionIdentity(runtime.providerConnection, connection)) {
      throw new Error("Provider continuation repair changed the verified provider process identity.");
    }
    if (repaired.previousProviderContinuationId !== continuation
      || repaired.replacementProviderContinuationId !== runtime.providerContinuationId) {
      throw new Error("Provider continuation repair returned inconsistent conversation identity.");
    }
    if (repaired.outcome === "rematerialized") {
      if (runtime.ref.runtimeId !== remembered.runtime.runtimeId || repaired.replacementProviderContinuationId !== continuation) {
        throw new Error("Provider restoration must preserve the installed native handle and conversation.");
      }
      // The registry record owns existing observations. A restoration changes
      // neither that ownership nor the coordinator's installed public handle.
      return { ...repaired, handle };
    }
    if (repaired.replacementProviderContinuationId === continuation) {
      throw new Error("Provider replacement must establish a different conversation.");
    }
    this.install(workAttemptId, { ...remembered, runtime: runtime.ref });
    this.watchExit(boundary, runtime.ref);
    return {
      ...repaired,
      handle: publicHandle(boundary, runtime, handle.appliedConfigurationRevision),
    };
  }

  async describeManagedLaunchContract(input: { provider: string; apiUrl: string; devMcpServerEntryPath?: string }): Promise<string | null> {
    const boundary = await this.boundary(this.requiredProvider(input.provider));
    if (!boundary.has("stopIdle") || !boundary.has("describeManagedLaunchContract")) return null;
    const { apiUrl, devMcpServerEntryPath } = input;
    return boundary.describeManagedLaunchContract({ apiUrl, ...(devMcpServerEntryPath === undefined ? {} : { devMcpServerEntryPath }) });
  }

  async stopIdle(handle: ProviderActionHandle, assertCurrent: () => void): Promise<ProviderActionTerminal> {
    const remembered = this.required(handle);
    const boundary = await this.boundary(remembered.provider);
    if (!boundary.has("stopIdle") || this.required(handle) !== remembered) {
      throw new Error("The exact provider cannot prove idle replacement.");
    }
    assertCurrent();
    return this.withSteps(boundary, {
      assert_current: () => {
        if (this.required(handle) !== remembered) throw new Error("Provider changed before idle replacement.");
        assertCurrent();
      },
    }, undefined, (operation) => boundary.stopIdle(remembered.runtime, operation));
  }

  async stop(handle: ProviderActionHandle, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal> {
    const remembered = this.required(handle);
    const terminal = await (await this.boundary(remembered.provider)).stop(remembered.runtime, stopOptions(options));
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
    const boundary = await this.boundary(provider);
    // Protocol terminals can precede OS death. The exact-reference path
    // must prove the frozen birth is gone even when a cached handle exists.
    if (boundary.has("stopRef") && (provider === "codex" || provider === "open-model" || options?.force)) {
      const terminal = await boundary.stopRef(ref, stopOptions(options));
      if (options?.actionId) this.actions.set(options.actionId, ref.workAttemptId);
      return terminal;
    }
    const installed = remembered?.runtime ? remembered.boundary.inspectIfHeld(remembered.runtime) : null;
    if (installed
      && !this.exits.get(installed.ref.runtimeId)?.exited
      && installed.providerContinuationId === ref.providerContinuationId
      && sameProviderActionConnectionIdentity(installed.providerConnection, ref.providerConnection)) {
      const terminal = await boundary.stop(installed.ref, stopOptions(options));
      if (options?.actionId) this.actions.set(options.actionId, ref.workAttemptId);
      return terminal;
    }
    if (!boundary.has("stopRef")) throw new Error(`Provider '${provider}' cannot stop an unattached durable process reference.`);
    const terminal = await boundary.stopRef(ref, stopOptions(options));
    if (options?.actionId) this.actions.set(options.actionId, ref.workAttemptId);
    return terminal;
  }

  async onExit(handle: ProviderActionHandle, listener: (terminal: ProviderActionTerminal) => void): Promise<() => void> {
    const remembered = this.required(handle);
    return this.listen(await this.boundary(remembered.provider), remembered.runtime, "exit", (body) => listener(body as ProviderActionTerminal)).dispose;
  }

  async onStream(handle: ProviderActionHandle, listener: (event: ProviderActionStreamEvent) => void): Promise<() => void> {
    const remembered = this.required(handle);
    // A stream event that was dropped at the boundary reaches the consumer as an explicit fault event. Its method is
    // not a turn or item method, so no stream policy reads it as the failure of a turn.
    const fault = (count: number): ProviderActionStreamEvent => ({
      workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId,
      observedAt: new Date().toISOString(),
      sequence: 0,
      provider: remembered.provider,
      kind: "error",
      method: "boundary/event_dropped",
      summary: "A provider event was not plain data and was dropped.",
      payload: { dropped: count },
      payloadTruncated: false,
      payloadRedacted: true,
      durablePayloadRef: null,
    });
    return this.listen(await this.boundary(remembered.provider), remembered.runtime, "stream",
      (body) => listener(body as ProviderActionStreamEvent), (count) => listener(fault(count))).dispose;
  }

  async onExecution(handle: ProviderActionHandle, listener: (event: NativeExecutionObservation) => void, onGap?: () => void): Promise<NativeExecutionSubscription> {
    const remembered = this.required(handle);
    const boundary = await this.boundary(remembered.provider);
    if (!boundary.has("onExecution")) throw new Error(`Provider '${remembered.provider}' does not expose native execution observations.`);
    const subscription = this.listen(boundary, remembered.runtime, "execution", (body) => listener(body as NativeExecutionObservation), () => onGap?.());
    // The last position that was read stays the answer after the subscription ends.
    let position = boundary.subscriptionPosition(subscription.id) ?? { firstRetainedSequence: 1, latestSequence: 0 };
    return Object.freeze({
      sourceId: subscription.sourceId ?? "",
      position: () => (position = boundary.subscriptionPosition(subscription.id) ?? position),
      dispose: () => { position = boundary.subscriptionPosition(subscription.id) ?? position; subscription.dispose(); },
    });
  }

  async stopBackgroundCommand(handle: ProviderActionHandle, taskId: string): Promise<"stopping" | "not_running" | "failed"> {
    const remembered = this.required(handle);
    if (!remembered.boundary.has("stopBackgroundCommand")) return "not_running";
    return await remembered.boundary.stopBackgroundCommand(remembered.runtime, taskId) ?? "not_running";
  }

  async readUsage(handle: ProviderActionHandle): Promise<import("../shared/provider-usage.js").ProviderUsage | null> {
    const remembered = this.required(handle);
    const continuation = handle.providerContinuationId;
    const connection = structuredClone(handle.providerConnection);
    // Cursor keeps its session between turns without a live process. Reading
    // that exact idle lane needs stable state, not evidence of process life.
    // Other providers and running Cursor turns still require a process birth.
    const sameConnection = remembered.provider === "cursor" && connection?.kind === "cursor_cli"
      && connection.pid === null && connection.processIdentity == null
      ? sameProviderActionConnectionSnapshot : sameProviderActionConnectionIdentity;
    const runtimeId = remembered.runtime.runtimeId;
    if (!sameConnection(remembered.boundary.inspectIfHeld(remembered.runtime)?.providerConnection, connection)
      || this.exits.get(runtimeId)?.exited) return null;
    const usage = remembered.boundary.has("readUsage") ? await remembered.boundary.readUsage(remembered.runtime) ?? null : null;
    const current = this.handles.get(handle.workAttemptId);
    const now = current === remembered ? remembered.boundary.inspectIfHeld(remembered.runtime) : null;
    return now !== null && now.providerContinuationId === continuation
      && sameConnection(now.providerConnection, connection)
      && !this.exits.get(runtimeId)?.exited && usage?.providerContinuationId === continuation ? usage : null;
  }

  async probeControl(handle: ProviderActionHandle): Promise<ControlProbeResult> {
    const remembered = this.required(handle);
    const boundary = await this.boundary(remembered.provider);
    return boundary.has("probeControl") ? boundary.probeControl(remembered.runtime) : { state: "unprobeable" };
  }

  /**
   * Start one subscription and give its events to `listener`. The receiver is in place before the adapter is
   * called, because an adapter can deliver events inside that call. `onGap` gets the count of dropped events, so
   * the consumer of the subscription can use its own fault path.
   */
  private listen(
    boundary: ProviderRuntimeBoundary,
    runtime: ProviderRuntimeRef,
    kind: ProviderEventKind,
    listener: (body: unknown) => void,
    onGap?: (count: number) => void,
  ): { id: string; sourceId?: string; dispose: () => void } {
    const id = randomUUID();
    this.eventListeners.set(id, (event) => {
      if (event.kind === "gap") { onGap?.(event.body.count); return; }
      if (event.kind !== kind) return;
      if (event.final) this.eventListeners.delete(id);
      listener(event.body);
    });
    try {
      const subscription = boundary.subscribe(runtime, kind, id);
      return { id, sourceId: subscription.sourceId, dispose: () => { this.eventListeners.delete(id); boundary.unsubscribe(id); } };
    } catch (error) {
      this.eventListeners.delete(id);
      throw error;
    }
  }

  /** Run one start. Its two hints arrive as `start` events that carry the operation id made here. */
  private async withStartHints<T>(
    hints: { onProgress?: () => void; onNativeStarted?: () => void },
    start: (options: { startOperationId?: string }) => Promise<T>,
  ): Promise<T> {
    if (!hints.onProgress && !hints.onNativeStarted) return start({});
    const startOperationId = randomUUID();
    this.eventListeners.set(startOperationId, (event) => {
      if (event.kind !== "start") return;
      if (event.body.hint === "progress") hints.onProgress?.(); else hints.onNativeStarted?.();
    });
    // Claude Code reports compaction progress through the same hint long after the start, so the listener stays for
    // the life of the runtime. It goes when the start fails, or when the runtime is forgotten.
    try {
      const started = await start({ startOperationId });
      const runtimeId = (started as { ref?: { runtimeId?: unknown } } | null)?.ref?.runtimeId;
      if (typeof runtimeId === "string") {
        this.dropStartListener(runtimeId);
        this.startListeners.set(runtimeId, startOperationId);
      } else {
        this.eventListeners.delete(startOperationId);
      }
      return started;
    } catch (error) {
      this.eventListeners.delete(startOperationId);
      throw error;
    }
  }

  /**
   * The name of a permission request for the boundary: the token that the request object got when an event named
   * it. The token belongs to that object only. An equal request of another runtime, or of a later observation, has
   * its own token, and the boundary refuses a token whose runtime or authority is not the current one.
   */
  private named<T extends object>(_runtime: ProviderRuntimeRef, request: T): T | ProviderPermissionToken {
    const token = this.permissionTokens.get(request);
    return token ? { token } : request;
  }

  /**
   * Run one operation whose steps this daemon answers. The daemon's function for a step runs at the delivery of
   * the step, as its callback ran before. A function that throws refuses the step; the operation then fails with
   * that same error object, unless the adapter made another error of it.
   */
  private async withSteps<T>(
    boundary: ProviderRuntimeBoundary,
    handlers: StepHandlers,
    detachSignal: AbortSignal | undefined,
    run: (operation: { operationId: string; detached?: true }) => Promise<T>,
  ): Promise<T> {
    const operationId = randomUUID();
    const refusals = new Map<number, unknown>();
    const answer = (seq: number, outcome: { thrown: unknown } | { body: unknown }) => {
      if ("thrown" in outcome) refusals.set(seq, outcome.thrown);
      try {
        boundary.answerStep(operationId, seq, "thrown" in outcome
          ? { ok: false, error: providerErrorData(outcome.thrown) }
          : outcome.body === undefined ? { ok: true } : { ok: true, body: outcome.body as never });
      } catch (error) {
        // The operation ended or was detached, and its step took a refusal already; or the body was not data, and
        // the step is refused with that error.
        if ("thrown" in outcome || outcome.body === undefined) return;
        refusals.set(seq, error);
        try { boundary.answerStep(operationId, seq, { ok: false, error: providerErrorData(error) }); } catch { /* as above */ }
      }
    };
    // Only a step whose answer has a body forwards the value of the daemon's function; for another step it is ignored.
    // A body is checked as plain data first, without reading a getter; a value that is not data refuses the step
    // here, so no error can escape the promise handler below and leave the step without an answer.
    const settled = (step: ProviderStepName, value: unknown): { thrown: unknown } | { body: unknown } => {
      if (!(step in PROVIDER_STEP_ANSWER_BODY_SCHEMAS) || value === undefined) return { body: undefined };
      try {
        assertPlainWireValue(value, { path: `answer of ${step}`, allowUndefinedProperties: true });
        return { body: withoutUndefinedProperties(value) };
      } catch (thrown) {
        return { thrown };
      }
    };
    this.stepHandlers.set(operationId, (event) => {
      let result: unknown;
      try { result = handlers[event.step]?.(event.body); } catch (thrown) { answer(event.seq, { thrown }); return; }
      if (event.sync || !(result instanceof Promise)) { answer(event.seq, settled(event.step, event.sync ? undefined : result)); return; }
      result.then((value) => answer(event.seq, settled(event.step, value)), (thrown: unknown) => answer(event.seq, { thrown }));
    });
    const detach = () => boundary.detachOperation(operationId);
    detachSignal?.addEventListener("abort", detach, { once: true });
    try {
      return await run({ operationId, ...(detachSignal?.aborted ? { detached: true as const } : {}) });
    } catch (error) {
      const step = (error as { daemonStep?: unknown } | null)?.daemonStep;
      if (typeof step === "number" && refusals.has(step)) throw refusals.get(step);
      throw error;
    } finally {
      detachSignal?.removeEventListener("abort", detach);
      this.stepHandlers.delete(operationId);
    }
  }

  /** The data boundary of one provider. The adapter behind it is loaded at the first use and is named nowhere else. */
  private boundary(provider: string): Promise<ProviderRuntimeBoundary> {
    const current = this.boundaries.get(provider);
    if (current) return current;
    const loaded = this.loadAdapter(provider).then((adapter) => {
      const boundary = new ProviderRuntimeBoundary(provider, adapter);
      boundary.connectEventSink((event) => {
        if (event.kind === "gap") {
          console.warn("[provider_events]", `${provider}: ${event.body.count} ${event.body.dropped} event(s) were not plain data and were dropped`);
        }
        if (event.kind === "step") {
          const handler = this.stepHandlers.get(event.operationId);
          if (handler) handler(event);
          // No operation of this daemon waits under that id: the step must not stay open.
          else boundary.answerStep(event.operationId, event.seq, { ok: false, error: providerErrorData(new Error("No operation waits for this step.")) });
          return;
        }
        this.eventListeners.get(event.kind === "start" ? event.operationId : event.subscriptionId)?.(event);
      });
      return boundary;
    });
    this.boundaries.set(provider, loaded);
    return loaded;
  }

  private loadAdapter(provider: string): Promise<NativeProviderAdapter> {
    return (async () => {
      const loader = this.adapterLoaders[provider];
      if (loader) return loader();
      if (provider === "codex") {
        const module = await import("#provider-runtime/agents/codex-provider-adapter.js");
        const adapter: NativeProviderAdapter = new module.CodexProviderAdapter();
        return adapter;
      }
      if (provider === "claude-code") {
        const module = await import("#provider-runtime/agents/claude-code-provider-adapter.js");
        const adapter: NativeProviderAdapter = new module.ClaudeCodeProviderAdapter();
        return adapter;
      }
      if (provider === "cursor") {
        const module = await import("#provider-runtime/agents/cursor-provider-adapter.js");
        const adapter: NativeProviderAdapter = new module.CursorProviderAdapter();
        return adapter;
      }
      if (provider === "open-model") {
        const module = await import("#provider-runtime/agents/open-model-provider-adapter.js");
        const adapter: NativeProviderAdapter = new module.OpenModelProviderAdapter();
        return adapter;
      }
      if (provider === "antigravity") {
        const module = await import("#provider-runtime/agents/antigravity-provider-adapter.js");
        const adapter: NativeProviderAdapter = new module.AntigravityProviderAdapter();
        return adapter;
      }
      throw new Error(`No supervised native adapter is available for ${provider}.`);
    })();
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

  private remember(provider: string, boundary: ProviderRuntimeBoundary, request: ProviderActionSpawn, runtime: ProviderRuntimeSnapshot): void {
    this.install(request.workAttemptId, { provider, boundary, runtime: runtime.ref });
    this.watchExit(boundary, runtime.ref);
    if (request.actionId) this.actions.set(request.actionId, request.workAttemptId);
  }

  /** Name the runtime of a work attempt. The runtime that was named before is forgotten once its process has exited. */
  private install(workAttemptId: string, next: Installed): void {
    const previous = this.handles.get(workAttemptId);
    this.handles.set(workAttemptId, next);
    if (!previous?.runtime || previous.runtime.runtimeId === next.runtime.runtimeId) return;
    const exit = this.exits.get(previous.runtime.runtimeId);
    if (exit) exit.replaced = true;
    this.forgetEnded(previous.boundary, previous.runtime);
  }

  private dropStartListener(runtimeId: string): void {
    const startListener = this.startListeners.get(runtimeId);
    if (!startListener) return;
    this.startListeners.delete(runtimeId);
    this.eventListeners.delete(startListener);
  }

  private forgetEnded(boundary: ProviderRuntimeBoundary, runtime: ProviderRuntimeRef): void {
    const exit = this.exits.get(runtime.runtimeId);
    if (!exit?.exited || !exit.replaced) return;
    this.exits.delete(runtime.runtimeId);
    boundary.release(runtime);
  }

  /** Learn of the exit from the adapter itself; a handle's reported state cannot tell a stopped process from a failed turn. */
  private watchExit(boundary: ProviderRuntimeBoundary, runtime: ProviderRuntimeRef): void {
    if (this.exits.has(runtime.runtimeId)) return;
    const exit = { exited: false, replaced: false };
    this.exits.set(runtime.runtimeId, exit);
    try {
      this.listen(boundary, runtime, "exit", () => {
        exit.exited = true;
        // A runtime that has exited sends no start hint. Its listener goes here, with or without a replacement.
        this.dropStartListener(runtime.runtimeId);
        this.forgetEnded(boundary, runtime);
      });
    }
    catch { /* An adapter that cannot report this exit keeps the handle attachable, as before. */ }
  }

  private required(handle: ProviderActionHandle): Installed {
    // The handle must be one that this module made, for the exact runtime that the work attempt names now.
    // A handle of a replaced runtime is refused, also when its continuation and process id are equal.
    const origin = originOf(handle);
    const remembered = origin ? this.handles.get(origin.runtime.workAttemptId) : undefined;
    const installed = origin && remembered?.runtime
      && remembered.boundary === origin.boundary
      && remembered.runtime.runtimeId === origin.runtime.runtimeId
      && origin.runtime.workAttemptId === handle.workAttemptId
      ? remembered.boundary.inspectIfHeld(remembered.runtime) : null;
    if (!remembered || !installed
      || installed.providerContinuationId !== handle.providerContinuationId
      || (remembered.provider !== "cursor" && installed.pid !== handle.pid)) {
      throw new Error("Provider handle is not owned by the current daemon generation.");
    }
    return remembered as Installed;
  }
}

function attachTerminal(attached: { terminal: ProviderActionTerminal; notices?: readonly string[] }): ProviderActionAttachTerminal {
  return { state: "terminal", terminal: attached.terminal, ...(attached.notices ? { notices: attached.notices } : {}) };
}

/** The stop options that cross the data boundary. The action id is the router's own record and stays here. */
function stopOptions(options?: { force?: boolean; graceMs?: number; actionId?: string }): { force?: boolean; graceMs?: number } | undefined {
  if (!options) return undefined;
  return {
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
  };
}

/**
 * What an Antigravity request asks for. Its adapter names agy's tools as
 * Claude Code names them; a tool it does not map keeps agy's own name and
 * counts as a command, the kind that never delegates.
 */
export function antigravityApprovalKind(toolName: string): "command" | "file_change" | "network" {
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) return "file_change";
  if (["WebFetch", "WebSearch"].includes(toolName)) return "network";
  return "command";
}

/** The provider a durable connection kind belongs to; null for a missing or unknown connection. */
export function providerFromConnection(connection: ProviderActionRef["providerConnection"]): string | null {
  if (connection?.kind === "codex_app_server") return "codex";
  if (connection?.kind === "claude_cli") return "claude-code";
  if (connection?.kind === "cursor_cli") return "cursor";
  if (connection?.kind === "opencode_server") return "open-model";
  if (connection?.kind === "antigravity_acp") return "antigravity";
  return null;
}
