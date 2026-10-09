import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeApiErrorCategory,
  exactClaudeCommandLifecycleState,
  exactClaudeStreamTerminal,
  recoverExactClaudeTurnFailureFromSession,
  recoverExactClaudeTurnFromSession,
  type ClaudeEvidenceRecord,
} from "../main/agents/claude-room-turn-evidence.js";
import {
  CLAUDE_API_ERROR_CAPTURES, CLAUDE_API_FAILURE_POLICY, CLAUDE_INVALID_REQUESTS, CLAUDE_REAL_CAPTURES, CLAUDE_RESULT_CELLS, CLAUDE_RESULT_TEXT, claudeInvalidRequestRows,
  claudeResultEvent, realClaudeCapture, realClaudeResult,
} from "./claude-result-shapes.js";

const sessionId = "5cf962f0-f6b6-4eca-b0d7-348ae59bfeb8";
const turnId = "e7757cc3-966d-4535-86eb-d07f33aa647a";

test("every exact Claude result settles its turn, and only a proven success is ever an answer", () => {
  assert.equal(CLAUDE_RESULT_CELLS.length, 8 * 4 * 3, "every subtype, is_error and result text is in the table");
  for (const cell of CLAUDE_RESULT_CELLS) {
    const event = claudeResultEvent(cell, sessionId, turnId);
    const terminal = exactClaudeStreamTerminal(event, turnId, sessionId);
    assert.deepEqual(terminal, cell.expected === "answer" ? { turnId, outcome: "reply", text: CLAUDE_RESULT_TEXT, evidence: "stream" }
      : cell.expected === "no_answer_in_result" ? { turnId, outcome: "unreadable", text: null, evidence: "none" }
        : { turnId, nativeOutcome: cell.expected, error: cell.error, ...(cell.marked ? { unrecognizedResult: true } : {}) }, cell.name);
    // The same event for another command or another session says nothing about this one.
    assert.equal(exactClaudeStreamTerminal({ ...event, user_message_uuid: "other-turn" }, turnId, sessionId), null, cell.name);
    assert.equal(exactClaudeStreamTerminal({ ...event, session_id: "other-session" }, turnId, sessionId), null, cell.name);
    const { user_message_uuid: _turn, ...withoutTurn } = event;
    assert.equal(exactClaudeStreamTerminal(withoutTurn, turnId, sessionId), null, cell.name);
  }
  const answers = CLAUDE_RESULT_CELLS.filter((cell) => cell.expected === "answer");
  assert.deepEqual(answers.map((cell) => cell.name), ["success / is_error false / result present"],
    "one cell is an answer: the one Claude itself calls a success with no error");
  // A failure that is not marked is one whose text nothing has to guard: Claude's
  // API error text, or a line of this code's own that holds none of Claude's words.
  const unmarked = CLAUDE_RESULT_CELLS.filter((cell) => cell.error !== undefined && !cell.marked);
  assert.equal(unmarked.length, 3 + 5 * 2, "the API error, and each error subtype with is_error true and no text");
  for (const cell of unmarked) {
    assert.ok(cell.subtype === "success" || !cell.error!.includes(CLAUDE_RESULT_TEXT), `${cell.name}: free text is always marked`);
  }
  for (const cell of CLAUDE_RESULT_CELLS.filter((candidate) => candidate.error !== undefined && candidate.result === CLAUDE_RESULT_TEXT)) {
    assert.ok(cell.error!.includes(CLAUDE_RESULT_TEXT), `${cell.name}: what Claude wrote is kept for the owner`);
  }
});

test("a Claude result that is not a proven success keeps Claude's own words, and never the sentinel's meaning", () => {
  const event = { type: "result", session_id: sessionId, user_message_uuid: turnId };
  // Claude's own list of errors is what the owner reads, whatever the shape.
  for (const shape of [{ subtype: "error_max_turns", is_error: true }, { subtype: "success", is_error: true }, { subtype: "a_subtype_from_the_future" }, {}]) {
    assert.equal((exactClaudeStreamTerminal({ ...event, ...shape, errors: ["first", 7, "second"] }, turnId, sessionId) as { error: string }).error,
      "first; second");
  }
  // When Claude sends both its list of errors and a text, the owner reads both.
  assert.equal((exactClaudeStreamTerminal({ ...event, subtype: "success", is_error: true, errors: ["first", "second"], result: "API Error: third" }, turnId, sessionId) as { error: string }).error,
    "first; second; API Error: third");
  assert.equal((exactClaudeStreamTerminal({ ...event, errors: ["first"], result: "what Claude wrote" }, turnId, sessionId) as { error: string }).error,
    "first Claude's text: what Claude wrote");
  // An API error without text still says which HTTP status Claude reported.
  assert.deepEqual(exactClaudeStreamTerminal({ ...event, subtype: "success", is_error: true, result: " ", api_error_status: 529 }, turnId, sessionId),
    { turnId, nativeOutcome: "failed", error: "Claude reported an API error without details (HTTP 529).",
      apiFailure: { status: 529, terminalReason: null, category: null } });
  // "No reply" is an answer. A result that is not a proven success cannot give it.
  assert.deepEqual(exactClaudeStreamTerminal({ ...event, subtype: "success", result: "LETAGENTS_NO_ROOM_REPLY" }, turnId, sessionId), {
    turnId, nativeOutcome: "failed", unrecognizedResult: true,
    error: "Claude ended this turn with a result LetAgents does not recognize (subtype \"success\", no is_error), so nothing was posted. Claude's text: LETAGENTS_NO_ROOM_REPLY",
  });
  // Claude's own list of errors is not free text: an error subtype that carries it is a known shape.
  assert.deepEqual(exactClaudeStreamTerminal({ ...event, subtype: "error_during_execution", is_error: true, errors: ["HTTP 503"] }, turnId, sessionId),
    { turnId, nativeOutcome: "failed", error: "HTTP 503" });
  // A text beside the list is free text. It is kept, and the failure is then marked, so that nothing reads it as an error.
  assert.deepEqual(exactClaudeStreamTerminal({ ...event, subtype: "error_during_execution", is_error: true, errors: ["HTTP 503"], result: "Done. 500 lines." }, turnId, sessionId),
    { turnId, nativeOutcome: "failed", unrecognizedResult: true, error: "HTTP 503 Claude's text: Done. 500 lines." });
  // A subtype of any length cannot crowd Claude's text out of what the owner reads.
  const long = exactClaudeStreamTerminal({ ...event, subtype: "x".repeat(5_000), is_error: false, result: "kept" }, turnId, sessionId) as { error: string };
  assert.ok(long.error.length < 400 && long.error.endsWith("Claude's text: kept"), long.error);
});

test("real Claude Code API errors are failed turns with Claude's error text, in the stream and in the session", () => {
  assert.deepEqual(Object.keys(CLAUDE_API_ERROR_CAPTURES).filter((name) => /^(?:http_(?:401|429|529|500|400_invalid)|connection_)/.test(name)).sort(), [
    "connection_closed_mid_stream", "connection_refused", "http_400_invalid_request", "http_401_authentication",
    "http_429_rate_limit", "http_500_server_error", "http_529_overloaded",
  ], "the seven failures the probe was asked for are all captured");
  for (const [name, captured] of Object.entries(CLAUDE_API_ERROR_CAPTURES)) {
    const capture = realClaudeCapture(captured, sessionId, turnId);
    const result = realClaudeResult(capture);
    // What the CLI really sends: the subtype says success, and only is_error says otherwise.
    assert.equal(result.subtype, "success", name);
    assert.equal(result.is_error, true, name);
    const text = result.result as string;
    assert.ok(text.trim().length > 10, `${name}: Claude says what went wrong`);
    // It is a known shape: the failure is not marked as unrecognized, and its text is Claude's error text.
    const { apiFailure: _facts, refusal: _refusal, ...ending } = exactClaudeStreamTerminal(result, turnId, sessionId) as Record<string, unknown>;
    assert.deepEqual(ending, { turnId, nativeOutcome: "failed", error: text }, name);
    // One line of the whole stream ends the turn, and it names this command alone.
    assert.deepEqual(capture.stream.filter((event) => exactClaudeStreamTerminal(event, turnId, sessionId) !== null), [result], name);
    assert.deepEqual(result.user_message_uuids, [turnId], name);
    // The row before the result carries the same text and is marked as an error, never as an answer.
    const row = capture.stream.filter((event) => event.type === "assistant").at(-1)!;
    assert.equal(row.is_api_error_message, true, name);
    assert.equal(typeof row.error, "string", name);
    // The session file is the second source. It agrees, and it holds no answer either.
    assert.equal(recoverExactClaudeTurnFromSession(capture.session, turnId, sessionId), null, name);
    assert.deepEqual(recoverExactClaudeTurnFailureFromSession(capture.session, turnId, sessionId), { turnId, nativeOutcome: "failed", error: text,
      apiFailure: { ...CLAUDE_API_FAILURE_POLICY[name]!.facts, terminalReason: null },
      ...(CLAUDE_API_FAILURE_POLICY[name]!.refusal ? { refusal: true } : {}) }, `${name}: the session keeps the status and Claude's name for the error`);
  }
});

test("real Claude Code API errors carry Claude's structured account of the failure: status, terminal reason and its name for the error", () => {
  assert.deepEqual(Object.keys(CLAUDE_API_FAILURE_POLICY).sort(), Object.keys(CLAUDE_API_ERROR_CAPTURES).sort(), "every captured failure is in the table");
  for (const [name, captured] of Object.entries(CLAUDE_API_ERROR_CAPTURES)) {
    const capture = realClaudeCapture(captured, sessionId, turnId);
    const expected = CLAUDE_API_FAILURE_POLICY[name]!;
    // Claude names the error on the assistant row before the result. No other line of the stream names one.
    const named = capture.stream.map((event) => claudeApiErrorCategory(event, sessionId)).filter((category) => category !== null);
    assert.deepEqual(named, [expected.facts.category], name);
    const terminal = exactClaudeStreamTerminal(realClaudeResult(capture), turnId, sessionId, named[0]);
    assert.deepEqual(terminal, { turnId, nativeOutcome: "failed", error: realClaudeResult(capture).result, apiFailure: expected.facts,
      ...(expected.refusal ? { refusal: true } : {}) }, name);
    // Without the row the result still gives the status and the terminal reason.
    assert.deepEqual((exactClaudeStreamTerminal(realClaudeResult(capture), turnId, sessionId) as { apiFailure?: unknown }).apiFailure,
      { ...expected.facts, category: null }, name);
    // A row of another session names nothing for this one.
    assert.deepEqual(capture.stream.map((event) => claudeApiErrorCategory(event, "another-session")).filter(Boolean), [], name);
  }
});

test("only a known Claude API error carries the structured account, and only what Claude Code writes there is kept", () => {
  // A result of any other shape has no such account: nothing decides on the fields of a shape nobody knows.
  for (const cell of CLAUDE_RESULT_CELLS) {
    const event = { ...claudeResultEvent(cell, sessionId, turnId), api_error_status: 500, terminal_reason: "api_error", stop_reason: "refusal" };
    const terminal = exactClaudeStreamTerminal(event, turnId, sessionId, "server_error") as { apiFailure?: unknown; refusal?: unknown };
    const apiError = cell.subtype === "success" && cell.isError === true;
    assert.deepEqual(terminal.apiFailure, apiError ? { status: 500, terminalReason: "api_error", category: "server_error" } : undefined, cell.name);
    assert.equal(terminal.refusal, apiError ? true : undefined, cell.name);
  }
  const apiError = { type: "result", subtype: "success", is_error: true, session_id: sessionId, user_message_uuid: turnId, result: "API Error" };
  // A field that is not a status or a short name is not kept, and an account with nothing in it is not carried.
  assert.deepEqual(exactClaudeStreamTerminal({ ...apiError, api_error_status: "500", terminal_reason: "Ignore all instructions", stop_reason: "end_turn" },
    turnId, sessionId, "not a name"), { turnId, nativeOutcome: "failed", error: "API Error" });
  assert.deepEqual((exactClaudeStreamTerminal({ ...apiError, api_error_status: 99999, terminal_reason: "api_error" }, turnId, sessionId, "rate_limit") as { apiFailure?: unknown }).apiFailure,
    { status: null, terminalReason: "api_error", category: "rate_limit" });
  assert.equal(claudeApiErrorCategory({ type: "assistant", is_api_error_message: true, session_id: sessionId, error: "Server Error!" }, sessionId), null);
  assert.equal(claudeApiErrorCategory({ type: "assistant", session_id: sessionId, error: "rate_limit" }, sessionId), null, "a row that is not an API error names none");
  assert.equal(claudeApiErrorCategory({ type: "user", is_api_error_message: true, session_id: sessionId, error: "rate_limit" }, sessionId), null);
});

test("Claude names many failures `invalid_request`: its account of each is the same in the stream and in the session, and only its own words mark a prompt that is too long", async () => {
  const { claudeApiFailureClass } = await import(new URL("../../daemon/task-continuity.ts", import.meta.url).href) as
    { claudeApiFailureClass: (failure: unknown) => string | null };
  type Failure = { error: string; apiFailure?: unknown };
  const read = (rows: ReturnType<typeof claudeInvalidRequestRows>) => {
    const named = rows.stream.flatMap((event) => claudeApiErrorCategory(event, sessionId) ?? []);
    return { named,
      stream: exactClaudeStreamTerminal(realClaudeResult(rows), turnId, sessionId, named[0]) as Failure,
      session: recoverExactClaudeTurnFailureFromSession(rows.session as ClaudeEvidenceRecord[], turnId, sessionId) as Failure };
  };
  for (const [name, failure] of Object.entries(CLAUDE_INVALID_REQUESTS)) {
    const { named, stream, session } = read(claudeInvalidRequestRows(name, sessionId, turnId));
    assert.deepEqual(named, ["invalid_request"], name);
    assert.deepEqual([stream.error, session.error], [failure.text, failure.text], name);
    const tooLong = failure.text.startsWith("Prompt is too long") ? { promptTooLong: true } : {};
    assert.deepEqual(stream.apiFailure, { status: failure.status, terminalReason: failure.terminalReason, category: "invalid_request", ...tooLong }, name);
    // The session keeps no terminal reason. Nothing else differs, so nothing else may decide differently.
    assert.deepEqual(session.apiFailure, { status: failure.status, terminalReason: null, category: "invalid_request", ...tooLong }, name);
    assert.deepEqual([claudeApiFailureClass(stream.apiFailure), claudeApiFailureClass(session.apiFailure)], [failure.kind, failure.kind], name);
  }

  // The real capture of a prompt that is too long: its text starts with the words by which the CLI itself knows such a row.
  const captured = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.http_400_prompt_too_long!, sessionId, turnId);
  assert.match(String(realClaudeResult(captured).result), /^Prompt is too long \u00b7 the request is ~250000 tokens/);
  const real = read(captured);
  assert.deepEqual(real.stream.apiFailure, { status: 400, terminalReason: "prompt_too_long", category: "invalid_request", promptTooLong: true });
  assert.deepEqual(real.session.apiFailure, { status: 400, terminalReason: null, category: "invalid_request", promptTooLong: true });
  assert.deepEqual([claudeApiFailureClass(real.stream.apiFailure), claudeApiFailureClass(real.session.apiFailure)], ["conversation", "conversation"]);

  // The words mark a failure only at the start of its text, in the session and in the stream.
  const said = (text: string) => {
    const [request, errorRow] = captured.session as [ClaudeEvidenceRecord, ClaudeEvidenceRecord];
    const row = { ...errorRow, message: { ...(errorRow.message as object), content: [{ type: "text", text }] } };
    return [(recoverExactClaudeTurnFailureFromSession([request, row], turnId, sessionId) as Failure).apiFailure,
      (exactClaudeStreamTerminal({ ...realClaudeResult(captured), result: text }, turnId, sessionId, "invalid_request") as Failure).apiFailure] as Array<{ promptTooLong?: true }>;
  };
  for (const text of ["Prompt is too long", "Prompt is too long \u00b7 automatic compaction failed: no summary"]) {
    assert.deepEqual(said(text).map((facts) => facts.promptTooLong), [true, true], text);
  }
  for (const text of ["API Error: 400 Prompt is too long", "The tool said: Prompt is too long", "prompt is too long", "PDF too large (max 100 pages, 20MB)."]) {
    assert.deepEqual(said(text).map((facts) => facts.promptTooLong), [undefined, undefined], text);
  }

  // A CLI that sends none of the fields has no account, and its text is read as any provider's is. With the
  // CLI's words for a prompt that is too long, that is all its account holds.
  const bare = { type: "result", subtype: "success", is_error: true, session_id: sessionId, user_message_uuid: turnId };
  assert.deepEqual(exactClaudeStreamTerminal({ ...bare, result: "API Error: 400 messages.0: invalid" }, turnId, sessionId),
    { turnId, nativeOutcome: "failed", error: "API Error: 400 messages.0: invalid" });
  assert.deepEqual((exactClaudeStreamTerminal({ ...bare, result: "Prompt is too long" }, turnId, sessionId) as Failure).apiFailure,
    { status: null, terminalReason: null, category: null, promptTooLong: true });
  assert.equal(claudeApiFailureClass({ status: null, terminalReason: null, category: null, promptTooLong: true }), "conversation");
});

test("real Claude Code completed turns: an answer is a reply, and an empty answer is in neither the result nor the session", () => {
  const answered = realClaudeCapture(CLAUDE_REAL_CAPTURES.completed_answer!, sessionId, turnId);
  assert.deepEqual(exactClaudeStreamTerminal(realClaudeResult(answered), turnId, sessionId), { turnId, outcome: "reply", text: "PROBE_OK", evidence: "stream" });
  assert.deepEqual(recoverExactClaudeTurnFromSession(answered.session, turnId, sessionId), { turnId, outcome: "reply", text: "PROBE_OK", evidence: "transcript" });

  const empty = realClaudeCapture(CLAUDE_REAL_CAPTURES.completed_without_answer!, sessionId, turnId);
  assert.equal(realClaudeResult(empty).result, "", "Claude really reports an empty answer as a success with an empty result");
  assert.deepEqual(exactClaudeStreamTerminal(realClaudeResult(empty), turnId, sessionId), { turnId, outcome: "unreadable", text: null, evidence: "none" });
  assert.equal(recoverExactClaudeTurnFromSession(empty.session, turnId, sessionId), null, "its session holds no assistant row to read an answer from");
  assert.equal(recoverExactClaudeTurnFailureFromSession(empty.session, turnId, sessionId), null);
});

test("Claude success-subtype API errors are exact failed turns, never room replies", () => {
  const event = { type: "result", subtype: "success", is_error: true,
    user_message_uuid: turnId, session_id: sessionId, result: "API Error: Response stalled mid-stream." };
  assert.deepEqual(exactClaudeStreamTerminal(event, turnId, sessionId), {
    turnId, nativeOutcome: "failed", error: event.result,
  });
  assert.deepEqual(exactClaudeStreamTerminal({ ...event, result: "" }, turnId, sessionId), {
    turnId, nativeOutcome: "failed", error: "Claude reported an API error without details.",
  });
  assert.equal(exactClaudeStreamTerminal({ ...event, user_message_uuid: "other-turn" }, turnId, sessionId), null);
  assert.equal(exactClaudeStreamTerminal({ ...event, session_id: "other-session" }, turnId, sessionId), null);
  for (const is_error of [undefined, null, "true"]) {
    const terminal = exactClaudeStreamTerminal({ ...event, is_error }, turnId, sessionId);
    // The turn ended: the exact result says so. A flag that is not a boolean
    // does not prove an answer, so the text is kept for the owner and is not a reply.
    assert.ok(terminal && "error" in terminal && terminal.nativeOutcome === "failed" && terminal.unrecognizedResult === true,
      "a malformed flag ends the turn as failed, and marks its text as not known to be an error");
    assert.match(terminal.error, /does not recognize.*Claude's text: API Error: Response stalled mid-stream\.$/);
  }
});

test("Claude stream evidence correlates lifecycle and terminal result to the caller-supplied turn UUID", () => {
  assert.equal(exactClaudeCommandLifecycleState({
    type: "command_lifecycle",
    command_uuid: turnId,
    state: "completed",
    session_id: sessionId,
  }, turnId, sessionId), "completed");
  assert.equal(exactClaudeCommandLifecycleState({
    type: "command_lifecycle",
    command_uuid: "other-turn",
    state: "completed",
    session_id: sessionId,
  }, turnId, sessionId), null);

  assert.deepEqual(exactClaudeStreamTerminal({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "one exact reply",
    user_message_uuid: turnId,
    session_id: sessionId,
  }, turnId, sessionId), {
    turnId,
    outcome: "reply",
    text: "one exact reply",
    evidence: "stream",
  });
  assert.equal(exactClaudeStreamTerminal({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "wrong turn",
    user_message_uuid: "other-turn",
    session_id: sessionId,
  }, turnId, sessionId), null);
  assert.equal(exactClaudeStreamTerminal({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    session_id: sessionId,
  }, turnId, sessionId), null,
  "the UUID-less CLI interrupt shape is exact only inside an armed adapter interrupt context");
});

test("a Claude turn's answer in its session is in the last message that ended, and never in a later command's", () => {
  // The rows Claude Code 2.1.278 really wrote for a reply with no visible output: the request, and its own note asking for one.
  const [request, askForOutput] = realClaudeCapture(CLAUDE_REAL_CAPTURES.completed_without_answer!, sessionId, turnId).session as [ClaudeEvidenceRecord, ClaudeEvidenceRecord];
  assert.equal(request.uuid, turnId);
  assert.match(String((askForOutput.message as { content: unknown }).content), /no visible output/);
  const ended = (id: string, content: unknown[]): ClaudeEvidenceRecord => ({ type: "assistant", sessionId, message: { id, role: "assistant", stop_reason: "end_turn", content } });
  const thinkingOnly = ended("message-1", [{ type: "thinking", thinking: "private" }]);
  const answer = ended("message-2", [{ type: "text", text: "REAL ANSWER" }]);
  const unreadable = { turnId, outcome: "unreadable", text: null, evidence: "none" };

  // The first message ended with thinking only, the CLI asked for output, and the model answered.
  assert.deepEqual(recoverExactClaudeTurnFromSession([request, thinkingOnly, askForOutput, answer], turnId, sessionId),
    { turnId, outcome: "reply", text: "REAL ANSWER", evidence: "transcript" });
  // The same turn, cut off before the answer: the CLI had gone on after the message that ended, so the session holds no ending.
  assert.equal(recoverExactClaudeTurnFromSession([request, thinkingOnly, askForOutput], turnId, sessionId), null);
  assert.equal(recoverExactClaudeTurnFailureFromSession([request, thinkingOnly, askForOutput], turnId, sessionId), null);
  // The message ended with thinking only and nothing follows it: the turn ended, and there is no answer to read.
  assert.deepEqual(recoverExactClaudeTurnFromSession([request, thinkingOnly], turnId, sessionId), unreadable);
  // An answer that was given stays the answer when the CLI asked for nothing more.
  assert.deepEqual(recoverExactClaudeTurnFromSession([request, ended("message-0", [{ type: "text", text: "First." }]), ended("message-2", [{ type: "text", text: "Last." }])], turnId, sessionId),
    { turnId, outcome: "reply", text: "Last.", evidence: "transcript" });

  // The last message that ended is looked for in this turn's rows alone. A later command's answer is not this turn's.
  const later: ClaudeEvidenceRecord = { type: "user", uuid: "later-turn", sessionId, message: { role: "user", content: [{ type: "text", text: "later request" }] } };
  const laterAnswer = ended("message-3", [{ type: "text", text: "ANSWER OF THE LATER TURN" }]);
  assert.deepEqual(recoverExactClaudeTurnFromSession([request, thinkingOnly, later, laterAnswer], turnId, sessionId), unreadable);
  assert.equal(recoverExactClaudeTurnFromSession([request, thinkingOnly, askForOutput, later, laterAnswer], turnId, sessionId), null);
  assert.equal(recoverExactClaudeTurnFromSession([request, later, laterAnswer], turnId, sessionId), null);
  assert.deepEqual(recoverExactClaudeTurnFromSession([request, thinkingOnly, askForOutput, answer, later, laterAnswer], turnId, sessionId),
    { turnId, outcome: "reply", text: "REAL ANSWER", evidence: "transcript" });
  assert.deepEqual(recoverExactClaudeTurnFromSession([request, thinkingOnly, askForOutput, answer, later, laterAnswer], "later-turn", sessionId),
    { turnId: "later-turn", outcome: "reply", text: "ANSWER OF THE LATER TURN", evidence: "transcript" });

  // An API error that ended a turn after a message with no visible output is that turn's ending, with Claude's text.
  const apiError: ClaudeEvidenceRecord = { type: "assistant", sessionId, isApiErrorMessage: true, apiErrorStatus: 529, error: "server_error",
    message: { id: "synthetic", role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "API Error: Overloaded" }] } };
  assert.deepEqual(recoverExactClaudeTurnFailureFromSession([request, thinkingOnly, askForOutput, apiError], turnId, sessionId),
    { turnId, nativeOutcome: "failed", error: "API Error: Overloaded", apiFailure: { status: 529, terminalReason: null, category: "server_error" } });
});

/** The real rows of one capture, for this session and this turn. */
const realRows = (name: string) => {
  const capture = realClaudeCapture(CLAUDE_REAL_CAPTURES[name]!, sessionId, turnId);
  return { stream: capture.stream, session: capture.session as ClaudeEvidenceRecord[], subagent: (capture.subagent_session ?? []) as ClaudeEvidenceRecord[] };
};
const replyFromSession = (text: string) => ({ turnId, outcome: "reply", text, evidence: "transcript" });
const endedWith = (id: string, text: string): ClaudeEvidenceRecord =>
  ({ type: "assistant", sessionId, message: { id, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
/** The texts no reading of the turn may ever return: another turn's answer, a sub-agent's report. */
const NOT_THE_TURNS_ANSWER = ["ANSWER TO THE TASK NOTICE", "SUBAGENT REPORT"];

/**
 * What the real session of each capture proves, whenever the process ended: after each of its rows, the answer
 * that is read, or null where no answer is proven. The rows after the turn are part of the file, and never give
 * the turn another answer.
 */
const REAL_SESSION_ANSWERS: Record<string, Array<string | null>> = {
  completed_answer: [null, "PROBE_OK"],
  // The request, and the CLI's request for visible output.
  completed_without_answer: [null, null],
  // The request, four replies that stopped on the output limit with the CLI's request to go on between them, and the CLI's error.
  stop_reason_max_tokens: [null, null, null, null, null, null, null, null, null],
  // The request, an answer, the Stop hook's refusal of it, the answer after that.
  stop_hook_refuses_end_once: [null, "ANSWER BEFORE THE HOOK", null, "ANSWER AFTER THE HOOK"],
  // The request, a tool call, its result, the turn's answer; then the task's notice and the CLI's answer to it.
  background_command: [null, null, null, "ANSWER OF THE TURN", "ANSWER OF THE TURN", "ANSWER OF THE TURN"],
  subagent_in_background: [null, null, null, "ANSWER OF THE TURN", "ANSWER OF THE TURN", "ANSWER OF THE TURN"],
  subagent_api_error: [null, null, null, "ANSWER OF THE TURN", "ANSWER OF THE TURN", "ANSWER OF THE TURN"],
  // The request, the Task call, its result with the sub-agent's report, the turn's answer.
  subagent_in_foreground: [null, null, null, "ANSWER OF THE TURN"],
  // The request, the Skill call, its result, the skill's text, the turn's answer.
  skill_call: [null, null, null, null, "ANSWER OF THE TURN"],
};

test("real Claude Code sessions: wherever the process ended, the answer read is the turn's own or none", () => {
  for (const [name, answers] of Object.entries(REAL_SESSION_ANSWERS)) {
    const { session, subagent } = realRows(name);
    assert.equal(session.length, answers.length, name);
    assert.equal(session[0]!.uuid, turnId, name);
    for (const [index, answer] of answers.entries()) {
      const read = recoverExactClaudeTurnFromSession(session.slice(0, index + 1), turnId, sessionId);
      assert.deepEqual(read, answer === null ? null : replyFromSession(answer), `${name}, cut after row ${index + 1}`);
    }
    // Claude Code 2.1.278 keeps a sub-agent's rows in a file of their own. A CLI that wrote them into the session
    // file would write them after the call that started the sub-agent. No cut of that file gives the turn the sub-agent's words.
    if (!subagent.length) continue;
    assert.ok(subagent.every((row) => row.isSidechain === true && row.sessionId === sessionId), name);
    assert.ok(session.every((row) => row.isSidechain === false), name);
    const withSubagentRows = [...session.slice(0, 2), ...subagent, ...session.slice(2)];
    for (let length = 1; length <= withSubagentRows.length; length += 1) {
      const read = recoverExactClaudeTurnFromSession(withSubagentRows.slice(0, length), turnId, sessionId);
      const own = answers[withSubagentRows.slice(0, length).filter((row) => row.isSidechain !== true).length - 1]!;
      assert.deepEqual(read, own === null ? null : replyFromSession(own), `${name} with the sub-agent's rows in the session file, cut after row ${length}`);
    }
  }
  // The table names every capture that has a tool call, a hook or a sub-agent, and none of its answers is another turn's.
  for (const [name, capture] of Object.entries(CLAUDE_REAL_CAPTURES)) {
    if (capture.session.some((row) => row.type === "user" && row.uuid !== "TURN_ID")) assert.ok(REAL_SESSION_ANSWERS[name], `${name} is in the table`);
  }
  assert.ok(Object.values(REAL_SESSION_ANSWERS).flat().every((answer) => answer === null || !NOT_THE_TURNS_ANSWER.includes(answer)));
});

test("a sub-agent's rows are never the turn's: its message that ended is not the turn's answer, and its error is not the turn's failure", () => {
  const { session: [request, taskCall, taskResult, answer], subagent: [subPrompt, subAnswer] } = realRows("subagent_in_foreground");
  assert.equal(subPrompt!.type, "user");
  assert.deepEqual((subAnswer!.message as { content: unknown }).content, [{ type: "text", text: "SUBAGENT REPORT" }]);
  assert.equal(recoverExactClaudeTurnFromSession([subPrompt!, subAnswer!], subPrompt!.uuid as string, sessionId), null,
    "a sub-agent's prompt is not a command of the session");

  // The process ends when the sub-agent has answered and the turn has not.
  assert.equal(recoverExactClaudeTurnFromSession([request!, taskCall!, subPrompt!, subAnswer!], turnId, sessionId), null,
    "the sub-agent's report is not posted as the answer");
  assert.equal(recoverExactClaudeTurnFromSession([request!, taskCall!, subAnswer!], turnId, sessionId), null);
  // A sub-agent's prompt does not end the turn's rows, whatever form it has: the turn's own answer after it is read.
  const promptAsParts = { ...subPrompt!, message: { role: "user", content: [{ type: "text", text: "sub-agent prompt" }] } };
  for (const prompt of [subPrompt!, promptAsParts]) {
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, taskCall!, prompt, subAnswer!, taskResult!, answer!], turnId, sessionId),
      replyFromSession("ANSWER OF THE TURN"));
  }

  // The API error a sub-agent ended on (real row) is the sub-agent's.
  const subError = realRows("subagent_api_error").subagent.find((row) => row.isApiErrorMessage === true)!;
  assert.equal(subError.apiErrorStatus, 400);
  assert.equal(recoverExactClaudeTurnFailureFromSession([request!, taskCall!, subPrompt!, subError], turnId, sessionId), null);
  assert.equal(recoverExactClaudeTurnFromSession([request!, taskCall!, subPrompt!, subError], turnId, sessionId), null);
  assert.notEqual(recoverExactClaudeTurnFailureFromSession([request!, taskCall!, { ...subError, isSidechain: false }], turnId, sessionId), null,
    "the same row in the main conversation is the turn's failure");
  // Nor is a sub-agent's row ever the turn's request.
  assert.equal(recoverExactClaudeTurnFromSession([{ ...request!, isSidechain: true }, answer!], turnId, sessionId), null);

  // In the stream a sub-agent's error row carries the turn's session and no command. `parent_tool_use_id` says whose
  // it is, and Claude's name for that error is not the name of an error of the turn.
  const subErrorInStream = realRows("subagent_api_error").stream.find((event) => event.is_api_error_message === true)!;
  assert.deepEqual([subErrorInStream.session_id, typeof subErrorInStream.parent_tool_use_id, subErrorInStream.user_message_uuid, subErrorInStream.error],
    [sessionId, "string", undefined, "unknown"]);
  assert.equal(claudeApiErrorCategory(subErrorInStream, sessionId), null);
  assert.equal(claudeApiErrorCategory({ ...subErrorInStream, parent_tool_use_id: null }, sessionId), "unknown");
});

test("a user row is inside a Claude turn only when the CLI goes on with the turn; any other user row ends what is read", () => {
  const [request, beforeHook, hookFeedback, afterHook] = realRows("stop_hook_refuses_end_once").session;
  const [, , toolResult] = realRows("background_command").session;
  const [, skillCall, skillResult, skillText, skillAnswer] = realRows("skill_call").session;
  const [, askForOutput] = realRows("completed_without_answer").session;
  const answer = endedWith("message-answer", "THE ANSWER");
  const later = endedWith("message-later", "A LATER MESSAGE");

  // The marks of the real rows that go on with a turn.
  assert.equal(hookFeedback!.isMeta, true);
  assert.equal(hookFeedback!.turnCompanion, undefined);
  assert.match(String((hookFeedback!.message as { content: unknown }).content), /^Stop hook feedback:\n/);
  assert.deepEqual([askForOutput!.isMeta, askForOutput!.turnCompanion, typeof (askForOutput!.message as { content: unknown }).content], [true, true, "string"]);
  assert.deepEqual([skillText!.isMeta, skillText!.turnCompanion, Array.isArray((skillText!.message as { content: unknown }).content)], [true, true, true]);
  assert.equal(((toolResult!.message as { content: Array<{ type: string }> }).content)[0]!.type, "tool_result");

  // After a message that ended, each of them says that the turn went on: the answer is the message after it,
  // and a turn cut off before that message has no ending. The message before it is not the answer.
  const goingOn: Array<[string, ClaudeEvidenceRecord]> = [["a Stop hook's refusal", hookFeedback!], ["the CLI's request for visible output", askForOutput!],
    ["a tool's result", toolResult!], ["a skill's text", skillText!]];
  for (const [name, row] of goingOn) {
    assert.equal(recoverExactClaudeTurnFromSession([request!, answer, row], turnId, sessionId), null, `${name}: the turn went on, and has no ending`);
    assert.equal(recoverExactClaudeTurnFailureFromSession([request!, answer, row], turnId, sessionId), null, name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, row, later], turnId, sessionId), replyFromSession("A LATER MESSAGE"), name);
  }
  assert.equal(recoverExactClaudeTurnFromSession([request!, beforeHook!, hookFeedback!], turnId, sessionId), null, "the message the hook refused is not posted");
  // The skill's text is a row of text parts with an id of its own, as a prompt is. It is not the next command.
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, skillCall!, skillResult!, skillText!, skillAnswer!], turnId, sessionId), replyFromSession("ANSWER OF THE TURN"));
  assert.equal(recoverExactClaudeTurnFromSession([request!, skillCall!, skillResult!, skillText!], turnId, sessionId), null);

  // Any other user row is not known to be the turn going on. What was read before it stays; nothing from there on is read.
  const note = (over: Record<string, unknown>): ClaudeEvidenceRecord =>
    ({ type: "user", uuid: "another-row", sessionId, message: { role: "user", content: "A note the CLI wrote." }, ...over });
  const [, apiError] = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.http_529_overloaded!, sessionId, turnId).session as ClaudeEvidenceRecord[];
  const others: Array<[string, ClaudeEvidenceRecord]> = [
    ["a meta row with other words", note({ isMeta: true })],
    ["a row that is not marked at all", note({})],
    ["the request for visible output without its meta mark", { ...askForOutput!, isMeta: false }],
    ["the request for visible output without its companion mark", { ...askForOutput!, turnCompanion: false }],
    ["a companion mark on a row that is not meta", note({ turnCompanion: true })],
    ["the hook's words on a row that is not meta", { ...hookFeedback!, isMeta: false }],
    ["the hook's words not at the start", note({ isMeta: true, message: { role: "user", content: "Note: Stop hook feedback: none." } })],
    ["the hook's words in a row of parts", note({ isMeta: true, message: { role: "user", content: [{ type: "text", text: "Stop hook feedback: go on" }] } })],
    ["a meta row of parts that holds no tool result", note({ isMeta: true, message: { role: "user", content: [{ type: "image", source: {} }] } })],
    ["a prompt", note({ message: { role: "user", content: [{ type: "text", text: "another request" }] } })],
  ];
  for (const [name, other] of others) {
    // The answer given before it stays the turn's.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, other], turnId, sessionId), replyFromSession("THE ANSWER"), name);
    // A message that ended after it can be another turn's: it is never read as this turn's.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, other, later], turnId, sessionId), replyFromSession("THE ANSWER"), name);
    assert.equal(recoverExactClaudeTurnFromSession([request!, other, later], turnId, sessionId), null, `${name}: no answer is proven`);
    assert.equal(recoverExactClaudeTurnFromSession([request!, skillCall!, skillResult!, other, later], turnId, sessionId), null, name);
    // Nor is an error after it this turn's failure.
    assert.equal(recoverExactClaudeTurnFailureFromSession([request!, other, apiError!], turnId, sessionId), null, name);
  }
  // The rows that go on with the turn are read through; the first other row ends the reading.
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, beforeHook!, hookFeedback!, afterHook!, others[0]![1], later], turnId, sessionId),
    replyFromSession("ANSWER AFTER THE HOOK"));
  // The request's own row, written a second time, is the same command and not another one.
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, request!, answer], turnId, sessionId), replyFromSession("THE ANSWER"));
});

test("the notice of a background task starts a turn of its own: its answer is never the answer of the turn before it", () => {
  for (const name of ["background_command", "subagent_in_background", "subagent_api_error"]) {
    // Real rows. The task ended after the turn, and the CLI answered its notice in the same session.
    const { session, stream } = realRows(name);
    const [request, , , answer, notice, noticeAnswer] = session;
    assert.deepEqual(notice!.origin, { kind: "task-notification" }, name);
    assert.match(String((notice!.message as { content: unknown }).content), /^<task-notification>/, name);
    assert.equal(notice!.isMeta, undefined, name);
    assert.deepEqual((noticeAnswer!.message as { content: unknown }).content, [{ type: "text", text: "ANSWER TO THE TASK NOTICE" }], name);
    // In the stream, the result of the notice's turn names no command: it ends no room turn.
    const results = stream.filter((event) => event.type === "result");
    assert.deepEqual(results.map((result) => [result.user_message_uuid, result.result]), [[turnId, "ANSWER OF THE TURN"], [undefined, "ANSWER TO THE TASK NOTICE"]], name);
    assert.deepEqual(results.map((result) => exactClaudeStreamTerminal(result, turnId, sessionId)),
      [{ turnId, outcome: "reply", text: "ANSWER OF THE TURN", evidence: "stream" }, null], name);

    assert.deepEqual(recoverExactClaudeTurnFromSession(session, turnId, sessionId), replyFromSession("ANSWER OF THE TURN"), name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer!, notice!], turnId, sessionId), replyFromSession("ANSWER OF THE TURN"), name);
    // The notice ends the turn's rows whatever the turn left: no ending at all, or the provider's error.
    assert.equal(recoverExactClaudeTurnFromSession([request!, notice!, noticeAnswer!], turnId, sessionId), null, name);
    const [, apiError] = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.http_529_overloaded!, sessionId, turnId).session as ClaudeEvidenceRecord[];
    assert.equal(recoverExactClaudeTurnFromSession([request!, apiError!, notice!, noticeAnswer!], turnId, sessionId), null, name);
    assert.match(recoverExactClaudeTurnFailureFromSession([request!, apiError!, notice!, noticeAnswer!], turnId, sessionId)?.error ?? "", /529 Overloaded/, name);
    // And the error the CLI ended the notice's turn with is not the failure of the turn before it.
    assert.equal(recoverExactClaudeTurnFailureFromSession([request!, notice!, apiError!], turnId, sessionId), null, name);
  }
});

test("a row of another session between a Claude turn's rows is not the turn's", () => {
  const request: ClaudeEvidenceRecord = { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "request" }] } };
  const foreign = { ...endedWith("message-foreign", "ANSWER OF ANOTHER SESSION"), sessionId: "another-session" };
  const own = endedWith("message-own", "THE ANSWER");
  assert.equal(recoverExactClaudeTurnFromSession([request, foreign], turnId, sessionId), null);
  assert.deepEqual(recoverExactClaudeTurnFromSession([request, own, foreign], turnId, sessionId), replyFromSession("THE ANSWER"));
  assert.deepEqual(recoverExactClaudeTurnFromSession([request, foreign, own], turnId, sessionId), replyFromSession("THE ANSWER"));
  // Another session's request with the same id is not this turn's request, and another session's error is not its failure.
  assert.equal(recoverExactClaudeTurnFromSession([{ ...request, sessionId: "another-session" }, own], turnId, sessionId), null);
  const [, apiError] = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.http_529_overloaded!, "another-session", turnId).session as ClaudeEvidenceRecord[];
  assert.equal(recoverExactClaudeTurnFailureFromSession([request, apiError!], turnId, sessionId), null);
});

test("Claude session recovery requires the exact user UUID and a terminal assistant boundary", () => {
  const rows: ClaudeEvidenceRecord[] = [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "bounded" }] } },
    { type: "assistant", uuid: "thinking", parentUuid: turnId, sessionId, message: { id: "message-1", role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "private" }] } },
    { type: "assistant", uuid: "answer", parentUuid: "thinking", sessionId, message: { id: "message-1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "recovered reply" }] } },
    { type: "user", uuid: "later-turn", sessionId, message: { role: "user", content: [{ type: "text", text: "later" }] } },
    { type: "assistant", uuid: "later-answer", parentUuid: "later-turn", sessionId, message: { id: "message-2", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "must not leak" }] } },
  ];
  assert.deepEqual(recoverExactClaudeTurnFromSession(rows, turnId, sessionId), {
    turnId,
    outcome: "reply",
    text: "recovered reply",
    evidence: "transcript",
  });
  assert.deepEqual(recoverExactClaudeTurnFromSession(rows.slice(0, 2), turnId, sessionId), {
    turnId,
    outcome: "unreadable",
    text: null,
    evidence: "none",
  });
  assert.equal(recoverExactClaudeTurnFromSession([
    rows[0],
    { ...rows[1], message: { id: "message-1", role: "assistant", stop_reason: null, content: [{ type: "thinking", thinking: "private" }] } },
  ], turnId, sessionId), null);
  assert.equal(recoverExactClaudeTurnFromSession(rows, "missing-turn", sessionId), null);
});

test("Claude session recovery keeps tool-result rows inside the turn and returns only final text", () => {
  const rows: ClaudeEvidenceRecord[] = [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "inspect the room" }] } },
    {
      type: "assistant",
      uuid: "tool-call",
      parentUuid: turnId,
      sessionId,
      message: {
        id: "message-tool",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tool-1", name: "read_messages", input: {} },
        ],
      },
    },
    {
      type: "user",
      uuid: "tool-result",
      parentUuid: "tool-call",
      sessionId,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "room result" }],
      },
    },
    {
      type: "assistant",
      uuid: "final-answer",
      parentUuid: "tool-result",
      sessionId,
      message: {
        id: "message-final",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Final room answer." }],
      },
    },
    { type: "user", uuid: "later-turn", sessionId, message: { role: "user", content: [{ type: "text", text: "later" }] } },
  ];

  assert.deepEqual(recoverExactClaudeTurnFromSession(rows, turnId, sessionId), {
    turnId,
    outcome: "reply",
    text: "Final room answer.",
    evidence: "transcript",
  });
  assert.equal(recoverExactClaudeTurnFromSession(rows.slice(0, 3), turnId, sessionId), null);
});

test("Claude recovery treats only the exact no-reply sentinel as no reply", () => {
  const rows = (text: string): ClaudeEvidenceRecord[] => [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "bounded" }] } },
    { type: "assistant", uuid: "answer", parentUuid: turnId, sessionId, message: { id: "message-1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } },
  ];
  assert.deepEqual(recoverExactClaudeTurnFromSession(
    rows("LETAGENTS_NO_ROOM_REPLY"),
    turnId,
    sessionId,
  ), {
    turnId,
    outcome: "no_reply",
    text: null,
    evidence: "transcript",
  });
  assert.deepEqual(recoverExactClaudeTurnFromSession(
    rows("LETAGENTS_NO_ROOM_REPLY\nextra"),
    turnId,
    sessionId,
  ), {
    turnId,
    outcome: "reply",
    text: "LETAGENTS_NO_ROOM_REPLY\nextra",
    evidence: "transcript",
  });
});
