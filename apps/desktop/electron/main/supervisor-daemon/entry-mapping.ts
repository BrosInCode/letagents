import type { DesktopSupervisorActivityEvent, DesktopSupervisorManifestEntry } from "../../ipc-types.js";
import { redactCredentialText, safeStreamPayload } from "../agents/provider-evidence.js";
import type { WireActivityEvent, WireEntry } from "./types.js";
import { enumValue, nonEmptyString, nullableNonEmptyString, nullableString, record } from "./wire-values.js";

/**
 * The daemon socket is a process boundary, not a typed function call.  Keep
 * the causal projection deliberately fail-closed: it is ephemeral UI state,
 * so a malformed row must never make the desktop accept a partly-coerced
 * delivery identity (or crash while rendering the manifest).
 */
export function mapEntry(entry: WireEntry, activityLimit?: number): DesktopSupervisorManifestEntry {
  const activeWorkerBinding = entry.worker_binding ?? null;
  const workerBinding = activeWorkerBinding ?? entry.last_worker_binding ?? null;
  return {
    id: entry.id,
    roomId: entry.room_id,
    ...(entry.local_room_id ? { localRoomId: entry.local_room_id } : {}),
    displayName: entry.display_name,
    provider: entry.provider,
    model: entry.model,
    charter: entry.charter,
    desiredState: entry.desired_state,
    observedState: entry.observed_state,
    condition: entry.condition,
    lastError: entry.last_error ?? null,
    permissionProfileId: entry.permission_profile_id,
    deliveryMode: entry.delivery_mode ?? "mcp_polling",
    ...(entry.polling_contract === "custodial_polling_v1" ? { pollingContract: entry.polling_contract } : {}),
    ...(entry.home_harness === "on" || entry.home_harness === "after_restart" || entry.home_harness === "until_restart"
      ? { homeHarness: entry.home_harness } : {}),
    ...(entry.permission_pending === true ? { permissionPending: true as const } : {}),
    createdBy: entry.created_by,
    createdAt: entry.created_at,
    sourceRepoPath: entry.source_repo_path ?? null,
    workspacePath: entry.workspace_path ?? null,
    workAttemptId: entry.work_attempt_id ?? null,
    agentSessionId: workerBinding?.agent_session_id ?? null,
    agentSessionBindingState: activeWorkerBinding ? "active" : workerBinding ? "historical" : "none",
    bindingUpdatedAt: workerBinding?.updated_at ?? null,
    executionGenerationId: entry.provider_ref?.execution_generation_id ?? null,
    providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
    providerPid: entry.provider_ref?.provider_connection?.pid ?? null,
    runtimeGenerationId: nonEmptyString(entry.runtime_generation_id) ?? null,
    runtimeRecovery: entry.runtime_recovery ?? null,
    providerProgress: entry.provider_progress?.state === "compacting"
      && typeof entry.provider_progress.startedAt === "string"
      && Number.isFinite(Date.parse(entry.provider_progress.startedAt))
      ? { state: "compacting", startedAt: entry.provider_progress.startedAt } : null,
    workplaceLiveness: {
      state: entry.workplace_liveness?.state ?? "unknown",
      observedAt: entry.workplace_liveness?.observed_at ?? null,
      detail: entry.workplace_liveness?.detail ?? null,
    },
    nativeLiveness: {
      state: entry.native_liveness?.state ?? "unknown",
      observedAt: entry.native_liveness?.observed_at ?? null,
      detail: entry.native_liveness?.detail ?? null,
    },
    readyReachedAt: entry.ready_reached_at ?? null,
    restartCount: entry.reconciliation?.exit_timestamps_ms?.length ?? 0,
    lastTerminal: entry.reconciliation?.last_terminal ?? null,
    activity: boundedWireActivity(entry.activity, activityLimit).map(mapActivity),
    lastTurnControlSequence: entry.last_turn_control_sequence ?? 0,
    roomAgentState: projectRoomAgentState(entry.room_agent_state),
    deliveryAttention: projectDeliveryAttention(entry.delivery_attention),
    deliveryReceipts: projectDeliveryReceipts(entry.delivery_receipts),
    turnControl: entry.turn_control ? {
      actionId: entry.turn_control.action_id,
      actionSequence: entry.turn_control.action_sequence,
      workAttemptId: entry.turn_control.work_attempt_id,
      executionGenerationId: entry.turn_control.execution_generation_id,
      targetRoomId: entry.turn_control.target_room_id ?? null,
      targetSourceMessageId: entry.turn_control.target_source_message_id ?? null,
      targetProviderContinuationId: entry.turn_control.target_provider_continuation_id ?? null,
      inboxItemId: entry.turn_control.inbox_item_id ?? null,
      providerTurnId: entry.turn_control.provider_turn_id ?? null,
      hasCorrection: Boolean(entry.turn_control.has_correction),
      correctionText: entry.turn_control.correction_text ?? null,
      status: entry.turn_control.status,
      capability: entry.turn_control.capability,
      interrupted: entry.turn_control.interrupted,
      resumed: entry.turn_control.resumed,
      state: entry.turn_control.state,
      stages: entry.turn_control.stages,
      error: entry.turn_control.error,
      recordedAt: entry.turn_control.recorded_at,
      updatedAt: entry.turn_control.updated_at,
    } : null,
  };
}

function projectRoomAgentState(value: unknown): DesktopSupervisorManifestEntry["roomAgentState"] {
  const root = record(value);
  if (!root) return null;
  const connection = record(root.connection);
  const hasIngress = Object.hasOwn(root, "ingress");
  const ingress = hasIngress ? record(root.ingress) : null;
  const inbox = record(root.inbox);
  const turn = record(root.turn);
  const task = record(root.task);
  if (!connection || (hasIngress && !ingress) || !inbox || !turn || !task) return null;

  const connectionState = enumValue(connection.state, ["connected", "reconnecting", "disconnected"] as const);
  const ingressState = ingress
    ? enumValue(ingress.state, ["starting", "observing", "backoff", "blocked", "stopped"] as const)
    : connectionState === "connected" ? "observing" as const : "stopped" as const;
  const inboxState = enumValue(inbox.state, ["empty", "queued", "blocked", "restoring_conversation", "waiting_for_desktop_credentials"] as const);
  const turnState = enumValue(turn.state, ["idle", "dispatching", "responding", "publishing", "retrying", "failed"] as const);
  const taskState = enumValue(task.state, ["none", "assigned", "working", "blocked"] as const);
  const observedAt = nullableNonEmptyString(connection.observed_at);
  const connectionDetail = nullableString(connection.detail);
  const ingressObservedAt = ingress ? nullableNonEmptyString(ingress.observed_at) : observedAt;
  const ingressDetail = ingress ? nullableString(ingress.detail) : null;
  const blockedByMessageId = nullableNonEmptyString(inbox.blocked_by_message_id);
  const inboxDetail = nullableString(inbox.detail);
  const inboxItemId = nullableNonEmptyString(turn.inbox_item_id);
  const sourceMessageId = nullableNonEmptyString(turn.source_message_id);
  const providerTurnId = nullableNonEmptyString(turn.provider_turn_id);
  const turnDetail = nullableString(turn.detail);
  const taskId = nullableNonEmptyString(task.task_id);
  const title = nullableString(task.title);
  if (!connectionState || !ingressState || !inboxState || !turnState || !taskState
    || observedAt === undefined || connectionDetail === undefined || ingressObservedAt === undefined || ingressDetail === undefined || blockedByMessageId === undefined || inboxDetail === undefined
    || inboxItemId === undefined || sourceMessageId === undefined || providerTurnId === undefined || turnDetail === undefined
    || taskId === undefined || title === undefined
    || typeof inbox.pending_count !== "number" || !Number.isFinite(inbox.pending_count) || !Number.isInteger(inbox.pending_count) || inbox.pending_count < 0) return null;
  return {
    connection: { state: connectionState, observedAt, detail: connectionDetail },
    ingress: { state: ingressState, observedAt: ingressObservedAt, detail: ingressDetail },
    inbox: { state: inboxState, pendingCount: inbox.pending_count, blockedByMessageId, detail: inboxDetail },
    turn: { state: turnState, inboxItemId, sourceMessageId, providerTurnId, detail: turnDetail },
    task: { state: taskState, taskId, title },
  };
}

function projectDeliveryAttention(value: unknown): DesktopSupervisorManifestEntry["deliveryAttention"] {
  const root = record(value);
  if (!root) return null;
  const reason = enumValue(root.reason, ["message_blocked"] as const);
  const sourceMessageId = nonEmptyString(root.source_message_id);
  const blockedSince = nonEmptyString(root.blocked_since);
  const detail = nullableString(root.detail);
  const retry = enumValue(root.retry, ["reread_saved_turn", "publish_saved_reply", "start_turn", "restore_conversation"] as const);
  const skipUnavailableReason = nullableString(root.skip_unavailable_reason);
  if (!reason || !sourceMessageId || !blockedSince || detail === undefined || !retry || skipUnavailableReason === undefined
    || typeof root.waiting_count !== "number" || !Number.isSafeInteger(root.waiting_count) || root.waiting_count < 0
    || typeof root.provider_work_started !== "boolean" || typeof root.can_skip !== "boolean") return null;
  return { reason, sourceMessageId, blockedSince, detail, waitingCount: root.waiting_count,
    providerWorkStarted: root.provider_work_started, retry, canSkip: root.can_skip, skipUnavailableReason };
}

function projectDeliveryReceipts(value: unknown): DesktopSupervisorManifestEntry["deliveryReceipts"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const receipt = record(candidate);
    if (!receipt) return [];
    const inboxItemId = nonEmptyString(receipt.inbox_item_id);
    const sourceMessageId = nonEmptyString(receipt.source_message_id);
    const fifoSequence = receipt.fifo_sequence;
    const replyClientMessageId = nonEmptyString(receipt.reply_client_message_id);
    const canonicalMessageId = receipt.canonical_message_id === undefined
      ? null
      : nullableNonEmptyString(receipt.canonical_message_id);
    const state = enumValue(receipt.state, ["pending", "dispatching", "awaiting_result", "result_recovery", "publishing", "acknowledged", "acknowledged_no_reply", "acknowledged_failed", "retryable", "blocked", "restoring_conversation", "cancelled_by_room_move", "cancelled_by_user", "queued_behind_blocked"] as const);
    const providerTurnId = nullableNonEmptyString(receipt.provider_turn_id);
    const blockedByMessageId = nullableNonEmptyString(receipt.blocked_by_message_id);
    const error = nullableString(receipt.error);
    const failureCode = receipt.failure_code === undefined || receipt.failure_code === null
      ? null
      : enumValue(receipt.failure_code, ["provider_continuation_missing"] as const);
    const terminalReason = receipt.terminal_reason === undefined || receipt.terminal_reason === null
      ? null
      : enumValue(receipt.terminal_reason, ["upgrade_authority_unavailable"] as const);
    const updatedAt = nonEmptyString(receipt.updated_at);
    if (!inboxItemId || !sourceMessageId || typeof fifoSequence !== "number" || !Number.isSafeInteger(fifoSequence) || fifoSequence < 1 || !replyClientMessageId || canonicalMessageId === undefined || !state || providerTurnId === undefined || blockedByMessageId === undefined || error === undefined || failureCode === undefined || terminalReason === undefined || !updatedAt
      || typeof receipt.attempt_count !== "number" || !Number.isFinite(receipt.attempt_count) || !Number.isInteger(receipt.attempt_count) || receipt.attempt_count < 0
      || !Array.isArray(receipt.timeline)) return [];
    const timeline: NonNullable<DesktopSupervisorManifestEntry["deliveryReceipts"]>[number]["timeline"] = [];
    for (const event of receipt.timeline) {
      const value = record(event);
      if (!value) return [];
      const phase = enumValue(value.phase, ["received", "queued", "turn_started", "turn_finished", "result_unreadable", "publish_started", "published", "no_reply", "retry_scheduled", "blocked", "room_move_cancelled", "conversation_restoring", "conversation_restored", "user_cancelled"] as const);
      const observedAt = nonEmptyString(value.observed_at);
      const detail = nullableString(value.detail);
      const rawSequence = value.event_sequence;
      if (!phase || !observedAt || detail === undefined || typeof rawSequence !== "number" || !Number.isSafeInteger(rawSequence) || rawSequence < 1) return [];
      const sequence = Number(rawSequence);
      timeline.push({ sequence, phase, observedAt, detail });
    }
    const followUp = projectFollowUp(receipt.follow_up);
    return [{ inboxItemId, sourceMessageId, fifoSequence, replyClientMessageId, canonicalMessageId, state, attemptCount: receipt.attempt_count, providerTurnId, blockedByMessageId, error, failureCode, terminalReason, updatedAt,
      ...(followUp ? { followUp } : {}), timeline }];
  });
}

/** Keep in sync with FOLLOW_UP_REASONS in daemon/task-continuity.ts. A test reads both. */
const FOLLOW_UP_REASONS = ["stopped_by_owner", "skipped", "agent_changed", "task_not_held", "uncertain_action", "uncertain_resolved", "attempts_failed", "ownership_unverified", "other"] as const;

/** A follow-up is shown only when every part of it is what the daemon writes; anything else reads as none. */
function projectFollowUp(value: unknown): import("../../ipc-types/agents.js").DesktopRoomAgentFollowUp | null {
  const followUp = record(value);
  if (!followUp) return null;
  const forMessageId = nullableNonEmptyString(followUp.for_message_id);
  const state = enumValue(followUp.state, ["scheduled", "waiting_for_owner", "ended"] as const);
  if (forMessageId === undefined || !state) return null;
  if (state !== "scheduled") {
    // A reason that this version does not know, from a newer daemon, reads as none: the follow-up is still shown.
    const reason = enumValue(followUp.reason, FOLLOW_UP_REASONS);
    return followUp.scheduled === null ? { forMessageId, state, ...(reason ? { reason } : {}),
      ...(typeof followUp.later_person_turn === "boolean" ? { laterPersonTurn: followUp.later_person_turn } : {}), scheduled: null } : null;
  }
  const scheduled = record(followUp.scheduled);
  const kind = enumValue(scheduled?.kind, ["provider_fault", "no_reply"] as const);
  const { at_ms: atMs, attempt, attempts } = scheduled ?? {};
  if (!kind || typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs <= 0
    || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1
    || typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < attempt) return null;
  return { forMessageId, state, scheduled: { atMs, attempt, attempts, kind } };
}

/**
 * `manifest.list` carries full history; the pushed state channel carries a
 * bounded, payload-free summary tail. Keep the newest events by sequence and
 * strip payloads so one oversized wire answer cannot reintroduce a
 * multi-megabyte IPC frame per sequence change.
 */
function boundedWireActivity(
  activity: WireActivityEvent[] | undefined,
  limit?: number,
): WireActivityEvent[] {
  const events = activity ?? [];
  if (limit === undefined || events.length === 0) return events;
  const bounded = limit <= 0
    ? []
    : [...events].sort((left, right) => left.sequence - right.sequence).slice(-limit);
  return bounded.map((event) => (event.payload === null ? event : { ...event, payload: null }));
}

export function mapActivity(event: WireActivityEvent): DesktopSupervisorActivityEvent {
  return sanitizeDesktopActivityEvent({
    observedAt: event.observed_at,
    sequence: event.sequence,
    provider: event.provider,
    kind: event.kind,
    method: event.method,
    summary: event.summary,
    status: event.status,
    payload: event.payload,
    payloadTruncated: event.payload_truncated,
    payloadRedacted: event.payload_redacted,
    durablePayloadRef: event.durable_payload_ref,
  });
}

function sanitizeDesktopActivityEvent(event: DesktopSupervisorActivityEvent): DesktopSupervisorActivityEvent {
  const payload = safeStreamPayload(event.payload);
  const provider = redactCredentialText(event.provider);
  const kind = redactCredentialText(event.kind);
  const method = redactCredentialText(event.method);
  const summary = redactCredentialText(event.summary);
  const durableRef = event.durablePayloadRef === null ? null : redactCredentialText(event.durablePayloadRef);
  const bound = (value: string, max: number) => {
    if (value.length <= max) return value;
    const markerStart = value.lastIndexOf("[REDACTED]", max);
    if (markerStart >= 0 && markerStart < max && markerStart + "[REDACTED]".length > max) return value.slice(-max);
    return value.slice(0, max);
  };
  const providerValue = bound(provider.value, 160);
  const kindValue = bound(kind.value, 160);
  const methodValue = bound(method.value, 500);
  const summaryValue = bound(summary.value, 500);
  const durableValue = durableRef ? bound(durableRef.value, 2_048) : null;
  return {
    ...event,
    provider: providerValue,
    kind: kindValue,
    method: methodValue,
    summary: summaryValue,
    payload: payload.payload,
    payloadTruncated: event.payloadTruncated || payload.payloadTruncated
      || provider.value.length > providerValue.length || kind.value.length > kindValue.length
      || method.value.length > methodValue.length || summary.value.length > summaryValue.length
      || (durableRef?.value.length ?? 0) > (durableValue?.length ?? 0),
    payloadRedacted: event.payloadRedacted || payload.payloadRedacted || provider.redacted || kind.redacted || method.redacted || summary.redacted || durableRef?.redacted === true,
    durablePayloadRef: durableValue,
  };
}
