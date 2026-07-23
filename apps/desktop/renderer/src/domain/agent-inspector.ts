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

export type AgentInspectorActionKind =
  | "mention"
  | "pause"
  | "resume"
  | "reconnect"
  | "recover"
  | "stop_turn"
  | "retry_delivery"
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
  presentation?: "wide" | "compact";
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
  now: AgentInspectorNowProjection | null;
  assignedWork: AgentInspectorTaskProjection[];
  recentOutcome: { label: string; observedAt: string } | null;
  actions: AgentInspectorActionAvailability[];
  mentionInsertText: string | null;
  resourceFreshness: "fresh" | "stale";
  entry: DesktopSupervisorManifestEntry;
}

export interface AgentInspectorProjectionOptions {
  roomId: string | null;
  tasks?: readonly DesktopTaskSummary[];
  deliveryRetryAvailable?: boolean;
  resourceFreshness?: "fresh" | "stale";
  mentionInsertTextByEntryId?: ReadonlyMap<string, string>;
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
    : inbox?.state === "queued" ? "waiting" : inbox ? "ready" : "offline";
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
      value: inbox ? `${titleCase(inbox.state)}${inbox.pendingCount ? ` · ${inbox.pendingCount}` : ""}` : "Unavailable",
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
    return {
      kind: "progress",
      label: "Now",
      summary: latest
        ? humanFacingSupervisorActivitySummary(latest)
        : entry.roomAgentState?.turn.detail || "Working on the room message",
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
  };
  return { label: labels[receipt.state] ?? titleCase(receipt.state), observedAt: receipt.updatedAt };
}

function actionAvailability(
  entry: DesktopSupervisorManifestEntry,
  deliveryRetryAvailable: boolean,
  resourceFreshness: "fresh" | "stale",
  mentionInsertText: string | null,
): AgentInspectorActionAvailability[] {
  const blockedReceipts = entry.deliveryReceipts?.filter((receipt) =>
    receipt.state === "blocked" && Boolean(receipt.sourceMessageId.trim())) ?? [];
  const blockedReceipt = blockedReceipts.length === 1 ? blockedReceipts[0] : null;
  const stateDependentActionsAvailable = resourceFreshness === "fresh";
  const canStopTurn = entry.desiredState === "running"
    && entry.condition === "none"
    && entry.agentSessionBindingState === "active"
    && entry.roomAgentState?.turn.state === "responding"
    && Boolean(entry.workAttemptId && entry.executionGenerationId && entry.providerContinuationId)
    && !entry.turnControl;
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
    { kind: "retire_agent", label: "Retire agent", available: stateDependentActionsAvailable && entry.desiredState !== "stopped", danger: true },
  ];
}

export function projectAgentInspector(
  entry: DesktopSupervisorManifestEntry,
  options: AgentInspectorProjectionOptions,
): AgentInspectorProjection | null {
  if (!options.roomId || entry.roomId !== options.roomId) return null;
  const overallState = agentInspectorOverallState(entry);
  const presentation = overallPresentation(overallState);
  const resourceFreshness = options.resourceFreshness ?? "fresh";
  const mentionInsertText = options.mentionInsertTextByEntryId?.get(entry.id) ?? null;
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
    now: nowProjection(entry, overallState),
    assignedWork: exactAssignedWork(entry, options.tasks ?? []),
    recentOutcome: recentOutcome(entry),
    actions: actionAvailability(entry, options.deliveryRetryAvailable ?? false, resourceFreshness, mentionInsertText),
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
