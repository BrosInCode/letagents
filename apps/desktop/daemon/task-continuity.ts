/** A snapshot of work already owned by the exact worker, never a new claim. */
export type ContinuityTask = { id: string; title: string; leaseId: string; epoch: number };
export type TaskContinuation = {
  parentId: string; attempt: number;
  workAttemptId: string; providerContinuationId: string; agentSessionId: string;
  heldBefore: string;
  tasks: ContinuityTask[] | null;
};

export function taskFailurePolicy(error: string | null, attempt: number): { automatic: boolean; detail: string } {
  const retry = "Resolve this issue, then use Retry delivery to continue the existing task.";
  if (/\b402\b|insufficient.{0,30}(?:credit|balance|quota)|(?:account|credit).{0,60}(?:output budget|exhausted)|(?:usage|spend|credit) limit|quota[ _-](?:exhausted|reached|exceeded)/i.test(error ?? "")) {
    return { automatic: false, detail: `The model provider has insufficient credit or quota. ${retry}` };
  }
  if (/\b40[13]\b|unauthorized|invalid api key|authentication|sign[ -]?in required|access.{0,15}denied/i.test(error ?? "")) {
    return { automatic: false, detail: `The model provider needs authentication or account access. ${retry}` };
  }
  if (attempt > 3) return { automatic: false, detail: `Automatic task recovery stopped after three continuations. Check the provider, then use Retry delivery. Existing work is preserved.` };
  if (/\b(?:429|500|502|503|504|529)\b|rate.?limit|temporar(?:y|ily)|overloaded|service unavailable|connection reset|ECONNRESET|ETIMEDOUT|socket closed|network error/i.test(error ?? "")) {
    return { automatic: true, detail: "The provider failed temporarily. Continuing the unfinished task after a short delay." };
  }
  return { automatic: false, detail: `The provider failed and safe automatic recovery could not be established. ${retry}` };
}

/** Parsing is not authorization; the inbox store also checks the durable parent. */
export function parseTaskContinuation(value: unknown): TaskContinuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  for (const key of ["parentId", "workAttemptId", "providerContinuationId", "agentSessionId"]) {
    if (typeof row[key] !== "string" || !row[key].trim()) return null;
  }
  if (!Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1 || typeof row.heldBefore !== "string" || !Number.isFinite(Date.parse(row.heldBefore))
    || (row.tasks !== null && (!Array.isArray(row.tasks) || row.tasks.length > 100))) return null;
  if (row.tasks !== null && !(row.tasks as unknown[]).every((task: unknown) => {
    if (!task || typeof task !== "object") return false;
    const t = task as Record<string, unknown>;
    return typeof t.id === "string" && !!t.id && typeof t.title === "string"
      && typeof t.leaseId === "string" && !!t.leaseId && Number.isSafeInteger(t.epoch) && Number(t.epoch) >= 0;
  })) return null;
  return row as unknown as TaskContinuation;
}
