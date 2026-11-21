import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ReplayRedactor,
  findReplayLeaks,
  type ReplayRedactionContext,
} from "../../../../electron/__tests__/provider-replay/redaction.js";
import {
  PROVIDER_REPLAY_FORMAT,
  parseProviderReplayTranscript,
  serializeProviderReplayTranscript,
  type JsonObject,
  type ProviderReplayEntry,
  type TranscriptStartEntry,
} from "../../../../electron/__tests__/provider-replay/transcript.js";

// Makes the fixtures of a scenario from the raw captures of `record-scenarios.ts`.
// It is the only writer of a Claude Code edge fixture: nobody edits one by hand.
//
//   node --import tsx daemon/__tests__/edge/claude-code/redact-capture.ts \
//     --captures /tmp/claude-captures --scenario simple --description "One room message, one reply."
//
// What it changes in a capture, and nothing else:
//
// - The ids that differ in each run become names the stand-in fills in again:
//   `<session>`, `<turn-N>`, `<control-N>`, and the workspace path `<workspace>`.
// - The content of a user message becomes `<prompt>`. It is our prompt
//   wording, which the stand-in does not compare.
// - Every frame goes through the redaction of the provider replay tests.
// - Each inbound entry gets a label, `t<turn>-<kind>`, that a test can hold at.
// - When the capture has no exit, because the daemon ended the recorder
//   before it could write one, a requested exit by SIGTERM is added and the
//   header says so.

const PROTOCOL = "claude-code.cli/stream-json-stdio";
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

const args = process.argv.slice(2);
const option = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const scenario = option("--scenario");
const capturesRoot = option("--captures");
const description = option("--description");
if (!scenario || !capturesRoot || !description) {
  throw new Error("Give --captures <folder>, --scenario <name> and --description <one sentence>.");
}
const captureDir = resolve(capturesRoot, scenario);
const outDir = join(FIXTURES, scenario);

const versionText = readFileSync(join(captureDir, "version.txt"), "utf8");
const providerVersion = /\d+\.\d+\.\d+/.exec(versionText)?.[0];
if (!providerVersion) throw new Error(`No version in ${JSON.stringify(versionText)}.`);

const escapeForJson = (value: string): string => JSON.stringify(value).slice(1, -1);
const bothSpellings = (path: string): string[] => [path, path.replace(/^\/private\//, "/"), `/private${path.replace(/^\/private\//, "/")}`];

function inboundKind(frame: JsonObject): string {
  if (frame.type === "command_lifecycle") return `lifecycle-${String(frame.state)}`;
  if (frame.type === "system") return String(frame.subtype);
  if (frame.type === "control_request") return `control-${String((frame.request as JsonObject | undefined)?.subtype)}`;
  return String(frame.type);
}

const launches = readdirSync(captureDir).filter((name) => /^capture-\d+\.ndjson$/.test(name)).length;
if (!launches) throw new Error(`No capture in ${captureDir}.`);
const written: string[] = [];

for (let index = 1; index <= launches; index += 1) {
  const launch = JSON.parse(readFileSync(join(captureDir, `launch-${index}.json`), "utf8")) as { argv: string[]; cwd: string };
  const flagValue = (flag: string): string | undefined => (launch.argv.includes(flag) ? launch.argv[launch.argv.indexOf(flag) + 1] : undefined);
  const sessionId = flagValue("--resume") ?? flagValue("--session-id");
  if (!sessionId) throw new Error(`Start ${index} names no session.`);
  // The isolated home of the edge harness is the folder that holds `.letagents`.
  const edgeHome = launch.cwd.split("/.letagents/")[0]!;

  const raw = readFileSync(join(captureDir, `capture-${index}.ndjson`), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as ProviderReplayEntry);

  // Name the ids of this run, in the order the daemon sent them.
  const names: Array<[string, string]> = [[sessionId, "<session>"]];
  let turns = 0;
  let controls = 0;
  for (const entry of raw) {
    if (entry.type !== "expect_outbound") continue;
    if (entry.frame.type === "user" && typeof entry.frame.uuid === "string") {
      names.push([entry.frame.uuid, `<turn-${turns += 1}>`]);
      (entry.frame.message as JsonObject).content = [{ type: "text", text: "<prompt>" }];
    } else if (entry.frame.type === "control_request" && typeof entry.frame.request_id === "string") {
      names.push([entry.frame.request_id, `<control-${controls += 1}>`]);
    }
  }
  for (const spelling of bothSpellings(launch.cwd)) names.push([escapeForJson(spelling), "<workspace>"]);
  names.sort((a, b) => b[0].length - a[0].length);

  const context: ReplayRedactionContext = {
    workspacePaths: [],
    tempDirectories: [...bothSpellings(edgeHome), ...bothSpellings(tmpdir().replace(/\/$/, ""))],
    repositoryPaths: [],
    homeDirectory: homedir(),
    username: userInfo().username,
    personalNames: [],
    hostnames: [hostname()],
    secrets: ["edge-dummy-key"],
    ownerSetupNames: [],
    accountMethods: [],
  };
  const redactor = new ReplayRedactor(context);

  let turn = 0;
  const entries: ProviderReplayEntry[] = raw.map((entry) => {
    if (entry.type === "runtime_exit") return entry;
    let text = JSON.stringify(entry.frame);
    for (const [value, name] of names) text = text.split(value).join(name);
    const frame = redactor.redactFrame(JSON.parse(text) as JsonObject);
    if (entry.type === "expect_outbound") {
      if (frame.type === "user") turn += 1;
      return { type: entry.type, label: frame.type === "user" ? `t${turn}-prompt` : `t${turn}-${inboundKind(frame)}`, frame };
    }
    return { type: entry.type, label: `t${turn}-${inboundKind(frame)}`, frame };
  });

  const exitCaptured = entries.at(-1)?.type === "runtime_exit";
  if (!exitCaptured) {
    entries.push({ type: "runtime_exit", requested: true, transportClosedBeforeExit: false, code: null, signal: "SIGTERM" });
  }

  const start: TranscriptStartEntry = {
    type: "transcript_start",
    format: PROVIDER_REPLAY_FORMAT,
    provider: "claude-code",
    protocol: PROTOCOL,
    providerVersion,
    scenario: `${scenario}/launch-${index}`,
    capture: {
      recorder: "apps/desktop/daemon/__tests__/edge/claude-code/record-scenarios.ts",
      redactor: "apps/desktop/daemon/__tests__/edge/claude-code/redact-capture.ts",
      capturedOn: new Date().toISOString().slice(0, 10),
      platform: `${process.platform}-${process.arch}`,
      description,
      daemon: "the real daemon, started by the edge harness",
      model: "stand-in: a local Messages API that answers each turn with a known text",
      roomServer: "stand-in: the fake room server of the edge harness",
      mcpServer: "stand-in: the MCP stub of the edge harness",
      exit: exitCaptured ? "captured" : "not captured: the daemon ended the recorder first; a requested SIGTERM exit was added",
      launchArguments: launch.argv.map((argument) => {
        if (argument === sessionId) return "<session>";
        return argument.includes("/") ? "<path>" : argument;
      }),
      redactions: { ...redactor.counts },
    },
  };

  const text = serializeProviderReplayTranscript(start, entries);
  parseProviderReplayTranscript(text, `launch-${index}.ndjson`);
  const leaks = findReplayLeaks(text, context);
  if (leaks.length) {
    throw new Error(`Start ${index} still holds what redaction should remove; nothing was written:\n${
      leaks.map((leak) => `  ${leak.rule} at line ${leak.line}, ${leak.path}`).join("\n")}`);
  }
  written.push(text);
}

mkdirSync(outDir, { recursive: true });
written.forEach((text, at) => writeFileSync(join(outDir, `launch-${at + 1}.ndjson`), text));
console.log(`${scenario}: wrote ${written.length} transcript(s) to ${outDir}${existsSync(outDir) ? "" : " (missing)"}`);
