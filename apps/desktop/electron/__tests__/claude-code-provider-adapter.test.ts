import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ClaudeCodeProviderAdapter,
  claudeSessionTranscriptCandidates,
  claudeCliEnv,
  claudeLaunchPolicyArgs,
  createEphemeralClaudeMcpConfig,
  createManagedClaudeMcpConfig,
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
import { defaultGetProcessIdentity, sameProcessBirthIdentity, type ProviderProcessExit } from "../main/agents/provider-evidence.js";

// Cross-layer assertions load the daemon at test runtime without pulling its
// separately compiled source tree into Electron's production rootDir.
const { providerStreamLifecycle } = await import(new URL("../../daemon/provider-stream-policy.ts", import.meta.url).href);
const { emptyExecutionProjection, reduceExecutionFact } = await import(new URL("../../daemon/execution-reducer.ts", import.meta.url).href);

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
  bootstrapResultSubtype?: string;
  /** Overrides per pid; undefined entries mean "cannot verify". */
  identities?: Map<number, string | null | undefined>;
  /** Defaults to true (a well-behaved CLI); fence tests opt out to exercise escalation. */
  dieOnSigterm?: boolean;
  versionOutput?: string;
  sessionRows?: Array<Record<string, unknown>>;
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
  const launches: Array<{ claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  const versionBins: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const identities = options.identities ?? new Map<number, string | null | undefined>();
  let nextPid = 4100;
  let mcpConfigDisposals = 0;
  let versionReads = 0;

  const dependencies: ClaudeCodeProviderAdapterDependencies = {
    async readVersion(claudeBin) {
      versionReads += 1;
      versionBins.push(claudeBin);
      return options.versionOutput ?? "2.1.220 (Claude Code)";
    },
    async createLetAgentsMcpConfig() {
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
        if (sawFirstWrite || options.noInit) return;
        sawFirstWrite = true;
        queueMicrotask(() => {
          if (!child.alive) return;
          child.emit({
            type: "system",
            subtype: "init",
            session_id: initSessionId,
            model: "claude-fable-5",
            permissionMode: "default",
            cwd: input.cwd,
            mcp_servers: options.noLetagents ? [] : [{ name: "letagents", status: "connected" }],
          });
          const frame = JSON.parse(json) as { uuid?: string };
          child.emit({
            type: "result",
            subtype: options.bootstrapResultSubtype ?? "success",
            is_error: options.bootstrapResultSubtype !== undefined,
            session_id: initSessionId,
            user_message_uuid: frame.uuid,
            result: "LETAGENTS_CLAUDE_DAEMON_READY",
          });
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
    now: () => new Date(1_700_000_000_000).toISOString(),
  };

  return {
    children,
    launches,
    versionBins,
    signals,
    identities,
    dependencies,
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

test("managed Claude MCP config is private, official-runtime-only, and ephemeral outside the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-claude-mcp-test-"));
  try {
    const config = await createEphemeralClaudeMcpConfig({
      LETAGENTS_API_URL: "https://letagents.example",
      LETAGENTS_TOKEN: "test-worker-token",
    }, root);
    const parsed = JSON.parse(await readFile(config.path, "utf8"));
    assert.deepEqual(parsed, {
      mcpServers: {
        letagents: {
          command: "npx",
          args: ["-y", "--package=letagents-runtime@npm:letagents", "letagents"],
          env: {
            LETAGENTS_API_URL: "https://letagents.example",
            LETAGENTS_TOKEN: "test-worker-token",
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
    const config = await createManagedClaudeMcpConfig("https://desktop.letagents.example", root);
    const parsed = JSON.parse(await readFile(config.path, "utf8"));
    assert.deepEqual(parsed.mcpServers.letagents.env, {
      LETAGENTS_API_URL: "https://desktop.letagents.example",
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
  await assert.rejects(adapter.spawn(spawnRequest()), /did not complete its daemon-safe bootstrap turn/);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.children[0]!.alive, false);
  assert.equal(harness.mcpConfigDisposals, 1);
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
  assert.match(prompt, /daemon owns observation, credentials, retries, and publication/i);
  assert.match(prompt, /Do not register a session, authenticate, poll/);
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
  await assert.rejects(running, /failed.*interrupted/i);
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
  await assert.rejects(running, /failed.*interrupted/i);
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
    await assert.rejects(running, /failed.*interrupted/i,
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
      await assert.rejects(running, /failed.*error_during_execution/i);
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
    await assert.rejects(running, /failed: Configured turn limit reached/);
    assert.equal(handle.observedState(), "idle");
    assert.equal(stream.at(-1)?.kind, "turn_lifecycle");
    assert.equal(stream.at(-1)?.method, `result/${subtype}`);
    assert.equal(providerStreamLifecycle(stream.at(-1)!), "idle");
    assert.equal((stream.at(-1)?.payload as { is_error: boolean }).is_error, true);

    const writesBeforeRecovery = child.written.length;
    await assert.rejects(adapter.recoverRoomTurn!(handle, {
      inboxItemId: request.inboxItemId, providerTurnId: frame.uuid,
    }), /failed: Configured turn limit reached/);
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
    controlProbe: "unsupported", approvals: { kinds: [], recovery: "unsupported", denyScope: "unsupported" },
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
  await assert.rejects(running, /failed/);
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
