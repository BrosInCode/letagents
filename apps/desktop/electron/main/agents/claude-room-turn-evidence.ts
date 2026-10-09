export const CLAUDE_NO_ROOM_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";

export type ClaudeEvidenceRecord = Record<string, unknown>;

export type ClaudeExactTurnResult =
  | {
    turnId: string;
    outcome: "reply";
    text: string;
    evidence: "stream" | "transcript";
  }
  | {
    turnId: string;
    outcome: "no_reply";
    text: null;
    evidence: "stream" | "transcript";
  }
  | {
    turnId: string;
    outcome: "unreadable";
    text: null;
    evidence: "none";
  };

export type ClaudeExactTurnFailure = {
  /** How the command ended. Every failure says so: one that did not was read again on each recovery and blocked the agent. */
  nativeOutcome: "failed" | "interrupted";
  turnId: string;
  error: string;
  /**
   * The result was not a shape Claude Code is known to send, or it carried
   * text where that shape has none. `error` then holds Claude's own words,
   * which may be an answer. They are for the owner to read. Nothing may read
   * them as a provider error and act on what they happen to say.
   */
  unrecognizedResult?: true;
  /** Claude Code's own structured account of the failed request, when the failure is a known API error. */
  apiFailure?: ClaudeApiFailure;
  /** The provider declined the turn's content: the answer stopped with `stop_reason: "refusal"`. */
  refusal?: true;
};

/**
 * What Claude Code says, in its own fields, about a request to the model that
 * failed. These are for code to decide on. The error text is for the owner to
 * read, and what it happens to say decides nothing for a failure that has them.
 * One mark is the exception, because Claude Code has no field for it: its own
 * first words for a request that does not fit the model's context.
 */
export type ClaudeApiFailure = {
  /** The HTTP status of the provider's answer. Null when there was none, as for a connection that was refused or lost. */
  status: number | null;
  /** The result's `terminal_reason`, such as `api_error` or `prompt_too_long`. The session file does not keep it. */
  terminalReason: string | null;
  /** Claude Code's name for the error, on the assistant row that carries its text: `rate_limit`, `server_error`, `billing_error`... */
  category: string | null;
  /** Claude reported, in the same turn, a usage window of the account that rejected the request. */
  usageLimit?: true;
  /** The error's text begins with Claude Code's own words for a request that does not fit the model's context. */
  promptTooLong?: true;
};

/**
 * How Claude Code begins the text of an error for a request that does not fit
 * the model's context. The CLI itself knows such a row by this start, and by
 * nothing else: its name for the error, `invalid_request`, is also its name
 * for a malformed tool history, a PDF it cannot read, a plan that lacks a
 * model, and more.
 */
const CLAUDE_PROMPT_TOO_LONG = "Prompt is too long";

/** A field is kept only when it is what Claude Code writes there: a short name, or an HTTP status. */
function factName(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}
function apiFailureFacts(status: unknown, terminalReason: unknown, category: unknown, texts: readonly string[], usageLimit = false): { apiFailure?: ClaudeApiFailure } {
  const promptTooLong = texts.some((text) => text.startsWith(CLAUDE_PROMPT_TOO_LONG));
  const facts = { status: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    terminalReason: factName(terminalReason), category: factName(category), ...(usageLimit ? { usageLimit: true as const } : {}),
    ...(promptTooLong ? { promptTooLong: true as const } : {}) };
  return facts.status === null && facts.terminalReason === null && facts.category === null && !usageLimit && !promptTooLong ? {} : { apiFailure: facts };
}

/**
 * Whether a stream line reports a usage window of the account that rejected a
 * request (SDKRateLimitEvent). Claude writes one line for each window it
 * reads; a window that is only allowed, or allowed with a warning, rejects nothing.
 */
export function claudeUsageLimitRejected(row: ClaudeEvidenceRecord, sessionId: string): boolean {
  return row.type === "rate_limit_event" && sessionIdOf(row) === sessionId && record(row.rate_limit_info)?.status === "rejected";
}

/**
 * Claude Code's name for an API error, from the assistant row that carries the
 * error's text in the stream. A sub-agent's row carries the same fields and the
 * same session; `parent_tool_use_id` names the tool call that started it. Its
 * error is not the turn's.
 */
export function claudeApiErrorCategory(row: ClaudeEvidenceRecord, sessionId: string): string | null {
  return row.type === "assistant" && row.is_api_error_message === true && row.parent_tool_use_id == null
    && sessionIdOf(row) === sessionId ? factName(row.error) : null;
}

function record(value: unknown): ClaudeEvidenceRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ClaudeEvidenceRecord
    : null;
}

function sessionIdOf(value: ClaudeEvidenceRecord): string | null {
  const candidate = value.session_id ?? value.sessionId;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function exactTextResult(
  turnId: string,
  text: string,
  evidence: "stream" | "transcript",
): ClaudeExactTurnResult {
  const normalized = text.trim();
  if (!normalized) {
    return { turnId, outcome: "unreadable", text: null, evidence: "none" };
  }
  if (normalized === CLAUDE_NO_ROOM_REPLY_SENTINEL) {
    return { turnId, outcome: "no_reply", text: null, evidence };
  }
  return { turnId, outcome: "reply", text: normalized, evidence };
}

/**
 * What the owner reads when a command ended on a result this code does not
 * know. It names the shape, so the report says what Claude sent. Claude's own
 * text, which may be an answer or an error, is added by the caller.
 */
function unrecognizedResultText(subtype: string | null, isError: unknown): string {
  const named = subtype === null ? "no subtype" : `subtype ${JSON.stringify(subtype.slice(0, 80))}`;
  const flag = typeof isError === "boolean" ? `is_error ${isError}` : isError === undefined ? "no is_error" : "an is_error that is not true or false";
  return `Claude ended this turn with a result LetAgents does not recognize (${named}, ${flag}), so nothing was posted.`;
}

export function exactClaudeCommandLifecycleState(
  event: ClaudeEvidenceRecord,
  turnId: string,
  sessionId: string,
): string | null {
  if (
    event.type !== "command_lifecycle"
    || event.command_uuid !== turnId
    || sessionIdOf(event) !== sessionId
  ) {
    return null;
  }
  return typeof event.state === "string" && event.state.trim()
    ? event.state.trim()
    : null;
}

export function exactClaudeStreamTerminal(
  event: ClaudeEvidenceRecord,
  turnId: string,
  sessionId: string,
  /** Claude Code's name for the API error of this turn, when the stream carried one before the result. */
  apiErrorCategory: string | null = null,
  /** The stream of this turn reported a usage window that rejected the request. */
  usageLimitRejected = false,
): ClaudeExactTurnResult | ClaudeExactTurnFailure | null {
  if (
    event.type !== "result"
    || event.user_message_uuid !== turnId
    || sessionIdOf(event) !== sessionId
  ) {
    return null;
  }
  if (event.subtype !== "success" || event.is_error !== false) {
    // The CLI sends a `result` when a turn has ended. This one names the
    // exact command and session, so the command has ended whatever else the
    // event holds. (In every capture of Claude Code 2.1.278 each command had
    // exactly one result, and its `user_message_uuids` list held that command
    // alone. The adapter sends one command at a time, and matches the one
    // that `user_message_uuid` names.)
    // Only `success` with `is_error: false` proves an answer. Every other
    // shape is a command that ended without one: it failed, Claude's text is
    // kept for the owner, and nothing is posted. No shape is left without an
    // outcome.
    const subtype = typeof event.subtype === "string" ? event.subtype : null;
    const resultText = typeof event.result === "string" ? event.result.trim() : "";
    // SDKResultSuccess also carries terminal API errors: is_error=true and
    // result contains the error text. The subtype alone does not mean success.
    const apiError = subtype === "success" && event.is_error === true;
    const errors = Array.isArray(event.errors)
      ? event.errors.filter((value): value is string => typeof value === "string")
      : [];
    const status = typeof event.api_error_status === "number" ? ` (HTTP ${event.api_error_status})` : "";
    // An error subtype says how the command ended, and carries its reasons in
    // `errors`. It is not known to carry a `result` text.
    const namedEnding = subtype !== null && /^(?:error_|interrupted$)/.test(subtype);
    // Claude's words in a place where no known shape puts an error text.
    const freeText = apiError ? "" : resultText;
    return {
      turnId,
      nativeOutcome: subtype === "interrupted" ? "interrupted" : "failed",
      // Both are kept for the owner: the errors Claude lists, and the text it wrote.
      error: apiError
        ? [...errors, resultText].filter(Boolean).join("; ") || `Claude reported an API error without details${status}.`
        : `${errors.join("; ") || (namedEnding ? `Claude command ended ${subtype}.` : unrecognizedResultText(subtype, event.is_error))}${freeText ? ` Claude's text: ${freeText}` : ""}`,
      // The shapes Claude Code is known to send for a failed command are an
      // API error, and an error subtype with `is_error: true` and no text.
      ...(apiError || (namedEnding && event.is_error === true && !freeText) ? {} : { unrecognizedResult: true as const }),
      ...(apiError ? apiFailureFacts(event.api_error_status, event.terminal_reason, apiErrorCategory, [resultText], usageLimitRejected) : {}),
      ...(apiError && event.stop_reason === "refusal" ? { refusal: true as const } : {}),
    };
  }
  return exactTextResult(
    turnId,
    typeof event.result === "string" ? event.result : "",
    "stream",
  );
}

function assistantText(row: ClaudeEvidenceRecord): string[] {
  if (row.type !== "assistant") return [];
  const message = record(row.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((item) => {
    const part = record(item);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  });
}

/**
 * Recover one completed Claude command from its session JSONL.
 *
 * Claude persists the caller-supplied user UUID verbatim. When the session log
 * contains its final assistant API message, `stop_reason=end_turn` is the exact
 * terminal boundary. Recovery deliberately refuses an absent or partial
 * assistant message instead of guessing that it completed.
 */
export function recoverExactClaudeTurnFromSession(
  rows: ClaudeEvidenceRecord[],
  turnId: string,
  sessionId: string,
): ClaudeExactTurnResult | null {
  const turnRows = exactClaudeTurnRows(rows, turnId, sessionId);
  if (!turnRows) return null;
  return recoverFromTurnRows(turnRows, turnId);
}

/**
 * The provider error a Claude command ended with, as its session JSONL keeps
 * it: when Claude gives up on a request it writes the error as a synthetic
 * assistant row marked `isApiErrorMessage`, whose text is the error. Null
 * when the exact turn has no such row, or has its answer instead.
 */
export function recoverExactClaudeTurnFailureFromSession(
  rows: ClaudeEvidenceRecord[],
  turnId: string,
  sessionId: string,
): ClaudeExactTurnFailure | null {
  const turnRows = exactClaudeTurnRows(rows, turnId, sessionId);
  if (!turnRows || recoverFromTurnRows(turnRows, turnId)) return null;
  const failure = [...turnRows].reverse().find((row) => row.type === "assistant" && row.isApiErrorMessage === true);
  if (!failure) return null;
  const text = assistantText(failure).join("").trim();
  const status = typeof failure.apiErrorStatus === "number" ? ` (HTTP ${failure.apiErrorStatus})` : "";
  return { turnId, nativeOutcome: "failed", error: text || `The model provider refused the request${status}.`,
    ...apiFailureFacts(failure.apiErrorStatus, null, failure.error, assistantText(failure)),
    ...(record(failure.message)?.stop_reason === "refusal" ? { refusal: true as const } : {}) };
}

/** Whether a row is an assistant message that ended its reply. */
function endsClaudeMessage(row: ClaudeEvidenceRecord): boolean {
  const message = row.type === "assistant" ? record(row.message) : null;
  return message?.stop_reason === "end_turn" && typeof message.id === "string" && Boolean(message.id.trim());
}

/** How the row begins that Claude Code writes when a Stop hook refuses the end of a turn. The hook's words follow. */
const CLAUDE_STOP_HOOK_FEEDBACK = "Stop hook feedback:";

/**
 * Whether a user row is the CLI going on with the turn it stands in: the model
 * is called again with it, in the same turn. These are the rows Claude Code
 * 2.1.278 is known to write for that (each is in a capture of
 * `__fixtures__/claude-code-result-shapes.json`), by the marks they carry:
 * - a row the CLI adds to a turn by itself, marked `isMeta` and
 *   `turnCompanion`: its request after a reply with no visible output or with
 *   the output limit reached, and the text of a skill that the model called;
 * - a tool's result;
 * - the words of a Stop hook that refused the end of the turn: `isMeta`, and
 *   the CLI's fixed first words.
 */
function continuesClaudeTurn(row: ClaudeEvidenceRecord): boolean {
  if (row.type !== "user") return false;
  if (row.isMeta === true && row.turnCompanion === true) return true;
  const content = record(row.message)?.content;
  if (Array.isArray(content)) return content.some((part) => record(part)?.type === "tool_result");
  return row.isMeta === true && typeof content === "string" && content.startsWith(CLAUDE_STOP_HOOK_FEEDBACK);
}

/**
 * The rows of one exact command in its session: those after its user row, up
 * to the first user row that is not the turn going on.
 *
 * Such a row is the next command (a prompt, or the notice of a background
 * task, which the CLI answers in a turn of its own), or a row this code does
 * not know. Either way nothing from there on is read as this turn's: a
 * message that ended after it can be the answer of another turn.
 */
function exactClaudeTurnRows(
  rows: ClaudeEvidenceRecord[],
  turnId: string,
  sessionId: string,
): ClaudeEvidenceRecord[] | null {
  // A sub-agent's rows carry the session of the turn that started it, and a
  // message of its own that ended. They are not the turn's. (Claude Code
  // 2.1.278 keeps them in a file of their own, which is not read here.)
  const ownRows = rows.filter((row) => row.isSidechain !== true && sessionIdOf(row) === sessionId);
  const sourceIndex = ownRows.findIndex((row) => row.type === "user" && row.uuid === turnId);
  if (sourceIndex < 0) return null;

  const turnRows = ownRows.slice(sourceIndex + 1);
  const endIndex = turnRows.findIndex((row) => row.type === "user" && row.uuid !== turnId && !continuesClaudeTurn(row));
  return endIndex < 0 ? turnRows : turnRows.slice(0, endIndex);
}

function recoverFromTurnRows(turnRows: ClaudeEvidenceRecord[], turnId: string): ClaudeExactTurnResult | null {
  // A turn can hold more than one message that ended. When a reply has no
  // visible output, or a Stop hook refuses the end of the turn, the CLI has
  // the model go on, and the turn's answer is then in the message after
  // that. So the answer is in the last message that ended. The rows are
  // those of this turn alone: a later command's answer is never among them.
  const terminalIndex = turnRows.reduce((last, row, index) => endsClaudeMessage(row) ? index : last, -1);
  if (terminalIndex < 0) return null;
  // A user row after that message is the CLI going on with the turn (the
  // turn's rows hold no other user row; see `continuesClaudeTurn`). The turn
  // did not end where that message did, and the session holds no ending for
  // it.
  if (turnRows.slice(terminalIndex + 1).some((row) => row.type === "user")) return null;
  const terminalMessageId = record(turnRows[terminalIndex]!.message)!.id;

  const text = turnRows.flatMap((row) => {
    const messageId = record(row.message)?.id;
    return messageId === terminalMessageId ? assistantText(row) : [];
  }).join("");
  if (!text.trim()) {
    return { turnId, outcome: "unreadable", text: null, evidence: "none" };
  }

  return exactTextResult(turnId, text, "transcript");
}
