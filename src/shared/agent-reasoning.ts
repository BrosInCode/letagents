export interface AgentReasoningTrace {
  summary: string;
  goal: string | null;
  hypothesis: string | null;
  checking: string | null;
  next_action: string | null;
  blocker: string | null;
  confidence: number | null;
}

const MAX_REASONING_TEXT_LENGTH = 280;

function normalizeReasoningText(value: unknown): string | null {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, MAX_REASONING_TEXT_LENGTH);
}

function normalizeReasoningConfidence(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.min(1, Math.max(0, Math.round(numeric * 100) / 100));
}

export function normalizeAgentReasoningTrace(value: unknown): AgentReasoningTrace | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const goal = normalizeReasoningText(record.goal);
  const hypothesis = normalizeReasoningText(record.hypothesis);
  const checking = normalizeReasoningText(record.checking);
  const nextAction = normalizeReasoningText(record.next_action);
  const blocker = normalizeReasoningText(record.blocker);
  const summary = normalizeReasoningText(record.summary)
    || goal
    || nextAction
    || checking
    || hypothesis
    || blocker;

  if (!summary) {
    return null;
  }

  return {
    summary,
    goal,
    hypothesis,
    checking,
    next_action: nextAction,
    blocker,
    confidence: normalizeReasoningConfidence(record.confidence),
  };
}
