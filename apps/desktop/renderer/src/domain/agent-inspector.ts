import type {
  DesktopSupervisorActivityEvent,
  DesktopSupervisorManifestEntry,
  DesktopTaskSummary,
} from "../../../electron/ipc-types";
import {
  canReconnectRoomAgent,
  canRecoverSavedRoomAgent,
} from "./room-agent-delivery";
import {
  humanFacingSupervisorActivitySummary,
  isHumanVisibleSupervisorActivity,
} from "./managed-agents";
import { supervisedAgentDisplayLabel } from "./codenames";

export type AgentInspectorOverallState =
  | "retired"
  | "paused"
  | "needs_attention"
  | "restoring_conversation"
  | "reconnecting"
  | "responding"
  | "listening"
  | "starting"
  | "disconnected";

export type AgentInspectorReadinessTone =
  | "ready"
  | "active"
  | "waiting"
  | "warning"
  | "blocked"
  | "offline";

export interface AgentInspectorReadinessFact {
  key: "provider" | "observation" | "inbox" | "turn";
  label: string;
  value: string;
  detail: string | null;
  tone: AgentInspectorReadinessTone;
}

export interface AgentInspectorTaskProjection {
  id: string;
  title: string;
  status: string;
}

export interface AgentInspectorNowProjection {
  kind: "progress" | "attention";
  label: string;
  summary: string;
  observedAt: string | null;
}

export interface AgentInspectorDeliveryProgressProjection {
  phase: "starting" | "responding" | "recovering" | "publishing";
  label: string;
  detail: string;
  sourceMessageId: string | null;
  /**
   * True while this desktop is completing the idempotent retry RPC. The
   * room-level coordinator owns this fact, so closing the Inspector cannot
   * make the request look idle or allow a duplicate click.
   */
  requestedLocally: boolean;
}

export type AgentInspectorActionKind =
  | "mention"
  | "pause"
  | "resume"
  | "reconnect"
  | "recover"
  | "stop_turn"
  | "steer_turn"
  | "resolve_turn_control"
  | "retry_delivery"
  | "restore_conversation"
  | "skip_message"
  | "retire_agent"
  | "save_settings"
  | "move_room"
  | "purge_agent";

export interface AgentInspectorActionAvailability {
  kind: AgentInspectorActionKind;
  label: string;
  available: boolean;
  sourceMessageId?: string;
  danger?: boolean;
}

export interface AgentInspectorActionIntent {
  entryId: string;
  roomId: string;
  kind: AgentInspectorActionKind;
  sourceMessageId?: string;
  /** A correction stays inside the existing provider continuation; it is never a room message. */
  correction?: string;
  /** Only used to settle one durable, ambiguous turn-control journal record. */
  turnControlResolution?: "not_applied" | "applied";
  presentation?: "wide" | "compact";
}

export type AgentInspectorTurnControlStatus = "ready" | "in_progress" | "uncertain" | "retryable" | "unavailable";

/**
 * A compact, user-facing projection of the daemon-owned turn-control journal.
 * It intentionally exposes no transport controls: the shell owns action IDs,
 * fences, retries, and the provider call.
 */
export interface AgentInspectorTurnControlProjection {
  status: AgentInspectorTurnControlStatus;
  capability: "native_interrupt" | "restart_resume" | "unsupported";
  providerTurnId: string | null;
  actionId: string | null;
  workAttemptId: string | null;
  executionGenerationId: string | null;
  canStop: boolean;
  canCorrect: boolean;
  canResolve: boolean;
  label: string;
  detail: string;
}

/** The exact renderer-side snapshot for an asynchronous, daemon-owned control. */
export interface AgentInspectorTurnControlFence {
  entryId: string;
  roomId: string;
  workAttemptId: string;
  executionGenerationId: string;
  providerTurnId: string | null;
  inboxItemId: string | null;
  sourceMessageId: string | null;
  daemonGeneration: number;
}

/**
 * The exact causal identity of one idempotent native turn-control effect.
 * The action id is derived from every meaningful input so a retry after an
 * ambiguous IPC response reaches the daemon's existing journal record rather
 * than creating a second native interrupt/resume request.
 */
export interface AgentInspectorTurnControlActionIdentity {
  entryId: string;
  roomId: string;
  workAttemptId: string;
  executionGenerationId: string;
  providerTurnId: string | null;
  inboxItemId: string | null;
  sourceMessageId: string | null;
  correction: string | null;
}

export interface AgentInspectorActionState {
  operationId: string;
  entryId: string;
  kind: AgentInspectorActionKind;
  status: "running" | "success" | "error";
  message: string | null;
}

/** Prevents an in-flight action for one agent from disabling or messaging another inspector. */
export function agentInspectorActionStateForEntry(
  state: AgentInspectorActionState | null,
  entryId: string | null,
): AgentInspectorActionState | null {
  return state && entryId && state.entryId === entryId ? state : null;
}

/**
 * Discard only the action that started this async path. A newer Inspector
 * operation may have replaced it while an earlier action was yielding.
 */
export function clearAgentInspectorActionStateIfMatching(
  state: AgentInspectorActionState | null,
  operationId: string,
): AgentInspectorActionState | null {
  return state?.operationId === operationId ? null : state;
}

export interface AgentInspectorProjection {
  entryId: string;
  roomId: string;
  agentKey: string | null;
  displayName: string;
  ownerAttribution: string | null;
  provider: string;
  model: string | null;
  charter: string;
  overallState: AgentInspectorOverallState;
  overallLabel: string;
  overallDetail: string;
  readiness: AgentInspectorReadinessFact[];
  deliveryProgress: AgentInspectorDeliveryProgressProjection | null;
  now: AgentInspectorNowProjection | null;
  assignedWork: AgentInspectorTaskProjection[];
  recentOutcome: { label: string; observedAt: string } | null;
  continuationRecovery: {
    state: "restoring" | "failed" | "restored";
    sourceMessageId: string;
    detail: string;
    canRestore: boolean;
    canSkip: boolean;
  } | null;
  turnControl: AgentInspectorTurnControlProjection | null;
  actions: AgentInspectorActionAvailability[];
  mentionInsertText: string | null;
  resourceFreshness: "fresh" | "stale";
  entry: DesktopSupervisorManifestEntry;
}

export interface AgentInspectorProjectionOptions {
  roomId: string | null;
  tasks?: readonly DesktopTaskSummary[];
  deliveryRetryAvailable?: boolean;
  continuationRepairAvailable?: boolean;
  roomDeliverySkipAvailable?: boolean;
  resourceFreshness?: "fresh" | "stale";
  mentionInsertTextByEntryId?: ReadonlyMap<string, string>;
  deliveryRetryingKeys?: ReadonlySet<string>;
}

const ACTIVE_TURN_STATES = new Set(["dispatching", "responding", "publishing", "retrying"]);

function titleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function ownerAttribution(createdBy: string): string | null {
  const value = createdBy.trim();
  if (!value || value === "desktop") return null;
  return `${value}'s agent`;
}

function hasLiveProvider(entry: DesktopSupervisorManifestEntry): boolean {
  return Boolean(entry.providerPid)
    && entry.agentSessionBindingState === "active"
    && Boolean(entry.workAttemptId && entry.executionGenerationId && entry.providerContinuationId);
}

function hasValidCredential(entry: DesktopSupervisorManifestEntry): boolean {
  return entry.condition !== "auth_blocked"
    && entry.roomAgentState?.inbox.state !== "waiting_for_desktop_credentials";
}

export function agentInspectorOverallState(entry: DesktopSupervisorManifestEntry): AgentInspectorOverallState {
  const room = entry.roomAgentState;
  if (entry.desiredState === "stopped" || entry.observedState === "stopped" || entry.observedState === "stopping") {
    return "retired";
  }
  if (entry.desiredState === "paused" || entry.observedState === "paused" || entry.observedState === "pausing") {
    return "paused";
  }
  if (room?.inbox.state === "restoring_conversation") return "restoring_conversation";
  if (
    entry.condition !== "none"
    || entry.observedState === "failed"
    || room?.ingress.state === "blocked"
    || room?.inbox.state === "blocked"
    || room?.inbox.state === "waiting_for_desktop_credentials"
    || room?.turn.state === "failed"
  ) return "needs_attention";
  if (room?.connection.state === "reconnecting" || room?.ingress.state === "backoff") return "reconnecting";
  if (room && ACTIVE_TURN_STATES.has(room.turn.state)) return "responding";
  if (
    room?.connection.state === "connected"
    && room.ingress.state === "observing"
    && hasLiveProvider(entry)
    && hasValidCredential(entry)
  ) return "listening";
  if (
    entry.observedState === "starting"
    || entry.observedState === "recovering"
    || room?.ingress.state === "starting"
  ) return "starting";
  return "disconnected";
}

function overallPresentation(state: AgentInspectorOverallState): { label: string; detail: string } {
  switch (state) {
    case "retired": return { label: "Stopped", detail: "This saved agent is no longer running." };
    case "paused": return { label: "Paused", detail: "Room work is held until you resume the agent." };
    case "needs_attention": return { label: "Needs attention", detail: "A blocked runtime or delivery step needs your input." };
    case "restoring_conversation": return { label: "Restoring conversation", detail: "Recovering the agent’s private Codex conversation without restarting its provider." };
    case "reconnecting": return { label: "Reconnecting", detail: "Restoring the room observation path." };
    case "responding": return { label: "Responding", detail: "A bounded room turn is in progress." };
    case "listening": return { label: "Listening", detail: "Connected and ready for a routed room message." };
    case "starting": return { label: "Starting", detail: "Preparing the provider and room observation path." };
    case "disconnected": return { label: "Disconnected", detail: "The provider is not currently reachable." };
  }
}

function readiness(entry: DesktopSupervisorManifestEntry): AgentInspectorReadinessFact[] {
  const room = entry.roomAgentState;
  const providerLive = hasLiveProvider(entry);
  const providerTone: AgentInspectorReadinessTone = providerLive
    ? "ready"
    : entry.observedState === "starting" || entry.observedState === "recovering"
      ? "waiting"
      : entry.observedState === "failed" ? "blocked" : "offline";
  const ingress = room?.ingress.state ?? "stopped";
  const ingressTone: AgentInspectorReadinessTone = ingress === "observing"
    ? "ready"
    : ingress === "backoff" ? "warning" : ingress === "blocked" ? "blocked" : ingress === "starting" ? "waiting" : "offline";
  const inbox = room?.inbox;
  const inboxTone: AgentInspectorReadinessTone = inbox?.state === "blocked" || inbox?.state === "waiting_for_desktop_credentials"
    ? "blocked"
    : inbox?.state === "queued" || inbox?.state === "restoring_conversation" ? "waiting" : inbox ? "ready" : "offline";
  const turn = room?.turn;
  const turnTone: AgentInspectorReadinessTone = turn?.state === "failed"
    ? "blocked"
    : turn && ACTIVE_TURN_STATES.has(turn.state) ? "active" : "ready";
  return [
    {
      key: "provider",
      label: "Provider",
      value: providerLive ? "Connected" : titleCase(entry.observedState),
      detail: entry.lastError ?? entry.workplaceLiveness.detail,
      tone: providerTone,
    },
    {
      key: "observation",
      label: "Room observation",
      value: titleCase(ingress),
      detail: room?.ingress.detail ?? null,
      tone: ingressTone,
    },
    {
      key: "inbox",
      label: "Inbox",
      value: inbox
        ? `${inbox.state === "restoring_conversation" ? "Restoring the blocked message" : titleCase(inbox.state)}${inbox.pendingCount ? ` · ${inbox.pendingCount}` : ""}`
        : "Unavailable",
      detail: inbox?.detail ?? null,
      tone: inboxTone,
    },
    {
      key: "turn",
      label: "Current turn",
      value: titleCase(turn?.state ?? "idle"),
      detail: turn?.detail ?? null,
      tone: turnTone,
    },
  ];
}

function turnStartedAt(entry: DesktopSupervisorManifestEntry): number | null {
  const turn = entry.roomAgentState?.turn;
  const receipt = entry.deliveryReceipts?.find((candidate) =>
    (Boolean(turn?.inboxItemId) && candidate.inboxItemId === turn?.inboxItemId)
    || (Boolean(turn?.sourceMessageId) && candidate.sourceMessageId === turn?.sourceMessageId));
  const event = [...(receipt?.timeline ?? [])].reverse().find((candidate) => candidate.phase === "turn_started");
  const timestamp = Date.parse(event?.observedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isAgentInspectorNowActivity(event: DesktopSupervisorActivityEvent): boolean {
  return isHumanVisibleSupervisorActivity(event)
    && event.status !== "idle"
    && event.method.trim().toLowerCase() !== "thread/read"
    && event.method.trim().toLowerCase() !== "account/ratelimits/updated";
}

function nowProjection(
  entry: DesktopSupervisorManifestEntry,
  overallState: AgentInspectorOverallState,
): AgentInspectorNowProjection | null {
  if (overallState === "responding") {
    const startedAt = turnStartedAt(entry);
    if (startedAt === null) return null;
    const latest = [...entry.activity]
      .sort((left, right) => right.sequence - left.sequence)
      .find((event) => isAgentInspectorNowActivity(event)
        && Date.parse(event.observedAt) >= startedAt);
    const fallback = entry.roomAgentState?.turn.detail?.trim() || "Working on the room message";
    return {
      kind: "progress",
      label: "Now",
      summary: latest
        ? humanFacingSupervisorActivitySummary(latest)
        : fallback,
      observedAt: latest?.observedAt ?? null,
    };
  }
  if (["needs_attention", "reconnecting", "disconnected"].includes(overallState)) {
    return {
      kind: "attention",
      label: overallState === "reconnecting" ? "Reconnecting" : "Needs attention",
      summary: entry.lastError
        || entry.roomAgentState?.inbox.detail
        || entry.roomAgentState?.ingress.detail
        || entry.roomAgentState?.connection.detail
        || overallPresentation(overallState).detail,
      observedAt: entry.roomAgentState?.connection.observedAt ?? entry.bindingUpdatedAt,
    };
  }
  if (overallState === "restoring_conversation") {
    return {
      kind: "progress",
      label: "Restoring conversation",
      summary: "Checking the saved conversation, then safely creating a replacement only if it is truly missing.",
      observedAt: entry.roomAgentState?.connection.observedAt ?? entry.bindingUpdatedAt,
    };
  }
  return null;
}

function deliveryProgress(
  entry: DesktopSupervisorManifestEntry,
  deliveryRetryingKeys: ReadonlySet<string>,
  hasLiveNow: boolean,
): AgentInspectorDeliveryProgressProjection | null {
  const turn = entry.roomAgentState?.turn;
  const retryKeyPrefix = `${entry.id}:`;
  const localRetryKey = [...deliveryRetryingKeys].find((key) => key.startsWith(retryKeyPrefix)) ?? null;
  const localRetrySourceMessageId = localRetryKey?.slice(retryKeyPrefix.length) || null;
  const requestedLocally = Boolean(localRetrySourceMessageId);
  const sourceMessageId = turn?.sourceMessageId ?? localRetrySourceMessageId;

  if (turn?.state === "publishing") {
    return {
      phase: "publishing",
      label: "Publishing response",
      detail: "The response is ready and is being added to the room.",
      sourceMessageId,
      requestedLocally,
    };
  }
  if (turn?.state === "retrying") {
    return {
      phase: "recovering",
      label: "Recovering response",
      detail: turn.detail?.trim() || "Resuming the failed delivery step without repeating completed work.",
      sourceMessageId,
      requestedLocally,
    };
  }
  if (turn?.state === "dispatching") {
    return {
      phase: "starting",
      label: "Starting delivery",
      detail: turn.detail?.trim() || "Handing the room message to the agent.",
      sourceMessageId,
      requestedLocally,
    };
  }
  if (turn?.state === "responding" && !hasLiveNow) {
    return {
      phase: "responding",
      label: "Agent is responding",
      detail: turn.detail?.trim() || "Working on the routed room message.",
      sourceMessageId,
      requestedLocally,
    };
  }
  if (localRetrySourceMessageId) {
    return {
      phase: "starting",
      label: "Retrying delivery",
      detail: "Checking the blocked message and safely resuming its delivery.",
      sourceMessageId,
      requestedLocally: true,
    };
  }
  return null;
}

function exactAssignedWork(
  entry: DesktopSupervisorManifestEntry,
  tasks: readonly DesktopTaskSummary[],
): AgentInspectorTaskProjection[] {
  const explicitTaskId = entry.roomAgentState?.task.taskId;
  const explicitTaskIsActive = Boolean(
    explicitTaskId && ["assigned", "working", "blocked"].includes(entry.roomAgentState?.task.state ?? "none"),
  );
  const terminalTaskStatuses = new Set(["done", "completed", "cancelled", "canceled", "closed", "merged"]);
  const matches = tasks.filter((task) => {
    if (explicitTaskIsActive && task.id === explicitTaskId) return true;
    const hasExactActiveLease = task.activeLeases.some((lease) =>
      Boolean(entry.agentKey) && lease.agentKey === entry.agentKey
      || Boolean(entry.agentSessionId) && lease.agentSessionId === entry.agentSessionId);
    if (hasExactActiveLease) return true;
    return Boolean(entry.agentKey)
      && task.assigneeAgentKey === entry.agentKey
      && !terminalTaskStatuses.has(task.status.trim().toLowerCase());
  });
  return matches.map((task) => ({ id: task.id, title: task.title, status: task.status }));
}

function recentOutcome(entry: DesktopSupervisorManifestEntry): AgentInspectorProjection["recentOutcome"] {
  const receipt = [...(entry.deliveryReceipts ?? [])].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!receipt) return null;
  const labels: Record<string, string> = {
    acknowledged: "Published a room response",
    acknowledged_no_reply: "Chose not to reply",
    result_recovery: "Result needs recovery",
    blocked: "Delivery needs attention",
    cancelled_by_room_move: "Cancelled after moving rooms",
    cancelled_by_user: "Skipped by you",
    restoring_conversation: "Restoring the blocked conversation",
  };
  return { label: labels[receipt.state] ?? titleCase(receipt.state), observedAt: receipt.updatedAt };
}

function providerTurnControlCapability(entry: DesktopSupervisorManifestEntry): AgentInspectorTurnControlProjection["capability"] {
  if (["codex", "claude-code", "open-model"].includes(entry.provider)) return "native_interrupt";
  if (entry.provider === "cursor") return "restart_resume";
  return "unsupported";
}

function turnControlBaseIsExact(entry: DesktopSupervisorManifestEntry): boolean {
  return entry.desiredState === "running"
    && entry.condition === "none"
    && entry.agentSessionBindingState === "active"
    && Boolean(entry.workAttemptId && entry.executionGenerationId && entry.providerContinuationId)
    && (entry.observedState === "working" || entry.observedState === "idle");
}

/**
 * The display layer may only offer a turn action against a durable provider
 * continuation. A live room turn additionally needs its exact provider turn
 * checkpoint; otherwise it is still starting and cannot be safely interrupted.
 */
export function projectAgentInspectorTurnControl(
  entry: DesktopSupervisorManifestEntry,
): AgentInspectorTurnControlProjection | null {
  const journal = entry.turnControl;
  const capability = journal?.capability ?? providerTurnControlCapability(entry);
  const baseExact = turnControlBaseIsExact(entry);
  const providerTurnId = entry.roomAgentState?.turn.providerTurnId ?? null;
  const isResponding = entry.roomAgentState?.turn.state === "responding";
  const activeTurnIsCheckpointed = !isResponding || Boolean(providerTurnId);
  const canControl = baseExact && capability !== "unsupported";

  if (journal?.status === "uncertain") {
    const journalMatchesExecution = journal.workAttemptId === entry.workAttemptId
      && journal.executionGenerationId === entry.executionGenerationId;
    return {
      status: "uncertain",
      capability: journal.capability,
      providerTurnId,
      actionId: journal.actionId,
      workAttemptId: journal.workAttemptId,
      executionGenerationId: journal.executionGenerationId,
      canStop: false,
      canCorrect: false,
      canResolve: baseExact && journalMatchesExecution,
      label: "Turn control needs confirmation",
      detail: journal.error || "The last control request may have reached the provider. Confirm the outcome before another change is sent.",
    };
  }

  if (journal && ["prepared", "dispatching"].includes(journal.status)) {
    return {
      status: "in_progress",
      capability: journal.capability,
      providerTurnId,
      actionId: journal.actionId,
      workAttemptId: journal.workAttemptId,
      executionGenerationId: journal.executionGenerationId,
      canStop: false,
      canCorrect: false,
      canResolve: false,
      label: journal.hasCorrection ? "Applying correction" : "Stopping current turn",
      detail: "The supervisor is applying this change to the existing agent session.",
    };
  }

  const shouldShow = canControl && (isResponding || journal?.status === "retryable");
  if (!shouldShow) return null;
  const awaitingTurnCheckpoint = isResponding && !activeTurnIsCheckpointed;
  return {
    status: journal?.status === "retryable" ? "retryable" : "ready",
    capability,
    providerTurnId,
    actionId: journal?.actionId ?? null,
    workAttemptId: entry.workAttemptId,
    executionGenerationId: entry.executionGenerationId,
    canStop: canControl && isResponding && activeTurnIsCheckpointed,
    canCorrect: canControl && activeTurnIsCheckpointed,
    canResolve: false,
    label: journal?.status === "retryable" ? "Previous change was not applied" : "Control current turn",
    detail: awaitingTurnCheckpoint
      ? "This turn is still starting. Wait for its provider checkpoint before interrupting it."
      : journal?.status === "retryable"
        ? "The previous change was verified not applied. You can safely send a new correction."
        : "Stop ends this response. A correction interrupts this turn, then continues on the same agent session.",
  };
}

/**
 * A push or poll may replace the selected entry while an IPC request is away.
 * An idle/null turn is allowed after a successful stop; a different live turn
 * proves that the response belongs to stale work and must not update the UI.
 */
export function agentInspectorTurnControlFenceMatches(
  fence: AgentInspectorTurnControlFence,
  entry: Pick<DesktopSupervisorManifestEntry, "id" | "roomId" | "workAttemptId" | "executionGenerationId" | "roomAgentState"> | null,
  daemonGeneration: number | null,
): boolean {
  if (!entry || daemonGeneration !== fence.daemonGeneration
    || entry.id !== fence.entryId || entry.roomId !== fence.roomId
    || entry.workAttemptId !== fence.workAttemptId
    || entry.executionGenerationId !== fence.executionGenerationId) return false;
  const currentTurn = entry.roomAgentState?.turn;
  const currentProviderTurnId = currentTurn?.providerTurnId ?? null;
  // A null provider checkpoint only proves the old turn ended when the room
  // turn is genuinely idle. During dispatch/respond/publish/retry it could be
  // a newer turn that has not published its checkpoint yet; failed/unknown is
  // not a completion proof either.
  if (!currentProviderTurnId) return currentTurn?.state === "idle";
  if (!fence.providerTurnId || currentProviderTurnId !== fence.providerTurnId) return false;
  // Once the exact provider turn is still live, bind its causal room item too.
  // An idle turn has intentionally cleared those fields after completion.
  if (currentProviderTurnId) {
    if (fence.inboxItemId && currentTurn?.inboxItemId !== fence.inboxItemId) return false;
    if (fence.sourceMessageId && currentTurn?.sourceMessageId !== fence.sourceMessageId) return false;
  }
  return true;
}

/**
 * A renderer retry must keep the same id even if the first IPC response was
 * lost. SHA-256 keeps the durable action id bounded without allowing a
 * different correction, turn, inbox item, or generation to collide with it.
 */
export async function agentInspectorTurnControlActionId(
  identity: AgentInspectorTurnControlActionIdentity,
): Promise<string> {
  const canonical = JSON.stringify([
    "agent-inspector-turn-control-v1",
    identity.entryId,
    identity.roomId,
    identity.workAttemptId,
    identity.executionGenerationId,
    identity.providerTurnId,
    identity.inboxItemId,
    identity.sourceMessageId,
    identity.correction,
  ]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `inspector-turn:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Hashing an idempotent action id yields to the event loop. Recheck the
 * authoritative Inspector fence after that yield and before an IPC effect:
 * a supervisor push may have advanced the provider turn in the meantime.
 */
export async function agentInspectorTurnControlActionIdIfCurrent(
  actionId: Promise<string>,
  isCurrent: () => boolean,
): Promise<string | null> {
  const resolvedActionId = await actionId;
  return isCurrent() ? resolvedActionId : null;
}

function actionAvailability(
  entry: DesktopSupervisorManifestEntry,
  deliveryRetryAvailable: boolean,
  continuationRepairAvailable: boolean,
  roomDeliverySkipAvailable: boolean,
  resourceFreshness: "fresh" | "stale",
  mentionInsertText: string | null,
  turnControl: AgentInspectorTurnControlProjection | null,
): AgentInspectorActionAvailability[] {
  const blockedReceipts = entry.deliveryReceipts?.filter((receipt) =>
    receipt.state === "blocked"
    && receipt.failureCode !== "provider_continuation_missing"
    && Boolean(receipt.sourceMessageId.trim())) ?? [];
  const blockedReceipt = blockedReceipts.length === 1 ? blockedReceipts[0] : null;
  const missingContinuationReceipts = entry.deliveryReceipts?.filter((receipt) =>
    receipt.failureCode === "provider_continuation_missing"
    && ["blocked", "restoring_conversation"].includes(receipt.state)
    && Boolean(receipt.sourceMessageId.trim())) ?? [];
  const missingContinuationReceipt = missingContinuationReceipts.length === 1
    ? missingContinuationReceipts[0]
    : null;
  const recoveryIsActive = missingContinuationReceipt?.state === "restoring_conversation";
  const safeToRestoreOrSkip = Boolean(
    missingContinuationReceipt
    && missingContinuationReceipt.attemptCount === 0
    && !missingContinuationReceipt.providerTurnId,
  );
  const stateDependentActionsAvailable = resourceFreshness === "fresh";
  const canStopTurn = turnControl?.canStop === true;
  return [
    { kind: "mention", label: "Mention", available: entry.desiredState !== "stopped" && Boolean(mentionInsertText) },
    { kind: "pause", label: "Pause", available: stateDependentActionsAvailable && entry.desiredState === "running" },
    { kind: "resume", label: "Resume", available: stateDependentActionsAvailable && entry.desiredState === "paused" },
    { kind: "reconnect", label: "Reconnect", available: stateDependentActionsAvailable && canReconnectRoomAgent(entry) },
    { kind: "recover", label: "Recover", available: stateDependentActionsAvailable && canRecoverSavedRoomAgent(entry) },
    { kind: "stop_turn", label: "Stop current turn", available: stateDependentActionsAvailable && canStopTurn },
    {
      kind: "retry_delivery",
      label: "Retry delivery",
      available: Boolean(stateDependentActionsAvailable && deliveryRetryAvailable && blockedReceipt),
      sourceMessageId: blockedReceipt?.sourceMessageId,
    },
    {
      kind: "restore_conversation",
      label: "Restore and retry",
      available: Boolean(stateDependentActionsAvailable && continuationRepairAvailable && safeToRestoreOrSkip && !recoveryIsActive),
      sourceMessageId: missingContinuationReceipt?.sourceMessageId,
    },
    {
      kind: "skip_message",
      label: "Skip message",
      available: Boolean(stateDependentActionsAvailable && roomDeliverySkipAvailable && safeToRestoreOrSkip && !recoveryIsActive),
      sourceMessageId: missingContinuationReceipt?.sourceMessageId,
    },
    { kind: "retire_agent", label: "Retire agent", available: stateDependentActionsAvailable && entry.desiredState !== "stopped", danger: true },
  ];
}

function continuationRecovery(
  entry: DesktopSupervisorManifestEntry,
  actions: readonly AgentInspectorActionAvailability[],
): AgentInspectorProjection["continuationRecovery"] {
  const receipt = [...(entry.deliveryReceipts ?? [])]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .find((candidate) =>
      candidate.failureCode === "provider_continuation_missing"
      || candidate.timeline.some((event) => event.phase === "conversation_restored"));
  if (!receipt) return null;
  const restored = receipt.timeline.some((event) => event.phase === "conversation_restored");
  const restoring = receipt.state === "restoring_conversation";
  return {
    state: restored && !restoring ? "restored" : restoring ? "restoring" : "failed",
    sourceMessageId: receipt.sourceMessageId,
    detail: restored && !restoring
      ? "The agent’s identity and workspace were preserved, but its earlier private Codex conversation was unavailable."
      : restoring
        ? "The provider remains connected while LetAgents verifies and repairs the missing conversation."
        : "Couldn’t restore this agent’s Codex conversation.",
    canRestore: actions.some((action) => action.kind === "restore_conversation" && action.available),
    canSkip: actions.some((action) => action.kind === "skip_message" && action.available),
  };
}

export function projectAgentInspector(
  entry: DesktopSupervisorManifestEntry,
  options: AgentInspectorProjectionOptions,
): AgentInspectorProjection | null {
  if (!options.roomId || entry.roomId !== options.roomId) return null;
  const overallState = agentInspectorOverallState(entry);
  const presentation = overallPresentation(overallState);
  const now = nowProjection(entry, overallState);
  const resourceFreshness = options.resourceFreshness ?? "fresh";
  const mentionInsertText = options.mentionInsertTextByEntryId?.get(entry.id) ?? null;
  const rawTurnControl = projectAgentInspectorTurnControl(entry);
  // A stale Inspector keeps its last meaningful explanation but never offers a
  // control based on it. The next fresh supervisor projection re-enables it.
  const turnControl = resourceFreshness === "fresh" || !rawTurnControl
    ? rawTurnControl
    : {
      ...rawTurnControl,
      canStop: false,
      canCorrect: false,
      canResolve: false,
      detail: "Live supervisor state is required before this turn can be changed.",
    };
  const actions = actionAvailability(
    entry,
    options.deliveryRetryAvailable ?? false,
    options.continuationRepairAvailable ?? false,
    options.roomDeliverySkipAvailable ?? false,
    resourceFreshness,
    mentionInsertText,
    turnControl,
  );
  return {
    entryId: entry.id,
    roomId: entry.roomId,
    agentKey: entry.agentKey ?? null,
    displayName: supervisedAgentDisplayLabel(entry.displayName, entry.id),
    ownerAttribution: ownerAttribution(entry.createdBy),
    provider: entry.provider,
    model: entry.model,
    charter: entry.charter,
    overallState,
    overallLabel: presentation.label,
    overallDetail: presentation.detail,
    readiness: readiness(entry),
    deliveryProgress: deliveryProgress(
      entry,
      options.deliveryRetryingKeys ?? new Set(),
      now?.kind === "progress" && overallState === "responding",
    ),
    now,
    assignedWork: exactAssignedWork(entry, options.tasks ?? []),
    recentOutcome: recentOutcome(entry),
    continuationRecovery: continuationRecovery(entry, actions),
    turnControl,
    actions,
    mentionInsertText,
    resourceFreshness,
    entry,
  };
}

export function projectAgentInspectors(
  entries: readonly DesktopSupervisorManifestEntry[],
  options: AgentInspectorProjectionOptions,
): AgentInspectorProjection[] {
  return entries
    .map((entry) => projectAgentInspector(entry, options))
    .filter((projection): projection is AgentInspectorProjection => Boolean(projection));
}
