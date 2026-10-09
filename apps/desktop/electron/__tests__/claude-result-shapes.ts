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
