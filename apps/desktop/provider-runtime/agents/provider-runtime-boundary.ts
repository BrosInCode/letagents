// The data boundary between the daemon and one provider adapter (step 4d).
//
// The daemon never holds a provider handle. It holds a runtime reference,
// which is plain data, and each call names the runtime by that reference. This
// module keeps the handles, behind the package boundary.
//
// A runtime reference names one installed runtime: the provider, the work
// attempt and an id that this boundary makes for each handle it is given. A
// reference whose id this boundary does not hold is stale, and it is refused.
// It is never resolved to the newest runtime of the same work attempt.
//
// Step 4d-1 moved the references, the values of the operations that carry
// data only, and the value guard. Step 4d-2 moves the events: the daemon
// connects one sink, a subscription is data, and each event reaches the sink
// as an envelope. The operations in TRANSITIONAL_OPERATIONS still take a
// callback or an AbortSignal beside the reference; step 4d-3 replaces those.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertPlainWireValue, assertWireBoundarySchema, jsonValueSchema } from "#daemon-contract/wire-boundary.js";
import type { ControlProbeResult, NativeTurnBoundary } from "../../shared/execution-protocol.js";
import type { ClaudeNativePermissionRequest, CodexNativePermissionRequest, CodexPermissionFileChange, OpenCodeNativePermissionRequest, ProviderPermissionDispatchOptions } from "../../shared/provider-permissions.js";
import type { ProviderUsage } from "../../shared/provider-usage.js";
import type {
  ProviderAdapterCapabilities,
  ProviderContinuationRef,
  ProviderContinuationRepairRequest,
  ProviderContinuationRepairResult,
  ProviderExactTurnControlOptions,
  ProviderExactTurnControlResult,
  ProviderHandle,
  ProviderNativePermissionRequest,
  ProviderRoomTurnOptions,
  ProviderRoomTurnRecoveryRequest,
  ProviderRoomTurnRequest,
  ProviderRoomTurnResult,
  ProviderSpawnRequest,
  ProviderTerminalPayload,
  ProviderTurnControlOptions,
  ProviderTurnControlResult,
  RoomTurnFileAccess,
  RoomTurnImageDelivery,
  SupervisedProviderAdapter,
} from "./provider-adapter.js";

const boundedText = z.string().min(1).max(4096);
const processId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const processFields = {
  pid: processId.nullable(),
  processIdentity: z.string().max(4096).nullable().optional(),
};

/** The durable identity of a native provider process, as the manifest stores it. */
export const providerConnectionRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("codex_app_server"), url: z.string().max(4096), ...processFields }),
  z.strictObject({ kind: z.literal("claude_cli"), ...processFields }),
  z.strictObject({ kind: z.literal("cursor_cli"), ...processFields }),
  z.strictObject({ kind: z.literal("opencode_server"), url: z.string().max(4096), ...processFields, serverAuthPath: z.string().max(4096) }),
]);

/** One installed runtime of one provider. Plain data; the only name the daemon has for a runtime. */
export const providerRuntimeRefSchema = z.strictObject({
  provider: boundedText,
  workAttemptId: boundedText,
  /** Made by the boundary for each handle. A new process, or a new attach of the same process, has a new id. */
  runtimeId: boundedText,
});
export type ProviderRuntimeRef = z.output<typeof providerRuntimeRefSchema>;

export const providerObservedStateSchema = z.enum(["starting", "working", "idle", "stopping", "stopped", "failed"]);

/** What the boundary knows of a runtime at the moment of the call. A value, not a view: it does not change later. */
export const providerRuntimeSnapshotSchema = z.strictObject({
  ref: providerRuntimeRefSchema,
  pid: processId.nullable(),
  providerContinuationId: z.string().nullable(),
  providerConnection: providerConnectionRefSchema.nullable(),
  observedState: providerObservedStateSchema,
  lifecycleAuthorityMode: z.literal("typed").optional(),
  managedLaunchContract: z.string().optional(),
  launchNotices: z.array(z.string()).optional(),
  ownerSetup: z.literal(true).optional(),
});
export type ProviderRuntimeSnapshot = z.output<typeof providerRuntimeSnapshotSchema>;

export const providerTerminalSchema = z.strictObject({
  nativeRuntimeDeath: z.strictObject({
    kind: z.enum(["claude_cli", "codex_app_server"]),
    pid: processId,
    processIdentity: z.string().min(1).max(512),
  }).optional(),
  endedAt: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  terminalCause: z.enum(["exited", "killed", "stopped", "crashed", "protocol_error", "provider_quota"]),
  providerContinuationId: z.string().nullable(),
});

/** The durable reference of a runtime that this boundary may not hold: the input of attach, resume and the exact stop. */
export const providerContinuationRefSchema = z.strictObject({
  workAttemptId: boundedText,
  providerContinuationId: z.string(),
  provider: z.string().optional(),
  launchPolicy: jsonValueSchema.optional(),
  lifecycleAuthorityMode: z.literal("typed").optional(),
  providerConnection: providerConnectionRefSchema.nullable().optional(),
  ownerSetup: z.union([z.literal(true), z.literal("unknown")]).optional(),
});

export const providerAttachResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("attached"), runtime: providerRuntimeSnapshotSchema }),
  z.strictObject({ state: z.literal("terminal"), terminal: providerTerminalSchema, notices: z.array(z.string()).optional() }),
  z.strictObject({ state: z.literal("absent") }),
]);
export type ProviderAttachResult =
  | { state: "attached"; runtime: ProviderRuntimeSnapshot }
  | { state: "terminal"; terminal: ProviderTerminalPayload; notices?: readonly string[] }
  | { state: "absent" };

export const providerStopOptionsSchema = z.strictObject({
  force: z.boolean().optional(),
  graceMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type ProviderBoundaryStopOptions = z.output<typeof providerStopOptionsSchema>;

export const PROVIDER_EVENT_KINDS = ["exit", "stream", "execution", "permissions"] as const;
export type ProviderEventKind = (typeof PROVIDER_EVENT_KINDS)[number];

const subscriptionId = boundedText;
const eventCounter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * One event on its way to the daemon. `seq` counts in one subscription from 1
 * with no hole. `order` is one counter for the whole boundary: it is the order
 * in which the adapter made its calls, across all subscriptions and kinds.
 * The body is the adapter's own event, unchanged: an execution observation
 * keeps its `sourceId` and `sequence`, and a stream event keeps its `sequence`.
 */
export const providerEventEnvelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(PROVIDER_EVENT_KINDS),
    subscriptionId,
    ref: providerRuntimeRefSchema,
    seq: eventCounter,
    order: eventCounter,
    /** The last envelope of this subscription. The boundary has ended the subscription. */
    final: z.literal(true).optional(),
    body: jsonValueSchema,
  }),
  // One or more events of this subscription did not reach the daemon because they were not plain data.
  z.strictObject({
    kind: z.literal("gap"),
    subscriptionId,
    ref: providerRuntimeRefSchema,
    seq: eventCounter,
    order: eventCounter,
    body: z.strictObject({ dropped: z.enum(["stream", "execution"]), count: eventCounter }),
  }),
  // A hint from a start that is in progress. There is no runtime yet, so the operation id of the start names it.
  z.strictObject({
    kind: z.literal("start"),
    operationId: boundedText,
    order: eventCounter,
    body: z.strictObject({ hint: z.enum(["progress", "native_started"]) }),
  }),
]);
export type ProviderEventEnvelope =
  | { kind: ProviderEventKind; subscriptionId: string; ref: ProviderRuntimeRef; seq: number; order: number; final?: true; body: unknown }
  | { kind: "gap"; subscriptionId: string; ref: ProviderRuntimeRef; seq: number; order: number; body: { dropped: "stream" | "execution"; count: number } }
  | { kind: "start"; operationId: string; order: number; body: { hint: "progress" | "native_started" } };

/** The transport for all events of one boundary. The daemon connects it one time. It is not a per-call callback. */
export type ProviderEventSink = (event: ProviderEventEnvelope) => void;

export const providerSubscriptionSchema = z.strictObject({
  subscriptionId,
  /** Execution only: the identity of the adapter's observer, as in each of its observations. */
  sourceId: z.string().optional(),
});
export type ProviderSubscription = z.output<typeof providerSubscriptionSchema>;

export const providerSubscriptionPositionSchema = z.strictObject({
  firstRetainedSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  latestSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/** The schemas of the values that steps 4d-1 and 4d-2 moved. Each one meets the shared wire rule of the RPC contract. */
export const PROVIDER_BOUNDARY_SCHEMAS = {
  providerConnectionRef: providerConnectionRefSchema,
  providerRuntimeRef: providerRuntimeRefSchema,
  providerRuntimeSnapshot: providerRuntimeSnapshotSchema,
  providerTerminal: providerTerminalSchema,
  providerContinuationRef: providerContinuationRefSchema,
  providerAttachResult: providerAttachResultSchema,
  providerStopOptions: providerStopOptionsSchema,
  providerEventEnvelope: providerEventEnvelopeSchema,
  providerSubscription: providerSubscriptionSchema,
  providerSubscriptionPosition: providerSubscriptionPositionSchema,
} as const;
for (const schema of Object.values(PROVIDER_BOUNDARY_SCHEMAS)) assertWireBoundarySchema(schema);

/**
 * Operations whose arguments and results are data only. The boundary checks
 * each value with the shared value guard.
 */
export const DATA_OPERATIONS = [
  "capabilities", "operations", "spawn", "resume", "attach", "inspect", "release", "poke", "inspectTurn",
  "inspectTurnBoundary", "probeControl", "readUsage", "stopBackgroundCommand", "roomTurnImageDelivery",
  "roomTurnFileAccess", "compactionProgress", "runtimeCustody", "describeManagedLaunchContract",
  "correlatePermissionTurn", "inspectPermissionFileChanges", "inspectPermissionProfile",
  "inspectPermissionMcpToolCall", "stop", "stopRef", "subscribe", "unsubscribe", "subscriptionPosition",
] as const;

/** The one place where the daemon gives the boundary a function: the transport for events. */
export const TRANSPORT_OPERATIONS = ["connectEventSink"] as const;

/**
 * Operations that name the runtime by data but still take a callback or an
 * AbortSignal. The part that is not data is named for each.
 */
export const TRANSITIONAL_OPERATIONS = {
  controlTurn: ["checkpointTurnStarted", "markDispatched"],
  controlExactTurn: ["checkpointTargetTurn", "markDispatched", "detachSignal"],
  runRoomTurn: [
    "beforeNativeDispatch", "checkpointTurnStarted", "checkpointPreparedTurn", "checkpointProviderState",
    "settleLifecycleBeforeIdle", "markDurableTurnStarted", "checkpointTerminalResult", "detachSignal",
    "markDispatched", "request.attachments[].image.data (Uint8Array)",
  ],
  recoverRoomTurn: ["detachSignal", "checkpointProviderState", "settleLifecycleBeforeIdle", "checkpointTerminalResult"],
  repairContinuation: ["checkpointReplacement", "detachSignal", "result.noticesRecorded"],
  stopIdle: ["assertCurrent"],
  replyPermission: ["beforeNativeDispatch", "assertNativeDispatch"],
} as const;

/** The reference names a runtime that this boundary does not hold. Nothing was sent to a provider. */
export class StaleProviderRuntimeRefError extends Error {
  readonly code = "PROVIDER_RUNTIME_REF_STALE";
  constructor() {
    super("Provider handle is not owned by the current daemon generation.");
    this.name = "StaleProviderRuntimeRefError";
  }
}

/** An adapter gave the boundary a value that is not what the contract says. */
export class ProviderBoundaryValueError extends Error {
  readonly code = "PROVIDER_BOUNDARY_VALUE";
  constructor(operation: string, detail: string) {
    super(`Provider boundary value of '${operation}' is not valid: ${detail}`);
    this.name = "ProviderBoundaryValueError";
  }
}

/** Names the start for its hint events. The daemon makes the id and listens for `start` envelopes that carry it. */
export const providerStartOptionsSchema = z.strictObject({ startOperationId: boundedText.optional() });
export type ProviderStartOptions = z.output<typeof providerStartOptionsSchema>;
export type ProviderBoundarySpawnRequest = Omit<ProviderSpawnRequest, "onProgress" | "onNativeStarted">;
export type ProviderBoundaryRepairResult = Omit<ProviderContinuationRepairResult, "handle"> & { runtime: ProviderRuntimeSnapshot };
export type ProviderBoundaryOperation = keyof SupervisedProviderAdapter;

const GUARD = { allowUndefinedProperties: true } as const;

function guarded<T>(operation: string, part: string, value: T): T {
  try {
    assertPlainWireValue(value, { ...GUARD, path: `${operation}.${part}` });
  } catch (error) {
    throw new ProviderBoundaryValueError(operation, error instanceof Error ? error.message : "not plain data");
  }
  return value;
}

function conforming<T>(operation: string, schema: z.ZodType, value: T): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The path and the rule, never the value: a value can hold a secret.
    throw new ProviderBoundaryValueError(operation, `${issue?.path.join(".") || "$"}: ${issue?.code ?? "invalid"}`);
  }
  return value;
}

function isAttachTerminal(value: ProviderHandle | { state: "terminal" }): value is { state: "terminal"; terminal: ProviderTerminalPayload; notices?: readonly string[] } {
  return "state" in value && value.state === "terminal";
}

/**
 * One provider adapter behind the data boundary. The daemon makes one for
 * each adapter that it loads and calls nothing else on the adapter.
 */
export class ProviderRuntimeBoundary {
  private readonly handles = new Map<string, ProviderHandle>();
  private readonly runtimeIds = new WeakMap<ProviderHandle, string>();
  private readonly subscriptions = new Map<string, {
    ref: ProviderRuntimeRef;
    kind: ProviderEventKind;
    seq: number;
    end: () => void;
    position?: () => { firstRetainedSequence: number; latestSequence: number };
  }>();
  private sink: ProviderEventSink | null = null;
  private order = 0;

  constructor(readonly provider: string, private readonly adapter: SupervisedProviderAdapter) {}

  /** The optional operations that this adapter has. The daemon asks here and does not look at the adapter. */
  operations(): ProviderBoundaryOperation[] {
    const optional: ProviderBoundaryOperation[] = [
      "readUsage", "stopBackgroundCommand", "compactionProgress", "onExecution", "probeControl", "controlExactTurn",
      "inspectTurn", "inspectTurnBoundary", "runRoomTurn", "roomTurnImageDelivery", "roomTurnFileAccess",
      "recoverRoomTurn", "repairContinuation", "stopRef", "runtimeCustody", "observePermissions", "replyPermission",
      "correlatePermissionTurn", "inspectPermissionFileChanges", "inspectPermissionProfile",
      "inspectPermissionMcpToolCall", "describeManagedLaunchContract", "stopIdle",
    ];
    return optional.filter((operation) => typeof this.adapter[operation] === "function");
  }

  has(operation: ProviderBoundaryOperation): boolean {
    return typeof this.adapter[operation] === "function";
  }

  capabilities(): ProviderAdapterCapabilities {
    return guarded("capabilities", "result", this.adapter.capabilities());
  }

  /** Connect the transport for events. One sink for the life of the boundary. */
  connectEventSink(sink: ProviderEventSink): void {
    if (this.sink) throw new Error("The provider boundary already has an event sink.");
    this.sink = sink;
  }

  async spawn(request: ProviderBoundarySpawnRequest, options: ProviderStartOptions = {}): Promise<ProviderRuntimeSnapshot> {
    guarded("spawn", "request", request);
    return this.installed("spawn", await this.adapter.spawn({ ...request, ...this.startHints("spawn", options) }));
  }

  async resume(continuation: ProviderContinuationRef, request: ProviderBoundarySpawnRequest, options: ProviderStartOptions = {}): Promise<ProviderRuntimeSnapshot> {
    this.continuation("resume", continuation);
    guarded("resume", "request", request);
    return this.installed("resume", await this.adapter.resume(continuation, { ...request, ...this.startHints("resume", options) }));
  }

  /**
   * Start one subscription. It is exactly one listener of the adapter, so each
   * subscriber gets what a listener got before: a late `exit` subscriber gets
   * the terminal, and a new `execution` subscriber gets the retained history
   * first. The daemon makes the id, because an adapter can deliver the first
   * events before this call returns.
   */
  subscribe(ref: ProviderRuntimeRef, kind: ProviderEventKind, id: string): ProviderSubscription {
    const handle = this.held(ref);
    guarded("subscribe", "kind", kind);
    guarded("subscribe", "subscriptionId", id);
    if (!PROVIDER_EVENT_KINDS.includes(kind)) throw new ProviderBoundaryValueError("subscribe", "kind: not an event kind");
    if (typeof id !== "string" || !id || id.length > 4096) throw new ProviderBoundaryValueError("subscribe", "subscriptionId: invalid");
    if (this.subscriptions.has(id)) throw new ProviderBoundaryValueError("subscribe", "subscriptionId: in use");
    if (!this.sink) throw new Error("The provider boundary has no event sink.");
    const record: NonNullable<ReturnType<typeof this.subscriptions.get>> = {
      ref: { provider: ref.provider, workAttemptId: ref.workAttemptId, runtimeId: ref.runtimeId },
      kind,
      seq: 0,
      end: () => undefined,
    };
    this.subscriptions.set(id, record);
    try {
      if (kind === "exit") {
        record.end = this.adapter.onExit(handle, (terminal) => this.deliver(id, terminal, handle));
      } else if (kind === "stream") {
        record.end = this.adapter.onStream(handle, (event) => this.deliver(id, event, handle));
      } else if (kind === "execution") {
        const subscription = this.required("onExecution")(handle, (event) => this.deliver(id, event, handle));
        record.end = () => subscription.dispose();
        record.position = () => subscription.position();
        return { subscriptionId: id, sourceId: guarded("subscribe", "sourceId", subscription.sourceId) };
      } else {
        const controller = new AbortController();
        record.end = () => controller.abort();
        // The adapter's promise is reported as one event, so nothing but data comes back. It does not end the
        // subscription: an adapter may call the listener after its promise settled, and only the daemon ends it.
        void this.required("observePermissions")(handle, (event) => this.deliver(id, event, handle), controller.signal).then(
          () => this.deliver(id, { type: "settled", outcome: "ended" }, handle),
          (error: unknown) => this.deliver(id, { type: "settled", outcome: "failed", message: error instanceof Error ? error.message : "failed" }, handle),
        );
      }
    } catch (error) {
      this.subscriptions.delete(id);
      throw error;
    }
    return { subscriptionId: id };
  }

  /** End a subscription. A second call, or a call for an id that is not known, does nothing. */
  unsubscribe(id: string): void {
    const record = typeof id === "string" ? this.subscriptions.get(id) : undefined;
    if (!record) return;
    this.subscriptions.delete(id);
    record.end();
  }

  /** Execution only: the adapter's retained range for this subscription. Null for an ended or unknown subscription. */
  subscriptionPosition(id: string): { firstRetainedSequence: number; latestSequence: number } | null {
    const position = typeof id === "string" ? this.subscriptions.get(id)?.position : undefined;
    if (!position) return null;
    const value = position();
    guarded("subscriptionPosition", "result", value);
    return conforming("subscriptionPosition", providerSubscriptionPositionSchema, { ...value });
  }

  /** `absent` means only "not attached". It is not evidence that the process is gone. */
  async attach(continuation: ProviderContinuationRef): Promise<ProviderAttachResult> {
    this.continuation("attach", continuation);
    const attached = await this.adapter.attach(continuation);
    if (!attached) return { state: "absent" };
    if (isAttachTerminal(attached)) {
      const result: ProviderAttachResult = {
        state: "terminal",
        terminal: this.terminal("attach", attached.terminal),
        ...(attached.notices ? { notices: guarded("attach", "notices", attached.notices) } : {}),
      };
      return result;
    }
    return { state: "attached", runtime: this.installed("attach", attached) };
  }

  /** The state of the runtime now. Throws StaleProviderRuntimeRefError for a reference that is not held. */
  inspect(ref: ProviderRuntimeRef): ProviderRuntimeSnapshot {
    return this.snapshot("inspect", ref, this.held(ref));
  }

  /** As `inspect`, but null for a reference that is not held. */
  inspectIfHeld(ref: ProviderRuntimeRef): ProviderRuntimeSnapshot | null {
    this.reference(ref);
    const handle = this.handles.get(ref.runtimeId);
    return handle && this.matches(ref, handle) ? this.snapshot("inspect", ref, handle) : null;
  }

  /**
   * Forget a runtime that the daemon no longer names. Its reference is stale from here.
   * Its subscriptions stay until the daemon ends them: the daemon forgets a runtime inside the delivery of its exit
   * event, and the other subscribers must still get that event and the events after it.
   */
  release(ref: ProviderRuntimeRef): void {
    this.reference(ref);
    const handle = this.handles.get(ref.runtimeId);
    if (!handle || !this.matches(ref, handle)) return;
    this.handles.delete(ref.runtimeId);
    // A released reference stays stale: the same handle object gets a new id if an adapter returns it again.
    this.runtimeIds.delete(handle);
  }

  async poke(ref: ProviderRuntimeRef, message: string): Promise<void> {
    await this.adapter.poke(this.held(ref), guarded("poke", "message", message));
  }

  async inspectTurn(ref: ProviderRuntimeRef, turnId: string): Promise<"active" | "terminal" | "unknown"> {
    const handle = this.held(ref);
    return guarded("inspectTurn", "result", await this.required("inspectTurn")(handle, guarded("inspectTurn", "turnId", turnId)));
  }

  async inspectTurnBoundary(ref: ProviderRuntimeRef): Promise<NativeTurnBoundary> {
    const handle = this.held(ref);
    return guarded("inspectTurnBoundary", "result", await this.required("inspectTurnBoundary")(handle));
  }

  async probeControl(ref: ProviderRuntimeRef): Promise<ControlProbeResult> {
    const handle = this.held(ref);
    return guarded("probeControl", "result", await this.required("probeControl")(handle));
  }

  async readUsage(ref: ProviderRuntimeRef): Promise<ProviderUsage | null> {
    const handle = this.held(ref);
    return guarded("readUsage", "result", await this.required("readUsage")(handle));
  }

  async stopBackgroundCommand(ref: ProviderRuntimeRef, taskId: string): Promise<"stopping" | "not_running" | "failed"> {
    const handle = this.held(ref);
    return guarded("stopBackgroundCommand", "result", await this.required("stopBackgroundCommand")(handle, guarded("stopBackgroundCommand", "taskId", taskId)));
  }

  roomTurnImageDelivery(ref: ProviderRuntimeRef): RoomTurnImageDelivery {
    const handle = this.held(ref);
    return guarded("roomTurnImageDelivery", "result", this.required("roomTurnImageDelivery")(handle));
  }

  roomTurnFileAccess(ref: ProviderRuntimeRef): RoomTurnFileAccess {
    const handle = this.held(ref);
    return guarded("roomTurnFileAccess", "result", this.required("roomTurnFileAccess")(handle));
  }

  compactionProgress(workAttemptId: string): { state: "compacting"; startedAt: string } | null {
    guarded("compactionProgress", "workAttemptId", workAttemptId);
    return guarded("compactionProgress", "result", this.adapter.compactionProgress?.(workAttemptId) ?? null);
  }

  /** `ref` is the runtime that the daemon names for the work attempt, when it names one. */
  runtimeCustody(workAttemptId: string, ref?: ProviderRuntimeRef): "absent" | "owned" | "unknown" | undefined {
    guarded("runtimeCustody", "workAttemptId", workAttemptId);
    const state = this.adapter.runtimeCustody?.(workAttemptId, ref ? this.held(ref) : undefined);
    return state === undefined ? undefined : guarded("runtimeCustody", "result", state);
  }

  async describeManagedLaunchContract(input: { apiUrl: string; devMcpServerEntryPath?: string }): Promise<string | null> {
    guarded("describeManagedLaunchContract", "input", input);
    return guarded("describeManagedLaunchContract", "result", await this.required("describeManagedLaunchContract")(input));
  }

  async correlatePermissionTurn(
    ref: ProviderRuntimeRef,
    request: OpenCodeNativePermissionRequest | ClaudeNativePermissionRequest,
    options?: { roomTurnId?: string },
  ): Promise<{ outcome: "correlation_unproven" } | { outcome: "correlated"; providerContinuationId: string; providerTurnId: string }> {
    const handle = this.held(ref);
    guarded("correlatePermissionTurn", "request", request);
    if (options !== undefined) guarded("correlatePermissionTurn", "options", options);
    return guarded("correlatePermissionTurn", "result", await this.required("correlatePermissionTurn")(handle, request, options));
  }

  async inspectPermissionFileChanges(ref: ProviderRuntimeRef, request: CodexNativePermissionRequest): Promise<readonly CodexPermissionFileChange[] | null> {
    const handle = this.held(ref);
    // Checked in place and not copied: the Codex adapter matches this request by object identity.
    guarded("inspectPermissionFileChanges", "request", request);
    return guarded("inspectPermissionFileChanges", "result", await this.required("inspectPermissionFileChanges")(handle, request));
  }

  async inspectPermissionProfile(ref: ProviderRuntimeRef, request: CodexNativePermissionRequest): Promise<Record<string, unknown> | null> {
    const handle = this.held(ref);
    // Checked in place and not copied: the Codex adapter matches this request by object identity.
    guarded("inspectPermissionProfile", "request", request);
    return guarded("inspectPermissionProfile", "result", await this.required("inspectPermissionProfile")(handle, request));
  }

  async inspectPermissionMcpToolCall(ref: ProviderRuntimeRef, request: CodexNativePermissionRequest): Promise<Record<string, unknown> | null> {
    const handle = this.held(ref);
    // Checked in place and not copied: the Codex adapter matches this request by object identity.
    guarded("inspectPermissionMcpToolCall", "request", request);
    return guarded("inspectPermissionMcpToolCall", "result", await this.required("inspectPermissionMcpToolCall")(handle, request));
  }

  async stop(ref: ProviderRuntimeRef, options?: ProviderBoundaryStopOptions): Promise<ProviderTerminalPayload> {
    const handle = this.held(ref);
    this.stopOptions("stop", options);
    return this.terminal("stop", await this.adapter.stop(handle, options));
  }

  /** Stop an exact durable process birth. The runtime needs no reference here: this boundary may never have held it. */
  async stopRef(continuation: ProviderContinuationRef, options?: ProviderBoundaryStopOptions): Promise<ProviderTerminalPayload> {
    this.continuation("stopRef", continuation);
    this.stopOptions("stopRef", options);
    return this.terminal("stopRef", await this.required("stopRef")(continuation, options));
  }

  // The operations below are transitional: see TRANSITIONAL_OPERATIONS.

  controlTurn(ref: ProviderRuntimeRef, correction?: string | null, options?: ProviderTurnControlOptions): Promise<ProviderTurnControlResult> {
    return this.adapter.controlTurn(this.held(ref), correction, options);
  }

  controlExactTurn(ref: ProviderRuntimeRef, options: ProviderExactTurnControlOptions): Promise<ProviderExactTurnControlResult> {
    const handle = this.held(ref);
    return this.required("controlExactTurn")(handle, options);
  }

  runRoomTurn(ref: ProviderRuntimeRef, request: ProviderRoomTurnRequest, options?: ProviderRoomTurnOptions): Promise<ProviderRoomTurnResult> {
    const handle = this.held(ref);
    return this.required("runRoomTurn")(handle, request, options);
  }

  recoverRoomTurn(
    ref: ProviderRuntimeRef,
    request: ProviderRoomTurnRecoveryRequest,
    options?: Pick<ProviderRoomTurnOptions, "detachSignal" | "checkpointProviderState" | "settleLifecycleBeforeIdle" | "checkpointTerminalResult">,
  ): Promise<ProviderRoomTurnResult> {
    const handle = this.held(ref);
    return this.required("recoverRoomTurn")(handle, request, options);
  }

  /**
   * The result names the runtime that holds the conversation after the
   * repair. It is the reference that was given when the adapter kept its
   * handle, and a new reference when the adapter made a new handle.
   */
  async repairContinuation(
    ref: ProviderRuntimeRef,
    request: ProviderContinuationRepairRequest,
    options: { checkpointReplacement: (providerContinuationId: string) => Promise<void>; detachSignal?: AbortSignal },
  ): Promise<ProviderBoundaryRepairResult> {
    const handle = this.held(ref);
    const { handle: repaired, ...result } = await this.required("repairContinuation")(handle, request, options);
    return { ...result, runtime: this.installed("repairContinuation", repaired, ref.workAttemptId) };
  }

  stopIdle(ref: ProviderRuntimeRef, assertCurrent: () => void): Promise<ProviderTerminalPayload> {
    const handle = this.held(ref);
    return this.required("stopIdle")(handle, assertCurrent);
  }

  replyPermission(
    ref: ProviderRuntimeRef,
    request: ProviderNativePermissionRequest,
    reply: "once" | "reject",
    options?: ProviderPermissionDispatchOptions,
  ): Promise<{ outcome: "sent"; scope: "request" } | { outcome: "processed"; nativeScope: "request" | "session_pending" }> {
    const handle = this.held(ref);
    guarded("replyPermission", "request", request);
    guarded("replyPermission", "reply", reply);
    return this.required("replyPermission")(handle, request, reply, options);
  }

  /**
   * Give one adapter event to the sink. The call is synchronous, at the moment
   * of the adapter's own call, as a listener was called before. An error of
   * the sink stays here: it does not go into the adapter's emit path, and it
   * makes no further event.
   */
  private deliver(id: string, body: unknown, handle: ProviderHandle): void {
    const record = this.subscriptions.get(id);
    if (!record || !this.sink) return;
    const base = { subscriptionId: id, ref: record.ref };
    let safe = body;
    let last = false;
    let plain = true;
    try { assertPlainWireValue(body, GUARD); } catch { plain = false; }
    if (record.kind === "exit") {
      // An exit is never dropped. A terminal that is not what the contract says is reported as a protocol error.
      // The replacement has no `nativeRuntimeDeath` and no success cause: malformed data proves no process death.
      if (!plain || !providerTerminalSchema.safeParse(body).success) {
        safe = { endedAt: new Date().toISOString(), exitCode: null, signal: null, terminalCause: "protocol_error", providerContinuationId: handle.providerContinuationId };
      }
      last = true;
    } else if (!plain && record.kind === "permissions") {
      // A permission event must not vanish: the daemon then shows no prompt. It learns that the lane cannot be read.
      safe = { type: "unavailable" };
    } else if (!plain) {
      this.send({ kind: "gap", ...base, seq: ++record.seq, order: ++this.order, body: { dropped: record.kind as "stream" | "execution", count: 1 } });
      return;
    }
    // The record ends here. The adapter's own listener is left as it is: a listener was never removed at its last event before.
    if (last) this.subscriptions.delete(id);
    this.send({ kind: record.kind, ...base, seq: ++record.seq, order: ++this.order, ...(last ? { final: true as const } : {}), body: safe });
  }

  private send(event: ProviderEventEnvelope): void {
    try {
      this.sink?.(event);
    } catch (error) {
      console.warn("[provider_events]", `${this.provider}: the event sink failed for one ${event.kind} event: ${error instanceof Error ? error.message : "error"}`);
    }
  }

  private startHints(operation: string, options: ProviderStartOptions): Pick<ProviderSpawnRequest, "onProgress" | "onNativeStarted"> {
    guarded(operation, "options", options);
    conforming(operation, providerStartOptionsSchema, options);
    const operationId = options.startOperationId;
    if (operationId === undefined) return {};
    const hint = (name: "progress" | "native_started") => () => {
      this.send({ kind: "start", operationId, order: ++this.order, body: { hint: name } });
    };
    return { onProgress: hint("progress"), onNativeStarted: hint("native_started") };
  }

  private required<K extends ProviderBoundaryOperation>(operation: K): NonNullable<SupervisedProviderAdapter[K]> {
    const method = this.adapter[operation];
    if (typeof method !== "function") throw new Error(`Provider '${this.provider}' does not support '${operation}'.`);
    return (method as (...args: unknown[]) => unknown).bind(this.adapter) as NonNullable<SupervisedProviderAdapter[K]>;
  }

  private matches(ref: ProviderRuntimeRef, handle: ProviderHandle): boolean {
    return ref.provider === this.provider && ref.workAttemptId === handle.workAttemptId;
  }

  /** Check a runtime reference as a value, before any of its properties is read. */
  private reference(ref: ProviderRuntimeRef): ProviderRuntimeRef {
    guarded("runtime", "ref", ref);
    return conforming("runtime", providerRuntimeRefSchema, ref);
  }

  private held(ref: ProviderRuntimeRef): ProviderHandle {
    this.reference(ref);
    const handle = this.handles.get(ref.runtimeId);
    if (!handle || !this.matches(ref, handle)) throw new StaleProviderRuntimeRefError();
    return handle;
  }

  private stopOptions(operation: string, options: ProviderBoundaryStopOptions | undefined): void {
    if (options === undefined) return;
    guarded(operation, "options", options);
    conforming(operation, providerStopOptionsSchema, options);
  }

  private continuation(operation: string, continuation: ProviderContinuationRef): void {
    guarded(operation, "ref", continuation);
    conforming(operation, providerContinuationRefSchema, continuation);
  }

  private terminal(operation: string, terminal: ProviderTerminalPayload): ProviderTerminalPayload {
    guarded(operation, "terminal", terminal);
    return conforming(operation, providerTerminalSchema, terminal);
  }

  /** Name a handle that the adapter returned. The same handle object keeps its reference. */
  private installed(operation: string, handle: ProviderHandle, expectedWorkAttemptId?: string): ProviderRuntimeSnapshot {
    if (expectedWorkAttemptId !== undefined && handle.workAttemptId !== expectedWorkAttemptId) {
      throw new ProviderBoundaryValueError(operation, "the runtime belongs to another work attempt");
    }
    let runtimeId = this.runtimeIds.get(handle);
    if (!runtimeId) {
      runtimeId = randomUUID();
      this.runtimeIds.set(handle, runtimeId);
    }
    this.handles.set(runtimeId, handle);
    return this.snapshot(operation, { provider: this.provider, workAttemptId: handle.workAttemptId, runtimeId }, handle);
  }

  private snapshot(operation: string, ref: ProviderRuntimeRef, handle: ProviderHandle): ProviderRuntimeSnapshot {
    const connection = handle.providerConnection;
    const snapshot: ProviderRuntimeSnapshot = {
      ref: { provider: ref.provider, workAttemptId: ref.workAttemptId, runtimeId: ref.runtimeId },
      pid: handle.pid,
      providerContinuationId: handle.providerContinuationId,
      providerConnection: connection ? { ...connection } : null,
      observedState: handle.observedState(),
      ...(handle.lifecycleAuthorityMode ? { lifecycleAuthorityMode: handle.lifecycleAuthorityMode } : {}),
      ...(handle.managedLaunchContract ? { managedLaunchContract: handle.managedLaunchContract } : {}),
      ...(handle.launchNotices?.length ? { launchNotices: [...handle.launchNotices] } : {}),
      ...(handle.ownerSetup === true ? { ownerSetup: true as const } : {}),
    };
    guarded(operation, "runtime", snapshot);
    return conforming(operation, providerRuntimeSnapshotSchema, snapshot);
  }
}
