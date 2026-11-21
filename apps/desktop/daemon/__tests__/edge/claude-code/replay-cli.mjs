// A stand-in for the `claude` program in the daemon edge tests. The daemon
// starts it in place of Claude Code (LETAGENTS_CLAUDE_CODE_BIN), and it plays
// a recorded transcript over stdin and stdout, the transport of the real one.
//
// It is plain Node with no imports from the repository, so a daemon in any
// language can run under the same tests. The format of a transcript is the
// provider replay format (docs/provider-replay-tests.md), with the protocol
// `claude-code.cli/stream-json-stdio`: `expect_outbound` is a line the daemon
// writes to stdin, `emit_inbound` is a line Claude Code wrote to stdout.
//
// The plan folder (LETAGENTS_EDGE_CLAUDE_REPLAY_DIR) holds:
//
//   launch-1.ndjson, launch-2.ndjson, ...  the transcript for each start, in order
//   session-1.ndjson, ...                  optional: the rows Claude Code had in
//                                          its own session file when that start
//                                          ended; see "The session file" below
//   hold-<label>                           a test makes this file to stop the
//                                          replay before the inbound entry with
//                                          that label, and removes it to go on
//
// and the stand-in writes, for the Nth start, a folder `claim-N` with:
//
//   launch.json      argv, cwd and pid of this start
//   outbound.ndjson  every line the daemon wrote, as it wrote it
//   reached-<label>  the replay stopped at that hold
//   exit.json        how the replay ended
//   error.txt        the daemon sent a line the recording does not have
//
// Ids differ in each run, so a transcript names them: `<session>` is the id in
// `--session-id` or `--resume`, `<turn-N>` the uuid of a user line, and
// `<control-N>` the request id of a control request, each numbered by a
// recorder in the order the daemon sent them. `<workspace>` is the cwd.

//
// The session file. Claude Code keeps each session in a file of its own,
// `<config>/projects/<cwd, every other character as "-">/<session>.jsonl`. A
// daemon that lost the program during a turn reads the end of the turn from
// that file. So the file is part of what the program shows the daemon, and a
// plan can hold its rows: when the start ends, for any reason, the stand-in
// writes them where Claude Code would.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PLAN_ENV = "LETAGENTS_EDGE_CLAUDE_REPLAY_DIR";
const PROTOCOL = "claude-code.cli/stream-json-stdio";
const HOLD_POLL_MS = 25;
/** Exit code for "the daemon and the recording disagree". No Claude Code exit uses it. */
const MISMATCH_EXIT_CODE = 70;
const BOUND_PLACEHOLDER = /^<(turn|control)-\d+>$/;

const argv = process.argv.slice(2);
const planDir = process.env[PLAN_ENV];
if (!planDir) {
  process.stderr.write(`claude replay: ${PLAN_ENV} is not set\n`);
  process.exit(MISMATCH_EXIT_CODE);
}

function loadTranscript(index) {
  const path = join(planDir, `launch-${index}.ndjson`);
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
  // The version check starts no session, so it takes no transcript of its own.
  process.stdout.write(`${loadTranscript(1).start.providerVersion} (Claude Code)\n`);
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
const optionValue = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const sessionId = optionValue("--resume") ?? optionValue("--session-id");

const bindings = new Map([["<workspace>", process.cwd()]]);
if (sessionId) bindings.set("<session>", sessionId);

let ended = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  // A stop from the daemon ends the replay at once, by that signal, as it ends Claude Code.
  // The handlers are in place before `launch.json` shows a test that this start is up.
  process.on(signal, () => end("signalled", { code: null, signal }));
}
writeFileSync(join(claimDir, "launch.json"), `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, sessionId }, null, 2)}\n`);

/** Leave the session file as Claude Code left it when this start ended. */
function writeSessionFile() {
  const rowsPath = join(planDir, `session-${launchIndex}.ndjson`);
  if (!existsSync(rowsPath) || !sessionId) return;
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(process.env.HOME?.trim() || homedir(), ".claude");
  const projectDir = join(configDir, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const rows = readFileSync(rowsPath, "utf8").split("\n").filter((line) => line.trim())
    .map((line) => fillPlaceholders(JSON.parse(line)));
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${rows.join("\n")}\n`);
}

function end(outcome, exit) {
  if (ended) return;
  ended = true;
  try {
    writeSessionFile();
  } catch (error) {
    writeFileSync(join(claimDir, "session-error.txt"), `${error instanceof Error ? error.stack : String(error)}\n`);
  }
  writeFileSync(join(claimDir, "exit.json"), `${JSON.stringify({ outcome, ...exit })}\n`);
  if (exit.signal && process.platform !== "win32") {
    // End by the recorded signal, so the daemon sees what it saw from Claude Code.
    process.removeAllListeners(exit.signal);
    process.kill(process.pid, exit.signal);
    return;
  }
  process.exitCode = exit.code ?? 1;
  // Let stdout drain: the daemon must get every line that was emitted.
  process.stdout.write("", () => process.exit());
}

function fail(detail) {
  writeFileSync(join(claimDir, "error.txt"), `${detail}\n`);
  process.stderr.write(`claude replay: ${detail}\n`);
  end("mismatch", { code: MISMATCH_EXIT_CODE, signal: null });
}

let transcript;
try {
  transcript = loadTranscript(launchIndex);
} catch (error) {
  fail(`start ${launchIndex} has no usable transcript: ${error instanceof Error ? error.message : String(error)}`);
}

/** Put this run's ids into a recorded frame. A value is written as JSON text, so a Windows path stays valid. */
function fillPlaceholders(frame) {
  let text = JSON.stringify(frame);
  for (const [name, value] of bindings) text = text.split(name).join(JSON.stringify(value).slice(1, -1));
  return text;
}

/**
 * Compare a line the daemon wrote with the recorded one. A placeholder the
 * recording holds takes its value from the line the first time. The text of a
 * user message is our prompt wording, not protocol, so it is not compared.
 */
function matchOutbound(expected, actual, path) {
  if (typeof expected === "string" && (BOUND_PLACEHOLDER.test(expected) || bindings.has(expected))) {
    if (typeof actual !== "string") return `${path}: expected a string for ${expected}`;
    if (!bindings.has(expected)) bindings.set(expected, actual);
    return bindings.get(expected) === actual ? null : `${path}: ${expected} is ${bindings.get(expected)}, the daemon sent ${actual}`;
  }
  if (expected === null || typeof expected !== "object") {
    return Object.is(expected, actual) ? null : `${path}: recorded ${JSON.stringify(expected)}, the daemon sent ${JSON.stringify(actual)}`;
  }
  if (Array.isArray(expected) !== Array.isArray(actual) || actual === null || typeof actual !== "object") {
    return `${path}: recorded ${Array.isArray(expected) ? "an array" : "an object"}, the daemon sent ${JSON.stringify(actual)}`;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    if (path === "frame.message" && key === "content") continue;
    const mismatch = matchOutbound(expected[key], actual[key], `${path}.${key}`);
    if (mismatch) return mismatch;
  }
  return null;
}

const outboundQueue = [];
let stdinEnded = false;
let wake = () => undefined;
const nextEvent = () => new Promise((resolve) => { wake = resolve; });

// The reader of stdout is gone: the daemon died. Claude Code ends then, and so does the replay.
process.stdout.on("error", () => end("stdout_closed", { code: 1, signal: null }));

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  appendFileSync(join(claimDir, "outbound.ndjson"), `${line}\n`);
  outboundQueue.push(line);
  wake();
});
lines.on("close", () => {
  stdinEnded = true;
  wake();
});

async function holdBefore(label) {
  if (!label || !existsSync(join(planDir, `hold-${label}`))) return;
  writeFileSync(join(claimDir, `reached-${label}`), "");
  while (existsSync(join(planDir, `hold-${label}`))) await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
}

async function play() {
  for (const entry of transcript.entries) {
    if (ended) return;
    if (entry.type === "emit_inbound") {
      await holdBefore(entry.label);
      if (ended) return;
      process.stdout.write(`${fillPlaceholders(entry.frame)}\n`);
      continue;
    }
    if (entry.type === "expect_outbound") {
      while (!outboundQueue.length && !stdinEnded) await nextEvent();
      if (ended) return;
      if (!outboundQueue.length) {
        // The daemon closed stdin with recorded traffic left: a stop. Claude Code then ends by itself.
        return end("stdin_closed_early", { code: 0, signal: null, line: entry.line });
      }
      let actual;
      const raw = outboundQueue.shift();
      try {
        actual = JSON.parse(raw);
      } catch {
        return fail(`${transcript.path}:${entry.line}: the daemon wrote a line that is not JSON: ${raw.slice(0, 200)}`);
      }
      const mismatch = matchOutbound(entry.frame, actual, "frame");
      if (mismatch) return fail(`${transcript.path}:${entry.line}: ${mismatch}`);
      continue;
    }
    // runtime_exit, always the last entry.
    if (entry.requested) {
      while (!stdinEnded && !ended) await nextEvent();
      if (ended) return;
      if (outboundQueue.length) {
        return fail(`${transcript.path}:${entry.line}: the daemon wrote a line after the end of the recording: ${outboundQueue[0].slice(0, 200)}`);
      }
    }
    return end("played", { code: entry.code, signal: entry.signal });
  }
}

if (transcript) {
  play().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
}
