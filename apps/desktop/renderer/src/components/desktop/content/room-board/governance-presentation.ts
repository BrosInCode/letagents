import type {
  DesktopAgentPresence,
  DesktopBoardGovernanceAuditEntry,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardIntentSummary,
  DesktopBoardManagerMode,
  DesktopBoardManagerRuntimeSource,
} from "../../../../../../electron/ipc-types";
import { formatFullTimestamp } from "../../../../domain/time";

export interface LiveManagerCandidate {
  agentSessionId: string;
  actorLabel: string;
  displayName: string;
  runtime: string;
  runtimeSource: DesktopBoardManagerRuntimeSource | null;
  isActiveManager: boolean;
}

export function activeBoardManagerAgents(
  presenceEntries: DesktopAgentPresence[]
): DesktopAgentPresence[] {
  const seenSessionIds = new Set<string>();
  const agents: DesktopAgentPresence[] = [];
  for (const presence of presenceEntries) {
    if (
      presence.sessionKind !== "worker"
      || !presence.agentSessionId
      || presence.freshness !== "active"
      || presence.activityState === "offline"
      || seenSessionIds.has(presence.agentSessionId)
    ) {
      continue;
    }
    seenSessionIds.add(presence.agentSessionId);
    agents.push(presence);
  }
  return agents;
}

export function readableManagerRuntime(
  runtimeSource: string | null | undefined
): string {
  if (runtimeSource === "open_model") return "Open model";
  if (runtimeSource === "desktop_managed") return "Desktop managed";
  if (runtimeSource === "external") return "External";
  if (runtimeSource === "unknown") return "Unknown";
  return "Worker";
}

export function readableManagerMode(mode: DesktopBoardManagerMode): string {
  if (mode === "intent_required") return "Approval required";
  if (mode === "manager_optional") return "Manager optional";
  return "Off";
}

export function readableIntentAction(actionType: string): string {
  return actionType.replace(/^task_/, "").replaceAll("_", " ");
}

export function liveManagerCandidates(
  governance: DesktopBoardGovernanceSnapshot,
  liveAgents: DesktopAgentPresence[]
): LiveManagerCandidate[] {
  const governanceCandidates = new Map(
    governance.candidates.map((candidate) => [candidate.agentSessionId, candidate])
  );
  return liveAgents
    .filter((agent) => Boolean(agent.agentSessionId))
    .map((agent) => {
      const agentSessionId = agent.agentSessionId as string;
      const candidate = governanceCandidates.get(agentSessionId);
      return {
        agentSessionId,
        actorLabel: candidate?.actorLabel || agent.actorLabel,
        displayName: candidate?.displayName || agent.displayName,
        runtime: candidate?.runtime || agent.runtime,
        runtimeSource: candidate?.runtimeSource || null,
        isActiveManager: candidate?.isActiveManager
          || governance.activeManager?.agentSessionId === agentSessionId
          || false,
      };
    });
}

export function managerCandidateName(candidate: LiveManagerCandidate): string {
  const displayName = candidate.displayName.trim();
  const actorLabel = candidate.actorLabel.trim();
  const shortActorLabel = actorLabel.split("|")[0]?.trim() || actorLabel;
  if (displayName && displayName !== actorLabel) return displayName;
  return shortActorLabel || displayName || "Agent";
}

export function managerCandidateRuntime(candidate: LiveManagerCandidate): string {
  const fallback = readableManagerRuntime(candidate.runtimeSource);
  const runtime = candidate.runtime
    .trim()
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ");
  if (!runtime) return fallback;
  const compactRuntime = runtime.replace(/\s+Room\s+[a-f0-9\s-]+$/i, "").trim();
  const primaryRuntime = compactRuntime.split(":")[0]?.trim() || compactRuntime;
  const lowerRuntime = primaryRuntime.toLowerCase();
  if (lowerRuntime.includes("claude")) return "Claude Code";
  if (lowerRuntime.includes("cursor")) return "Cursor";
  if (lowerRuntime.includes("codex")) return "Codex";
  if (lowerRuntime.includes("open model")) return "Open Model";
  if (lowerRuntime === "agent" || lowerRuntime === "worker") return fallback;
  return primaryRuntime
    .split(" ")
    .filter(Boolean)
    .map((part) => part.length <= 2
      ? part.toUpperCase()
      : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function managerCandidateInitial(candidate: LiveManagerCandidate): string {
  return managerCandidateName(candidate).trim().charAt(0).toUpperCase() || "A";
}

export function activeManagerLabel(
  governance: DesktopBoardGovernanceSnapshot | null
): string | null {
  if (!governance?.activeManager) return null;
  return managerCandidateName({
    agentSessionId: governance.activeManager.agentSessionId,
    actorLabel: governance.activeManager.actorLabel,
    displayName: governance.activeManager.actorLabel,
    runtime: "",
    runtimeSource: governance.activeManager.runtimeSource,
    isActiveManager: true,
  });
}

function payloadText(intent: DesktopBoardIntentSummary, key: string): string | null {
  const value = intent.payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readableIntentTitle(intent: DesktopBoardIntentSummary): string {
  return intent.actionType === "task_create"
    ? "Create task"
    : readableIntentAction(intent.actionType);
}

export function readableIntentBody(intent: DesktopBoardIntentSummary): string {
  if (intent.actionType === "task_create") {
    const title = payloadText(intent, "title");
    const description = payloadText(intent, "description");
    return description ? `${title || "Untitled task"} — ${description}` : title || "Untitled task";
  }
  const taskId = payloadText(intent, "task_id") || intent.taskId || "task";
  const status = payloadText(intent, "status");
  const assignee = payloadText(intent, "assignee");
  const prUrl = payloadText(intent, "pr_url");
  if (intent.actionType === "task_claim") {
    return assignee ? `Assign ${taskId} to ${assignee}` : `Claim ${taskId}`;
  }
  if (intent.actionType === "task_close") {
    const statusText = status ? `Move ${taskId} to ${status}` : `Close ${taskId}`;
    return prUrl ? `${statusText} with ${prUrl}` : statusText;
  }
  if (intent.actionType === "task_update") {
    return status ? `Update ${taskId} to ${status}` : `Update ${taskId}`;
  }
  if (intent.actionType === "task_override") {
    const action = payloadText(intent, "action");
    const target = payloadText(intent, "target_actor_key");
    if (action === "handoff") return target ? `Hand off ${taskId} to ${target}` : `Hand off ${taskId}`;
    if (action === "release") return `Release work on ${taskId}`;
    return `Change work lease for ${taskId}`;
  }
  return "Review the requested board change.";
}

export function approveIntentLabel(intent: DesktopBoardIntentSummary): string {
  return intent.actionType === "task_create" ? "Create task" : "Approve";
}

export function readableAuditEvent(entry: DesktopBoardGovernanceAuditEntry): string {
  return entry.eventType === "board_intent_task_created"
    ? "Task created"
    : entry.eventType.replaceAll("_", " ");
}

export function auditResultText(entry: DesktopBoardGovernanceAuditEntry): string | null {
  const taskId = entry.metadata?.task_id;
  return entry.eventType === "board_intent_task_created" && typeof taskId === "string"
    ? `Created ${taskId}`
    : null;
}

export function governanceTimestamp(value: string | null | undefined): string {
  return formatFullTimestamp(value);
}
