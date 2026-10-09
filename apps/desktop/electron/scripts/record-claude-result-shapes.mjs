import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Records what Claude Code really writes to stdout and to its session file
// when its request to the model fails, and when a turn holds more than a
// request and an answer: a tool's result, a Stop hook that refuses the end of
// the turn, the notice of a background task, a sub-agent, a skill. It writes
// them as the fixture __fixtures__/claude-code-result-shapes.json. The tests
// of the room adapter replay that fixture, so they hold the shapes the CLI
// sends and not the shapes somebody believed it sends.
//
// It is a manual developer tool. CI never runs it, and it starts no LetAgents
// desktop app and no daemon. It makes no call to a real model:
//   - The CLI talks to a stand-in for the Messages API that this script
//     starts on 127.0.0.1. The stand-in never stores or prints a request
//     header or a request body. It counts requests by method and path, and
//     reads five yes/no facts and one count from a body as it passes (see
//     `startStandIn`).
//   - The CLI runs under a macOS sandbox profile that denies every network
//     connection except to this machine's loopback, and the script proves
//     that the profile works before it starts the CLI.
//   - The CLI gets a clean environment: a new HOME, a new CLAUDE_CONFIG_DIR,
//     its temporary files in the run's own folder, and a dummy API key. It
//     does not read or write the owner's Claude settings, sessions or login.
//   - In some runs the stand-in answers with a tool call, and the CLI runs
//     that tool: it is given that one tool besides the read-only ones. The
//     sandbox denies the network to what the tool starts too, and nothing
//     else. Every call is written out in this file: a background shell
//     command that sleeps and prints a word (in one run it then exits with
//     a code that is not zero), a sub-agent whose model is the stand-in, a
//     bundled skill. In one run the CLI has a Stop hook: a
//     script this tool writes into the run's folder, named in a settings
//     file in the new CLAUDE_CONFIG_DIR. That run reads the "user"
//     settings, which are that file alone. In some runs the tool writes
//     more lines to the CLI's stdin after the prompt: an interrupt control
//     request, a second prompt, or its answer to a permission request. Two
//     runs start the CLI as an agent that asks before it writes; the command
//     it asks about writes one empty file in the run's own folder, and is
//     never allowed. (See `cli` in STUB_ANSWERS.)
//   - One run has no stand-in: the connection that is refused goes to a
//     loopback port with no listener, which nothing can hold (see
//     `unlistenedPort`). A local process that took that port during the run
//     would be sent the dummy key and the probe prompt. The tool checks that
//     every attempt was refused, and writes nothing when one was answered.
//   - The fixture is redacted, then checked for the user name, the host
//     name, the home and temporary directories and any UUID before it is
//     written. A path of the recording machine inside a text is replaced,
//     and a text of more than 2000 characters is cut short.
//
//   LETAGENTS_RECORD_CLAUDE_RESULT_SHAPES=1 node \
//     electron/scripts/record-claude-result-shapes.mjs [options]
//
//   --out <file>       where to write the fixture (default: the fixture file)
//   --only <a,b>       record only these stand-in answers (see STUB_ANSWERS)
//   --timeout-ms <n>   give one run up to n ms (default 240000). The CLI
//                      retries some failures for about three minutes.
//   --raw              also keep each run UNREDACTED, in a new folder in the system's
//                      temporary directory; the folder is named when the tool ends.
//                      Those files hold the ids and paths of this machine's runs.
//                      They are for --from-raw only: never commit them.
//   --from-raw <dir>   start no CLI: build the fixture from runs kept with --raw
//   --merge            keep the captures that the output file already holds, and add
//                      or replace only the ones of this run. Without it the file is
//                      written anew, with the captures of this run alone.

const RECORD_ENV = "LETAGENTS_RECORD_CLAUDE_RESULT_SHAPES";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Every network connection is denied except to this machine's loopback. */
const SANDBOX_PROFILE = "(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip \"localhost:*\"))\n";
/** TEST-NET-1: an address that is never routed, so the proof that it is denied reaches no one. */
const UNROUTED_ADDRESS = "192.0.2.1";
const DEFAULT_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "__fixtures__", "claude-code-result-shapes.json");

const errorBody = (type, message) => JSON.stringify({ type: "error", error: { type, message }, request_id: "req_probe" });
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const messageStart = (id = "msg_probe") => sse("message_start", { type: "message_start", message: {
  id, type: "message", role: "assistant", model: "probe-model", content: [], stop_reason: null, stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
const textStart = sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const textDelta = (text) => sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });

/** An answer that is one HTTP error. */
const httpError = (status, type, message) => (_wantsStream, response) => {
  response.writeHead(status, { "content-type": "application/json", "request-id": "req_probe" });
  response.end(errorBody(type, message));
};
/**
 * An answer that is one complete message, streamed or not as the request asked.
 * The provider gives every message its own id, and the CLI tells the messages
 * of a turn apart by it: a run with more than one answer names each.
 */
const message = (text, stopReason, id = "msg_probe") => (wantsStream, response) => {
  if (!wantsStream) {
    response.writeHead(200, { "content-type": "application/json", "request-id": "req_probe" });
    response.end(JSON.stringify({ id, type: "message", role: "assistant", model: "probe-model",
      content: text ? [{ type: "text", text }] : [], stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_probe" });
  response.write(messageStart(id));
  if (text) response.write(textStart + textDelta(text) + sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  response.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } }));
  response.end(sse("message_stop", { type: "message_stop" }));
};
/** An answer that is one call of a tool. */
const toolCall = (name, input) => (wantsStream, response) => {
  const call = { type: "tool_use", id: "toolu_probe", name };
  if (!wantsStream) {
    response.writeHead(200, { "content-type": "application/json", "request-id": "req_probe" });
    response.end(JSON.stringify({ id: "msg_probe_tool_call", type: "message", role: "assistant", model: "probe-model",
      content: [{ ...call, input }], stop_reason: "tool_use", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_probe" });
  response.write(messageStart("msg_probe_tool_call"));
  response.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { ...call, input: {} } })
    + sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })
    + sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  response.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }));
  response.end(sse("message_stop", { type: "message_stop" }));
};

/** An answer that is one message with several calls of tools. Each call has an id of its own. */
const toolCalls = (calls) => (wantsStream, response) => {
  const blocks = calls.map(([name, input], index) => ({ type: "tool_use", id: `toolu_probe_${index + 1}`, name, input }));
  if (!wantsStream) {
    response.writeHead(200, { "content-type": "application/json", "request-id": "req_probe" });
    response.end(JSON.stringify({ id: "msg_probe_tool_call", type: "message", role: "assistant", model: "probe-model",
      content: blocks, stop_reason: "tool_use", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_probe" });
  response.write(messageStart("msg_probe_tool_call"));
  for (const [index, block] of blocks.entries()) {
    response.write(sse("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } })
      + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })
      + sse("content_block_stop", { type: "content_block_stop", index }));
  }
  response.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }));
  response.end(sse("message_stop", { type: "message_stop" }));
};
/** An answer that is given only after a wait, so that something else can happen while the CLI waits for it. */
const later = (ms, answer) => (wantsStream, response, request, holds) => {
  setTimeout(() => { if (!response.destroyed && !request.socket.destroyed) answer(wantsStream, response, request, holds); }, ms).unref();
};

/** The prompt the stand-in gives a sub-agent. A request that holds its first word and no tool result is the sub-agent's own. */
const SUBAGENT_PROMPT = "PROBE_SUBAGENT: reply exactly SUBAGENT REPORT.";
/** The same for the second sub-agent of a run that starts two. Neither prompt's first word is part of the other's. */
const SECOND_SUBAGENT_PROMPT = "PROBE_SECOND_SUBAGENT: reply exactly SECOND SUBAGENT REPORT.";
/** The prompt of the second turn, in the run that sends one. */
const SECOND_PROMPT = "Reply exactly PROBE_SECOND_OK.";
/**
 * A turn in which the model calls one tool. The first request gets the call.
 * The request that brings the tool's result back gets the turn's answer. When
 * the CLI later sends the notice of a background task, it runs a turn of its
 * own for it, and that request gets an answer with other words. A sub-agent's
 * own request gets `subagent`.
 */
const turnWithToolCall = (call, subagent = message("SUBAGENT REPORT", "end_turn", "msg_probe_subagent")) => (wantsStream, response, request, holds) => (
  holds.taskNotice ? message("ANSWER TO THE TASK NOTICE", "end_turn", "msg_probe_notice_answer")
    : holds.toolResult ? message("ANSWER OF THE TURN", "end_turn", "msg_probe_answer")
      : holds.subagentPrompt ? subagent : call)(wantsStream, response, request);
/**
 * The same turn, with what a run changes in it. `notices` answers the requests that hold a task's notice, the
 * first of them with its first entry and so on (the last entry answers every later one). `secondSubagent`
 * answers the second sub-agent's own request, and `secondTurn` the request of a second prompt.
 */
const turnWithBackgroundWork = (call, { notices = [message("ANSWER TO THE TASK NOTICE", "end_turn", "msg_probe_notice_answer")],
  subagent = message("SUBAGENT REPORT", "end_turn", "msg_probe_subagent"), secondSubagent = null, secondTurn = null } = {}) => {
  let noticeRequests = 0;
  return (wantsStream, response, request, holds) => (
    holds.taskNotice ? notices[Math.min(noticeRequests++, notices.length - 1)]
      : secondTurn && holds.secondPrompt ? secondTurn
        : holds.toolResult ? message("ANSWER OF THE TURN", "end_turn", "msg_probe_answer")
          : secondSubagent && holds.secondSubagentPrompt ? secondSubagent
            : holds.subagentPrompt ? subagent : call)(wantsStream, response, request, holds);
};
const backgroundCommand = (command, description = "probe") => ["Bash", { command, description, run_in_background: true }];
/** One line that the tool writes to the CLI's stdin after the prompt. */
const interruptRequest = () => ({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
const secondPrompt = (ids) => ({ type: "user", uuid: ids.secondTurnId, message: { role: "user", content: [{ type: "text", text: SECOND_PROMPT }] } });
/** The answer to a permission request that the CLI sent on stdout. */
const permissionResponse = (event, response) => ({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response } });
/** The command with which the model answers a task's notice, in the runs that ask for approval. It writes one empty file in the run's own folder. */
const NOTICE_COMMAND = "touch notice-probe";
const asksForTheNoticeCommand = (event) => event.request?.subtype === "can_use_tool" && event.request.input?.command === NOTICE_COMMAND;
/** The recorder allows the background command of the turn, as an owner would, whenever the CLI asks about it. */
const allowsTheBackgroundCommand = { when: "control_request", every: true, afterMs: 50,
  match: (event) => event.request?.subtype === "can_use_tool" && !asksForTheNoticeCommand(event),
  lines: (_ids, event) => [permissionResponse(event, { behavior: "allow", updatedInput: event.request.input })] };
/**
 * A turn with one tool call, in the runs that send a second prompt after a task's notice. The request with the
 * second prompt holds the notice too, so the answers go by what the request holds and by their order: the call,
 * the turn's answer, and then `notice()` for each request that has no second prompt in it.
 */
const afterTheTurn = (call, notice) => {
  let requests = 0;
  return (wantsStream, response, request, holds) => {
    requests += 1;
    (requests === 1 ? call : requests === 2 ? message("ANSWER OF THE TURN", "end_turn", "msg_probe_answer")
      : holds.secondPrompt ? message("ANSWER OF THE SECOND TURN", "end_turn", "msg_probe_second_answer") : notice())(wantsStream, response, request, holds);
  };
};
/** The first request with the notice gets a command that needs approval. A later one gets an answer. */
const noticeAnsweredWithACommand = () => {
  let asked = 0;
  return () => (asked++ === 0 ? toolCalls([["Bash", { command: NOTICE_COMMAND, description: "notice probe" }]])
    : message("ANSWER TO THE TASK NOTICE, AFTER ITS COMMAND", "end_turn", "msg_probe_notice_answer"));
};

/**
 * What the stand-in answers to POST /v1/messages, by the name the fixture
 * gives the capture. `answer` is null where there is no listener at all.
 * A stalled stream is not in the default set: the CLI wrote no result for it
 * in nine minutes.
 *
 * `cli` is what a run changes in how the CLI is started: `tool` is the one
 * tool it gets besides the read-only ones (two, with a comma between them,
 * in the run that starts a sub-agent and a command), `stopHook` gives it a Stop hook
 * that refuses the first end of the turn, and `lingerMs` is how long the CLI
 * is left running after the turn's result, for what it writes after a turn.
 * `alsoWrites` is one more line for the CLI's stdin: `afterMs` after the first
 * stdout line of the kind `when` names ("result", "control_request", or
 * "task_notification" for the system event of that name). A run can have a
 * list of them. `lines` gives several lines that are written together,
 * `match` limits the rule to the stdout lines it accepts, and `every` writes
 * for each such line. `askForApproval` starts the CLI as an agent that asks
 * before it writes: the tool is not allowed beforehand, and the CLI sends a
 * permission request on stdout. `closeWaitMs` is how long the CLI gets to
 * end by itself once its stdin is closed, before it is stopped (default 3000).
 */
const STUB_ANSWERS = {
  completed_answer: { stub: "HTTP 200, a normal streamed answer", answer: message("PROBE_OK", "end_turn") },
  completed_without_answer: { stub: "HTTP 200, a streamed answer with no content, twice", answer: message("", "end_turn") },
  http_401_authentication: { stub: "HTTP 401 authentication_error", answer: httpError(401, "authentication_error", "invalid x-api-key") },
  http_403_permission: { stub: "HTTP 403 permission_error",
    answer: httpError(403, "permission_error", "Your API key does not have permission to use the specified resource.") },
  http_404_not_found: { stub: "HTTP 404 not_found_error", answer: httpError(404, "not_found_error", "model: probe-model") },
  http_400_invalid_request: { stub: "HTTP 400 invalid_request_error",
    answer: httpError(400, "invalid_request_error", "messages.0.content: probe says this request is invalid") },
  http_400_prompt_too_long: { stub: "HTTP 400 invalid_request_error: prompt is too long",
    answer: httpError(400, "invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum") },
  http_400_credit_balance: { stub: "HTTP 400 invalid_request_error: credit balance is too low",
    answer: httpError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.") },
  http_413_request_too_large: { stub: "HTTP 413 request_too_large",
    answer: httpError(413, "request_too_large", "Request exceeds the maximum allowed number of bytes.") },
  http_429_rate_limit: { stub: "HTTP 429 rate_limit_error",
    answer: httpError(429, "rate_limit_error", "This request would exceed your organization's rate limit.") },
  http_500_server_error: { stub: "HTTP 500 api_error", answer: httpError(500, "api_error", "Internal server error") },
  http_529_overloaded: { stub: "HTTP 529 overloaded_error", answer: httpError(529, "overloaded_error", "Overloaded") },
  connection_closed_mid_stream: { stub: "HTTP 200, then the connection is closed in the middle of the stream",
    answer: (wantsStream, response, request) => {
      response.writeHead(200, { "content-type": wantsStream ? "text/event-stream" : "application/json", "request-id": "req_probe" });
      response.write(wantsStream ? messageStart() + textStart + textDelta("PARTIAL ")
        : "{\"id\":\"msg_probe\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"PARTI");
      setTimeout(() => request.socket.destroy(), 100);
    } },
  connection_refused: { stub: "no listener on the port", answer: null },
  stream_error_event: { stub: "HTTP 200, then an overloaded_error event in the stream",
    answer: (_wantsStream, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_probe" });
      response.write(messageStart() + textStart + textDelta("PARTIAL "));
      response.end(sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    } },
  stream_stalled: { stub: "HTTP 200, then no more bytes", optional: true,
    answer: (wantsStream, response) => {
      if (!wantsStream) return; // The request the CLI falls back to gets no answer either.
      response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_probe" });
      response.write(messageStart() + textStart);
    } },
  stop_reason_max_tokens: { stub: "HTTP 200, every answer stops with max_tokens", answer: message("PROBE_OK", "max_tokens") },
  stop_reason_refusal: { stub: "HTTP 200, the answer stops with refusal", answer: message("PROBE_OK", "refusal") },
  stop_hook_refuses_end_once: { stub: "HTTP 200, two normal answers. A Stop hook refuses the first end of the turn and allows the second.",
    cli: { stopHook: true },
    answer: (wantsStream, response, _request, holds) => (holds.nth === 1 ? message("ANSWER BEFORE THE HOOK", "end_turn", "msg_probe_before_hook")
      : message("ANSWER AFTER THE HOOK", "end_turn", "msg_probe_after_hook"))(wantsStream, response) },
  background_command: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer, then an answer to the task's notice. The command ends three seconds after it starts.",
    cli: { tool: "Bash", lingerMs: 9_000 },
    answer: turnWithToolCall(toolCall("Bash", { command: "sleep 3; echo BACKGROUND_DONE", description: "probe", run_in_background: true })) },
  subagent_in_background: { stub: "HTTP 200: a Task call, then the turn's answer, then an answer to the task's notice. The sub-agent gets a normal answer.",
    cli: { tool: "Task", lingerMs: 4_000 },
    answer: turnWithToolCall(toolCall("Task", { description: "probe", prompt: SUBAGENT_PROMPT, subagent_type: "general-purpose" })) },
  subagent_in_foreground: { stub: "HTTP 200: a Task call that is not to run in the background, then the turn's answer. The sub-agent gets a normal answer.",
    cli: { tool: "Task", lingerMs: 4_000 },
    answer: turnWithToolCall(toolCall("Task", { description: "probe", prompt: SUBAGENT_PROMPT, subagent_type: "general-purpose", run_in_background: false })) },
  subagent_api_error: { stub: "HTTP 200: a Task call, then the turn's answer, then an answer to the task's notice. The sub-agent gets HTTP 400 invalid_request_error.",
    cli: { tool: "Task", lingerMs: 4_000 },
    answer: turnWithToolCall(toolCall("Task", { description: "probe", prompt: SUBAGENT_PROMPT, subagent_type: "general-purpose" }),
      httpError(400, "invalid_request_error", "probe says the sub-agent's request is invalid")) },
  skill_call: { stub: "HTTP 200: a Skill call for a bundled skill, then the turn's answer.",
    cli: { tool: "Skill" },
    answer: turnWithToolCall(toolCall("Skill", { skill: "keybindings-help" })) },
  two_background_commands: { stub: "HTTP 200: two Bash calls in one message that run in the background, then the turn's answer, then an answer to each task's notice. One command ends two seconds after it starts and the other six.",
    cli: { tool: "Bash", lingerMs: 12_000 },
    answer: turnWithBackgroundWork(toolCalls([backgroundCommand("sleep 2; echo FIRST_DONE", "first probe"), backgroundCommand("sleep 6; echo SECOND_DONE", "second probe")]),
      { notices: [message("ANSWER TO THE FIRST TASK NOTICE", "end_turn", "msg_probe_first_notice_answer"), message("ANSWER TO THE SECOND TASK NOTICE", "end_turn", "msg_probe_second_notice_answer")] }) },
  two_background_commands_end_together: { stub: "HTTP 200: two Bash calls in one message that run in the background, then the turn's answer, then an answer to each task's notice. Both commands end three seconds after they start.",
    cli: { tool: "Bash", lingerMs: 10_000 },
    answer: turnWithBackgroundWork(toolCalls([backgroundCommand("sleep 3; echo FIRST_DONE", "first probe"), backgroundCommand("sleep 3; echo SECOND_DONE", "second probe")]),
      { notices: [message("ANSWER TO THE FIRST TASK NOTICE", "end_turn", "msg_probe_first_notice_answer"), message("ANSWER TO THE SECOND TASK NOTICE", "end_turn", "msg_probe_second_notice_answer")] }) },
  two_subagents_in_background: { stub: "HTTP 200: two Task calls in one message, then the turn's answer, then an answer to each task's notice. The first sub-agent gets a normal answer at once and the second after four seconds.",
    cli: { tool: "Task", lingerMs: 12_000 },
    answer: turnWithBackgroundWork(toolCalls([["Task", { description: "first probe", prompt: SUBAGENT_PROMPT, subagent_type: "general-purpose" }],
      ["Task", { description: "second probe", prompt: SECOND_SUBAGENT_PROMPT, subagent_type: "general-purpose" }]]),
    { notices: [message("ANSWER TO THE FIRST TASK NOTICE", "end_turn", "msg_probe_first_notice_answer"), message("ANSWER TO THE SECOND TASK NOTICE", "end_turn", "msg_probe_second_notice_answer")],
      secondSubagent: later(4_000, message("SECOND SUBAGENT REPORT", "end_turn", "msg_probe_second_subagent")) }) },
  background_command_fails: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer, then an answer to the task's notice. The command ends two seconds after it starts, with exit code 3.",
    cli: { tool: "Bash", lingerMs: 8_000 },
    answer: turnWithBackgroundWork(toolCall(...backgroundCommand("sleep 2; echo BACKGROUND_FAILED; exit 3"))) },
  background_command_notice_answer_empty: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer, then an answer with no content to the task's notice, each time it is asked. The command ends two seconds after it starts.",
    cli: { tool: "Bash", lingerMs: 9_000 },
    answer: turnWithBackgroundWork(toolCall(...backgroundCommand("sleep 2; echo BACKGROUND_DONE")), { notices: [message("", "end_turn", "msg_probe_notice_answer")] }) },
  background_command_notice_api_error: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer. The request that holds the task's notice gets HTTP 400 invalid_request_error. The command ends two seconds after it starts.",
    cli: { tool: "Bash", lingerMs: 9_000 },
    answer: turnWithBackgroundWork(toolCall(...backgroundCommand("sleep 2; echo BACKGROUND_DONE")),
      { notices: [httpError(400, "invalid_request_error", "probe says the request with the task's notice is invalid")] }) },
  background_command_running_at_input_close: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer. A request with the task's notice would get an answer. The command would end eight seconds after it starts. The CLI's stdin is closed one and a half seconds after the turn's result, and the CLI then gets twenty seconds to end by itself.",
    cli: { tool: "Bash", lingerMs: 1_500, closeWaitMs: 20_000 },
    answer: turnWithBackgroundWork(toolCall(...backgroundCommand("sleep 8; echo BACKGROUND_DONE"))) },
  background_command_running_at_interrupt: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer, then an answer to the task's notice. The command ends five seconds after it starts. One second after the turn's result, with no turn running, the CLI is sent an interrupt control request.",
    cli: { tool: "Bash", lingerMs: 11_000, alsoWrites: { when: "result", afterMs: 1_000, line: interruptRequest } },
    answer: turnWithBackgroundWork(toolCall(...backgroundCommand("sleep 5; echo BACKGROUND_DONE"))) },
  interrupt_during_task_notice_answer: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer. The command ends two seconds after it starts. The answer to the task's notice would come only after eight seconds; one and a half seconds after the task's notification the CLI is sent an interrupt control request.",
    cli: { tool: "Bash", lingerMs: 12_000, alsoWrites: { when: "task_notification", afterMs: 1_500, line: interruptRequest } },
    answer: turnWithBackgroundWork(toolCall(...backgroundCommand("sleep 2; echo BACKGROUND_DONE")),
      { notices: [later(8_000, message("ANSWER TO THE TASK NOTICE", "end_turn", "msg_probe_notice_answer"))] }) },
  background_command_stopped_by_request: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer. A request with the task's notice would get an answer. The command would end six seconds after it starts. One second after the turn's result the CLI is sent a stop_task control request for the task.",
    cli: { tool: "Bash", lingerMs: 9_000, alsoWrites: { when: "result", afterMs: 1_000,
      line: (ids) => ({ type: "control_request", request_id: randomUUID(), request: { subtype: "stop_task", task_id: ids.taskId } }) } },
    answer: turnWithBackgroundWork(toolCall(...backgroundCommand("sleep 6; echo BACKGROUND_DONE"))) },
  subagent_stopped_by_request: { stub: "HTTP 200: a Task call, then the turn's answer, then an answer to the task's notice. The sub-agent's own request would be answered only after eight seconds. One second after the turn's result the CLI is sent a stop_task control request for the task.",
    cli: { tool: "Task", lingerMs: 11_000, alsoWrites: { when: "result", afterMs: 1_000,
      line: (ids) => ({ type: "control_request", request_id: randomUUID(), request: { subtype: "stop_task", task_id: ids.taskId } }) } },
    answer: turnWithBackgroundWork(toolCall("Task", { description: "probe", prompt: SUBAGENT_PROMPT, subagent_type: "general-purpose" }),
      { subagent: later(8_000, message("SUBAGENT REPORT", "end_turn", "msg_probe_subagent")) }) },
  subagent_and_background_command: { stub: "HTTP 200: a Task call and a Bash call that runs in the background, in one message, then the turn's answer, then an answer to each task's notice. The sub-agent's own request is answered after three seconds. The command ends seven seconds after it starts.",
    cli: { tool: "Task,Bash", lingerMs: 12_000 },
    answer: turnWithBackgroundWork(toolCalls([["Task", { description: "review probe", prompt: SUBAGENT_PROMPT, subagent_type: "general-purpose" }], backgroundCommand("sleep 7; echo BACKGROUND_DONE", "server probe")]),
      { notices: [message("ANSWER TO THE FIRST TASK NOTICE", "end_turn", "msg_probe_first_notice_answer"), message("ANSWER TO THE SECOND TASK NOTICE", "end_turn", "msg_probe_second_notice_answer")],
        subagent: later(3_000, message("SUBAGENT REPORT", "end_turn", "msg_probe_subagent")) }) },
  interrupt_during_task_notice_answer_then_prompt: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer. The command ends two seconds after it starts. The answer to the task's notice would come only after eight seconds; one and a half seconds after the task's notification the CLI is sent an interrupt control request and, with it, a second prompt (SECOND_TURN_ID), which is answered at once.",
    cli: { tool: "Bash", lingerMs: 9_000, alsoWrites: { when: "task_notification", afterMs: 1_500, lines: (ids) => [interruptRequest(), secondPrompt(ids)] } },
    answer: afterTheTurn(toolCall(...backgroundCommand("sleep 2; echo BACKGROUND_DONE")),
      () => later(8_000, message("ANSWER TO THE TASK NOTICE", "end_turn", "msg_probe_notice_answer"))) },
  approval_in_task_notice_answer_interrupted: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer. The command ends two seconds after it starts. The task's notice is answered with a Bash call that needs the owner's approval. Nobody answers the permission request; one and a half seconds after it the CLI is sent an interrupt control request and, with it, a second prompt (SECOND_TURN_ID), which is answered at once.",
    cli: { tool: "Bash", askForApproval: true, lingerMs: 11_000, alsoWrites: [allowsTheBackgroundCommand,
      { when: "control_request", match: asksForTheNoticeCommand, afterMs: 1_500, lines: (ids) => [interruptRequest(), secondPrompt(ids)] }] },
    answer: afterTheTurn(toolCall(...backgroundCommand("sleep 2; echo BACKGROUND_DONE")), noticeAnsweredWithACommand()) },
  approval_in_task_notice_answer_denied_and_interrupted: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer. The command ends two seconds after it starts. The task's notice is answered with a Bash call that needs the owner's approval. One and a half seconds after the permission request the CLI is sent a denial of it, an interrupt control request and a second prompt (SECOND_TURN_ID), which is answered at once.",
    cli: { tool: "Bash", askForApproval: true, lingerMs: 11_000, alsoWrites: [allowsTheBackgroundCommand,
      { when: "control_request", match: asksForTheNoticeCommand, afterMs: 1_500,
        lines: (ids, event) => [permissionResponse(event, { behavior: "deny", message: "The recorder denied this action." }), interruptRequest(), secondPrompt(ids)] }] },
    answer: afterTheTurn(toolCall(...backgroundCommand("sleep 2; echo BACKGROUND_DONE")), noticeAnsweredWithACommand()) },
  subagent_running_at_interrupt: { stub: "HTTP 200: a Task call, then the turn's answer, then an answer to the task's notice. The sub-agent's own request would be answered only after eight seconds. One second after the turn's result, with no turn running, the CLI is sent an interrupt control request.",
    cli: { tool: "Task", lingerMs: 13_000, alsoWrites: { when: "result", afterMs: 1_000, line: interruptRequest } },
    answer: turnWithBackgroundWork(toolCall("Task", { description: "probe", prompt: SUBAGENT_PROMPT, subagent_type: "general-purpose" }),
      { subagent: later(8_000, message("SUBAGENT REPORT", "end_turn", "msg_probe_subagent")) }) },
  task_ends_while_turn_goes_on: { stub: "HTTP 200: a Bash call that runs in the background, then a Bash call that does not, then the turn's answer. A later request would get an answer to the task's notice. The background command ends one second after it starts, while the other command, of three seconds, still runs. The turn's answer says so when the request for it holds the task's notice.",
    cli: { tool: "Bash", lingerMs: 8_000 },
    answer: (() => {
      let requests = 0;
      return (wantsStream, response, request, holds) => {
        requests += 1;
        (requests === 1 ? toolCall(...backgroundCommand("sleep 1; echo BACKGROUND_DONE"))
          : requests === 2 ? toolCalls([["Bash", { command: "sleep 3; echo FOREGROUND_DONE", description: "foreground probe" }]])
            : requests === 3 ? message(holds.taskNotice ? "ANSWER OF THE TURN, TO A REQUEST THAT HOLDS THE TASK NOTICE" : "ANSWER OF THE TURN", "end_turn", "msg_probe_answer")
              : message("ANSWER TO THE TASK NOTICE", "end_turn", "msg_probe_notice_answer"))(wantsStream, response, request);
      };
    })() },
  task_ends_while_notice_is_answered: { stub: "HTTP 200: two Bash calls in one message that run in the background, then the turn's answer. One command ends one second after it starts and the other four. The first notice is answered with a Bash call of five seconds that does not run in the background, so the second command ends while the first notice is being answered. Each later answer says how many task notices its request holds.",
    cli: { tool: "Bash", lingerMs: 14_000 },
    answer: (() => {
      let requests = 0;
      return (wantsStream, response, request, holds) => {
        requests += 1;
        (requests === 1 ? toolCalls([backgroundCommand("sleep 1; echo FIRST_DONE", "first probe"), backgroundCommand("sleep 4; echo SECOND_DONE", "second probe")])
          : requests === 2 ? message("ANSWER OF THE TURN", "end_turn", "msg_probe_answer")
            : requests === 3 ? toolCalls([["Bash", { command: "sleep 5; echo FOREGROUND_DONE", description: "foreground probe" }]])
              : message(`ANSWER NUMBER ${requests - 3} AFTER THE TURN, TO A REQUEST THAT HOLDS ${holds.taskNotices} TASK NOTICES`, "end_turn", `msg_probe_notice_answer_${requests - 3}`))(wantsStream, response, request);
      };
    })() },
  task_ends_during_next_turn: { stub: "HTTP 200: a Bash call that runs in the background, then the turn's answer. The command ends four seconds after it starts. Half a second after the turn's result the CLI is sent a second prompt (SECOND_TURN_ID), whose answer comes only after seven seconds. Then an answer to the task's notice.",
    cli: { tool: "Bash", lingerMs: 16_000, alsoWrites: { when: "result", afterMs: 500, line: secondPrompt } },
    answer: turnWithBackgroundWork(toolCall(...backgroundCommand("sleep 4; echo BACKGROUND_DONE")),
      { secondTurn: later(7_000, message("ANSWER OF THE SECOND TURN", "end_turn", "msg_probe_second_answer")) }) },
};

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

/**
 * The stand-in for the Messages API. It listens on 127.0.0.1 only. A request
 * body is drained chunk by chunk and never kept. Five yes/no facts and one
 * count are read from it as it passes, through a window of a few dozen
 * characters: whether it asks for a streamed answer, whether it holds a
 * tool's result, whether it holds the prompt this tool gives a sub-agent or
 * the one it gives a second sub-agent, whether it holds this tool's second
 * prompt, and how many notices of background tasks it holds. No header is
 * read at all.
 */
function startStandIn(answer, counts) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    let wantsStream = false;
    const holds = { toolResult: false, subagentPrompt: false, secondSubagentPrompt: false, taskNotice: false, taskNotices: 0, secondPrompt: false, nth: 0 };
    let tail = "";
    request.on("data", (chunk) => {
      const window = tail + chunk.toString("latin1");
      if (/"stream"\s*:\s*true/.test(window)) wantsStream = true;
      if (/"type"\s*:\s*"tool_result"/.test(window)) holds.toolResult = true;
      if (window.includes(SUBAGENT_PROMPT.split(":")[0])) holds.subagentPrompt = true;
      if (window.includes(SECOND_SUBAGENT_PROMPT.split(":")[0])) holds.secondSubagentPrompt = true;
      if (window.includes(SECOND_PROMPT.split(" ").at(-1))) holds.secondPrompt = true;
      // As the CLI writes the notice in a message. Its tool descriptions name the tag too, without what follows it here.
      // A notice that ends in this chunk is counted now; one that lies in the kept tail was counted before.
      for (const notice of window.matchAll(/<task-notification>\\n<task-id>/g)) if (notice.index + notice[0].length > tail.length) holds.taskNotices += 1;
      holds.taskNotice = holds.taskNotices > 0;
      tail = window.slice(-48);
    });
    request.on("end", () => {
      tail = "";
      const key = `${request.method} ${path}`;
      counts[key] = (counts[key] ?? 0) + 1;
      holds.nth = counts[key];
      if (request.method === "POST" && path === "/v1/messages") { answer(wantsStream, response, request, holds); return; }
      response.writeHead(404, { "content-type": "application/json", "request-id": "req_probe" });
      response.end(errorBody("not_found_error", "stand-in: unknown path"));
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => done({
      port: server.address().port,
      close: () => new Promise((closed) => { for (const socket of sockets) socket.destroy(); server.close(() => closed()); }),
    }));
  });
}

/**
 * A loopback port with no listener, for the connection that is refused. It is
 * a port that was found free a moment ago, and nothing holds it during the
 * run: on macOS a port that is held without a listener does not refuse a
 * connection, it lets it time out, and that is another failure than the one
 * this run records. So another local process could take the port while the
 * CLI retries, and would then be sent the CLI's request: the dummy key and
 * the probe prompt, and nothing of the owner's. `refusedNothingElse` checks
 * afterwards that this did not happen.
 */
function unlistenedPort() {
  return new Promise((done) => {
    const probe = createTcpServer();
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
  });
}

/** Whether every attempt of a run that was to be refused got no answer at all, and the run ended as a refused connection. */
function refusedNothingElse(capture) {
  const events = capture.lines.map((line) => line.event);
  const result = events.find((event) => event.type === "result");
  return events.every((event) => event.type !== "system" || event.subtype !== "api_retry" || event.error_status === null)
    && (!result || (result.is_error === true && result.api_error_status === null && /refused/i.test(String(result.result))));
}

/** Refuse to go on unless the sandbox profile denies a connection that leaves this machine and allows one that does not. */
async function proveSandbox(profilePath) {
  const connect = (host, port) => spawnSync(SANDBOX_EXEC, ["-f", profilePath, process.execPath, "-e",
    `const socket = require("node:net").connect({ host: ${JSON.stringify(host)}, port: ${port} });
     socket.on("connect", () => { console.log("CONNECTED"); process.exit(0); });
     socket.on("error", (error) => { console.log(error.code); process.exit(0); });
     setTimeout(() => { console.log("NO_ANSWER"); process.exit(0); }, 4000);`], { encoding: "utf8", timeout: 10_000 }).stdout.trim();
  const outside = connect(UNROUTED_ADDRESS, 9);
  if (outside !== "EPERM") throw new Error(`The sandbox did not deny a connection that leaves this machine (${outside || "no output"}). Nothing was started.`);
  const counts = {};
  const local = await startStandIn((_wantsStream, response) => response.end(), counts);
  const inside = connect("127.0.0.1", local.port);
  await local.close();
  if (inside !== "CONNECTED") throw new Error(`The sandbox did not allow a loopback connection (${inside || "no output"}). Nothing was started.`);
}

/** Run the CLI once, as the room adapter launches it, against one stand-in answer. */
async function recordOne(name, claudeBin, root, profilePath, timeoutMs) {
  const runRoot = join(root, name);
  const dirs = { home: join(runRoot, "home"), config: join(runRoot, "config"), work: join(runRoot, "work"), tmp: join(runRoot, "tmp") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const mcpConfigPath = join(runRoot, "mcp.json");
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
  const requests = {};
  const { answer, cli = {} } = STUB_ANSWERS[name];
  if (cli.stopHook) {
    // The hook refuses the end of the turn once, with words for the model, and allows it from then on.
    const hookPath = join(runRoot, "stop-hook.sh");
    const ranOnce = join(dirs.tmp, "stop-hook-ran");
    writeFileSync(hookPath, `#!/bin/sh\nif [ -e "${ranOnce}" ]; then exit 0; fi\ntouch "${ranOnce}"\necho STOP_HOOK_SAYS_GO_ON 1>&2\nexit 2\n`);
    chmodSync(hookPath, 0o755);
    writeFileSync(join(dirs.config, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: hookPath }] }] } }));
  }
  const standIn = answer ? await startStandIn(answer, requests) : null;
  const port = standIn ? standIn.port : await unlistenedPort();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const secondTurnId = randomUUID();
  // The flags of claudeCliLaunchArgs() with the read-only profile's policy. A run that has the model call a
  // tool adds that tool, and the run with the Stop hook reads the settings file of its new CLAUDE_CONFIG_DIR.
  const args = ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--strict-mcp-config", "--mcp-config", mcpConfigPath,
    // An agent that asks before it writes: its permission requests go to stdout, and its tool is not allowed beforehand.
    ...(cli.askForApproval ? ["--permission-prompt-tool", "stdio", "--permission-mode", "default"] : ["--permission-mode", "dontAsk"]),
    "--tools", ["Read,Glob,Grep", cli.tool].filter(Boolean).join(","),
    "--allowed-tools", ["mcp__letagents__*", cli.askForApproval ? null : cli.tool].filter(Boolean).join(","), "--setting-sources", cli.stopHook ? "user" : "", "--session-id", sessionId];
  // Nothing of this process's environment reaches the CLI.
  const env = {
    PATH: [dirname(claudeBin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    HOME: dirs.home, TMPDIR: dirs.tmp, CLAUDE_CODE_TMPDIR: dirs.tmp, CLAUDE_CONFIG_DIR: dirs.config,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "probe-dummy-key",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
  };
  const started = performance.now();
  const child = spawn(SANDBOX_EXEC, ["-f", profilePath, claudeBin, ...args], { cwd: dirs.work, env, stdio: ["pipe", "pipe", "ignore"], detached: true });
  const lines = [];
  let buffered = "";
  let outcome = "running";
  let resultSeen = false;
  const alsoWrites = [cli.alsoWrites ?? []].flat();
  const alsoWritten = new Set();
  /** The id the CLI gave the task it started last. */
  let taskId = null;
  let inputClosedAt = null;
  let stoppedByTool = false;
  const finish = (why) => {
    if (outcome !== "running") return;
    outcome = why;
    inputClosedAt = performance.now();
    try { child.stdin.end(); } catch { /* The pipe is already gone. */ }
    setTimeout(() => { stoppedByTool = true; try { process.kill(-child.pid, "SIGTERM"); } catch { /* It has exited. */ } }, cli.closeWaitMs ?? 3_000).unref();
  };
  child.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let event = null;
      try { event = JSON.parse(line); } catch { /* Not a stream-json line. */ }
      if (!event || typeof event !== "object") continue;
      lines.push({ atMs: Math.round(performance.now() - started), event });
      // The lifecycle event that follows the result is part of the turn. Some runs wait for what the CLI writes after it.
      if (event.type === "result" && !resultSeen) { resultSeen = true; setTimeout(() => finish("result"), cli.lingerMs ?? 500); }
      const kind = event.type === "system" ? event.subtype : event.type;
      if (kind === "task_started" && typeof event.task_id === "string") taskId = event.task_id;
      for (const rule of alsoWrites) {
        if (kind !== rule.when || (alsoWritten.has(rule) && !rule.every) || (rule.match && !rule.match(event))) continue;
        alsoWritten.add(rule);
        setTimeout(() => {
          const ids = { secondTurnId, taskId };
          try {
            for (const written of rule.lines ? rule.lines(ids, event) : [rule.line(ids, event)]) child.stdin.write(`${JSON.stringify(written)}\n`);
          } catch { /* The pipe is already gone. */ }
        }, rule.afterMs);
      }
    }
  });
  const timer = setTimeout(() => finish("timeout"), timeoutMs);
  child.stdin.write(`${JSON.stringify({ type: "user", uuid: turnId, message: { role: "user", content: [{ type: "text", text: "Reply exactly PROBE_OK." }] } })}\n`);
  const [exitCode, exitSignal] = await new Promise((exited) => child.once("exit", (code, signal) => exited([code, signal])));
  // How the CLI ended once its stdin was closed: by itself, or stopped by this tool when its time was up.
  const afterInputClosed = inputClosedAt === null ? null
    : { ended: stoppedByTool ? "stopped by the recorder" : "by itself", code: exitCode, signal: exitSignal, seconds: Math.round((performance.now() - inputClosedAt) / 100) / 10 };
  clearTimeout(timer);
  await standIn?.close();
  const projects = join(dirs.config, "projects");
  const transcript = existsSync(projects)
    ? readdirSync(projects, { recursive: true }).map(String).find((entry) => entry.endsWith(`${sessionId}.jsonl`)) : undefined;
  const rowsOf = (entry) => readFileSync(join(projects, entry), "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row));
  const sessionRows = transcript ? rowsOf(transcript) : [];
  // Claude Code keeps the rows of a sub-agent in a file of their own, beside the session's file.
  const subagentRows = existsSync(projects) ? readdirSync(projects, { recursive: true }).map(String).sort()
    .filter((entry) => entry.split(/[\\/]/).includes(sessionId) && entry.split(/[\\/]/).includes("subagents") && entry.endsWith(".jsonl")).flatMap(rowsOf) : [];
  return { name, outcome, sessionId, turnId, secondTurnId, runRoot, requests, lines, sessionRows, subagentRows, afterInputClosed };
}

/** Token and cost accounting. It is large, and nothing that reads a result uses it. */
const ACCOUNTING = new Set(["usage", "modelUsage", "subagent_stats"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A text longer than this is cut short: a skill's text is long, and it is not what a test reads. */
const LONG_TEXT = 2_000;

/** Every path in a run's own folder, as it stands in a text. On macOS the same folder has a name with and without `/private`. */
function pathsOf(runRoot) {
  if (!runRoot) return null;
  const escaped = runRoot.replace(/^\/private/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:/private)?${escaped}[^\\s"'<>\\]\\\\]*`, "g");
}

function redact(value, ids) {
  if (typeof value === "string") {
    const text = (ids.paths ? value.replace(ids.paths, "/PATH") : value)
      .replaceAll(ids.sessionId, "SESSION_ID").replaceAll(ids.turnId, "TURN_ID").replaceAll(ids.secondTurnId ?? "SECOND_TURN_ID", "SECOND_TURN_ID").replace(UUID, "UUID")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "2026-01-01T00:00:00.000Z");
    return text.length > LONG_TEXT ? `${text.slice(0, 120)} [${text.length - 120} more characters left out]` : text;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, ids));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ACCOUNTING.has(key))
    .map(([key, entry]) => [key, key === "cwd" ? "/workspace" : key === "request_sent_wall_ms" || key === "end_time" ? 0 : redact(entry, ids)]));
}

/** One capture as the fixture holds it, or null when the CLI wrote no result in the time it was given. */
function fixtureCapture(capture) {
  const result = capture.lines.find((line) => line.event.type === "result");
  if (!result) return null;
  const ids = { sessionId: capture.sessionId, turnId: capture.turnId, secondTurnId: capture.secondTurnId, paths: pathsOf(capture.runRoot) };
  const chat = (rows) => rows.filter((row) => row.type === "user" || row.type === "assistant").map((row) => redact(row, ids));
  return {
    stub: STUB_ANSWERS[capture.name].stub,
    seconds_to_result: Math.round(result.atMs / 100) / 10,
    // Every line the CLI wrote to stdout for the turn, in order, but for the
    // `system/init` line: that one describes the machine, and a test's own
    // launch supplies it.
    stream: capture.lines.map((line) => line.event).filter((event) => !(event.type === "system" && event.subtype === "init"))
      .map((event) => redact(event, ids)),
    // The user and assistant rows of the session file, in order. They go on after the turn when the CLI did.
    session: chat(capture.sessionRows),
    // The same rows of the file that holds a sub-agent's.
    ...(capture.subagentRows?.length ? { subagent_session: chat(capture.subagentRows) } : {}),
    // Only for a run that asks how the CLI ends once its stdin is closed.
    ...(STUB_ANSWERS[capture.name].cli?.closeWaitMs && capture.afterInputClosed ? { after_input_closed: capture.afterInputClosed } : {}),
  };
}

function fixtureText(captures, version) {
  const line = (value) => JSON.stringify(value);
  const rows = (events) => events.length ? `[\n${events.map((event) => `        ${line(event)}`).join(",\n")}\n      ]` : "[]";
  const about = `Real stream-json output of Claude Code ${version}, launched with the room adapter's flags against a local stand-in for the Messages API. Recorded with electron/scripts/record-claude-result-shapes.mjs. Ids, times, paths and the stand-in's port are replaced, and the token accounting (usage, modelUsage, subagent_stats) is left out. SESSION_ID and TURN_ID stand for the session and for the user message that started the turn. In the captures from stop_hook_refuses_end_once on, the stand-in answers with a tool call or the CLI has a Stop hook: one more tool is allowed, a text of more than 2000 characters is cut short, the stream and the session go on after the turn when the CLI did, and 'subagent_session' holds the rows of the separate file in which the CLI keeps a sub-agent's. In the captures from two_background_commands on, a turn starts background work in more ways: 'stub' says what the recorder also wrote to the CLI's stdin (an interrupt control request, its answer to a permission request, or a second prompt, whose user message is SECOND_TURN_ID), and 'after_input_closed' says how the CLI ended once its stdin was closed. In the two captures named approval_…, the CLI was started as an agent that asks before it writes.`;
  const body = Object.entries(captures).map(([name, capture]) => [
    `    ${line(name)}: {`,
    `      "stub": ${line(capture.stub)},`,
    `      "seconds_to_result": ${capture.seconds_to_result},`,
    `      "stream": ${rows(capture.stream)},`,
    `      "session": ${rows(capture.session)}${capture.subagent_session || capture.after_input_closed ? "," : ""}`,
    ...(capture.subagent_session ? [`      "subagent_session": ${rows(capture.subagent_session)}${capture.after_input_closed ? "," : ""}`] : []),
    ...(capture.after_input_closed ? [`      "after_input_closed": ${line(capture.after_input_closed)}`] : []),
    "    }",
  ].join("\n")).join(",\n");
  return `{\n  "about": ${line(about)},\n  "claude_code_version": ${line(version)},\n  "captures": {\n${body}\n  }\n}\n`;
}

/** What must never be in a fixture: who recorded it, where, and any id of a real run. */
function leaks(text, extra = []) {
  const user = userInfo().username;
  // The directory that holds every home directory covers a path of any user of this machine.
  const needles = [user, hostname(), hostname().split(".")[0], homedir(), `${dirname(homedir())}/`, realpathSync(tmpdir()), tmpdir(), "/private/", ...extra]
    .filter((needle) => typeof needle === "string" && needle.length > 2);
  const found = needles.filter((needle) => text.toLowerCase().includes(needle.toLowerCase()));
  if (UUID.test(text)) found.push("a UUID");
  UUID.lastIndex = 0;
  return [...new Set(found)];
}

async function main() {
  if (process.env[RECORD_ENV] !== "1") {
    throw new Error(`This tool starts the Claude Code CLI. Set ${RECORD_ENV}=1 to run it deliberately.`);
  }
  if (process.env.CI) throw new Error("This tool is not for CI.");
  const only = option("--only")?.split(",").map((name) => name.trim()).filter(Boolean) ?? null;
  for (const name of only ?? []) if (!STUB_ANSWERS[name]) throw new Error(`Unknown stand-in answer '${name}'. Known: ${Object.keys(STUB_ANSWERS).join(", ")}.`);
  const names = only ?? Object.keys(STUB_ANSWERS).filter((name) => !STUB_ANSWERS[name].optional);
  const out = resolve(option("--out") ?? DEFAULT_FIXTURE);
  const keepRaw = process.argv.includes("--raw");
  const merge = process.argv.includes("--merge");
  const fromRaw = option("--from-raw") ? resolve(option("--from-raw")) : null;
  const timeoutMs = Number(option("--timeout-ms") ?? 240_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number.");

  const raw = [];
  if (fromRaw) {
    for (const name of names) {
      const path = join(fromRaw, name, "capture.json");
      if (existsSync(path)) raw.push({ ...JSON.parse(readFileSync(path, "utf8")), name });
      else console.error(`${name}: no kept run in ${fromRaw}`);
    }
  } else {
    if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
      throw new Error("This tool keeps the CLI off the network with the macOS sandbox, so it runs on macOS only.");
    }
    const located = process.env.LETAGENTS_CLAUDE_CODE_BIN || process.env.LETAGENTS_CLAUDE_BIN
      || spawnSync("/usr/bin/which", ["claude"], { encoding: "utf8" }).stdout.trim();
    if (!located || !existsSync(located)) throw new Error("The Claude Code CLI was not found. Set LETAGENTS_CLAUDE_CODE_BIN to its path.");
    const claudeBin = realpathSync(located);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "letagents-claude-result-shapes-")));
    try {
      const profilePath = join(root, "loopback-only.sb");
      writeFileSync(profilePath, SANDBOX_PROFILE);
      await proveSandbox(profilePath);
      // Each run is its own process, stand-in and directories, so they do not have to wait for each other.
      raw.push(...await Promise.all(names.map((name) => recordOne(name, claudeBin, root, profilePath, timeoutMs))));
      for (const capture of raw) {
        if (!STUB_ANSWERS[capture.name].answer && !refusedNothingElse(capture)) {
          throw new Error(`${capture.name}: something answered on the port that was to refuse the connection. Another local process took that port, and was sent the dummy key and the probe prompt. Nothing was written.`);
        }
        const other = Object.keys(capture.requests).filter((key) => key !== "POST /v1/messages" && key !== "HEAD /api/hello");
        console.error(`${capture.name}: ${capture.outcome}; requests ${JSON.stringify(capture.requests)}${other.length ? " (unexpected paths)" : ""}`);
      }
      if (keepRaw) {
        // A new folder outside every repository: a kept run cannot land beside files that are committed.
        const rawDir = mkdtempSync(join(tmpdir(), "letagents-claude-result-shapes-raw-"));
        for (const capture of raw) {
          mkdirSync(join(rawDir, capture.name));
          writeFileSync(join(rawDir, capture.name, "capture.json"), JSON.stringify(capture, null, 2));
        }
        console.error(`kept the runs UNREDACTED in ${rawDir}. They hold this machine's ids and paths: do not commit them.`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // With --merge the captures that the file already holds stay as they are, in their order.
  const held = merge && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  const captures = { ...held?.captures };
  for (const capture of raw) {
    const built = fixtureCapture(capture);
    if (built) captures[capture.name] = built;
    else console.error(`${capture.name}: left out, the CLI wrote no result`);
  }
  if (!Object.keys(captures).length) throw new Error("No run ended with a result. Nothing was written.");
  const versions = [...new Set(raw.flatMap((capture) => capture.sessionRows.map((row) => row.version)).filter((version) => typeof version === "string"))];
  if (versions.length !== 1) throw new Error(`The runs do not name one Claude Code version (${versions.join(", ") || "none"}). Nothing was written.`);
  if (held && held.claude_code_version !== versions[0]) {
    throw new Error(`The file holds captures of Claude Code ${held.claude_code_version}, and these runs are of ${versions[0]}. Nothing was written.`);
  }
  const text = fixtureText(captures, versions[0]);
  JSON.parse(text);
  // A run's folder is also checked in the form the CLI gives it in the name of a project folder.
  const found = leaks(text, raw.flatMap((capture) => [capture.sessionId, capture.turnId, capture.secondTurnId, capture.runRoot, capture.runRoot?.replace(/[^A-Za-z0-9]/g, "-")]));
  if (found.length) throw new Error(`The fixture still holds ${found.join(", ")}. Nothing was written.`);
  writeFileSync(out, text);
  console.error(`wrote ${Object.keys(captures).length} captures of Claude Code ${versions[0]} to ${out}${held ? ` (${raw.length} of them from this run)` : ""}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
