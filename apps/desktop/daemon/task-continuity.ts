import { NO_REPLY_FAILURE, noReplyFailureKind } from "../../../shared/room-turn-no-reply.mjs";

/** A snapshot of work already owned by the exact worker, never a new claim. */
export type ContinuityTask = { id: string; title: string; leaseId: string; epoch: number };
export type TaskContinuation = {
  parentId: string; attempt: number;
  workAttemptId: string; providerContinuationId: string; agentSessionId: string;
  heldBefore: string;
  tasks: ContinuityTask[] | null;
};

export type TaskFailurePolicy = {
  automatic: boolean;
  detail: string;
  /** Stop without a follow-up and without blocking the queue; `detail` is kept on the failed message. */
  settle?: true;
  /** Added to the follow-up prompt so the next turn can avoid the same failure. */
  note?: string;
};

export function taskFailurePolicy(error: string | null, attempt: number, refusal = false): TaskFailurePolicy {
  // The provider declined the turn's content. Retry delivery cannot change
  // that and a follow-up would send the same context again, so stop without a
  // follow-up and without blocking: the provider's reason stays on the
  // message and later messages go ahead. A failure the owner can clear, such
  // as credit or a key, still blocks below, because Retry delivery is then
  // how the held task resumes.
  if (refusal) {
    return { automatic: false, settle: true, detail: `${error?.trim() || "The model provider refused this turn."} The unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` };
  }
  const retry = "Resolve this issue, then use Retry delivery to continue the existing task.";
  if (/\b402\b|insufficient.{0,30}(?:credit|balance|quota)|(?:account|credit).{0,60}(?:output budget|exhausted)|(?:usage|spend|credit) limit|quota[ _-](?:exhausted|reached|exceeded)/i.test(error ?? "")) {
    return { automatic: false, detail: `The model provider has insufficient credit or quota. ${retry}` };
  }
  if (/\b40[13]\b|unauthorized|invalid api key|authentication|sign[ -]?in required|access.{0,15}denied/i.test(error ?? "")) {
    return { automatic: false, detail: `The model provider needs authentication or account access. ${retry}` };
  }
  // The turn finished without an answer. That usually repeats, so allow one
  // follow-up turn (never a replay), then stop without blocking later messages.
  const noReply = noReplyFailureKind(error);
  if (noReply === "contentFilter") {
    return { automatic: false, settle: true, detail: `${NO_REPLY_FAILURE.contentFilter} The unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` };
  }
  if (noReply) {
    if (attempt > 1) {
      return { automatic: false, settle: true, detail: `${NO_REPLY_FAILURE[noReply]} It happened again, so the unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` };
    }
    return { automatic: true, detail: "The model stopped before writing a reply. Continuing the unfinished task after a short delay.",
      note: noReply === "outputLimit"
        ? "Your previous turn hit the model's output limit before it wrote a reply. Keep replies short and split large tool calls."
        : noReply === "deniedTool"
          ? "In your previous turn a tool call was denied, so it did not run, and the turn ended before you replied. Do not run it again. Continue without it, or say in your reply why you need it. End this turn with a short reply."
          : "Your previous turn ended without a reply. End this turn with a short reply." };
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
