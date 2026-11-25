// A stand-in for the Antigravity CLI (`agy`) in the daemon edge tests. The
// daemon starts it in place of agy (LETAGENTS_ANTIGRAVITY_BIN) as `agy acp`,
// and it plays a recorded transcript over stdin and stdout, the transport of
// the real one: ACP, JSON-RPC 2.0 with one message per line.
//
// It is plain Node with no imports from the repository. The format of a
// transcript is the provider replay format (docs/provider-replay-tests.md),
// with the protocol `antigravity.acp/stdio`: `expect_outbound` is a message
// the daemon writes to stdin, `emit_inbound` is a message agy wrote to stdout.
//
// ACP is not a fixed sequence of lines, so the replay is not one either:
//
//   - The daemon numbers its own requests. A recorded request is matched by
//     its method, and the recorded answer goes out with the daemon's id.
//   - The daemon checks that agy answers with `letagents/probe`, at times of
//     its own. agy has no such method and answers -32601 at once. The stand-in
//     does the same for every probe, wherever it comes; the fixture keeps the
//     first probe only, to show the recorded answer.
//   - agy asks the daemon for permission with `session/request_permission` and
//     waits. The recorded answer continues the recording. Another answer
//     continues with the plan file `branch-<label>-<optionId>.ndjson`, the
//     rest of the turn for that answer, and then with the recording after the
//     end of the turn. A branch file names in its header whether it is
//     recorded or derived from recorded frames.
//
// The plan folder (LETAGENTS_EDGE_AGY_REPLAY_DIR) holds:
//
//   launch-1.ndjson, launch-2.ndjson, ...   the transcript for each start, in order
//   branch-<label>-<optionId>.ndjson        optional: the turn after another answer
//   hold-<label>                            a test makes this file to stop the replay
//                                           before the inbound entry with that label,
//                                           and removes it to go on
//
// and the stand-in writes, for the Nth start, a folder `claim-N` with:
//
//   launch.json      argv, cwd and pid of this start
//   outbound.ndjson  every line the daemon wrote, as it wrote it
//   emitted.ndjson   the label of every inbound entry, when it has been written
//   answers.ndjson   each permission answer the daemon gave, and the path it took
//   reached-<label>  the replay stopped at that hold
//   exit.json        how the replay ended
//   error.txt        the daemon sent a message the recording does not have
//
// Ids differ in each run, so a transcript names them: `<session>` is the ACP
// session id and `<workspace>` the session's cwd. A start that makes a new
// session mints its id; a start that resumes one takes the id the daemon sends.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PLAN_ENV = "LETAGENTS_EDGE_AGY_REPLAY_DIR";
const PROTOCOL = "antigravity.acp/stdio";
const PROBE_METHOD = "letagents/probe";
const HOLD_POLL_MS = 25;
/** The longest a hold lasts. No test holds for more than a few seconds. */
const HOLD_LIMIT_MS = 120_000;
/** Exit code for "the daemon and the recording disagree". agy does not use it. */
const MISMATCH_EXIT_CODE = 70;

const argv = process.argv.slice(2);
const planDir = process.env[PLAN_ENV];
if (!planDir) {
  process.stderr.write(`agy replay: ${PLAN_ENV} is not set\n`);
  process.exit(MISMATCH_EXIT_CODE);
}

function readTranscript(path) {
  const entries = readFileSync(path, "utf8").split("\n").filter((line) => line.trim())
    .map((line, at) => ({ ...JSON.parse(line), line: at + 1 }));
  const start = entries.shift();
  if (start?.type !== "transcript_start" || start.protocol !== PROTOCOL) {
    throw new Error(`${path}: not a ${PROTOCOL} transcript`);
  }
  if (entries.at(-1)?.type !== "runtime_exit") throw new Error(`${path}: the transcript must end with runtime_exit`);
  return { path, start, entries };
}

if (argv.includes("--version")) {
  // `agy --version` prints a bare version and starts no session.
  process.stdout.write(`${readTranscript(join(planDir, "launch-1.ndjson")).start.providerVersion}\n`);
  process.exit(0);
}

/** Take the next start number. `mkdir` fails for all but one of two racing starts. */
function claimLaunch() {
  for (let index = 1; ; index += 1) {
    try {
      mkdirSync(join(planDir, `claim-${index}`));
      return index;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

const launchIndex = claimLaunch();
const claimDir = join(planDir, `claim-${launchIndex}`);
const claimLog = (file, entry) => appendFileSync(join(claimDir, file), `${JSON.stringify(entry)}\n`);

let ended = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  // A stop from the daemon ends the replay at once, by that signal, as it ends agy.
  // The handlers are in place before `launch.json` shows a test that this start is up.
  process.on(signal, () => end("signalled", { code: null, signal }));
}
writeFileSync(join(claimDir, "launch.json"), `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }, null, 2)}\n`);

function end(outcome, exit) {
  if (ended) return;
  ended = true;
  writeFileSync(join(claimDir, "exit.json"), `${JSON.stringify({ outcome, ...exit })}\n`);
  if (exit.signal && process.platform !== "win32") {
    process.removeAllListeners(exit.signal);
    process.kill(process.pid, exit.signal);
    return;
  }
  process.exitCode = exit.code ?? 1;
  // Let stdout drain: the daemon must get every message that was emitted.
  process.stdout.write("", () => process.exit());
}

function fail(detail) {
  writeFileSync(join(claimDir, "error.txt"), `${detail}\n`);
  process.stderr.write(`agy replay: ${detail}\n`);
  end("mismatch", { code: MISMATCH_EXIT_CODE, signal: null });
}

let transcript;
try {
  transcript = readTranscript(join(planDir, `launch-${launchIndex}.ndjson`));
} catch (error) {
  fail(`start ${launchIndex} has no usable transcript: ${error instanceof Error ? error.message : String(error)}`);
}

const bindings = new Map();
/** Recorded id of a daemon request -> the id the daemon used this time. */
const requestIds = new Map();

/** Put this run's values into a recorded frame. A value is written as JSON text, so a Windows path stays valid. */
function fill(frame) {
  let text = JSON.stringify(frame);
  for (const [name, value] of bindings) text = text.split(name).join(JSON.stringify(value).slice(1, -1));
  return text;
}

const recordedProbeAnswer = transcript?.entries.find((entry) => entry.label === "probe-answer")?.frame
  ?? { jsonrpc: "2.0", error: { code: -32601, message: `Method not found: ${PROBE_METHOD}` } };

const queue = [];
let stdinEnded = false;
let wake = () => undefined;
const nextEvent = () => new Promise((resolve) => { wake = resolve; });

// The reader of stdout is gone: the daemon died. agy ends then, and so does the replay.
process.stdout.on("error", () => end("stdout_closed", { code: 1, signal: null }));

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  appendFileSync(join(claimDir, "outbound.ndjson"), `${line}\n`);
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(`the daemon wrote a line that is not JSON: ${line.slice(0, 200)}`);
    return;
  }
  if (message?.method === PROBE_METHOD && message.id !== undefined) {
    // Answered at once, wherever the replay stands, as agy answers it.
    if (!ended) process.stdout.write(`${JSON.stringify({ ...recordedProbeAnswer, id: message.id })}\n`);
    return;
  }
  queue.push(message);
  wake();
});
lines.on("close", () => {
  stdinEnded = true;
  wake();
});

async function holdBefore(label) {
  if (!label || !existsSync(join(planDir, `hold-${label}`))) return;
  writeFileSync(join(claimDir, `reached-${label}`), "");
  // A test that died leaves its hold in place. The stand-in must not wait for it for ever.
  const deadline = Date.now() + HOLD_LIMIT_MS;
  while (existsSync(join(planDir, `hold-${label}`))) {
    if (Date.now() > deadline) return end("hold_expired", { code: MISMATCH_EXIT_CODE, signal: null, label });
    await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
  }
}

/** The next message of the daemon, or null when it closed stdin. */
async function nextMessage() {
  while (!queue.length && !stdinEnded && !ended) await nextEvent();
  return queue.length ? queue.shift() : null;
}

const isResponse = (frame) => frame && frame.method === undefined && (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"));

/** Bind or check the values a daemon request carries, against the recorded one. */
function checkRequest(entry, actual) {
  const expected = entry.frame;
  const at = `${transcript.path}:${entry.line}`;
  if (actual.method !== expected.method) return `${at}: recorded ${expected.method}, the daemon sent ${actual.method ?? "a response"}`;
  if (expected.id !== undefined && actual.id === undefined) return `${at}: recorded a request, the daemon sent a notification`;
  const params = actual.params ?? {};
  if (expected.method === "session/new" || expected.method === "session/resume") {
    if (typeof params.cwd !== "string") return `${at}: ${expected.method} without a cwd`;
    bindings.set("<workspace>", params.cwd);
    if (expected.method === "session/resume") {
      if (typeof params.sessionId !== "string") return `${at}: session/resume without a sessionId`;
      bindings.set("<session>", params.sessionId);
    } else {
      bindings.set("<session>", randomUUID());
    }
    const servers = Array.isArray(params.mcpServers) ? params.mcpServers.map((server) => server?.name) : [];
    const recordedServers = (expected.params?.mcpServers ?? []).map((server) => server?.name);
    if (JSON.stringify(servers) !== JSON.stringify(recordedServers)) {
      return `${at}: recorded MCP servers ${JSON.stringify(recordedServers)}, the daemon sent ${JSON.stringify(servers)}`;
    }
  } else if (expected.params?.sessionId === "<session>" && params.sessionId !== bindings.get("<session>")) {
    return `${at}: ${expected.method} for session ${params.sessionId}, not ${bindings.get("<session>")}`;
  }
  for (const key of Object.keys(expected.params ?? {})) {
    if (!Object.hasOwn(params, key)) return `${at}: ${expected.method} without ${key}`;
  }
  if (expected.method === "session/set_mode" && params.modeId !== expected.params.modeId) {
    return `${at}: recorded mode ${expected.params.modeId}, the daemon set ${params.modeId}`;
  }
  if (expected.id !== undefined) requestIds.set(String(expected.id), actual.id);
  return null;
}

/**
 * The entries after a permission answer the recording does not have: the
 * branch for that answer, then the recording after the end of the turn.
 */
function branchFor(entries, at, label, optionId) {
  const path = join(planDir, `branch-${label}-${optionId}.ndjson`);
  if (!existsSync(path)) return null;
  const branch = readTranscript(path);
  // The end of the turn: the answer to the prompt that was asked last before this permission.
  const promptAt = entries.slice(0, at).findLastIndex((entry) => entry.type === "expect_outbound" && entry.frame.method === "session/prompt");
  const promptId = promptAt >= 0 ? String(entries[promptAt].frame.id) : null;
  const turnEnd = entries.findIndex((entry, index) => index > at && entry.type === "emit_inbound"
    && isResponse(entry.frame) && String(entry.frame.id) === promptId);
  if (turnEnd < 0) return null;
  const played = branch.entries.filter((entry) => entry.type !== "runtime_exit")
    .map((entry) => ({ ...entry, source: branch.path }));
  return { entries: [...played, ...entries.slice(turnEnd + 1)], description: branch.start.capture?.description ?? "" };
}

async function play() {
  let entries = transcript.entries.map((entry) => ({ ...entry, source: transcript.path }));
  for (let at = 0; at < entries.length; at += 1) {
    if (ended) return;
    const entry = entries[at];
    const where = `${entry.source}:${entry.line}`;
    if (entry.type === "emit_inbound") {
      if (entry.label === "probe-answer") continue;
      await holdBefore(entry.label);
      if (ended) return;
      let frame = entry.frame;
      if (isResponse(frame)) {
        const id = requestIds.get(String(frame.id));
        if (id === undefined) return fail(`${where}: an answer to request ${frame.id}, which the daemon never sent`);
        frame = { ...frame, id };
      }
      process.stdout.write(`${fill(frame)}\n`);
      claimLog("emitted.ndjson", { label: entry.label ?? null, line: entry.line, source: entry.source === transcript.path ? "launch" : "branch" });
      continue;
    }
    if (entry.type === "expect_outbound") {
      if (entry.label === "probe") continue;
      const actual = await nextMessage();
      if (ended) return;
      if (!actual) {
        // The daemon closed stdin with recorded traffic left: a stop. agy then ends by itself.
        return end("stdin_closed_early", { code: 0, signal: null, line: entry.line });
      }
      if (isResponse(entry.frame)) {
        // The daemon's answer to a request of agy: a permission request.
        if (!isResponse(actual) || String(actual.id) !== String(entry.frame.id)) {
          return fail(`${where}: recorded the answer to ${entry.frame.id}, the daemon sent ${JSON.stringify(actual).slice(0, 200)}`);
        }
        const recorded = entry.frame.result?.outcome;
        const given = actual.result?.outcome;
        const same = JSON.stringify(recorded) === JSON.stringify(given);
        if (same) {
          claimLog("answers.ndjson", { label: entry.label ?? null, outcome: given ?? null, path: "recorded" });
          continue;
        }
        const optionId = given?.outcome === "selected" ? given.optionId : given?.outcome ?? "none";
        // A branch file is named for the request: `permission-1`, the answer to it is `permission-1-answer`.
        const branch = branchFor(entries, at, (entry.label ?? "").replace(/-answer$/, ""), optionId);
        if (!branch) {
          claimLog("answers.ndjson", { label: entry.label ?? null, outcome: given ?? null, path: "none" });
          return fail(`${where}: the daemon answered ${JSON.stringify(given)}, and the plan has no branch for it`);
        }
        claimLog("answers.ndjson", { label: entry.label ?? null, outcome: given ?? null, path: "branch", description: branch.description });
        entries = [...entries.slice(0, at + 1), ...branch.entries];
        continue;
      }
      if (isResponse(actual)) return fail(`${where}: recorded ${entry.frame.method}, the daemon sent an answer ${JSON.stringify(actual).slice(0, 200)}`);
      const mismatch = checkRequest(entry, actual);
      if (mismatch) return fail(mismatch);
      continue;
    }
    // runtime_exit, always the last entry.
    if (entry.requested) {
      // The recording has no more traffic. A message that comes now is one agy never got, and it
      // fails at once: a stop signal that follows it must not hide it.
      const extra = await nextMessage();
      if (ended) return;
      if (extra) return fail(`${where}: the daemon wrote a message after the end of the recording: ${JSON.stringify(extra).slice(0, 200)}`);
    }
    return end("played", { code: entry.code, signal: entry.signal });
  }
}

if (transcript) {
  play().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
}
