import type {
  DesktopSupervisorManifestEntry,
  DesktopSupervisorObservedState,
  DesktopSupervisorServiceSnapshot,
} from "../../../electron/ipc-types";
import type { DesktopHostApproval } from "../../../shared/host-approvals";
import { agentInspectorOverallState } from "./agent-inspector";
import { sanitizeAgentInspectorDiagnosticsValue } from "./agent-inspector-diagnostics";

export interface ServiceHealthAgent {
  entryId: string;
  roomId: string;
  roomName: string;
  displayName: string;
  stateLabel: string;
  lastActivityAt: string | null;
  messagesWaiting: number | null;
  approvalsWaiting: number | null;
  needsAttention: boolean;
  detail: string | null;
}

export interface ServiceHealthProjection {
  service: { stateLabel: string; version: string | null; startedAt: string | null; recoveryLabel: string | null };
  counts: { total: number; running: number; paused: number; stopped: number; needsAttention: number } | null;
  agents: ServiceHealthAgent[];
}

export interface ServiceHealthEvent { id: string; observedAt: string; summary: string }
export const SERVICE_HEALTH_EVENT_LIMIT = 20;

const stateLabels: Record<DesktopSupervisorObservedState, string> = {
  absent: "Not running", starting: "Starting", idle: "Idle", working: "Working",
  checkpointing: "Saving progress", pausing: "Pausing", paused: "Paused",
  recovering: "Recovering", stopping: "Stopping", stopped: "Stopped", failed: "Failed",
};

function safeText(value: string): string {
  return String(sanitizeAgentInspectorDiagnosticsValue(value).value ?? "");
}

function validTimestamp(value: string | null | undefined): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function lastActivityAt(entry: DesktopSupervisorManifestEntry): string | null {
  // Heartbeats and binding refreshes are not work. Retained activity and
  // message receipts are the only timestamps shown as agent activity.
  return [...entry.activity.map(event => event.observedAt),
    ...(entry.deliveryReceipts ?? []).map(receipt => receipt.updatedAt)]
    .filter(validTimestamp).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export function projectServiceHealth(snapshot: DesktopSupervisorServiceSnapshot, options: {
  approvals?: readonly DesktopHostApproval[];
  /** Rooms whose approval reads succeeded; omitted means approvals cover every room. */
  approvalRooms?: ReadonlySet<string>;
  roomNames?: ReadonlyMap<string, string>;
} = {}): ServiceHealthProjection {
  const { status } = snapshot;
  const state = status && snapshot.state?.daemonGeneration === status.generation ? snapshot.state : null;
  const service: ServiceHealthProjection["service"] = {
    stateLabel: !status ? "Not connected" : status.maintenanceHoldId ? "Under maintenance" : status.healthy ? "Running" : "Needs attention",
    version: status ? safeText(status.implementationVersion) : null,
    startedAt: validTimestamp(status?.startedAt) ? status.startedAt : null,
    recoveryLabel: null,
  };
  if (!state) return { service, counts: null, agents: [] };

  const approvals = new Map<string, Set<string>>();
  for (const approval of options.approvals ?? []) {
    if (approval.status !== "pending" && approval.status !== "decision_recorded") continue;
    const ids = approvals.get(approval.presentation.agentId) ?? new Set<string>();
    ids.add(approval.requestKey ?? approval.id);
    approvals.set(approval.presentation.agentId, ids);
  }
  const agents = state.entries.map((entry): ServiceHealthAgent => {
    const approvalsWaiting = options.approvals === undefined
      || (options.approvalRooms && !options.approvalRooms.has(entry.roomId))
      ? null : approvals.get(entry.id)?.size ?? 0;
    const pending = entry.roomAgentState?.inbox.pendingCount;
    const messagesWaiting = pending !== undefined && Number.isSafeInteger(pending) && pending >= 0 ? pending : null;
    const needsAttention = agentInspectorOverallState(entry) === "needs_attention" || (approvalsWaiting ?? 0) > 0;
    const detail = entry.lastError || entry.roomAgentState?.inbox.detail || entry.roomAgentState?.connection.detail;
    return {
      entryId: entry.id, roomId: entry.roomId,
      roomName: safeText(options.roomNames?.get(entry.roomId) || entry.roomId),
      displayName: safeText(entry.displayName || entry.id),
      stateLabel: stateLabels[entry.observedState], lastActivityAt: lastActivityAt(entry),
      messagesWaiting, approvalsWaiting, needsAttention,
      detail: detail ? safeText(detail) : null,
    };
  }).sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention)
    || (b.messagesWaiting ?? 0) - (a.messagesWaiting ?? 0)
    || (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0)
    || a.displayName.localeCompare(b.displayName) || a.entryId.localeCompare(b.entryId));
  const counts = { total: state.entries.length, running: 0, paused: 0, stopped: 0,
    needsAttention: agents.filter(agent => agent.needsAttention).length };
  for (const entry of state.entries) counts[entry.desiredState] += 1;
  const recovering = state.entries.filter(entry => entry.desiredState === "running"
    && (entry.observedState === "recovering" || Boolean(entry.runtimeRecovery)
      || ["recovering", "restoring_conversation"].includes(agentInspectorOverallState(entry)))).length;
  if (recovering > 0) {
    service.recoveryLabel = `${recovering} of ${counts.running} running agents ${recovering === 1 ? "is" : "are"} recovering.`;
  }
  return { service, counts, agents };
}

/** Session observations only. This is not a projection of the daemon audit log. */
export function updateServiceEvents(
  previous: DesktopSupervisorServiceSnapshot | null,
  next: DesktopSupervisorServiceSnapshot,
  previousEvents: readonly ServiceHealthEvent[] = [],
): ServiceHealthEvent[] {
  const events = [...previousEvents];
  const add = (id: string, observedAt: string, summary: string) => {
    if (!events.some(event => event.id === id)) events.unshift({ id, observedAt, summary });
  };
  if (next.status) {
    const generation = next.status.generation;
    if (validTimestamp(next.status.startedAt)) {
      add(`started:${generation}:${next.status.startedAt}`, next.status.startedAt, "Background service started.");
    }
    if (previous?.status && previous.status.generation !== generation) {
      add(`restart:${generation}:${next.observedAt}`, next.observedAt, "Background service restarted.");
    } else if (previous && !previous.status) {
      add(`connected:${generation}:${next.observedAt}`, next.observedAt, "Connected to the background service.");
    }
  } else if (previous?.status) {
    add(`disconnected:${next.observedAt}`, next.observedAt, "Lost contact with the background service.");
  }
  return events.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, SERVICE_HEALTH_EVENT_LIMIT);
}
