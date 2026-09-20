import type { DesktopMessageInfo, DesktopSupervisorAgentInspectorDetail, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import type { AgentModalTarget } from "../components/desktop/content/desktop-chat-message/types";
import type { MessageIntervention } from "../../../shared/message-outcome";

/** A receipt's durable key can select only one agent in this room, never a matching display name. */
export function messageOutcomeTarget(agent: DesktopMessageInfo["agentsAsked"][number], messageId: string,
  roomId: string, entries: readonly DesktopSupervisorManifestEntry[]): AgentModalTarget | null {
  if (!messageId.trim() || !/[/:]/.test(agent.agentKey)) return null;
  const matches = entries.filter(entry => entry.roomId === roomId && entry.agentKey === agent.agentKey);
  if (matches.length !== 1) return null;
  const entry = matches[0]!;
  return { workSourceMessageId: messageId, messageId: null, clientMessageId: null, messageSource: null,
    actorLabel: agent.actorLabel, displayName: agent.actorLabel, sender: agent.actorLabel,
    ownerAttribution: null, ideLabel: entry.provider, agentKey: entry.agentKey ?? null, agentSessionId: entry.agentSessionId };
}

export function messageTriggerLabel(activation: Record<string, unknown> | null | undefined): string {
  const reasons: Record<string, string> = {
    mention: "Mentioned directly", direct_mention: "Mentioned directly", human_correction: "Human correction",
    everyone: "Message addressed to everyone",
    human_message: "Message from a person", thread_reply: "Reply in an agent’s thread",
    task_continuation: "Continuing assigned work", task_assigned: "Task assigned",
  };
  return typeof activation?.reason === "string" ? reasons[activation.reason] ?? "Room delivery requested a response" : "Room delivery requested a response";
}

export function messageInterventionLabel(control: MessageIntervention): string {
  if (control.operatorResolution === "not_applied") return "Marked as not applied";
  if (control.operatorResolution === "applied") return "Marked as applied";
  if (control.status === "uncertain") return "Delivery is uncertain";
  if (control.status === "retryable") return "Delivery needs retry";
  if (control.status === "prepared") return "Requested";
  if (control.status === "dispatching") return "Being delivered";
  if (control.hasCorrection) return control.resumed ? "Correction delivered · Session resumed" : "Correction delivered";
  return control.interrupted ? "Turn stopped" : "Stop request completed";
}

/** Use only receipt timestamps. Missing boundaries never become zero-second success. */
export function messageOutcomeDuration(detail: DesktopSupervisorAgentInspectorDetail): string | null {
  const start = detail.timeline.find(event => event.phase === "turn_started");
  const finish = [...detail.timeline].reverse().find(event => event.phase === "turn_finished");
  if (!start || !finish) return null;
  const milliseconds = Date.parse(finish.observedAt) - Date.parse(start.observedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 1) return "Under a second";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function messageOutcomeTone(state: string | undefined): "positive" | "attention" | "active" | "neutral" {
  if (state === "acknowledged" || state === "acknowledged_no_reply") return "positive";
  if (state === "blocked" || state === "acknowledged_failed" || state === "result_recovery") return "attention";
  if (["dispatching", "awaiting_result", "publishing"].includes(state ?? "")) return "active";
  return "neutral";
}
