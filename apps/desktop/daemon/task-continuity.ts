import { NO_REPLY_FAILURE, noReplyFailureKind } from "../../../shared/room-turn-no-reply.mjs";

/** A snapshot of work already owned by the exact worker, never a new claim. */
export type ContinuityTask = { id: string; title: string; leaseId: string; epoch: number };
/**
 * What a follow-up is for. A short provider fault gets up to three automatic attempts. A turn that ended without
 * a reply gets one. The owner is told which it is, so the daemon saves it with the follow-up: nothing reads it back
 * from the follow-up's text.
 */
export type FollowUpKind = "provider_fault" | "no_reply";
export type TaskContinuation = {
  parentId: string; attempt: number;
  workAttemptId: string; providerContinuationId: string; agentSessionId: string;
  heldBefore: string;
  tasks: ContinuityTask[] | null;
  /** Absent on a follow-up that an earlier daemon made. */
  kind?: FollowUpKind;
};

export type TaskFailurePolicy = {
  automatic: boolean;
  detail: string;
  /** Stop without a follow-up and without blocking the queue; `detail` is kept on the failed message. */
  settle?: true;
  /** Added to the follow-up prompt so the next turn can avoid the same failure. */
  note?: string;
  /** How long an automatic follow-up waits before it starts. Without it, `defaultFollowUpDelayMs` says. */
  delayMs?: number;
  /** What an automatic follow-up is for. */
  kind?: FollowUpKind;
};

/** How many follow-ups a failed task turn gets by itself. After the last of them the follow-up waits for the owner. */
export const MAX_AUTOMATIC_FOLLOW_UPS = 3;
/**
 * What a scheduled follow-up says while it waits, after a turn that ended without a reply. Such a turn gets one
 * automatic attempt and no more; what the owner is shown reads this text to tell it from a provider fault.
 */
export const NO_REPLY_FOLLOW_UP_DETAIL = "The model stopped before writing a reply. The agent will try again once, after a short wait.";
/** What the follow-up says that waits for the owner after the last automatic attempt failed. */
export const AUTOMATIC_ATTEMPTS_FAILED_DETAIL = "All three automatic attempts failed. The agent now waits for you: check the provider, then use Retry delivery to try again. Existing work is preserved.";
/** What a follow-up says when its owner cannot be sure of the task: its tasks could not be read, at the start or just before it was to run. */
export const OWNERSHIP_UNVERIFIED_DETAIL = "Task ownership could not be verified. Check the room connection before continuing work.";
export const OWNERSHIP_UNVERIFIED_BEFORE_START_DETAIL = "Task ownership could not be verified. Check the room connection and use Retry delivery.";
/**
 * Why a follow-up ended with nothing started. The owner reads these on the room message.
 * `stoppedByOwner` is for an attempt that still waited for its time. `skippedByOwner` is for a follow-up that was
 * blocked, whatever blocked it: no attempt waited, so it says only what Skip did and what Skip leaves as it is.
 */
export const FOLLOW_UP_ENDED = {
  stoppedByOwner: "You stopped the automatic attempts. The task is still assigned to this agent. Send it a message to continue.",
  skippedByOwner: "You skipped the next attempt, and the task and its work lease are left as they are.",
  agentChanged: "The agent did not try again: its session, conversation or workspace changed after the failure. Send it a message to continue the task.",
  taskNotHeld: "The agent did not try again: the task is finished, or is no longer this agent's.",
  uncertainEffects: "The agent did not try again: an earlier action has an uncertain result. Check what it did (the inspector shows its actions), then tell it to continue only the verified work.",
} as const;
/**
 * What the daemon wrote before for these, on a follow-up that an earlier version made. They are read, and not written.
 * The old text of Skip said that the agent did not try again, which is not always known.
 */
const LEGACY_ENDED_TEXTS: ReadonlyArray<readonly [string, "uncertain_action" | "skipped"]> = [
  ["The agent did not try again: an earlier action has an uncertain result. The agent's inspector lists it. Check it, then send an instruction to continue only the verified work.", "uncertain_action"],
  ["The agent did not try again: an earlier action has an uncertain result. Check that result, then send an instruction to continue only the verified unfinished work.", "uncertain_action"],
  ["You skipped the next attempt, so the agent did not try again. The task and its work lease are left as they are.", "skipped"],
];
/**
 * What the receipt of a follow-up says when it ended because of an uncertain result that the daemon's record no longer
 * has as uncertain: every action of that turn has since completed or failed. It asks the owner nothing.
 */
export const FOLLOW_UP_UNCERTAIN_RESOLVED_DETAIL = "The agent did not try again: an earlier action had an uncertain result, and that result is now known.";
/**
 * The reasons of an ended follow-up whose note asks its owner to send a message. Such a note goes when the owner has done it: when
 * the agent has run a turn for a message of a person that came after the follow-up. A turn for any other message does not show it.
 */
export const FOLLOW_UP_REASONS_THAT_ASK_THE_OWNER = new Set<string>(["stopped_by_owner", "agent_changed"]);
/**
 * Why a follow-up that does not wait for its time stands as it does: a small closed set, which the receipt carries so
 * that nothing has to read it back from the text. A follow-up that ended with nothing started has one of the first
 * six. One that waits for its owner has one of the last three. `other` is any block that has no reason of its own:
 * the follow-up's text says what it is. `uncertain_action` is sent only while an action of the failed turn is still
 * uncertain in the daemon's record; the daemon has no control for the owner to resolve it, and it leaves that state
 * only when the action's own completion is recorded, which then makes the reason `uncertain_resolved`.
 */
export const FOLLOW_UP_REASONS = ["stopped_by_owner", "skipped", "agent_changed", "task_not_held", "uncertain_action", "uncertain_resolved", "attempts_failed", "ownership_unverified", "other"] as const;
export type FollowUpReason = (typeof FOLLOW_UP_REASONS)[number];
const ENDED_REASON_OF_TEXT: ReadonlyMap<string, FollowUpReason> = new Map<string, FollowUpReason>([
  [FOLLOW_UP_ENDED.stoppedByOwner, "stopped_by_owner"], [FOLLOW_UP_ENDED.skippedByOwner, "skipped"], [FOLLOW_UP_ENDED.agentChanged, "agent_changed"],
  [FOLLOW_UP_ENDED.taskNotHeld, "task_not_held"], [FOLLOW_UP_ENDED.uncertainEffects, "uncertain_action"], ...LEGACY_ENDED_TEXTS,
]);
/** The reason that a follow-up ended with nothing started, from the text that the daemon wrote for it. Null for any other text. */
export function endedFollowUpReason(text: string | null): FollowUpReason | null {
  return ENDED_REASON_OF_TEXT.get(text ?? "") ?? null;
}
/** The reason that a follow-up waits for its owner. */
export function blockedFollowUpReason(text: string | null): FollowUpReason {
  return text === AUTOMATIC_ATTEMPTS_FAILED_DETAIL ? "attempts_failed"
    : text === OWNERSHIP_UNVERIFIED_DETAIL || text === OWNERSHIP_UNVERIFIED_BEFORE_START_DETAIL ? "ownership_unverified" : "other";
}
/**
 * How long each follow-up waits after a short provider fault: a rate limit, a
 * server error, an overloaded provider, a lost connection. Such a fault often
 * lasts minutes, so the waits grow: 30 seconds, 2 minutes, 10 minutes.
 */
export const SHORT_FAULT_FOLLOW_UP_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;
/** The wait of a first follow-up that has no schedule of its own, as after a turn that ended without a reply. */
export const FIRST_FOLLOW_UP_DELAY_MS = 10_000;
/** No such follow-up waits longer than this. */
export const LONGEST_DEFAULT_FOLLOW_UP_DELAY_MS = 60_000;
/** A follow-up with no schedule of its own waits 10, 20, then 40 seconds. */
export function defaultFollowUpDelayMs(attempt: number): number {
  return Math.min(LONGEST_DEFAULT_FOLLOW_UP_DELAY_MS, FIRST_FOLLOW_UP_DELAY_MS * 2 ** Math.min(attempt - 1, 3));
}

/** Claude Code's own structured account of a request to the model that failed. */
export type ClaudeApiFailure = { status: number | null; terminalReason: string | null; category: string | null;
  /** Claude reported, in the same turn, a usage window of the account that rejected the request. */
  usageLimit?: true;
  /** The error's text begins with Claude Code's own words for a request that does not fit the model's context. */
  promptTooLong?: true };

/** Parsing is not trust: only an HTTP status and short names are kept, and anything else reads as not said. */
export function parseClaudeApiFailure(value: unknown): ClaudeApiFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const name = (field: unknown) => typeof field === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(field) ? field : null;
  return { status: typeof row.status === "number" && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 ? row.status : null,
    terminalReason: name(row.terminalReason), category: name(row.category), ...(row.usageLimit === true ? { usageLimit: true as const } : {}),
    ...(row.promptTooLong === true ? { promptTooLong: true as const } : {}) };
}

export type ClaudeApiFailureClass = "short_fault" | "authentication" | "billing" | "model" | "conversation" | "request" | "output_limit";

/**
 * What kind of failure Claude's structured fields describe. Null when they do
 * not say, as for the category `unknown` with no HTTP status: the failure text
 * is then read as it is for every other provider.
 */
export function claudeApiFailureClass(failure: ClaudeApiFailure | null): ClaudeApiFailureClass | null {
  if (!failure) return null;
  const { status, terminalReason, category } = failure;
  // The account's usage limit and a brief rate limit have the same name and
  // the same status. A usage limit does not pass in seconds, so a follow-up
  // turn cannot help: it is a limit of the account, like its credit. A usage
  // window that rejected the turn says which of the two this is.
  if (failure.usageLimit && (category === "rate_limit" || status === 429)) return "billing";
  // A refused credential is a key or an access that the owner can put right,
  // whatever name Claude Code gave the error: "API key authentication is
  // disabled" is a 403 that it names `invalid_request`. So this status is
  // read before any name.
  if (status === 401 || status === 403) return "authentication";
  // Otherwise Claude Code's name for the error says the most. One HTTP status
  // can mean several things: a low credit balance and a malformed request are
  // both 400. A connection that was refused or lost has no status, and is a
  // server error.
  if (category === "rate_limit" || category === "server_error") return "short_fault";
  if (category === "authentication_failed") return "authentication";
  if (category === "billing_error") return "billing";
  if (category === "model_not_found") return "model";
  if (category === "max_output_tokens") return "output_limit";
  // The request does not fit the model's context. That is not a fault of one
  // request: every later turn in the conversation fails the same way. The
  // result says so in its terminal reason: `prompt_too_long` when the
  // provider refused the request, `blocking_limit` when Claude Code did not
  // send it. The session keeps no terminal reason; there, and for a CLI that
  // sends none, the start of the error's text says it, as it does for the CLI.
  if (terminalReason === "prompt_too_long" || terminalReason === "blocking_limit" || failure.promptTooLong) return "conversation";
  if (category === "invalid_request" || terminalReason === "image_error") return "request";
  // No name that says it: the provider's status still says what kind of answer it gave.
  if (status === 429 || (status !== null && status >= 500)) return "short_fault";
  // A 400 means a request that cannot succeed only when Claude Code named the
  // error at all. With no name the text is read below: a low credit balance
  // is a 400 too.
  if (status === 413 || (status === 400 && category !== null)) return "request";
  return null;
}

/** Words for an account that is out of credit or quota, as the failure text of every provider is read. */
const OUT_OF_CREDIT_OR_QUOTA = /\b402\b|insufficient.{0,30}(?:credit|balance|quota)|(?:account|credit).{0,60}(?:output budget|exhausted)|(?:usage|spend|credit) limit|quota[ _-](?:exhausted|reached|exceeded)/i;
/**
 * The words Claude Code has for its own limits of usage and credit, which
 * name no "usage limit": "Credit balance is too low", and the starts of its
 * usage messages ("You've hit your session limit", "weekly limit", "Opus
 * limit", "team's shared budget", "You're out of extra usage"...). A brief
 * rate limit that is worded "your ... rate limit" is not one of them.
 *
 * Claude Code writes such a message as the whole text, and knows it by its
 * start. So the words count at the start of the text alone: the same words
 * in a server's message, which the CLI puts after "API Error: ...", are that
 * server's and say nothing about the account. They are read for a Claude
 * failure alone: another provider can word a brief limit of its own this way.
 */
const CLAUDE_OUT_OF_USAGE = /^(?:credit balance (?:is )?too low|you['’]ve (?:hit|reached) your (?:(?!rate[ -]?limit)[^.\n]){0,60}?(?:limit|budget)|you['’]re out of (?:usage credits|extra usage)|your org is out of usage|your seat type doesn['’]t include (?:extra )?usage|your usage allocation has been disabled|[^\n\u00b7:]{1,40} requires usage credits|this service is disabled for your org)/i;
/** Claude Code words a brief rate limit of a subscription login as "(not your usage limit)". Those words name no usage limit. */
const CLAUDE_NOT_A_USAGE_LIMIT = /\(not your usage limit\)/gi;

/**
 * `claudeCode` says that the failure is one of Claude Code. It is true when
 * Claude's account of the failure is given; a caller that knows the provider
 * says so for a failure that has no account. For every other provider the
 * text is read exactly as it was before Claude's fields and words were read.
 */
export function taskFailurePolicy(error: string | null, attempt: number, refusal = false, unrecognizedResult = false,
  claudeApiFailure: ClaudeApiFailure | null = null, claudeCode = claudeApiFailure !== null): TaskFailurePolicy {
  // The turn ended on a result of a shape its adapter does not know. The text
  // may be the model's own words, so nothing below may read it: words such as
  // "500" or "rate limit" in an answer are not a provider failure. No follow-up
  // is started on them, and nothing is blocked; the text stays on the message.
  if (unrecognizedResult) {
    return { automatic: false, settle: true, detail: `${error?.trim() || "The provider ended this turn with a result that was not recognized."} The unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` };
  }
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
  // Claude's structured fields say what kind of failure this is. When they do,
  // the kind decides and the text is not read: "Credit balance is too low"
  // matches no pattern below, and "Connection refused" reads like no temporary fault.
  const kind = claudeApiFailureClass(claudeApiFailure);
  // A failure that Claude names a rate limit, or that has the status of one,
  // can be the account's usage limit with no usage window reported: a turn
  // that is read back from its session has no window. The text that says so
  // is still read first, so that such a limit is never retried as a short fault.
  const readsLimitText = !kind || (kind === "short_fault" && (claudeApiFailure?.category === "rate_limit" || claudeApiFailure?.status === 429));
  // Claude Code's own words are read for a Claude failure alone.
  const limitText = claudeCode ? (error ?? "").replace(CLAUDE_NOT_A_USAGE_LIMIT, "") : error ?? "";
  if (kind === "billing" || (readsLimitText && (OUT_OF_CREDIT_OR_QUOTA.test(limitText) || (claudeCode && CLAUDE_OUT_OF_USAGE.test(limitText.trim()))))) {
    return { automatic: false, detail: `The model provider has insufficient credit or quota. ${retry}` };
  }
  if (kind === "authentication" || (!kind && /\b40[13]\b|unauthorized|invalid api key|authentication|sign[ -]?in required|access.{0,15}denied/i.test(error ?? ""))) {
    return { automatic: false, detail: `The model provider needs authentication or account access. ${retry}` };
  }
  if (kind === "model") {
    return { automatic: false, detail: `The model provider cannot find the selected model, or this account cannot use it. ${retry}` };
  }
  // The request does not fit the model's context, and no follow-up turn in
  // this conversation can. Claude's own text says what takes the room: the
  // conversation, or the system prompt, tools and attachments. The owner can
  // start a new conversation with Start fresh, at the cost of this one's
  // context. The follow-up belongs to the old conversation, so Retry delivery
  // then ends it without a turn, and later messages go ahead.
  if (kind === "conversation") {
    return { automatic: false, detail: `${error?.trim() || "Claude reported that the prompt is too long."} The request does not fit the model's context, so each turn in this conversation fails the same way. Start fresh opens a new conversation and discards the context of this one. After it, use Retry delivery, then send a message to continue the task. If the size comes from attachments or tools, a new conversation may not help.` };
  }
  // The provider cannot accept the request as it was sent: it is malformed or
  // too large. That belongs to this one message. A follow-up for it fails the
  // same way and Retry delivery cannot change it, so nothing is queued.
  if (kind === "request") {
    return { automatic: false, settle: true, detail: `${error?.trim() || "The model provider rejected this request."} Sending it again unchanged cannot help, so the unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` };
  }
  // The turn finished without an answer. That usually repeats, so allow one
  // follow-up turn (never a replay), then stop without blocking later messages.
  const noReply = kind === "output_limit" ? "outputLimit" : kind ? null : noReplyFailureKind(error);
  if (noReply === "contentFilter") {
    return { automatic: false, settle: true, detail: `${NO_REPLY_FAILURE.contentFilter} The unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` };
  }
  if (noReply) {
    if (attempt > 1) {
      return { automatic: false, settle: true, detail: `${NO_REPLY_FAILURE[noReply]} It happened again, so the unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.` };
    }
    return { automatic: true, detail: NO_REPLY_FOLLOW_UP_DETAIL, kind: "no_reply",
      note: noReply === "outputLimit"
        ? "Your previous turn hit the model's output limit before it wrote a reply. Keep replies short and split large tool calls."
        : noReply === "deniedTool"
          ? "In your previous turn a tool call was denied, so it did not run, and the turn ended before you replied. Do not run it again. Continue without it, or say in your reply why you need it. End this turn with a short reply."
          : "Your previous turn ended without a reply. End this turn with a short reply." };
  }
  if (attempt > MAX_AUTOMATIC_FOLLOW_UPS) return { automatic: false, detail: AUTOMATIC_ATTEMPTS_FAILED_DETAIL };
  if (kind === "short_fault" || (!kind && /\b(?:429|500|502|503|504|529)\b|rate.?limit|temporar(?:y|ily)|overloaded|service unavailable|connection reset|ECONNRESET|ETIMEDOUT|socket closed|network error/i.test(error ?? ""))) {
    // The same for every provider: a short fault is the same thing whoever reports it.
    return { automatic: true, detail: "The provider failed temporarily. The agent will try again by itself.", kind: "provider_fault",
      delayMs: SHORT_FAULT_FOLLOW_UP_DELAYS_MS[attempt - 1] ?? SHORT_FAULT_FOLLOW_UP_DELAYS_MS.at(-1)! };
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
  // A kind that this daemon does not know, as after a downgrade, is read as none. The follow-up is still valid, and
  // still can be stopped and retried: one value must not make the whole record invalid.
  if (row.kind === undefined || row.kind === "provider_fault" || row.kind === "no_reply") return row as unknown as TaskContinuation;
  const { kind: _unknown, ...withoutKind } = row;
  return withoutKind as unknown as TaskContinuation;
}

/** What a follow-up's id begins with. */
export const FOLLOW_UP_SOURCE_PREFIX = "task-continuation:";
/**
 * The item that a series of follow-ups began with: a room message, or the earliest follow-up that is kept. Each
 * follow-up names the item before it, so the walk ends, however many follow-ups lie between after its owner used
 * Retry. An item that is named twice is not followed again.
 */
export function followUpOrigin<Item extends { inbox_item_id: string; source_message_id: string; activation: Record<string, unknown> }>(
  start: Item, load: (inboxItemId: string) => Item | undefined,
): Item {
  let origin = start;
  const seen = new Set([origin.inbox_item_id]);
  while (origin.source_message_id.startsWith(FOLLOW_UP_SOURCE_PREFIX)) {
    const parentId = parseTaskContinuation(origin.activation.task_continuity)?.parentId;
    const parent = parentId && !seen.has(parentId) ? load(parentId) : undefined;
    if (!parent) break;
    origin = parent;
    seen.add(origin.inbox_item_id);
  }
  return origin;
}
