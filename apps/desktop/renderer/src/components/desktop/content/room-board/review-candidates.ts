import type { DesktopAgentPresence, DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import { workLease, reviewLeases } from "./task-state";
import type { ReviewCandidateSelection } from "./types";

export function reviewAssignmentCandidates(
  task: DesktopTaskSummary,
  presence: DesktopAgentPresence[]
): DesktopAgentPresence[] {
  const work = workLease(task);
  const reviews = reviewLeases(task);
  const seen = new Set<string>();
  return presence
    .filter((entry) => {
      if (entry.sessionKind !== "worker") return false;
      if (!entry.agentKey || !entry.agentSessionId) return false;
      if (entry.freshness !== "active" || entry.activityState === "offline") return false;
      if (work?.agentKey && entry.agentKey === work.agentKey) return false;
      if (reviews.some((lease) => lease.agentKey && lease.agentKey === entry.agentKey)) return false;
      const key = reviewCandidateKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function reviewCandidateKey(candidate: DesktopAgentPresence): string {
  return [
    candidate.agentKey || "agent",
    candidate.agentInstanceId || "instance",
    candidate.agentSessionId || candidate.actorLabel,
  ].join(":");
}

export function reviewCandidateValue(candidate: DesktopAgentPresence): string {
  return JSON.stringify({
    agentKey: candidate.agentKey,
    agentInstanceId: candidate.agentInstanceId,
    agentSessionId: candidate.agentSessionId,
  });
}

export function parseReviewCandidateValue(value: string): ReviewCandidateSelection | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      agentKey?: unknown;
      agentInstanceId?: unknown;
      agentSessionId?: unknown;
    };
    const agentKey = typeof parsed.agentKey === "string" ? parsed.agentKey.trim() : "";
    const agentSessionId = typeof parsed.agentSessionId === "string" ? parsed.agentSessionId.trim() : "";
    if (!agentKey || !agentSessionId) return null;
    return {
      agentKey,
      agentInstanceId: typeof parsed.agentInstanceId === "string" && parsed.agentInstanceId.trim()
        ? parsed.agentInstanceId.trim()
        : null,
      agentSessionId,
    };
  } catch {
    return null;
  }
}

export function reviewCandidateLabel(candidate: DesktopAgentPresence): string {
  const sessionSuffix = candidate.agentSessionId ? candidate.agentSessionId.slice(-6) : "session";
  return `${candidate.displayName} (${sessionSuffix})`;
}
