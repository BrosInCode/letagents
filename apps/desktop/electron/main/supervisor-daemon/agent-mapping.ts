import { z } from "zod";
import { inspectorUsageSchema } from "../agents/provider-usage.js";
import type { RetainedExecutionDetail } from "../../../shared/execution-protocol.js";
import { enumValue, nonEmptyString, nullableNonEmptyString, nullableString, record } from "./wire-values.js";

export function mapAgentConfiguration(value: Record<string, unknown>, entryId: string, daemonGeneration: number): import("../../ipc-types/agents.js").DesktopSupervisorAgentConfiguration {
  if (value.entry_id !== entryId || value.daemon_generation !== daemonGeneration || typeof value.provider !== "string" || !value.provider.trim() || typeof value.charter !== "string" || !value.charter.trim()
    || !Object.hasOwn(value, "model") || (value.model !== null && typeof value.model !== "string")
    || !Object.hasOwn(value, "permission_profile_id") || (value.permission_profile_id !== null && typeof value.permission_profile_id !== "string")
    || !Array.isArray(value.supervised_permission_profiles)
    || !Object.hasOwn(value, "provider_launch_policy") || value.provider_launch_policy === null || typeof value.provider_launch_policy !== "object" || Array.isArray(value.provider_launch_policy)
    || !Number.isSafeInteger(value.config_revision) || (value.config_revision as number) < 1
    || !Number.isSafeInteger(value.runtime_configuration_revision) || (value.runtime_configuration_revision as number) < 1
    || (value.runtime_configuration_revision as number) > (value.config_revision as number)) throw new Error("Supervisor returned an invalid agent configuration response.");
  const effort = value.reasoning_effort;
  if (effort !== null && (typeof effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(effort))) throw new Error("Supervisor returned an invalid reasoning effort.");
  return { entryId, daemonGeneration, provider: value.provider, model: value.model as string | null,
    reasoningEffort: effort as import("../../ipc-types/agents.js").DesktopManagedAgentEffort | null, charter: value.charter,
    permissionProfileId: value.permission_profile_id as string | null,
    supervisedPermissionProfiles: value.supervised_permission_profiles.map((profile) => mapSupervisedPermissionProfile(profile)),
    providerLaunchPolicy: value.provider_launch_policy, configRevision: value.config_revision as number, runtimeConfigurationRevision: value.runtime_configuration_revision as number,
    ...mapHomeHarness(value),
    // Only an agent app that asks has the choice; anything unreadable is off.
    ...(value.image_input_available === true ? { imageInput: value.image_input === true } : {}), ...mapLiveSharing(value) };
}

/** Absent from an older background service, and anything unreadable is off. */
function mapLiveSharing(value: Record<string, unknown>): Pick<import("../../ipc-types/agents.js").DesktopSupervisorAgentConfiguration, "liveSharing"> {
  const availability = value.live_sharing_availability;
  if (availability !== "available" && availability !== "rental" && availability !== "polling") return {};
  return { liveSharing: { enabled: value.share_live_activity === true, availability } };
}

/** Absent from an older background service, and anything unreadable is off. */
function mapHomeHarness(value: Record<string, unknown>): Pick<import("../../ipc-types/agents.js").DesktopSupervisorAgentConfiguration, "homeHarness"> {
  const availability = value.home_harness_availability;
  if (availability !== "available" && availability !== "rental" && availability !== "unsupported" && availability !== "polling") return {};
  return { homeHarness: {
    enabled: availability === "available" && value.home_harness === true,
    pending: availability === "available" && value.home_harness_pending === true,
    availability,
  } };
}

function mapSupervisedPermissionProfile(value: unknown): import("../../ipc-types/agents.js").DesktopManagedAgentPermissionProfile {
  const profile = record(value);
  const id = typeof profile?.id === "string" && profile.id.trim() ? profile.id : null;
  const label = typeof profile?.label === "string" && profile.label.trim() ? profile.label : null;
  const description = typeof profile?.description === "string" && profile.description.trim() ? profile.description : null;
  const status = enumValue(profile?.status, ["available", "gated", "unsupported"] as const);
  const risk = enumValue(profile?.risk, ["low", "medium", "high"] as const);
  if (!id || !label || !description || !status || !risk || typeof profile?.isDefault !== "boolean" || (profile.detail !== null && typeof profile.detail !== "string")) {
    throw new Error("Supervisor returned an invalid supervised permission profile.");
  }
  return { id, label, description, status, risk, detail: profile.detail as string | null, isDefault: profile.isDefault };
}

export function mapRoomMove(value: Record<string, unknown>, entryId: string, operationId?: string): import("../../ipc-types/agents.js").DesktopSupervisorRoomMove {
  const fail = (): never => { throw new Error("Supervisor returned an invalid or unfenced room-move response."); };
  const nonEmpty = (key: string): string => typeof value[key] === "string" && (value[key] as string).trim() ? value[key] as string : fail();
  const nullable = (key: string): string | null => value[key] === null ? null : typeof value[key] === "string" && (value[key] as string).trim() ? value[key] as string : fail();
  const phase = enumValue(value.phase, ["prepared", "waiting_for_current_turn", "joining_destination", "membership_committed", "rotating_credentials", "bootstrapping_destination_tail", "active", "failed", "rollback_required"] as const) ?? fail();
  const mappedOperation = nonEmpty("operation_id");
  const daemonGeneration = typeof value.daemon_generation === "number" && Number.isSafeInteger(value.daemon_generation) && value.daemon_generation > 0 ? value.daemon_generation : fail();
  if (nonEmpty("agent_id") !== entryId || (operationId !== undefined && mappedOperation !== operationId) || typeof value.source_credentials_revoked !== "boolean") fail();
  return { operationId: mappedOperation, requestId: nonEmpty("request_id"), entryId, sourceRoomId: nonEmpty("source_room_id"), destinationRoomId: nonEmpty("destination_room_id"), daemonGeneration,
    workAttemptId: nullable("work_attempt_id"), executionGenerationId: nullable("execution_generation_id"), agentSessionId: nullable("agent_session_id"), phase,
    remoteRoomId: nullable("remote_room_id"), destinationCursor: nullable("destination_cursor"), sourceCredentialsRevoked: value.source_credentials_revoked as boolean, error: nullable("error"), createdAt: nonEmpty("created_at"), updatedAt: nonEmpty("updated_at") };
}

// Host-private, structural evidence only. Reject malformed optional evidence
// independently so delivery receipts remain usable when capture is unavailable.
const recordedIdentity = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const recordedOperation = z.strictObject({
  executionId: recordedIdentity,
  operation: z.enum(["command", "file_read", "file_change", "network", "question", "other"]),
  outcome: z.enum(["succeeded", "failed", "denied_before_start", "cancelled_before_start", "interrupted_after_start", "lost_after_start"]).nullable(),
  startObserved: z.boolean(), outputBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sideEffects: z.enum(["none", "possible", "observed"]),
  exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
  signalNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
}).refine((row) => row.outcome !== null || row.exitCode === null && row.signalNumber === null)
  .refine((row) => !["denied_before_start", "cancelled_before_start"].includes(row.outcome ?? "")
    || !row.startObserved && row.outputBytes === 0 && row.sideEffects === "none" && row.exitCode === null && row.signalNumber === null);
const recordedExecutionSchema: z.ZodType<RetainedExecutionDetail> = z.union([
  z.strictObject({ availability: z.enum(["not_captured", "unavailable"]) }),
  z.strictObject({
    availability: z.literal("available"), truncated: z.boolean(), evidenceIncomplete: z.boolean(),
    turns: z.array(z.strictObject({
      turnId: recordedIdentity, state: z.enum(["none", "active", "terminal", "lost"]),
      outcome: z.enum(["completed", "failed", "interrupted", "unreadable"]).nullable(),
      operations: z.array(recordedOperation).max(128),
    }).refine((turn) => (turn.state === "terminal") === (turn.outcome !== null))
      .refine((turn) => new Set(turn.operations.map((row) => row.executionId)).size === turn.operations.length)).max(32),
  }).refine((value) => value.turns.reduce((count, turn) => count + turn.operations.length, 0) <= 128)
    .refine((value) => new Set(value.turns.map((turn) => turn.turnId)).size === value.turns.length)
    .refine((value) => value.turns.length > 0 || value.evidenceIncomplete),
]);

export function mapAgentInspectorDetail(value: Record<string, unknown>, input: import("../../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetailInput): import("../../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetail {
  type Detail = import("../../ipc-types/agents.js").DesktopSupervisorAgentInspectorDetail;
  const fail = (): never => { throw new Error("Supervisor returned an invalid or unfenced agent inspector detail response."); };
  const availability = enumValue(value.availability, ["available", "pruned", "not_loaded"] as const) ?? fail();
  const inboxItemId = nullableNonEmptyString(value.inbox_item_id);
  const requestedSourceMessageId = nullableNonEmptyString(value.requested_source_message_id);
  if (value.entry_id !== input.entryId || value.room_id !== input.roomId || inboxItemId === undefined || requestedSourceMessageId === undefined || requestedSourceMessageId !== (input.sourceMessageId ?? null)) fail();
  const mapOutcome = (candidate: unknown): Detail["receipt"] extends { outcome: infer T } ? T : never => {
    if (candidate === null) return null as never;
    const outcome = record(candidate) ?? fail();
    if (outcome.kind !== undefined && !nonEmptyString(outcome.kind)) fail();
    if (outcome.text !== undefined && nullableString(outcome.text) === undefined) fail();
    if (outcome.evidence !== undefined && !nonEmptyString(outcome.evidence)) fail();
    return { ...(outcome.kind === undefined ? {} : { kind: String(outcome.kind) }), ...(outcome.text === undefined ? {} : { text: outcome.text as string | null }), ...(outcome.evidence === undefined ? {} : { evidence: String(outcome.evidence) }) } as never;
  };
  const source = value.source_message === null ? null : (() => { const row = record(value.source_message) ?? fail(); const id = nonEmptyString(row.id) ?? fail(); const roomId = nonEmptyString(row.room_id); const sender = nullableString(row.sender); const text = nullableString(row.text); const createdAt = nullableNonEmptyString(row.created_at); const replyTo = nullableNonEmptyString(row.reply_to); const threadRoot = nullableNonEmptyString(row.thread_root_id); const activation = row.activation === null ? null : record(row.activation); if (roomId !== input.roomId || sender === undefined || text === undefined || createdAt === undefined || replyTo === undefined || threadRoot === undefined || (row.activation !== null && !activation)) fail(); return { id, room_id: roomId!, sender, text, created_at: createdAt, reply_to: replyTo, thread_root_id: threadRoot, activation }; })();
  const receipt = value.receipt === null ? null : (() => { const row = record(value.receipt) ?? fail(); const state = enumValue(row.state, ["pending", "dispatching", "awaiting_result", "result_recovery", "publishing", "retryable", "blocked", "acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_room_move", "cancelled_by_user"] as const) ?? fail(); const providerTurn = nullableNonEmptyString(row.provider_turn_id); const error = nullableString(row.last_error); const failureCode = row.failure_code == null ? null : enumValue(row.failure_code, ["provider_continuation_missing"] as const); const terminalReason = row.terminal_reason == null ? null : enumValue(row.terminal_reason, ["upgrade_authority_unavailable"] as const); const blocked = nullableNonEmptyString(row.blocked_by_inbox_item_id); const next = row.next_attempt_at_ms; if (providerTurn === undefined || error === undefined || (row.failure_code != null && !failureCode) || (row.terminal_reason != null && !terminalReason) || blocked === undefined || !(next === null || (typeof next === "number" && Number.isSafeInteger(next) && next >= 0)) || typeof row.attempt_count !== "number" || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0) fail(); return { state, attempt_count: row.attempt_count, provider_turn_id: providerTurn, outcome: mapOutcome(row.outcome), last_error: error, failure_code: failureCode, terminal_reason: terminalReason, blocked_by_inbox_item_id: blocked, next_attempt_at_ms: next as number | null }; })();
  const terminal = value.terminal === null ? null : (() => { const row = record(value.terminal) ?? fail(); const outcome = nonEmptyString(row.outcome) ?? fail(); const text = nullableString(row.normalized_text); const evidence = nonEmptyString(row.evidence_source) ?? fail(); const at = nonEmptyString(row.observed_at) ?? fail(); if (text === undefined) fail(); return { outcome, normalized_text: text, evidence_source: evidence, observed_at: at }; })();
  const publication = value.publication === null ? null : (() => { const row = record(value.publication) ?? fail(); const client = nonEmptyString(row.client_message_id) ?? fail(); const canonical = nullableNonEmptyString(row.canonical_message_id); const roomId = nullableNonEmptyString(row.room_id); if (canonical === undefined || roomId === undefined || (roomId !== null && roomId !== input.roomId)) fail(); return { client_message_id: client, canonical_message_id: canonical, room_id: roomId }; })();
  const rawUncertainEffects = value.uncertain_effects ?? [];
  if (!Array.isArray(value.timeline) || value.timeline.length > 100 || !Array.isArray(value.items) || value.items.length > 50 || !Array.isArray(rawUncertainEffects) || rawUncertainEffects.length > 32) fail();
  const timelineRows = value.timeline as unknown[]; const itemRows = value.items as unknown[]; const uncertainEffectRows = rawUncertainEffects as unknown[];
  const timeline = timelineRows.map((candidate) => { const row = record(candidate) ?? fail(); const phase = enumValue(row.phase, ["received", "queued", "turn_started", "turn_finished", "result_unreadable", "publish_started", "published", "no_reply", "retry_scheduled", "blocked", "room_move_cancelled", "conversation_restoring", "conversation_restored", "user_cancelled"] as const) ?? fail(); const at = nonEmptyString(row.observed_at) ?? fail(); const detail = nullableString(row.detail); const rawSequence = row.event_sequence; if (detail === undefined || typeof rawSequence !== "number" || !Number.isSafeInteger(rawSequence) || rawSequence < 1) fail(); const sequence = Number(rawSequence); return { sequence, phase, observedAt: at, detail }; });
  const items = itemRows.map((candidate) => { const row = record(candidate) ?? fail(); const sourceId = nonEmptyString(row.source_message_id) ?? fail(); const itemId = nonEmptyString(row.inbox_item_id) ?? fail(); const state = enumValue(row.state, ["pending", "dispatching", "awaiting_result", "result_recovery", "publishing", "retryable", "blocked", "acknowledged", "acknowledged_no_reply", "acknowledged_failed", "cancelled_by_room_move", "cancelled_by_user"] as const) ?? fail(); const updatedAt = nonEmptyString(row.updated_at) ?? fail(); const sender = nullableString(row.sender); const preview = nullableString(row.text_preview); const createdAt = nullableNonEmptyString(row.created_at); const providerTurn = nullableNonEmptyString(row.provider_turn_id); const error = nullableString(row.last_error); const failureCode = row.failure_code == null ? null : enumValue(row.failure_code, ["provider_continuation_missing"] as const); const terminalReason = row.terminal_reason == null ? null : enumValue(row.terminal_reason, ["upgrade_authority_unavailable"] as const); const canonical = nullableNonEmptyString(row.canonical_message_id); if (sender === undefined || preview === undefined || createdAt === undefined || providerTurn === undefined || error === undefined || (row.failure_code != null && !failureCode) || (row.terminal_reason != null && !terminalReason) || canonical === undefined || typeof row.attempt_count !== "number" || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0) fail(); return { source_message_id: sourceId, inbox_item_id: itemId, state, attempt_count: row.attempt_count, updated_at: updatedAt, sender, text_preview: preview, created_at: createdAt, outcome: mapOutcome(row.outcome), provider_turn_id: providerTurn, last_error: error, failure_code: failureCode, terminal_reason: terminalReason, canonical_message_id: canonical }; });
  const uncertainEffects = uncertainEffectRows.map((candidate) => { const row = record(candidate) ?? fail(); return { effect_id: nonEmptyString(row.effect_id) ?? fail(), tool_name: nonEmptyString(row.tool_name) ?? fail(), mcp_request_id: nonEmptyString(row.mcp_request_id) ?? fail(), error: nonEmptyString(row.error) ?? fail(), created_at: nonEmptyString(row.created_at) ?? fail(), updated_at: nonEmptyString(row.updated_at) ?? fail() }; });
  const repair = value.continuation_repair == null ? null : (() => {
    const row = record(value.continuation_repair) ?? fail();
    const phase = enumValue(row.phase, ["probing", "replacement_created", "committed", "failed"] as const) ?? fail();
    const replacement = nullableNonEmptyString(row.replacement_continuation);
    const error = nullableString(row.last_error);
    if (row.agent_id !== input.entryId || row.room_id !== input.roomId || replacement === undefined || error === undefined
      || typeof row.daemon_generation !== "number" || !Number.isSafeInteger(row.daemon_generation)
      || typeof row.expected_pid !== "number" || !Number.isSafeInteger(row.expected_pid) || row.expected_pid < 1
      || typeof row.attempt_count !== "number" || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 1) fail();
    return {
      repair_id: nonEmptyString(row.repair_id) ?? fail(), agent_id: input.entryId, room_id: input.roomId,
      inbox_item_id: nonEmptyString(row.inbox_item_id) ?? fail(), daemon_generation: row.daemon_generation,
      execution_generation_id: nonEmptyString(row.execution_generation_id) ?? fail(),
      work_attempt_id: nonEmptyString(row.work_attempt_id) ?? fail(), expected_pid: row.expected_pid,
      expected_process_identity: nonEmptyString(row.expected_process_identity) ?? fail(),
      missing_continuation: nonEmptyString(row.missing_continuation) ?? fail(),
      replacement_continuation: replacement, phase, attempt_count: row.attempt_count,
      last_error: error, created_at: nonEmptyString(row.created_at) ?? fail(), updated_at: nonEmptyString(row.updated_at) ?? fail(),
    };
  })();
  const boundary = value.history_boundary === null ? null : (() => { const row = record(value.history_boundary) ?? fail(); const observed = nullableNonEmptyString(row.earliest_retained_observed_message_id); const inbox = nullableNonEmptyString(row.earliest_retained_inbox_message_id); const sequence = row.earliest_retained_receipt_sequence; const pruned = nullableNonEmptyString(row.pruned_before_message_id); const at = nullableNonEmptyString(row.pruned_at); if (observed === undefined || inbox === undefined || !(sequence === null || (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0)) || pruned === undefined || at === undefined) fail(); return { earliest_retained_observed_message_id: observed, earliest_retained_inbox_message_id: inbox, earliest_retained_receipt_sequence: sequence as number | null, pruned_before_message_id: pruned, pruned_at: at }; })();
  const requestedSourceId = input.sourceMessageId ?? null;
  if (availability === "available" && (!requestedSourceId || !inboxItemId || !source || source.id !== requestedSourceId || !receipt)) fail();
  if (availability !== "available" && (inboxItemId || source || receipt || terminal || publication || repair || timeline.length)) fail();
  if (requestedSourceId === null && availability !== "not_loaded") fail();
  const recorded = availability === "available" && value.recorded_execution !== undefined
    ? recordedExecutionSchema.safeParse(value.recorded_execution) : null;
  const preparedContext = availability === "available" && value.prepared_context != null
    ? z.object({
      preparedAt: z.string().datetime(), totalMessages: z.number().int().nonnegative(),
      omittedMessages: z.number().int().nonnegative(),
      messages: z.array(z.object({ id: z.string().max(256).nullable(), sender: z.string().max(256).nullable(),
        text: z.string().max(2_000).nullable(), truncated: z.boolean() })).max(30),
    }).refine(row => row.totalMessages === row.messages.length + row.omittedMessages).safeParse(value.prepared_context)
    : null;
  const intervention = availability === "available" && value.latest_intervention != null
    ? z.object({
      actionId: z.string().min(1), recordedAt: z.string().datetime(), hasCorrection: z.boolean(),
      correctionText: z.string().max(32_768).nullable(), strategy: z.enum(["native", "stop_then_resend"]).nullable(),
      operatorResolution: z.enum(["applied", "not_applied"]).nullable(),
      status: z.enum(["prepared", "dispatching", "completed", "retryable", "uncertain"]),
      interrupted: z.boolean().nullable(), resumed: z.boolean().nullable(),
    }).safeParse(value.latest_intervention) : null;
  let runtimeControl: Detail["runtime_control"] = undefined;
  if (value.runtime_control !== undefined) {
    runtimeControl = null;
    const row = value.runtime_control === null ? null : record(value.runtime_control);
    if (row) {
      const controlState = enumValue(row.control_state, ["connecting", "responsive", "degraded", "lost", "unprobeable"] as const);
      const runtimeState = enumValue(row.runtime_state, ["starting", "ready", "stopping", "exited"] as const);
      const observedAt = nullableNonEmptyString(row.observed_at);
      const executionGenerationId = nonEmptyString(row.execution_generation_id);
      const daemonGenerationId = nonEmptyString(row.daemon_generation_id);
      if (controlState && runtimeState && observedAt !== undefined && executionGenerationId && daemonGenerationId) {
        runtimeControl = { control_state: controlState, runtime_state: runtimeState, observed_at: observedAt,
          execution_generation_id: executionGenerationId, daemon_generation_id: daemonGenerationId,
          ...(nonEmptyString(row.runtime_generation_id) ? { runtime_generation_id: nonEmptyString(row.runtime_generation_id)! } : {}) };
      }
    }
  }
  const usage = inspectorUsageSchema.safeParse(value.usage);
  return { usage: usage.success ? usage.data : null, availability, entry_id: input.entryId, room_id: input.roomId, requested_source_message_id: requestedSourceMessageId, inbox_item_id: inboxItemId, source_message: source, receipt, terminal, publication, continuation_repair: repair, timeline, items, uncertain_effects: uncertainEffects, history_boundary: boundary,
    ...(recorded ? { recorded_execution: recorded.success ? recorded.data : { availability: "unavailable" } } : {}),
    prepared_context: preparedContext?.success ? preparedContext.data : null,
    latest_intervention: intervention?.success ? intervention.data : null,
    ...(runtimeControl === undefined ? {} : { runtime_control: runtimeControl }) } as Detail;
}
