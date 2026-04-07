import type { AgentPresenceStatus } from "../shared/agent-presence.js";

const IDLE_STATUS_RE = /\b(idle|available|online|polling|monitoring|watching|ready)\b/i;
const REVIEWING_STATUS_RE = /\b(review|reviewing|approve|approval|approving)\b/i;
const BLOCKED_STATUS_RE = /\b(blocked|waiting|stuck)\b/i;

export function classifyPresenceStatusText(
  statusText: string,
  fallback: AgentPresenceStatus = "working"
): AgentPresenceStatus {
  const normalized = statusText.trim();
  if (!normalized) {
    return fallback;
  }

  if (BLOCKED_STATUS_RE.test(normalized)) {
    return "blocked";
  }

  if (IDLE_STATUS_RE.test(normalized)) {
    return "idle";
  }

  if (REVIEWING_STATUS_RE.test(normalized)) {
    return "reviewing";
  }

  return "working";
}

export function deriveTaskPresenceStatus(
  taskStatus: string | null | undefined,
  fallback: AgentPresenceStatus = "working"
): AgentPresenceStatus {
  switch (taskStatus) {
    case "blocked":
      return "blocked";
    case "in_review":
      return "reviewing";
    case "merged":
    case "done":
    case "accepted":
      return "idle";
    case "assigned":
    case "in_progress":
      return "working";
    default:
      return fallback;
  }
}
