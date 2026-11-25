// Makes a fixture of the Antigravity edge stand-in from a raw capture of
// `record-cli.mjs`. It is a manual developer tool, and CI never runs it.
//
//   node redact-capture.mjs --capture <raw capture-N.ndjson> --out <fixture.ndjson> \
//     --scenario <name/launch-N> --captured-on <yyyy-mm-dd> --description <text> [--version <x.y.z>]
//
// A raw capture holds this machine's paths, the run's ids, the daemon's prompt
// and the account's plan name. The fixture keeps the protocol and drops the rest:
//
//   the session id                  -> <session>
//   the session's cwd               -> <workspace>
//   any other absolute path         -> <path>
//   the text of a prompt            -> <prompt>
//   the room MCP server's launch    -> <node>, <dev-mcp>, and <value> for each env value
//   the account plan in `_meta`     -> <plan>
//
// The daemon checks its own liveness with `letagents/probe` at times of its own,
// and the stand-in answers every probe by itself. So only the first probe and
// its answer stay in a fixture, labelled `probe` and `probe-answer`.

import { readFileSync, writeFileSync } from "node:fs";

const PROTOCOL = "antigravity.acp/stdio";

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at >= 0 && process.argv[at + 1] !== undefined) return process.argv[at + 1];
  if (fallback !== undefined) return fallback;
  process.stderr.write(`agy redact: ${name} is required\n`);
  process.exit(64);
}

const capturePath = option("--capture");
const outPath = option("--out");
const scenario = option("--scenario");
const capturedOn = option("--captured-on");
const description = option("--description");
const entries = readFileSync(capturePath, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));

let version = option("--version", "");
let sessionId = null;
let workspace = null;
for (const entry of entries) {
  const frame = entry.frame ?? {};
  if (!version && frame.result?.agentInfo?.version) version = frame.result.agentInfo.version;
  if (entry.type === "expect_outbound" && (frame.method === "session/new" || frame.method === "session/resume")) {
    workspace ??= frame.params?.cwd ?? null;
    if (frame.method === "session/resume") sessionId ??= frame.params?.sessionId ?? null;
  }
  if (entry.type === "emit_inbound" && typeof frame.result?.sessionId === "string") sessionId ??= frame.result.sessionId;
}
if (!version) {
  process.stderr.write("agy redact: the capture names no agy version; pass --version\n");
  process.exit(64);
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/)(?:Users|home|private|tmp|var|Volumes)[^\s"'`]*/g;

/** Replace the run's values in one string. */
function redactString(text) {
  let out = text;
  if (workspace) out = out.split(workspace).join("<workspace>");
  if (sessionId) out = out.split(sessionId).join("<session>");
  return out.replace(ABSOLUTE_PATH, "<path>");
}

function redact(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redact(inner)]));
  return value;
}

function redactFrame(entry) {
  const frame = structuredClone(entry.frame);
  if (frame.method === "session/prompt" && Array.isArray(frame.params?.prompt)) {
    frame.params.prompt = frame.params.prompt.map((block) => (block.type === "text" ? { ...block, text: "<prompt>" } : block));
  }
  for (const server of frame.params?.mcpServers ?? []) {
    if (typeof server.command === "string") server.command = "<node>";
    if (Array.isArray(server.args)) server.args = server.args.map(() => "<dev-mcp>");
    if (Array.isArray(server.env)) server.env = server.env.map((pair) => ({ name: pair.name, value: "<value>" }));
  }
  const plan = frame.result?._meta?.antigravity?.tier;
  if (plan && typeof plan === "object") {
    frame.result._meta.antigravity.tier = Object.fromEntries(Object.keys(plan).map((key) => [key, "<plan>"]));
  }
  return redact(frame);
}

const out = [{
  type: "transcript_start",
  format: 1,
  provider: "antigravity",
  protocol: PROTOCOL,
  providerVersion: version,
  scenario,
  capture: {
    recorder: "apps/desktop/daemon/__tests__/edge/antigravity/record-cli.mjs",
    redactor: "apps/desktop/daemon/__tests__/edge/antigravity/redact-capture.mjs",
    capturedOn,
    platform: `${process.platform}-${process.arch}`,
    description,
  },
}];

let probes = 0;
let skipProbeAnswer = false;
let permissions = 0;
for (const entry of entries) {
  if (entry.type === "runtime_exit") {
    out.push({ type: "runtime_exit", requested: entry.requested, transportClosedBeforeExit: entry.transportClosedBeforeExit, code: entry.code, signal: entry.signal });
    continue;
  }
  const frame = entry.frame;
  if (frame.not_json !== undefined) continue;
  let label;
  if (entry.type === "expect_outbound" && frame.method === "letagents/probe") {
    probes += 1;
    if (probes > 1) { skipProbeAnswer = true; continue; }
    label = "probe";
  } else if (entry.type === "emit_inbound" && frame.error?.code === -32601 && probes >= 1) {
    if (skipProbeAnswer) { skipProbeAnswer = false; continue; }
    if (!out.some((line) => line.label === "probe-answer")) label = "probe-answer";
  } else if (frame.method === "session/request_permission") {
    permissions += 1;
    label = `permission-${permissions}`;
  } else if (entry.type === "expect_outbound" && frame.method === undefined && frame.result?.outcome) {
    label = `permission-${permissions}-answer`;
  } else if (entry.type === "expect_outbound" && typeof frame.method === "string") {
    label = frame.method.replace(/^session\//, "");
  }
  out.push({ type: entry.type, ...(label ? { label } : {}), frame: redactFrame(entry) });
}

writeFileSync(outPath, `${out.map((line) => JSON.stringify(line)).join("\n")}\n`);
process.stdout.write(`agy redact: ${out.length} lines -> ${outPath}\n`);
