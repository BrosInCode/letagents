import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every shape of Claude Code `result` event that can end a room turn, and how
 * the turn must end on it. The tests of the evidence reader and of the adapter
 * both walk this table, so a shape cannot be handled in one and not the other.
 *
 * The table is written out by hand. It is the statement of what is wanted, not
 * a second copy of the code that decides it.
 */

/** The text of a result that carries one. */
export const CLAUDE_RESULT_TEXT = "Text that Claude wrote.";

const ABSENT = Symbol("the field is not in the event");
type Field<T> = T | typeof ABSENT;

export type ClaudeResultCell = {
  name: string;
  subtype: Field<string>;
  isError: Field<unknown>;
  result: Field<string>;
  /**
   * How the turn ends.
   * - `answer`: Claude's text is the room reply.
   * - `no_answer_in_result`: the turn completed, and the result holds no text.
   *   The session is read next; if it holds no answer either, the turn fails.
   * - `failed` / `interrupted`: the turn ended without an answer. Nothing is posted.
   */
  expected: "answer" | "no_answer_in_result" | "failed" | "interrupted";
  /** What the owner reads when the turn failed or was interrupted. */
  error?: string;
  /**
   * The failure is marked as an unrecognized result: its text may be Claude's
   * own words, so nothing may read it as a provider error and act on it.
   */
  marked?: true;
};

/** The owner's text for a shape the code does not know: with Claude's text, and without it. */
function unrecognized(shape: string): [string, string] {
  const said = `Claude ended this turn with a result LetAgents does not recognize (${shape}), so nothing was posted.`;
  return [`${said} Claude's text: ${CLAUDE_RESULT_TEXT}`, said];
}
/** The owner's text for an error subtype: with a text that the subtype is not known to carry, and without it. */
function ended(subtype: string): [string, string] {
  return [`Claude command ended ${subtype}. Claude's text: ${CLAUDE_RESULT_TEXT}`, `Claude command ended ${subtype}.`];
}

/** `is_error` as Claude sends it, as it could be left out, and as a value that is not a boolean. */
const NOT_A_BOOLEAN = "true";
/**
 * When a failure is marked as an unrecognized result. A known shape is never
 * marked: its text is Claude's error text. An error subtype with
 * `is_error: true` is a known shape as long as it carries no text.
 */
type Marked = "never" | "with_text" | "always";
/** A failed shape that the table does not name as known is marked. */
const MARKED_UNLESS_KNOWN: Marked = "always";
type Row = [subtype: Field<string>, isError: Field<unknown>, ends: "completed" | "failed" | "interrupted", withText?: string, withoutText?: string, marked?: Marked];
const ROWS: Row[] = [
  // The one shape that is an answer. Claude Code 2.1.278 sends it for a completed turn.
  ["success", false, "completed"],
  // Claude Code 2.1.278 sends this for every API error. The text is the error.
  ["success", true, "failed", CLAUDE_RESULT_TEXT, "Claude reported an API error without details.", "never"],
  // "success" alone proves nothing: the text could be an API error. It is kept, and it is not posted.
  ["success", ABSENT, "failed", ...unrecognized("subtype \"success\", no is_error")],
  ["success", NOT_A_BOOLEAN, "failed", ...unrecognized("subtype \"success\", an is_error that is not true or false")],

  // The error subtypes Claude Code 2.1.278 defines. The subtype says how the command ended, whatever is_error says.
  ["error_during_execution", true, "failed", ...ended("error_during_execution"), "with_text"],
  ["error_during_execution", false, "failed", ...ended("error_during_execution")],
  ["error_during_execution", ABSENT, "failed", ...ended("error_during_execution")],
  ["error_during_execution", NOT_A_BOOLEAN, "failed", ...ended("error_during_execution")],
  ["error_max_turns", true, "failed", ...ended("error_max_turns"), "with_text"],
  ["error_max_turns", false, "failed", ...ended("error_max_turns")],
  ["error_max_turns", ABSENT, "failed", ...ended("error_max_turns")],
  ["error_max_turns", NOT_A_BOOLEAN, "failed", ...ended("error_max_turns")],
  ["error_max_budget_usd", true, "failed", ...ended("error_max_budget_usd"), "with_text"],
  ["error_max_budget_usd", false, "failed", ...ended("error_max_budget_usd")],
  ["error_max_budget_usd", ABSENT, "failed", ...ended("error_max_budget_usd")],
  ["error_max_budget_usd", NOT_A_BOOLEAN, "failed", ...ended("error_max_budget_usd")],
  ["error_max_structured_output_retries", true, "failed", ...ended("error_max_structured_output_retries"), "with_text"],
  ["error_max_structured_output_retries", false, "failed", ...ended("error_max_structured_output_retries")],
  ["error_max_structured_output_retries", ABSENT, "failed", ...ended("error_max_structured_output_retries")],
  ["error_max_structured_output_retries", NOT_A_BOOLEAN, "failed", ...ended("error_max_structured_output_retries")],

  ["interrupted", true, "interrupted", ...ended("interrupted"), "with_text"],
  ["interrupted", false, "interrupted", ...ended("interrupted")],
  ["interrupted", ABSENT, "interrupted", ...ended("interrupted")],
  ["interrupted", NOT_A_BOOLEAN, "interrupted", ...ended("interrupted")],

  // A subtype this code has never seen, and no subtype at all.
  ["a_subtype_from_the_future", true, "failed", ...unrecognized("subtype \"a_subtype_from_the_future\", is_error true")],
  ["a_subtype_from_the_future", false, "failed", ...unrecognized("subtype \"a_subtype_from_the_future\", is_error false")],
  ["a_subtype_from_the_future", ABSENT, "failed", ...unrecognized("subtype \"a_subtype_from_the_future\", no is_error")],
  ["a_subtype_from_the_future", NOT_A_BOOLEAN, "failed", ...unrecognized("subtype \"a_subtype_from_the_future\", an is_error that is not true or false")],
  [ABSENT, true, "failed", ...unrecognized("no subtype, is_error true")],
  [ABSENT, false, "failed", ...unrecognized("no subtype, is_error false")],
  [ABSENT, ABSENT, "failed", ...unrecognized("no subtype, no is_error")],
  [ABSENT, NOT_A_BOOLEAN, "failed", ...unrecognized("no subtype, an is_error that is not true or false")],
];

const RESULT_TEXTS: Array<[label: string, value: Field<string>]> = [
  ["present", CLAUDE_RESULT_TEXT], ["empty", ""], ["missing", ABSENT],
];

export const CLAUDE_RESULT_CELLS: ClaudeResultCell[] = ROWS.flatMap(([subtype, isError, ends, withText, withoutText, marked]) =>
  RESULT_TEXTS.map(([label, result]): ClaudeResultCell => {
    const hasText = result === CLAUDE_RESULT_TEXT;
    return {
      name: `${subtype === ABSENT ? "no subtype" : subtype} / ${isError === ABSENT ? "no is_error" : `is_error ${JSON.stringify(isError)}`} / result ${label}`,
      subtype, isError, result,
      ...(ends === "completed" ? { expected: hasText ? "answer" as const : "no_answer_in_result" as const }
        : { expected: ends, error: hasText ? withText : withoutText,
          ...((marked ?? MARKED_UNLESS_KNOWN) === "always" || (marked === "with_text" && hasText) ? { marked: true as const } : {}) }),
    };
  }));

/** The `result` event of one cell, for the exact turn and session. */
export function claudeResultEvent(cell: ClaudeResultCell, sessionId: string, turnId: string): Record<string, unknown> {
  return {
    type: "result",
    ...(cell.subtype === ABSENT ? {} : { subtype: cell.subtype }),
    ...(cell.isError === ABSENT ? {} : { is_error: cell.isError }),
    ...(cell.result === ABSENT ? {} : { result: cell.result }),
    session_id: sessionId,
    user_message_uuid: turnId,
  };
}

/** One real turn of Claude Code, as `__fixtures__/claude-code-result-shapes.json` holds it. */
export type RealClaudeCapture = {
  /** What the stand-in for the Messages API answered. */
  stub: string;
  seconds_to_result: number;
  /** Every line the CLI wrote to stdout, in order, but for its `system/init` lines. It goes on after the turn when the CLI did. */
  stream: Array<Record<string, unknown>>;
  /** The user and assistant rows of the session file, in order. They go on after the turn when the CLI did. */
  session: Array<Record<string, unknown>>;
  /** The user and assistant rows of the separate file in which the CLI keeps a sub-agent's rows. */
  subagent_session?: Array<Record<string, unknown>>;
};

/**
 * Real output of Claude Code 2.1.278. The fixture's `about` says how it was
 * recorded and what was replaced; `electron/scripts/record-claude-result-shapes.mjs` records it.
 */
export const CLAUDE_REAL_CAPTURES: Record<string, RealClaudeCapture> = (JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "__fixtures__", "claude-code-result-shapes.json"), "utf8",
)) as { captures: Record<string, RealClaudeCapture> }).captures;

/** The `result` line of a capture. */
export function realClaudeResult(capture: RealClaudeCapture): Record<string, unknown> {
  return capture.stream.find((event) => event.type === "result")!;
}

/** The captures in which the request to the model failed. */
export const CLAUDE_API_ERROR_CAPTURES: Record<string, RealClaudeCapture> = Object.fromEntries(
  Object.entries(CLAUDE_REAL_CAPTURES).filter(([, capture]) => realClaudeResult(capture).is_error === true));

/** A capture as the CLI wrote it for this session and this turn. */
export function realClaudeCapture(capture: RealClaudeCapture, sessionId: string, turnId: string): RealClaudeCapture {
  return JSON.parse(JSON.stringify(capture)
    .replaceAll("\"SESSION_ID\"", JSON.stringify(sessionId))
    .replaceAll("\"TURN_ID\"", JSON.stringify(turnId))) as RealClaudeCapture;
}

/** What happens next for an agent that holds a task, after a turn that failed. */
export type ClaudeFailureFollowUp =
  /** A follow-up turn for the task is queued and, after its delay, dispatched. Later messages run after it. */
  | "follow_up"
  /** A follow-up for the task is queued blocked, with the reason, until the owner uses Retry delivery. Later messages wait behind it. */
  | "blocked"
  /** Nothing is queued. The reason stays on the failed message, and later messages go ahead. */
  | "settled";

const RETRY_DELIVERY = "Resolve this issue, then use Retry delivery to continue the existing task.";
const NOT_CONTINUED = "The unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.";
/** What the owner reads on the follow-up item of each kind of failure. */
export const CLAUDE_FAILURE_TEXT = {
  temporary: "The provider failed temporarily. The agent will try again by itself.",
  authentication: `The model provider needs authentication or account access. ${RETRY_DELIVERY}`,
  billing: `The model provider has insufficient credit or quota. ${RETRY_DELIVERY}`,
  model: `The model provider cannot find the selected model, or this account cannot use it. ${RETRY_DELIVERY}`,
  /** Added to Claude's own text on the follow-up item: what the failure means for the conversation, and what Start fresh costs. */
  conversation: "The request does not fit the model's context, so each turn in this conversation fails the same way. Start fresh opens a new conversation and discards the context of this one. After it, use Retry delivery, then send a message to continue the task. If the size comes from attachments or tools, a new conversation may not help.",
  unknown: `The provider failed and safe automatic recovery could not be established. ${RETRY_DELIVERY}`,
  noReply: "The model stopped before writing a reply. The agent will try again once, after a short wait.",
  /** Added to Claude's own text on the failed message, when nothing is queued. */
  cannotSucceed: `Sending it again unchanged cannot help, so the unfinished task was not continued automatically. Existing work is preserved; send a message to continue it.`,
  refused: NOT_CONTINUED,
} as const;

/**
 * For each real API failure in the fixture: what Claude Code says about it in
 * its structured fields, the kind of failure that makes it, and what then
 * happens for an agent that holds a task. This is the table the owner
 * approved, written out for the captures. `before` is what the failure text
 * alone gave, which is what every failure got before the fields were read.
 */
export const CLAUDE_API_FAILURE_POLICY: Record<string, {
  facts: { status: number | null; terminalReason: string | null; category: string | null; promptTooLong?: true };
  /** The kind the fields make. Null: they do not say, and the text is read as for any provider. */
  kind: "short_fault" | "authentication" | "billing" | "model" | "conversation" | "request" | "output_limit" | null;
  /** The provider declined the content; that decides before the kind does. */
  refusal?: true;
  then: ClaudeFailureFollowUp;
  before: ClaudeFailureFollowUp;
  /**
   * What the owner reads on the follow-up item, or what is added to Claude's text on the message when there is
   * none. For the kind `conversation` it is added to Claude's text on the follow-up item (see `claudeFollowUpText`).
   */
  reads: string;
}> = {
  http_401_authentication: { facts: { status: 401, terminalReason: "api_error", category: "authentication_failed" }, kind: "authentication",
    then: "blocked", before: "blocked", reads: CLAUDE_FAILURE_TEXT.authentication },
  http_403_permission: { facts: { status: 403, terminalReason: "api_error", category: "authentication_failed" }, kind: "authentication",
    then: "blocked", before: "blocked", reads: CLAUDE_FAILURE_TEXT.authentication },
  http_404_not_found: { facts: { status: 404, terminalReason: "api_error", category: "model_not_found" }, kind: "model",
    then: "blocked", before: "blocked", reads: CLAUDE_FAILURE_TEXT.model },
  // Claude Code gave this 400 no name of its own. The provider's status says the request was not accepted.
  http_400_invalid_request: { facts: { status: 400, terminalReason: "api_error", category: "unknown" }, kind: "request",
    then: "settled", before: "blocked", reads: CLAUDE_FAILURE_TEXT.cannotSucceed },
  // The request does not fit the model's context, so every later turn in the conversation fails the same way: only
  // the owner can clear that. Claude Code's name for it is its name for many other failures. The terminal reason
  // says which it is, and so does the start of its text, which is all a session keeps.
  http_400_prompt_too_long: { facts: { status: 400, terminalReason: "prompt_too_long", category: "invalid_request", promptTooLong: true }, kind: "conversation",
    then: "blocked", before: "blocked", reads: CLAUDE_FAILURE_TEXT.conversation },
  // The same status as a malformed request. Only Claude Code's name for it says that the account has no credit.
  http_400_credit_balance: { facts: { status: 400, terminalReason: "api_error", category: "billing_error" }, kind: "billing",
    then: "blocked", before: "blocked", reads: CLAUDE_FAILURE_TEXT.billing },
  http_413_request_too_large: { facts: { status: 413, terminalReason: "image_error", category: "invalid_request" }, kind: "request",
    then: "settled", before: "blocked", reads: CLAUDE_FAILURE_TEXT.cannotSucceed },
  http_429_rate_limit: { facts: { status: 429, terminalReason: "api_error", category: "rate_limit" }, kind: "short_fault",
    then: "follow_up", before: "follow_up", reads: CLAUDE_FAILURE_TEXT.temporary },
  http_500_server_error: { facts: { status: 500, terminalReason: "api_error", category: "server_error" }, kind: "short_fault",
    then: "follow_up", before: "follow_up", reads: CLAUDE_FAILURE_TEXT.temporary },
  http_529_overloaded: { facts: { status: 529, terminalReason: "api_error", category: "server_error" }, kind: "short_fault",
    then: "follow_up", before: "follow_up", reads: CLAUDE_FAILURE_TEXT.temporary },
  // A connection fault has no status. The two differ in their text alone, and only one text read as temporary.
  connection_closed_mid_stream: { facts: { status: null, terminalReason: "api_error", category: "server_error" }, kind: "short_fault",
    then: "follow_up", before: "follow_up", reads: CLAUDE_FAILURE_TEXT.temporary },
  connection_refused: { facts: { status: null, terminalReason: "api_error", category: "server_error" }, kind: "short_fault",
    then: "follow_up", before: "blocked", reads: CLAUDE_FAILURE_TEXT.temporary },
  // No status and no name: the fields say nothing, so the text is read as before.
  stream_error_event: { facts: { status: null, terminalReason: "api_error", category: "unknown" }, kind: null,
    then: "blocked", before: "blocked", reads: CLAUDE_FAILURE_TEXT.unknown },
  stop_reason_max_tokens: { facts: { status: null, terminalReason: "api_error", category: "max_output_tokens" }, kind: "output_limit",
    then: "follow_up", before: "blocked", reads: CLAUDE_FAILURE_TEXT.noReply },
  stop_reason_refusal: { facts: { status: null, terminalReason: "api_error", category: "invalid_request" }, kind: "request", refusal: true,
    then: "settled", before: "blocked", reads: CLAUDE_FAILURE_TEXT.refused },
};

/** What the owner reads on the follow-up item of a captured failure, given Claude's own text for it. */
export function claudeFollowUpText(name: string, claudeText: string): string {
  const expected = CLAUDE_API_FAILURE_POLICY[name]!;
  return expected.kind === "conversation" ? `${claudeText} ${expected.reads}` : expected.reads;
}

/**
 * Failures that Claude Code 2.1.278 names `invalid_request`, in the words it has for them (read in its binary).
 * No capture holds these: each stands here as the captured rows of the prompt that is too long, with the text,
 * the status and the terminal reason of the failure (see `claudeInvalidRequestRows`). The status and the terminal
 * reason are set by hand. `kind` is what Claude's account of the failure makes, in the stream and in the session.
 */
export const CLAUDE_INVALID_REQUESTS: Record<string, { text: string; status: number | null; terminalReason: string; kind: "request" | "authentication" | "conversation" }> = {
  tool_history_mismatch: { status: 400, terminalReason: "api_error", kind: "request", text: "API Error: 400 due to tool use concurrency issues." },
  pdf_too_large: { status: 400, terminalReason: "api_error", kind: "request",
    text: "PDF too large (max 100 pages, 20MB). Try reading the file a different way (e.g., extract text with pdftotext)." },
  pdf_password_protected: { status: 400, terminalReason: "api_error", kind: "request", text: "PDF is password protected. Try using a CLI tool to extract or convert the PDF." },
  image_dimension: { status: 400, terminalReason: "api_error", kind: "request",
    text: "An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session." },
  model_not_in_plan: { status: 400, terminalReason: "api_error", kind: "request",
    text: "Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect." },
  disabled_organization_key: { status: 400, terminalReason: "api_error", kind: "request",
    text: "Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable" },
  // A key or an access that the owner can put right: the status of a refused credential says so, whatever the name.
  api_key_authentication_disabled: { status: 403, terminalReason: "api_error", kind: "authentication",
    text: "Your organization has disabled API key authentication · Unset ANTHROPIC_API_KEY and run /login to sign in with your claude.ai account" },
  api_key_helper_failing: { status: 401, terminalReason: "api_error", kind: "authentication",
    text: "Your apiKeyHelper script is failing · This usually means you need to re-authenticate with your provider · Run /status to see the script's error output" },
  // The context is full and Claude Code could not compact it: it sends no request, so there is no status.
  context_blocking_limit: { status: null, terminalReason: "blocking_limit", kind: "conversation",
    text: "Prompt is too long · automatic compaction failed: the summary request was rejected" },
};

/** One of `CLAUDE_INVALID_REQUESTS` as the CLI would write it for this session and this turn: its stream lines and its session rows. */
export function claudeInvalidRequestRows(name: string, sessionId: string, turnId: string): RealClaudeCapture {
  const failure = CLAUDE_INVALID_REQUESTS[name]!;
  const captured = realClaudeCapture(CLAUDE_REAL_CAPTURES.http_400_prompt_too_long!, sessionId, turnId);
  const inJson = (text: string) => JSON.stringify(text).slice(1, -1);
  const rows = JSON.parse(JSON.stringify(captured).replaceAll(inJson(realClaudeResult(captured).result as string), inJson(failure.text))) as RealClaudeCapture;
  for (const event of rows.stream) {
    if (event.type === "result") Object.assign(event, { api_error_status: failure.status, terminal_reason: failure.terminalReason });
  }
  for (const row of rows.session) {
    if (row.isApiErrorMessage !== true) continue;
    // The provider's own message is not the CLI's, and is not what these rows are about.
    delete row.errorDetails;
    if (failure.status === null) delete row.apiErrorStatus; else row.apiErrorStatus = failure.status;
  }
  return rows;
}
