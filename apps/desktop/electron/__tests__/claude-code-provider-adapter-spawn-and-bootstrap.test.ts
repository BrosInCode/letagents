import "./isolated-home.js";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertOwnerPrivateFile } from "./harness.js";
import { providerAcquisitionIdentity, providerAcquisitionEvidence } from "../../../../shared/provider-acquisition-evidence.mjs";
import {
  ClaudeCodeProviderAdapter,
  claudeSessionTranscriptCandidates,
  claudeCliEnv,
  claudeLaunchPolicyArgs,
  createEphemeralClaudeMcpConfig,
  createManagedClaudeMcpConfig,
} from "../main/agents/claude-code-provider-adapter.js";
import type { ProviderStreamEvent, NativeExecutionObservation } from "../main/agents/provider-adapter.js";
import {
  ProviderActionPortRouter,
  ProviderSchedulerFailureCoordinator,
  redactCredentialText,
  FakeClaudeChild,
  type HarnessOptions,
  argValue,
  birthIdentity,
  createHarness,
  spawnRequest,
  flush,
  withLoopAlive,
} from "./claude-code-provider-adapter.fixture.js";

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
  const failed = await running;
  assert.equal(failed.outcome, "failed", "an exact result ends its turn, whatever else it holds");
  assert.match((failed as { error: string }).error, /does not recognize \(no subtype, no is_error\)/);
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

  assert.equal((await running).outcome, "failed", "the delivery ends on the exact result under either authority");
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
    assertOwnerPrivateFile(config.path, root);
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
