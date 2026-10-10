export const CLAUDE_NO_ROOM_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";

export type ClaudeEvidenceRecord = Record<string, unknown>;

export type ClaudeExactTurnResult =
  | {
    turnId: string;
    outcome: "reply";
    text: string;
    evidence: "stream" | "transcript";
    /**
     * Only on a reply that was read from the session, for a turn that started background work: the session
     * does not prove that the reply is complete. `ended_unreported`: the session holds the notice of all of
     * that work, and not an answer to each. `no_report`: the rows that are read for the turn hold no notice
     * of some of that work. The reply then says so (see `recoverExactClaudeTurnFromSession`).
     */
    backgroundWork?: "ended_unreported" | "no_report";
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
 *
 * A turn that started background work is kept open by the adapter until the
 * model has answered the notice of that work, and its reply is the turn's
 * answer and those answers, in order. The session holds them as commands of
 * their own after the turn. They are read here in the same way: the reply is
 * what the adapter would have posted when the session proves all of it, and
 * otherwise what the session has, marked as not proven complete. The turn's
 * interim answer alone is never returned as if it were the whole reply.
 *
 * All of that rests on marks that the CLI writes on its rows, and every row
 * that these rules were read from is of Claude Code 2.1.278. The app allows
 * older ones. So the turn's own request row is the witness: a CLI that marks
 * its prompts marked this one. When it carries no mark, the session is read
 * by the earlier rule, which needs none (see `claudeCommandRows`).
 */
export function recoverExactClaudeTurnFromSession(
  rows: ClaudeEvidenceRecord[],
  turnId: string,
  sessionId: string,
): ClaudeExactTurnResult | null {
  const turn = exactClaudeTurnRows(rows, turnId, sessionId);
  if (!turn) return null;
  const own = recoverFromTurnRows(turn, turnId);
  // Only an answer is added to, or the model's word that it has none: as the adapter holds only such a turn open.
  // And only where the rows were read by their marks: the earlier rule knows no notice from any other command.
  if (!own || own.outcome === "unreadable" || !turn.byMarks) return own;
  return withBackgroundWorkAnswers(own, turn, turnId);
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
  const turn = exactClaudeTurnRows(rows, turnId, sessionId);
  // A turn that has an answer did not fail, whether or not the row after its rows proves that answer complete.
  if (!turn || recoverFromTurnRows({ ...turn, end: "command" }, turnId)) return null;
  const failure = [...turn.rows].reverse().find((row) => row.type === "assistant" && row.isApiErrorMessage === true);
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
 * - a tool's result: a row whose every part is one. A hook that denies a tool
 *   call writes its words as that call's result. (A row that holds a tool's
 *   result beside other parts is not known, and is not read as one.)
 * - the words of a Stop hook that refused the end of the turn: `isMeta`, and
 *   the CLI's fixed first words.
 */
function continuesClaudeTurn(row: ClaudeEvidenceRecord): boolean {
  if (row.type !== "user") return false;
  if (row.isMeta === true && row.turnCompanion === true) return true;
  const content = record(row.message)?.content;
  if (Array.isArray(content)) return content.length > 0 && content.every((part) => record(part)?.type === "tool_result");
  return row.isMeta === true && typeof content === "string" && content.startsWith(CLAUDE_STOP_HOOK_FEEDBACK);
}

/** The words of a task's notice, when the row is one: `<task-id>` names the task. */
const CLAUDE_TASK_NOTICE_ID = /<task-id>([^<\s]{1,128})<\/task-id>/;

/**
 * The background task whose end a row tells the model of: its id, an empty
 * text when the row is such a notice and names no task, and null for any other
 * row. The CLI writes a notice in two ways (each captured):
 * - as the prompt of a command of its own, a user row with
 *   `origin.kind: "task-notification"`, when no request is running;
 * - as an attachment of the kind `queued_command` with the mode
 *   `task-notification`, when a running turn takes the notice with its next
 *   request to the model. No command follows such a notice.
 */
function claudeTaskNotice(row: ClaudeEvidenceRecord): string | null {
  const attachment = row.type === "attachment" ? record(row.attachment) : null;
  const words = row.type === "user" && record(row.origin)?.kind === "task-notification" ? record(row.message)?.content
    : attachment?.type === "queued_command" && attachment.commandMode === "task-notification" ? attachment.prompt : null;
  if (words === null || words === undefined) return null;
  const text = typeof words === "string" ? words
    : Array.isArray(words) ? words.map((part) => { const text = record(part)?.text; return typeof text === "string" ? text : ""; }).join("") : "";
  return CLAUDE_TASK_NOTICE_ID.exec(text)?.[1] ?? "";
}

/** Whether the CLI marked a row as a prompt, with where the prompt came from. */
function isMarkedClaudePrompt(row: ClaudeEvidenceRecord): boolean {
  return row.type === "user" && typeof row.promptSource === "string" && row.promptSource.trim() !== "";
}

/** The boundary row of a compaction, and whether the CLI's own command `/compact` made it. */
function claudeCompaction(row: ClaudeEvidenceRecord): "by_command" | "other" | null {
  if (row.type !== "system" || row.subtype !== "compact_boundary") return null;
  return record(row.compactMetadata)?.trigger === "manual" ? "by_command" : "other";
}

/**
 * Whether a row starts another command, so that the turn before it is over.
 * These are the rows Claude Code 2.1.278 is known to write for that (each
 * captured):
 * - a prompt: the CLI marks each with where it came from, in `promptSource`
 *   (`sdk` for a prompt that the adapter wrote);
 * - the notice of a background task, which the CLI answers in a command of
 *   its own;
 * - a compaction that the CLI's own command `/compact` made: its boundary row.
 */
function startsClaudeCommand(row: ClaudeEvidenceRecord): boolean {
  if (row.type === "system") return claudeCompaction(row) === "by_command";
  return row.type === "user" && (record(row.origin)?.kind === "task-notification" || isMarkedClaudePrompt(row));
}

/**
 * The rows of one command, and how they end:
 * - `command`: at a row that starts another command. The command is over.
 * - `file`: with the session, as far as it was written.
 * - `unknown`: at a user row that is not known to be the command going on, and
 *   not known to start another command. It can be either.
 * `rest` holds the rows from that row on. `byMarks` says that the rows were
 * read by the marks of the CLI to their end, and not by the earlier rule.
 */
type ClaudeCommandRows = { rows: ClaudeEvidenceRecord[]; end: "command" | "file" | "unknown"; rest: ClaudeEvidenceRecord[]; byMarks: boolean };

/**
 * The rows of the command that starts at `from`, among the session's own rows.
 * `turnId` is the id of its request.
 *
 * With `byMarks` a command ends only where the CLI's marks say that another
 * starts, and a user row with no known mark ends the reading as `unknown`.
 *
 * Without it the earlier rule holds: the first user row that is not the
 * command going on ends it, as another command. That rule needs no mark, and
 * it is the rule for two cases in which the marks cannot be relied on:
 * - a session of a CLI that does not mark its prompts. There each prompt is a
 *   row with no mark, and by the marks no answer would ever be proven.
 * - the rows after a compaction that no command made. No capture holds one:
 *   two tries did not make the CLI compact by itself, and the adapter never
 *   sends `/compact`. So what the earlier rule read there is still read: the
 *   answer before the summary of the compaction, and nothing after it.
 */
function claudeCommandRows(ownRows: ClaudeEvidenceRecord[], from: number, turnId: string, byMarks: boolean): ClaudeCommandRows {
  for (let index = from; index < ownRows.length; index += 1) {
    const row = ownRows[index]!;
    // The request's own row, written a second time, is the same command.
    if (row.type === "user" && row.uuid === turnId) continue;
    const goesOn = continuesClaudeTurn(row);
    if (byMarks && claudeCompaction(row) === "other") byMarks = false;
    if (!byMarks) {
      if (row.type === "user" && !goesOn) return { rows: ownRows.slice(from, index), end: "command", rest: ownRows.slice(index), byMarks };
      continue;
    }
    const startsNext = startsClaudeCommand(row);
    // A row with the marks of both is of neither kind.
    if (startsNext && !goesOn) return { rows: ownRows.slice(from, index), end: "command", rest: ownRows.slice(index), byMarks };
    if (row.type === "user" && !(goesOn && !startsNext)) return { rows: ownRows.slice(from, index), end: "unknown", rest: ownRows.slice(index), byMarks };
  }
  return { rows: ownRows.slice(from), end: "file", rest: [], byMarks };
}

/**
 * The rows of one exact command in its session: those after its user row, up
 * to the row that starts the next command.
 *
 * A user row that is not known ends them too, and is kept apart: nothing from
 * there on is read as this turn's, because a message that ended after it can
 * be the answer of another turn. A message that ended before it is not proven
 * to be this turn's answer either, because the row can be the turn going on.
 *
 * The turn's request row says which rule reads them: it is a prompt, so a CLI
 * that marks its prompts marked it. A file in which that is not so for every
 * prompt is not known to occur (it would take a CLI of another version to go
 * on with the session). It is read by its request all the same: after a
 * request with no mark, the earlier rule reads a later prompt as the start of
 * another command, marked or not. After a marked request, a later prompt with
 * no mark is a row that is not known, and no answer is proven.
 */
function exactClaudeTurnRows(
  rows: ClaudeEvidenceRecord[],
  turnId: string,
  sessionId: string,
): ClaudeCommandRows | null {
  // A sub-agent's rows carry the session of the turn that started it, and a
  // message of its own that ended. They are not the turn's. (Claude Code
  // 2.1.278 keeps them in a file of their own, which is not read here.)
  const ownRows = rows.filter((row) => row.isSidechain !== true && sessionIdOf(row) === sessionId);
  const sourceIndex = ownRows.findIndex((row) => row.type === "user" && row.uuid === turnId);
  return sourceIndex < 0 ? null : claudeCommandRows(ownRows, sourceIndex + 1, turnId, isMarkedClaudePrompt(ownRows[sourceIndex]!));
}

function recoverFromTurnRows(turn: Pick<ClaudeCommandRows, "rows" | "end">, turnId: string): ClaudeExactTurnResult | null {
  const turnRows = turn.rows;
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
  // The rows end at a user row of a kind that is not known. If that row is the
  // turn going on, the message that ended before it is an interim one, and the
  // answer is not in the rows that were read. So no answer is proven.
  if (turn.end === "unknown") return null;
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

/**
 * The background task that a tool's result says was started, by the fields of
 * the result that the CLI keeps beside it (each captured): the id of a shell
 * command that runs in the background, and the id of a sub-agent that was
 * started without waiting for it.
 *
 * Work of a kind that leaves neither field is not recognised. A turn that
 * started only such work is read as a turn with no background work: its own
 * answer, with nothing added and nothing said about a report.
 */
function startedClaudeBackgroundTask(row: ClaudeEvidenceRecord): string[] {
  const result = row.type === "user" ? record(row.toolUseResult) : null;
  const taskId = typeof result?.backgroundTaskId === "string" ? result.backgroundTaskId
    : result?.isAsync === true && typeof result.agentId === "string" ? result.agentId : "";
  return taskId.trim() ? [taskId.trim()] : [];
}

/**
 * The background command that a tool's result says the model stopped: the
 * result of a call of the CLI's tool `TaskStop`, by the fields that the CLI
 * keeps beside it (captured). The CLI does not tell the model of the end of a
 * command that was stopped, so no report on it is due.
 *
 * A sub-agent that the model stopped is not taken out in this way: no capture
 * holds one, and the CLI tells the model of a sub-agent that was stopped by a
 * request from outside.
 */
function stoppedClaudeBackgroundCommand(row: ClaudeEvidenceRecord, rows: ClaudeEvidenceRecord[]): string[] {
  const result = row.type === "user" ? record(row.toolUseResult) : null;
  if (typeof result?.task_id !== "string" || result.task_type !== "local_bash" || typeof result.message !== "string") return [];
  const content = record(row.message)?.content;
  const part = Array.isArray(content) && content.length === 1 ? record(content[0]) : null;
  if (part?.type !== "tool_result" || part.is_error === true || typeof part.tool_use_id !== "string") return [];
  const calledToStop = rows.some((other) => {
    const calls = other.type === "assistant" ? record(other.message)?.content : null;
    return Array.isArray(calls) && calls.some((call) => record(call)?.type === "tool_use" && record(call)?.id === part.tool_use_id && record(call)?.name === "TaskStop");
  });
  return calledToStop ? [result.task_id] : [];
}

/**
 * The reply of a turn that started background work, as the adapter makes it
 * for a turn that it holds open: the turn's own answer, then the answer to
 * each notice of that work, in order, with a blank line between them. A text
 * that repeats the text before it is left out, and so is a notice's answer
 * that has no text for the room.
 *
 * The answers are read from the commands that follow the turn, each of which
 * starts with one notice or more. An answer is the turn's when one of its
 * notices is of the turn's work. Work that such an answer started is the
 * turn's too. The reading ends at the first command that is not a notice's:
 * the adapter sends no prompt while it holds a turn open.
 *
 * The reply is proven complete when the model was told of the end of all of
 * that work, and each answer about it ended. Otherwise the reply holds what
 * the session has, and says which of the two is missing. A command that the
 * model itself stopped is not work that a report is due on.
 *
 * A notice is known by the mark that the CLI writes on its row. A command of
 * the CLI's own (`promptSource: "system"`) that carries no such mark shows
 * that this CLI does not mark its notices, or that the command is of a kind
 * that is not known. Then no notice can be told from another command, and
 * the turn is read as the earlier rule read it: its own answer, with nothing
 * added and nothing said about a report.
 */
function withBackgroundWorkAnswers(
  own: Extract<ClaudeExactTurnResult, { outcome: "reply" | "no_reply" }>,
  turn: ClaudeCommandRows,
  turnId: string,
): ClaudeExactTurnResult {
  const tasks = new Set(turn.rows.flatMap(startedClaudeBackgroundTask));
  const stoppedIn = (rows: ClaudeEvidenceRecord[]) => rows.flatMap((row) => stoppedClaudeBackgroundCommand(row, rows));
  for (const taskId of stoppedIn(turn.rows)) tasks.delete(taskId);
  if (!tasks.size) return own;
  const noticesIn = (rows: ClaudeEvidenceRecord[]) => rows.flatMap((row) => { const taskId = claudeTaskNotice(row); return taskId ? [taskId] : []; });
  // The notices that the turn's own requests took: its own answer is the answer to them.
  const told = new Set(noticesIn(turn.rows));
  const texts = own.outcome === "reply" ? [own.text] : [];
  let answered = true;
  let rest = turn.end === "command" ? turn.rest : [];
  const isNoticeCommand = (row: ClaudeEvidenceRecord | undefined) => row?.type === "user" && record(row.origin)?.kind === "task-notification";
  /** A command of the CLI's own that carries no mark of what it is. */
  const isUnmarkedOwnCommand = (row: ClaudeEvidenceRecord | undefined) => row?.type === "user" && row.promptSource === "system" && record(row.origin) === null;
  for (;;) {
    if (isUnmarkedOwnCommand(rest[0])) return own;
    if (!isNoticeCommand(rest[0])) break;
    // Notices that wait together go to the model with one request, and get one answer: the notices end at the
    // first message that is not one.
    let first = 1;
    for (let index = 1; index < rest.length && rest[index]!.type !== "assistant" && (rest[index]!.type !== "user" || isNoticeCommand(rest[index])); index += 1) {
      if (isNoticeCommand(rest[index])) first = index + 1;
    }
    const answer = claudeCommandRows(rest, first, turnId, true);
    const about = [...noticesIn(rest.slice(0, first)), ...noticesIn(answer.rows)];
    rest = answer.end === "command" ? answer.rest : [];
    // An answer about other work is not this turn's: the adapter posts it nowhere, and the turn waits on.
    if (!about.some((taskId) => tasks.has(taskId))) continue;
    for (const taskId of about) told.add(taskId);
    for (const taskId of answer.rows.flatMap(startedClaudeBackgroundTask)) tasks.add(taskId);
    for (const taskId of stoppedIn(answer.rows)) tasks.delete(taskId);
    const read = recoverFromTurnRows(answer, turnId);
    // The answer failed, was cut off, or is not proven to have ended: the turn ends with what it has.
    if (!read) { answered = false; break; }
    if (read.outcome === "reply") texts.push(read.text);
  }
  const said = texts.filter((text, index) => text !== texts[index - 1]);
  // A turn in which the model wrote nothing for the room posts nothing.
  if (!said.length) return { turnId, outcome: "no_reply", text: null, evidence: "transcript" };
  const toldOfAll = [...tasks].every((taskId) => told.has(taskId));
  return { turnId, outcome: "reply", text: said.join("\n\n"), evidence: "transcript",
    ...(answered && toldOfAll ? {} : { backgroundWork: toldOfAll ? "ended_unreported" as const : "no_report" as const }) };
}
