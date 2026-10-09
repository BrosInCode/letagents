import { execFile } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LETAGENTS_MCP_SERVER_NAME, listCodexMcpServers } from "../../../../shared/codex-owner-isolation.mjs";
import {
  launchManagedCodexAppServer,
  sensitiveCodexAppServerEnvValues,
  terminateSpawnedProcess,
  type CodexAppServerExit,
} from "../main/agents/codex-app-server.js";
import { resolveCodexExecutable } from "../main/agents/codex-executable.js";
import type { CodexProviderAdapterDependencies } from "../main/agents/codex-provider-adapter.js";
import { CodexRpcClient, type CodexRpcWebSocketCtor } from "../main/agents/codex-rpc-client.js";
import { defaultSignalProcess } from "../main/agents/provider-evidence.js";
import { CODEX_REPLAY_PROTOCOL } from "../__tests__/provider-replay/codex-replay.js";
import {
  CODEX_SCENARIOS,
  runCodexScenario,
  type CodexScenarioName,
  type CodexScenarioOutcome,
} from "../__tests__/provider-replay/codex-scenarios.js";
import {
  ReplayRedactor,
  findReplayLeaks,
  type ReplayRedactionContext,
} from "../__tests__/provider-replay/redaction.js";
import { frameName } from "../__tests__/provider-replay/replay-session.js";
import {
  PROVIDER_REPLAY_FORMAT,
  countProviderReplayEntries,
  parseProviderReplayTranscript,
  serializeProviderReplayTranscript,
  type JsonObject,
  type ProviderReplayEntry,
  type ProviderReplayFrameEntry,
  type TranscriptStartEntry,
} from "../__tests__/provider-replay/transcript.js";

// Records the traffic between the real Codex adapter and a real
// `codex app-server` for one scenario, and writes it as a replay transcript.
// It is a manual developer tool: it spends a real model turn, and CI never
// runs it. It starts no LetAgents desktop app and no daemon.
//
//   LETAGENTS_RECORD_LIVE_CODEX=1 node --import tsx \
//     electron/scripts/record-codex-replay.ts --scenario simple
//
// See docs/provider-replay-tests.md.

const LIVE_RECORD_ENV = "LETAGENTS_RECORD_LIVE_CODEX";
const SCENARIO_TIMEOUT_MS = 180_000;
/** The wire is settled when no reply is owed and nothing has crossed it for this long. */
const QUIET_MS = 2_500;
const SETTLE_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDirectory, "..", "..");
const repositoryRoot = resolve(desktopRoot, "..", "..");
const roomStubPath = join(scriptDirectory, "record-codex-replay-room-stub.mjs");
const fixtureDirectory = join(desktopRoot, "electron", "__tests__", "provider-replay", "fixtures", "codex");

/** The stand-in room server needs none of the owner's room credentials, so it is given none. */
const ROOM_STUB_OVERRIDES = [
  'mcp_servers.letagents.env.LETAGENTS_TOKEN=""',
  'mcp_servers.letagents.env.LETAGENTS_AGENT_SESSION_BEARER=""',
];

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms.`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * End a recording that will not be written: stop its app-server and remove
 * its workspace. The app-server runs detached, in a process group of its own,
 * so a signal to the recorder does not reach it.
 */
export function discardRecording(
  recording: { pid: number | null; exited: boolean; workspace: string },
  terminate: (pid: number) => void = terminateSpawnedProcess,
): void {
  if (recording.pid !== null && !recording.exited) terminate(recording.pid);
  rmSync(recording.workspace, { recursive: true, force: true });
}

/** Every frame that crossed the socket, in the order this process saw it. */
class CodexCapture {
  readonly entries: ProviderReplayEntry[] = [];
  pid: number | null = null;
  exit: Promise<CodexAppServerExit> | null = null;
  /** The adapter signalled the process while both ends of the runtime were still up. */
  exitRequested = false;
  /** The order the adapter saw the two ends of the runtime in: its socket closing, and its process exiting. */
  transportClosedBeforeExit = false;
  private exitSeen = false;
  private closeSeen = false;
  private readonly requestMethods = new Map<string, string>();
  private readonly owedReplies = new Set<string>();
  private lastFrameAt = Date.now();

  record(direction: "outbound" | "inbound", text: string): void {
    const frame = JSON.parse(text) as unknown;
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      throw new Error(`Codex sent a ${direction} frame that is not a JSON object.`);
    }
    this.lastFrameAt = Date.now();
    this.entries.push({
      type: direction === "outbound" ? "expect_outbound" : "emit_inbound",
      label: this.label(direction, frame as JsonObject),
      frame: frame as JsonObject,
    });
  }

  /** A request or notification is named by its method; a reply by the method it answers. */
  private label(direction: "outbound" | "inbound", frame: JsonObject): string {
    const id = frame.id === undefined ? null : JSON.stringify(frame.id);
    if (typeof frame.method === "string") {
      if (id !== null) {
        this.requestMethods.set(`${direction}:${id}`, frame.method);
        if (direction === "outbound") this.owedReplies.add(id);
      }
      return frame.method;
    }
    const asked = direction === "outbound" ? "inbound" : "outbound";
    if (direction === "inbound" && id !== null) this.owedReplies.delete(id);
    return this.requestMethods.get(`${asked}:${id}`) ?? frameName(frame);
  }

  async settled(): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (this.owedReplies.size > 0 || Date.now() - this.lastFrameAt < QUIET_MS) {
      if (Date.now() > deadline) throw new Error("Codex did not go quiet after the turn.");
      await delay(100);
    }
  }

  /** The real launch, the real socket and the real signal, each with a tap. */
  dependencies(): Partial<CodexProviderAdapterDependencies> {
    return {
      launchServer: async (serverUrl, codexBin, options) => {
        const launch = await launchManagedCodexAppServer(serverUrl, codexBin, {
          ...options,
          configOverrides: [...options.configOverrides, ...ROOM_STUB_OVERRIDES],
        });
        this.pid = launch.pid;
        this.exit = launch.exited;
        // Registered before the adapter's own observer, so both see the same order.
        void launch.exited.then(() => { this.exitSeen = true; });
        return launch;
      },
      createRpcClient: (serverUrl, onNotification) =>
        new CodexRpcClient(serverUrl, onNotification, undefined, this.tappedWebSocket()),
      signalProcess: (pid, signal) => {
        // A signal after the runtime began to end is the adapter cleaning up, not the cause.
        if (!this.exitSeen && !this.closeSeen) this.exitRequested = true;
        defaultSignalProcess(pid, signal);
      },
    };
  }

  private tappedWebSocket(): CodexRpcWebSocketCtor {
    const capture = this;
    return class TappedWebSocket extends globalThis.WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        // Added before the client sets `onmessage`, so the tap sees each frame first.
        this.addEventListener("message", (event) => capture.record("inbound", String(event.data)));
        this.addEventListener("close", () => {
          capture.closeSeen = true;
          if (!capture.exitSeen) capture.transportClosedBeforeExit = true;
        });
      }

      override send(data: Parameters<WebSocket["send"]>[0]): void {
        capture.record("outbound", String(data));
        super.send(data);
      }
    };
  }
}

async function commandOutput(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function withoutPrivatePrefix(path: string): string[] {
  return path.startsWith("/private/") ? [path, path.slice("/private".length)] : [path, `/private${path}`];
}

/** What must not reach a public repository from this machine. Values are collected, never printed. */
async function redactionContext(codexBin: string, workspace: string): Promise<ReplayRedactionContext> {
  const fullName = await commandOutput("id", ["-F"]);
  const gitName = await commandOutput("git", ["config", "--global", "user.name"]);
  const gitEmail = await commandOutput("git", ["config", "--global", "user.email"]);
  const names = [fullName, gitName, gitEmail?.split("@")[0]].filter((value): value is string => Boolean(value));
  const host = hostname();
  const hostnames = [
    host,
    host.replace(/\.local$/i, ""),
    ...(process.platform === "darwin"
      ? await Promise.all(["LocalHostName", "ComputerName", "HostName"].map((name) => commandOutput("scutil", ["--get", name])))
      : []),
  ].filter((value): value is string => Boolean(value));
  // The owner's Codex config can hold credentials for its MCP servers.
  // Its server names are the owner's own choice too. A list that cannot be
  // read fails the recording: nothing is written without it.
  const servers = await listCodexMcpServers(codexBin, { cwd: "/", env: process.env, configOverrides: [] });
  const serverSecrets = servers.flatMap((server) => {
    const transport = (server.transport ?? {}) as Record<string, unknown>;
    return [transport.env, transport.http_headers, transport.env_http_headers].flatMap((bag) =>
      bag && typeof bag === "object" ? sensitiveCodexAppServerEnvValues(bag as NodeJS.ProcessEnv) : []);
  });
  return {
    workspacePaths: withoutPrivatePrefix(workspace),
    tempDirectories: [...withoutPrivatePrefix(await realpath(tmpdir())), tmpdir()],
    repositoryPaths: [...withoutPrivatePrefix(await realpath(repositoryRoot)), repositoryRoot],
    homeDirectory: homedir(),
    username: userInfo().username,
    personalNames: [...names, ...names.flatMap((name) => name.split(/[^\p{L}\p{N}]+/u)).filter((word) => word.length >= 4)],
    hostnames,
    secrets: [...sensitiveCodexAppServerEnvValues(process.env), ...serverSecrets].filter((value) => value.length >= 8),
    ownerSetupNames: servers.map((server) => server.name).filter((name) => name !== LETAGENTS_MCP_SERVER_NAME),
    accountMethods: [/^account\//],
  };
}

function parseArguments(argv: string[]): { scenario: CodexScenarioName; out: string } {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const scenario = value("--scenario");
  if (!scenario || !Object.hasOwn(CODEX_SCENARIOS, scenario)) {
    throw new Error(`Give --scenario one of: ${Object.keys(CODEX_SCENARIOS).join(", ")}.`);
  }
  return {
    scenario: scenario as CodexScenarioName,
    out: resolve(value("--out") ?? join(fixtureDirectory, `${scenario}.ndjson`)),
  };
}

function summarize(outcome: CodexScenarioOutcome): Record<string, unknown> {
  return {
    stateAfterSpawn: outcome.stateAfterSpawn,
    roomTurn: outcome.roomTurn,
    interrupt: outcome.interrupt,
    stateAfterTurn: outcome.stateAfterTurn,
    terminal: outcome.terminal,
    stateAfterStop: outcome.stateAfterStop,
    streamEvents: outcome.stream.length,
    activityEvents: outcome.activity.length,
    executionFacts: outcome.execution.map(({ fact }) => `${fact.domain}:${"state" in fact ? fact.state : fact.kind}`),
  };
}

async function main(): Promise<void> {
  if (process.env[LIVE_RECORD_ENV] !== "1") {
    throw new Error(`This recorder runs a real Codex model turn. Set ${LIVE_RECORD_ENV}=1 to run it deliberately.`);
  }
  const { scenario: scenarioName, out } = parseArguments(process.argv.slice(2));
  const scenario = CODEX_SCENARIOS[scenarioName];
  const codexBin = process.env.LETAGENTS_CODEX_BIN?.trim() || resolveCodexExecutable({ env: process.env });
  const versionOutput = await commandOutput(codexBin, ["--version"]);
  const providerVersion = versionOutput?.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0];
  if (!providerVersion) throw new Error(`Could not read the Codex version from ${JSON.stringify(versionOutput)}.`);

  // A fresh empty folder: the agent has nothing to read and, read-only, nothing to change.
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "letagents-codex-replay-")));
  const capture = new CodexCapture();
  let outcome: CodexScenarioOutcome;
  let exit: CodexAppServerExit | null = null;
  const discard = () => discardRecording({ pid: capture.pid, exited: exit !== null, workspace });
  // Ctrl-C, or a stop from outside, must not leave the app-server running or the folder behind.
  const interrupted = (signal: NodeJS.Signals) => {
    discard();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    outcome = await withDeadline(runCodexScenario(scenario, {
      dependencies: capture.dependencies(),
      codexBin,
      workspace,
      launch: { devMcpServerEntryPath: roomStubPath },
      settled: () => capture.settled(),
    }), SCENARIO_TIMEOUT_MS, `Scenario ${scenario.name}`);
    if (!capture.exit) throw new Error("The scenario ended without launching a Codex app-server.");
    exit = await withDeadline(capture.exit, EXIT_TIMEOUT_MS, "The Codex app-server exit");
    // Frames already in flight when the process ended still belong before its exit.
    await delay(250);
  } finally {
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    // A recording that failed must not leave its app-server running either.
    discard();
  }
  if (exit.type !== "exit") throw new Error(`The Codex app-server did not exit cleanly: ${exit.error.message}`);
  capture.entries.push({
    type: "runtime_exit",
    requested: capture.exitRequested,
    transportClosedBeforeExit: capture.transportClosedBeforeExit,
    code: exit.code,
    signal: exit.signal,
  });

  const context = await redactionContext(codexBin, workspace);
  const redactor = new ReplayRedactor(context);
  const entries = capture.entries.map((entry): ProviderReplayEntry => entry.type === "runtime_exit" ? entry : {
    type: entry.type,
    label: entry.label,
    // A reply has no method of its own; its label is the method it answers.
    frame: redactor.redactFrame(entry.frame, entry.label),
  } satisfies ProviderReplayFrameEntry);
  const threadStart = entries.find((entry) => entry.type === "emit_inbound" && entry.label === "thread/start");
  const model = threadStart?.type === "emit_inbound" ? (threadStart.frame.result as JsonObject | undefined)?.model : undefined;
  const start: TranscriptStartEntry = {
    type: "transcript_start",
    format: PROVIDER_REPLAY_FORMAT,
    provider: "codex",
    protocol: CODEX_REPLAY_PROTOCOL,
    providerVersion,
    scenario: scenario.name,
    capture: {
      recorder: relative(repositoryRoot, fileURLToPath(import.meta.url)),
      capturedOn: new Date().toISOString().slice(0, 10),
      platform: `${process.platform}-${process.arch}`,
      description: scenario.description,
      message: scenario.message,
      model: typeof model === "string" ? model : null,
      // Codex is the real one. The room's MCP server is a stand-in with no room and no network.
      roomServer: "stand-in: record-codex-replay-room-stub.mjs",
      redactions: { ...redactor.counts },
    },
  };
  const text = serializeProviderReplayTranscript(start, entries);
  // The file must load, and must hold nothing redaction was meant to remove.
  const transcript = parseProviderReplayTranscript(text, out);
  const leaks = findReplayLeaks(text, context);
  if (leaks.length) {
    const found = leaks.map((leak) => `${leak.rule} at ${leak.path || "the entry"} (line ${leak.line})`).join("; ");
    const bareName = leaks.some((leak) => leak.rule === "username")
      ? " A user name is replaced only where it names you: in a path, before `@`, or under a user-like key."
        + " If yours is an ordinary word that the protocol also uses, record from an account with a distinctive user name."
      : "";
    throw new Error(`Nothing was written: the redacted transcript still holds ${found}. Fix the redaction and record again.${bareName}`);
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text, "utf8");

  console.log(JSON.stringify({
    written: relative(repositoryRoot, out),
    scenario: scenario.name,
    providerVersion,
    entries: countProviderReplayEntries(transcript),
    redactions: start.capture.redactions,
    exit: capture.entries.at(-1),
    outcome: redactor.redactFrame(JSON.parse(JSON.stringify(summarize(outcome))) as JsonObject),
  }, null, 2));
}

/** True when this file is the program that was started, false when a test or another script imports it. */
function executedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (executedDirectly()) {
  main().then(() => process.exit(0), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
