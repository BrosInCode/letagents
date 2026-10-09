import { ClaudeCompaction } from "../main/agents/claude-compaction.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { providerAcquisitionIdentity, providerAcquisitionEvidence } from "../../../../shared/provider-acquisition-evidence.mjs";

import {
  ClaudeCodeProviderAdapter,
  claudeSessionTranscriptCandidates,
  claudeChildEnvironment,
  claudeCliEnv,
  claudeTranscriptsRoot,
  claudeCliLaunchArgs,
  claudeLaunchPolicyArgs,
  claudeOwnerSetupReadsProjectInstructionsOnly,
  claudeOwnerSetupStartEnvironment,
  createEphemeralClaudeMcpConfig,
  createManagedClaudeMcpConfig,
  ownerMcpServerNotices,
  ownerMcpStartupTimeoutMs,
  type ClaudeCliChild,
  type ClaudeCodeProviderAdapterDependencies,
} from "../main/agents/claude-code-provider-adapter.js";
import type {
  ProviderSpawnRequest,
  ProviderActivityEvent,
  ProviderStreamEvent,
  ProviderTerminalPayload,
  NativeExecutionObservation,
} from "../main/agents/provider-adapter.js";
import { PROCESS_ENDED_DURING_TURN } from "../main/agents/provider-adapter.js";
import { defaultGetProcessIdentity, sameProcessBirthIdentity, type ProviderProcessExit } from "../main/agents/provider-evidence.js";

// Cross-layer assertions load the daemon at test runtime without pulling its
// separately compiled source tree into Electron's production rootDir.
const { providerStreamLifecycle } = await import(new URL("../../daemon/provider-stream-policy.ts", import.meta.url).href);
const { emptyExecutionProjection, reduceExecutionFact } = await import(new URL("../../daemon/execution-reducer.ts", import.meta.url).href);
const { ProviderActionPortRouter } = await import(new URL("../../daemon/provider-action-port-router.ts", import.meta.url).href);
const { ProviderSchedulerFailureCoordinator } = await import(new URL("../../daemon/provider-scheduler-failure-coordinator.ts", import.meta.url).href);
const { redactCredentialText } = await import(new URL("../../daemon/credential-redaction.ts", import.meta.url).href);

// Fake-child harness proving the P2a adapter honors every #765 liveness
// invariant with no live `claude` binary: birth-identity fencing, control-loss
// is never death, recycled PIDs are never signalled, and startup failures
// leave no orphan.

class FakeClaudeChild implements ClaudeCliChild {
  readonly lines: Array<(line: string) => void> = [];
  readonly disconnects: Array<() => void> = [];
  readonly written: string[] = [];
  intentionalClose = false;
  inputEnded = false;
  alive = true;
  private resolveExited!: (exit: ProviderProcessExit) => void;
  readonly exited: Promise<ProviderProcessExit>;

  constructor(readonly pid: number | null) {
    this.exited = new Promise((resolve) => { this.resolveExited = resolve; });
  }

  onLine(listener: (line: string) => void): () => void {
    this.lines.push(listener);
    return () => {
      const index = this.lines.indexOf(listener);
      if (index >= 0) this.lines.splice(index, 1);
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnects.push(listener);
    return () => {
      const index = this.disconnects.indexOf(listener);
      if (index >= 0) this.disconnects.splice(index, 1);
    };
  }

  writeLine(json: string): void {
    this.written.push(json);
  }

  endInput(): void {
    this.inputEnded = true;
  }

  markIntentionalClose(): void {
    this.intentionalClose = true;
  }

  emit(message: Record<string, unknown>): void {
    for (const listener of [...this.lines]) listener(JSON.stringify(message));
  }

  emitRaw(line: string): void {
    for (const listener of [...this.lines]) listener(line);
  }

  disconnect(): void {
    for (const listener of [...this.disconnects]) listener();
    this.disconnects.length = 0;
  }

  resolveExit(exit: ProviderProcessExit): void {
    this.alive = false;
    this.resolveExited(exit);
  }
}

interface HarnessOptions {
  pid?: number | null;
  /** Force the init message's session id (to exercise identity-mismatch refusal). */
  initSessionId?: string;
  noInit?: boolean;
  noLetagents?: boolean;
  /** The servers the CLI reports, when a test needs more than the room's own. */
  mcpServers?: Array<Record<string, unknown>>;
  mcpStatus?: string;
  mcpTools?: string[];
  noApprovalLifecycle?: boolean;
  /** The mode the CLI reports it started in; an account without Auto reports another. */
  initPermissionMode?: string;
  bootstrapResultSubtype?: string;
  bootstrapMessages?: (sessionId: string, turnId: string) => Record<string, unknown>[];
  omitBootstrapResult?: boolean;
  exitAfterBootstrapResult?: ProviderProcessExit;
  /** Overrides per pid; undefined entries mean "cannot verify". */
  identities?: Map<number, string | null | undefined>;
  /** Defaults to true (a well-behaved CLI); fence tests opt out to exercise escalation. */
  dieOnSigterm?: boolean;
  versionOutput?: string;
  sessionRows?: Array<Record<string, unknown>>;
  /** The managed commit identity the work attempt resolves to. */
  commitEnvironment?: Record<string, string>;
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

function birthIdentity(pid: number): string {
  return `fake-claude-${pid}-birth-1`;
}

function createHarness(options: HarnessOptions = {}) {
  const children: FakeClaudeChild[] = [];
  const launches: Array<{ claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; ownerSetup?: true }> = [];
  const versionBins: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const identities = options.identities ?? new Map<number, string | null | undefined>();
  let nextPid = 4100;
  let mcpConfigDisposals = 0;
  let versionReads = 0;
  const commitRequests: ProviderSpawnRequest[] = [];
  const mcpConfigRequests: unknown[][] = [];

  const dependencies: ClaudeCodeProviderAdapterDependencies = {
    async readVersion(claudeBin) {
      versionReads += 1;
      versionBins.push(claudeBin);
      return options.versionOutput ?? "2.1.220 (Claude Code)";
    },
    async createLetAgentsMcpConfig(...received) {
      mcpConfigRequests.push(received);
      return {
        path: "/private/tmp/letagents-claude-mcp-test/mcp.json",
        async dispose() { mcpConfigDisposals += 1; },
      };
    },
    launchChild(input) {
      launches.push(input);
      const pid = options.pid === undefined ? nextPid++ : options.pid;
      const child = new FakeClaudeChild(pid);
      children.push(child);
      if (pid !== null && !identities.has(pid)) identities.set(pid, birthIdentity(pid));
      // Real-CLI semantics proven by the task_36 spike (msg_1382): init is only
      // emitted AFTER the first stdin user frame, and it echoes the minted
      // --session-id (or the SAME id under --resume).
      const initSessionId = options.initSessionId
        ?? argValue(input.args, "--resume")
        ?? argValue(input.args, "--session-id")
        ?? "sess-unexpected";
      const originalWriteLine = child.writeLine.bind(child);
      let sawFirstWrite = false;
      child.writeLine = (json: string) => {
        originalWriteLine(json);
        if (sawFirstWrite) return;
        sawFirstWrite = true;
        queueMicrotask(() => {
          if (!child.alive) return;
          if (!options.noInit) child.emit({
            type: "system",
            subtype: "init",
            session_id: initSessionId,
            model: "claude-fable-5",
            capabilities: options.noApprovalLifecycle ? [] : ["msg_lifecycle_v1"],
            permissionMode: options.initPermissionMode ?? "default",
            cwd: input.cwd,
            mcp_servers: options.mcpServers ?? (options.noLetagents ? [] : [{ name: "letagents", status: options.mcpStatus ?? "connected" }]),
            tools: options.mcpTools ?? ["mcp__letagents__get_board", "mcp__letagents__read_messages", "mcp__letagents__send_message"],
          });
          const frame = JSON.parse(json) as { uuid?: string };
          for (const message of options.bootstrapMessages?.(initSessionId, frame.uuid!) ?? []) child.emit(message);
          if (options.noInit || options.omitBootstrapResult) return;
          child.emit({
            type: "result",
            subtype: options.bootstrapResultSubtype ?? "success",
            is_error: options.bootstrapResultSubtype !== undefined,
            session_id: initSessionId,
            user_message_uuid: frame.uuid,
            result: "LETAGENTS_CLAUDE_DAEMON_READY",
          });
          if (options.exitAfterBootstrapResult) {
            if (options.exitAfterBootstrapResult.type === "exit" && pid !== null) identities.set(pid, null);
            child.resolveExit(options.exitAfterBootstrapResult);
          }
        });
      };
      return child;
    },
    signalProcess(pid, signal) {
      signals.push({ pid, signal });
      const child = children.find((entry) => entry.pid === pid);
      if (signal === "SIGKILL") {
        identities.set(pid, null);
        child?.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
      } else if (signal === "SIGTERM" && (options.dieOnSigterm ?? true)) {
        identities.set(pid, null);
        child?.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
      }
    },
    getProcessIdentity(pid) {
      return identities.get(pid);
    },
    observeProcessExit(pid, processIdentity) {
      return new Promise((resolve) => {
        const poll = () => {
          const current = identities.get(pid);
          if (current === null || (typeof current === "string" && current !== processIdentity)) {
            resolve({ type: "exit", code: null, signal: null });
            return;
          }
          setTimeout(poll, 5);
        };
        poll();
      });
    },
    async readSessionRows() {
      return options.sessionRows ?? [];
    },
    async resolveCommitEnvironment(req) {
      commitRequests.push(req);
      return options.commitEnvironment ?? {};
    },
    now: () => new Date(1_700_000_000_000).toISOString(),
  };

  return {
    children,
    launches,
    versionBins,
    signals,
    identities,
    dependencies,
    commitRequests,
    mcpConfigRequests,
    get mcpConfigDisposals() { return mcpConfigDisposals; },
    get versionReads() { return versionReads; },
  };
}

function spawnRequest(over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "wa-claude-1",
    roomId: "github.com/example/repo",
    agentDisplayName: "LanternRook",
    cwd: "/tmp/wa-claude-1",
    launchPolicy: { permissionMode: "acceptEdits" },
    deliveryMode: "daemon_inbox",
    ...over,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function waitForChildOutput(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(marker)) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => { cleanup(); reject(new Error(`child exited before '${marker}'`)); };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

// The evidence module's grace timers are deliberately unref'd; when a test's
// only pending work is such a timer the loop would drain, so hold it open.
async function withLoopAlive<T>(work: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await work;
  } finally {
    clearInterval(keepAlive);
  }
}

test("spawn launches the headless CLI with verbatim policy flags and establishes an idle daemon continuation", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  const handle = await adapter.spawn(spawnRequest({ launchPolicy: { permissionMode: "acceptEdits", model: "opus", dangerouslySkipPermissions: false } }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));

  assert.equal(harness.launches.length, 1);
  const args = harness.launches[0]!.args;
  for (const expected of ["--print", "--verbose", "--input-format", "stream-json", "--output-format"]) {
    assert.ok(args.includes(expected), `args include ${expected}`);
  }
  assert.ok(args.join(" ").includes("--permission-mode acceptEdits"), "native policy flag passed verbatim");
  assert.ok(args.join(" ").includes("--model opus"));
  assert.equal(args.includes("--dangerously-skip-permissions"), false, "false policy values are omitted, not inverted");
  assert.equal(args.includes("--resume"), false);

  // The adapter mints the session identity up front and the CLI echoes it in
  // init (msg_1382); the continuation is that exact minted id.
  const mintedSessionId = argValue(args, "--session-id");
  assert.ok(mintedSessionId, "a session id is minted at spawn");
  assert.equal(handle.providerContinuationId, mintedSessionId);
  assert.equal(handle.pid, 4100);
  assert.deepEqual(handle.providerConnection, {
    kind: "claude_cli",
    pid: 4100,
    processIdentity: birthIdentity(4100),
  });
  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(observations.map(({ fact }) => fact), [{
    domain: "runtime",
    kind: "state_changed",
    state: "ready",
    sideEffects: "none",
  }], "verified bootstrap readiness is retained before the first room turn");
  assert.equal(harness.versionReads, 1, "the installed CLI is checked immediately before launch");

  const child = harness.children[0]!;
  assert.equal(child.written.length, 1, "exactly one daemon-safe bootstrap message");
  const startMessage = JSON.parse(child.written[0]!) as { type: string; uuid?: string; message: { content: Array<{ text: string }> } };
  assert.equal(startMessage.type, "user");
  assert.ok(startMessage.uuid, "bootstrap uses an exact caller-supplied turn id");
  const prompt = startMessage.message.content[0]!.text;
  assert.match(prompt, /Do not call tools, inspect the room, or perform work/);
  assert.doesNotMatch(prompt, /register_agent_session|wait_for_messages|join_room/);

  assert.ok(streamEvents.some((event) => event.method === "system/init"), "init published as stream evidence");
});

test("read-only spawn removes shell tools and ambient settings from the native CLI", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({
    configurationRevision: 1,
    permissionProfileId: "read_only",
    launchPolicy: {
      permissionMode: "dontAsk",
      dangerouslySkipPermissions: false,
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["mcp__letagents__*"],
      settingSources: "",
    },
  }));

  const args = harness.launches[0]!.args;
  assert.equal(argValue(args, "--permission-mode"), "dontAsk");
  assert.equal(argValue(args, "--tools"), "Read,Glob,Grep");
  assert.equal(argValue(args, "--allowed-tools"), "mcp__letagents__*");
  assert.equal(argValue(args, "--setting-sources"), "");
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("Claude freezes lifecycle authority to the exact CLI process birth", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const typedHandle = handle as typeof handle & { lifecycleAuthorityMode: string };
  const ref = {
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
    lifecycleAuthorityMode: "typed" as const,
  };

  assert.equal(typedHandle.lifecycleAuthorityMode, "typed");
  assert.equal(await adapter.attach(ref), handle);
  assert.equal(await adapter.attach({
    ...ref,
    providerConnection: { kind: "claude_cli", pid: handle.pid, processIdentity: birthIdentity(9999) },
  }), null);
  assert.equal(await adapter.attach({ ...ref, lifecycleAuthorityMode: "typed_shadow" }), null);
  assert.equal(await adapter.attach({ ...ref, lifecycleAuthorityMode: undefined }), null);
  await assert.rejects(adapter.spawn(spawnRequest({
    workAttemptId: "wa-claude-wrong-delivery",
    deliveryMode: "mcp_polling",
    lifecycleAuthorityMode: "typed",
  })), /require daemon_inbox delivery/);

  const resumed = await adapter.resume(
    { ...ref, workAttemptId: "wa-claude-resumed", lifecycleAuthorityMode: "typed_shadow" },
    spawnRequest({ workAttemptId: "wa-claude-resumed", lifecycleAuthorityMode: "typed" }),
  ) as typeof handle & { lifecycleAuthorityMode: string };
  assert.equal(resumed.lifecycleAuthorityMode, "typed",
    "a resumed continuation starts a new process birth under the requested authority");
});

test("typed Claude lifecycle ignores foreign failures and settles every exact result", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const child = harness.children[0]!;
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => events.push(event));
  const request = { inboxItemId: "typed-malformed", actionId: "typed-malformed", sourceMessage: {}, activation: {} };
  const running = adapter.runRoomTurn(handle, request);
  await flush();
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  const session_id = handle.providerContinuationId;

  child.emit({
    type: "result", subtype: "error_during_execution", is_error: true,
    session_id, user_message_uuid: "foreign-turn",
  });
  assert.equal(handle.observedState(), "idle", "foreign raw failure cannot poison typed lifecycle");

  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id });
  assert.equal(handle.observedState(), "working");
  child.emit({ type: "result", session_id, user_message_uuid: turnId });
  await assert.rejects(running, /without success/);
  assert.equal(handle.observedState(), "idle", "an exact failed turn leaves the typed runtime reusable");
  assert.equal(events.filter((event) => event.fact.domain === "turn"
    && event.fact.state === "terminal"
    && event.fact.providerTurnId === turnId
    && event.fact.turnOutcome === "failed").length, 1,
  "the same exact result that settles delivery emits one typed terminal");

  const next = adapter.runRoomTurn(handle, { ...request, inboxItemId: "typed-after-malformed" });
  await flush();
  const nextId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "result", subtype: "success", is_error: false, session_id, user_message_uuid: nextId, result: "ready" });
  assert.equal((await next).text, "ready");
});

test("typed-shadow Claude keeps malformed exact-result observation unchanged", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed_shadow" }));
  const child = harness.children[0]!;
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => events.push(event));
  const running = adapter.runRoomTurn(handle, {
    inboxItemId: "shadow-malformed", actionId: "shadow-malformed", sourceMessage: {}, activation: {},
  });
  await flush();
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "result", session_id: handle.providerContinuationId, user_message_uuid: turnId });

  await assert.rejects(running, /without success/);
  assert.equal(handle.observedState(), "idle");
  assert.equal(events.some((event) => event.fact.domain === "turn" && event.fact.state === "terminal"), false,
    "the permissive exact-result terminal belongs only to typed authority");
});

test("Claude checkpoints an exact provider failure while retaining its reusable session", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const checkpoints: unknown[] = [];
  const pending = adapter.runRoomTurn(handle, { inboxItemId: "failure", actionId: "failure", sourceMessage: {}, activation: {} }, {
    checkpointTerminalResult: async result => { checkpoints.push(result); },
  });
  await flush();
  const child = harness.children[0]!;
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "result", subtype: "error_during_execution", is_error: true,
    session_id: handle.providerContinuationId, user_message_uuid: turnId, errors: ["HTTP 503 service unavailable"] });
  const failure = await pending;
  assert.deepEqual(failure, { turnId, providerContinuationId: handle.providerContinuationId,
    outcome: "failed", text: null, evidence: "stream", error: "HTTP 503 service unavailable" });
  assert.deepEqual(checkpoints, [failure]);
  assert.equal(handle.observedState(), "idle");
  assert.equal(child.alive, true);
  assert.deepEqual(harness.signals, []);
});

test("preflight and launch use the exact configured Claude Code executable", async () => {
  const previousExact = process.env.LETAGENTS_CLAUDE_CODE_BIN;
  const previousLegacy = process.env.LETAGENTS_CLAUDE_BIN;
  process.env.LETAGENTS_CLAUDE_CODE_BIN = "/custom/claude-code";
  process.env.LETAGENTS_CLAUDE_BIN = "/different/claude";
  try {
    const harness = createHarness();
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });

    await adapter.spawn(spawnRequest());

    assert.deepEqual(harness.versionBins, ["/custom/claude-code"]);
    assert.equal(harness.launches[0]?.claudeBin, "/custom/claude-code");
  } finally {
    if (previousExact === undefined) delete process.env.LETAGENTS_CLAUDE_CODE_BIN;
    else process.env.LETAGENTS_CLAUDE_CODE_BIN = previousExact;
    if (previousLegacy === undefined) delete process.env.LETAGENTS_CLAUDE_BIN;
    else process.env.LETAGENTS_CLAUDE_BIN = previousLegacy;
  }
});

test("spawn blocks an outdated Claude CLI before creating credentials or a provider process", async () => {
  const harness = createHarness({ versionOutput: "2.1.69 (Claude Code)" });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(
    adapter.spawn(spawnRequest()),
    /Claude Code 2\.1\.69 is too old.*2\.1\.70 or newer.*claude update/,
  );
  assert.equal(harness.versionReads, 1);
  assert.equal(harness.launches.length, 0);
  assert.equal(harness.children.length, 0);
  assert.equal(harness.mcpConfigDisposals, 0, "no credential-bearing MCP config exists before runtime admission");
});

test("Claude supervised launch passes the exact daemon generation bridge to its LetAgents MCP workplace", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_2819",
    },
  }));
  assert.deepEqual(harness.launches[0]?.env, {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: spawnRequest().workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "execution_exact",
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent_session_exact",
    LETAGENTS_SUPERVISOR_ROOM_ID: spawnRequest().roomId,
    LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: spawnRequest().agentDisplayName,
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
  });
  const args = harness.launches[0]!.args;
  assert.equal(args.includes("--strict-mcp-config"), true);
  assert.equal(argValue(args, "--mcp-config"), "/private/tmp/letagents-claude-mcp-test/mcp.json");
  assert.equal(JSON.stringify(args).includes("test-worker-token"), false, "worker auth never enters process argv");
  assert.equal(harness.mcpConfigDisposals, 1, "ephemeral MCP config is removed after init");
});

test("Claude launches with the managed commit identity for its work attempt", async () => {
  const identity = {
    GIT_AUTHOR_NAME: "octo-fake",
    GIT_AUTHOR_EMAIL: "424242+octo-fake@users.noreply.github.com",
    GIT_COMMITTER_NAME: "octo-fake",
    GIT_COMMITTER_EMAIL: "424242+octo-fake@users.noreply.github.com",
  };
  const harness = createHarness({ commitEnvironment: identity });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
  }));
  assert.equal(harness.commitRequests[0]?.cwd, spawnRequest().cwd);
  assert.equal(harness.commitRequests[0]?.supervisorEntryId, "manifest_exact");
  const env = harness.launches[0]?.env ?? {};
  for (const [key, value] of Object.entries(identity)) assert.equal(env[key], value, key);
  assert.equal(env.LETAGENTS_SUPERVISOR_ENTRY_ID, "manifest_exact", "the supervisor coordinates are kept");
});

test("managed Claude MCP config is private, official-runtime-only, and ephemeral outside the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-claude-mcp-test-"));
  try {
    const config = await createEphemeralClaudeMcpConfig({
      LETAGENTS_API_URL: "https://letagents.example",
      LETAGENTS_TOKEN: "test-worker-token",
    }, { entryPath: "/verified/runtime/dist/mcp/server.js", readRoots: ["/verified/runtime"] }, root);
    const parsed = JSON.parse(await readFile(config.path, "utf8"));
    assert.deepEqual(parsed, {
      mcpServers: {
        letagents: {
          command: process.execPath,
          args: ["/verified/runtime/dist/mcp/server.js"],
          env: {
            LETAGENTS_API_URL: "https://letagents.example",
            LETAGENTS_TOKEN: "test-worker-token",
            ELECTRON_RUN_AS_NODE: "1",
          },
        },
      },
    });
    assert.equal((await stat(config.path)).mode & 0o777, 0o600);
    await config.dispose();
    await assert.rejects(access(config.path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervised Claude builds its MCP workplace from the desktop endpoint without a user Claude config", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-claude-managed-endpoint-"));
  try {
    const config = await createManagedClaudeMcpConfig("https://desktop.letagents.example", root, "/explicit/dev/entry.js", entry => {
      assert.equal(entry, "/explicit/dev/entry.js");
      return { entryPath: entry!, readRoots: ["/explicit/dev"] };
    });
    const parsed = JSON.parse(await readFile(config.path, "utf8"));
    assert.deepEqual(parsed.mcpServers.letagents.env, {
      LETAGENTS_API_URL: "https://desktop.letagents.example",
      ELECTRON_RUN_AS_NODE: "1",
    });
    assert.equal(JSON.stringify(parsed).includes("LETAGENTS_TOKEN"), false);
    await config.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo-tracked legacy .mcp.json cannot override the supervised Claude workplace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "letagents-managed-workspace-"));
  try {
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({
      mcpServers: {
        letagents: {
          command: "npx",
          args: ["-y", "letagents"],
          cwd: workspace,
        },
      },
    }));
    const harness = createHarness();
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    await adapter.spawn(spawnRequest({ cwd: workspace }));
    const args = harness.launches[0]!.args;
    assert.equal(args.includes("--strict-mcp-config"), true);
    assert.equal(argValue(args, "--mcp-config"), "/private/tmp/letagents-claude-mcp-test/mcp.json");
    assert.equal(argValue(args, "--mcp-config")!.startsWith(workspace), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("launch policy is opaque but shape-checked: reserved flags and non-object policies are rejected before launch", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest({ launchPolicy: { resume: "sess-x" } })), /reserved flag 'resume'/);
  await assert.rejects(adapter.spawn(spawnRequest({ launchPolicy: { sessionId: "sess-x" } })), /reserved flag 'sessionId'/);
  await assert.rejects(adapter.spawn(spawnRequest({ launchPolicy: { noSessionPersistence: true } })), /reserved flag 'noSessionPersistence'/, "a policy may not disable the continuation");
  await assert.rejects(adapter.spawn(spawnRequest({ launchPolicy: { mcpConfig: "/tmp/other.json" } })), /reserved flag 'mcpConfig'/);
  await assert.rejects(adapter.spawn(spawnRequest({ launchPolicy: { strictMcpConfig: false } })), /reserved flag 'strictMcpConfig'/);
  await assert.rejects(adapter.spawn(spawnRequest({ launchPolicy: "bypassPermissions" })), /native CLI options object/);
  await assert.rejects(adapter.spawn(spawnRequest({ launchPolicy: { hooks: { PreToolUse: [] } } })), /must be a scalar/);
  assert.equal(harness.launches.length, 0, "nothing launched for a rejected policy");
});

test("claudeLaunchPolicyArgs maps keys mechanically without reinterpretation", () => {
  assert.deepEqual(
    claudeLaunchPolicyArgs({ permissionMode: "plan", allowedTools: ["Bash", "Read"], maxTurns: 3, verboseLogging: true }),
    ["--permission-mode", "plan", "--allowed-tools", "Bash,Read", "--max-turns", "3", "--verbose-logging"],
  );
});

test("claudeCliEnv strips launch blockers and ambient LetAgents credentials from bounded workers", () => {
  const env = claudeCliEnv({
    CLAUDECODE: "1",
    LETAGENTS_TOKEN: "owner-secret",
    LETAGENTS_AGENT_SESSION_BEARER: "fixed-worker-secret",
    HOME: "/Users/someone",
    ANTHROPIC_LOG: "debug",
  });
  assert.equal("CLAUDECODE" in env, false, "the spike-proven launch blocker is removed");
  assert.equal("LETAGENTS_TOKEN" in env, false, "owner authority cannot bypass the daemon generation");
  assert.equal("LETAGENTS_AGENT_SESSION_BEARER" in env, false, "fixed worker authority cannot bypass the daemon generation");
  assert.equal(env.HOME, "/Users/someone");
  assert.equal(env.ANTHROPIC_LOG, "debug");
});

test("Claude transcript discovery accepts native Windows and POSIX recursive paths", () => {
  assert.deepEqual(claudeSessionTranscriptCandidates([
    "project-a/session-exact.jsonl",
    "project-b\\session-exact.jsonl",
    "session-exact.jsonl",
    "project-c/session-other.jsonl",
  ], "session-exact"), [
    "project-a/session-exact.jsonl",
    "project-b\\session-exact.jsonl",
    "session-exact.jsonl",
  ]);
});

test("a CLI without the LetAgents workplace is terminated with no orphan", async () => {
  const harness = createHarness({ noLetagents: true });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest()), /refusing to launch without the room workplace/);
  assert.deepEqual(harness.signals[0], { pid: 4100, signal: "SIGTERM" });
  assert.equal(harness.children[0]!.alive, false, "the fresh child was terminated and awaited");
  assert.equal(harness.mcpConfigDisposals, 1, "startup refusal removes the private MCP config");
});

for (const options of [{ mcpStatus: "failed" }, { mcpStatus: "pending" }, { mcpTools: ["Bash", "Read"] },
  { mcpTools: ["mcp__letagents__get_board", "mcp__letagents__read_messages"] }]) {
  test(`Claude refuses an unusable room connection: ${JSON.stringify(options)}`, async () => {
    const harness = createHarness(options);
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    await assert.rejects(adapter.spawn(spawnRequest()), /room tools did not connect/);
    assert.equal(harness.children[0]!.alive, false);
    assert.equal(harness.mcpConfigDisposals, 1);
  });
}

test("startup identity failure terminates and awaits the known fresh child", async () => {
  const identities = new Map<number, string | null | undefined>([[4100, undefined]]);
  const harness = createHarness({ identities });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest()), /process identity could not be verified/);
  assert.deepEqual(harness.signals[0], { pid: 4100, signal: "SIGTERM" });
  assert.equal(harness.children[0]!.alive, false);
  assert.equal(harness.children[0]!.written.length, 0, "no prompt reaches an unfenceable writer");
});

test("a silent CLI that never reports init is refused as unobservable, with no orphan", async () => {
  const harness = createHarness({ noInit: true });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
  await assert.rejects(adapter.spawn(spawnRequest()), /did not report its stream-json init/);
  assert.deepEqual(harness.signals[0], { pid: 4100, signal: "SIGTERM" });
  assert.equal(harness.children[0]!.alive, false);
});

test("a turn-limit failure during Claude bootstrap still rejects startup and reaps the child", async () => {
  const harness = createHarness({ bootstrapResultSubtype: "error_max_turns" });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest()), {
    name: "ClaudeBootstrapError", phase: "bootstrap_turn", reason: "failed_response",
  });
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.children[0]!.alive, false);
  assert.equal(harness.mcpConfigDisposals, 1);
});

for (const mode of ["deadline", "failed_response", "native_exit", "transport_error", "cleanup_error", "init_deadline"] as const) {
  test(`failed acquisition retains only exact death evidence: ${mode}`, async () => {
    const harness = createHarness({ noInit: mode === "init_deadline", omitBootstrapResult: mode !== "failed_response",
      ...(mode === "failed_response" ? { bootstrapResultSubtype: "error_max_turns" } : {}) });
    const request = spawnRequest({ supervisorEntryId: "entry-1", supervisorExecutionGenerationId: "generation-1" });
    if (mode === "native_exit" || mode === "transport_error") {
      const launch = harness.dependencies.launchChild;
      harness.dependencies.launchChild = input => {
        const child = launch(input) as FakeClaudeChild;
        const write = child.writeLine.bind(child);
        child.writeLine = line => {
          write(line);
          setImmediate(() => {
            if (mode === "native_exit") {
              harness.identities.set(child.pid!, null);
              child.resolveExit({ type: "exit", code: 7, signal: null });
            } else child.resolveExit({ type: "error", error: new Error("private transport payload") });
          });
        };
        return child;
      };
    }
    if (mode === "cleanup_error") harness.dependencies.signalProcess = () => { throw new Error("cleanup signal rejected"); };
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
    try {
      await assert.rejects(withLoopAlive(adapter.spawn(request)), error => {
        const evidence = providerAcquisitionEvidence(error, providerAcquisitionIdentity("claude-code", request));
        if (["deadline", "failed_response", "native_exit"].includes(mode)) {
          assert.ok(evidence, "adapter-confirmed death must survive the rejected acquisition");
          assert.deepEqual(evidence.terminal.nativeRuntimeDeath, {
            kind: "claude_cli", pid: 4100, processIdentity: "fake-claude-4100-birth-1",
          });
          assert.equal(evidence.terminal.providerContinuationId, argValue(harness.launches[0]!.args, "--session-id"));
          assert.equal(evidence.terminal.exitCode, mode === "native_exit" ? 7 : null);
          assert.equal(evidence.terminal.signal, mode === "native_exit" ? null : "SIGTERM");
          assert.equal(adapter.runtimeCustody(request.workAttemptId), "absent");
        } else {
          assert.equal(evidence, undefined, "unknown custody or unverified init must not invent a receipt");
          if (mode !== "init_deadline") assert.equal(adapter.runtimeCustody(request.workAttemptId), "unknown");
        }
        return true;
      });
      assert.equal(harness.launches.length, 1);
      assert.equal(harness.children[0]!.written.length, 1);
    } finally {
      harness.identities.set(4100, null);
      harness.children[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
      await flush();
    }
  });
}

test("failed resumed acquisition binds death to the saved continuation and immutable request", async () => {
  const harness = createHarness({ omitBootstrapResult: true });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
  const request = spawnRequest({ supervisorEntryId: "entry-1", supervisorExecutionGenerationId: "generation-1" });
  const saved = "saved-claude-continuation";
  const expected = providerAcquisitionIdentity("claude-code", request, saved);
  await assert.rejects(withLoopAlive(adapter.resume({ workAttemptId: request.workAttemptId, providerContinuationId: saved }, request)), error => {
    const evidence = providerAcquisitionEvidence(error, expected);
    assert.ok(evidence?.terminal.nativeRuntimeDeath);
    assert.equal(evidence.terminal.providerContinuationId, saved);
    request.supervisorExecutionGenerationId = "later-generation";
    assert.throws(() => providerAcquisitionEvidence(error, providerAcquisitionIdentity("claude-code", request, saved)), /does not match/);
    assert.throws(() => providerAcquisitionEvidence(error, { ...expected!, continuationId: "another-continuation" }), /does not match/);
    assert.equal(providerAcquisitionEvidence({ ...error as Error }, expected), undefined, "structural error copies are not operational evidence");
    assert.equal(providerAcquisitionEvidence(error, expected), evidence);
    return true;
  });
});

test("a resumed conversation gets the longer startup budget a cold re-read needs; a fresh session does not", async () => {
  for (const mode of ["resume", "fresh"] as const) {
    const harness = createHarness({ omitBootstrapResult: true });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40, resumeInitTimeoutMs: 2_000 });
    const request = spawnRequest({ workAttemptId: `wa-claude-${mode}` });
    const starting = mode === "resume"
      ? adapter.resume({ workAttemptId: request.workAttemptId, providerContinuationId: "saved-claude-continuation" }, request)
      : adapter.spawn(request);
    const outcome = starting.then(() => "ready", (error: unknown) => error);
    while (!harness.children[0]?.written.length) await new Promise((resolve) => setImmediate(resolve));
    const child = harness.children[0]!;
    const bootstrapTurn = (JSON.parse(child.written[0]!) as { uuid: string }).uuid;
    const sessionId = argValue(harness.launches[0]!.args, "--resume") ?? argValue(harness.launches[0]!.args, "--session-id");
    // The answer arrives well after the fresh-session budget, as a cold
    // re-read of a large saved conversation does.
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (child.alive) child.emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId,
      user_message_uuid: bootstrapTurn, result: "LETAGENTS_CLAUDE_DAEMON_READY" });
    const settled = await withLoopAlive(outcome);
    if (mode === "resume") {
      assert.equal(settled, "ready", "the resumed conversation finished its bootstrap inside its own budget");
      assert.equal(child.alive, true);
      harness.identities.set(child.pid!, null);
      child.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
      await flush();
    } else {
      assert.ok(settled instanceof Error);
      assert.match(settled.message, /bootstrap turn \(deadline\).*budget_ms=40/);
      assert.equal(child.alive, false);
    }
  }
});

test("Claude reports its process up once init is verified, before the bootstrap turn answers", async () => {
  const harness = createHarness({ omitBootstrapResult: true });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 2_000 });
  const hints: string[] = [];
  const request = spawnRequest({ workAttemptId: "wa-claude-native-start" });
  request.onNativeStarted = () => { hints.push(harness.children[0]?.written.length ? "after-init" : "before-launch"); };
  const starting = adapter.resume({ workAttemptId: request.workAttemptId, providerContinuationId: "saved-claude-continuation" }, request);
  for (let wait = 0; wait < 200 && !hints.length; wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(hints, ["after-init"], "the hint follows a verified init, while the bootstrap turn is still open");
  const child = harness.children[0]!;
  const bootstrapTurn = (JSON.parse(child.written[0]!) as { uuid: string }).uuid;
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: "saved-claude-continuation",
    user_message_uuid: bootstrapTurn, result: "LETAGENTS_CLAUDE_DAEMON_READY" });
  await withLoopAlive(starting);
  assert.deepEqual(hints, ["after-init"], "reported once");
  harness.identities.set(child.pid!, null);
  child.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();
});

test("a CLI that never reports init never claims its process is up", async () => {
  const harness = createHarness({ noInit: true });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
  let hinted = false;
  const request = spawnRequest({ workAttemptId: "wa-claude-no-init" });
  request.onNativeStarted = () => { hinted = true; };
  await assert.rejects(adapter.spawn(request), /did not report its stream-json init/);
  assert.equal(hinted, false);
});

// api_retry has the published SDKAPIRetryMessage shape. This reproduces the
// capture boundary, not the native cause of any historical live failure.
for (const withOptionalSink of [false, true]) {
  test(`bootstrap retry diagnostic survives rejected acquisition (optional sink: ${withOptionalSink})`, async () => {
    const harness = createHarness({ omitBootstrapResult: true });
    const saved = "saved-bootstrap-diagnostic-session";
    const retry = {
      type: "system", subtype: "api_retry", session_id: saved,
      uuid: "00000000-0000-4000-8000-000000000001",
      attempt: 1, max_retries: 10, retry_delay_ms: 1000,
      error_status: 529, error: "overloaded",
    };
    let emitted = 0;
    const launch = harness.dependencies.launchChild;
    harness.dependencies.launchChild = input => {
      const child = launch(input) as FakeClaudeChild;
      const write = child.writeLine.bind(child);
      child.writeLine = line => {
        write(line);
        queueMicrotask(() => { emitted += 1; child.emit(retry); });
      };
      return child;
    };
    const streams: ProviderStreamEvent[] = [];
    const adapter = new ClaudeCodeProviderAdapter({
      dependencies: harness.dependencies, initTimeoutMs: 40,
      ...(withOptionalSink ? { streamSink: (event: ProviderStreamEvent) => streams.push(event) } : {}),
    });
    const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
    const request = { ...spawnRequest({ supervisorEntryId: "entry-diagnostic",
      supervisorExecutionGenerationId: "execution-diagnostic" }), provider: "claude-code" };
    let admitted = false;
    let rejected: Error | null = null;
    await assert.rejects(withLoopAlive(router.resume({ workAttemptId: request.workAttemptId,
      provider: "claude-code", providerContinuationId: saved }, request).then(() => {
      admitted = true;
    })), error => {
      assert.ok(error instanceof Error);
      rejected = error;
      assert.equal(error.name, "ClaudeBootstrapError");
      assert.equal((error as Error & { phase: string }).phase, "bootstrap_turn");
      assert.equal((error as Error & { reason: string }).reason, "deadline");
      const evidence = providerAcquisitionEvidence(error, providerAcquisitionIdentity("claude-code", request, saved));
      assert.ok(evidence?.terminal.nativeRuntimeDeath, "existing exact death evidence still survives");
      assert.equal(evidence.terminal.providerContinuationId, saved);
      assert.match(error.message, /last_api_retry=overloaded \(HTTP 529\)/);
      assert.doesNotMatch(error.message, /retry_delay_ms|uuid|saved-bootstrap-diagnostic-session/);
      assert.match(error.message, /stdout_lines=2; matched_session_lines=2; stderr_bytes=unavailable/);
      assert.doesNotMatch(JSON.stringify(evidence), /api_retry|overloaded|529/,
        "diagnostics never change the operational death receipt");
      return true;
    });
    assert.equal(emitted, 1);
    assert.equal(admitted, false, "failed startup must not admit a handle");
    assert.deepEqual(router.runtimeCustody(request.workAttemptId, "claude-code"), { state: "absent" });
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.children[0]!.written.length, 1);
    assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
    assert.equal(harness.mcpConfigDisposals, 1);
    const retryEvents = streams.filter(event => event.method === "system/api_retry");
    assert.equal(retryEvents.length, withOptionalSink ? 1 : 0,
      "positive control proves the adapter consumes the event before failure");
    if (withOptionalSink) assert.deepEqual(retryEvents[0]!.payload, retry);

    const projected: string[] = [];
    const entry = { id: "entry-diagnostic", desired_state: "running", observed_state: "recovering",
      condition: "none", work_attempt_id: request.workAttemptId };
    const scheduler = new ProviderSchedulerFailureCoordinator({
      nativeHeartbeatIntervalMs: 1000, currentDaemonGeneration: () => 1, nowMs: () => 0,
      serializeEntry: async (_id: string, operation: () => Promise<unknown>) => operation(),
      serializeManifest: async (operation: () => Promise<unknown>) => operation(),
      manifest: { load: async () => ({ entries: [entry] }), updateEntry: async () => { throw new Error("must not reset continuation"); } },
      transitionOnce: async (_id: string, _state: string, condition: string, message: string) => {
        assert.equal(condition, "coordination_blocked"); projected.push(message);
      },
      audit: { append: async () => {} },
      scheduleRecovery: () => { throw new Error("diagnostics must not authorize a retry"); },
    });
    await scheduler.record(entry.id, rejected, "test");
    assert.equal(projected.length, 1);
    assert.match(projected[0]!, /last_api_retry=overloaded \(HTTP 529\)/,
      "the existing saved-failure transition receives the useful diagnostic");
  });
}

// SDKStatusMessage and SDKHookResponseMessage carry these fixed enums.
// Retain the observed distinction, not the cause of a historical native stall.
test("bootstrap diagnostics distinguish observed progress at the appropriate bounded deadline", async () => {
  const diagnostics: string[] = [];
  for (const category of ["compacting", "requesting", "hook_error"] as const) {
    const privateText = "private-hook-output-token";
    const harness = createHarness({ omitBootstrapResult: true, bootstrapMessages: sessionId =>
      Array.from({ length: 3 }, () => category === "hook_error"
        ? { type: "system", subtype: "hook_response", outcome: "error", session_id: sessionId,
          hook_id: privateText, hook_name: privateText, hook_event: privateText,
          output: privateText, stdout: privateText, stderr: privateText, exit_code: 1 }
        : { type: "system", subtype: "status", status: category, session_id: sessionId }),
    });
    const streams: ProviderStreamEvent[] = [];
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40, compactionTimeoutMs: 40,
      streamSink: event => streams.push(event),
    });
    const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
    const request = { ...spawnRequest({ supervisorEntryId: "entry-progress",
      supervisorExecutionGenerationId: "execution-progress" }), provider: "claude-code" };
    const saved = "saved-progress-session";
    await assert.rejects(withLoopAlive(router.resume({ workAttemptId: request.workAttemptId,
      provider: "claude-code", providerContinuationId: saved }, request)), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ClaudeBootstrapError");
      assert.match(error.message, category === "compacting" ? /bootstrap turn \(compaction_deadline\)/ : /bootstrap turn \(deadline\)/);
      assert.match(error.message, /stdout_lines=4; matched_session_lines=4/);
      assert.match(error.message, /api_retry_count=0; assistant_count=0; result_count=0/);
      const expected = category === "hook_error" ? "system.hook_response.error" : `system.status.${category}`;
      assert.ok(error.message.includes(`last_line_type=${expected}`));
      assert.ok(error.message.includes(`line_types=system.init:1,${expected}:3`));
      assert.match(error.message, /last_line_ms=\d+/);
      assert.doesNotMatch(error.message, /private-hook-output-token|saved-progress-session/);
      diagnostics.push(error.message.replace(/(?:init_ms|bootstrap_ms|last_line_ms)=\d+/g, "elapsed_ms=<measured>"));
      const safe = redactCredentialText(error.message);
      assert.equal(safe.value, error.message);
      assert.equal(safe.redacted, false);
      assert.equal(safe.truncated, false);
      const evidence = providerAcquisitionEvidence(error, providerAcquisitionIdentity("claude-code", request, saved));
      assert.ok(evidence?.terminal.nativeRuntimeDeath);
      return true;
    });
    const observed = streams.filter(event => event.method !== "system/init");
    assert.equal(observed.length, 3, "positive control: the adapter consumed all three progress events");
    for (const event of observed) {
      const payload = event.payload as Record<string, unknown>;
      assert.equal(event.method, category === "hook_error" ? "system/hook_response" : "system/status");
      assert.equal(category === "hook_error" ? payload.outcome : payload.status,
        category === "hook_error" ? "error" : category);
    }
    assert.deepEqual(router.runtimeCustody(request.workAttemptId, "claude-code"), { state: "absent" });
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.children[0]!.written.length, 1);
    assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
    assert.equal(harness.mcpConfigDisposals, 1);
  }
  assert.equal(new Set(diagnostics).size, 3, "progress categories survive without relying on elapsed-time differences");
});

for (const [apiError, expected] of [
  ["rate_limit", { providerQuotaExhausted: true, transientProviderStart: undefined }],
  ["overloaded", { providerQuotaExhausted: undefined, transientProviderStart: true }],
  ["server_error", { providerQuotaExhausted: undefined, transientProviderStart: true }],
  ["authentication_failed", { providerQuotaExhausted: undefined, transientProviderStart: undefined }],
] as const) {
  test(`a bootstrap turn Claude rejects with ${apiError} is classified for the scheduler`, async () => {
    const harness = createHarness({
      bootstrapResultSubtype: "success",
      bootstrapMessages: sessionId => [{ type: "assistant", session_id: sessionId, error: apiError,
        message: { content: [{ type: "text", text: "limit" }] } }],
    });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
    await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest())), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`\\(failed_response\\).*assistant_error=${apiError}`));
      const flags = error as { providerQuotaExhausted?: true; transientProviderStart?: true };
      assert.equal(flags.providerQuotaExhausted, expected.providerQuotaExhausted);
      assert.equal(flags.transientProviderStart, expected.transientProviderStart);
      return true;
    });
  });
}

// The CLI's SDKRateLimitEvent: rate_limit_info.resetsAt is epoch seconds and only a rejected window blocks the turn.
for (const [name, events, expectedResetMs] of [
  ["a rejected window names when the limit resets", sessionId => [
    { type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "allowed_warning", resetsAt: 1_790_000_100, rateLimitType: "five_hour" } },
    { type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "rejected", resetsAt: 1_790_000_000, rateLimitType: "seven_day" } },
  ], 1_790_000_000_000],
  ["the latest of several rejected windows is the reset", sessionId => [
    { type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "rejected", resetsAt: 1_790_050_000, rateLimitType: "seven_day" } },
    { type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "rejected", resetsAt: 1_790_000_000, rateLimitType: "five_hour" } },
  ], 1_790_050_000_000],
  ["no event leaves the reset time unknown", () => [], undefined],
  ["a window that is not rejected is not a reset time", sessionId => [
    { type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "allowed", resetsAt: 1_790_000_000 } },
  ], undefined],
  ["a millisecond value is not trusted as seconds", sessionId => [
    { type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "rejected", resetsAt: 1_790_000_000_000 } },
  ], undefined],
  ["a rejection without a reset time stays unknown", sessionId => [
    { type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "rejected" } },
  ], undefined],
] as const satisfies ReadonlyArray<readonly [string, (sessionId: string) => Record<string, unknown>[], number | undefined]>) {
  test(`a usage-limit bootstrap rejection: ${name}`, async () => {
    const harness = createHarness({
      bootstrapResultSubtype: "success",
      bootstrapMessages: sessionId => [...events(sessionId), { type: "assistant", session_id: sessionId, error: "rate_limit",
        message: { content: [{ type: "text", text: "limit" }] } }],
    });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
    await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest())), (error: unknown) => {
      assert.ok(error instanceof Error);
      const flags = error as { providerQuotaExhausted?: true; providerQuotaResetsAtMs?: number };
      assert.equal(flags.providerQuotaExhausted, true, "still classified as a usage limit");
      assert.equal(flags.providerQuotaResetsAtMs, expectedResetMs);
      if (expectedResetMs === undefined) assert.doesNotMatch(error.message, /usage_limit_resets_at/);
      else assert.match(error.message, new RegExp(`assistant_error=rate_limit; usage_limit_resets_at=${new Date(expectedResetMs).toISOString()};`));
      return true;
    });
  });
}

test("a reset time never marks another API error as a usage limit", async () => {
  const harness = createHarness({
    bootstrapResultSubtype: "success",
    bootstrapMessages: sessionId => [
      { type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "rejected", resetsAt: 1_790_000_000 } },
      { type: "assistant", session_id: sessionId, error: "authentication_failed", message: { content: [{ type: "text", text: "no" }] } },
    ],
  });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
  await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest())), (error: unknown) => {
    const flags = error as { providerQuotaExhausted?: true; providerQuotaResetsAtMs?: number };
    assert.equal(flags.providerQuotaExhausted, undefined);
    assert.equal(flags.providerQuotaResetsAtMs, undefined);
    return true;
  });
});

test("a bootstrap deadline stays unretried even after Claude reported a rate-limit retry", async () => {
  const harness = createHarness({
    omitBootstrapResult: true,
    bootstrapMessages: sessionId => [{ type: "system", subtype: "api_retry", session_id: sessionId,
      error: "rate_limit", error_status: 429, attempt: 1, retry_delay_ms: 1000 }],
  });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
  await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest())), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /\(deadline\)/);
    const flags = error as { providerQuotaExhausted?: true; transientProviderStart?: true };
    assert.equal(flags.providerQuotaExhausted, undefined, "a stalled resume can cost tokens; only an explicit rejection retries");
    assert.equal(flags.transientProviderStart, undefined);
    return true;
  });
});

test("post-init bootstrap diagnostics count a retry storm without changing the deadline", async () => {
  const harness = createHarness({ omitBootstrapResult: true });
  let emittedAfterInit = false;
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40,
    streamSink: event => {
      if (event.method !== "system/init") return;
      emittedAfterInit = true;
      for (const [index, category] of ["billing_error", "rate_limit", "overloaded"].entries()) {
        harness.children[0]!.emit({ type: "system", subtype: "api_retry", session_id: event.providerContinuationId,
          error: category, error_status: [402, 429, 529][index], attempt: index + 1, retry_delay_ms: 1000 });
      }
    },
  });
  await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest())), error => {
    assert.ok(error instanceof Error);
    assert.equal(emittedAfterInit, true);
    assert.match(error.message, /\(deadline\).*last_api_retry=overloaded \(HTTP 529\)/);
    assert.match(error.message, /api_retry_count=3; assistant_count=0; result_count=0/);
    assert.doesNotMatch(error.message, /billing_error|rate_limit|retry_delay_ms/);
    const safe = redactCredentialText(error.message);
    assert.equal(safe.value, error.message);
    assert.equal(safe.redacted, false);
    assert.equal(safe.truncated, false);
    return true;
  });
  assert.equal(harness.children[0]!.written.length, 1);
  assert.equal(harness.mcpConfigDisposals, 1);
});

for (const scenario of ["preinit", "foreign", "private_fields", "compact_result", "histogram_cap", "total_cap", "cleanup"] as const) {
  test(`bootstrap progress observations remain bounded and passive: ${scenario}`, async () => {
    const privateText = "private-progress-token";
    const harness = createHarness({ noInit: scenario === "preinit", omitBootstrapResult: true,
      bootstrapMessages: (sessionId, turnId) => {
        const base = { session_id: sessionId, uuid: privateText };
        if (scenario === "preinit") return [{ ...base, type: "system", subtype: "status", status: "requesting" }];
        if (scenario === "foreign") return [
          { ...base, type: "command_lifecycle", command_uuid: turnId, state: "started" },
          { type: "system", subtype: "status", status: "compacting", session_id: "other-session" },
          { type: "control_request", request: { subtype: "can_use_tool", input: privateText } },
        ];
        if (scenario === "private_fields") return [
          { ...base, type: privateText, subtype: privateText },
          { ...base, type: "system", subtype: privateText },
          { ...base, type: "system", subtype: "status", status: privateText, compact_result: privateText, compact_error: privateText },
          { ...base, type: "system", subtype: "hook_response", outcome: privateText, output: privateText, stderr: privateText },
          { ...base, type: "system", subtype: "session_state_changed", state: privateText },
          { ...base, type: "command_lifecycle", state: privateText, command_uuid: privateText },
        ];
        if (scenario === "compact_result") return [
          { ...base, type: "system", subtype: "status", status: "compacting" },
          { ...base, type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: privateText },
        ];
        if (scenario === "histogram_cap") return ["hook_started", "hook_progress", "compact_boundary", "commands_changed",
          "background_tasks_changed", "files_persisted", "notification", "informational", "thinking_tokens", "worker_shutting_down"]
          .map(subtype => ({ ...base, type: "system", subtype, output: privateText, reason: privateText }));
        if (scenario === "total_cap") return [
          { ...base, type: "system", subtype: "api_retry", error: "authentication_failed", error_status: 401 },
          { ...base, type: "assistant", error: "oauth_org_not_allowed" },
          { ...base, type: "result", subtype: "error_max_structured_output_retries", user_message_uuid: "other-turn", is_error: true },
          { ...base, type: "auth_status", isAuthenticating: true },
          { ...base, type: "system", subtype: "status", status: "requesting", compact_result: "failed" },
        ];
        return [];
      },
    });
    if (scenario === "cleanup") {
      const signal = harness.dependencies.signalProcess;
      harness.dependencies.signalProcess = (pid, kind) => {
        const session = argValue(harness.launches[0]!.args, "--session-id")!;
        harness.children[0]!.emit({ type: "system", subtype: "hook_response", outcome: "error", session_id: session });
        return signal(pid, kind);
      };
    }
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
    await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest())), error => {
      assert.ok(error instanceof Error);
      const suffix = `Startup observations: ${error.message.split("Startup observations: ")[1]}`;
      assert.ok(suffix.length <= 512, suffix);
      assert.doesNotMatch(error.message, new RegExp(privateText));
      const safe = redactCredentialText(error.message);
      assert.equal(safe.value, error.message);
      assert.equal(safe.redacted, false);
      assert.equal(safe.truncated, false);
      if (scenario === "preinit") {
        assert.match(error.message, /bootstrap_ms=not_started/);
        assert.match(error.message, /last_line_type=system.status.requesting; last_line_ms=\d+/);
        assert.match(error.message, /line_types=system.status.requesting:1/);
      }
      if (scenario === "foreign") {
        assert.match(error.message, /stdout_lines=4; matched_session_lines=2/);
        assert.match(error.message, /last_line_type=command_lifecycle.started/);
        assert.match(error.message, /line_types=system.init:1,command_lifecycle.started:1/);
        assert.doesNotMatch(error.message, /compacting|control_request/);
      }
      if (scenario === "private_fields") {
        assert.match(error.message, /last_line_type=command_lifecycle.unlisted/);
        assert.match(error.message, /line_types=system.init:1,unlisted:1,system.unlisted:1/);
        assert.match(error.message, /system.status.unlisted.compact_unlisted:1/);
      }
      if (scenario === "compact_result") {
        assert.match(error.message, /last_line_type=system.status.cleared.compact_failed/);
        assert.match(error.message, /line_types=system.init:1,system.status.compacting:1,system.status.cleared.compact_failed:1/);
      }
      if (scenario === "histogram_cap") {
        assert.match(error.message, /last_line_type=system.worker_shutting_down/);
        const histogram = suffix.match(/line_types=([^;]+)\./)![1]!;
        const parts = histogram.split(",");
        const omitted = Number(parts.pop()!.split(":")[1]);
        assert.ok(omitted > 0);
        assert.ok(parts.length <= 8);
        assert.equal(parts.length + omitted, 11, "all omitted distinct types are disclosed");
        assert.ok(histogram.length <= 210);
      }
      if (scenario === "total_cap") {
        assert.match(error.message, /last_api_retry=authentication_failed \(HTTP 401\)/);
        assert.match(error.message, /assistant_error=oauth_org_not_allowed/);
        assert.match(error.message, /uncorrelated_result=error_max_structured_output_retries/);
        assert.match(error.message, /last_line_type=system.status.requesting.compact_failed; last_line_ms=\d+/);
        assert.match(error.message, /omitted_fields=\d+/);
        assert.doesNotMatch(error.message, /line_types=/, "the histogram yields to existing error categories and last observed progress");
      }
      if (scenario === "cleanup") {
        assert.match(error.message, /last_line_type=system.init/);
        assert.doesNotMatch(error.message, /hook_response/);
      }
      return true;
    });
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.children[0]!.written.length, 1);
    assert.equal(harness.mcpConfigDisposals, 1);
    assert.equal(adapter.runtimeCustody("wa-claude-1"), "absent");
  });
}

for (const scenario of ["foreign_session", "private_error", "foreign_turn", "assistant_error", "failed_result", "unlisted_result", "no_http_response", "auth_status", "result_without_turn_id"] as const) {
  test(`bootstrap diagnostics retain only bounded correlated categories: ${scenario}`, async () => {
    const secret = "private-token-and-native-message";
    const harness = createHarness({ omitBootstrapResult: true, bootstrapMessages: (sessionId, turnId) => {
      const base = { session_id: sessionId, private_field: secret };
      switch (scenario) {
        case "foreign_session": return [{ ...base, type: "system", subtype: "api_retry", session_id: "other-session", error: "billing_error", error_status: 402 }];
        case "private_error": return [{ ...base, type: "system", subtype: "api_retry", error: secret, error_status: secret }];
        case "foreign_turn": return [{ ...base, type: "result", subtype: "error_max_turns", user_message_uuid: "other-turn", is_error: true, errors: [secret] }];
        case "assistant_error": return [{ ...base, type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: secret }] } }];
        case "failed_result": return [{ ...base, type: "result", subtype: "error_max_turns", user_message_uuid: turnId, is_error: true, errors: [secret] }];
        case "unlisted_result": return [{ ...base, type: "result", subtype: secret, user_message_uuid: turnId, is_error: true, errors: [secret] }];
        case "no_http_response": return [{ ...base, type: "system", subtype: "api_retry", error: "unknown", error_status: null }];
        case "auth_status": return [{ ...base, type: "auth_status", isAuthenticating: true, error: secret, output: [secret] }];
        case "result_without_turn_id": return [{ ...base, type: "result", subtype: "error_max_turns", is_error: true, errors: [secret] }];
      }
    } });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
    await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest())), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, new RegExp(secret));
      assert.ok(error.message.split("Startup observations: ")[1]!.length <= 512);
      assert.match(error.message, /init_ms=\d+; bootstrap_ms=\d+; budget_ms=40/);
      if (scenario === "foreign_session") assert.doesNotMatch(error.message, /billing_error|HTTP 402|last_api_retry=/);
      if (scenario === "private_error") assert.match(error.message, /last_api_retry=unlisted \(HTTP unlisted\)/);
      if (scenario === "foreign_turn" || scenario === "result_without_turn_id") {
        assert.match(error.message, /\(deadline\).*uncorrelated_result=error_max_turns/);
        assert.match(error.message, /result_count=1/);
        assert.doesNotMatch(error.message, /(?:^|; )result=/);
      }
      if (scenario === "assistant_error") assert.match(error.message, /assistant_error=authentication_failed/);
      if (scenario === "failed_result") assert.match(error.message, /\(failed_response\).*result=error_max_turns/);
      if (scenario === "unlisted_result") assert.match(error.message, /result=unlisted/);
      if (scenario === "no_http_response") assert.match(error.message, /last_api_retry=unknown \(HTTP none\)/);
      if (scenario === "auth_status") assert.match(error.message, /auth_status_count=1; authenticating=true/);
      const safe = redactCredentialText(error.message);
      assert.equal(safe.value, error.message);
      assert.equal(safe.redacted, false);
      assert.equal(safe.truncated, false);
      return true;
    });
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.children[0]!.written.length, 1);
    assert.equal(harness.mcpConfigDisposals, 1);
  });
}

for (const stderr of [0, 123, "unavailable"] as const) {
  test(`init deadline keeps stderr volume ${stderr} separate from native content and custody`, async () => {
    const harness = createHarness({ noInit: true });
    const launch = harness.dependencies.launchChild;
    harness.dependencies.launchChild = input => {
      const child = launch(input);
      child.stderrBytesRead = () => {
        if (stderr === "unavailable") throw new Error("private stderr read failure");
        return stderr;
      };
      return child;
    };
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
    const request = spawnRequest({ supervisorEntryId: "entry-init", supervisorExecutionGenerationId: "execution-init" });
    await assert.rejects(withLoopAlive(adapter.spawn(request)), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\(deadline\).*bootstrap_ms=not_started.*stdout_lines=0; matched_session_lines=0/);
      assert.ok(error.message.includes(`stderr_bytes=${stderr}`));
      assert.doesNotMatch(error.message, /private stderr/);
      assert.equal(providerAcquisitionEvidence(error, providerAcquisitionIdentity("claude-code", request)), undefined,
        "diagnostics on an uninitialized child must not invent operational evidence");
      return true;
    });
    assert.equal(harness.launches.length, 1);
    assert.equal(harness.mcpConfigDisposals, 1);
  });
}

test("pre-init matching-session diagnostics survive without admitting native custody", async () => {
  const harness = createHarness({ noInit: true, bootstrapMessages: sessionId => [
    { type: "system", subtype: "api_retry", session_id: sessionId, error: "rate_limit", error_status: 429 },
    { type: "auth_status", session_id: sessionId, isAuthenticating: false, error: "private native text" },
  ] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
  const request = spawnRequest({ supervisorEntryId: "entry-preinit", supervisorExecutionGenerationId: "execution-preinit" });
  await assert.rejects(withLoopAlive(adapter.spawn(request)), error => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { phase: string }).phase, "init");
    assert.match(error.message, /last_api_retry=rate_limit \(HTTP 429\)/);
    assert.match(error.message, /auth_status_count=1; authenticating=false/);
    assert.match(error.message, /bootstrap_ms=not_started/);
    assert.match(error.message, /stdout_lines=2; matched_session_lines=2/);
    assert.doesNotMatch(error.message, /private native text/);
    assert.equal(providerAcquisitionEvidence(error, providerAcquisitionIdentity("claude-code", request)), undefined);
    return true;
  });
  assert.equal(harness.launches.length, 1);
  assert.equal(harness.children[0]!.written.length, 1);
});

test("default child retains stderr byte count without its text", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-startup-diagnostic-test-"));
  const executable = join(directory, "inert-cli.cjs");
  const privateText = "private-stderr-token-12345\n";
  await writeFile(executable, `#!${process.execPath}\n`
    + `process.stderr.write(${JSON.stringify(privateText)});\n`
    + "process.stdin.resume(); setInterval(() => {}, 1000);\n", { mode: 0o700 });
  const adapter = new ClaudeCodeProviderAdapter({ claudeBin: executable, initTimeoutMs: 5000,
    dependencies: { readVersion: async () => "2.1.220 (Claude Code)",
      createLetAgentsMcpConfig: async () => ({ path: join(directory, "unused.json"), dispose: async () => {} }) },
  });
  try {
    await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest({ cwd: directory }))), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`stderr_bytes=${Buffer.byteLength(privateText)}`));
      assert.match(error.message, /bootstrap_ms=not_started/);
      assert.doesNotMatch(error.message, /private-stderr-token/);
      return true;
    });
    assert.equal(adapter.runtimeCustody("wa-claude-1"), "absent");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const phase of ["init", "bootstrap_turn"] as const) {
  for (const reason of ["deadline", "native_exit", "transport_error"] as const) {
    test(`Claude ${phase} preserves ${reason} without changing native custody`, async () => {
      const harness = createHarness({ noInit: phase === "init", omitBootstrapResult: true });
      const launch = harness.dependencies.launchChild;
      if (reason !== "deadline") {
        harness.dependencies.launchChild = input => {
          const child = launch(input) as FakeClaudeChild;
          const write = child.writeLine.bind(child);
          child.writeLine = json => {
            write(json);
            setImmediate(() => {
              if (reason === "native_exit") {
                harness.identities.set(child.pid!, null);
                child.resolveExit({ type: "exit", code: 7, signal: null });
              } else {
                child.resolveExit({ type: "error", error: new Error("private transport payload") });
              }
            });
          };
          return child;
        };
      }
      const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 40 });
      try {
        await assert.rejects(withLoopAlive(adapter.spawn(spawnRequest())), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "ClaudeBootstrapError");
          assert.equal((error as Error & { phase: string }).phase, phase);
          assert.equal((error as Error & { reason: string }).reason, reason);
          assert.match(error.message, new RegExp(reason));
          assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private transport payload/);
          if (reason === "native_exit") {
            assert.equal((error as Error & { exitCode: number }).exitCode, 7);
            assert.equal((error as Error & { signal: unknown }).signal, null);
          }
          return true;
        });
        assert.equal(harness.launches.length, 1);
        assert.equal(harness.children[0]!.written.length, 1);
        assert.equal(harness.mcpConfigDisposals, 1);
        assert.equal(adapter.runtimeCustody("wa-claude-1"), reason === "transport_error" ? "unknown" : "absent");
        assert.deepEqual(harness.signals, reason === "deadline" ? [{ pid: 4100, signal: "SIGTERM" }] : []);
      } finally {
        harness.identities.set(4100, null);
        await flush();
      }
    });
  }
}

for (const failed of [false, true]) {
  for (const exit of [{ type: "exit", code: 7, signal: null },
    { type: "error", error: new Error("private transport payload") }] as const) {
    test(`exact bootstrap ${failed ? "failure" : "success"} keeps precedence over same-batch ${exit.type}`, async () => {
      const harness = createHarness({
        ...(failed ? { bootstrapResultSubtype: "error_max_turns" } : {}),
        exitAfterBootstrapResult: exit,
      });
      const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
      try {
        if (failed) {
          await assert.rejects(adapter.spawn(spawnRequest()), {
            name: "ClaudeBootstrapError", phase: "bootstrap_turn", reason: "failed_response",
          });
        } else {
          const handle = await adapter.spawn(spawnRequest());
          assert.equal(handle.providerContinuationId, argValue(harness.launches[0]!.args, "--session-id"));
        }
      } finally {
        harness.identities.set(4100, null);
        await flush();
      }
    });
  }
}

test("failed Claude bootstrap retains rejected native custody until exact physical retirement", async () => {
  const options: HarnessOptions = { noInit: true };
  const harness = createHarness(options);
  harness.dependencies.signalProcess = () => { throw new Error("cleanup signal failed"); };
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 20 });
  await assert.rejects(adapter.spawn(spawnRequest()), /cleanup signal failed/);
  assert.equal(adapter.runtimeCustody("wa-claude-1"), "unknown");
  options.noInit = false;
  const successor = await adapter.spawn(spawnRequest());
  assert.equal(adapter.runtimeCustody("wa-claude-1", successor), "unknown", "the successful retry does not overwrite the old child");
  harness.identities.set(4100, undefined);
  assert.equal(adapter.runtimeCustody("wa-claude-1", successor), "unknown");
  harness.identities.set(4100, null);
  assert.equal(adapter.runtimeCustody("wa-claude-1", successor), "owned");
  harness.children[1]!.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(adapter.runtimeCustody("wa-claude-1", successor), "absent");
});

test("Claude missing executable proves no native child was acquired", async () => {
  const harness = createHarness();
  const { launchChild: _launchChild, ...dependencies } = harness.dependencies;
  const adapter = new ClaudeCodeProviderAdapter({ claudeBin: "/nonexistent-letagents-test/claude", dependencies });
  await assert.rejects(adapter.spawn(spawnRequest({ cwd: tmpdir() })), /did not expose a process id/);
  assert.equal(adapter.runtimeCustody("wa-claude-1"), "absent");
  assert.deepEqual(harness.signals, []);
});

test("Claude bootstrap transport error is not a native-death receipt", async () => {
  const harness = createHarness({ noInit: true });
  const launch = harness.dependencies.launchChild;
  harness.dependencies.launchChild = input => {
    const child = launch(input) as FakeClaudeChild;
    queueMicrotask(() => child.resolveExit({ type: "error", error: new Error("transport failed") }));
    return child;
  };
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, initTimeoutMs: 20 });
  await assert.rejects(adapter.spawn(spawnRequest()), /did not report its stream-json init/);
  assert.equal(harness.signals.length, 0, "existing cleanup resolves early on this transport error");
  assert.equal(adapter.runtimeCustody("wa-claude-1"), "unknown", "birth remains live despite rejected acquisition and resolved error");
  harness.identities.set(4100, undefined);
  assert.equal(adapter.runtimeCustody("wa-claude-1"), "unknown");
  harness.identities.set(4100, "reused-pid-birth");
  assert.equal(adapter.runtimeCustody("wa-claude-1"), "absent", "later physical retirement unblocks handoff without history edits");
});

test("observed crash emits one synthesized terminal payload and makes attach terminal evidence", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  harness.identities.set(4100, null);
  harness.children[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "crashed");
  assert.deepEqual(terminals[0]!.nativeRuntimeDeath, { kind: "claude_cli", pid: 4100, processIdentity: handle.providerConnection!.processIdentity });
  assert.equal(handle.observedState(), "failed");
  const attachment = await adapter.attach({
    workAttemptId: "wa-claude-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
  });
  assert.equal(attachment && "state" in attachment ? attachment.state : null, "terminal");
  assert.equal(attachment && "state" in attachment ? attachment.terminal.terminalCause : null, "crashed");
});

test("durable birth identity remains stable when a provider rewrites its process title", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", [
    "process.stdout.write('ready\\n')",
    "process.stdin.once('data', () => { process.title = 'claude'; process.stdout.write('changed\\n') })",
    "setInterval(() => {}, 1000)",
  ].join(";")], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    await waitForChildOutput(child, "ready");
    const before = defaultGetProcessIdentity(child.pid!);
    child.stdin!.write("change\n");
    await waitForChildOutput(child, "changed");
    const after = defaultGetProcessIdentity(child.pid!);
    assert.equal(typeof before, "string");
    assert.equal(after, before, "mutable argv/title is excluded from process birth identity");
    assert.equal(
      sameProcessBirthIdentity(after!, `${before} /usr/local/bin/claude --print --verbose`),
      true,
      "2.0.12 recognizes a pre-upgrade identity that appended mutable argv",
    );
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
});

test("stop orders SIGTERM before the observed terminal and escalates to SIGKILL after grace", async () => {
  const graceful = createHarness();
  const gracefulAdapter = new ClaudeCodeProviderAdapter({ dependencies: graceful.dependencies, stopGraceMs: 200 });
  const gracefulHandle = await gracefulAdapter.spawn(spawnRequest());
  const stopped = await gracefulAdapter.stop(gracefulHandle);
  assert.deepEqual(graceful.signals.map((entry) => entry.signal), ["SIGTERM"]);
  assert.equal(stopped.terminalCause, "stopped");

  const stubborn = createHarness({ dieOnSigterm: false });
  const stubbornAdapter = new ClaudeCodeProviderAdapter({ dependencies: stubborn.dependencies, stopGraceMs: 30 });
  const stubbornHandle = await stubbornAdapter.spawn(spawnRequest());
  const killed = await withLoopAlive(stubbornAdapter.stop(stubbornHandle));
  assert.deepEqual(stubborn.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  assert.equal(killed.terminalCause, "killed");
});

test("exact-reference Claude stop fences both attached and unreachable processes and emits birth evidence", async () => {
  for (const cached of [false, true]) for (const force of [false, true]) {
    const birth = "Mon Sep 21 17:55:18 2026";
    const h = createHarness({ identities: new Map([[4100, birth]]), dieOnSigterm: false });
    const owner = new ClaudeCodeProviderAdapter({ dependencies: h.dependencies });
    const handle = await owner.spawn(spawnRequest());
    const adapter = cached ? owner : new ClaudeCodeProviderAdapter({ dependencies: h.dependencies });
    const terminal = await withLoopAlive(adapter.stopRef({ workAttemptId: handle.workAttemptId,
      providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection }, { force, graceMs: 1 }));
    assert.deepEqual(h.signals.map(value => value.signal), force ? ["SIGKILL"] : ["SIGTERM", "SIGKILL"]);
    assert.equal(h.identities.get(4100), null);
    assert.deepEqual(terminal.nativeRuntimeDeath, { kind: "claude_cli", pid: 4100, processIdentity: birth });
    assert.equal(terminal.providerContinuationId, handle.providerContinuationId);
    assert.equal(h.launches.length, 1);
  }
});

test("exact-reference Claude stop ignores a cached protocol terminal while its process remains alive", async () => {
  const birth = "Mon Sep 21 17:55:18 2026";
  const h = createHarness({ identities: new Map([[4100, birth]]) });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: h.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  Object.assign(handle, { terminal: { endedAt: h.dependencies.now(), exitCode: null, signal: null,
    terminalCause: "protocol_error", providerContinuationId: handle.providerContinuationId } });
  const terminal = await withLoopAlive(adapter.stopRef({ workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!, providerConnection: handle.providerConnection }, { graceMs: 1 }));
  assert.deepEqual(h.signals.map(value => value.signal), ["SIGTERM"]);
  assert.equal(h.identities.get(4100), null);
  assert.equal(terminal.nativeRuntimeDeath?.pid, 4100);
});

test("exact-reference Claude stop refuses invalid births and known foreign ownership", async () => {
  const birth = "Mon Sep 21 17:55:18 2026";
  const h = createHarness({ identities: new Map([[4100, birth]]) });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: h.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const ref = { workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection };
  await assert.rejects(adapter.stopRef({ ...ref, workAttemptId: "foreign" }), /known native process owner/);
  await assert.rejects(adapter.stopRef({ ...ref, providerContinuationId: "foreign" }), /known native process owner/);
  for (const pid of [-1, 0, 1.1, null]) await assert.rejects(adapter.stopRef({ ...ref,
    providerConnection: { kind: "claude_cli", pid, processIdentity: birth } }), /exact continuation and process birth/);
  await assert.rejects(adapter.stopRef({ ...ref, providerConnection: { kind: "claude_cli", pid: 4100, processIdentity: "bad" } }), /exact continuation and process birth/);
  for (const unknown of [undefined, "bad ps output"]) {
    h.identities.set(4100, unknown);
    await assert.rejects(adapter.stopRef(ref), /ambiguous/);
  }
  assert.equal(h.signals.length, 0);
});

test("exact-reference Claude stop never signals a reused PID or accepts an unconfirmed kill", async () => {
  const birth = "Mon Sep 21 17:55:18 2026";
  const h = createHarness({ identities: new Map([[4100, "Mon Sep 21 18:55:18 2026"]]) });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: h.dependencies });
  const ref = { workAttemptId: "wa-old", providerContinuationId: "session-old",
    providerConnection: { kind: "claude_cli" as const, pid: 4100, processIdentity: birth } };
  assert.equal((await adapter.stopRef(ref)).nativeRuntimeDeath?.processIdentity, birth);
  assert.equal(h.signals.length, 0);
  h.identities.set(4100, birth);
  h.dependencies.signalProcess = (pid, signal) => { h.signals.push({ pid, signal }); };
  const stubborn = new ClaudeCodeProviderAdapter({ dependencies: h.dependencies });
  await assert.rejects(withLoopAlive(stubborn.stopRef(ref, { force: true, graceMs: 1 })), /not yet proved/);
  assert.deepEqual(h.signals.map(value => value.signal), ["SIGKILL"]);
  h.signals.length = 0;
  h.dependencies.signalProcess = (pid, signal) => { h.signals.push({ pid, signal }); h.identities.set(pid, "Mon Sep 21 18:55:18 2026"); };
  const replaced = new ClaudeCodeProviderAdapter({ dependencies: h.dependencies });
  await withLoopAlive(replaced.stopRef(ref, { graceMs: 1 }));
  assert.deepEqual(h.signals.map(value => value.signal), ["SIGTERM"], "no escalation into reused PID");
});

test("stdio loss on a verified-live child fences the exact child instead of synthesizing death", async () => {
  const harness = createHarness({ dieOnSigterm: false });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  const observations: NativeExecutionObservation[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));
  adapter.onExecution(handle, (event) => observations.push(event));

  harness.children[0]!.disconnect();
  await flush();

  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }], "the exact live child is fenced");
  assert.equal(terminals.length, 0, "stdio loss alone cannot make a live writer restartable");
  assert.equal(harness.children[0]!.alive, true);
  assert.deepEqual(observations.at(-1), {
    sourceId: observations.at(-1)?.sourceId,
    sequence: 2,
    observedAtMs: 1_700_000_000_000,
    fact: { domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none" },
    nativeProcessIdentity: birthIdentity(4100),
    nativeProcessPid: 4100,
  }, "stdio loss degrades typed control without inventing runtime death");

  // Only real identity disappearance becomes terminal.
  harness.identities.set(4100, null);
  harness.children[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "crashed");
  assert.deepEqual(observations.slice(-2).map(({ fact }) => fact), [
    { domain: "control", kind: "state_changed", state: "lost", sideEffects: "none", controlEvidence: "process_exit" },
    { domain: "runtime", kind: "state_changed", state: "exited", sideEffects: "none", controlEvidence: "process_exit" },
  ], "verified process exit remains the only hard-loss boundary");
});

test("a quiet daemon-owned Claude continuation stays idle between turns", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  await flush();
  await flush();

  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(harness.signals, []);
  assert.deepEqual(terminals, []);
});

test("a recycled pid can neither authenticate an attach nor be signalled", async () => {
  const originalBirth = "Wed Jul 15 23:42:10 2026";
  const recycledBirth = "Thu Jul 16 00:01:22 2026";
  const harness = createHarness({ identities: new Map([[4100, originalBirth]]) });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  const fresh = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  harness.identities.set(4100, recycledBirth);
  const attached = await fresh.attach({
    workAttemptId: "wa-claude-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: {
      kind: "claude_cli",
      pid: 4100,
      processIdentity: `${originalBirth} /opt/homebrew/bin/claude --print --verbose`,
    },
  });
  assert.equal(attached && "state" in attached ? attached.state : null, "terminal", "the recorded child is proven absent");
  assert.equal(attached && "state" in attached ? attached.terminal.terminalCause : null, "crashed");
  assert.deepEqual(attached && "state" in attached ? attached.terminal.nativeRuntimeDeath : null,
    { kind: "claude_cli", pid: 4100, processIdentity: `${originalBirth} /opt/homebrew/bin/claude --print --verbose` });
  assert.deepEqual(harness.signals, [], "the recycled pid was never signalled");
});

test("pid-less or unverifiable durable endpoints stay ambiguous and restart-blocking", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.attach({
    workAttemptId: "wa-x",
    providerContinuationId: "sess-x",
    providerConnection: { kind: "claude_cli", pid: null, processIdentity: null },
  }), /ambiguous/);

  harness.identities.set(9999, undefined);
  await assert.rejects(adapter.attach({
    workAttemptId: "wa-y",
    providerContinuationId: "sess-y",
    providerConnection: { kind: "claude_cli", pid: 9999, processIdentity: "birth-y" },
  }), /ambiguous/);
  assert.deepEqual(harness.signals, []);
});

test("attach to a live unreachable orphan fences it (TERM, identity recheck, KILL) before reporting terminal", async () => {
  const stableBirth = "Wed Jul 15 23:42:10 2026";
  const harness = createHarness({ dieOnSigterm: false, identities: new Map([[4100, stableBirth]]) });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const handle = await adapter.spawn(spawnRequest());

  // A fresh adapter (daemon restart) has no stdio to the recorded child.
  const fresh = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const attached = await withLoopAlive(fresh.attach({
    workAttemptId: "wa-claude-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: {
      kind: "claude_cli",
      pid: 4100,
      processIdentity: stableBirth,
    },
  }));

  assert.equal(attached && "state" in attached ? attached.state : null, "terminal", "fencing returns durable terminal evidence for bounded recovery");
  assert.equal(attached && "state" in attached ? attached.terminal.terminalCause : null, "killed");
  assert.deepEqual(harness.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"], "exact-child fence ordering");
  assert.equal(harness.identities.get(4100), null, "the orphan is verifiably gone before recovery may proceed");
  assert.equal(harness.launches.length, 1, "fencing never launches a second writer");
});

test("concurrent Claude attach authenticates one exact continuation, authority mode, and process birth", async () => {
  const stableBirth = "Wed Jul 15 23:42:10 2026";
  const harness = createHarness({ dieOnSigterm: false, identities: new Map([[4100, stableBirth]]) });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const handle = await adapter.spawn(spawnRequest());
  const fresh = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const ref = {
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    lifecycleAuthorityMode: "typed_shadow" as const,
    providerConnection: handle.providerConnection,
  };

  const exact = fresh.attach(ref);
  assert.equal(await fresh.attach({ ...ref, providerContinuationId: "foreign-session" }), null);
  assert.equal(await fresh.attach({ ...ref, lifecycleAuthorityMode: "typed" }), null);
  assert.equal(await fresh.attach({
    ...ref,
    providerConnection: { kind: "claude_cli", pid: handle.pid, processIdentity: birthIdentity(9999) },
  }), null);
  assert.equal(await fresh.attach({ ...ref }), await withLoopAlive(exact),
    "an identical concurrent attach shares only the exact in-flight fence");
  assert.deepEqual(harness.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
});

test("resume presents the recorded continuation and asserts the spike-proven same-session identity", async () => {
  // msg_1382 proved `--resume <id>` continues the SAME session id, so the
  // capability is advertised and the identity is asserted, exactly like
  // Codex's exact-thread resume.
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  assert.deepEqual(adapter.capabilities().deliveryModes, ["daemon_inbox"]);
  assert.equal(adapter.capabilities().resume, true);
  assert.equal(adapter.capabilities().survivesRestart, false, "bounded recovery, not survival");
  const handle = await adapter.resume(
    { workAttemptId: "wa-claude-1", providerContinuationId: "sess-old" },
    spawnRequest({
      supervisorWorkerSession: {
        agentSessionId: "agent_session_exact",
        roomCursor: "msg_2819",
      },
    }),
  );
  const args = harness.launches[0]!.args;
  assert.ok(args.join(" ").includes("--resume sess-old"), "the recorded continuation is presented to the CLI");
  assert.equal(args.includes("--session-id"), false, "resume does not mint a competing identity");
  assert.equal(handle.providerContinuationId, "sess-old", "the SAME session id continues");
  const resumePrompt = (JSON.parse(harness.children[0]!.written[0]!) as { message: { content: Array<{ text: string }> } }).message.content[0]!.text;
  assert.match(resumePrompt, /Initialize this supervised Claude Code continuation/);
  assert.match(resumePrompt, /Do not call tools, inspect the room, or perform work/);
  assert.doesNotMatch(resumePrompt, /agent_session_exact|msg_2819|register_agent_session/);

  // A CLI that resumes a DIFFERENT session is refused and the fresh child is
  // terminated — a stranger conversation must never become this work attempt's
  // continuation.
  const wrong = createHarness({ initSessionId: "sess-other" });
  const wrongAdapter = new ClaudeCodeProviderAdapter({ dependencies: wrong.dependencies });
  await assert.rejects(wrongAdapter.resume(
    { workAttemptId: "wa-claude-2", providerContinuationId: "sess-old" },
    spawnRequest({ workAttemptId: "wa-claude-2" }),
  ), /resumed a different session/);
  assert.equal(wrong.children[0]!.alive, false, "the mismatched child is terminated, not orphaned");

  // The symmetric fresh-spawn guard: a CLI ignoring the minted --session-id is
  // an unverifiable continuation and is refused the same way.
  const ignored = createHarness({ initSessionId: "sess-not-minted" });
  const ignoredAdapter = new ClaudeCodeProviderAdapter({ dependencies: ignored.dependencies });
  await assert.rejects(ignoredAdapter.spawn(spawnRequest({ workAttemptId: "wa-claude-3" })), /ignored the minted session id/);
  assert.equal(ignored.children[0]!.alive, false);
});

test("stream evidence is bounded and redacted, and non-JSON output keeps method identity", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;

  child.emit({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello room" }] },
    api_key: "sk-not-really",
  });
  child.emitRaw("plain text noise from the harness");
  await flush();

  const assistant = streamEvents.find((event) => event.method === "assistant");
  assert.ok(assistant);
  assert.equal(assistant!.kind, "text_delta");
  assert.equal(assistant!.payloadRedacted, true, "sensitive keys are redacted");
  assert.equal((assistant!.payload as { api_key?: unknown }).api_key, "[REDACTED]");

  const raw = streamEvents.find((event) => event.method === "stdout/raw");
  assert.ok(raw, "non-JSON output is preserved as bounded raw evidence");

  const sequences = streamEvents.map((event) => event.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, "stream sequence is ordered");
});

test("result messages settle the observed state to idle and publish activity evidence", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;

  child.emit({ type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } });
  await flush();
  assert.equal(handle.observedState(), "working");

  child.emit({ type: "result", subtype: "success", result: "done", num_turns: 3 });
  await flush();
  assert.equal(handle.observedState(), "idle");
});

test("daemon-owned Claude runs one exact bounded room turn and checkpoints before publication", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  const calls: string[] = [];

  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-claude-1",
    actionId: "action-claude-1",
    observedContext: [{ id: "msg-before", text: "Earlier context" }],
    sourceMessage: { id: "msg-source", text: "Please fix it" },
    activation: { kind: "mention" },
  }, {
    beforeNativeDispatch: async () => { calls.push("intent"); },
    checkpointTurnStarted: async (turnId) => { calls.push(`turn:${turnId}`); },
    checkpointTerminalResult: async (result) => { calls.push(`terminal:${result.turnId}`); },
  });
  await flush();

  const frame = JSON.parse(child.written.at(-1)!) as {
    uuid: string;
    message: { content: Array<{ text: string }> };
  };
  assert.ok(frame.uuid);
  assert.deepEqual(calls, ["intent", `turn:${frame.uuid}`], "durable intent and exact id precede native completion");
  const prompt = frame.message.content[0]!.text;
  assert.match(prompt, /publication of your final chat reply/i);
  assert.match(prompt, /chat reply publication does not publish code or create PRs/);
  assert.match(prompt, /standing merge approval/);
  assert.match(prompt, /Do not register a session, authenticate LetAgents, poll/);
  assert.doesNotMatch(prompt, /durable charter/i);
  assert.match(prompt, /Inbox item: inbox-claude-1/);
  assert.match(prompt, /Source message: .*Please fix it/);

  child.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: handle.providerContinuationId,
    user_message_uuid: frame.uuid,
    result: "Fixed and verified.",
  });
  assert.deepEqual(await pending, {
    turnId: frame.uuid,
    outcome: "reply",
    text: "Fixed and verified.",
    evidence: "stream",
  });
  assert.deepEqual(calls, ["intent", `turn:${frame.uuid}`, `terminal:${frame.uuid}`]);
  assert.equal(handle.observedState(), "idle");
});

test("Claude bounded turns use the exact no-reply sentinel and never infer it from extra text", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;

  const exact = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-no-reply",
    actionId: "action-no-reply",
    sourceMessage: {},
    activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {},
  });
  await flush();
  const exactFrame = JSON.parse(child.written.at(-1)!) as { uuid: string };
  child.emit({
    type: "result", subtype: "success", is_error: false,
    session_id: handle.providerContinuationId,
    user_message_uuid: exactFrame.uuid,
    result: "LETAGENTS_NO_ROOM_REPLY",
  });
  assert.deepEqual(await exact, {
    turnId: exactFrame.uuid,
    outcome: "no_reply",
    text: null,
    evidence: "stream",
  });

  const extra = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-sentinel-extra",
    actionId: "action-sentinel-extra",
    sourceMessage: {},
    activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {},
  });
  await flush();
  const extraFrame = JSON.parse(child.written.at(-1)!) as { uuid: string };
  child.emit({
    type: "result", subtype: "success", is_error: false,
    session_id: handle.providerContinuationId,
    user_message_uuid: extraFrame.uuid,
    result: "LETAGENTS_NO_ROOM_REPLY because this was informational.",
  });
  assert.deepEqual(await extra, {
    turnId: extraFrame.uuid,
    outcome: "reply",
    text: "LETAGENTS_NO_ROOM_REPLY because this was informational.",
    evidence: "stream",
  });
});

test("Claude exact-turn recovery reads only the durable transcript and never dispatches again", async () => {
  const turnId = "turn-recover-exact";
  const sessionId = "sess-old";
  const harness = createHarness({
    sessionRows: [
      {
        type: "user",
        uuid: turnId,
        sessionId,
        message: { content: [{ type: "text", text: "source" }] },
      },
      {
        type: "assistant",
        sessionId,
        message: {
          id: "assistant-recover",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Recovered once." }],
        },
      },
    ],
  });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.resume(
    { workAttemptId: "wa-claude-1", providerContinuationId: sessionId },
    spawnRequest(),
  );
  const writesBeforeRecovery = harness.children[0]!.written.length;
  let checkpointed = false;
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-recover",
    providerTurnId: turnId,
  }, {
    checkpointTerminalResult: async () => { checkpointed = true; },
  }), {
    turnId,
    outcome: "reply",
    text: "Recovered once.",
    evidence: "transcript",
  });
  assert.equal(checkpointed, true);
  assert.equal(harness.children[0]!.written.length, writesBeforeRecovery, "recovery never starts another native turn");
});

for (const recordEnding of [true, false] as const) {
  test(`a Claude turn whose process exited under it ${recordEnding ? "is closed in the record when" : "stays lost in the record unless"} the daemon asks its replacement to record the ending it reads from the session`, async () => {
    // The real adapter over the fake CLI, feeding the real execution capture and shadow store.
    const { DatabaseSync } = await import("node:sqlite");
    const { DaemonStateSchema } = await import(new URL("../../daemon/daemon-state-database.ts", import.meta.url).href);
    const { ExecutionCaptureCoordinator } = await import(new URL("../../daemon/execution-capture-coordinator.ts", import.meta.url).href);
    const { ExecutionShadowStore, executionRuntimeStorageIdentity } = await import(new URL("../../daemon/execution-shadow-store.ts", import.meta.url).href);
    const sessionRows: Array<Record<string, unknown>> = [];
    const harness = createHarness({ sessionRows });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const at = "2026-08-31T00:00:00.000Z";
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    new DaemonStateSchema().createSchema(db);
    db.exec(`INSERT INTO agent_identities VALUES('agent','owner','${at}',0);
      INSERT INTO agent_configurations(agent_id,provider,charter,delivery_mode,provider_launch_policy_present,provider_launch_policy_undefined,config_revision,runtime_configuration_revision)
        VALUES('agent','claude-code','charter','daemon_inbox',0,0,1,1);
      INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
        VALUES('wa-claude-1','task','lease',1,'/private/workspace','repo','remote','revision','/private/bare','active','${at}');
      INSERT INTO work_attempt_executions VALUES('generation','wa-claude-1','${at}','test',1,NULL);`);
    type Native = Awaited<ReturnType<typeof adapter.spawn>>;
    const natives = new Map<object, Native>();
    let current: { workAttemptId: string; pid: number | null; providerContinuationId: string | null; providerConnection: Native["providerConnection"]; observedState: "idle"; appliedConfigurationRevision: number } | undefined;
    const diagnostics: string[] = [];
    const capture = new ExecutionCaptureCoordinator(db, {
      provider: { onExecution: (handle: object, listener: (event: NativeExecutionObservation) => void) => adapter.onExecution(natives.get(handle)!, listener) },
      currentHandle: () => current, daemonGeneration: () => 1, diagnostic: (_id: string, code: string) => diagnostics.push(code),
    });
    /** What the daemon does when it installs a runtime: record its birth, and observe it. */
    const install = (native: Native) => {
      const connection = native.providerConnection!;
      current = { workAttemptId: native.workAttemptId, pid: native.pid, providerContinuationId: native.providerContinuationId,
        providerConnection: connection, observedState: "idle", appliedConfigurationRevision: 1 };
      natives.set(current, native);
      db.prepare("DELETE FROM runtime_deployments").run();
      db.prepare(`INSERT INTO runtime_deployments(agent_id,observed_state,workspace_path_present,work_attempt_id_present,work_attempt_id,
        provider_ref_present,provider_work_attempt_id,provider_continuation_id,provider_connection_kind,provider_connection_pid,
        provider_process_identity_present,provider_process_identity,provider_execution_generation_id,workplace_liveness_present,native_liveness_present,activity_present)
        VALUES('agent','idle',0,1,'wa-claude-1',1,'wa-claude-1',?,'claude_cli',?,1,?,'generation',0,0,0)`)
        .run(native.providerContinuationId, connection.pid, connection.processIdentity!);
      new ExecutionShadowStore(db).registerRuntime({ agentId: "agent", executionGenerationId: "generation",
        runtimeGenerationId: executionRuntimeStorageIdentity("agent", "generation", "claude_cli", connection.pid!, connection.processIdentity!),
        provider: "claude-code", authorityMode: "typed", configRevision: 1, createdAtMs: Date.parse(at) });
      capture.install(Object.freeze({ nonce: Symbol("installation"), listenerLeaseNonce: Symbol("lease"), entryId: "agent", handle: current,
        executionGenerationId: "generation", workAttemptId: native.workAttemptId, providerContinuationId: native.providerContinuationId!,
        providerConnection: { ...connection }, configurationRevision: 1, authorityMode: "typed" }));
    };
    /** The daemon saves which message a native turn belongs to before the turn's first event can arrive. */
    const bindTurn = (turnId: string, continuation: string) => {
      const order = Number(db.prepare("SELECT COUNT(*) n FROM supervised_agent_inbox").get()!.n) + 1;
      db.prepare(`INSERT INTO supervised_agent_inbox(inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,created_at,updated_at)
        VALUES(?,'agent','room',?,'{}','{}',?,'awaiting_result',1,?,?,?,?,?)`).run(turnId, `message-${order}`, order, `action-${order}`, `reply-${order}`, turnId, at, at);
      db.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES(?,'agent','room','wa-claude-1','generation',?,?)").run(turnId, continuation, turnId);
    };
    const turns = () => db.prepare("SELECT provider_turn_id,state FROM execution_turns ORDER BY rowid").all().map((turn) => ({ ...turn }));
    const startTurn = async (native: Native, child: FakeClaudeChild, inboxItemId: string) => {
      const running = adapter.runRoomTurn!(native, { inboxItemId, actionId: inboxItemId, sourceMessage: {}, activation: {} },
        { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
      void running.catch(() => undefined);
      await flush();
      const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
      bindTurn(turnId, native.providerContinuationId!);
      child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: native.providerContinuationId });
      await flush();
      return { running, turnId };
    };
    try {
      const first = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
      install(first);
      const one = await startTurn(first, harness.children[0]!, "inbox-1");
      assert.deepEqual(turns(), [{ provider_turn_id: one.turnId, state: "active" }]);

      // The process dies under the turn. Its session file shows the turn had finished.
      sessionRows.push(
        { type: "user", uuid: one.turnId, sessionId: first.providerContinuationId, message: { content: [{ type: "text", text: "source" }] } },
        { type: "assistant", sessionId: first.providerContinuationId,
          message: { id: "assistant-1", stop_reason: "end_turn", content: [{ type: "text", text: "Finished before the exit." }] } });
      harness.identities.set(first.pid!, null);
      harness.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
      await assert.rejects(one.running);
      await flush();
      assert.deepEqual(turns(), [{ provider_turn_id: one.turnId, state: "lost" }]);

      // Its replacement resumes the conversation and reads the turn's ending back.
      const second = await adapter.resume({ workAttemptId: first.workAttemptId, providerContinuationId: first.providerContinuationId! },
        spawnRequest({ lifecycleAuthorityMode: "typed" }));
      install(second);
      await flush();
      const recovered = await adapter.recoverRoomTurn!(second, { inboxItemId: "inbox-1", providerTurnId: one.turnId, ...(recordEnding ? { recordEnding: true } : {}) },
        { checkpointTerminalResult: async () => {} });
      assert.deepEqual(recovered, { turnId: one.turnId, outcome: "reply", text: "Finished before the exit.", evidence: "transcript" });
      db.prepare("UPDATE supervised_agent_inbox SET state='acknowledged' WHERE inbox_item_id=?").run(one.turnId);
      capture.refresh("agent");
      await flush();
      assert.deepEqual(turns(), [{ provider_turn_id: one.turnId, state: recordEnding ? "terminal" : "lost" }]);

      // The next turn.
      const two = await startTurn(second, harness.children[1]!, "inbox-2");
      const position = { ...db.prepare("SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers").get()! };
      if (recordEnding) {
        assert.deepEqual(turns(), [{ provider_turn_id: one.turnId, state: "terminal" }, { provider_turn_id: two.turnId, state: "active" }],
          "the next turn is recorded");
        assert.equal(position.max, position.last, "with no gap");
        assert.deepEqual(diagnostics.filter((code) => ["source_gap", "invalid_observation", "retention_limit"].includes(code)), [],
          "and the record never stops");
      } else {
        assert.deepEqual(turns().map((turn) => turn.state), ["lost"], "the open turn refuses the next one");
        assert.ok(Number(position.max) > Number(position.last), "and the record has a gap from here on");
        assert.ok(diagnostics.includes("invalid_observation"));
      }
    } finally {
      capture.close();
    }
  });
}

/**
 * A real daemon supervising one Claude Code agent: the real adapter, action
 * router, delivery, execution capture and stores, over the fake CLI. Only the
 * room, the server and the processes are doubles.
 */
async function claudeDaemonFixture() {
  const { SupervisorDaemon } = await import(new URL("../../daemon/main.ts", import.meta.url).href);
  const { WorkDurabilityStore } = await import(new URL("../../daemon/durability-store.ts", import.meta.url).href);
  const { DAEMON_PROTOCOL_VERSION } = await import(new URL("../../daemon/types.ts", import.meta.url).href);
  const { createConnection } = await import("node:net");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "claude-daemon-"));
  const id = "claude_agent";
  const paths = {
    lockPath: join(root, "daemon.lock"), socketPath: join(root, "daemon.sock"),
    manifestPath: join(root, "daemon-state.sqlite"), auditPath: join(root, "audit.jsonl"),
    attemptsPath: join(root, "attempts.json"), attemptsRoot: join(root, "attempt-data"), workspaceRoot: root,
  };
  const request = (method: string, params?: unknown) => new Promise<{ ok: boolean; result?: any; error?: string }>((resolve, reject) => {
    const socket = createConnection(paths.socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\n")) return;
      socket.end();
      resolve(JSON.parse(received.slice(0, received.indexOf("\n"))));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: "test", method, params })}\n`));
  });
  const eventually = async (check: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!await check()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const workAttemptId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const workspace = join(root, "worktrees", "repo", workAttemptId);
  await mkdir(join(root, "repos", "repo.git"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, ".letagents-work-attempt.json"), JSON.stringify({ version: 1, repo: "repo",
    work_attempt_id: workAttemptId, task_id: id, remote_url: "https://example.invalid/repo", resolved_revision: "a".repeat(40),
    bare_path: join(root, "repos", "repo.git") }));
  const durability = new WorkDurabilityStore(paths.attemptsPath, paths.attemptsRoot, undefined, join(root, "worktrees"));
  const attempt = await durability.createAttempt({ taskId: id, leaseId: id, leaseEpoch: 0, workspacePath: workspace, workAttemptId });
  await durability.close();

  /** The session file every process of this agent appends to and resumes from. */
  const sessionRows: Array<Record<string, unknown>> = [];
  const harness = createHarness({ sessionRows });
  /** Whether the session file is found where the CLI keeps it, and where the adapter looked for it. */
  const transcript = { found: true, readFrom: [] as Array<string | undefined> };
  harness.dependencies.readSessionRows = async (_sessionId, transcriptsRoot) => {
    transcript.readFrom.push(transcriptsRoot);
    return transcript.found ? sessionRows : null;
  };
  /** Every room turn a process was asked to run: the frame after its bootstrap, and each one after that. */
  const turns: Array<{ id: string; child: FakeClaudeChild }> = [];
  const launchChild = harness.dependencies.launchChild;
  harness.dependencies.launchChild = (input) => {
    const child = launchChild(input) as FakeClaudeChild;
    const write = child.writeLine.bind(child);
    let bootstrapped = false;
    child.writeLine = (json: string) => {
      const frame = JSON.parse(json) as { type?: string; uuid?: string };
      if (!bootstrapped) bootstrapped = true;
      else if (frame.type === "user" && frame.uuid) turns.push({ id: frame.uuid, child });
      write(json);
    };
    return child;
  };
  /** What a test makes the adapter's reading back of a turn wait on, and what the daemon asked of it. */
  const recovery = { held: null as Promise<void> | null, requests: [] as Array<Record<string, unknown>> };
  /** What a test makes the first saving of a turn's result fail with. */
  let failNextResultCheckpoint: Error | null = null;
  const makeAdapter = () => {
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: { ...harness.dependencies, now: () => new Date().toISOString() } });
    const recover = adapter.recoverRoomTurn!.bind(adapter);
    adapter.recoverRoomTurn = async (handle, turn, options) => {
      recovery.requests.push({ ...turn });
      await recovery.held;
      return recover(handle, turn, options);
    };
    const run = adapter.runRoomTurn!.bind(adapter);
    adapter.runRoomTurn = (handle, turn, options = {}) => run(handle, turn, { ...options, checkpointTerminalResult: async (result) => {
      const failure = failNextResultCheckpoint;
      failNextResultCheckpoint = null;
      if (failure) throw failure;
      return options.checkpointTerminalResult!(result);
    } });
    return adapter;
  };
  let adapter = makeAdapter();
  const roomMessages: Array<Record<string, unknown>> = [];
  const published: string[] = [];
  let mints = 0;
  const makeDaemon = () => new SupervisorDaemon(paths, "darwin", new ProviderActionPortRouter({ "claude-code": async () => adapter }), true,
    50, undefined, {}, {
      poll: async ({ afterMessageId, signal }: { afterMessageId: string | null; signal: AbortSignal }) => {
        const from = afterMessageId ? roomMessages.findIndex((message) => message.id === afterMessageId) + 1 : 0;
        if (roomMessages.length > from) return { messages: roomMessages.slice(from) };
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        return { messages: [] };
      },
      publish: async (input: { text: string; roomId: string }) => {
        published.push(input.text);
        return { messageId: `msg_${900 + published.length}`, roomId: input.roomId };
      },
    }, {
      listWorkLeases: async () => [], readWorkLease: async () => null,
      attestWorkLease: async () => { throw new Error("unused"); },
      rebindWorkLease: async () => { throw new Error("unused"); },
      createWorkerSession: async () => {
        mints += 1;
        return { sessionId: `${id}-session`, bearer: `${id}-bearer-${mints}`, bearerId: `${id}-bearer-id-${mints}`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() };
      },
    });
  let daemon = makeDaemon();
  const read = <T>(sql: string): T[] => {
    const database = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try { return database.prepare(sql).all(id).map((row) => ({ ...row })) as T[]; } finally { database.close(); }
  };
  const cleanup = async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  };
  type Receipt = { source_message_id: string; state: string; last_error: string | null; provider_turn_id: string | null };
  const inbox = () => (daemon as unknown as { supervisedInbox: {
    bootstrapCursor(input: { agent_id: string; room_id: string; last_observed_message_id: string | null }): Promise<unknown>;
    receipts(agentId: string): Promise<Receipt[]>;
  } }).supervisedInbox;
  const startDaemon = async () => {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    const generation = (await request("daemon.status")).result.generation;
    return async () => assert.equal((await request("supervisor.install_host_grant", {
      entry_id: id, room_id: "room_1", agent_key: "owner/agent", grant_id: `grant-${id}`,
      supervisor_grant: `${id}-parent`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: generation,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    })).ok, true);
  };
  try {
    const installGrant = await startDaemon();
    assert.equal((await request("manifest.put", { entry: {
      id, room_id: "room_1", display_name: "Agent", provider: "claude-code", model: null, charter: "test",
      desired_state: "running", observed_state: "absent", condition: "none", permission_profile_id: null,
      created_by: "test", created_at: "2026-01-01T00:00:00.000Z", delivery_mode: "daemon_inbox",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await inbox().bootstrapCursor({ agent_id: id, room_id: "room_1", last_observed_message_id: null });
    await installGrant();
    const view = async () => (await request("manifest.list")).result[0] as {
      observed_state: string; condition: string; last_error: string | null; provider_ref: { provider_continuation_id: string };
      room_agent_state: { ingress: { state: string }; inbox: { state: string; detail: string | null } };
    };
    await eventually(() => harness.children.length === 1, "the CLI is launched");
    await eventually(async () => (await view())?.room_agent_state?.ingress.state === "observing", "the agent listens to its room");
    const sessionId = (await view()).provider_ref.provider_continuation_id;
    const receipt = async (messageId: string) => (await inbox().receipts(id)).find((item) => item.source_message_id === messageId);
    /** Send the agent its nth room message and wait until its process has been asked to run the turn. */
    const begin = async (ordinal: number) => {
      roomMessages.push({ id: `msg_${ordinal}`, sender: "someone", text: `request ${ordinal}`, activation: { for_current_agent: { decision: "activate" } } });
      await eventually(async () => turns.length === ordinal && Boolean((await receipt(`msg_${ordinal}`))?.provider_turn_id), `msg_${ordinal} starts its turn`).catch(async (error) => {
        const current = await view();
        throw new Error(`${(error as Error).message}: agent is ${current.observed_state}/${current.condition} (${current.last_error}); inbox ${current.room_agent_state.inbox.state} (${current.room_agent_state.inbox.detail})`);
      });
      return turns[ordinal - 1]!;
    };
    return { id, harness, request, eventually, view, read, published, roomMessages, turns, sessionRows, sessionId, receipt, begin, cleanup, recovery, transcript,
      receipts: () => inbox().receipts(id),
      /** The CLI reports that the turn has started. */
      reportStarted: (turn: { id: string; child: FakeClaudeChild }) =>
        turn.child.emit({ type: "command_lifecycle", state: "started", command_uuid: turn.id, session_id: sessionId }),
      /** The CLI reports the turn's result. */
      answer: (turn: { id: string; child: FakeClaudeChild }, text: string) =>
        turn.child.emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, user_message_uuid: turn.id, result: text }),
      /** The agent's newest process ends now, as it does when it crashes. */
      exitProcess: () => {
        const child = harness.children.at(-1)!;
        harness.identities.set(child.pid!, null);
        child.resolveExit({ type: "exit", code: 1, signal: null });
      },
      /** The first saving of the next turn result fails, as it does when the daemon dies between the result and its checkpoint. */
      failNextResultCheckpoint: (error: Error) => { failNextResultCheckpoint = error; },
      /** From here on the reading back of a saved turn waits until the returned function lets it go. */
      holdRecovery: () => {
        let release!: () => void;
        recovery.held = new Promise<void>((resolve) => { release = resolve; });
        return () => { recovery.held = null; release(); };
      },
      /** The daemon ends and a new one, with a new adapter, takes the agent over. */
      restartDaemon: async () => {
        await daemon.stop();
        adapter = makeAdapter();
        daemon = makeDaemon();
        await (await startDaemon())();
      },
      /** The turns in the agent's execution record, and whether the record has a gap. */
      recorded: () => ({
        turns: read<{ provider_turn_id: string; state: string }>("SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,rowid"),
        endings: read<{ provider_turn_id: string; n: number; outcome: string | null }>(`SELECT t.provider_turn_id, COUNT(*) AS n, MIN(f.turn_outcome) AS outcome
          FROM execution_facts f JOIN execution_turns t USING(turn_id)
          WHERE f.agent_id=? AND f.domain='turn' AND f.state='terminal' GROUP BY t.provider_turn_id ORDER BY MIN(f.sequence)`),
        gaps: read<{ last: number; max: number }>("SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")
          .filter((observer) => observer.max !== observer.last).length,
      }) };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** What a Claude session holds of a turn whose process ended under it. */
const CLAUDE_SESSION_AFTER_EXIT = {
  "its answer": (sessionId: string, turnId: string, ordinal: number) => [
    { type: "user", uuid: turnId, sessionId, message: { content: [{ type: "text", text: "request" }] } },
    { type: "assistant", sessionId, message: { id: `assistant-${ordinal}`, stop_reason: "end_turn", content: [{ type: "text", text: `Recovered ${ordinal}.` }] } }],
  "half an answer": (sessionId: string, turnId: string, ordinal: number) => [
    { type: "user", uuid: turnId, sessionId, message: { content: [{ type: "text", text: "request" }] } },
    { type: "assistant", sessionId, message: { id: `assistant-${ordinal}`, stop_reason: null, content: [{ type: "text", text: "Half of" }] } }],
  "a tool call that never returned": (sessionId: string, turnId: string, ordinal: number) => [
    { type: "user", uuid: turnId, sessionId, message: { content: [{ type: "text", text: "request" }] } },
    { type: "assistant", sessionId, message: { id: `assistant-${ordinal}`, stop_reason: "tool_use", content: [{ type: "tool_use", id: `tool-${ordinal}`, name: "Bash", input: {} }] } }],
  "a transcript that holds nothing of the turn": () => [],
  // The shape Claude Code 2.1.278 writes when it gives up on a request the provider refused.
  "the provider's error": (sessionId: string, turnId: string, ordinal: number) => [
    { type: "user", uuid: turnId, sessionId, message: { role: "user", content: [{ type: "text", text: "request" }] } },
    { type: "assistant", uuid: `api-error-${ordinal}`, parentUuid: turnId, sessionId, isApiErrorMessage: true, apiErrorStatus: 400, error: "unknown",
      message: { id: `synthetic-${ordinal}`, role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence",
        content: [{ type: "text", text: "API Error: 400 LOCAL_PROVIDER_FAILURE_1517" }] } }],
} as const;

for (const [left, rows] of Object.entries(CLAUDE_SESSION_AFTER_EXIT)) {
  test(`a Claude agent whose process ends during two turns in a row, leaving ${left} in the session, settles both, records both endings and answers its next message`, async () => {
    const agent = await claudeDaemonFixture();
    try {
      for (const ordinal of [1, 2]) {
        const turn = await agent.begin(ordinal);
        agent.reportStarted(turn);
        await agent.eventually(() => agent.recorded().turns.at(-1)?.state === "active", `turn ${ordinal} is recorded as started`);
        agent.sessionRows.push(...rows(agent.sessionId, turn.id, ordinal));
        agent.exitProcess();
        await agent.eventually(() => agent.harness.children.length === ordinal + 1, `process ${ordinal + 1} replaces it`);
        const settled = left === "its answer" ? "acknowledged" : "acknowledged_failed";
        await agent.eventually(async () => (await agent.receipt(`msg_${ordinal}`))?.state === settled, `msg_${ordinal} settles ${settled}`).catch(async (error) => {
          const row = await agent.receipt(`msg_${ordinal}`);
          throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error})`);
        });
        if (left === "the provider's error") {
          const reason = (await agent.receipt(`msg_${ordinal}`))!.last_error ?? "";
          assert.match(reason, /LOCAL_PROVIDER_FAILURE_1517/, "the reason shown is the provider's, as the session kept it");
        } else if (left !== "its answer") {
          assert.equal((await agent.receipt(`msg_${ordinal}`))!.last_error, PROCESS_ENDED_DURING_TURN,
            "the room and the owner read why the message has no answer");
        }
        assert.equal(agent.recovery.requests.at(-1)?.recordEnding, true, "the daemon asks for the ending to be recorded: its record holds the turn open");
      }
      // The third process takes the next message.
      const third = await agent.begin(3);
      agent.reportStarted(third);
      agent.answer(third, "Answer 3.");
      await agent.eventually(async () => (await agent.receipt("msg_3"))?.state === "acknowledged", "msg_3 is answered");

      assert.deepEqual(agent.published, left === "its answer" ? ["Recovered 1.", "Recovered 2.", "Answer 3."] : ["Answer 3."],
        "a turn that was cut off is never run again, and never answered with something it did not say");
      await agent.eventually(() => agent.recorded().turns.every((turn) => turn.state === "terminal"), "every turn has its ending in the record");
      const record = agent.recorded();
      assert.deepEqual(record.turns.map((turn) => turn.provider_turn_id), agent.turns.map((turn) => turn.id), "all three turns are in the record");
      assert.deepEqual(record.endings.map((ending) => ending.n), [1, 1, 1], "each with one ending");
      assert.deepEqual(record.endings.map((ending) => ending.outcome), left === "its answer" ? ["completed", "completed", "completed"]
        : left === "the provider's error" ? ["failed", "failed", "completed"]
          : ["interrupted", "interrupted", "completed"], "which says how the turn ended: answered, failed at the provider, or cut off");
      assert.equal(record.gaps, 0, "and the record has no gap");
      assert.equal(agent.harness.children.length, 3, "two replacements");
      const current = await agent.view();
      assert.equal(current.condition, "none", current.last_error ?? "");
      assert.equal(current.room_agent_state.inbox.state, "empty", "nothing waits behind a message that needs a person");
    } finally {
      await agent.cleanup();
    }
  });
}

test("a Claude turn whose transcript is not found where its CLI keeps it is left for its owner, not settled as cut off", async () => {
  const agent = await claudeDaemonFixture();
  try {
    const turn = await agent.begin(1);
    agent.reportStarted(turn);
    await agent.eventually(() => agent.recorded().turns[0]?.state === "active", "the turn is recorded as started");
    // Its answer may well be in a session file; none is found where the CLI was told to keep it.
    agent.transcript.found = false;
    agent.exitProcess();
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "blocked", "msg_1 waits for its owner");
    assert.match((await agent.receipt("msg_1"))!.last_error ?? "", /found no transcript/, "with the reason");
    assert.deepEqual(agent.published, [], "nothing is published, and nothing is settled as failed");
    assert.equal(agent.transcript.readFrom.at(-1), claudeTranscriptsRoot(claudeChildEnvironment({})),
      "the adapter looked where a CLI started with the desktop's environment writes its transcripts");
  } finally {
    await agent.cleanup();
  }
});

test("Claude transcripts are read where the CLI writes them: its configured directory, or its home's", () => {
  const base = { HOME: "/home/owner", PATH: "/usr/bin" };
  assert.equal(claudeTranscriptsRoot(claudeChildEnvironment({}, base)), "/home/owner/.claude/projects");
  assert.equal(claudeTranscriptsRoot(claudeChildEnvironment({}, { ...base, CLAUDE_CONFIG_DIR: "/data/claude" })), "/data/claude/projects",
    "an owner who sets CLAUDE_CONFIG_DIR has their transcripts there");
  assert.equal(claudeTranscriptsRoot(claudeChildEnvironment({ ownerSetup: true }, { ...base, CLAUDE_CONFIG_DIR: "/data/claude" })), "/data/claude/projects",
    "so does an agent that runs with its owner's setup");
  assert.equal(claudeTranscriptsRoot(claudeChildEnvironment({ env: { LETAGENTS_RENTAL_CREDENTIAL_ISOLATION: "1" } }, { ...base, CLAUDE_CONFIG_DIR: "/data/claude" })),
    "/home/owner/.claude/projects", "a rented agent's CLI is not given the owner's directory, and writes in its home");
});

test("a Claude turn that ended before its process did is not given a second ending when its replacement reads it back", async () => {
  const agent = await claudeDaemonFixture();
  try {
    const turn = await agent.begin(1);
    agent.reportStarted(turn);
    // The CLI reports the answer, and the daemon fails to save it: the message is still to be settled when the process ends.
    agent.failNextResultCheckpoint(new Error("the result could not be saved"));
    agent.answer(turn, "Answer 1.");
    await agent.eventually(() => agent.recorded().turns[0]?.state === "terminal", "the turn's ending is in the record");
    agent.sessionRows.push(...CLAUDE_SESSION_AFTER_EXIT["its answer"](agent.sessionId, turn.id, 1));
    agent.exitProcess();
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered from the session");
    assert.equal(agent.recovery.requests.at(-1)?.recordEnding, undefined, "the record already has the ending; nothing asks for another");

    const next = await agent.begin(2);
    agent.reportStarted(next);
    agent.answer(next, "Answer 2.");
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    await agent.eventually(() => agent.recorded().turns.every((recorded) => recorded.state === "terminal"), "both turns are closed in the record");
    assert.deepEqual(agent.recorded().endings.map((ending) => ending.n), [1, 1], "one ending each");
    assert.equal(agent.recorded().gaps, 0);
  } finally {
    await agent.cleanup();
  }
});

test("a Claude turn whose process ended before it reported the turn started is in the record as lost, and is closed once when its replacement reads it back", async () => {
  const agent = await claudeDaemonFixture();
  try {
    // The process ends before it has reported the turn started. The adapter
    // names the turn it was asked to run when it reports the exit, so the
    // record holds the turn as lost although it never saw it start.
    const letRecoveryGo = agent.holdRecovery();
    const turn = await agent.begin(1);
    assert.deepEqual(agent.recorded().turns, [], "nothing is recorded for a turn that was only asked for");
    agent.sessionRows.push(...CLAUDE_SESSION_AFTER_EXIT["its answer"](agent.sessionId, turn.id, 1));
    agent.exitProcess();
    await agent.eventually(() => agent.recorded().turns[0]?.state === "lost", "the turn is recorded as lost with its process");
    letRecoveryGo();
    await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === "acknowledged", "msg_1 is answered from the session");
    assert.equal(agent.recovery.requests.at(-1)?.recordEnding, true, "the record holds the turn open, so its ending is asked for");

    const next = await agent.begin(2);
    agent.reportStarted(next);
    agent.answer(next, "Answer 2.");
    await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
    await agent.eventually(() => agent.recorded().turns.length === 2 && agent.recorded().turns.every((recorded) => recorded.state === "terminal"),
      "both turns are closed in the record");
    assert.deepEqual(agent.recorded().endings.map((ending) => ending.n), [1, 1], "one ending each");
    assert.equal(agent.recorded().gaps, 0);
  } finally {
    await agent.cleanup();
  }
});

for (const left of ["its answer", "half an answer"] as const) {
  test(`a Claude turn left lost by a daemon that ended before reading it back, with ${left} in the session, is closed by the next daemon`, async () => {
    const agent = await claudeDaemonFixture();
    try {
      const turn = await agent.begin(1);
      agent.reportStarted(turn);
      await agent.eventually(() => agent.recorded().turns[0]?.state === "active", "the turn is recorded as started");
      agent.sessionRows.push(...CLAUDE_SESSION_AFTER_EXIT[left](agent.sessionId, turn.id, 1));
      const letRecoveryGo = agent.holdRecovery();
      agent.exitProcess();
      await agent.eventually(() => agent.recorded().turns[0]?.state === "lost", "the turn is lost with its process, and that is saved");
      await agent.restartDaemon();
      letRecoveryGo();

      const settled = left === "its answer" ? "acknowledged" : "acknowledged_failed";
      await agent.eventually(async () => (await agent.receipt("msg_1"))?.state === settled, `msg_1 settles ${settled}`);
      assert.equal(agent.recovery.requests.at(-1)?.recordEnding, true, "the new daemon reads from its saved record that the turn is open");
      const next = await agent.begin(2);
      agent.reportStarted(next);
      agent.answer(next, "Answer 2.");
      await agent.eventually(async () => (await agent.receipt("msg_2"))?.state === "acknowledged", "msg_2 is answered");
      await agent.eventually(() => agent.recorded().turns.every((recorded) => recorded.state === "terminal"), "both turns are closed in the record");
      assert.deepEqual(agent.recorded().endings.map((ending) => ending.n), [1, 1]);
      assert.equal(agent.recorded().gaps, 0);
    } finally {
      await agent.cleanup();
    }
  });
}

test("Claude keeps an exact stream result when terminal checkpointing fails so recovery cannot redispatch", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;

  const running = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-checkpoint-failure",
    actionId: "action-checkpoint-failure",
    sourceMessage: {},
    activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {},
    checkpointTerminalResult: async () => {
      throw new Error("durable terminal checkpoint unavailable");
    },
  });
  await flush();
  const turnFrame = JSON.parse(child.written.at(-1)!) as { uuid: string };
  child.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: handle.providerContinuationId,
    user_message_uuid: turnFrame.uuid,
    result: "Completed before the checkpoint failed.",
  });
  await assert.rejects(running, /durable terminal checkpoint unavailable/);

  const writesBeforeRecovery = child.written.length;
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-checkpoint-failure",
    providerTurnId: turnFrame.uuid,
  }, {
    checkpointTerminalResult: async () => {},
  }), {
    turnId: turnFrame.uuid,
    outcome: "reply",
    text: "Completed before the checkpoint failed.",
    evidence: "stream",
  });
  assert.equal(child.written.length, writesBeforeRecovery, "recovery consumes cached exact evidence without another native turn");
});

test("Claude clears exact-turn observation and fails the continuation when stdin dispatch throws", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  child.writeLine = () => {
    throw new Error("Claude CLI stdin is unavailable.");
  };

  let persistedTurnId = "";
  await assert.rejects(adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-dead-stdin",
    actionId: "action-dead-stdin",
    sourceMessage: {},
    activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async (turnId) => { persistedTurnId = turnId; },
  }), /stdin is unavailable/);
  assert.ok(persistedTurnId, "the exact turn id remains available for durable recovery");
  assert.equal(handle.observedState(), "failed");
  await assert.rejects(adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-after-dead-stdin",
    actionId: "action-after-dead-stdin",
    sourceMessage: {},
    activation: {},
  }), /continuation has failed/);
});

test("Claude recovery fails closed when the exact terminal boundary is absent", async () => {
  const harness = createHarness({
    sessionRows: [{
      type: "user",
      uuid: "turn-partial",
      sessionId: "sess-old",
      message: { content: [{ type: "text", text: "source" }] },
    }],
  });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.resume(
    { workAttemptId: "wa-claude-1", providerContinuationId: "sess-old" },
    spawnRequest(),
  );
  await assert.rejects(
    adapter.recoverRoomTurn!(handle, {
      inboxItemId: "inbox-partial",
      providerTurnId: "turn-partial",
    }),
    (error: unknown) => {
      assert.match(String(error), /cannot prove.*terminal boundary/);
      assert.equal((error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome, "ambiguous");
      return true;
    },
  );
});

test("Claude turn control interrupts only the active bounded turn and refuses correction side turns", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  const running = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-interrupt",
    actionId: "action-interrupt",
    sourceMessage: {},
    activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {},
  });
  await flush();
  const turnFrame = JSON.parse(child.written.at(-1)!) as { uuid: string };

  let checkpointedTurnId: string | null = null;
  const controlled = adapter.controlTurn!(handle, null, {
    targetTurnId: turnFrame.uuid,
    checkpointTurnStarted: async (turnId) => { checkpointedTurnId = turnId; },
    markDispatched: async () => {},
  });
  await flush();
  const controlFrame = JSON.parse(child.written.at(-1)!) as Record<string, unknown>;
  assert.equal(checkpointedTurnId, turnFrame.uuid);
  assert.equal(controlFrame.type, "control_request");

  child.emit({
    type: "result",
    subtype: "interrupted",
    is_error: true,
    session_id: handle.providerContinuationId,
    user_message_uuid: turnFrame.uuid,
  });
  assert.deepEqual(await controlled, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
  assert.equal((await running).outcome, "interrupted");
  const writesAfterInterrupt = child.written.length;
  await assert.rejects(
    adapter.controlTurn!(handle, "Start another untracked turn."),
    /cannot start an unjournaled correction turn/,
  );
  assert.equal(child.written.length, writesAfterInterrupt);
});

test("Claude 2.1.238 UUID-less interrupt boundary settles only the daemon-fenced exact turn", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const child = harness.children[0]!;
  const events: NativeExecutionObservation[] = [];
  const activities: ProviderActivityEvent[] = [];
  adapter.onExecution(handle, (event) => events.push(event));
  adapter.onActivity(handle, (event) => activities.push(event));
  const request = { inboxItemId: "inbox-uuidless-interrupt", actionId: "action-uuidless-interrupt", sourceMessage: {}, activation: {} };
  const running = adapter.runRoomTurn!(handle, request);
  await flush();
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: handle.providerContinuationId });

  const controlled = adapter.controlTurn!(handle, null, {
    targetTurnId: turnId,
    checkpointTurnStarted: async () => {},
    markDispatched: async () => {},
  });
  await flush();
  const boundary = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    session_id: handle.providerContinuationId,
  };
  child.emit(boundary);

  assert.deepEqual(await controlled, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
  assert.equal((await running).outcome, "interrupted");
  assert.equal(handle.observedState(), "idle");
  const terminalFacts = events.filter(({ fact }) => fact.domain === "turn"
    && fact.state === "terminal"
    && fact.providerTurnId === turnId);
  assert.equal(terminalFacts.length, 1);
  const terminalFact = terminalFacts[0]!.fact;
  assert.equal(terminalFact.domain, "turn");
  if (terminalFact.domain !== "turn") throw new Error("expected an exact turn terminal");
  assert.equal(terminalFact.turnOutcome, "interrupted");
  const rawBoundary = stream.find((event) => event.method === "result/error_during_execution");
  assert.equal(rawBoundary?.nativeLifecyclePhase, "turn_terminal");
  assert.equal((rawBoundary?.payload as Record<string, unknown>).user_message_uuid, undefined,
    "the published provider payload remains raw; exact correlation is local context");

  child.emit(boundary);
  await flush();
  assert.equal(events.filter(({ fact }) => fact.domain === "turn"
    && fact.state === "terminal"
    && fact.providerTurnId === turnId).length, 1,
  "a duplicate UUID-less boundary reuses the original typed terminal");
  const replayedBoundaries = stream.filter((event) => event.method === "result/error_during_execution");
  assert.equal(replayedBoundaries.length, 2);
  assert.equal(replayedBoundaries[1]!.nativeEventId, replayedBoundaries[0]!.nativeEventId);
  assert.equal(activities.at(-1)?.summary, "Turn interrupted");

  const next = adapter.runRoomTurn!(handle, { ...request, inboxItemId: "inbox-after-interrupt", actionId: "action-after-interrupt" });
  await flush();
  const nextId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({
    type: "result", subtype: "success", is_error: false,
    session_id: handle.providerContinuationId, user_message_uuid: nextId, result: "reused",
  });
  assert.equal((await next).text, "reused");
});

test("Claude UUID-less interrupt compatibility stays fenced across malformed and late boundaries", async () => {
  const withoutStop = createHarness();
  const standaloneAdapter = new ClaudeCodeProviderAdapter({ dependencies: withoutStop.dependencies });
  const standaloneHandle = await standaloneAdapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const standaloneChild = withoutStop.children[0]!;
  const standaloneEvents: NativeExecutionObservation[] = [];
  standaloneAdapter.onExecution(standaloneHandle, (event) => standaloneEvents.push(event));
  const standalone = standaloneAdapter.runRoomTurn!(standaloneHandle, {
    inboxItemId: "inbox-unprompted-abort", actionId: "action-unprompted-abort", sourceMessage: {}, activation: {},
  });
  let standaloneSettled = false;
  void standalone.then(() => { standaloneSettled = true; }, () => { standaloneSettled = true; });
  await flush();
  const standaloneTurnId = (JSON.parse(standaloneChild.written.at(-1)!) as { uuid: string }).uuid;
  standaloneChild.emit({
    type: "result", subtype: "error_during_execution", is_error: true,
    terminal_reason: "aborted_streaming", session_id: standaloneHandle.providerContinuationId,
  });
  await flush();
  assert.equal(standaloneSettled, false, "an identical frame without a daemon interrupt is not exact evidence");
  assert.equal(standaloneEvents.some(({ fact }) => fact.domain === "turn" && fact.state === "terminal"), false);
  standaloneChild.emit({
    type: "result", subtype: "success", is_error: false,
    session_id: standaloneHandle.providerContinuationId, user_message_uuid: standaloneTurnId, result: "natural",
  });
  assert.equal((await standalone).text, "natural");

  for (const { name, patch } of [
    { name: "wrong terminal reason", patch: { terminal_reason: "different_reason" } },
    { name: "missing terminal reason", patch: { terminal_reason: undefined } },
    { name: "wrong session", patch: { session_id: "different-session" } },
    { name: "foreign turn UUID", patch: { user_message_uuid: "foreign-turn" } },
    { name: "empty turn UUID", patch: { user_message_uuid: "" } },
    { name: "wrong subtype", patch: { subtype: "different_subtype" } },
    { name: "non-error result", patch: { is_error: false } },
  ]) {
    const harness = createHarness();
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
    const child = harness.children[0]!;
    const running = adapter.runRoomTurn!(handle, {
      inboxItemId: "inbox-late-interrupt", actionId: "action-late-interrupt", sourceMessage: {}, activation: {},
    });
    await flush();
    const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
    const controlled = adapter.controlTurn!(handle, null, {
      targetTurnId: turnId,
      checkpointTurnStarted: async () => {},
      markDispatched: async () => {},
    });
    await flush();
    const malformedFrame: Record<string, unknown> = {
      type: "result", subtype: "error_during_execution", is_error: true,
      terminal_reason: "aborted_streaming", session_id: handle.providerContinuationId,
    };
    Object.assign(malformedFrame, patch);
    child.emit(malformedFrame);
    await assert.rejects(controlled, (error: unknown) => {
      assert.equal((error as { turnControlOutcome?: unknown }).turnControlOutcome, "uncertain");
      return true;
    }, name);

    child.emit({
      type: "result", subtype: "error_during_execution", is_error: true,
      terminal_reason: "aborted_streaming", session_id: handle.providerContinuationId,
    });
    assert.equal((await running).outcome, "interrupted",
      "the retained exact-turn context recognizes the late provider boundary");
    assert.equal(handle.observedState(), "idle");
  }
});

for (const natural of [
  { name: "success", frame: { subtype: "success", is_error: false, result: "natural result" } },
  { name: "failure", frame: { subtype: "error_during_execution", is_error: true } },
]) {
  test(`Claude exact ${natural.name} racing an interrupt remains the natural terminal`, async () => {
    const harness = createHarness();
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
    const child = harness.children[0]!;
    const running = adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-natural-${natural.name}`,
      actionId: `action-natural-${natural.name}`,
      sourceMessage: {},
      activation: {},
    });
    await flush();
    const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
    const controlled = adapter.controlTurn!(handle, null, {
      targetTurnId: turnId,
      checkpointTurnStarted: async () => {},
      markDispatched: async () => {},
    });
    await flush();
    child.emit({
      type: "result",
      session_id: handle.providerContinuationId,
      user_message_uuid: turnId,
      ...natural.frame,
    });

    await assert.rejects(controlled, (error: unknown) => {
      assert.equal((error as { turnControlOutcome?: unknown }).turnControlOutcome, "not_applied");
      return true;
    });
    if (natural.name === "success") {
      assert.equal((await running).text, "natural result");
    } else {
      assert.equal((await running).outcome, "failed");
    }
    assert.equal(handle.observedState(), "idle");
  });
}

for (const subtype of ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) {
  test(`Claude ${subtype} fails only the exact turn and leaves the continuation reusable`, async () => {
    const harness = createHarness();
    const stream: ProviderStreamEvent[] = [];
    const adapter = new ClaudeCodeProviderAdapter({
      dependencies: harness.dependencies,
      streamSink: (event) => stream.push(event),
    });
    const handle = await adapter.spawn(spawnRequest());
    const child = harness.children[0]!;
    const request = { inboxItemId: "inbox-limited", actionId: "action-limited", sourceMessage: {}, activation: {} };
    const options = { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} };
    const running = adapter.runRoomTurn!(handle, request, options);
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    const frame = JSON.parse(child.written.at(-1)!) as { uuid: string };
    for (const identity of [
      { session_id: "different-session", user_message_uuid: frame.uuid },
      { session_id: handle.providerContinuationId, user_message_uuid: "different-turn" },
    ]) {
      child.emit({ type: "result", subtype, is_error: true, ...identity });
      await flush();
      assert.equal(settled, false, "uncorrelated results cannot settle the active room turn");
    }
    child.emit({
      type: "result", subtype, is_error: true,
      session_id: handle.providerContinuationId, user_message_uuid: frame.uuid,
      errors: ["Configured turn limit reached."],
    });
    assert.equal((await running).outcome, "failed");
    assert.equal(handle.observedState(), "idle");
    assert.equal(stream.at(-1)?.kind, "turn_lifecycle");
    assert.equal(stream.at(-1)?.method, `result/${subtype}`);
    assert.equal(providerStreamLifecycle(stream.at(-1)!), "idle");
    assert.equal((stream.at(-1)?.payload as { is_error: boolean }).is_error, true);

    const writesBeforeRecovery = child.written.length;
    assert.equal((await adapter.recoverRoomTurn!(handle, {
      inboxItemId: request.inboxItemId, providerTurnId: frame.uuid,
    })).outcome, "failed");
    assert.equal(child.written.length, writesBeforeRecovery, "exact failed-turn evidence is retained without replay");

    const next = adapter.runRoomTurn!(handle, { ...request, inboxItemId: "inbox-next", actionId: "action-next" }, options);
    await flush();
    const nextFrame = JSON.parse(child.written.at(-1)!) as { uuid: string };
    assert.notEqual(nextFrame.uuid, frame.uuid);
    child.emit({
      type: "result", subtype: "success", is_error: false,
      session_id: handle.providerContinuationId, user_message_uuid: nextFrame.uuid,
      result: "The next turn completed.",
    });
    assert.deepEqual(await next, { turnId: nextFrame.uuid, outcome: "reply", text: "The next turn completed.", evidence: "stream" });
    assert.equal(harness.children.length, 1);
    assert.equal(child.alive, true);
    assert.deepEqual(harness.signals, []);
  });
}

for (const subtype of ["error_during_execution", "error_max_unknown_limit", "error_max_turns_extra"]) {
  test(`Claude ${subtype} retains legacy runtime failure handling`, async () => {
    const harness = createHarness();
    const stream: ProviderStreamEvent[] = [];
    const adapter = new ClaudeCodeProviderAdapter({
      dependencies: harness.dependencies,
      streamSink: (event) => stream.push(event),
    });
    const handle = await adapter.spawn(spawnRequest());
    harness.children[0]!.emit({
      type: "result",
      subtype,
      is_error: true,
      result: "native provider failure",
    });
    await flush();

    assert.equal(handle.observedState(), "failed");
    assert.equal(stream.at(-1)?.kind, "error");
    assert.equal(stream.at(-1)?.method, `result/${subtype}`);
    assert.equal(providerStreamLifecycle(stream.at(-1)!), "failed");
  });
}

test("Claude typed observations correlate native turns and completed tools without inventing execution starts", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  const stream: ProviderStreamEvent[] = [];
  const stopStream = adapter.onStream(handle, (event) => stream.push(event));
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, () => { throw new Error("shadow persistence unavailable"); });
  adapter.onExecution(handle, (event) => events.push(event));
  assert.deepEqual(events.map(({ fact }) => fact), [{
    domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none",
  }], "subscription replays verified runtime readiness, never bootstrap room work");
  assert.deepEqual(adapter.capabilities().execution, {
    controlProbe: "unsupported", approvals: { kinds: ["command"], recovery: "native_instance_only", denyScope: "request" },
  });
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" });
  assert.deepEqual(events.map(({ fact }) => fact), [
    { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
    { domain: "control", kind: "state_changed", state: "unprobeable", sideEffects: "none" },
  ], "the unsupported probe state is still published to typed-shadow history");
  const request = { inboxItemId: "typed-inbox", actionId: "typed-action", sourceMessage: {}, activation: {} };
  const running = adapter.runRoomTurn(handle, request);
  await flush();
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  const session_id = handle.providerContinuationId;
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: "wrong", session_id });
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: "wrong" });
  child.emit({ type: "assistant", session_id, message: { content: [
    { type: "tool_use", id: "bootstrap-tail", name: "Bash", input: { command: "late-bootstrap" } },
  ] } });
  child.emit({ type: "user", session_id, message: { content: [
    { type: "tool_result", tool_use_id: "bootstrap-tail", is_error: false, content: "finished" },
  ] } });
  assert.equal(events.length, 2);
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id });
  child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id });
  child.emit({ type: "user", session_id, message: { content: [
    { type: "tool_result", tool_use_id: "bootstrap-tail", is_error: false, content: "finished" },
  ] } });
  child.emit({ type: "assistant", session_id, message: { content: [
    { type: "tool_use", id: "shell-1", name: "Bash", input: { command: "secret-command" } },
  ] } });
  assert.equal(events.length, 3, "the control state, runtime readiness, and native turn start are proved");
  child.emit({ type: "user", session_id, message: { content: [
    { type: "tool_result", tool_use_id: "unmatched", is_error: true, content: "secret-output" },
    { type: "tool_result", tool_use_id: "shell-1", is_error: true, content: "secret-output" },
  ] } });
  child.emit({ type: "user", session_id, message: { content: [
    { type: "tool_result", tool_use_id: "shell-1", is_error: true },
  ] } });
  const failedResult = { type: "result", subtype: "error_max_turns", is_error: true, session_id, user_message_uuid: turnId };
  child.emit(failedResult);
  assert.equal((await running).outcome, "failed");
  child.emit(failedResult);
  assert.equal(handle.observedState(), "idle", "typed collection preserves legacy containment");
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" }, "turn failure is not runtime death");

  const next = adapter.runRoomTurn(handle, { ...request, inboxItemId: "typed-next" });
  await flush();
  const nextId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "result", subtype: "success", is_error: false, session_id, user_message_uuid: nextId, result: "ready" });
  assert.equal((await next).text, "ready");
  let projection = emptyExecutionProjection();
  let runtimeReadyObserved = false;
  for (const event of events) {
    projection = reduceExecutionFact(projection, {
      ...event.fact, ...("providerTurnId" in event.fact ? { turnId: event.fact.providerTurnId } : {}),
      factId: `fact-${event.sequence}`, agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "runtime",
      observerEpoch: 1, sourceSequence: event.sequence, observedAtMs: event.observedAtMs,
    });
    assert.equal(event.nativeProcessIdentity, birthIdentity(child.pid!));
    if (event.fact.domain === "runtime" && event.fact.state === "ready") runtimeReadyObserved = true;
    if (runtimeReadyObserved) {
      assert.equal(projection.runtime, "ready", "the exact native start proves readiness, which survives turn failure");
    }
  }
  assert.equal(projection.turns.get(turnId)?.outcome, "failed");
  assert.equal(projection.turns.get(nextId)?.outcome, "completed");
  assert.equal(projection.turns.get(turnId)?.operations.get("shell-1")?.startObserved, false);
  assert.equal(projection.turns.get(turnId)?.operations.get("shell-1")?.outcome, "failed");
  assert.equal(events.filter((event) => event.fact.domain === "execution").length, 1);
  assert.doesNotMatch(JSON.stringify(events), /secret-command|secret-output/);
  const streamCheckpointIds = [...new Set(stream.flatMap((event) => event.nativeEventId ? [event.nativeEventId] : []))];
  const typedCheckpointIds = [...new Set(events.flatMap((event) => event.fact.nativeEventId ? [event.fact.nativeEventId] : []))];
  assert.deepEqual(typedCheckpointIds, streamCheckpointIds,
    "exact native command lifecycle and result records correlate both projections");
  assert.equal(stream.every((event) => !event.nativeEventId || event.nativeLifecyclePhase ===
    (event.method === "command_lifecycle" ? "turn_active" : "turn_terminal")), true,
  "correlated Claude events expose only the closed structural lifecycle phase");
  assert.equal(streamCheckpointIds.length, 3, "one start and two terminal records have distinct identities");
  const terminalIds = stream.filter((event) => event.method.startsWith("result") && event.nativeEventId)
    .map((event) => event.nativeEventId);
  assert.equal(terminalIds.length, 3);
  assert.equal(terminalIds[0], terminalIds[1], "an identical terminal replay keeps the first checkpoint identity");
  assert.equal(events.filter((event) => event.fact.domain === "turn" && event.fact.state === "terminal"
    && event.fact.nativeEventId === terminalIds[0]).length, 1, "a replay does not emit another typed terminal");
  const repeatedStartIds = stream.filter((event) => event.method === "command_lifecycle" && event.nativeEventId)
    .map((event) => event.nativeEventId);
  assert.equal(repeatedStartIds.length, 2, "only the two exact repeated native starts are eligible");
  assert.equal(new Set(repeatedStartIds).size, 1, "a replayed native start keeps the same checkpoint identity");
  assert.equal(stream.some((event) => ["assistant", "user"].includes(event.method) && event.nativeEventId !== undefined), false);
  assert.equal(events.some((event) => event.fact.domain === "execution" && event.fact.nativeEventId !== undefined), false);
  assert.deepEqual(harness.signals, []);
  stopStream();
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.deepEqual(await adapter.probeControl(handle), { state: "lost", controlEvidence: "process_exit" });
  assert.equal(events.at(-1)?.fact.domain, "runtime");
});

test("Claude shadow native terminal remains observable behind a legacy failed-state latch", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const events: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => events.push(event));
  const running = adapter.runRoomTurn(handle, { inboxItemId: "latch", actionId: "latch", sourceMessage: {}, activation: {} });
  const rejected = assert.rejects(running, /exited/);
  await flush();
  const child = harness.children[0]!;
  const turnId = (JSON.parse(child.written.at(-1)!) as { uuid: string }).uuid;
  child.emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: handle.providerContinuationId, user_message_uuid: "foreign" });
  assert.equal(handle.observedState(), "failed");
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: handle.providerContinuationId, user_message_uuid: turnId });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0]!.fact, {
    domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none",
  });
  const { nativeEventId, ...terminalFact } = events[1]!.fact;
  assert.match(nativeEventId ?? "", /^nlc1:[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(terminalFact, { domain: "turn", kind: "state_changed", state: "terminal", sideEffects: "none",
    providerContinuationId: handle.providerContinuationId, providerTurnId: turnId, turnOutcome: "completed" });
  assert.equal(handle.observedState(), "failed", "shadow must not repair or rewrite legacy behavior");
  assert.deepEqual(harness.signals, []);
  child.resolveExit({ type: "exit", code: 1, signal: null });
  await rejected;
});

const claudeAskPolicy = {
  permissionMode: "default", dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
  tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"],
  allowedTools: ["mcp__letagents__*"], settingSources: "", settings: "{}",
};

async function approvalHarness(detachSignal?: AbortSignal) {
  const harness = createHarness({ versionOutput: "2.1.272 (Claude Code)" });
  const streams: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, streamSink: event => streams.push(event) });
  const handle = await adapter.spawn(spawnRequest({ permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: claudeAskPolicy }));
  const child = harness.children[0]!;
  const controller = new AbortController();
  let requests: import("../../shared/provider-permissions.js").ClaudeNativePermissionRequest[] = [];
  const closures: import("../../shared/provider-permissions.js").ClaudePermissionObservation[] = [];
  const facts: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, event => facts.push(event));
  const observing = adapter.observePermissions(handle, event => { if (event.type === "snapshot") requests = [...event.requests]; else if (event.type === "request_closed") closures.push(event); }, controller.signal);
  const running = adapter.runRoomTurn(handle, { inboxItemId: "approval-inbox", actionId: "approval-action", sourceMessage: { text: "Write a file" }, activation: {} }, { detachSignal });
  void running.catch(() => {});
  await flush();
  const turnId = JSON.parse(child.written.at(-1)!).uuid as string;
  const started = () => child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: handle.providerContinuationId });
  const tool = (over: Record<string, unknown> = {}) => child.emit({ type: "assistant", session_id: handle.providerContinuationId, parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "tool-write", name: "Write", input: { file_path: "/tmp/output", content: "private approval content" } }] }, ...over });
  const permission = (over: Record<string, unknown> = {}) => child.emit({ type: "control_request", request_id: "native-request",
    request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "tool-write", input: { file_path: "/tmp/output", content: "private approval content" },
      permission_suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] }, ...over });
  return { harness, adapter, handle, child, streams, turnId, started, tool, permission, facts,
    get requests() { return requests; }, closures,
    async close() {
      child.emit({ type: "result", subtype: "success", is_error: false, session_id: handle.providerContinuationId, user_message_uuid: turnId, result: "Done" });
      await running.catch(() => {}); controller.abort(); await observing; await adapter.stop(handle);
    } };
}

test("Claude Ask before writes owns prompting policy and requires native exact-turn capability", async () => {
  const h = await approvalHarness();
  try {
    assert.equal(argValue(h.harness.launches[0]!.args, "--permission-prompt-tool"), "stdio");
    assert.equal(argValue(h.harness.launches[0]!.args, "--permission-mode"), "default");
    assert.equal(argValue(h.harness.launches[0]!.args, "--setting-sources"), "");
    assert.equal(h.adapter.capabilities().execution?.approvals.denyScope, "request");
  } finally { await h.close(); }
  const old = createHarness({ noApprovalLifecycle: true, versionOutput: "2.1.272 (Claude Code)" });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: old.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest({ permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: claudeAskPolicy })), /exact native turn lifecycle/);
  assert.equal(old.children[0]!.alive, false);
  for (const override of [{ permissionMode: "acceptEdits" }, { allowedTools: ["*"] }, { settings: '{"permissions":{"allow":["Bash"]}}' }, { "permission-mode": "bypassPermissions" }]) {
    await assert.rejects(adapter.spawn(spawnRequest({ permissionProfileId: "ask_before_write", configurationRevision: 1, launchPolicy: { ...claudeAskPolicy, ...override } })), /authority|cannot override/);
  }
});

test("Claude Auto starts in the native mode, keeps the prompt bridge, and refuses a runtime that did not apply it", async () => {
  const claudeAutoPolicy = { ...claudeAskPolicy, permissionMode: "auto" };
  const request = () => spawnRequest({ permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: claudeAutoPolicy });
  const harness = createHarness({ versionOutput: "2.1.272 (Claude Code)", initPermissionMode: "auto" });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(request());
  try {
    const args = harness.launches[0]!.args;
    assert.equal(argValue(args, "--permission-mode"), "auto");
    assert.equal(argValue(args, "--permission-prompt-tool"), "stdio", "anything Claude leaves undecided still reaches the host");
    assert.equal(argValue(args, "--setting-sources"), "");
    assert.equal(argValue(args, "--settings"), "{}");
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    assert.equal(args.includes("--allow-dangerously-skip-permissions"), false);
  } finally { await adapter.stop(handle); }

  const unsupported = createHarness({ versionOutput: "2.1.272 (Claude Code)" });
  await assert.rejects(new ClaudeCodeProviderAdapter({ dependencies: unsupported.dependencies }).spawn(request()), /did not start in Auto mode/);
  assert.equal(unsupported.children[0]!.alive, false);

  const old = createHarness({ versionOutput: "2.1.220 (Claude Code)", initPermissionMode: "auto" });
  await assert.rejects(new ClaudeCodeProviderAdapter({ dependencies: old.dependencies }).spawn(request()), /too old for Auto/);
  assert.equal(old.children.length, 0);

  const noLifecycle = createHarness({ noApprovalLifecycle: true, versionOutput: "2.1.272 (Claude Code)", initPermissionMode: "auto" });
  await assert.rejects(new ClaudeCodeProviderAdapter({ dependencies: noLifecycle.dependencies }).spawn(request()), /exact native turn lifecycle/);

  for (const override of [{ permissionMode: "bypassPermissions" }, { permissionMode: "default" }, { allowedTools: ["*"] }, { "permission-mode": "bypassPermissions" }, { dangerouslySkipPermissions: true }]) {
    await assert.rejects(adapter.spawn(spawnRequest({ permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: { ...claudeAutoPolicy, ...override } })), /authority|cannot override/);
  }
});

for (const reply of ["once", "reject"] as const) test(`Claude native ${reply} applies once to the exact tool and never persists permission suggestions`, async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission(); const expected = h.requests[0]!;
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, expected), { outcome: "correlated", providerContinuationId: h.handle.providerContinuationId, providerTurnId: h.turnId });
    h.permission(); assert.equal(h.requests.length, 1);
    const order: string[] = [];
    assert.deepEqual(await h.adapter.replyPermission(h.handle, expected, reply, { beforeNativeDispatch: async () => { order.push("journal"); }, assertNativeDispatch: () => { order.push("fence"); } }), { outcome: "sent", scope: "request" });
    assert.deepEqual(order, ["journal", "fence"]);
    const response = JSON.parse(h.child.written.at(-1)!).response;
    assert.equal(response.request_id, expected.id);
    assert.deepEqual(response.response, reply === "once" ? { behavior: "allow", updatedInput: expected.request.input } : { behavior: "deny", message: "The host rejected this action." });
    assert.equal(h.requests.length, 0);
    assert.equal(h.streams.some(event => event.method === "control_request"), false);
    h.permission(); assert.equal(h.requests.length, 0, "resolved IDs cannot be reused");
    await assert.rejects(h.adapter.replyPermission(h.handle, expected, reply, { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});

// Claude reports a denied tool as a generic error result. Only a deny this adapter wrote for that exact
// tool, followed by an error result for it, shows that the tool never ran.
for (const scenario of ["host denied, error result", "host denied, result is not an error", "host allowed, error result",
  "no host answer, error result", "host denied another tool"] as const) {
  test(`Claude reports the outcome of a tool after: ${scenario}`, async () => {
    const h = await approvalHarness();
    try {
      h.started(); h.tool(); h.permission(); const expected = h.requests[0]!;
      if (scenario !== "no host answer, error result") {
        const other = scenario === "host denied another tool";
        if (other) {
          h.child.emit({ type: "assistant", session_id: h.handle.providerContinuationId, parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "tool-other", name: "Write", input: {} }] } });
          h.child.emit({ type: "control_request", request_id: "other-request",
            request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "tool-other", input: {} } });
        }
        const target = other ? h.requests.find(request => request.id === "other-request")! : expected;
        await h.adapter.replyPermission(h.handle, target, scenario === "host allowed, error result" ? "once" : "reject", { beforeNativeDispatch: async () => {} });
      }
      h.child.emit({ type: "user", session_id: h.handle.providerContinuationId,
        message: { content: [{ type: "tool_result", tool_use_id: "tool-write", content: "result",
          is_error: scenario !== "host denied, result is not an error" }] } });
      const completed = h.facts.map(event => event.fact).filter(fact => fact.domain === "execution" && fact.kind === "completed");
      assert.equal(completed.length, 1);
      const fact = completed[0]!;
      assert.equal(fact.domain === "execution" && fact.executionId, "tool-write");
      if (scenario === "host denied, error result") {
        assert.equal(fact.domain === "execution" && fact.kind === "completed" && fact.outcome, "denied_before_start");
        assert.equal(fact.sideEffects, "none");
      } else {
        assert.equal(fact.domain === "execution" && fact.kind === "completed" && fact.outcome,
          scenario === "host denied, result is not an error" ? "succeeded" : "failed");
        assert.equal(fact.sideEffects, "possible");
      }
    } finally { await h.close(); }
  });
}

test("Claude approval correlation excludes pre-start, foreign, subagent, changed and completed tools", async () => {
  const h = await approvalHarness();
  try {
    h.tool(); h.permission(); assert.equal(h.requests.length, 0);
    h.started(); h.tool({ session_id: "foreign" }); h.permission();
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, h.requests[0]!), { outcome: "correlation_unproven" });
    h.child.emit({ type: "control_cancel_request", request_id: "native-request" });
    h.tool({ parent_tool_use_id: "subagent" }); h.permission({ request_id: "subagent-request" });
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, h.requests[0]!), { outcome: "correlation_unproven" });
    h.tool(); h.permission({ request_id: "valid-request" });
    const expected = h.requests.find(request => request.id === "valid-request")!;
    const changed = structuredClone(expected); changed.request.input.content = "changed";
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, changed), { outcome: "correlation_unproven" });
    await assert.rejects(h.adapter.replyPermission(h.handle, changed, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
    h.child.emit({ type: "user", session_id: h.handle.providerContinuationId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-write", content: "Denied", is_error: true }] } });
    await assert.rejects(h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});

for (const invalidation of ["cancel", "disconnect", "process-replaced", "terminal"] as const) {
  test(`Claude approval is fenced when ${invalidation} arrives during durable admission`, async () => {
    const h = await approvalHarness();
    try {
      h.started(); h.tool(); h.permission(); const expected = h.requests[0]!;
      const before = h.child.written.length;
      await assert.rejects(h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: async () => {
        if (invalidation === "cancel") h.child.emit({ type: "control_cancel_request", request_id: expected.id });
        if (invalidation === "disconnect") h.child.disconnect();
        if (invalidation === "process-replaced") h.harness.identities.set(h.handle.pid!, "other-birth");
        if (invalidation === "terminal") h.child.emit({ type: "result", subtype: "success", is_error: false, session_id: h.handle.providerContinuationId, user_message_uuid: h.turnId, result: "Done" });
      } }), { outcome: "not_dispatched" });
      assert.equal(h.child.written.length, before);
    } finally { await h.close(); }
  });
}

test("Claude approval serializes replies and refuses retry after an uncertain stdin write", async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission(); const expected = h.requests[0]!;
    let release!: () => void; const admitted = new Promise<void>(resolve => { release = resolve; });
    const first = h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: () => admitted });
    await assert.rejects(h.adapter.replyPermission(h.handle, expected, "reject", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
    const original = h.child.writeLine.bind(h.child);
    h.child.writeLine = () => { throw new Error("pipe lost after write attempt"); };
    release(); await assert.rejects(first, { outcome: "uncertain" });
    h.child.writeLine = original;
    await assert.rejects(h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});

for (const observer of ["attached", "detached before interrupt", "detached during interrupt"]) test(`Claude cancellation at a native approval uses its exact aborted-tools boundary (${observer})`, async () => {
  const delivery = new AbortController();
  const h = await approvalHarness(delivery.signal);
  try {
    h.started(); h.tool(); h.permission(); const pending = h.requests[0]!;
    if (observer === "detached before interrupt") {
      delivery.abort();
      await flush();
      assert.equal(h.handle.observedState(), "working", "detaching delivery does not stop native work");
    }
    const interrupted = h.adapter.controlTurn(h.handle, null, { targetTurnId: h.turnId });
    if (observer === "detached during interrupt") delivery.abort();
    await flush();
    h.child.emit({ type: "control_cancel_request", request_id: pending.id });
    h.child.emit({ type: "result", subtype: "error_during_execution", terminal_reason: "aborted_tools", is_error: true,
      session_id: h.handle.providerContinuationId, user_message_uuid: h.turnId });
    assert.equal((await interrupted).interrupted, true);
    assert.equal(h.handle.observedState(), "idle");
    const writes = h.child.written.length;
    const recovered = await h.adapter.recoverRoomTurn(h.handle, { inboxItemId: "approval-inbox", providerTurnId: h.turnId });
    assert.equal(recovered.outcome, "interrupted");
    assert.equal(h.child.written.length, writes, "recovery consumes the interrupted result without another native request");
    await assert.rejects(h.adapter.replyPermission(h.handle, pending, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});

for (const invalid of ["foreign session", "foreign turn", "missing tool turn", "natural failure"]) {
  test(`detached Claude interruption still rejects ${invalid} evidence`, async () => {
    const delivery = new AbortController();
    const h = await approvalHarness(delivery.signal);
    try {
      h.started(); h.tool(); h.permission();
      delivery.abort();
      await flush();
      const interrupted = h.adapter.controlTurn(h.handle, null, { targetTurnId: h.turnId });
      const rejected = assert.rejects(interrupted, /instead of an exact-session interrupted boundary/);
      await flush();
      h.child.emit({ type: "result", subtype: "error_during_execution", is_error: true,
        terminal_reason: invalid === "natural failure" ? "tool_error" : "aborted_tools",
        session_id: invalid === "foreign session" ? "other-session" : h.handle.providerContinuationId,
        user_message_uuid: invalid === "foreign turn" ? "other-turn" : invalid === "missing tool turn" ? undefined : h.turnId });
      await rejected;
    } finally { await h.close(); }
  });
}

test("Claude explicit foreign tool-turn UUID cannot create or resolve approval authority", async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool({ user_message_uuid: "previous-turn" }); h.permission();
    assert.deepEqual(await h.adapter.correlatePermissionTurn(h.handle, h.requests[0]!), { outcome: "correlation_unproven" });
    await assert.rejects(h.adapter.replyPermission(h.handle, h.requests[0]!, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
    h.child.emit({ type: "control_cancel_request", request_id: "native-request" });
    h.tool({ user_message_uuid: h.turnId }); h.permission({ request_id: "current-request" });
    const expected = h.requests[0]!;
    const result = { type: "user", session_id: h.handle.providerContinuationId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-write", content: "Done" }] } };
    h.child.emit({ ...result, user_message_uuid: "previous-turn" });
    assert.equal((await h.adapter.correlatePermissionTurn(h.handle, expected)).outcome, "correlated");
    h.child.emit({ ...result, user_message_uuid: h.turnId });
    assert.equal((await h.adapter.correlatePermissionTurn(h.handle, expected)).outcome, "correlation_unproven");
  } finally { await h.close(); }
});

test("Claude refuses to fall back to npx when the sealed MCP runtime cannot be verified", async () => {
  assert.throws(() => createManagedClaudeMcpConfig("https://letagents.example", tmpdir(), undefined, () => {
    throw new Error("runtime integrity failure");
  }), /runtime integrity failure/);
});

for (const cause of ["cancel", "failed", "succeeded", "terminal"] as const) {
  test(`Claude publishes exact request closure for ${cause}, including a sent prompt`, async () => {
    const h = await approvalHarness();
    try {
      h.started(); h.tool(); h.permission();
      const expected = h.requests[0]!;
      if (cause === "failed" || cause === "succeeded") {
        await h.adapter.replyPermission(h.handle, expected, "once", { beforeNativeDispatch: async () => {} });
        assert.equal(h.requests.length, 0);
        h.child.emit({ type: "user", session_id: h.handle.providerContinuationId,
          message: { content: [{ type: "tool_result", tool_use_id: "tool-write", is_error: cause === "failed", content: "result" }] } });
      } else if (cause === "cancel") h.child.emit({ type: "control_cancel_request", request_id: expected.id });
      else h.child.emit({ type: "result", subtype: "interrupted", is_error: true,
        session_id: h.handle.providerContinuationId, user_message_uuid: h.turnId });
      assert.deepEqual(h.closures, [{ type: "request_closed", request: expected,
        providerContinuationId: h.handle.providerContinuationId, providerTurnId: h.turnId }]);
      h.child.emit({ type: "control_cancel_request", request_id: expected.id });
      assert.equal(h.closures.length, 1);
    } finally { await h.close(); }
  });
}

test("Claude cannot close a prompt from foreign tool, turn, session or process evidence", async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission();
    const result = { type: "user", session_id: h.handle.providerContinuationId,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-write", content: "done" }] } };
    h.child.emit({ ...result, session_id: "foreign" });
    h.child.emit({ ...result, user_message_uuid: "foreign" });
    h.child.emit({ ...result, message: { content: [{ type: "tool_result", tool_use_id: "other", content: "done" }] } });
    assert.equal(h.closures.length, 0);
    h.harness.identities.set(h.handle.pid!, "different-birth");
    h.child.emit({ type: "control_cancel_request", request_id: "native-request" });
    assert.equal(h.closures.length, 0);
  } finally { await h.close(); }
});

test("Claude disconnect clears native pendingness without inventing request closure", async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission(); h.child.disconnect();
    assert.equal(h.closures.length, 0);
  } finally { await h.close(); }
});

for (const cause of ["cancel", "result"] as const) test(`Claude retires an evicted pending permission on exact ${cause}`, async () => {
  const h = await approvalHarness();
  try {
    h.started(); h.tool(); h.permission(); const original = h.requests[0]!;
    for (let index = 0; index < 65; index++) {
      const toolId = `later-tool-${index}`;
      h.child.emit({ type: "assistant", session_id: h.handle.providerContinuationId,
        message: { content: [{ type: "tool_use", id: toolId, name: "Write", input: {} }] } });
      h.child.emit({ type: "control_request", request_id: `later-request-${index}`,
        request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: toolId, input: {} } });
    }
    if (cause === "cancel") h.child.emit({ type: "control_cancel_request", request_id: original.id });
    else h.child.emit({ type: "user", session_id: h.handle.providerContinuationId,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-write", is_error: true, content: "failed" }] } });
    assert.ok(h.requests.every(request => request.id !== original.id));
    assert.equal(h.closures.length, 1);
    await assert.rejects(h.adapter.replyPermission(h.handle, original, "once", { beforeNativeDispatch: async () => {} }), { outcome: "not_dispatched" });
  } finally { await h.close(); }
});


test("compaction uses cumulative separate budgets; repeated starts and cleared statuses never refill them", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  let wakes = 0;
  const tracker = new ClaudeCompaction("session", 30_000, 300_000,
    () => new Date(clock).toISOString(), () => { wakes++; }, () => clock);
  const tick = (ms: number) => { clock += ms; t.mock.timers.tick(ms); };
  const status = (value: unknown, extra = {}) => tracker.observe({ type: "system", subtype: "status", session_id: "session", status: value, ...extra });
  tick(10_000);
  status("compacting");
  const first = tracker.progress();
  tick(100_000);
  status("compacting");
  assert.deepEqual(tracker.progress(), first);
  assert.equal(wakes, 1);
  status(null); // Ends busy status, but is never a bootstrap result.
  tick(10_000);
  status("compacting");
  tick(199_999);
  assert.equal(tracker.failure, null);
  tick(1);
  assert.equal(await tracker.deadline, "compaction_deadline");
  assert.equal(tracker.progress(), null);
  tracker.close();
});

for (const completion of ["boundary", "success", "cleared", "requesting"] as const) {
  test(`compaction ${completion} resumes only the unused normal startup budget`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let clock = 0;
    const tracker = new ClaudeCompaction("session", 30_000, 300_000, () => "2026-09-24T00:00:00Z", undefined, () => clock);
    const tick = (ms: number) => { clock += ms; t.mock.timers.tick(ms); };
    tick(20_000);
    tracker.observe({ type: "system", subtype: "status", session_id: "session", status: "compacting" });
    tick(60_000);
    tracker.observe({ type: "system", session_id: "session", subtype: completion === "boundary" ? "compact_boundary" : "status",
      status: completion === "requesting" ? "requesting" : null, ...(completion === "success" ? { compact_result: "success" } : {}) });
    assert.equal(tracker.progress(), null);
    tick(9_999);
    assert.equal(tracker.failure, null);
    tick(1);
    assert.equal(await tracker.deadline, "deadline");
    tracker.close();
  });
}

test("foreign, missing-session and subagent compaction cannot extend startup; explicit failure wins", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  const tracker = new ClaudeCompaction("session", 30_000, 300_000, () => "now", undefined, () => clock);
  for (const extra of [{ session_id: "other" }, {}, { session_id: "session", parent_tool_use_id: "subagent" }]) {
    tracker.observe({ type: "system", subtype: "status", status: "compacting", ...extra });
    assert.equal(tracker.progress(), null);
  }
  tracker.observe({ type: "system", subtype: "status", session_id: "session", status: "compacting", compact_result: "failed", compact_error: "PRIVATE" });
  assert.equal(await tracker.deadline, "compaction_failed");
  assert.equal(tracker.progress(), null);
  tracker.close();
  tracker.observe({ type: "system", subtype: "status", session_id: "session", status: "compacting" });
  assert.equal(tracker.progress(), null);
});

test("router exposes exact child compaction before admission, then ordinary bootstrap proof is still required", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const pump = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
  const harness = createHarness({ omitBootstrapResult: true,
    bootstrapMessages: session_id => [{ type: "system", subtype: "status", status: "compacting", session_id }] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const router = new ProviderActionPortRouter({ "claude-code": async () => adapter });
  let wakes = 0;
  const req = { ...spawnRequest({ onProgress: () => wakes++ }), provider: "claude-code" };
  let admitted = false;
  const launched = router.spawn(req).then((handle: { observedState: string }) => { admitted = true; return handle; });
  await pump();
  assert.equal(router.compactionProgress(req.workAttemptId, "claude-code")?.state, "compacting");
  assert.equal(router.compactionProgress(req.workAttemptId, "codex"), null);
  assert.equal(router.compactionProgress("another-attempt", "claude-code"), null);
  clock = 60_000; t.mock.timers.tick(60_000); await pump();
  assert.equal(admitted, false);
  assert.deepEqual(harness.signals, []);
  const child = harness.children[0]!;
  const session = argValue(harness.launches[0]!.args, "--session-id")!;
  child.emit({ type: "system", subtype: "compact_boundary", session_id: session });
  await pump();
  assert.equal(admitted, false, "compaction completion is not readiness");
  assert.equal(router.compactionProgress(req.workAttemptId, "claude-code"), null);
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: session,
    user_message_uuid: JSON.parse(child.written[0]!).uuid, result: "LETAGENTS_CLAUDE_DAEMON_READY" });
  const handle = await launched;
  assert.equal(handle.observedState, "idle");
  child.emit({ type: "system", subtype: "status", session_id: session, status: "compacting" });
  assert.equal(router.compactionProgress(req.workAttemptId, "claude-code")?.state, "compacting",
    "the same owner supplies progress for later native turns");
  child.emit({ type: "system", subtype: "status", session_id: "other", status: null });
  assert.ok(router.compactionProgress(req.workAttemptId, "claude-code"));
  harness.identities.set(child.pid!, null);
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await pump();
  assert.equal(router.compactionProgress(req.workAttemptId, "claude-code"), null);
  assert.ok(wakes >= 4);
});

for (const elapsed of [299_999, 300_001]) test(`bootstrap admission accounts ${elapsed}ms compaction even before its timer runs`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const harness = createHarness({ omitBootstrapResult: true,
    bootstrapMessages: session_id => [{ type: "system", subtype: "status", status: "compacting", session_id }] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const launched = adapter.spawn(spawnRequest());
  for (let n = 0; n < 40; n++) await Promise.resolve();
  const child = harness.children[0]!;
  clock = elapsed; // Intentionally leave the overdue timer undelivered.
  child.emit({ type: "result", subtype: "success", is_error: false,
    session_id: argValue(harness.launches[0]!.args, "--session-id"),
    user_message_uuid: JSON.parse(child.written[0]!).uuid, result: "LETAGENTS_CLAUDE_DAEMON_READY" });
  if (elapsed < 300_000) {
    assert.equal((await launched).observedState(), "idle");
    harness.identities.set(child.pid!, null);
    child.resolveExit({ type: "exit", code: 0, signal: null });
  } else {
    await assert.rejects(launched, { reason: "compaction_deadline" });
    assert.deepEqual(harness.signals, [{ pid: child.pid, signal: "SIGTERM" }]);
  }
  for (let n = 0; n < 40; n++) await Promise.resolve();
  assert.equal(adapter.compactionProgress("wa-claude-1"), null);
});

for (const sameBatchExit of [false, true]) test(`buffered explicit compaction failure blocks a success result (same-batch exit=${sameBatchExit})`, async () => {
  const harness = createHarness({
    ...(sameBatchExit ? { exitAfterBootstrapResult: { type: "exit" as const, code: 0, signal: null } } : {}),
    bootstrapMessages: session_id => [{ type: "system", subtype: "status", status: null, compact_result: "failed", session_id }],
  });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest()), { reason: "compaction_failed" });
  assert.equal(adapter.compactionProgress("wa-claude-1"), null);
});

const ROOM_SERVER = { name: "letagents", status: "connected", source: "dynamic" };
const OWNER_SERVER = { name: "owner_browser", status: "connected", source: "user" };
const CLAUDE_TOOLS = ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];
/** How Claude is told to start MCP servers when it also starts the owner's: its own time limit, and all of them at once. */
const OWNER_START_ENV = { MCP_TIMEOUT: "30000", MCP_SERVER_CONNECTION_BATCH_SIZE: "256", MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE: "256" };
const OWNER_START_SETTINGS = JSON.stringify({ env: OWNER_START_ENV });
/** The owner's own setup is only ever on for a daemon-supervised room agent. */
const SUPERVISED = { supervisorEntryId: "supervised_owner", supervisorSocketPath: "/tmp/fake-daemon.sock", supervisorExecutionGenerationId: "generation-1" };
const OWN_SETUP = { ...SUPERVISED, homeHarness: true };
function ownSetupAskPolicy(homeHarness: boolean, permissionMode = "default") {
  return {
    permissionMode, dangerouslySkipPermissions: false, allowDangerouslySkipPermissions: false,
    tools: homeHarness ? [...CLAUDE_TOOLS, "Skill"] : CLAUDE_TOOLS,
    allowedTools: ["mcp__letagents__*"], settingSources: homeHarness ? "user" : "", settings: "{}",
  };
}

test("Claude starts exactly as before without the owner's own setup, and reads the owner's servers and settings with it", async () => {
  const launch = async (homeHarness: boolean, permissionProfileId: string, launchPolicy: Record<string, unknown>) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER],
      initPermissionMode: String(launchPolicy.permissionMode), commitEnvironment: { GIT_AUTHOR_NAME: "octo-fake" } });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    await adapter.spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId, launchPolicy,
      ...SUPERVISED,
      supervisorWorkerSession: { agentSessionId: "session-1", roomCursor: null, apiUrl: "https://letagents.invalid" },
      ...(homeHarness ? { homeHarness: true } : {}),
    }));
    return { ...harness.launches[0]!, launch: harness.launches[0]!, mcpConfig: harness.mcpConfigRequests[0]! };
  };
  // What makes a process on this machine the room agent: the daemon answers whoever holds these.
  const coordinates = {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_owner",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/fake-daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: "wa-claude-1",
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "generation-1",
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "session-1",
    LETAGENTS_SUPERVISOR_ROOM_ID: "github.com/example/repo",
    LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "LanternRook",
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    LETAGENTS_PERMISSION_PROFILE_ID: "ask_before_write",
  };

  const off = await launch(false, "ask_before_write", ownSetupAskPolicy(false));
  const session = argValue(off.args, "--session-id")!;
  assert.deepEqual(off.args, [
    "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio",
    "--strict-mcp-config",
    "--mcp-config", "/private/tmp/letagents-claude-mcp-test/mcp.json",
    "--permission-mode", "default",
    "--tools", "Read,Glob,Grep,Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch",
    "--allowed-tools", "mcp__letagents__*",
    "--setting-sources", "",
    "--settings", "{}",
    "--session-id", session,
  ], "without the owner's setup the launch is exactly the isolated one");

  const on = await launch(true, "ask_before_write", ownSetupAskPolicy(true));
  assert.deepEqual(on.args, [
    "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio",
    "--mcp-config", "/private/tmp/letagents-claude-mcp-test/mcp.json",
    "--permission-mode", "default",
    "--tools", "Read,Glob,Grep,Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Skill",
    "--allowed-tools", "mcp__letagents__*",
    "--setting-sources", "user",
    // Given on the command line so that the owner's own settings cannot replace them.
    "--settings", OWNER_START_SETTINGS,
    "--session-id", argValue(on.args, "--session-id")!,
  ], "the room's server is still named, approvals still travel over stdio, and no project settings are read");
  assert.equal(on.cwd, off.cwd);

  // Without the owner's setup the coordinates are in the CLI's environment, where only the room's server inherits them.
  assert.deepEqual(off.env, { GIT_AUTHOR_NAME: "octo-fake", ...coordinates });
  assert.deepEqual(off.launch, { claudeBin: off.claudeBin, args: off.args, cwd: off.cwd, env: off.env }, "and the launch is marked in no other way");
  assert.equal(off.mcpConfig.length, 1, "the room server's config is asked for exactly as before");
  // With it, Claude hands its environment to the owner's servers and hooks too, so the coordinates go to the room's server alone.
  assert.deepEqual(on.env, { GIT_AUTHOR_NAME: "octo-fake", ...OWNER_START_ENV },
    "beside the commit identity, only how Claude is to start the owner's servers");
  for (const name of Object.keys(OWNER_START_ENV)) assert.equal(Object.hasOwn(off.env ?? {}, name), false, name);
  assert.equal(on.launch.ownerSetup, true);
  assert.deepEqual(on.mcpConfig[1], coordinates);

  // Full access names no setting sources: it reads the owner's, the project's and the folder's own.
  const fullAccess = { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true };
  const fullOff = await launch(false, "full_access", fullAccess);
  const fullOn = await launch(true, "full_access", fullAccess);
  assert.deepEqual(fullOff.args, [
    "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--strict-mcp-config",
    "--mcp-config", "/private/tmp/letagents-claude-mcp-test/mcp.json",
    "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
    "--session-id", argValue(fullOff.args, "--session-id")!,
  ], "without the owner's setup a Full access launch is exactly what it was");
  assert.deepEqual(fullOff.env, { GIT_AUTHOR_NAME: "octo-fake", ...coordinates, LETAGENTS_PERMISSION_PROFILE_ID: "full_access" });
  // With the owner's setup it reads the owner's settings alone, so nothing of the project's runs beside the owner's tools,
  // and it is given its own work folder as an added directory so that the project's CLAUDE.md still loads.
  const withInstructions = { ...OWNER_START_ENV, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" };
  assert.deepEqual(fullOn.args, [
    "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--mcp-config", "/private/tmp/letagents-claude-mcp-test/mcp.json",
    "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
    "--settings", JSON.stringify({ env: withInstructions }),
    "--setting-sources", "user",
    "--add-dir", fullOn.cwd,
    "--session-id", argValue(fullOn.args, "--session-id")!,
  ]);
  assert.equal(fullOn.cwd, spawnRequest().cwd, "the added directory is the agent's own work folder and nothing else");
  assert.deepEqual(fullOn.env, { GIT_AUTHOR_NAME: "octo-fake", ...withInstructions });
  // The other access levels never read a project's instructions, so they are given no added directory.
  assert.equal(on.args.includes("--add-dir"), false);
  assert.equal(Object.hasOwn(on.env ?? {}, "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"), false);
});

test("with the owner's own setup the Claude CLI's environment carries nothing that lets a process act as the room agent", () => {
  const ambient = {
    PATH: "/usr/bin", HOME: "/Users/fake", LETAGENTS_API_URL: "https://letagents.invalid",
    // A desktop app started from inside an agent's shell has these in its own environment.
    LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_other", LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/other.sock",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn", LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_PERMISSION_PROFILE_ID: "full_access", LETAGENTS_TOKEN: "fake-owner-token", LETAGENTS_AGENT_SESSION_BEARER: "fake-bearer",
  };
  assert.deepEqual(claudeChildEnvironment({ env: { GIT_AUTHOR_NAME: "octo-fake" }, ownerSetup: true }, ambient), {
    PATH: "/usr/bin", HOME: "/Users/fake", LETAGENTS_API_URL: "https://letagents.invalid", GIT_AUTHOR_NAME: "octo-fake",
  });
  // Without the owner's setup the environment is the one every launch had before.
  assert.deepEqual(claudeChildEnvironment({ env: { GIT_AUTHOR_NAME: "octo-fake" } }, ambient), claudeCliEnv(ambient, { GIT_AUTHOR_NAME: "octo-fake" }));
  assert.equal(claudeChildEnvironment({}, ambient).LETAGENTS_SUPERVISOR_ENTRY_ID, "supervised_other");
});

test("the room server's config carries the coordinates only when the launch hands them over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letagents-claude-room-config-"));
  try {
    const runtime = () => ({ entryPath: "/fake/letagents-mcp.js" }) as never;
    const read = async (roomServerEnvironment?: Record<string, string>) => {
      const config = await createManagedClaudeMcpConfig("https://letagents.invalid", directory, undefined, runtime, roomServerEnvironment);
      try {
        return { text: await readFile(config.path, "utf8"), mode: (await stat(config.path)).mode & 0o777 };
      } finally {
        await config.dispose();
      }
    };
    const isolated = await read();
    assert.equal(isolated.text, JSON.stringify({ mcpServers: { letagents: {
      command: process.execPath, args: ["/fake/letagents-mcp.js"], env: { LETAGENTS_API_URL: "https://letagents.invalid", ELECTRON_RUN_AS_NODE: "1" },
    } } }), "without the owner's setup the file is byte for byte the one written before");
    const ownSetup = await read({ LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_owner", LETAGENTS_API_URL: "https://elsewhere.invalid" });
    assert.deepEqual(JSON.parse(ownSetup.text).mcpServers.letagents.env, {
      LETAGENTS_SUPERVISOR_ENTRY_ID: "supervised_owner", LETAGENTS_API_URL: "https://letagents.invalid", ELECTRON_RUN_AS_NODE: "1",
    }, "the endpoint is always the launch's own");
    assert.equal(ownSetup.mode, 0o600, "only the owner can read it");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude is refused the owner's own setup outside a daemon-supervised room agent", async () => {
  const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [ROOM_SERVER] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), homeHarness: true,
  })), /only as a daemon-supervised room agent/);
  assert.equal(harness.launches.length, 0);
  assert.equal(harness.mcpConfigRequests.length, 0);
});

test("the owner's MCP servers get Claude's own time to start, a smaller limit of the owner's is kept, and a larger one is capped", () => {
  for (const [configured, expected] of [
    [undefined, 30_000], ["", 30_000], ["5000", 5_000], [" 7000 ", 7_000], ["30000", 30_000], ["45000", 45_000],
    ["45001", 45_000], ["600000", 45_000], ["999999999", 45_000],
    // Anything that is not a plain positive number of milliseconds is not the owner's limit.
    ["0", 30_000], ["-1", 30_000], ["1e3", 30_000], ["3000ms", 30_000], ["0x10", 30_000], ["3000.5", 30_000], ["1234567890", 30_000],
  ] as const) assert.equal(ownerMcpStartupTimeoutMs(configured), expected, String(configured));
});

test("each of the owner's MCP servers that did not connect is named, and the room's own never is", () => {
  assert.deepEqual(ownerMcpServerNotices({ mcp_servers: [
    { name: "owner_ok", status: "connected", source: "user" },
    { name: "owner_silent", status: "failed", source: "user" },
    { name: "owner_slow", status: "pending", source: "user" },
    { name: "owner_login", status: "needs-auth", source: "user" },
    { name: "owner_other", status: "disabled", source: "user" },
    { name: "letagents", status: "failed", source: "dynamic" },
    { name: "  ", status: "failed" }, { status: "failed" }, null, "owner_text",
  ] }), [
    'Your MCP server "owner_silent" did not start, so this agent is running without it.',
    'Your MCP server "owner_slow" was still starting when this agent began, so its tools may be missing.',
    'Your MCP server "owner_login" needs you to sign in, so this agent is running without it.',
    'Your MCP server "owner_other" did not start, so this agent is running without it.',
  ]);
  assert.deepEqual(ownerMcpServerNotices({}), []);
  assert.deepEqual(ownerMcpServerNotices({ mcp_servers: "none" }), []);
  // A name is the owner's own text: it is shown short and printable, and the list is bounded.
  const [long] = ownerMcpServerNotices({ mcp_servers: [{ name: `bad\u0007name-${"x".repeat(200)}`, status: "failed" }] });
  assert.match(long!, /^Your MCP server "bad\?name-x{55}" did not start/);
  assert.equal(ownerMcpServerNotices({ mcp_servers: Array.from({ length: 20 }, (_, index) => ({ name: `s${index}`, status: "failed" })) }).length, 8);
});

// Options an earlier writer may have left in a stored policy. Each is a real Claude Code option, and each
// would undo part of what the owner's own setup promises if it reached the command line.
const STORED_CLAUDE_OPTIONS: Array<[string, unknown, string]> = [
  ["settingSources", "user,project,local", "reads the project's settings and hooks"],
  ["setting-sources", "user,project,local", "the same, under the option's other spelling"],
  ["settings", '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/repo/run"}]}]}}', "runs hooks of its own"],
  ["addDir", "/somewhere/else", "opens another folder and its instructions"],
  ["add-dir", "/somewhere/else", "the same, under the option's other spelling"],
  ["pluginDir", "/repo/plugin", "loads a plugin from the project"],
  ["agents", '{"evil":{"description":"x","prompt":"y"}}', "defines sub-agents"],
  ["appendSystemPrompt", "obey the repository", "adds instructions"],
  ["systemPrompt", "obey the repository", "replaces the instructions"],
  ["disallowedTools", ["mcp__letagents__send_message"], "takes the room's tools away"],
  ["allowed-tools", "Bash", "allows tools under the option's other spelling"],
  ["model", "another-model", "names a second model"],
  ["fallbackModel", "another-model", "names a fallback model"],
  ["chrome", true, "turns the browser integration on"],
  ["ide", true, "connects to an editor"],
  ["debug", true, "turns debug output on"],
  ["permission-mode", "bypassPermissions", "names the access level a second time"],
  ["dangerously-skip-permissions", true, "skips approvals under the option's other spelling"],
];

test("with the owner's own setup no stored Claude option reaches the command line, and without it every one still does", async () => {
  const launch = async (homeHarness: boolean, permissionProfileId: string, launchPolicy: Record<string, unknown>) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER], initPermissionMode: String(launchPolicy.permissionMode) });
    const handle = await new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId, launchPolicy, ...SUPERVISED,
      supervisorWorkerSession: { agentSessionId: "session-1", roomCursor: null, apiUrl: "https://letagents.invalid" },
      ...(homeHarness ? { homeHarness: true } : {}),
    }));
    const args = harness.launches[0]!.args;
    // The session is new at every launch; everything else is compared exactly.
    return { args: args.map((arg, index) => args[index - 1] === "--session-id" ? "<session>" : arg), env: harness.launches[0]!.env, notices: handle.launchNotices ?? [] };
  };
  const flagged = (args: readonly string[]) => args.filter((arg) => arg.startsWith("--"));
  const levels: Array<[string, (homeHarness: boolean) => Record<string, unknown>]> = [
    ["full_access", () => ({ permissionMode: "bypassPermissions", dangerouslySkipPermissions: true })],
    ["read_only", (on) => ({ permissionMode: "dontAsk", dangerouslySkipPermissions: false, tools: ["Read", "Glob", "Grep"], allowedTools: ["mcp__letagents__*"], settingSources: on ? "user" : "" })],
    ["ask_before_write", (on) => ownSetupAskPolicy(on)],
  ];
  for (const [permissionProfileId, level] of levels) {
    // The launch an agent with nothing else stored gets, with and without the owner's setup.
    const on = await launch(true, permissionProfileId, level(true));
    const off = await launch(false, permissionProfileId, level(false));
    assert.deepEqual(on.notices, [], permissionProfileId);
    // With the owner's setup every flag is there once, and these three are what the launch says they are.
    assert.equal(new Set(flagged(on.args)).size, flagged(on.args).length, `${permissionProfileId}: no flag is given twice`);
    assert.equal(argValue(on.args, "--setting-sources"), "user", permissionProfileId);
    assert.equal(on.args.includes("--strict-mcp-config"), false, permissionProfileId);
    assert.equal(argValue(on.args, "--mcp-config"), "/private/tmp/letagents-claude-mcp-test/mcp.json", permissionProfileId);
    assert.deepEqual(JSON.parse(argValue(on.args, "--settings")!), { env: on.env }, `${permissionProfileId}: the launch's own start settings`);
    assert.equal(argValue(on.args, "--add-dir") ?? null, permissionProfileId === "full_access" ? spawnRequest().cwd : null, permissionProfileId);

    for (const [option, value, what] of STORED_CLAUDE_OPTIONS) {
      // The asking levels refuse the other spelling of their own options at any launch, as they always did.
      if (permissionProfileId === "ask_before_write" && ["settings", "setting-sources", "allowed-tools", "permission-mode", "dangerously-skip-permissions"].includes(option)) continue;
      const name = `${permissionProfileId}: ${option} (${what})`;
      // An option the level decides itself stays the level's.
      const stored = (homeHarness: boolean) => ({ [option]: value, ...level(homeHarness) });
      const withOption = await launch(true, permissionProfileId, stored(true));
      assert.deepEqual(withOption.args, on.args, `${name}: the launch is the one with nothing else stored`);
      assert.deepEqual(withOption.env, on.env, name);
      assert.deepEqual(withOption.notices, Object.hasOwn(level(true), option) ? [] : [
        `With your own setup on, this agent starts with its access level's own Claude Code options only. These saved options were not used: ${JSON.stringify(option)}.`,
      ], `${name}: and the owner is told what was left out`);
      // Without the owner's setup the option is passed on exactly as it always was.
      const passedOn = await launch(false, permissionProfileId, stored(false));
      assert.deepEqual(passedOn.args, [
        ...off.args.slice(0, off.args.indexOf("--mcp-config") + 2),
        ...claudeLaunchPolicyArgs(stored(false)),
        ...off.args.slice(off.args.indexOf("--session-id")),
      ], `${name}: unchanged without the owner's setup`);
      assert.deepEqual(passedOn.notices, [], name);
    }
  }
});

test("a Claude agent is told which saved options were left out when they change, not at every start, and a failed start does not use the line up", async () => {
  const level = { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true };
  const told = async (agent: string, stored: Record<string, unknown>, over: { fails?: boolean; servers?: unknown[] } = {}) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: (over.servers ?? [OWNER_SERVER, ROOM_SERVER]) as never, initPermissionMode: "bypassPermissions",
      ...(over.fails ? { bootstrapResultSubtype: "error_max_turns" } : {}) });
    return new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId: "full_access", launchPolicy: { ...level, ...stored }, ...OWN_SETUP, supervisorEntryId: agent,
      supervisorWorkerSession: { agentSessionId: "session-1", roomCursor: null, apiUrl: "https://letagents.invalid" },
    })).then((handle) => handle.launchNotices ?? [], (error: Error) => error);
  };
  const line = (...options: string[]) => `With your own setup on, this agent starts with its access level's own Claude Code options only. These saved options were not used: ${options.map((option) => JSON.stringify(option)).join(", ")}.`;
  const stored = { settingSources: "user,project,local" };
  assert.deepEqual(await told("supervised_said_once", stored), [line("settingSources")], "its first start says it");
  assert.deepEqual(await told("supervised_said_once", stored), [], "the same again says nothing");
  assert.deepEqual(await told("supervised_said_once", { settingSources: "project" }), [], "another value under the same name is not a change");
  assert.deepEqual(await told("supervised_said_once", { ...stored, pluginDir: "/repo" }), [line("settingSources", "pluginDir")], "a change is said");
  // What one of the owner's servers did is still said at every start.
  const silent = [OWNER_SERVER, { name: "owner_silent", status: "failed", source: "user" }, ROOM_SERVER];
  const serverLine = 'Your MCP server "owner_silent" did not start, so this agent is running without it.';
  assert.deepEqual(await told("supervised_said_once", { ...stored, pluginDir: "/repo" }, { servers: silent }), [serverLine]);
  assert.deepEqual(await told("supervised_said_once", { ...stored, pluginDir: "/repo" }, { servers: silent }), [serverLine]);
  // A start that failed after it was given the line never showed it, so the next one says it.
  assert.ok(await told("supervised_said_once_failed", stored, { fails: true }) instanceof Error);
  assert.deepEqual(await told("supervised_said_once_failed", stored), [line("settingSources")]);
  // One that failed without being given it, the line having been said before, changes nothing.
  assert.ok(await told("supervised_said_once_failed", stored, { fails: true, servers: silent }) instanceof Error);
  assert.deepEqual(await told("supervised_said_once_failed", stored), []);
  // What one agent was told says nothing about another.
  assert.deepEqual(await told("supervised_said_once_other", stored), [line("settingSources")]);
});

test("a flag the launch with the owner's own setup decides is set once, wherever it stood before", () => {
  const base = { approvalProfileLabel: null, homeHarness: true, ownerMcpStartupMs: 30_000, cwd: "/work/attempt", mcpConfigPath: "/room/mcp.json", session: { sessionId: "s-1" } };
  const clean = claudeCliLaunchArgs({ ...base, policyArgs: ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"] });
  const settings = argValue(clean, "--settings")!;
  // Arguments that already name the launch's own flags, first, last and twice: the answer is the same.
  for (const policyArgs of [
    ["--setting-sources", "user,project,local", "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"],
    ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--setting-sources", "user,project,local"],
    ["--setting-sources", "project", "--permission-mode", "bypassPermissions", "--setting-sources", "local", "--dangerously-skip-permissions", "--setting-sources", "user,project,local"],
    ["--settings", '{"hooks":{}}', "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--settings", '{"env":{"MCP_TIMEOUT":"1"}}'],
    ["--add-dir", "/somewhere/else", "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--add-dir", "/another"],
  ]) {
    const args = claudeCliLaunchArgs({ ...base, policyArgs });
    for (const flag of ["--setting-sources", "--settings", "--add-dir", "--mcp-config"]) {
      assert.equal(args.filter((arg) => arg === flag).length <= 1, true, `${flag} in ${policyArgs.join(" ")}`);
    }
    assert.equal(argValue(args, "--setting-sources"), "user", policyArgs.join(" "));
    assert.equal(args.join(" ").includes("project"), false, policyArgs.join(" "));
    assert.equal(args.includes("/somewhere/else") || args.includes("/another"), false);
    assert.equal(argValue(args, "--settings")?.includes("hooks"), false);
    assert.equal(JSON.parse(argValue(args, "--settings")!).env.MCP_TIMEOUT, "30000");
    // Arguments that named the settings to read are not Full access as stored, so no folder is added for them.
    assert.equal(argValue(args, "--add-dir") ?? null, policyArgs.includes("--setting-sources") ? null : "/work/attempt");
  }
  assert.equal(argValue(clean, "--settings"), settings);
  // Without the owner's setup the arguments are passed on untouched, twice-named flags included.
  const off = claudeCliLaunchArgs({ ...base, homeHarness: false, policyArgs: ["--setting-sources", "user", "--setting-sources", "project", "--add-dir", "/x"] });
  assert.deepEqual(off.slice(off.indexOf("--mcp-config") + 2, -2), ["--setting-sources", "user", "--setting-sources", "project", "--add-dir", "/x"]);
});

test("an owner MCP server that did not start is reported on the handle, only for a launch with the owner's setup", async () => {
  const servers = [OWNER_SERVER, { name: "owner_silent", status: "failed", source: "user" }, { name: "owner_slow", status: "pending", source: "user" }, ROOM_SERVER];
  const launch = async (over: Partial<ProviderSpawnRequest>) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: servers });
    return new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies }).spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId: "ask_before_write", ...over,
    }));
  };
  const on = await launch({ launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP });
  assert.deepEqual(on.launchNotices, [
    'Your MCP server "owner_silent" did not start, so this agent is running without it.',
    'Your MCP server "owner_slow" was still starting when this agent began, so its tools may be missing.',
  ]);
  // The agent started all the same.
  assert.equal(on.observedState(), "idle");
  // Its handle says the process has the owner's setup: that is what later ends it when the owner turns it off.
  assert.equal(on.ownerSetup, true);
  const off = await launch({ launchPolicy: ownSetupAskPolicy(false), ...SUPERVISED });
  assert.deepEqual(off.launchNotices ?? [], []);
  assert.equal(off.ownerSetup, false);
});

test("the start waits for the owner's MCP servers on top of its usual budget, and only with the owner's setup", async () => {
  const start = (over: Partial<ProviderSpawnRequest>, ownerMcpTimeout?: string) => {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", noInit: true });
    const adapter = new ClaudeCodeProviderAdapter({
      dependencies: { ...harness.dependencies, ownerMcpTimeout: () => ownerMcpTimeout }, initTimeoutMs: 40,
    });
    let settled: "pending" | Error = "pending";
    const spawned = adapter.spawn(spawnRequest({ configurationRevision: 4, permissionProfileId: "ask_before_write", ...over }));
    spawned.catch((error: Error) => { settled = error; });
    return { harness, spawned, state: () => settled };
  };
  // Without the owner's setup the budget is the one it always was.
  const offStarted = Date.now();
  const off = start({ launchPolicy: ownSetupAskPolicy(false), ...SUPERVISED }, "400");
  await assert.rejects(withLoopAlive(off.spawned), (error: Error) => {
    assert.ok(Date.now() - offStarted < 300, "it gives up after its usual 40 ms, not after the owner's limit as well");
    assert.match(error.message, /did not report its stream-json init/);
    assert.doesNotMatch(error.message, /your MCP servers/);
    return true;
  });
  assert.equal(Object.hasOwn(off.harness.launches[0]!.env ?? {}, "MCP_TIMEOUT"), false);

  // With it, Claude is told the limit and the launch waits that much longer for init.
  const on = start({ launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP }, "400");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(on.state(), "pending", "the usual 40 ms have long passed and the launch is still waiting");
  assert.equal(on.harness.launches[0]!.env?.MCP_TIMEOUT, "400");
  await assert.rejects(withLoopAlive(on.spawned), (error: Error) => {
    assert.match(error.message, /did not report its stream-json init/);
    assert.match(error.message, /This agent starts with your own Claude Code setup, so one of your MCP servers or hooks may be holding the start up\./);
    return true;
  });
  assert.equal(on.harness.children[0]!.alive, false, "a launch that still never reports is stopped, as before");
});

test("a start that ran out of time after Claude came up names the owner's servers that did not start", async () => {
  const servers = [OWNER_SERVER, { name: "owner_silent", status: "failed", source: "user" }, ROOM_SERVER];
  const start = (over: Partial<ProviderSpawnRequest>) => {
    // Claude reports init, and then the first turn never finishes.
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: servers, omitBootstrapResult: true });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: { ...harness.dependencies, ownerMcpTimeout: () => "60" }, initTimeoutMs: 40 });
    return adapter.spawn(spawnRequest({ configurationRevision: 4, permissionProfileId: "ask_before_write", ...over }));
  };
  await assert.rejects(withLoopAlive(start({ launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP })), (error: Error) => {
    assert.match(error.message, /did not complete its daemon-safe bootstrap turn \(deadline\)/);
    assert.match(error.message, /Your MCP server "owner_silent" did not start, so this agent is running without it\.$/);
    return true;
  });
  await assert.rejects(withLoopAlive(start({ launchPolicy: ownSetupAskPolicy(false), ...SUPERVISED })), (error: Error) => {
    assert.match(error.message, /did not complete its daemon-safe bootstrap turn \(deadline\)/);
    assert.doesNotMatch(error.message, /Your MCP server/, "an isolated agent's failure says nothing about the owner's servers");
    return true;
  });
});

test("the Claude launch arguments differ only in what the owner's setup needs", () => {
  // An access level that names its setting sources, as Read-only, Ask before writes and Auto do.
  const input = { approvalProfileLabel: "Ask before writes", mcpConfigPath: "/tmp/mcp.json", policyArgs: ["--permission-mode", "default", "--setting-sources", "user"], model: "opus" };
  const off = claudeCliLaunchArgs({ ...input, homeHarness: false, session: { sessionId: "s-1" } });
  const on = claudeCliLaunchArgs({ ...input, homeHarness: true, cwd: "/work/attempt", session: { sessionId: "s-1" } });
  assert.deepEqual(off, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio", "--strict-mcp-config", "--mcp-config", "/tmp/mcp.json",
    "--permission-mode", "default", "--setting-sources", "user", "--model", "opus", "--session-id", "s-1"]);
  assert.deepEqual(on, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--permission-prompt-tool", "stdio", "--mcp-config", "/tmp/mcp.json",
    "--permission-mode", "default", "--setting-sources", "user", "--settings", OWNER_START_SETTINGS, "--model", "opus", "--session-id", "s-1"],
  "the strict MCP flag is dropped and the start settings are added; no directory is added");
  assert.deepEqual(claudeCliLaunchArgs({ ...input, approvalProfileLabel: null, model: null, homeHarness: true, ownerMcpStartupMs: 4_000, session: { resume: "s-2" } }),
    ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--mcp-config", "/tmp/mcp.json", "--permission-mode", "default", "--setting-sources", "user",
      "--settings", JSON.stringify({ env: { ...OWNER_START_ENV, MCP_TIMEOUT: "4000" } }), "--resume", "s-2"]);
  // A policy that already carries settings has them replaced where they stand, never given twice.
  const replaced = claudeCliLaunchArgs({ ...input, policyArgs: ["--permission-mode", "default", "--setting-sources", "user", "--settings", "{}", "--tools", "Read"], homeHarness: true, session: { sessionId: "s-1" } });
  assert.deepEqual(replaced.filter((arg) => arg === "--settings").length, 1);
  assert.equal(replaced[replaced.indexOf("--settings") + 1], OWNER_START_SETTINGS);
  assert.deepEqual(claudeCliLaunchArgs({ ...input, policyArgs: ["--permission-mode", "default", "--settings", "{}", "--tools", "Read"], homeHarness: false, ownerMcpStartupMs: 4_000, cwd: "/work/attempt", session: { sessionId: "s-1" } })
    .filter((arg, index, all) => all[index - 1] === "--settings"), ["{}"], "without the owner's setup the policy's own settings are passed as they are");

  // An access level that names no setting sources reads the project's too: Full access.
  const full = { approvalProfileLabel: null, mcpConfigPath: "/tmp/mcp.json", policyArgs: ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"], model: null };
  assert.equal(claudeOwnerSetupReadsProjectInstructionsOnly(full.policyArgs), true);
  assert.equal(claudeOwnerSetupReadsProjectInstructionsOnly(input.policyArgs), false);
  assert.equal(claudeOwnerSetupReadsProjectInstructionsOnly(["--permission-mode", "dontAsk", "--setting-sources", ""]), false);
  const fullOff = claudeCliLaunchArgs({ ...full, homeHarness: false, cwd: "/work/attempt", session: { sessionId: "s-1" } });
  assert.deepEqual(fullOff, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
    "--strict-mcp-config", "--mcp-config", "/tmp/mcp.json",
    "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", "--session-id", "s-1"], "without the owner's setup nothing is added, whatever folder is named");
  const instructions = JSON.stringify({ env: { ...OWNER_START_ENV, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } });
  assert.deepEqual(claudeCliLaunchArgs({ ...full, homeHarness: true, cwd: "/work/attempt", session: { sessionId: "s-1" } }),
    ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--mcp-config", "/tmp/mcp.json",
      "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions",
      "--settings", instructions, "--setting-sources", "user", "--add-dir", "/work/attempt", "--session-id", "s-1"]);
  // With no folder to add, the launch still reads the owner's settings alone.
  for (const cwd of [undefined, "", "  "]) {
    const args = claudeCliLaunchArgs({ ...full, homeHarness: true, ...(cwd === undefined ? {} : { cwd }), session: { sessionId: "s-1" } });
    assert.equal(args.includes("--add-dir"), false, String(cwd));
    assert.equal(args[args.indexOf("--setting-sources") + 1], "user", String(cwd));
  }
  assert.deepEqual(claudeOwnerSetupStartEnvironment(30_000), OWNER_START_ENV);
  assert.deepEqual(claudeOwnerSetupStartEnvironment(30_000, true), { ...OWNER_START_ENV, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
});

test("with the owner's own setup, Claude must report the room's server as the one this launch named", async () => {
  for (const [servers, starts] of [
    [[OWNER_SERVER, ROOM_SERVER], true],
    [[{ name: "letagents", status: "connected", source: "user" }], false],
    [[{ name: "letagents", status: "connected", source: "project" }], false],
    [[{ name: "letagents", status: "connected" }], false],
    [[ROOM_SERVER, { name: "letagents", status: "connected", source: "user" }], false],
  ] as const) {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [...servers] });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const spawned = adapter.spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP,
    }));
    if (starts) {
      await spawned;
    } else {
      await assert.rejects(withLoopAlive(spawned), /did not report the room's LetAgents server as the one this launch started/);
      assert.equal(harness.mcpConfigDisposals, 1, "the refused launch leaves no room config behind");
    }
  }
  // Without the owner's setup only the room's server can load, so an older CLI that names no source still starts.
  const isolated = createHarness({ versionOutput: "2.1.278 (Claude Code)" });
  await new ClaudeCodeProviderAdapter({ dependencies: isolated.dependencies }).spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(false),
  }));
});

test("a rented Claude agent is refused the owner's own setup before anything starts", async () => {
  const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [ROOM_SERVER] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(adapter.spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP,
    supervisorEntryId: "supervised_rental_0123", supervisorSocketPath: "/tmp/fake-daemon.sock", supervisorExecutionGenerationId: "generation-1",
  })), /a rented agent never uses its owner's own setup/);
  assert.equal(harness.launches.length, 0);
});

test("a request nobody can answer is turned down at once instead of holding the turn", async () => {
  const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER] });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({
    configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP,
  }));
  const child = harness.children[0]!;
  const answers = () => child.written.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.type === "control_response");
  const observed: unknown[] = [];
  const controller = new AbortController();
  void adapter.observePermissions(handle, (event) => { observed.push(event); }, controller.signal);
  const activity: string[] = [];
  // The background service keeps an agent's activity from its stream, so that is where each one must be.
  adapter.onStream(handle, (event) => { if (event.method === "control_request/declined") activity.push(event.summary ?? ""); });

  // One of the owner's MCP servers asks the person to type something.
  child.emit({ type: "control_request", request_id: "elicit-1", request: {
    subtype: "elicitation", mcp_server_name: "owner_browser", message: "Which account?", mode: "form",
    requested_schema: { type: "object", properties: { account: { type: "string" } }, required: ["account"] },
  } });
  // A skill's helper agent wants a tool approved.
  child.emit({ type: "control_request", request_id: "sub-1", request: {
    subtype: "can_use_tool", tool_name: "mcp__owner_browser__owner_write", input: {}, tool_use_id: "toolu_sub_1", agent_id: "a37a052b",
  } });
  assert.deepEqual(answers(), [
    { type: "control_response", response: { subtype: "success", request_id: "elicit-1", response: { action: "decline" } } },
    { type: "control_response", response: { subtype: "success", request_id: "sub-1", response: {
      behavior: "deny", message: "LetAgents cannot show an approval for a sub-agent's action, so it was not allowed.",
    } } },
  ]);

  // The owner can see in the agent's activity what was turned down, and whose request it was.
  assert.deepEqual(activity, [
    'Declined a request for typed input from your MCP server "owner_browser". LetAgents cannot show it.',
    "Did not allow the tool \"mcp__owner_browser__owner_write\" for a skill's helper agent. LetAgents cannot show an approval for it.",
  ]);
  child.emit({ type: "control_request", request_id: "elicit-2", request: {
    subtype: "elicitation", mcp_server_name: "owner_browser", message: "Sign in", mode: "url", url: "https://example.invalid/sign-in",
  } });
  assert.equal(activity.at(-1), 'Declined a request for a sign-in from your MCP server "owner_browser". LetAgents cannot show it.');
  activity.length = 0;

  // The agent's own tool call is never answered here: it waits for the owner's decision.
  child.emit({ type: "control_request", request_id: "own-1", request: {
    subtype: "can_use_tool", tool_name: "mcp__owner_browser__owner_write", input: {}, tool_use_id: "toolu_1",
    mcp_server: { name: "owner_browser", source: "user" }, display_name: "Owner Write",
  } });
  // Neither is anything the room's own server might one day ask.
  child.emit({ type: "control_request", request_id: "room-1", request: {
    subtype: "elicitation", mcp_server_name: "letagents", message: "?", mode: "form", requested_schema: { type: "object", properties: {} },
  } });
  assert.equal(answers().length, 3);
  assert.deepEqual(activity, [], "nothing is reported as declined that was not");
  controller.abort();
  assert.equal(JSON.stringify(observed).includes("elicit-1") || JSON.stringify(observed).includes("sub-1"), false,
    "a declined request is never offered as an approval");
});

test("one of the owner's MCP tools asks for approval through the same flow as the agent's built-in tools", async () => {
  for (const reply of ["once", "reject"] as const) {
    const harness = createHarness({ versionOutput: "2.1.278 (Claude Code)", mcpServers: [OWNER_SERVER, ROOM_SERVER] });
    const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({
      configurationRevision: 4, permissionProfileId: "ask_before_write", launchPolicy: ownSetupAskPolicy(true), ...OWN_SETUP,
    }));
    const child = harness.children[0]!;
    const controller = new AbortController();
    let requests: import("../../shared/provider-permissions.js").ClaudeNativePermissionRequest[] = [];
    const observing = adapter.observePermissions(handle, event => { if (event.type === "snapshot") requests = [...event.requests]; }, controller.signal);
    const running = adapter.runRoomTurn(handle, { inboxItemId: "inbox", actionId: "action", sourceMessage: { text: "Click the button" }, activation: {} }, {});
    void running.catch(() => {});
    await flush();
    const turnId = JSON.parse(child.written.at(-1)!).uuid as string;
    child.emit({ type: "command_lifecycle", state: "started", command_uuid: turnId, session_id: handle.providerContinuationId });
    child.emit({ type: "assistant", session_id: handle.providerContinuationId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_owner", name: "mcp__owner_browser__owner_write", input: { selector: "#buy" } }] } });
    // The request exactly as Claude Code 2.1.278 sends it for a user-scope MCP tool.
    child.emit({ type: "control_request", request_id: "native-owner-tool", request: {
      subtype: "can_use_tool", tool_name: "mcp__owner_browser__owner_write", mcp_server: { name: "owner_browser", source: "user" },
      display_name: "Owner Write", input: { selector: "#buy" }, tool_use_id: "toolu_owner",
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "mcp__owner_browser__owner_write" }], behavior: "allow", destination: "localSettings" }],
    } });
    await flush();
    assert.equal(requests.length, 1, "the owner sees it as a pending approval");
    assert.equal(requests[0]!.request.tool_name, "mcp__owner_browser__owner_write");
    assert.equal(child.written.some((line) => line.includes("control_response")), false, "nothing is decided for the owner");
    assert.deepEqual(await adapter.correlatePermissionTurn(handle, requests[0]!),
      { outcome: "correlated", providerContinuationId: handle.providerContinuationId, providerTurnId: turnId });
    assert.deepEqual(await adapter.replyPermission(handle, requests[0]!, reply, { beforeNativeDispatch: async () => {} }),
      { outcome: "sent", scope: "request" });
    assert.deepEqual(JSON.parse(child.written.at(-1)!), { type: "control_response", response: {
      subtype: "success", request_id: "native-owner-tool",
      response: reply === "once" ? { behavior: "allow", updatedInput: { selector: "#buy" } } : { behavior: "deny", message: "The host rejected this action." },
    } });
    child.emit({ type: "result", subtype: "success", is_error: false, session_id: handle.providerContinuationId, user_message_uuid: turnId, result: "Done" });
    await running.catch(() => {}); controller.abort(); await observing; await adapter.stop(handle);
  }
});
