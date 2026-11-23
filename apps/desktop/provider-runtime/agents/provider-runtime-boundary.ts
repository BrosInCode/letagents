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
// as an envelope. Step 4d-3a moves five operations that waited on functions
// of the daemon: each wait is a `step` envelope, and the daemon answers it
// with data. Step 4d-3b moves the room turn and its recovery the same way,
// and gives the images of a turn as base64 text. No operation takes a callback
// or an AbortSignal of the daemon now; the event sink is the one transport.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { assertPlainWireValue, assertWireBoundarySchema, jsonValueSchema } from "#daemon-contract/wire-boundary.js";
import type { ControlProbeResult, NativeTurnBoundary } from "../../shared/execution-protocol.js";
import type { ClaudeNativePermissionRequest, CodexNativePermissionRequest, CodexPermissionFileChange, OpenCodeNativePermissionRequest } from "../../shared/provider-permissions.js";
import type { ProviderUsage } from "../../shared/provider-usage.js";
import {
  ROOM_TURN_IMAGE_MAX_BYTES, ROOM_TURN_IMAGES_MAX_TOTAL_BYTES, ROOM_TURN_RECENT_IMAGE_LIMIT, ROOM_TURN_RECENT_IMAGES_MAX_BYTES,
} from "./provider-adapter.js";
import type {
  ProviderAdapterCapabilities,
  ProviderContinuationRef,
  ProviderContinuationRepairRequest,
  ProviderContinuationRepairResult,
  ProviderExactTurnControlResult,
  ProviderHandle,
  ProviderNativePermissionRequest,
  ProviderRoomTurnCheckpointDisposition,
  ProviderRoomTurnOptions,
  ProviderRoomTurnRecoveryRequest,
  ProviderRoomTurnRequest,
  ProviderRoomTurnResult,
  ProviderSpawnRequest,
  ProviderTerminalPayload,
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

/** The points where an operation of steps 4d-3a and 4d-3b waits for the daemon. */
export const PROVIDER_STEP_NAMES = [
  "checkpoint_turn_started", "mark_dispatched", "checkpoint_target_turn", "before_native_dispatch",
  "assert_native_dispatch", "assert_current", "checkpoint_replacement",
  "checkpoint_prepared_turn", "checkpoint_provider_state", "settle_lifecycle_before_idle", "mark_durable_turn_started",
  "checkpoint_terminal_result",
] as const;
export type ProviderStepName = (typeof PROVIDER_STEP_NAMES)[number];

/**
 * The fields of a thrown error that the daemon reads. An error crosses the boundary as data: its name, its message
 * and these fields. A field that is not in this list does not cross.
 */
export const PROVIDER_ERROR_FIELDS = [
  "code", "outcome", "turnControlOutcome", "roomTurnRecoveryOutcome", "providerFailureCode", "providerAttachOutcome",
  "transientProviderStartFailure", "providerContinuationId",
] as const;

const errorFieldValue = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);
export const providerErrorDataSchema = z.strictObject({
  name: z.string().max(256),
  message: z.string().max(16_384),
  stack: z.string().max(32_768).optional(),
  fields: z.strictObject(Object.fromEntries(PROVIDER_ERROR_FIELDS.map((field) => [field, errorFieldValue.optional()])) as Record<(typeof PROVIDER_ERROR_FIELDS)[number], z.ZodOptional<typeof errorFieldValue>>),
  /** The error is the daemon's own refusal of this step of the operation, and the adapter did not change it. */
  daemonStep: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
export type ProviderErrorData = z.output<typeof providerErrorDataSchema>;

/** The data form of a thrown value. It reads only the name, the message, the stack and the listed fields. */
export function providerErrorData(error: unknown): ProviderErrorData {
  const source = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const fields: ProviderErrorData["fields"] = {};
  for (const field of PROVIDER_ERROR_FIELDS) {
    const value = source[field];
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) fields[field] = value;
    else if (typeof value === "string") fields[field] = value.slice(0, 4096);
  }
  const text = (value: unknown, fallback: string, max: number) => (typeof value === "string" ? value : fallback).slice(0, max);
  return {
    name: text(source.name, "Error", 256),
    message: text(source.message, typeof error === "string" ? error : "The provider operation failed.", 16_384),
    ...(typeof source.stack === "string" ? { stack: source.stack.slice(0, 32_768) } : {}),
    fields,
  };
}

/** An error with the name, the message and the fields of its data form. */
export function providerErrorFromData(data: ProviderErrorData): Error {
  const error = new Error(data.message);
  // As the name of an error class: not a field that a copy or a comparison of the error sees.
  Object.defineProperty(error, "name", { value: data.name, enumerable: false, writable: true, configurable: true });
  if (data.stack !== undefined) error.stack = data.stack;
  return Object.assign(error, data.fields);
}

const stepIdentifier = z.string().min(1).max(4096);
const publicationContract = z.enum(["structured_room_turn_v1", "legacy_cursor_aggregate_v0"]);
const resultText = z.string().max(16 * 1024 * 1024);
/** A turn that ended with a native failure or interruption: exact native terminal proof. */
const endedTurnFields = {
  turnId: stepIdentifier, providerContinuationId: stepIdentifier, text: z.null(),
  evidence: z.enum(["transcript", "stream"]), error: resultText.optional(), refusal: z.literal(true).optional(),
  unrecognizedResult: z.literal(true).optional(),
  claudeApiFailure: z.strictObject({
    status: z.number().int().nullable(), terminalReason: z.string().max(4096).nullable(), category: z.string().max(4096).nullable(),
    usageLimit: z.literal(true).optional(), promptTooLong: z.literal(true).optional(),
  }).optional(),
  authorityUnproven: z.literal(true).optional(), publicationContract: publicationContract.optional(),
};
/** The result of a room turn, as each adapter returns it. */
export const providerRoomTurnResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ turnId: stepIdentifier, outcome: z.literal("reply"), text: resultText, evidence: z.enum(["transcript", "stream"]).optional(), publicationContract: publicationContract.optional() }),
  z.strictObject({ turnId: stepIdentifier, outcome: z.literal("no_reply"), text: z.null(), evidence: z.enum(["transcript", "stream"]).optional(), publicationContract: publicationContract.optional() }),
  z.strictObject({ ...endedTurnFields, outcome: z.literal("failed") }),
  z.strictObject({ ...endedTurnFields, outcome: z.literal("interrupted") }),
  z.strictObject({ turnId: stepIdentifier, outcome: z.literal("unreadable"), text: z.null(), evidence: z.literal("none").optional(), publicationContract: publicationContract.optional() }),
]);
/** What the daemon recorded for a terminal result: the result it accepts, and whether recovery evidence may go. */
export const providerRoomTurnCheckpointDispositionSchema = z.strictObject({
  acceptedResult: providerRoomTurnResultSchema,
  cleanupRecoveryEvidence: z.boolean(),
});
const providerStateBody = { providerContinuationId: stepIdentifier, providerConnection: providerConnectionRefSchema };

/** The body of each step. A step whose body is not this shape is refused before it reaches the sink. */
export const PROVIDER_STEP_BODY_SCHEMAS = {
  checkpoint_turn_started: z.strictObject({ turnId: stepIdentifier }),
  mark_dispatched: z.null(),
  checkpoint_target_turn: z.strictObject({ turnId: stepIdentifier }),
  before_native_dispatch: z.null(),
  assert_native_dispatch: z.null(),
  assert_current: z.null(),
  checkpoint_replacement: z.strictObject({ providerContinuationId: stepIdentifier }),
  checkpoint_prepared_turn: z.strictObject({ providerTurnId: stepIdentifier, ...providerStateBody }),
  checkpoint_provider_state: z.strictObject(providerStateBody),
  settle_lifecycle_before_idle: z.null(),
  mark_durable_turn_started: z.null(),
  checkpoint_terminal_result: z.strictObject({ result: providerRoomTurnResultSchema }),
} as const satisfies Record<ProviderStepName, z.ZodType>;

/**
 * The body of an answer, for the steps whose answer carries one. An answer with no body is `undefined` for the
 * adapter, not `null` and not `{}`: for a terminal result that means "no disposition", as a callback that returned
 * nothing did before.
 */
export const PROVIDER_STEP_ANSWER_BODY_SCHEMAS = {
  checkpoint_terminal_result: providerRoomTurnCheckpointDispositionSchema,
} as const satisfies Partial<Record<ProviderStepName, z.ZodType>>;

/** The steps of a room turn. The daemon names the steps that it answers; the adapter sees no function for the others. */
export const ROOM_TURN_STEP_NAMES = [
  "before_native_dispatch", "checkpoint_turn_started", "checkpoint_prepared_turn", "checkpoint_provider_state",
  "settle_lifecycle_before_idle", "mark_durable_turn_started", "checkpoint_terminal_result",
] as const satisfies readonly ProviderStepName[];
export const ROOM_TURN_RECOVERY_STEP_NAMES = [
  "checkpoint_provider_state", "settle_lifecycle_before_idle", "checkpoint_terminal_result",
] as const satisfies readonly ProviderStepName[];

export const providerStepAnswerSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), body: jsonValueSchema.optional() }),
  z.strictObject({ ok: z.literal(false), error: providerErrorDataSchema }),
]);
export type ProviderStepAnswer = z.output<typeof providerStepAnswerSchema>;

/** Names one call of an operation that has steps. The daemon makes the id. */
export const providerOperationOptionsSchema = z.strictObject({
  operationId: boundedText,
  /** The daemon's observation was ended before the call. The operation starts as after `detachOperation`. */
  detached: z.literal(true).optional(),
});
export const providerTurnControlOptionsSchema = z.strictObject({
  operationId: boundedText,
  targetTurnId: z.string().nullable().optional(),
  detached: z.literal(true).optional(),
});
export const providerPermissionReplyOptionsSchema = z.strictObject({ operationId: boundedText, expectedFileChanges: jsonValueSchema.optional() });
export const providerRoomTurnOptionsSchema = z.strictObject({
  operationId: boundedText,
  detached: z.literal(true).optional(),
  steps: z.array(z.enum(ROOM_TURN_STEP_NAMES)).max(ROOM_TURN_STEP_NAMES.length),
});
export const providerRoomTurnRecoveryOptionsSchema = z.strictObject({
  operationId: boundedText,
  detached: z.literal(true).optional(),
  steps: z.array(z.enum(ROOM_TURN_RECOVERY_STEP_NAMES)).max(ROOM_TURN_RECOVERY_STEP_NAMES.length),
});
export type ProviderRoomTurnBoundaryOptions = z.output<typeof providerRoomTurnOptionsSchema>;
export type ProviderRoomTurnRecoveryBoundaryOptions = z.output<typeof providerRoomTurnRecoveryOptionsSchema>;

const ROOM_TURN_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The number of bytes that a base64 text holds, or null when the text is not base64. */
function base64Bytes(text: string): number | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return text.length / 4 * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0);
}
/** The name of a permission request in place of the request: a token of a permission event. */
export const providerPermissionTokenSchema = z.strictObject({ token: boundedText });
export type ProviderPermissionToken = z.output<typeof providerPermissionTokenSchema>;

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
    /**
     * Permissions only: one token for each request of a `snapshot`, in the order of `body.requests`, or the one
     * token of the request of a `request_closed`. A token names the request in the permission operations.
     */
    permissionTokens: z.array(boundedText).optional(),
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
  // An operation waits for the daemon. The daemon answers with `answerStep`, and names the operation and `seq`.
  z.strictObject({
    kind: z.literal("step"),
    operationId: boundedText,
    ref: providerRuntimeRefSchema,
    step: z.enum(PROVIDER_STEP_NAMES),
    /** Counts the steps of this operation from 1. One step is open at a time. */
    seq: eventCounter,
    order: eventCounter,
    /** The answer must come inside the delivery of this envelope. No answer is a refusal. */
    sync: z.literal(true).optional(),
    body: jsonValueSchema,
  }),
]);
export type ProviderEventEnvelope =
  | { kind: ProviderEventKind; subscriptionId: string; ref: ProviderRuntimeRef; seq: number; order: number; final?: true; permissionTokens?: string[]; body: unknown }
  | { kind: "gap"; subscriptionId: string; ref: ProviderRuntimeRef; seq: number; order: number; body: { dropped: "stream" | "execution"; count: number } }
  | { kind: "start"; operationId: string; order: number; body: { hint: "progress" | "native_started" } }
  | { kind: "step"; operationId: string; ref: ProviderRuntimeRef; step: ProviderStepName; seq: number; order: number; sync?: true; body: unknown };

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

/** The schemas of the values that steps 4d-1, 4d-2 and 4d-3a moved. Each one meets the shared wire rule of the RPC contract. */
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
  providerErrorData: providerErrorDataSchema,
  providerStepAnswer: providerStepAnswerSchema,
  providerOperationOptions: providerOperationOptionsSchema,
  providerTurnControlOptions: providerTurnControlOptionsSchema,
  providerPermissionReplyOptions: providerPermissionReplyOptionsSchema,
  providerPermissionToken: providerPermissionTokenSchema,
  providerRoomTurnOptions: providerRoomTurnOptionsSchema,
  providerRoomTurnRecoveryOptions: providerRoomTurnRecoveryOptionsSchema,
  providerRoomTurnResult: providerRoomTurnResultSchema,
  providerRoomTurnCheckpointDisposition: providerRoomTurnCheckpointDispositionSchema,
  ...Object.fromEntries(Object.entries(PROVIDER_STEP_BODY_SCHEMAS).map(([step, schema]) => [`providerStepBody:${step}`, schema])),
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
  "controlTurn", "controlExactTurn", "repairContinuation", "acknowledgeRepairNotices", "stopIdle", "replyPermission",
  "runRoomTurn", "recoverRoomTurn", "answerStep", "detachOperation",
] as const;

/**
 * The steps of each operation of steps 4d-3a and 4d-3b. A step with `sync` is a check that the daemon answers inside
 * the delivery of the envelope, on the same stack: the adapter's next line runs only after the answer. That works
 * because the sink is called in the same process and on the same stack. A transport between processes cannot answer
 * in the same call: it needs a fence value that the adapter can compare itself. That part of the contract is not
 * process-neutral yet.
 */
export const OPERATION_STEPS = {
  controlTurn: ["checkpoint_turn_started", "mark_dispatched"],
  controlExactTurn: ["checkpoint_target_turn", "mark_dispatched"],
  repairContinuation: ["checkpoint_replacement"],
  stopIdle: ["assert_current (sync)"],
  replyPermission: ["before_native_dispatch", "assert_native_dispatch (sync)"],
  runRoomTurn: [
    "before_native_dispatch", "checkpoint_turn_started", "checkpoint_prepared_turn", "checkpoint_provider_state",
    "settle_lifecycle_before_idle", "mark_durable_turn_started (sync)", "checkpoint_terminal_result",
  ],
  recoverRoomTurn: ["checkpoint_provider_state", "settle_lifecycle_before_idle", "checkpoint_terminal_result"],
} as const;

/** The one place where the daemon gives the boundary a function: the transport for events. */
export const TRANSPORT_OPERATIONS = ["connectEventSink"] as const;


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
export type ProviderBoundaryRepairResult = Omit<ProviderContinuationRepairResult, "handle" | "noticesRecorded"> & {
  runtime: ProviderRuntimeSnapshot;
  /** The adapter waits to hear that its lines are recorded. The daemon says so with `acknowledgeRepairNotices`. */
  noticesAwaitAcknowledgement: boolean;
};
export type ProviderPermissionRequestName = ProviderNativePermissionRequest | ProviderPermissionToken;

/** The operation is not open, or the step is not the one that waits. Nothing was dispatched. */
export class ProviderStepRefusedError extends Error {
  readonly code = "PROVIDER_STEP_REFUSED";
  constructor(detail: string) {
    super(`Provider operation step was refused: ${detail}`);
    this.name = "ProviderStepRefusedError";
  }
}

type OpenOperation = {
  ref: ProviderRuntimeRef;
  seq: number;
  /** The step that waits now. */
  open: { seq: number; sync: boolean; answer?: ProviderStepAnswer; closed?: true; settle?: (answer: ProviderStepAnswer) => void } | null;
  detach: AbortController;
  /**
   * A detach refuses the steps of this operation: a step that waits, and each later step. A room turn sets this to
   * false: its detach ends only the adapter's own signal, and its steps still reach the daemon, which decides each one
   * (an admitted turn must still record its recovery key while a handoff drains the daemon).
   */
  detachRefusesSteps: boolean;
  /** The errors that this boundary threw into the adapter for a refused step, by step. */
  refusals: WeakMap<object, number>;
};
export type ProviderBoundaryOperation = keyof SupervisedProviderAdapter;

const GUARD = { allowUndefinedProperties: true } as const;
/** The adapter's permission events, and the one event that reports the end of the adapter's observation call. */
const PERMISSION_EVENT_TYPES = new Set(["snapshot", "request_closed", "degraded", "unavailable", "settled"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * True when a plain permission event has the fields that the daemon reads from it. The check reads the event; it
 * makes no copy, so a valid request stays the adapter's own object.
 */
function knownPermissionEvent(body: unknown): boolean {
  if (!isRecord(body) || typeof body.type !== "string" || !PERMISSION_EVENT_TYPES.has(body.type)) return false;
  if (body.type === "snapshot") {
    return (body.connectionId === undefined || typeof body.connectionId === "string")
      && Array.isArray(body.requests) && body.requests.every(isRecord);
  }
  if (body.type === "request_closed") return isRecord(body.request);
  if (body.type === "settled") return body.outcome === "ended" || body.outcome === "failed";
  return true;
}

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

/**
 * Check a room turn request: plain data, and each image within the limits of a turn, counted in bytes of the image
 * and not of its base64 text. An error names the attachment and the rule, never the image.
 */
function roomTurnRequest(request: ProviderRoomTurnRequest): void {
  guarded("runRoomTurn", "request", request);
  const refuse = (index: number, detail: string) => {
    throw new ProviderBoundaryValueError("runRoomTurn", `request.attachments.${index}.image: ${detail}`);
  };
  let total = 0;
  let recentCount = 0;
  let recentBytes = 0;
  (request.attachments ?? []).forEach((attachment, index) => {
    const image = attachment.image;
    if (image === undefined) return;
    if (attachment.status !== "image") refuse(index, "only an included image has an image");
    if (!(ROOM_TURN_IMAGE_MIME_TYPES as readonly string[]).includes(image.mimeType)) refuse(index, "the image type is not supported");
    if (image.base64 !== undefined && image.path !== undefined) refuse(index, "an image is base64 text or a file, not both");
    if (image.base64 === undefined) {
      if (typeof image.path !== "string" || image.path.length === 0 || image.path.length > 4096) refuse(index, "an image needs base64 text or a file");
      return;
    }
    const bytes = typeof image.base64 === "string" ? base64Bytes(image.base64) : null;
    if (bytes === null) return refuse(index, "the image is not base64 text");
    if (bytes === 0) refuse(index, "the image is empty");
    if (bytes > ROOM_TURN_IMAGE_MAX_BYTES) refuse(index, "the image is larger than the limit of one image");
    total += bytes;
    if (total > ROOM_TURN_IMAGES_MAX_TOTAL_BYTES) refuse(index, "the images are larger than the limit of a turn");
    if (attachment.origin !== undefined) {
      recentCount += 1;
      recentBytes += bytes;
      if (recentCount > ROOM_TURN_RECENT_IMAGE_LIMIT) refuse(index, "more images from recent messages than a turn takes");
      if (recentBytes > ROOM_TURN_RECENT_IMAGES_MAX_BYTES) refuse(index, "the images from recent messages are larger than their limit");
    }
  });
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
  private readonly openOperations = new Map<string, OpenOperation>();
  private readonly repairNotices = new Map<string, { runtimeId: string; recorded: () => void }>();
  /** The permission requests that the latest events named, for each runtime. A token dies with its request. */
  private readonly permissionTokens = new Map<string, { runtimeId: string; authority: string; request: object }>();

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
    // Each callback is bound to this record, not to the id: an id can be used again after its subscription ended,
    // and a late call of an old callback must not arrive under the new subscription.
    const receive = (body: unknown) => this.deliver(id, record, body, handle);
    let result: ProviderSubscription = { subscriptionId: id };
    let end: () => void;
    try {
      if (kind === "exit") {
        end = this.adapter.onExit(handle, receive);
      } else if (kind === "stream") {
        end = this.adapter.onStream(handle, receive);
      } else if (kind === "execution") {
        const subscription = this.required("onExecution")(handle, receive);
        end = () => subscription.dispose();
        try {
          result = { subscriptionId: id, sourceId: guarded("subscribe", "sourceId", subscription.sourceId) };
        } catch (error) {
          subscription.dispose();
          throw error;
        }
        record.position = () => subscription.position();
      } else {
        const controller = new AbortController();
        end = () => controller.abort();
        // The adapter's promise is reported as one event, so nothing but data comes back. It does not end the
        // subscription: an adapter may call the listener after its promise settled, and only the daemon ends it.
        void this.required("observePermissions")(handle, receive, controller.signal).then(
          () => receive({ type: "settled", outcome: "ended" }),
          (error: unknown) => receive({ type: "settled", outcome: "failed", message: error instanceof Error ? error.message : "failed" }),
        );
      }
    } catch (error) {
      if (this.subscriptions.get(id) === record) this.subscriptions.delete(id);
      throw error;
    }
    record.end = end;
    // The subscription can have ended inside the adapter's call: the daemon ended it during a replay, or its
    // final event arrived at once. The adapter's listener is removed here, because nothing else can do it later.
    if (this.subscriptions.get(id) !== record) {
      try { end(); } catch { /* the adapter already removed it */ }
    }
    return result;
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
    for (const [token, entry] of this.permissionTokens) if (entry.runtimeId === ref.runtimeId) this.permissionTokens.delete(token);
    for (const [id, entry] of this.repairNotices) if (entry.runtimeId === ref.runtimeId) this.repairNotices.delete(id);
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

  async inspectPermissionFileChanges(ref: ProviderRuntimeRef, request: CodexNativePermissionRequest | ProviderPermissionToken): Promise<readonly CodexPermissionFileChange[] | null> {
    const handle = this.held(ref);
    const native = this.permissionRequest("inspectPermissionFileChanges", ref, request) as CodexNativePermissionRequest;
    return guarded("inspectPermissionFileChanges", "result", await this.required("inspectPermissionFileChanges")(handle, native));
  }

  async inspectPermissionProfile(ref: ProviderRuntimeRef, request: CodexNativePermissionRequest | ProviderPermissionToken): Promise<Record<string, unknown> | null> {
    const handle = this.held(ref);
    const native = this.permissionRequest("inspectPermissionProfile", ref, request) as CodexNativePermissionRequest;
    return guarded("inspectPermissionProfile", "result", await this.required("inspectPermissionProfile")(handle, native));
  }

  async inspectPermissionMcpToolCall(ref: ProviderRuntimeRef, request: CodexNativePermissionRequest | ProviderPermissionToken): Promise<Record<string, unknown> | null> {
    const handle = this.held(ref);
    const native = this.permissionRequest("inspectPermissionMcpToolCall", ref, request) as CodexNativePermissionRequest;
    return guarded("inspectPermissionMcpToolCall", "result", await this.required("inspectPermissionMcpToolCall")(handle, native));
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

  // The operations below have steps: see OPERATION_STEPS. Each waits for the daemon with a `step` envelope.

  /**
   * Run one room turn. The adapter gets a function only for each step that `options.steps` names; for another step
   * it sees none, as when the daemon left a callback out before. An adapter decides on that presence.
   *
   * A detach ends the adapter's own signal and nothing else: the steps still reach the daemon, as the callbacks did
   * before. The daemon decides each step. An admitted turn whose native start answers after a detach must still
   * record its exact turn id, and a checkpoint that runs when the detach comes is joined, not cut off.
   */
  async runRoomTurn(ref: ProviderRuntimeRef, request: ProviderRoomTurnRequest, options: ProviderRoomTurnBoundaryOptions): Promise<ProviderRoomTurnResult> {
    const handle = this.held(ref);
    roomTurnRequest(request);
    conforming("runRoomTurn", providerRoomTurnOptionsSchema, guarded("runRoomTurn", "options", options));
    const run = this.required("runRoomTurn");
    const steps = new Set<string>(options.steps);
    return this.operation("runRoomTurn", ref, options.operationId, options.detached === true, async (operation, record) => this.roomTurnResult("runRoomTurn",
      await run(handle, request, {
        ...this.roomTurnSteps(operation, steps),
        ...(steps.has("before_native_dispatch") ? { beforeNativeDispatch: async () => { await this.step(operation, "before_native_dispatch", null); } } : {}),
        ...(steps.has("checkpoint_turn_started") ? { checkpointTurnStarted: async (turnId: string) => { await this.step(operation, "checkpoint_turn_started", { turnId }); } } : {}),
        ...(steps.has("checkpoint_prepared_turn") ? {
          checkpointPreparedTurn: async (state: Parameters<NonNullable<ProviderRoomTurnOptions["checkpointPreparedTurn"]>>[0]) => {
            await this.step(operation, "checkpoint_prepared_turn", {
              providerTurnId: state.providerTurnId, providerContinuationId: state.providerContinuationId, providerConnection: state.providerConnection,
            });
          },
        } : {}),
        ...(steps.has("mark_durable_turn_started") ? { markDurableTurnStarted: () => { this.check(operation, "mark_durable_turn_started", null); } } : {}),
        detachSignal: record.detach.signal,
      })), false);
  }

  /** Recover one persisted native turn. The steps work as for `runRoomTurn`. */
  async recoverRoomTurn(ref: ProviderRuntimeRef, request: ProviderRoomTurnRecoveryRequest, options: ProviderRoomTurnRecoveryBoundaryOptions): Promise<ProviderRoomTurnResult> {
    const handle = this.held(ref);
    guarded("recoverRoomTurn", "request", request);
    conforming("recoverRoomTurn", providerRoomTurnRecoveryOptionsSchema, guarded("recoverRoomTurn", "options", options));
    const run = this.required("recoverRoomTurn");
    const steps = new Set<string>(options.steps);
    return this.operation("recoverRoomTurn", ref, options.operationId, options.detached === true, async (operation, record) => this.roomTurnResult("recoverRoomTurn",
      await run(handle, request, { ...this.roomTurnSteps(operation, steps), detachSignal: record.detach.signal })), false);
  }

  /** The functions of the steps that a turn and its recovery share. */
  private roomTurnSteps(operation: string, steps: ReadonlySet<string>): Pick<ProviderRoomTurnOptions, "checkpointProviderState" | "settleLifecycleBeforeIdle" | "checkpointTerminalResult"> {
    return {
      ...(steps.has("checkpoint_provider_state") ? {
        checkpointProviderState: async (state: Parameters<NonNullable<ProviderRoomTurnOptions["checkpointProviderState"]>>[0]) => {
          await this.step(operation, "checkpoint_provider_state", { providerContinuationId: state.providerContinuationId, providerConnection: state.providerConnection });
        },
      } : {}),
      ...(steps.has("settle_lifecycle_before_idle") ? { settleLifecycleBeforeIdle: async () => { await this.step(operation, "settle_lifecycle_before_idle", null); } } : {}),
      ...(steps.has("checkpoint_terminal_result") ? {
        checkpointTerminalResult: async (result: ProviderRoomTurnResult) =>
          await this.step(operation, "checkpoint_terminal_result", { result }) as ProviderRoomTurnCheckpointDisposition | undefined,
      } : {}),
    };
  }

  private roomTurnResult(operation: string, result: ProviderRoomTurnResult): ProviderRoomTurnResult {
    guarded(operation, "result", result);
    conforming(operation, providerRoomTurnResultSchema, result);
    return result;
  }

  async controlTurn(ref: ProviderRuntimeRef, correction: string | null | undefined, options: { operationId: string; targetTurnId?: string | null }): Promise<ProviderTurnControlResult> {
    const handle = this.held(ref);
    if (correction !== undefined) guarded("controlTurn", "correction", correction);
    conforming("controlTurn", providerTurnControlOptionsSchema, guarded("controlTurn", "options", options));
    return this.operation("controlTurn", ref, options.operationId, false, async (operation) => guarded("controlTurn", "result",
      await this.adapter.controlTurn(handle, correction, {
        targetTurnId: options.targetTurnId,
        checkpointTurnStarted: async (turnId) => { await this.step(operation, "checkpoint_turn_started", { turnId }); },
        markDispatched: async () => { await this.step(operation, "mark_dispatched", null); },
      })));
  }

  async controlExactTurn(ref: ProviderRuntimeRef, options: { operationId: string; targetTurnId?: string | null; detached?: true }): Promise<ProviderExactTurnControlResult> {
    const handle = this.held(ref);
    conforming("controlExactTurn", providerTurnControlOptionsSchema, guarded("controlExactTurn", "options", options));
    const run = this.required("controlExactTurn");
    return this.operation("controlExactTurn", ref, options.operationId, options.detached === true, async (operation, record) => guarded("controlExactTurn", "result",
      await run(handle, {
        targetTurnId: options.targetTurnId,
        checkpointTargetTurn: async (turnId) => { await this.step(operation, "checkpoint_target_turn", { turnId }); },
        markDispatched: async () => { await this.step(operation, "mark_dispatched", null); },
        detachSignal: record.detach.signal,
      })));
  }

  /**
   * The result names the runtime that holds the conversation after the
   * repair. It is the reference that was given when the adapter kept its
   * handle, and a new reference when the adapter made a new handle.
   */
  async repairContinuation(ref: ProviderRuntimeRef, request: ProviderContinuationRepairRequest, options: { operationId: string; detached?: true }): Promise<ProviderBoundaryRepairResult> {
    const handle = this.held(ref);
    guarded("repairContinuation", "request", request);
    conforming("repairContinuation", providerOperationOptionsSchema, guarded("repairContinuation", "options", options));
    const run = this.required("repairContinuation");
    return this.operation("repairContinuation", ref, options.operationId, options.detached === true, async (operation, record) => {
      const { handle: repaired, noticesRecorded, ...result } = await run(handle, request, {
        checkpointReplacement: async (providerContinuationId) => { await this.step(operation, "checkpoint_replacement", { providerContinuationId }); },
        detachSignal: record.detach.signal,
      });
      guarded("repairContinuation", "result", result);
      const runtime = this.installed("repairContinuation", repaired, ref.workAttemptId);
      if (typeof noticesRecorded === "function") this.repairNotices.set(operation, { runtimeId: runtime.ref.runtimeId, recorded: noticesRecorded });
      return { ...result, runtime, noticesAwaitAcknowledgement: typeof noticesRecorded === "function" };
    });
  }

  /** The lines of a repair are recorded. One time for each repair; a second call, or an unknown id, does nothing. */
  acknowledgeRepairNotices(operationId: string): void {
    guarded("acknowledgeRepairNotices", "operationId", operationId);
    const entry = this.repairNotices.get(operationId);
    this.repairNotices.delete(operationId);
    entry?.recorded();
  }

  async stopIdle(ref: ProviderRuntimeRef, options: { operationId: string }): Promise<ProviderTerminalPayload> {
    const handle = this.held(ref);
    conforming("stopIdle", providerOperationOptionsSchema, guarded("stopIdle", "options", options));
    const run = this.required("stopIdle");
    return this.operation("stopIdle", ref, options.operationId, false, async (operation) =>
      this.terminal("stopIdle", await run(handle, () => { this.check(operation, "assert_current", null); })));
  }

  async replyPermission(
    ref: ProviderRuntimeRef,
    request: ProviderPermissionRequestName,
    reply: "once" | "reject",
    options: { operationId: string; expectedFileChanges?: readonly CodexPermissionFileChange[] },
  ): Promise<{ outcome: "sent"; scope: "request" } | { outcome: "processed"; nativeScope: "request" | "session_pending" }> {
    const handle = this.held(ref);
    const native = this.permissionRequest("replyPermission", ref, request);
    guarded("replyPermission", "reply", reply);
    conforming("replyPermission", providerPermissionReplyOptionsSchema, guarded("replyPermission", "options", options));
    const run = this.required("replyPermission");
    return this.operation("replyPermission", ref, options.operationId, false, async (operation) => guarded("replyPermission", "result",
      await run(handle, native, reply, {
        expectedFileChanges: options.expectedFileChanges,
        beforeNativeDispatch: async () => { await this.step(operation, "before_native_dispatch", null); },
        assertNativeDispatch: () => { this.check(operation, "assert_native_dispatch", null); },
      })));
  }

  /**
   * Answer the step that waits. Only the open step of an open operation takes an answer: a second answer, an answer
   * for another step, and an answer after the end of the operation are refused with ProviderStepRefusedError.
   */
  answerStep(operationId: string, seq: number, answer: ProviderStepAnswer): void {
    guarded("answerStep", "operationId", operationId);
    guarded("answerStep", "seq", seq);
    conforming("answerStep", providerStepAnswerSchema, guarded("answerStep", "answer", answer));
    const open = this.openOperations.get(operationId)?.open;
    if (!open || open.seq !== seq || open.answer !== undefined || open.closed) throw new ProviderStepRefusedError("no step with this number waits");
    open.answer = answer;
    open.settle?.(answer);
  }

  /**
   * End the daemon's observation of an operation. The native work of the provider is not interrupted. A step that
   * waits ends with a refusal, so the adapter dispatches nothing for it. An unknown id does nothing.
   * Room turns (`runRoomTurn` and `recoverRoomTurn`) are the exception: their steps stay open after a detach, because
   * the daemon must still record what the provider already did (for example a turn that started). Only the adapter's
   * `detachSignal` fires for them.
   */
  detachOperation(operationId: string): void {
    guarded("detachOperation", "operationId", operationId);
    const record = this.openOperations.get(operationId);
    if (!record) return;
    record.detach.abort();
    const open = record.open;
    if (record.detachRefusesSteps && open && !open.sync && open.answer === undefined) {
      open.answer = this.refusal("the operation was detached");
      open.settle?.(open.answer);
    }
  }

  /** Run one operation that has steps. An error leaves as its data form, built again as an error. */
  private async operation<T>(
    name: string, ref: ProviderRuntimeRef, operationId: string, detached: boolean,
    run: (operationId: string, record: OpenOperation) => Promise<T>, detachRefusesSteps = true,
  ): Promise<T> {
    if (this.openOperations.has(operationId)) throw new ProviderBoundaryValueError(name, "the operation id is in use");
    const record: OpenOperation = {
      ref: { provider: ref.provider, workAttemptId: ref.workAttemptId, runtimeId: ref.runtimeId },
      seq: 0, open: null, detach: new AbortController(), detachRefusesSteps, refusals: new WeakMap(),
    };
    if (detached) record.detach.abort();
    this.openOperations.set(operationId, record);
    try {
      return await run(operationId, record);
    } catch (error) {
      if (error instanceof ProviderBoundaryValueError) throw error;
      const data = providerErrorData(error);
      const daemonStep = typeof error === "object" && error !== null ? record.refusals.get(error) : undefined;
      throw Object.assign(providerErrorFromData(data), daemonStep === undefined ? {} : { daemonStep });
    } finally {
      this.openOperations.delete(operationId);
    }
  }

  /**
   * Wait for the daemon at one step. Returns the body of the answer. A refusal is thrown into the adapter.
   * A delivery that failed is a refusal, also when the sink answered before it failed.
   */
  private async step(operationId: string, step: ProviderStepName, body: unknown): Promise<unknown> {
    const { record, open } = this.openStep(operationId, step, body, false);
    const answered = new Promise<ProviderStepAnswer>((resolve) => { open.settle = resolve; });
    if (record.detach.signal.aborted && record.detachRefusesSteps) open.answer = this.refusal("the operation was detached");
    else if (!this.sendStep(operationId, record, step, open, body)) open.answer = this.refusal("the event sink did not take the step");
    const answer = open.answer ?? await answered;
    record.open = null;
    return this.answered(record, open.seq, answer, step);
  }

  /**
   * Ask the daemon at one step and read its answer when the sink returns. No answer is a refusal, and so is a
   * delivery that failed, also when the sink answered before it failed.
   */
  private check(operationId: string, step: ProviderStepName, body: unknown): void {
    const { record, open } = this.openStep(operationId, step, body, true);
    const delivered = !(record.detach.signal.aborted && record.detachRefusesSteps) && this.sendStep(operationId, record, step, open, body);
    const answer = delivered && open.answer ? open.answer : this.refusal(delivered ? "the check got no answer" : "the event sink did not take the check");
    // A later answer finds no open step.
    record.open = null;
    this.answered(record, open.seq, answer, step);
  }

  private refusal(detail: string): ProviderStepAnswer {
    return { ok: false, error: providerErrorData(new ProviderStepRefusedError(detail)) };
  }

  private openStep(operationId: string, step: ProviderStepName, body: unknown, sync: boolean): { record: OpenOperation; open: NonNullable<OpenOperation["open"]> } {
    const record = this.openOperations.get(operationId);
    if (!record) throw new ProviderStepRefusedError("the operation has ended");
    if (record.open) throw new ProviderStepRefusedError("another step of the operation waits");
    // The adapter's value for the step is checked before a step is open: a value that is not data makes no envelope.
    conforming(`step ${step}`, PROVIDER_STEP_BODY_SCHEMAS[step], guarded(`step ${step}`, "body", body));
    const open = { seq: ++record.seq, sync };
    record.open = open;
    return { record, open };
  }

  private sendStep(operationId: string, record: OpenOperation, step: ProviderStepName, open: NonNullable<OpenOperation["open"]>, body: unknown): boolean {
    if (!this.sink) return false;
    try {
      this.sink({ kind: "step", operationId, ref: record.ref, step, seq: open.seq, order: ++this.order, ...(open.sync ? { sync: true as const } : {}), body });
      return true;
    } catch (error) {
      // An answer that the sink gave before it failed does not count, and no answer can come later.
      open.closed = true;
      console.warn("[provider_events]", `${this.provider}: the event sink failed for the step '${step}': ${error instanceof Error ? error.message : "error"}`);
      return false;
    }
  }

  /**
   * The body of an answer, or a refusal thrown into the adapter. An answer with no body gives `undefined`. A step
   * whose answer has a body checks it with its schema; a step whose answer has no body ignores one.
   */
  private answered(record: OpenOperation, seq: number, answer: ProviderStepAnswer, step: ProviderStepName): unknown {
    if (answer.ok) {
      const schema = (PROVIDER_STEP_ANSWER_BODY_SCHEMAS as Partial<Record<ProviderStepName, z.ZodType>>)[step];
      if (!schema || answer.body === undefined) return undefined;
      return conforming(`answer of step ${step}`, schema, answer.body);
    }
    const refusal = providerErrorFromData(answer.error);
    record.refusals.set(refusal, seq);
    throw refusal;
  }

  /**
   * The request that a permission operation names. A token must be of this runtime, its request must still be open,
   * and the native connection must be the one that reported the request. A request object is checked in place and
   * not copied: the Codex adapter matches it by object identity.
   */
  private permissionRequest(operation: string, ref: ProviderRuntimeRef, request: ProviderPermissionRequestName): ProviderNativePermissionRequest {
    guarded(operation, "request", request);
    const named: unknown = request;
    if (!isRecord(named) || typeof named.token !== "string" || Object.keys(named).length !== 1) return request as ProviderNativePermissionRequest;
    const entry = this.permissionTokens.get(named.token);
    const handle = this.handles.get(ref.runtimeId);
    if (!entry || !handle || entry.runtimeId !== ref.runtimeId || entry.authority.split("\n")[0] !== this.connectionKey(handle)) {
      throw Object.assign(new Error("The permission request of this token is not open on this runtime."), { outcome: "not_dispatched" });
    }
    // Codex matches its request by object identity. The other providers match by value, and they get a copy, as
    // they did before there were tokens: an adapter must not depend on the identity of what the boundary holds.
    return (this.provider === "codex" ? entry.request : structuredClone(entry.request)) as ProviderNativePermissionRequest;
  }

  /** The identity of the native process and connection of a runtime, as one text. */
  private connectionKey(handle: ProviderHandle): string {
    const connection = handle.providerConnection;
    return JSON.stringify(connection ? [connection.kind, "url" in connection ? connection.url : null, connection.pid, connection.processIdentity ?? null] : null);
  }

  /**
   * The tokens of a permission event. A request keeps its token while it stays open under the same authority: the
   * same object, or for a provider that lists its requests again, an equal value. The authority is the native
   * connection of the runtime and the connection id of the snapshot. A closed request, and a request that a
   * snapshot no longer has, lose their token. All tokens of the runtime end when the authority changes, and when
   * the lane reports that it cannot be read (`unavailable`, `degraded`, or an event that was not valid). A request
   * that is reported after that gets a new token. A new request never gets an old token.
   */
  private tokensOf(runtimeId: string, handle: ProviderHandle, body: unknown): string[] | undefined {
    if (!isRecord(body)) return undefined;
    const live = [...this.permissionTokens].filter(([, entry]) => entry.runtimeId === runtimeId);
    const retire = () => { for (const [token] of live) this.permissionTokens.delete(token); };
    if (body.type === "unavailable" || body.type === "degraded") { retire(); return undefined; }
    if (body.type !== "snapshot" && body.type !== "request_closed") return undefined;
    const tokenOf = (request: object, taken: Set<string>): string | undefined =>
      live.find(([token, entry]) => !taken.has(token) && entry.request === request)?.[0]
      ?? (this.provider === "codex" ? undefined : live.find(([token, entry]) => !taken.has(token) && isDeepStrictEqual(entry.request, request))?.[0]);
    if (body.type === "request_closed") {
      const token = tokenOf(body.request as object, new Set());
      if (token) this.permissionTokens.delete(token);
      return token ? [token] : [];
    }
    const authority = `${this.connectionKey(handle)}\n${typeof body.connectionId === "string" ? body.connectionId : ""}`;
    if (live.some(([, entry]) => entry.authority !== authority)) { retire(); live.length = 0; }
    const taken = new Set<string>();
    const tokens = (body.requests as object[]).map((request) => {
      const token = tokenOf(request, taken) ?? randomUUID();
      taken.add(token);
      this.permissionTokens.set(token, { runtimeId, authority, request });
      return token;
    });
    for (const [token] of live) if (!taken.has(token)) this.permissionTokens.delete(token);
    return tokens;
  }

  /**
   * Give one adapter event to the sink. The call is synchronous, at the moment
   * of the adapter's own call, as a listener was called before. An error of
   * the sink stays here: it does not go into the adapter's emit path, and it
   * makes no further event.
   */
  private deliver(id: string, record: NonNullable<ReturnType<typeof this.subscriptions.get>>, body: unknown, handle: ProviderHandle): void {
    if (this.subscriptions.get(id) !== record || !this.sink) return;
    const base = { subscriptionId: id, ref: record.ref };
    let safe = body;
    let last = false;
    let plain = true;
    let tokens: string[] | undefined;
    try { assertPlainWireValue(body, GUARD); } catch { plain = false; }
    if (record.kind === "exit") {
      // An exit is never dropped. A terminal that is not what the contract says is reported as a protocol error.
      // The replacement has no `nativeRuntimeDeath` and no success cause: malformed data proves no process death.
      if (!plain || !providerTerminalSchema.safeParse(body).success) {
        safe = { endedAt: new Date().toISOString(), exitCode: null, signal: null, terminalCause: "protocol_error",
          providerContinuationId: typeof handle.providerContinuationId === "string" ? handle.providerContinuationId : null };
      }
      last = true;
    } else if (record.kind === "permissions") {
      // A permission event must not vanish: the daemon then shows no prompt. For an event that is not plain data,
      // or that is not one of the known events with the fields that the daemon reads, it learns that the lane cannot be read.
      if (!plain || !knownPermissionEvent(body)) safe = { type: "unavailable" };
      tokens = this.tokensOf(record.ref.runtimeId, handle, safe);
    } else if (!plain) {
      this.send({ kind: "gap", ...base, seq: ++record.seq, order: ++this.order, body: { dropped: record.kind as "stream" | "execution", count: 1 } });
      return;
    }
    // The record ends here. The adapter's own listener is left as it is: a listener was never removed at its last event before.
    if (last) this.subscriptions.delete(id);
    this.send({ kind: record.kind, ...base, seq: ++record.seq, order: ++this.order, ...(last ? { final: true as const } : {}), ...(tokens ? { permissionTokens: tokens } : {}), body: safe });
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
