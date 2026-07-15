import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ClaudeCodeProviderAdapter,
  claudeCliEnv,
  claudeLaunchPolicyArgs,
  createEphemeralClaudeMcpConfig,
  type ClaudeCliChild,
  type ClaudeCodeProviderAdapterDependencies,
} from "../main/agents/claude-code-provider-adapter.js";
import type {
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../main/agents/provider-adapter.js";
import type { ProviderProcessExit } from "../main/agents/provider-evidence.js";

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
  /** Overrides per pid; undefined entries mean "cannot verify". */
  identities?: Map<number, string | null | undefined>;
  /** Defaults to true (a well-behaved CLI); fence tests opt out to exercise escalation. */
  dieOnSigterm?: boolean;
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
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const identities = options.identities ?? new Map<number, string | null | undefined>();
  let nextPid = 4100;
  let mcpConfigDisposals = 0;

  const dependencies: ClaudeCodeProviderAdapterDependencies = {
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
    now: () => new Date(1_700_000_000_000).toISOString(),
  };

  return {
    children,
    launches,
    signals,
    identities,
    dependencies,
    get mcpConfigDisposals() { return mcpConfigDisposals; },
  };
}

function spawnRequest(over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "wa-claude-1",
    roomId: "github.com/example/repo",
    agentDisplayName: "LanternRook",
    cwd: "/tmp/wa-claude-1",
    launchPolicy: { permissionMode: "acceptEdits" },
    ...over,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
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

test("spawn launches the headless CLI with verbatim policy flags, verifies the workplace, and sends the room start prompt", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  const handle = await adapter.spawn(spawnRequest({ launchPolicy: { permissionMode: "acceptEdits", model: "opus", dangerouslySkipPermissions: false } }));

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
  assert.equal(handle.observedState(), "working");

  const child = harness.children[0]!;
  assert.equal(child.written.length, 1, "exactly one start-prompt user message");
  const startMessage = JSON.parse(child.written[0]!) as { type: string; message: { content: Array<{ text: string }> } };
  assert.equal(startMessage.type, "user");
  const prompt = startMessage.message.content[0]!.text;
  assert.ok(prompt.includes("Claude Code worker"), "prompt is provider-labelled");
  assert.ok(prompt.includes('"claude-code:'), "register_agent_session runtime uses the claude-code key");
  assert.ok(!/Never call yourself Codex/.test(prompt), "codename guard names this provider, not Codex");

  assert.ok(streamEvents.some((event) => event.method === "system/init"), "init published as stream evidence");
});

test("Claude supervised launch passes the exact daemon generation bridge to its LetAgents MCP workplace", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
  }));
  assert.deepEqual(harness.launches[0]?.env, {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: spawnRequest().workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "execution_exact",
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

test("claudeCliEnv passes the user's environment through minus exactly the CLAUDECODE carve-out", () => {
  const env = claudeCliEnv({ CLAUDECODE: "1", HOME: "/Users/someone", ANTHROPIC_LOG: "debug" });
  assert.equal("CLAUDECODE" in env, false, "the spike-proven launch blocker is removed");
  assert.equal(env.HOME, "/Users/someone");
  assert.equal(env.ANTHROPIC_LOG, "debug");
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

test("observed crash emits one synthesized terminal payload and makes attach absent", async () => {
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
  assert.equal(await adapter.attach({
    workAttemptId: "wa-claude-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
  }), null);
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
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  harness.children[0]!.disconnect();
  await flush();

  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }], "the exact live child is fenced");
  assert.equal(terminals.length, 0, "stdio loss alone cannot make a live writer restartable");
  assert.equal(harness.children[0]!.alive, true);

  // Only real identity disappearance becomes terminal.
  harness.identities.set(4100, null);
  harness.children[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "crashed");
});

test("a quiet child stays working: no signals, no terminal, no state decay", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  await flush();
  await flush();

  assert.equal(handle.observedState(), "working");
  assert.deepEqual(harness.signals, []);
  assert.deepEqual(terminals, []);
});

test("a recycled pid can neither authenticate an attach nor be signalled", async () => {
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  const fresh = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
  harness.identities.set(4100, "some-other-birth-2");
  const attached = await fresh.attach({
    workAttemptId: "wa-claude-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "claude_cli", pid: 4100, processIdentity: birthIdentity(4100) },
  });
  assert.equal(attached, null, "the recorded child is proven absent");
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

test("attach to a live unreachable orphan fences it (TERM, identity recheck, KILL) before reporting absent", async () => {
  const harness = createHarness({ dieOnSigterm: false });
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const handle = await adapter.spawn(spawnRequest());

  // A fresh adapter (daemon restart) has no stdio to the recorded child.
  const fresh = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const attached = await withLoopAlive(fresh.attach({
    workAttemptId: "wa-claude-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "claude_cli", pid: 4100, processIdentity: birthIdentity(4100) },
  }));

  assert.equal(attached, null, "after fencing, the lane is provably absent for bounded recovery");
  assert.deepEqual(harness.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"], "exact-child fence ordering");
  assert.equal(harness.identities.get(4100), null, "the orphan is verifiably gone before recovery may proceed");
  assert.equal(harness.launches.length, 1, "fencing never launches a second writer");
});

test("resume presents the recorded continuation and asserts the spike-proven same-session identity", async () => {
  // msg_1382 proved `--resume <id>` continues the SAME session id, so the
  // capability is advertised and the identity is asserted, exactly like
  // Codex's exact-thread resume.
  const harness = createHarness();
  const adapter = new ClaudeCodeProviderAdapter({ dependencies: harness.dependencies });
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
  assert.match(resumePrompt, /agent_session_exact/);
  assert.match(resumePrompt, /msg_2819/);
  assert.match(resumePrompt, /Do not call register_agent_session/);
  assert.doesNotMatch(resumePrompt, /Suggested codename|Call set_agent_name/);

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

test("error result messages settle the observed state to failed", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new ClaudeCodeProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  harness.children[0]!.emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "native provider failure",
  });
  await flush();

  assert.equal(handle.observedState(), "failed");
  assert.equal(stream.at(-1)?.kind, "error");
  assert.equal(stream.at(-1)?.method, "result/error_during_execution");
});
