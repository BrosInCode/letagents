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
  CLAUDE_API_ERROR_CAPTURES, CLAUDE_API_FAILURE_POLICY, CLAUDE_INVALID_REQUESTS, CLAUDE_REAL_CAPTURES, CLAUDE_RESULT_CELLS, CLAUDE_RESULT_TEXT, claudeCapturedTask,
  claudeInvalidRequestRows, claudeParentChain, claudeResultEvent, realClaudeCapture, realClaudeResult,
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
  // The later command's row is the real row of a second prompt: the CLI marks a prompt with where it came from.
  const later = realClaudeCapture(CLAUDE_REAL_CAPTURES.task_ends_during_next_turn!, sessionId, turnId).session.find((row) => row.uuid === "SECOND_TURN_ID") as ClaudeEvidenceRecord;
  assert.deepEqual([later.type, later.promptSource, later.isMeta], ["user", "sdk", undefined]);
  later.uuid = "later-turn";
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

/** The real rows of one capture, for this session and this turn: its messages, and every row of its session file that has an id. */
const realRows = (name: string) => {
  const capture = realClaudeCapture(CLAUDE_REAL_CAPTURES[name]!, sessionId, turnId);
  return { stream: capture.stream, session: capture.session as ClaudeEvidenceRecord[], file: capture.session_file as ClaudeEvidenceRecord[],
    subagent: (capture.subagent_session ?? []) as ClaudeEvidenceRecord[] };
};
const isMessage = (row: ClaudeEvidenceRecord) => row.type === "user" || row.type === "assistant";
const replyFromSession = (text: string) => ({ turnId, outcome: "reply", text, evidence: "transcript" });
const endedWith = (id: string, text: string): ClaudeEvidenceRecord =>
  ({ type: "assistant", sessionId, message: { id, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
/** What the cuts of the property test come to, over all captures. */
const [PROPERTY_CUTS, PROPERTY_REPLIES, PROPERTY_MARKED] = [870, 153, 94];
/** The texts no reading of the turn may ever hold: another room turn's answer, a sub-agent's report. */
const NOT_THE_TURNS = ["ANSWER OF THE SECOND TURN", "SUBAGENT REPORT", "SECOND SUBAGENT REPORT", "SUMMARY OF THE CONVERSATION"];

const A = "ANSWER OF THE TURN";
const N = "ANSWER TO THE TASK NOTICE";
const N1 = "ANSWER TO THE FIRST TASK NOTICE";
const N2 = "ANSWER TO THE SECOND TASK NOTICE";
/**
 * What is read: no proven answer, a reply that the session proves complete, or a reply with what it lacks.
 * `no_report`: the session holds no notice of some of the background work that the turn started.
 * `ended_unreported`: it holds the notice of all of that work, and not an answer to each.
 */
type Read = null | string | [text: string, lacks: "no_report" | "ended_unreported"];
const noReport = (...texts: string[]): Read => [texts.join("\n\n"), "no_report"];
const unreported = (...texts: string[]): Read => [texts.join("\n\n"), "ended_unreported"];
const whole = (...texts: string[]): Read => texts.join("\n\n");
const asRead = (read: Read) => read === null ? null : typeof read === "string" ? replyFromSession(read) : { ...replyFromSession(read[0]), backgroundWork: read[1] };
/** A turn with one tool call that started background work: the request, the call, its result, the turn's answer. */
const HELD = [null, null, null, noReport(A)];
/** The same with two calls. */
const HELD_FOR_TWO = [null, null, null, null, null, noReport(A)];

/**
 * What the real session file of each capture proves, whenever the process ended: after each of its messages,
 * what is read for the turn. The rows after the turn are part of the file. The answer to the notice of the
 * turn's own background work is part of the turn's reply, as it is for a turn that the adapter holds open; the
 * answer of another room turn never is, and a sub-agent's report never is.
 */
const REAL_SESSION_READS: Record<string, Read[]> = {
  completed_answer: [null, "PROBE_OK"],
  // The request, and the CLI's request for visible output.
  completed_without_answer: [null, null],
  // The request, four replies that stopped on the output limit with the CLI's request to go on between them, and the CLI's error.
  stop_reason_max_tokens: [null, null, null, null, null, null, null, null, null],
  // The request, an answer, the Stop hook's refusal of it, the answer after that.
  stop_hook_refuses_end_once: [null, "ANSWER BEFORE THE HOOK", null, "ANSWER AFTER THE HOOK"],
  // The request, a tool call, its result, the turn's answer; then the task's notice, and the CLI's answer to it.
  background_command: [...HELD, unreported(A), whole(A, N)],
  subagent_in_background: [...HELD, unreported(A), whole(A, N)],
  subagent_api_error: [...HELD, unreported(A), whole(A, N)],
  background_command_fails: [...HELD, unreported(A), whole(A, N)],
  background_command_running_at_interrupt: [...HELD, unreported(A), whole(A, N)],
  subagent_stopped_by_request: [...HELD, unreported(A), whole(A, N)],
  // The request, the Task call, its result with the sub-agent's report, the turn's answer. Nothing ran in the background.
  subagent_in_foreground: [null, null, null, A],
  // The request, the Skill call, its result, the skill's text, the turn's answer.
  skill_call: [null, null, null, null, A],
  // The request, two tool calls, their results, the turn's answer; then, for each task, its notice and the answer to it.
  two_background_commands: [...HELD_FOR_TWO, noReport(A), noReport(A, N1), unreported(A, N1), whole(A, N1, N2)],
  two_subagents_in_background: [...HELD_FOR_TWO, noReport(A), noReport(A, N1), unreported(A, N1), whole(A, N1, N2)],
  subagent_and_background_command: [...HELD_FOR_TWO, noReport(A), noReport(A, N1), unreported(A, N1), whole(A, N1, N2)],
  // The same turn; then both notices, which went to the model with one request, and the one answer to them.
  two_background_commands_end_together: [...HELD_FOR_TWO, noReport(A), unreported(A), whole(A, N1)],
  // The turn; then the task's notice, and what the CLI wrote for it in place of an answer: its request for
  // visible output, the provider's error, or the mark of an interrupt.
  background_command_notice_answer_empty: [...HELD, unreported(A), unreported(A)],
  background_command_notice_api_error: [...HELD, unreported(A), unreported(A)],
  interrupt_during_task_notice_answer: [...HELD, unreported(A), unreported(A)],
  // A command that was stopped, and one that still ran when the CLI ended, have no notice: the session ends with the turn.
  background_command_stopped_by_request: HELD,
  background_command_running_at_input_close: HELD,
  // A sub-agent that an interrupt stopped has no notice either.
  subagent_running_at_interrupt: HELD,
  // The task ended while the turn still ran. Its notice went to the model with the turn's last request: the
  // file holds that as an attachment, and the turn's answer is the answer to it.
  task_ends_while_turn_goes_on: [null, null, null, null, null, "ANSWER OF THE TURN, TO A REQUEST THAT HOLDS THE TASK NOTICE"],
  // The turn; then the first notice, a tool call and its result, and the answer, whose request took the second notice.
  task_ends_while_notice_is_answered: [...HELD_FOR_TWO, noReport(A), noReport(A), noReport(A),
    whole(A, "ANSWER NUMBER 1 AFTER THE TURN, TO A REQUEST THAT HOLDS 2 TASK NOTICES")],
  // The turn; then a second prompt and its answer; then the task's notice and the answer to it. The adapter
  // sends no prompt while it holds a turn open, so what follows a prompt is not read for the turn.
  task_ends_during_next_turn: [...HELD, noReport(A), noReport(A), noReport(A), noReport(A)],
  // The turn; then the task's notice, the mark of the interrupt that ended its answer, and a second prompt with its answer.
  interrupt_during_task_notice_answer_then_prompt: [...HELD, unreported(A), unreported(A), unreported(A), unreported(A)],
  // The same, with the command that the answer to the notice called and the refusal of it before the interrupt's mark.
  approval_in_task_notice_answer_interrupted: [...HELD, ...Array<Read>(6).fill(unreported(A))],
  approval_in_task_notice_answer_denied_and_interrupted: [...HELD, ...Array<Read>(6).fill(unreported(A))],
  // The turn; then the task's notice and its answer; then a second prompt, which the CLI kept until that answer had ended.
  prompt_during_task_notice_answer: [...HELD, unreported(A), whole(A, N), whole(A, N), whole(A, N)],
  // The request and its answer; then the rows of the CLI's own command /compact, and a second prompt with its answer.
  compaction_by_command: [null, A, A, A, A, A, A, A],
  // A hook of another kind than Stop writes no message of its own: its words are an attachment, or the result of the call that it denied.
  hook_adds_context_to_prompt: [null, A],
  hook_denies_tool_call: [null, null, null, A],
  hook_feedback_after_tool_call: [null, null, null, A],
  write_outside_run_folder_denied: [null, null, null, A],
  // Two commands of one message whose notices come in the other order than the tasks started.
  two_background_commands_end_in_the_other_order: [...HELD_FOR_TWO, noReport(A), noReport(A, N1), unreported(A, N1), whole(A, N1, N2)],
  // The request, a call that starts a command in the background, its result, the call that stops that command, its
  // result, the turn's answer. No report is due on a command that the turn itself stopped: nothing is missing.
  background_command_stopped_by_the_turn: [null, null, null, null, null, A],
  // The request and its answer; then, written by the process that was started again for the session, a second prompt and its answer.
  resumed_session: [null, A, A, A],
};

test("real Claude Code sessions: wherever the process ended, what is read is the turn's own reply, and says what the session does not prove", () => {
  for (const [name, reads] of Object.entries(REAL_SESSION_READS)) {
    const { file, subagent } = realRows(name);
    const messages = file.filter(isMessage);
    assert.equal(messages.length, reads.length, name);
    assert.equal(file[0]!.uuid, turnId, name);
    type Reading = ReturnType<typeof recoverExactClaudeTurnFromSession>;
    let read: Reading = null;
    for (let length = 1; length <= file.length; length += 1) {
      const row = file[length - 1]!;
      const before: Reading = read;
      read = recoverExactClaudeTurnFromSession(file.slice(0, length), turnId, sessionId);
      if (isMessage(row)) {
        const message = messages.indexOf(row);
        assert.deepEqual(read, asRead(reads[message]!), `${name}, cut after message ${message + 1}`);
      } else if ((row.attachment as { type?: string } | undefined)?.type !== "queued_command") {
        // A row that is no message, and no notice that a request took, changes nothing.
        assert.deepEqual(read, before, `${name}, cut after row ${length} (${row.type})`);
      }
      if (read?.outcome === "reply") assert.ok(NOT_THE_TURNS.every((text) => !read!.text!.includes(text)), `${name}, cut after row ${length}`);
    }
    // Claude Code 2.1.278 keeps a sub-agent's rows in a file of their own. A CLI that wrote them into the session
    // file would write them after the call that started the sub-agent. They change no reading of that file.
    if (!subagent.length) continue;
    assert.ok(subagent.every((row) => row.isSidechain === true && row.sessionId === sessionId), name);
    assert.ok(file.every((row) => row.isSidechain === false), name);
    const call = file.findIndex((row) => row.type === "assistant");
    const withSubagentRows = [...file.slice(0, call + 1), ...subagent, ...file.slice(call + 1)];
    for (let length = 1; length <= withSubagentRows.length; length += 1) {
      const cut = withSubagentRows.slice(0, length);
      assert.deepEqual(recoverExactClaudeTurnFromSession(cut, turnId, sessionId), recoverExactClaudeTurnFromSession(cut.filter((row) => row.isSidechain !== true), turnId, sessionId),
        `${name} with the sub-agent's rows in the session file, cut after row ${length}`);
    }
  }
  // The table names every capture whose session holds more than a request and an answer.
  for (const [name, capture] of Object.entries(CLAUDE_REAL_CAPTURES)) {
    if (capture.session.some((row) => row.type === "user" && row.uuid !== "TURN_ID")) assert.ok(REAL_SESSION_READS[name], `${name} is in the table`);
  }
  // A prompt that a hook blocked is no row of the session: nothing is read for it.
  const { file: blocked } = realRows("hook_blocks_prompt");
  assert.deepEqual(blocked.map((row) => [row.type, row.subtype]), [["system", "informational"]]);
  assert.equal(recoverExactClaudeTurnFromSession(blocked, turnId, sessionId), null);
  assert.equal(recoverExactClaudeTurnFailureFromSession(blocked, turnId, sessionId), null);
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

test("a user row is inside a Claude turn only when the CLI goes on with the turn", () => {
  const [request, beforeHook, hookFeedback, afterHook] = realRows("stop_hook_refuses_end_once").session;
  const [, , toolResult] = realRows("hook_feedback_after_tool_call").session;
  const [, , deniedByHook] = realRows("hook_denies_tool_call").session;
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
  assert.deepEqual((toolResult!.message as { content: Array<{ type: string }> }).content.map((part) => part.type), ["tool_result"]);
  // A hook that denies a tool call writes its words as the result of that call: a tool's result like any other.
  assert.deepEqual((deniedByHook!.message as { content: Array<{ type: string; content: string }> }).content.map((part) => [part.type, part.content.split(":")[0]]), [["tool_result", "PreToolUse"]]);
  for (const row of [hookFeedback!, askForOutput!, skillText!, toolResult!, deniedByHook!]) assert.deepEqual([row.promptSource, row.origin], [undefined, undefined]);

  // After a message that ended, each of them says that the turn went on: the answer is the message after it,
  // and a turn cut off before that message has no ending. The message before it is not the answer.
  const goingOn: Array<[string, ClaudeEvidenceRecord]> = [["a Stop hook's refusal", hookFeedback!], ["the CLI's request for visible output", askForOutput!],
    ["a tool's result", toolResult!], ["a hook's denial of a tool call", deniedByHook!], ["a skill's text", skillText!]];
  for (const [name, row] of goingOn) {
    assert.equal(recoverExactClaudeTurnFromSession([request!, answer, row], turnId, sessionId), null, `${name}: the turn went on, and has no ending`);
    assert.equal(recoverExactClaudeTurnFailureFromSession([request!, answer, row], turnId, sessionId), null, name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, row, later], turnId, sessionId), replyFromSession("A LATER MESSAGE"), name);
  }
  assert.equal(recoverExactClaudeTurnFromSession([request!, beforeHook!, hookFeedback!], turnId, sessionId), null, "the message the hook refused is not posted");
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, beforeHook!, hookFeedback!, afterHook!], turnId, sessionId), replyFromSession("ANSWER AFTER THE HOOK"));
  // The skill's text is a row of text parts with an id of its own, as a prompt is. It is not the next command.
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, skillCall!, skillResult!, skillText!, skillAnswer!], turnId, sessionId), replyFromSession("ANSWER OF THE TURN"));
  assert.equal(recoverExactClaudeTurnFromSession([request!, skillCall!, skillResult!, skillText!], turnId, sessionId), null);
  // The request's own row, written a second time, is the same command and not another one.
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, request!, answer], turnId, sessionId), replyFromSession("THE ANSWER"));
});

test("a Claude turn is over where another command starts: a prompt, the notice of a task, a compaction that a command made", () => {
  const [request] = realRows("completed_answer").session;
  const answer = endedWith("message-answer", "THE ANSWER");
  const later = endedWith("message-later", "A LATER MESSAGE");
  // Real rows. Each starts a command of its own, and carries the mark that says so.
  const prompt = realRows("prompt_during_task_notice_answer").session.find((row) => row.uuid === "SECOND_TURN_ID")!;
  const notice = realRows("background_command").session.find((row) => row.origin !== undefined)!;
  const compaction = realRows("compaction_by_command").file;
  const boundary = compaction.find((row) => row.type === "system")!;
  const afterBoundary = compaction.slice(compaction.indexOf(boundary) + 1).filter(isMessage);
  assert.deepEqual([prompt.promptSource, prompt.origin], ["sdk", undefined]);
  assert.deepEqual([notice.promptSource, notice.origin], ["system", { kind: "task-notification" }]);
  assert.deepEqual([boundary.subtype, boundary.compactMetadata, boundary.parentUuid], ["compact_boundary", { trigger: "manual" }, null]);
  // What the CLI wrote for its own command /compact: the summary, a caveat, the command, and what it printed. None is a prompt.
  assert.deepEqual(afterBoundary.slice(0, 4).map((row) => [row.type, row.promptSource, row.isCompactSummary ?? row.isMeta ?? null, String((row.message as { content: unknown }).content).slice(0, 22)]), [
    ["user", undefined, true, "This session is being "], ["user", undefined, true, "<local-command-caveat>"],
    ["user", undefined, null, "<command-name>/compact"], ["user", undefined, null, "<local-command-stdout>"]]);

  for (const [name, starts] of [["a prompt", [prompt]], ["the notice of a task", [notice]], ["the compaction of the CLI's own command", [boundary, ...afterBoundary.slice(0, 4)]]] as const) {
    // The answer that the turn gave before it is the turn's, and proven: the turn is over.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, ...starts], turnId, sessionId), replyFromSession("THE ANSWER"), name);
    // A message that ended after it is the other command's, and is never read as this turn's.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, ...starts, later], turnId, sessionId), replyFromSession("THE ANSWER"), name);
    assert.equal(recoverExactClaudeTurnFromSession([request!, ...starts, later], turnId, sessionId), null, `${name}: the turn has no answer`);
    // Nor is an error after it this turn's failure.
    const [, apiError] = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.http_529_overloaded!, sessionId, turnId).session as ClaudeEvidenceRecord[];
    assert.equal(recoverExactClaudeTurnFailureFromSession([request!, ...starts, apiError!], turnId, sessionId), null, name);
    assert.match(recoverExactClaudeTurnFailureFromSession([request!, apiError!, ...starts, later], turnId, sessionId)?.error ?? "", /529 Overloaded/, name);
  }
  // A prompt is known by its mark, whatever the CLI names as its source, and not by its form.
  for (const promptSource of ["sdk", "system", "typed", "queued", "suggestion_accepted"]) {
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, { ...prompt, promptSource }, later], turnId, sessionId), replyFromSession("THE ANSWER"), promptSource);
  }
  // A summary with no boundary before it is a row that is not known.
  const summary = afterBoundary[0]!;
  assert.equal(recoverExactClaudeTurnFromSession([request!, answer, summary], turnId, sessionId), null);
  assert.equal(recoverExactClaudeTurnFromSession([request!, answer, summary, later], turnId, sessionId), null);
});

test("a user row that is not known proves nothing: a message that ended before it is not read as the answer, and neither is one after it", () => {
  const [request, beforeHook, hookFeedback, afterHook] = realRows("stop_hook_refuses_end_once").session;
  const [, skillCall, skillResult] = realRows("skill_call").session;
  const [, askForOutput] = realRows("completed_without_answer").session;
  const [, , toolResult] = realRows("hook_feedback_after_tool_call").session;
  const prompt = realRows("prompt_during_task_notice_answer").session.find((row) => row.uuid === "SECOND_TURN_ID")!;
  const answer = endedWith("message-answer", "THE ANSWER");
  const later = endedWith("message-later", "A LATER MESSAGE");
  const note = (over: Record<string, unknown>): ClaudeEvidenceRecord =>
    ({ type: "user", uuid: "another-row", sessionId, message: { role: "user", content: "A note the CLI wrote." }, ...over });
  // The mark of an interrupt is a real row of this kind: it follows what was interrupted, and says nothing of what comes next.
  const interrupted = realRows("interrupt_during_task_notice_answer").session.at(-1)!;
  assert.deepEqual([interrupted.type, interrupted.promptSource, interrupted.origin, interrupted.isMeta, (interrupted.message as { content: unknown }).content],
    ["user", undefined, undefined, undefined, [{ type: "text", text: "[Request interrupted by user]" }]]);
  const [, apiError] = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.http_529_overloaded!, sessionId, turnId).session as ClaudeEvidenceRecord[];
  const others: Array<[string, ClaudeEvidenceRecord]> = [
    ["the mark of an interrupt", interrupted],
    ["a meta row with other words", note({ isMeta: true })],
    ["a row that is not marked at all", note({})],
    ["the request for visible output without its meta mark", { ...askForOutput!, isMeta: false }],
    ["the request for visible output without its companion mark", { ...askForOutput!, turnCompanion: false }],
    ["a companion mark on a row that is not meta", note({ turnCompanion: true })],
    ["the hook's words on a row that is not meta", { ...hookFeedback!, isMeta: false }],
    ["the hook's words not at the start", note({ isMeta: true, message: { role: "user", content: "Note: Stop hook feedback: none." } })],
    ["the hook's words in a row of parts", note({ isMeta: true, message: { role: "user", content: [{ type: "text", text: "Stop hook feedback: go on" }] } })],
    ["a meta row of parts that holds no tool result", note({ isMeta: true, message: { role: "user", content: [{ type: "image", source: {} }] } })],
    ["a row of text parts with no mark of a prompt", note({ message: { role: "user", content: [{ type: "text", text: "another request" }] } })],
    ["a row with no parts", note({ message: { role: "user", content: [] } })],
    // A row with the marks of both kinds is of neither.
    ["a tool's result with the mark of a prompt", { ...toolResult!, promptSource: "sdk" }],
    ["the hook's words with the mark of a task's notice", { ...hookFeedback!, origin: { kind: "task-notification" } }],
  ];
  for (const [name, other] of others) {
    // The row can be the turn going on. Then the message that ended before it is an interim one: it is not read as the answer.
    assert.equal(recoverExactClaudeTurnFromSession([request!, answer, other], turnId, sessionId), null, `${name}: no answer is proven`);
    // The row can be another command. Then a message that ended after it is that command's: it is not read either.
    assert.equal(recoverExactClaudeTurnFromSession([request!, answer, other, later], turnId, sessionId), null, name);
    assert.equal(recoverExactClaudeTurnFromSession([request!, other, later], turnId, sessionId), null, name);
    assert.equal(recoverExactClaudeTurnFromSession([request!, skillCall!, skillResult!, other, later], turnId, sessionId), null, name);
    // A known end of the turn after it does not make the row known.
    assert.equal(recoverExactClaudeTurnFromSession([request!, answer, other, prompt, later], turnId, sessionId), null, name);
    // Nor is an error after it this turn's failure. An error before it is: that the turn failed needs no proof from later rows.
    assert.equal(recoverExactClaudeTurnFailureFromSession([request!, other, apiError!], turnId, sessionId), null, name);
    assert.match(recoverExactClaudeTurnFailureFromSession([request!, apiError!, other], turnId, sessionId)?.error ?? "", /529 Overloaded/, name);
    // A turn that has an answer did not fail, whether or not the answer is proven complete.
    assert.equal(recoverExactClaudeTurnFailureFromSession([request!, apiError!, askForOutput!, answer, other], turnId, sessionId), null, name);
  }
  // The rows that go on with the turn are read through. After the turn's answer a row that is not known still proves nothing.
  assert.equal(recoverExactClaudeTurnFromSession([request!, beforeHook!, hookFeedback!, afterHook!, others[1]![1], later], turnId, sessionId), null);
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, beforeHook!, hookFeedback!, afterHook!, prompt, others[1]![1], later], turnId, sessionId),
    replyFromSession("ANSWER AFTER THE HOOK"), "a row after the turn's end is not the turn's");
});

test("a row that holds a tool's result beside another part is not a tool's result: a prompt with one does not keep the turn before it open", () => {
  const [request] = realRows("completed_answer").session;
  const [, , toolResult] = realRows("hook_feedback_after_tool_call").session;
  const answer = endedWith("message-answer", "THE ANSWER");
  const laterAnswer = endedWith("message-later", "THE ANSWER OF THE NEXT TURN");
  const [resultPart] = (toolResult!.message as { content: Array<Record<string, unknown>> }).content;
  // The real row of a second prompt, with a tool's result among its parts.
  const prompt = realRows("prompt_during_task_notice_answer").session.find((row) => row.uuid === "SECOND_TURN_ID")!;
  const [promptPart] = (prompt.message as { content: Array<Record<string, unknown>> }).content;
  for (const parts of [[promptPart, resultPart], [resultPart, promptPart]]) {
    const mixedPrompt = { ...prompt, message: { role: "user", content: parts } };
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, mixedPrompt, laterAnswer], turnId, sessionId), replyFromSession("THE ANSWER"),
      "the prompt ends the turn: the next turn's answer is not read");
    assert.equal(recoverExactClaudeTurnFromSession([request!, mixedPrompt, laterAnswer], turnId, sessionId), null);
    // The same parts on a row with no mark of a prompt: a row that is not known.
    const unmarked = { ...toolResult!, message: { role: "user", content: parts } };
    assert.equal(recoverExactClaudeTurnFromSession([request!, answer, unmarked, laterAnswer], turnId, sessionId), null);
    assert.equal(recoverExactClaudeTurnFromSession([request!, unmarked, laterAnswer], turnId, sessionId), null);
  }
  // A row of several results, and nothing else, is the turn going on.
  const twoResults = { ...toolResult!, message: { role: "user", content: [resultPart, { ...resultPart, tool_use_id: "toolu_other" }] } };
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, twoResults, laterAnswer], turnId, sessionId), replyFromSession("THE ANSWER OF THE NEXT TURN"));
});

test("the reply of a turn that started background work is its answer and the answers to the notices of that work, as the adapter posts it", () => {
  for (const name of ["background_command", "subagent_in_background", "subagent_api_error"]) {
    // Real rows. The task ended after the turn, and the CLI answered its notice in the same session.
    const { session, stream } = realRows(name);
    const [request, call, started, answer, notice, noticeAnswer] = session;
    assert.deepEqual(notice!.origin, { kind: "task-notification" }, name);
    assert.match(String((notice!.message as { content: unknown }).content), /^<task-notification>\n<task-id>/, name);
    assert.equal(notice!.isMeta, undefined, name);
    assert.deepEqual((noticeAnswer!.message as { content: unknown }).content, [{ type: "text", text: N }], name);
    // The tool's result names the task that it started, in the fields that the CLI keeps beside it; the notice names the same task.
    const task = claudeCapturedTask(name);
    const result = started!.toolUseResult as { backgroundTaskId?: string; isAsync?: boolean; agentId?: string };
    assert.equal(result.backgroundTaskId ?? (result.isAsync === true ? result.agentId : undefined), task, name);
    assert.ok(String((notice!.message as { content: unknown }).content).includes(`<task-id>${task}</task-id>`), name);
    // In the stream, the result of the notice's command names no room command: the adapter adds its text to the open turn.
    const results = stream.filter((event) => event.type === "result");
    assert.deepEqual(results.map((result) => [result.user_message_uuid, result.result]), [[turnId, A], [undefined, N]], name);
    assert.deepEqual(results.map((result) => exactClaudeStreamTerminal(result, turnId, sessionId)),
      [{ turnId, outcome: "reply", text: A, evidence: "stream" }, null], name);

    assert.deepEqual(recoverExactClaudeTurnFromSession(session, turnId, sessionId), replyFromSession(`${A}\n\n${N}`), name);
    // The interim answer alone is never read as the whole reply: the reading says what the session does not prove.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, call!, started!, answer!], turnId, sessionId), asRead(noReport(A)), name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, call!, started!, answer!, notice!], turnId, sessionId), asRead(unreported(A)), name);
    // A turn that started nothing in the background has its answer, and nothing is added to it.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer!, notice!, noticeAnswer!], turnId, sessionId), replyFromSession(A), name);
    // The notice ends the turn's rows whatever the turn left: no ending at all, or the provider's error.
    assert.equal(recoverExactClaudeTurnFromSession([request!, call!, started!, notice!, noticeAnswer!], turnId, sessionId), null, name);
    const [, apiError] = realClaudeCapture(CLAUDE_API_ERROR_CAPTURES.http_529_overloaded!, sessionId, turnId).session as ClaudeEvidenceRecord[];
    assert.equal(recoverExactClaudeTurnFromSession([request!, call!, started!, apiError!, notice!, noticeAnswer!], turnId, sessionId), null, name);
    assert.match(recoverExactClaudeTurnFailureFromSession([request!, call!, started!, apiError!, notice!, noticeAnswer!], turnId, sessionId)?.error ?? "", /529 Overloaded/, name);
    // And the error the CLI ended the notice's command with is not the failure of the turn before it.
    assert.equal(recoverExactClaudeTurnFailureFromSession([request!, call!, started!, notice!, apiError!], turnId, sessionId), null, name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, call!, started!, answer!, notice!, apiError!], turnId, sessionId), asRead(unreported(A)), name);
  }

  const [request, call, started, answer, notice, noticeAnswer] = realRows("background_command").session;
  const task = claudeCapturedTask("background_command");
  const read = (...after: ClaudeEvidenceRecord[]) => recoverExactClaudeTurnFromSession([request!, call!, started!, answer!, ...after], turnId, sessionId);
  const says = (row: ClaudeEvidenceRecord, text: string): ClaudeEvidenceRecord => JSON.parse(JSON.stringify(row).replaceAll(JSON.stringify(N), JSON.stringify(text)).replaceAll(JSON.stringify(A), JSON.stringify(text)));
  const about = (row: ClaudeEvidenceRecord, other: string): ClaudeEvidenceRecord => JSON.parse(JSON.stringify(row).replaceAll(task!, other));
  // A text that repeats the text before it is left out, as the adapter leaves it out. Any other text stays.
  assert.deepEqual(read(notice!, says(noticeAnswer!, A)), replyFromSession(A));
  // The model's word that it has nothing for the room is no text of the reply.
  assert.deepEqual(read(notice!, says(noticeAnswer!, "LETAGENTS_NO_ROOM_REPLY")), replyFromSession(A));
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, call!, started!, says(answer!, "LETAGENTS_NO_ROOM_REPLY"), notice!, noticeAnswer!], turnId, sessionId), replyFromSession(N));
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, call!, started!, says(answer!, "LETAGENTS_NO_ROOM_REPLY"), notice!, says(noticeAnswer!, "LETAGENTS_NO_ROOM_REPLY")], turnId, sessionId),
    { turnId, outcome: "no_reply", text: null, evidence: "transcript" }, "a turn in which the model wrote nothing for the room posts nothing");
  assert.deepEqual(recoverExactClaudeTurnFromSession([request!, call!, started!, says(answer!, "LETAGENTS_NO_ROOM_REPLY")], turnId, sessionId),
    { turnId, outcome: "no_reply", text: null, evidence: "transcript" }, "with or without a line about what it lacks");
  // The answer to the notice of other work is not this turn's: it is not in the reply, and the turn's own work is still not reported.
  assert.deepEqual(read(about(notice!, "bother000"), says(noticeAnswer!, "ANSWER ABOUT OTHER WORK")), asRead(noReport(A)));
  assert.deepEqual(read(about(notice!, "bother000"), says(noticeAnswer!, "ANSWER ABOUT OTHER WORK"), notice!, noticeAnswer!), replyFromSession(`${A}\n\n${N}`));
  // A notice that names no task is of no known work.
  const unnamed = { ...notice!, message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" } };
  assert.deepEqual(read(unnamed, noticeAnswer!), asRead(noReport(A)));
  // An answer that started more work in the background: that work is the turn's too, and the reply is not complete without its report.
  const moreWork = [about(call!, "bmore0000"), about(started!, "bmore0000")].map((row, index) => ({ ...row, uuid: `more-${index}` }));
  assert.deepEqual(read(notice!, ...moreWork, noticeAnswer!), asRead(noReport(A, N)));
  assert.deepEqual(read(notice!, ...moreWork, noticeAnswer!, about(notice!, "bmore0000"), says(noticeAnswer!, "ANSWER ABOUT THE LATER WORK")),
    replyFromSession(`${A}\n\n${N}\n\nANSWER ABOUT THE LATER WORK`));
  // The answer to a notice went on after a message that ended, or a row that is not known follows it: it is not proven.
  const [, askForOutput] = realRows("completed_without_answer").session;
  assert.deepEqual(read(notice!, noticeAnswer!, askForOutput!), asRead(unreported(A)));
  assert.deepEqual(read(notice!, noticeAnswer!, { type: "user", uuid: "another-row", sessionId, message: { role: "user", content: "A note the CLI wrote." } }), asRead(unreported(A)));
  // A notice that a running request took is an attachment in the file, and needs no answer of its own (real rows of both).
  for (const [name, text] of [["task_ends_while_turn_goes_on", "ANSWER OF THE TURN, TO A REQUEST THAT HOLDS THE TASK NOTICE"],
    ["task_ends_while_notice_is_answered", `${A}\n\nANSWER NUMBER 1 AFTER THE TURN, TO A REQUEST THAT HOLDS 2 TASK NOTICES`]] as const) {
    const { file } = realRows(name);
    const taken = file.filter((row) => (row.attachment as { type?: string } | undefined)?.type === "queued_command");
    assert.deepEqual(taken.map((row) => (row.attachment as { commandMode: string; prompt: string }).commandMode), ["task-notification"], name);
    assert.ok((taken[0]!.attachment as { prompt: string }).prompt.includes(`<task-id>${claudeCapturedTask(name, name === "task_ends_while_turn_goes_on" ? "toolu_probe" : "toolu_probe_2")}</task-id>`), name);
    assert.deepEqual(recoverExactClaudeTurnFromSession(file, turnId, sessionId), replyFromSession(text), name);
    // Without that row the session does not show that the model was told of the task.
    assert.deepEqual(recoverExactClaudeTurnFromSession(file.filter((row) => !taken.includes(row)), turnId, sessionId), asRead(noReport(text)), name);
    // A command of another kind that a request took is not the notice of a task.
    const otherMode = file.map((row) => taken.includes(row) ? { ...row, attachment: { ...(row.attachment as object), commandMode: "prompt" } } : row);
    assert.deepEqual(recoverExactClaudeTurnFromSession(otherMode, turnId, sessionId), asRead(noReport(text)), name);
  }
});

test("a compaction that no command made is read as before: the answer before its summary, and nothing after it", () => {
  // No capture holds a compaction that the CLI made by itself: it could not be made, and the adapter never sends
  // /compact, so in a room it is the only kind. The rows here are the real boundary and summary of the command's
  // compaction, with the boundary saying that no command asked for it. They are read by the rule that was there
  // before the marks were read: the first user row that is not the turn going on ends the turn's rows.
  const [request] = realRows("completed_answer").session;
  const compaction = realRows("compaction_by_command").file;
  const byCommand = compaction.find((row) => row.type === "system")!;
  const [summary, ...afterSummary] = compaction.slice(compaction.indexOf(byCommand) + 1).filter(isMessage);
  assert.deepEqual([summary!.type, summary!.isCompactSummary, summary!.promptSource, summary!.parentUuid], ["user", true, undefined, byCommand.uuid]);
  const answer = endedWith("message-answer", "THE ANSWER");
  const later = endedWith("message-later", "A LATER MESSAGE");
  for (const [name, boundary] of [["an automatic boundary", { ...byCommand, compactMetadata: { trigger: "auto" } }], ["a boundary that does not say what asked for it", { ...byCommand, compactMetadata: undefined }],
    ["a boundary with another word for it", { ...byCommand, compactMetadata: { trigger: "reactive" } }]] as const) {
    // After the turn's answer: the answer is read, as it was.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, boundary, summary!], turnId, sessionId), replyFromSession("THE ANSWER"), name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, boundary, summary!, ...afterSummary, later], turnId, sessionId), replyFromSession("THE ANSWER"), name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, boundary], turnId, sessionId), replyFromSession("THE ANSWER"), name);
    // Inside a turn: nothing after the summary is read as the turn's, as it was not before.
    assert.equal(recoverExactClaudeTurnFromSession([request!, boundary, summary!, later], turnId, sessionId), null, name);
    // The boundary alone ends nothing: only the summary's row does, as before.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, boundary, answer], turnId, sessionId), replyFromSession("THE ANSWER"), name);
    // A row that is not known after such a boundary ends the turn's rows too, with the answer before it, as before.
    assert.deepEqual(recoverExactClaudeTurnFromSession([request!, answer, boundary, { type: "user", uuid: "another-row", sessionId, message: { role: "user", content: "A note the CLI wrote." } }], turnId, sessionId),
      replyFromSession("THE ANSWER"), name);
  }
  // A turn that started background work, with such a compaction after it: its own answer with nothing added, as before.
  const [heldRequest, call, started, own, notice, noticeAnswer] = realRows("background_command").session;
  const automatic = { ...byCommand, compactMetadata: { trigger: "auto" } };
  assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, call!, started!, own!, automatic, summary!, notice!, noticeAnswer!], turnId, sessionId), replyFromSession(A));
  // The same rows with the boundary of the command, which is captured: the turn is over there, and its background work is not reported.
  assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, call!, started!, own!, byCommand, summary!, notice!, noticeAnswer!], turnId, sessionId), asRead(noReport(A)));
});

test("the turn's own request row says whether the CLI marks its prompts: a session with no marks is read by the earlier rule", () => {
  // Every captured row is of Claude Code 2.1.278, and the app allows older ones. A CLI that does not write
  // `promptSource` writes it on no prompt: then no prompt would ever end a turn by its mark, and no answer would be
  // proven. The rows here are real; `unmarked` takes the marks off, as such a CLI would leave them off.
  const unmarked = (rows: ClaudeEvidenceRecord[]) => rows.map((row) => { const { promptSource: _source, origin: _origin, turnOrigin: _turn, ...rest } = row; return rest as ClaudeEvidenceRecord; });
  // The sequence in which the reader runs: a turn, then the first prompt of the process that replaced the one that ended, and its answer.
  const { session: resumed, file: resumedFile } = realRows("resumed_session");
  const [request, answer, nextPrompt, nextAnswer] = resumed;
  assert.deepEqual([request!.promptSource, nextPrompt!.promptSource, nextPrompt!.uuid], ["sdk", "sdk", "SECOND_TURN_ID"]);
  assert.deepEqual((nextAnswer!.message as { content: unknown }).content, [{ type: "text", text: "ANSWER OF THE SECOND TURN" }]);
  for (const [name, rows] of [["with the marks", resumedFile], ["with no marks", unmarked(resumedFile)], ["messages alone, with the marks", resumed], ["messages alone, with no marks", unmarked(resumed)]] as const) {
    assert.deepEqual(recoverExactClaudeTurnFromSession(rows, turnId, sessionId), replyFromSession(A), `${name}: the turn's answer is read`);
    assert.deepEqual(recoverExactClaudeTurnFromSession(rows, "SECOND_TURN_ID", sessionId), { ...replyFromSession("ANSWER OF THE SECOND TURN"), turnId: "SECOND_TURN_ID" }, name);
    // Cut before the replacement's answer: the turn's answer is proven by the prompt alone.
    assert.deepEqual(recoverExactClaudeTurnFromSession(rows.slice(0, rows.findIndex((row) => row.uuid === "SECOND_TURN_ID") + 1), turnId, sessionId), replyFromSession(A), name);
  }
  // The same holds for the simplest real turn.
  const completed = realRows("completed_answer").session;
  assert.deepEqual(recoverExactClaudeTurnFromSession(unmarked([...completed, nextPrompt!, nextAnswer!]), turnId, sessionId), replyFromSession("PROBE_OK"));

  // With no marks, every row is read by the earlier rule: the rows that go on with the turn are read through, and
  // the first other user row ends the turn's rows. The answer before it stays; nothing after it is read.
  const [hookRequest, beforeHook, hookFeedback, afterHook] = unmarked(realRows("stop_hook_refuses_end_once").session);
  const [, askForOutput] = realRows("completed_without_answer").session;
  const [, , toolResult] = realRows("hook_feedback_after_tool_call").session;
  const interrupted = realRows("interrupt_during_task_notice_answer").session.at(-1)!;
  const own = endedWith("message-answer", "THE ANSWER");
  const later = endedWith("message-later", "A LATER MESSAGE");
  assert.equal(hookRequest!.promptSource, undefined);
  assert.deepEqual(recoverExactClaudeTurnFromSession([hookRequest!, beforeHook!, hookFeedback!, afterHook!], turnId, sessionId), replyFromSession("ANSWER AFTER THE HOOK"));
  assert.equal(recoverExactClaudeTurnFromSession([hookRequest!, beforeHook!, hookFeedback!], turnId, sessionId), null);
  for (const row of [askForOutput!, toolResult!, hookFeedback!]) {
    assert.deepEqual(recoverExactClaudeTurnFromSession([hookRequest!, own, row, later], turnId, sessionId), replyFromSession("A LATER MESSAGE"));
  }
  const note: ClaudeEvidenceRecord = { type: "user", uuid: "another-row", sessionId, message: { role: "user", content: "A note the CLI wrote." } };
  for (const other of [interrupted, note, unmarked([nextPrompt!])[0]!, nextPrompt!]) {
    assert.deepEqual(recoverExactClaudeTurnFromSession([hookRequest!, own, other], turnId, sessionId), replyFromSession("THE ANSWER"));
    assert.deepEqual(recoverExactClaudeTurnFromSession([hookRequest!, own, other, later], turnId, sessionId), replyFromSession("THE ANSWER"));
    assert.equal(recoverExactClaudeTurnFromSession([hookRequest!, other, later], turnId, sessionId), null);
  }
  // A row that holds a tool's result beside another part is not the turn going on under either rule.
  const mixedParts = { ...toolResult!, message: { role: "user", content: [...(toolResult!.message as { content: unknown[] }).content, { type: "text", text: "another request" }] } };
  assert.deepEqual(recoverExactClaudeTurnFromSession([hookRequest!, own, mixedParts, later], turnId, sessionId), replyFromSession("THE ANSWER"));

  // With no marks a notice is not known from any other command: the turn that started background work is read as
  // it was before, with its own answer and nothing added. No capture of such a CLI shows what else would be true.
  for (const name of ["background_command", "subagent_in_background", "two_background_commands", "task_ends_while_turn_goes_on"]) {
    const { file } = realRows(name);
    const ownAnswer = (file.filter((row) => row.type === "assistant" && (row.message as { stop_reason?: string }).stop_reason === "end_turn")[0]!.message as { content: Array<{ text: string }> }).content[0]!.text;
    for (let length = 1; length <= file.length; length += 1) {
      const read = recoverExactClaudeTurnFromSession(unmarked(file.slice(0, length)), turnId, sessionId);
      assert.ok(read === null || (read.outcome === "reply" && read.text === ownAnswer && read.backgroundWork === undefined), `${name} with no marks, cut after row ${length}`);
    }
    assert.deepEqual(recoverExactClaudeTurnFromSession(unmarked(file), turnId, sessionId), replyFromSession(ownAnswer), name);
  }

  // A file in which only some prompts are marked is not known to occur. It is read by the turn's own request.
  // A request with no mark, and a marked prompt after it: the earlier rule ends the turn at that prompt.
  assert.deepEqual(recoverExactClaudeTurnFromSession([...unmarked([request!, answer!]), nextPrompt!, nextAnswer!], turnId, sessionId), replyFromSession(A));
  // A marked request, and a prompt with no mark after it: that prompt is a row that is not known, and no answer is proven.
  assert.equal(recoverExactClaudeTurnFromSession([request!, answer!, ...unmarked([nextPrompt!, nextAnswer!])], turnId, sessionId), null);

  // The notice of a task has a mark of its own. A CLI that marks its prompts and not its notices writes a command of
  // its own (`promptSource: "system"`) with no word on what it is: the turn is then read with its own answer alone.
  const [heldRequest, call, started, ownAnswer, notice, noticeAnswer] = realRows("background_command").session;
  const { origin: _origin, ...noticeWithNoMark } = notice!;
  assert.deepEqual([notice!.promptSource, noticeWithNoMark.promptSource, noticeWithNoMark.origin], ["system", "system", undefined]);
  assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, call!, started!, ownAnswer!, noticeWithNoMark, noticeAnswer!], turnId, sessionId), replyFromSession(A));
  assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, call!, started!, ownAnswer!, noticeWithNoMark], turnId, sessionId), replyFromSession(A));
  // With no command of the CLI's own after the turn, there is no notice in the session, marked or not: the reply says that a report is missing.
  assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, call!, started!, ownAnswer!], turnId, sessionId), asRead(noReport(A)));
  assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, call!, started!, ownAnswer!, nextPrompt!, nextAnswer!], turnId, sessionId), asRead(noReport(A)));
  // A command of the CLI's own that is marked as another kind is no notice, and ends the reading like a prompt:
  // the notice of the turn's task after it is not read for the turn.
  const otherKind = { ...notice!, uuid: "another-command", origin: { kind: "scheduled-trigger" } };
  assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, call!, started!, ownAnswer!, otherKind, noticeAnswer!], turnId, sessionId), asRead(noReport(A)));
  assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, call!, started!, ownAnswer!, otherKind, endedWith("message-other", "ANSWER TO THE OTHER COMMAND"), notice!, noticeAnswer!], turnId, sessionId),
    asRead(noReport(A)));
});

test("the line about a missing report is added only when a report is due: not for a command that the turn itself stopped, and not for work of a kind that is not recognised", () => {
  // Real rows: the turn starts a command in the background and stops it with the CLI's own tool. The CLI tells the
  // model of no end of such a command, and the adapter does not hold the turn open for it.
  const { session, stream } = realRows("background_command_stopped_by_the_turn");
  const [request, call, started, stopCall, stopped, answer] = session;
  const task = claudeCapturedTask("background_command_stopped_by_the_turn");
  assert.equal((started!.toolUseResult as { backgroundTaskId: string }).backgroundTaskId, task);
  assert.deepEqual(((stopCall!.message as { content: Array<{ name: string; input: unknown }> }).content).map((part) => [part.name, part.input]), [["TaskStop", { task_id: task }]]);
  assert.deepEqual(stopped!.toolUseResult, { message: `Successfully stopped task: ${task} (sleep 30; echo BACKGROUND_DONE)`, task_id: task, task_type: "local_bash", command: "sleep 30; echo BACKGROUND_DONE" });
  assert.deepEqual(stream.filter((event) => event.subtype === "task_notification").map((event) => [event.task_id, event.status]), [[task, "stopped"]]);
  assert.deepEqual(stream.filter((event) => event.type === "result").map((event) => event.result), [A], "one result: no answer to a notice follows");
  assert.deepEqual(recoverExactClaudeTurnFromSession(session, turnId, sessionId), replyFromSession(A), "nothing is missing, and the reply does not say that something is");

  const read = (...rows: ClaudeEvidenceRecord[]) => recoverExactClaudeTurnFromSession([request!, call!, started!, ...rows, answer!], turnId, sessionId);
  // Without the stop, a report is due.
  assert.deepEqual(read(), asRead(noReport(A)));
  // The stop of another task, a stop that failed, a result of another tool with the same fields, and a stopped
  // sub-agent (no capture shows that the model is not told of one) leave the report due.
  const withResult = (toolUseResult: unknown, part: Record<string, unknown> = {}): ClaudeEvidenceRecord =>
    ({ ...stopped!, toolUseResult, message: { role: "user", content: [{ ...(stopped!.message as { content: Array<Record<string, unknown>> }).content[0]!, ...part }] } });
  const result = stopped!.toolUseResult as Record<string, unknown>;
  assert.deepEqual(read(stopCall!, withResult({ ...result, task_id: "bother000" })), asRead(noReport(A)));
  assert.deepEqual(read(stopCall!, withResult(result, { is_error: true })), asRead(noReport(A)));
  assert.deepEqual(read(stopCall!, withResult({ ...result, task_type: "local_agent" })), asRead(noReport(A)));
  assert.deepEqual(read(stopCall!, withResult({ task_id: task, task_type: "local_bash" })), asRead(noReport(A)));
  assert.deepEqual(read(stopCall!, withResult("Error: no such task")), asRead(noReport(A)));
  const otherTool = JSON.parse(JSON.stringify(stopCall!).replaceAll("\"TaskStop\"", "\"Bash\"")) as ClaudeEvidenceRecord;
  assert.deepEqual(read(otherTool, stopped!), asRead(noReport(A)));
  assert.deepEqual(read(stopped!), asRead(noReport(A)), "a result with no call of the tool");
  // Of two commands, one stopped: a report on the other is still due.
  const second = [call!, started!].map((row, index) => ({ ...JSON.parse(JSON.stringify(row).replaceAll(task, "bsecond00").replaceAll("\"toolu_probe\"", "\"toolu_probe_other\"")), uuid: `second-${index}` }) as ClaudeEvidenceRecord);
  assert.deepEqual(read(...second, stopCall!, stopped!), asRead(noReport(A)));

  // The answer to a notice can stop the turn's other command (real rows of two commands, and of the stop): no
  // report on that one is due either, and the reply is whole.
  const two = "two_background_commands";
  const [twoRequest, firstCall, secondCall, firstStarted, secondStarted, twoAnswer, firstNotice, firstNoticeAnswer] = realRows(two).session;
  const [endsFirst, endsLater] = [claudeCapturedTask(two, "toolu_probe_1"), claudeCapturedTask(two, "toolu_probe_2")];
  assert.ok(String((firstNotice!.message as { content: unknown }).content).includes(`<task-id>${endsFirst}</task-id>`));
  const stopOfTheOther = [stopCall!, stopped!].map((row, index) => ({ ...JSON.parse(JSON.stringify(row).replaceAll(task, endsLater)), uuid: `stop-${index}` }) as ClaudeEvidenceRecord);
  const turnOfTwo = [twoRequest!, firstCall!, secondCall!, firstStarted!, secondStarted!, twoAnswer!, firstNotice!];
  assert.deepEqual(recoverExactClaudeTurnFromSession([...turnOfTwo, firstNoticeAnswer!], turnId, sessionId), asRead(noReport(A, N1)));
  assert.deepEqual(recoverExactClaudeTurnFromSession([...turnOfTwo, ...stopOfTheOther, firstNoticeAnswer!], turnId, sessionId), replyFromSession(`${A}\n\n${N1}`));

  // Background work is recognised by the two fields that the CLI keeps beside a tool's result: the id of a command
  // that runs in the background, and the id of a sub-agent that was started without waiting for it. A turn whose
  // work left neither is read as a turn with no background work: its own answer, and no word about a report.
  for (const name of ["background_command", "subagent_in_background"]) {
    const [heldRequest, heldCall, heldStarted, own, notice, noticeAnswer] = realRows(name).session;
    const { toolUseResult: _result, ...notRecognised } = heldStarted!;
    assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, heldCall!, notRecognised, own!, notice!, noticeAnswer!], turnId, sessionId), replyFromSession(A), name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, heldCall!, notRecognised, own!], turnId, sessionId), replyFromSession(A), name);
    assert.deepEqual(recoverExactClaudeTurnFromSession([heldRequest!, heldCall!, { ...heldStarted!, toolUseResult: { stdout: "", stderr: "", taskId: "bother000" } }, own!], turnId, sessionId), replyFromSession(A), name);
  }
  // A sub-agent that the tool call waited for is no background work.
  assert.deepEqual(recoverExactClaudeTurnFromSession(realRows("subagent_in_foreground").session, turnId, sessionId), replyFromSession(A));
});

test("two tasks of one message whose notices come in the other order than they started: each answer is bound to its task by the task's id", () => {
  const name = "two_background_commands_end_in_the_other_order";
  const { stream, file, session } = realRows(name);
  const [first, second] = [claudeCapturedTask(name, "toolu_probe_1"), claudeCapturedTask(name, "toolu_probe_2")];
  const tasksOf = (subtype: string) => stream.filter((event) => event.type === "system" && event.subtype === subtype).map((event) => event.task_id);
  assert.deepEqual(tasksOf("task_started"), [first, second], "the first call's task started first");
  assert.deepEqual(tasksOf("task_notification"), [second, first], "and ended last");
  // In the session the results stand in the order of the calls, and the notices in the order in which the tasks ended.
  assert.deepEqual(session.flatMap((row) => { const id = (row.toolUseResult as { backgroundTaskId?: string } | undefined)?.backgroundTaskId; return id ? [id] : []; }), [first, second]);
  const notices = session.filter((row) => row.origin !== undefined).map((row) => String((row.message as { content: unknown }).content));
  assert.deepEqual(notices.map((text) => /<task-id>([^<]+)<\/task-id>\n<tool-use-id>([^<]+)</.exec(text)!.slice(1, 3)), [[second, "toolu_probe_2"], [first, "toolu_probe_1"]]);
  assert.deepEqual(recoverExactClaudeTurnFromSession(file, turnId, sessionId), replyFromSession(`${A}\n\n${N1}\n\n${N2}`));
  // After the first notice's answer the reply still lacks the report on the task that started first.
  const firstAnswer = file.findIndex((row) => row.type === "assistant" && JSON.stringify(row.message).includes(N1));
  assert.deepEqual(recoverExactClaudeTurnFromSession(file.slice(0, firstAnswer + 1), turnId, sessionId), asRead(noReport(A, N1)));
});

/**
 * Every capture, cut after every row of its session file, as a process that ended there would leave it. What is
 * the turn's and what is not is read from the rows themselves, by the chain of parents: a message answers the
 * first prompt, or notice of a task, on its chain.
 */
test("no cut of any real session gives a text of another turn or of a sub-agent, or a partial reply that does not say so", () => {
  let cuts = 0;
  let replies = 0;
  let marked = 0;
  for (const [name, capture] of Object.entries(CLAUDE_REAL_CAPTURES)) {
    const { file, subagent } = realRows(name);
    const textOf = (row: ClaudeEvidenceRecord) => ((row.message as { content?: unknown } | undefined)?.content as Array<{ type: string; text?: string }> | undefined ?? [])
      .flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("");
    // The request of a message: the first prompt, or notice of a task, on its chain of parents.
    const requestOf = (row: ClaudeEvidenceRecord) => claudeParentChain(capture.session_file, capture.session_file.find((other) => other.uuid === row.uuid)!)
      .find((other) => other.type === "user" && typeof other.promptSource === "string");
    const answers = file.filter((row) => row.type === "assistant" && textOf(row));
    const forbidden = [...new Set([...subagent.filter((row) => row.type === "assistant").map(textOf),
      ...answers.filter((row) => { const request = requestOf(row); return request !== undefined && request.uuid !== "TURN_ID" && (request.origin as { kind?: string } | undefined)?.kind !== "task-notification"; }).map(textOf),
      // What the CLI itself wrote in a result or a summary is never the model's answer.
      "SUMMARY OF THE CONVERSATION", "UserPromptSubmit operation blocked"].filter(Boolean))];
    const whole = recoverExactClaudeTurnFromSession(file, turnId, sessionId);
    const startsBackgroundWork = file.some((row) => { const result = row.toolUseResult as { backgroundTaskId?: unknown; isAsync?: unknown } | undefined; return result?.backgroundTaskId !== undefined || result?.isAsync === true; });
    const firstCall = file.findIndex((row) => row.type === "assistant");
    const withSubagent = subagent.length ? [...file.slice(0, firstCall + 1), ...subagent, ...file.slice(firstCall + 1)] : null;
    for (const rows of [file, ...(withSubagent ? [withSubagent] : [])]) {
      for (let length = 1; length <= rows.length; length += 1) {
        cuts += 1;
        const read = recoverExactClaudeTurnFromSession(rows.slice(0, length), turnId, sessionId);
        if (read?.outcome !== "reply") continue;
        replies += 1;
        const where = `${name}${rows === file ? "" : " with the sub-agent's rows"}, cut after row ${length}`;
        for (const text of forbidden) assert.ok(!read.text.includes(text), `${where}: ${JSON.stringify(text)} is not this turn's`);
        // Each part of the reply is a whole text of a message that the session holds.
        for (const part of read.text.split("\n\n")) assert.ok(answers.some((row) => textOf(row).trim() === part), `${where}: ${JSON.stringify(part)} is a message of the session`);
        if (read.backgroundWork) { marked += 1; continue; }
        // A reply with no word that something is missing is the whole reply: the one that the whole session gives,
        // or the answer of a turn that started nothing in the background, or of a turn that stopped what it started.
        assert.ok(!startsBackgroundWork || name === "background_command_stopped_by_the_turn" || (whole?.outcome === "reply" && whole.backgroundWork === undefined && whole.text === read.text),
          `${where}: a reply that is not the whole one says so`);
      }
    }
  }
  // The numbers are written out, so that a change of the fixture or of the cuts is seen.
  assert.deepEqual({ captures: Object.keys(CLAUDE_REAL_CAPTURES).length, cuts, replies, marked }, { captures: 52, cuts: PROPERTY_CUTS, replies: PROPERTY_REPLIES, marked: PROPERTY_MARKED });
});

test("in a capture each id has a placeholder of its own, so a row names its parent, and an answer is bound to its request by that chain", () => {
  for (const [name, capture] of Object.entries(CLAUDE_REAL_CAPTURES)) {
    const file = capture.session_file;
    const ids = file.map((row) => row.uuid);
    assert.ok(ids.every((id) => typeof id === "string" && /^(?:TURN_ID|SECOND_TURN_ID|UUID_\d+)$/.test(id)), name);
    assert.equal(new Set(ids).size, ids.length, `${name}: no two rows share an id`);
    // A row's parent is a row that the file holds before it. A row with none starts the conversation, or starts it
    // again after a compaction.
    for (const [index, row] of file.entries()) {
      if (row.parentUuid === null) continue;
      assert.ok(ids.slice(0, index).includes(row.parentUuid), `${name}: row ${index + 1} names a row before it as its parent`);
    }
    // No id of a recording is left as the one word that all ids had before.
    assert.ok(!JSON.stringify(capture).includes("\"UUID\""), name);
  }
  // The request of an answer is the first row on its chain that starts a command: a prompt, or the notice of a task.
  const requestOf = (file: Array<Record<string, unknown>>, text: string) => {
    const answer = file.find((row) => row.type === "assistant" && JSON.stringify((row.message as { content: unknown }).content).includes(JSON.stringify(text)))!;
    return claudeParentChain(file, answer).find((row) => row.type === "user" && typeof row.promptSource === "string");
  };
  const secondPrompt = CLAUDE_REAL_CAPTURES.prompt_during_task_notice_answer!.session_file;
  assert.equal(requestOf(secondPrompt, A)!.uuid, "TURN_ID");
  assert.deepEqual(requestOf(secondPrompt, N)!.origin, { kind: "task-notification" });
  assert.equal(requestOf(secondPrompt, "ANSWER OF THE SECOND TURN")!.uuid, "SECOND_TURN_ID");
  const nextTurn = CLAUDE_REAL_CAPTURES.task_ends_during_next_turn!.session_file;
  assert.equal(requestOf(nextTurn, "ANSWER OF THE SECOND TURN")!.uuid, "SECOND_TURN_ID");
  assert.deepEqual(requestOf(nextTurn, N)!.origin, { kind: "task-notification" });
  // A compaction starts the chain again: the rows after it do not lead back to the turn before it.
  const compacted = CLAUDE_REAL_CAPTURES.compaction_by_command!.session_file;
  assert.equal(requestOf(compacted, A)!.uuid, "TURN_ID");
  const afterCompaction = claudeParentChain(compacted, compacted.find((row) => row.uuid === "SECOND_TURN_ID")!);
  assert.equal(afterCompaction.at(-1)!.subtype, "compact_boundary");
  assert.ok(afterCompaction.every((row) => row.uuid !== "TURN_ID"));
});

test("the recorder's sandbox denied a file write beside the run's folder, in a real run", () => {
  const { session, stream } = realRows("write_outside_run_folder_denied");
  const [, call, result] = session;
  const command = ((call!.message as { content: Array<{ input: { command: string } }> }).content[0]!).input.command;
  assert.match(command, /echo x > inside-the-run && echo INSIDE_WRITTEN; echo x > \.\.\/\.\.\/outside-every-run\/written-by-a-run; echo OUTSIDE_EXIT_\$\?/);
  // The write in the run's own folder was made. The write beside it was denied by the system, and the command went on.
  assert.equal(((result!.message as { content: Array<{ content: string }> }).content[0]!).content,
    "INSIDE_WRITTEN\nsh: ../../outside-every-run/written-by-a-run: Operation not permitted\nOUTSIDE_EXIT_1");
  assert.equal(stream.find((event) => event.type === "result")!.result, A);
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
    { type: "user", uuid: "later-turn", promptSource: "sdk", sessionId, message: { role: "user", content: [{ type: "text", text: "later" }] } },
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
    { type: "user", uuid: "later-turn", promptSource: "sdk", sessionId, message: { role: "user", content: [{ type: "text", text: "later" }] } },
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
