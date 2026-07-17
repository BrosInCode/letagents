import assert from "node:assert/strict";
import test from "node:test";

import {
  CursorProviderAdapter,
  cursorCliEnv,
  cursorLaunchPolicyArgs,
  type CursorCliChild,
  type CursorProviderAdapterDependencies,
} from "../main/agents/cursor-provider-adapter.js";
import type {
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../main/agents/provider-adapter.js";
import type { ProviderProcessExit } from "../main/agents/provider-evidence.js";

// Fake per-turn child harness proving the P2b adapter honors the #765
// invariants under Cursor's one-child-per-turn model: honest idle-between-turns
// (never a claimed live process), turn-terminal vs attempt-terminal evidence,
// boundary delivery, and the recycled-pid / ambiguity / no-orphan rules.

class FakeCursorChild implements CursorCliChild {
  readonly lines: Array<(line: string) => void> = [];
  alive = true;
  stderr = "";
  private resolveExited!: (exit: ProviderProcessExit) => void;
  readonly exited: Promise<ProviderProcessExit>;

  constructor(readonly pid: number | null) {
    this.exited = new Promise((resolve) => { this.resolveExited = resolve; });
  }

  stderrTail(): string {
    return this.stderr;
  }

  onLine(listener: (line: string) => void): () => void {
    this.lines.push(listener);
    return () => {
      const index = this.lines.indexOf(listener);
      if (index >= 0) this.lines.splice(index, 1);
    };
  }

  emit(message: Record<string, unknown>): void {
    for (const listener of [...this.lines]) listener(JSON.stringify(message));
  }

  emitRaw(line: string): void {
    for (const listener of [...this.lines]) listener(line);
  }

  resolveExit(exit: ProviderProcessExit): void {
    this.alive = false;
    this.resolveExited(exit);
  }
}

interface HarnessOptions {
  pid?: number | null;
  /** Force the first stream event's session id (identity-mismatch cases). */
  sessionId?: string;
  /** Suppress the auto first event so the startup bound can be exercised. */
  silent?: boolean;
  identities?: Map<number, string | null | undefined>;
  /** Defaults to true (a well-behaved CLI); fence tests opt out. */
  dieOnSigterm?: boolean;
}

function birthIdentity(pid: number): string {
  return `fake-cursor-${pid}-birth-1`;
}

function argValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1]! : null;
}

function createHarness(options: HarnessOptions = {}) {
  const children: FakeCursorChild[] = [];
  const launches: Array<{ cursorBin: string; args: string[]; cwd: string }> = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const identities = options.identities ?? new Map<number, string | null | undefined>();
  let nextPid = 5200;
  let mintedSessions = 0;

  const dependencies: CursorProviderAdapterDependencies = {
    launchTurn(input) {
      launches.push(input);
      const pid = options.pid === undefined ? nextPid++ : options.pid;
      const child = new FakeCursorChild(pid);
      children.push(child);
      if (pid !== null && !identities.has(pid)) identities.set(pid, birthIdentity(pid));
      if (!options.silent) {
        const sessionId = options.sessionId
          ?? argValue(input.args, "--resume")
          ?? `sess-cursor-${++mintedSessions}`;
        queueMicrotask(() => {
          if (!child.alive) return;
          child.emit({ type: "system", subtype: "init", session_id: sessionId, model: "cursor-fast" });
        });
      }
      return child;
    },
    signalProcess(pid, signal) {
      signals.push({ pid, signal });
      const child = children.find((entry) => entry.pid === pid && entry.alive);
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
    now: () => new Date(1_700_000_000_000).toISOString(),
  };

  return { children, launches, signals, identities, dependencies };
}

function spawnRequest(over: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "wa-cursor-1",
    roomId: "github.com/example/repo",
    agentDisplayName: "TidalHare",
    cwd: "/tmp/wa-cursor-1",
    launchPolicy: { mode: "ask", sandbox: "enabled" },
    ...over,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

async function withLoopAlive<T>(work: Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await work;
  } finally {
    clearInterval(keepAlive);
  }
}

test("spawn runs one per-turn child with verbatim policy flags and the prompt as a positional argument", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  assert.equal(harness.launches.length, 1);
  const args = harness.launches[0]!.args;
  assert.equal(args[0], "-p");
  assert.ok(args.join(" ").includes("--output-format stream-json"));
  assert.ok(args.includes("--trust"), "headless workspace-trust suppression is adapter-owned");
  assert.ok(args.join(" ").includes("--workspace /tmp/wa-cursor-1"));
  assert.ok(args.join(" ").includes("--mode ask"), "native policy flag passed verbatim");
  assert.ok(args.join(" ").includes("--sandbox enabled"));
  assert.equal(args.includes("--resume"), false);
  const prompt = args[args.length - 1]!;
  assert.ok(prompt.includes("Cursor worker"), "prompt is provider-labelled and positional");
  assert.ok(prompt.includes('"cursor:'), "register_agent_session runtime uses the cursor key");

  // spawn resolves while the turn is still RUNNING: live pid, working state.
  assert.equal(handle.observedState(), "working");
  assert.equal(handle.pid, 5200);
  assert.deepEqual(handle.providerConnection, {
    kind: "cursor_cli",
    pid: 5200,
    processIdentity: birthIdentity(5200),
  });
  assert.equal(handle.providerContinuationId, "sess-cursor-1", "session id captured from the stream");
});

test("cursorLaunchPolicyArgs maps mechanically and rejects adapter-owned flags", () => {
  assert.deepEqual(
    cursorLaunchPolicyArgs({ mode: "plan", force: true, sandbox: "disabled", model: "cursor-fast" }),
    ["--mode", "plan", "--force", "--sandbox", "disabled", "--model", "cursor-fast"],
  );
  assert.throws(() => cursorLaunchPolicyArgs({ resume: "sess-x" }), /reserved flag 'resume'/);
  assert.throws(() => cursorLaunchPolicyArgs({ workspace: "/elsewhere" }), /reserved flag 'workspace'/);
  assert.throws(() => cursorLaunchPolicyArgs("yolo"), /native CLI options object/);
});

test("cursorCliEnv passes the environment through without curation (v10 §3 — diverges from the legacy allowlist)", () => {
  const env = cursorCliEnv({ HOME: "/Users/someone", SOME_RANDOM_VAR: "kept", CURSOR_API_KEY: "kept-too" });
  assert.equal(env.SOME_RANDOM_VAR, "kept", "no allowlist: unknown vars survive");
  assert.equal(env.HOME, "/Users/someone");
  assert.equal(env.CURSOR_API_KEY, "kept-too");
});

test("a successful result is TURN-terminal: the lane goes idle with NO claimed process and is not attempt-terminal", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  const child = harness.children[0]!;
  child.emit({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "sess-cursor-1" });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();

  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(terminals, [], "a finished turn never becomes attempt-terminal evidence");
  // The honest idle cell: no process is claimed between turns.
  assert.equal(handle.pid, null);
  assert.deepEqual(handle.providerConnection, { kind: "cursor_cli", pid: null, processIdentity: null });
  assert.equal(handle.providerContinuationId, "sess-cursor-1", "the session id is the only continuation state");
});

test("a turn child that dies WITHOUT its result event is attempt-terminal (crashed) and attach reports absent", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  harness.identities.set(5200, null);
  harness.children[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "crashed");
  assert.equal(handle.observedState(), "failed");
  assert.equal(await adapter.attach({
    workAttemptId: "wa-cursor-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "cursor_cli", pid: 5200, processIdentity: birthIdentity(5200) },
  }), null);
});

test("stop during a live turn orders SIGTERM before the observed terminal and escalates to SIGKILL after grace", async () => {
  const graceful = createHarness();
  const gracefulAdapter = new CursorProviderAdapter({ dependencies: graceful.dependencies, stopGraceMs: 200 });
  const gracefulHandle = await gracefulAdapter.spawn(spawnRequest());
  const stopped = await gracefulAdapter.stop(gracefulHandle);
  assert.deepEqual(graceful.signals.map((entry) => entry.signal), ["SIGTERM"]);
  assert.equal(stopped.terminalCause, "stopped");

  const stubborn = createHarness({ dieOnSigterm: false });
  const stubbornAdapter = new CursorProviderAdapter({ dependencies: stubborn.dependencies, stopGraceMs: 30 });
  const stubbornHandle = await stubbornAdapter.spawn(spawnRequest());
  const killed = await withLoopAlive(stubbornAdapter.stop(stubbornHandle));
  assert.deepEqual(stubborn.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"]);
  assert.equal(killed.terminalCause, "killed");
});

test("stop while idle needs no signal: nothing is running, the attempt ends immediately as stopped", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(handle.observedState(), "idle");

  const stopped = await adapter.stop(handle);
  assert.equal(stopped.terminalCause, "stopped");
  assert.deepEqual(harness.signals, [], "no process existed, so nothing was signalled");
  assert.equal(handle.observedState(), "stopped");
});

test("poke delivers at the boundary: refused mid-turn, runs a --resume turn when idle", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  await assert.rejects(adapter.poke(handle, "mid-turn message"), /no channel into a running turn/);

  const first = harness.children[0]!;
  first.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  first.resolveExit({ type: "exit", code: 0, signal: null });
  await flush();
  assert.equal(handle.observedState(), "idle");

  await adapter.poke(handle, "next room event");
  assert.equal(harness.launches.length, 2, "boundary delivery runs a fresh per-turn child");
  const args = harness.launches[1]!.args;
  assert.ok(args.join(" ").includes("--resume sess-cursor-1"), "the next turn continues the recorded session");
  assert.equal(args[args.length - 1], "next room event");
  assert.equal(handle.observedState(), "working");
  assert.equal(handle.pid, 5201, "the new turn's live pid is claimed while it runs");
});

test("Cursor turn control fences only the live turn child and resumes the same session without attempt terminal", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  const result = await withLoopAlive(adapter.controlTurn!(handle, "Apply the corrected direction."));

  assert.deepEqual(result, {
    capability: "restart_resume",
    interrupted: true,
    resumed: true,
    state: "working",
  });
  assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }]);
  assert.deepEqual(terminals, [], "turn-child interruption never becomes attempt-terminal evidence");
  assert.equal(harness.launches.length, 2);
  assert.ok(harness.launches[1]!.args.join(" ").includes("--resume sess-cursor-1"));
  assert.equal(harness.launches[1]!.args.at(-1), "Apply the corrected direction.");
  assert.equal(handle.providerContinuationId, "sess-cursor-1");
  assert.equal(handle.observedState(), "working");
});

test("resume presents the recorded session and a stranger session id mid-stream is a protocol violation", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.resume(
    { workAttemptId: "wa-cursor-1", providerContinuationId: "sess-old" },
    spawnRequest(),
  );
  assert.ok(harness.launches[0]!.args.join(" ").includes("--resume sess-old"));
  assert.equal(handle.providerContinuationId, "sess-old", "the SAME session continues");

  // A stranger session id in the init itself must not silently become the
  // continuation: the launch is REJECTED and the fenced turn child terminated.
  const wrong = createHarness({ sessionId: "sess-stranger" });
  const wrongAdapter = new CursorProviderAdapter({ dependencies: wrong.dependencies });
  await assert.rejects(wrongAdapter.resume(
    { workAttemptId: "wa-cursor-2", providerContinuationId: "sess-old" },
    spawnRequest({ workAttemptId: "wa-cursor-2" }),
  ), /violated the session contract/);
  assert.deepEqual(wrong.signals.map((entry) => entry.signal), ["SIGTERM"], "the mismatched turn child was fenced");
  assert.equal(wrong.children[0]!.alive, false);
});

test("startup gates on a valid init, not arbitrary stdout bytes (msg_1758)", async () => {
  // Raw diagnostics BEFORE init are published as evidence but do not start the
  // turn; the handle only returns once init supplies the session identity.
  const harness = createHarness({ silent: true });
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
    turnStartTimeoutMs: 500,
  });
  const spawning = adapter.spawn(spawnRequest());
  await flush();
  const child = harness.children[0]!;
  child.emitRaw("cursor-agent: warming up model cache");
  await flush();
  child.emit({ type: "system", subtype: "init", session_id: "sess-late-init" });
  const handle = await spawning;
  assert.equal(handle.providerContinuationId, "sess-late-init", "init, not raw bytes, supplies the continuation");
  assert.ok(streamEvents.some((event) => event.method === "stdout/raw"), "pre-init diagnostics still published");

  // Raw-only output that never becomes an init times out and fences the child.
  const rawOnly = createHarness({ silent: true });
  const rawOnlyAdapter = new CursorProviderAdapter({ dependencies: rawOnly.dependencies, turnStartTimeoutMs: 60, stopGraceMs: 30 });
  const rawSpawning = rawOnlyAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-7" }));
  rawSpawning.catch(() => {});
  await flush();
  rawOnly.children[0]!.emitRaw("just noise, never an init");
  await assert.rejects(rawSpawning, /no stream-json init within the startup bound/);
  assert.equal(rawOnly.children[0]!.alive, false, "the unobservable child was terminated and awaited");
});

test("only a genuine system/init with a session id satisfies readiness — other system events do not (msg_1807)", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  await flush();
  const child = harness.children[0]!;

  // A non-init system event — even one carrying a session id — must not start
  // the turn or become the continuation identity for readiness.
  child.emit({ type: "system", subtype: "status", session_id: "sess-early" });
  await flush();

  child.emit({ type: "system", subtype: "init", session_id: "sess-real-init" });
  const handle = await spawning;
  assert.equal(handle.observedState(), "working", "readiness resolved only after the real init");
  assert.equal(handle.providerContinuationId, "sess-real-init");
});

test("an init that carries no session id is fenced immediately as a session-contract violation (msg_1807)", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await flush();
  harness.children[0]!.emit({ type: "system", subtype: "init" });
  await assert.rejects(spawning, /violated the session contract/);
  assert.deepEqual(harness.signals.map((entry) => entry.signal), ["SIGTERM"], "the sessionless child was fenced, not awaited to timeout");
  assert.equal(harness.children[0]!.alive, false);
});

test("a child that exits before init rejects the launch and records terminal evidence", async () => {
  const harness = createHarness({ silent: true });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, turnStartTimeoutMs: 500 });
  const spawning = adapter.spawn(spawnRequest());
  spawning.catch(() => {});
  await flush();
  harness.identities.set(5200, null);
  harness.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await assert.rejects(spawning, /exited before reporting its stream-json init/);
});

test("a streaming-but-quiet turn stays working; a completely silent turn is fenced with no orphan", async () => {
  const streaming = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: streaming.dependencies, turnStartTimeoutMs: 40 });
  const handle = await adapter.spawn(spawnRequest());
  await flush();
  await flush();
  assert.equal(handle.observedState(), "working", "long quiet turns are not dead");
  assert.equal(streaming.signals.length, 0);

  const silent = createHarness({ silent: true });
  const silentAdapter = new CursorProviderAdapter({ dependencies: silent.dependencies, turnStartTimeoutMs: 40, stopGraceMs: 30 });
  await assert.rejects(silentAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-3" })), /no stream-json init within the startup bound/);
  assert.equal(silent.children[0]!.alive, false, "the unobservable child was terminated and awaited");
});

test("a recycled pid can neither authenticate an attach nor be signalled; unverifiable identity stays ambiguous", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  harness.identities.set(7777, "some-other-birth");
  assert.equal(await adapter.attach({
    workAttemptId: "wa-x",
    providerContinuationId: "sess-x",
    providerConnection: { kind: "cursor_cli", pid: 7777, processIdentity: "recorded-birth" },
  }), null, "recorded turn child proven absent");
  assert.deepEqual(harness.signals, [], "the recycled pid was never signalled");

  harness.identities.set(8888, undefined);
  await assert.rejects(adapter.attach({
    workAttemptId: "wa-y",
    providerContinuationId: "sess-y",
    providerConnection: { kind: "cursor_cli", pid: 8888, processIdentity: "birth-y" },
  }), /ambiguous/);

  // An idle lane records no pid: its absence is exact, not ambiguous.
  assert.equal(await adapter.attach({
    workAttemptId: "wa-z",
    providerContinuationId: "sess-z",
    providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
  }), null);
});

test("attach to a live orphaned turn child fences it (TERM, identity recheck, KILL) before reporting absent", async () => {
  const harness = createHarness({ dieOnSigterm: false });
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const handle = await adapter.spawn(spawnRequest());

  const fresh = new CursorProviderAdapter({ dependencies: harness.dependencies, stopGraceMs: 30 });
  const attached = await withLoopAlive(fresh.attach({
    workAttemptId: "wa-cursor-1",
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: { kind: "cursor_cli", pid: 5200, processIdentity: birthIdentity(5200) },
  }));

  assert.equal(attached, null, "after fencing, the lane is provably absent for bounded resume");
  assert.deepEqual(harness.signals.map((entry) => entry.signal), ["SIGTERM", "SIGKILL"], "exact-child fence ordering");
  assert.equal(harness.identities.get(5200), null, "the orphan is verifiably gone before recovery may proceed");
  assert.equal(harness.launches.length, 1, "fencing never launches a second writer");
});

test("a result line delivered after exit resolution still counts: the lane goes idle, never falsely terminal (msg_1780)", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  // Simulate the drain race: exit evidence resolves first, the buffered final
  // result line lands one microtask later (as a still-flushing pipe would).
  const child = harness.children[0]!;
  child.resolveExit({ type: "exit", code: 0, signal: null });
  await Promise.resolve();
  child.emit({ type: "result", subtype: "success", is_error: false, session_id: "sess-cursor-1" });
  await flush();

  assert.deepEqual(terminals, [], "a cleanly completed turn is never misread as a crash");
  assert.equal(handle.observedState(), "idle");
});

test("the proven usage-limit signature classifies as provider_quota, not crashed (msg_1708)", async () => {
  const harness = createHarness();
  const adapter = new CursorProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  // init + user emitted normally, then the stream stops with NO result, the
  // ActionRequiredError lands on stderr, and the process exits 1.
  const child = harness.children[0]!;
  child.emit({ type: "user", session_id: "sess-cursor-1" });
  child.stderr = "ActionRequiredError: You've hit your usage limit. Switch to a different model or set a Spend Limit.";
  child.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.terminalCause, "provider_quota", "an account condition is never recorded as a crash");
  assert.equal(terminals[0]!.exitCode, 1);
  assert.equal(handle.observedState(), "failed");

  // The same no-result death WITHOUT the quota signature stays a crash.
  const crash = createHarness();
  const crashAdapter = new CursorProviderAdapter({ dependencies: crash.dependencies });
  const crashHandle = await crashAdapter.spawn(spawnRequest({ workAttemptId: "wa-cursor-9" }));
  const crashTerminals: ProviderTerminalPayload[] = [];
  crashAdapter.onExit(crashHandle, (terminal) => crashTerminals.push(terminal));
  crash.children[0]!.stderr = "segfault or something else entirely";
  crash.children[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  assert.equal(crashTerminals[0]!.terminalCause, "crashed");
});

test("stream evidence is bounded, redacted, and ordered; non-JSON output keeps method identity", async () => {
  const harness = createHarness();
  const streamEvents: ProviderStreamEvent[] = [];
  const adapter = new CursorProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => streamEvents.push(event),
  });
  await adapter.spawn(spawnRequest());
  const child = harness.children[0]!;

  child.emit({ type: "assistant", message: { content: [{ type: "text", text: "hi room" }] }, api_key: "sk-nope" });
  child.emitRaw("cursor-agent plain diagnostics line");
  await flush();

  const assistant = streamEvents.find((event) => event.method === "assistant");
  assert.ok(assistant);
  assert.equal(assistant!.payloadRedacted, true);
  assert.equal((assistant!.payload as { api_key?: unknown }).api_key, "[REDACTED]");
  assert.ok(streamEvents.some((event) => event.method === "stdout/raw"), "non-JSON output preserved as bounded evidence");
  const sequences = streamEvents.map((event) => event.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, "stream sequence is ordered");
});
