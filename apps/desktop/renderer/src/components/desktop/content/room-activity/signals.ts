import type { DesktopAgentPresence } from "../../../../../../electron/ipc-types";
import { timestampValue } from "../../../../domain/time";
import { RECENT_SIGNAL_WINDOW_MS } from "./constants";
import { livenessCapabilityLabel } from "./formatters";
import type { ActivityParticipant, ActivityState } from "./types";

export function isReachablePresence(presence: DesktopAgentPresence): boolean {
  return presence.sessionKind === "worker" && presence.sourceFlags.includes("delivery") && presence.freshness === "active";
}

export function isReachableParticipant(participant: ActivityParticipant): boolean {
  return participant.kind === "agent" && (participant.activityState === "active" || participant.activityState === "away");
}

export function hasDeliverySignal(participant: ActivityParticipant): boolean {
  return participant.sources.includes("delivery") || participant.sources.includes("desktop delivery");
}

export function hasRecentLivenessObservation(participant: ActivityParticipant): boolean {
  return isRecentTimestamp(participant.livenessObservation?.lastObservedAt);
}

export function hasAgentSignal(participant: ActivityParticipant): boolean {
  if (participant.kind !== "agent") return false;
  if (participant.livenessObservation && hasRecentLivenessObservation(participant)) return true;
  if ((participant.workState || participant.statusText) && isRecentTimestamp(participant.lastSeenAt)) return true;
  if (participant.activeReasoning.some((session) => isRecentTimestamp(session.updatedAt || session.createdAt))) return true;
  return participant.currentTasks.some((task) => isRecentTimestamp(task.updatedAt));
}

export function signalLabel(participant: ActivityParticipant): string {
  if (participant.workLabel) return participant.workLabel;
  if (participant.livenessObservation && hasRecentLivenessObservation(participant)) {
    return livenessCapabilityLabel(participant.livenessObservation.livenessCapability);
  }
  if (participant.statusText) return "Status";
  return "Signal";
}

export function workSignalFrom(
  presence: DesktopAgentPresence | null,
  statusText: string | null,
  currentTaskCount: number,
  reasoningCount: number,
): { state: string; label: string } | null {
  if (presence?.status === "blocked") return { state: "blocked", label: "Blocked" };
  if (presence?.status === "reviewing") return { state: "reviewing", label: "Reviewing" };
  if (presence?.status === "working") return { state: "working", label: statusText ? "Working" : "In progress" };
  if (reasoningCount > 0) return { state: "responding", label: "Reasoning" };
  if (currentTaskCount > 0) return { state: "working", label: "Assigned" };
  return null;
}

export function resolveActivityState(
  participant: { hiddenAt: string | null; activityState: ActivityState | null } | null,
  presence: DesktopAgentPresence | null,
): ActivityState {
  if (presence && isReachablePresence(presence)) {
    return presence.status === "idle" ? "away" : "active";
  }
  if (participant?.hiddenAt) return "offline";
  if (presence?.activityState) return presence.activityState;
  return participant?.activityState || "offline";
}

export function connectionLabel(participant: ActivityParticipant): string {
  if (participant.kind === "human") return "human";
  if (participant.activityState === "active") return "connected";
  if (participant.activityState === "away") return "idle";
  if (hasAgentSignal(participant)) return "signal only";
  return "offline";
}

export function connectionTone(participant: ActivityParticipant): string {
  if (participant.kind === "human") return "human";
  if (participant.activityState === "active") return "active";
  if (participant.activityState === "away") return "away";
  if (hasAgentSignal(participant)) return "signal";
  return "offline";
}

export function sourceBadges(participant: ActivityParticipant): Array<{ label: string; active: boolean }> {
  const sources = new Set(participant.sources);
  return [
    { label: "Delivery", active: sources.has("delivery") || sources.has("desktop delivery") },
    { label: "Presence", active: sources.has("presence") },
    { label: "Session", active: sources.has("session liveness") },
    { label: "Messages", active: sources.has("messages") },
    { label: "Tasks", active: sources.has("tasks") },
    { label: "Local app", active: sources.has("local worker") },
  ];
}

function isRecentTimestamp(value: string | null | undefined): boolean {
  const signalTime = timestampValue(value);
  return signalTime >= 0 && Date.now() - signalTime <= RECENT_SIGNAL_WINDOW_MS;
}
