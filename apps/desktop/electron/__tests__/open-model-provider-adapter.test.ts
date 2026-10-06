import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPEN_MODEL_PROVIDER_RETRY_METHOD,
  OpenCodeRuntimeGoneError,
  OpenModelProviderAdapter,
  type OpenCodePermissionObservation,
  type OpenModelProviderAdapterDependencies,
} from "../main/agents/open-model-provider-adapter.js";
import {
  PROCESS_ENDED_DURING_TURN,
  ProviderTurnControlError,
  type ProviderHandle,
  type ProviderRoomTurnResult,
  type ProviderSpawnRequest,
  type ProviderStreamEvent,
} from "../main/agents/provider-adapter.js";
import {
  terminateFreshLaunch,
  type ProviderProcessExit,
} from "../main/agents/provider-evidence.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import {
  OpenCodePermissionReplyError,
  OpenCodeServerClient,
  parseOpenCodePermissionEvent,
  type OpenCodePermissionRequest,
} from "../main/agents/opencode-server-client.js";
import { seedOpenCodeConfigHome, shieldOwnerInstructions } from "../main/agents/opencode-launch-contract.js";
import { OPENCODE_RUNTIME_VERSION } from "../main/agents/opencode-runtime.js";
import { NO_REPLY_FAILURE } from "../../../../shared/room-turn-no-reply.mjs";

type LaunchRecord = {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};
type TranscriptMessage = {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
};
type TranscriptFactory = (turnId: string) => TranscriptMessage[];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A launch that is expected to get as far as its first session has a budget
// no runner will exhaust. The harness answers at once, so the size costs
// nothing. With 100ms, a slow file write before the health check used up the
// budget and the launch timed out. Cleanup then waited for the harness's
// process to exit, which it never does, and Node ended the file: that test
// and every test after it were cancelled. Where a test asserted the phase, it
// saw "health" where it expected "session".
const LAUNCH_BUDGET_MS = 10_000;

function createHarness() {
  const launches: LaunchRecord[] = [];
  const promptBodies: Array<Record<string, unknown>> = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const aborts: string[] = [];
  const sessions = new Set(["session-open-model-1"]);
  let nextSession = 1;
  let assistantText = "OpenCode bounded reply.";
  let includeAssistantText = true;
  let holdTurnOpen = false;
  let nativeStatus: Record<string, unknown> = { type: "busy" };
  let statusReads = 0;
  let statusReadsHeldAfterAbort = 0;
  const messageReadWaiters: Array<() => void> = [];
  let transcriptWhileBusy = false;
  let transcriptFactories: TranscriptFactory[] | null = null;
  let streamEvents: Array<Record<string, unknown>> = [];
  let promptFailure: Error | null = null;
  let observedProcessExit: Promise<ProviderProcessExit>;
  let messageReads = 0;
  let permissions: unknown = [];
  const permissionReplies: Array<{ requestId: string; reply: string }> = [];
  const eventStreams = new Set<{ send(event: Record<string, unknown>): void; close(): void }>();
  let eventConnections = 0;
  const gitProbes: Array<{ workspace: string; environment: NodeJS.ProcessEnv }> = [];
  let gitProblem: string | null = null;

  const neverExits = new Promise<ProviderProcessExit>(() => {});
  observedProcessExit = neverExits;
  const dependencies: OpenModelProviderAdapterDependencies = {
    launch(input) {
      launches.push(input);
      const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
      Object.assign(child, { pid: 6101, unref() {} });
      return { child, exited: neverExits };
    },
    getProcessIdentity(pid) {
      return pid === 6101 ? "opencode-birth-6101" : null;
    },
    observeProcessExit() {
      return observedProcessExit;
    },
    signalProcess(pid, signal) {
      signals.push({ pid, signal });
    },
    allocatePort: async () => 43821,
    discoverRuntimeConnection: async () => null,
    async fetch(input, init) {
      const url = new URL(input);
      const authorization = new Headers(init?.headers).get("authorization");
      assert.match(authorization ?? "", /^Basic /);
      if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.20" });
      if (url.pathname === "/permission") return json(permissions);
      const permissionMatch = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (permissionMatch && init?.method === "POST") {
        const requestId = decodeURIComponent(permissionMatch[1]!);
        const { reply } = JSON.parse(String(init.body)) as { reply: string };
        permissionReplies.push({ requestId, reply });
        assert.ok(Array.isArray(permissions));
        const pending = permissions as OpenCodePermissionRequest[];
        const current = pending.find((request) => request.id === requestId);
        if (!current) return json({ _tag: "PermissionNotFoundError", requestID: requestId }, 404);
        permissions = pending.filter((request) => reply === "reject"
          ? request.sessionID !== current.sessionID
          : request.id !== current.id);
        return json(true);
      }
      if (url.pathname === "/event") {
        eventConnections += 1;
        const encoder = new TextEncoder();
        let connection: { send(event: Record<string, unknown>): void; close(): void };
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            connection = {
              send(event) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); },
              close() { if (eventStreams.delete(connection)) controller.close(); },
            };
            eventStreams.add(connection);
            controller.enqueue(encoder.encode(
              'data: {"type":"server.connected","properties":{}}\n\n',
            ));
            for (const event of streamEvents) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            init?.signal?.addEventListener("abort", () => connection.close(), {
              once: true,
            });
          },
          cancel() { eventStreams.delete(connection); },
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === "/config") {
        return json({ model: "letagents-open-model/qwen/qwen3-coder" });
      }
      if (url.pathname === "/session" && init?.method === "POST") {
        const id = nextSession === 1 ? "session-open-model-1" : `session-open-model-${nextSession}`;
        nextSession += 1;
        sessions.add(id);
        return json({ id });
      }
      if (url.pathname === "/session") {
        return json([...sessions].map((id) => ({ id })));
      }
      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (promptMatch && init?.method === "POST") {
        if (promptFailure) throw promptFailure;
        promptBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (messageMatch) {
        messageReads += 1;
        for (const wake of messageReadWaiters.splice(0)) wake();
        if (holdTurnOpen && !transcriptWhileBusy) return json([]);
        const turnId = String(promptBodies.at(-1)?.messageID ?? "turn-recovery");
        if (transcriptFactories) {
          const factory = transcriptFactories[
            Math.min(messageReads - 1, transcriptFactories.length - 1)
          ];
          return json(factory?.(turnId) ?? []);
        }
        return json([{
          info: {
            id: "assistant-1",
            role: "assistant",
            parentID: turnId,
            time: { created: 1_700_000_000_000, completed: 1_700_000_000_001 },
          },
          parts: [
            { id: "reasoning-1", type: "reasoning", text: "Checking the bounded context." },
            ...(includeAssistantText
              ? [{ id: "text-1", type: "text", text: assistantText }]
              : []),
            { id: "finish-1", type: "step-finish", reason: "stop" },
          ],
        }]);
      }
      if (url.pathname === "/session/status") {
        statusReads += 1;
        if (!holdTurnOpen && statusReadsHeldAfterAbort > 0) {
          statusReadsHeldAfterAbort -= 1;
          return json({ "session-open-model-1": nativeStatus });
        }
        return json(holdTurnOpen ? { "session-open-model-1": nativeStatus } : {});
      }
      if (url.pathname.endsWith("/abort") && init?.method === "POST") {
        aborts.push(decodeURIComponent(url.pathname.split("/")[2] ?? ""));
        holdTurnOpen = false;
        return json(true);
      }
      assert.fail(`Unexpected OpenCode request: ${init?.method ?? "GET"} ${url.pathname}`);
    },
    now: () => "2026-07-28T00:00:00.000Z",
    async probeGit(workspace, environment) {
      gitProbes.push({ workspace, environment });
      return gitProblem;
    },
  };

  return {
    dependencies,
    gitProbes,
    set gitProblem(value: string | null) { gitProblem = value; },
    launches,
    promptBodies,
    signals,
    aborts,
    permissionReplies,
    get eventConnections() { return eventConnections; },
    get activeEventStreams() { return eventStreams.size; },
    sendEvent(event: Record<string, unknown>) { for (const stream of eventStreams) stream.send(event); },
    closeEvents() { for (const stream of eventStreams) stream.close(); },
    get messageReads() {
      return messageReads;
    },
    get statusReads() {
      return statusReads;
    },
    /** Resolves when the adapter next reads the session transcript. */
    nextMessageRead(): Promise<void> {
      return new Promise((resolve) => { messageReadWaiters.push(resolve); });
    },
    /** The session keeps reporting its held status for this many reads after an abort. */
    holdStatusAfterAbort(reads: number) {
      statusReadsHeldAfterAbort = reads;
    },
    setAssistantText(value: string) {
      assistantText = value;
      includeAssistantText = true;
    },
    omitAssistantText() {
      includeAssistantText = false;
    },
    holdTurnOpen() {
      holdTurnOpen = true;
    },
    holdTurnOpenWithTranscript() {
      holdTurnOpen = true;
      transcriptWhileBusy = true;
    },
    /** OpenCode is waiting out a backoff before it re-sends a failed model request. */
    holdTurnInRetry() {
      holdTurnOpen = true;
      transcriptWhileBusy = true;
      nativeStatus = {
        type: "retry",
        attempt: 2,
        message: "Rate limit exceeded",
        next: 1_790_000_000_000,
      };
    },
    completeTurn() {
      holdTurnOpen = false;
      transcriptWhileBusy = false;
      for (const stream of eventStreams) {
        stream.send({
          type: "session.idle",
          properties: { sessionID: "session-open-model-1" },
        });
      }
    },
    setTranscriptFactories(factories: TranscriptFactory[]) {
      transcriptFactories = factories;
    },
    setStreamEvents(events: Array<Record<string, unknown>>) {
      streamEvents = events;
    },
    setPromptFailure(error: Error) {
      promptFailure = error;
    },
    setPermissions(value: unknown) {
      permissions = value;
    },
    completeObservedProcessExit(exit: ProviderProcessExit) {
      observedProcessExit = Promise.resolve(exit);
    },
  };
}

function spawnRequest(overrides: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "work-attempt-open-model-1",
    roomId: "focus_37",
    deliveryMode: "daemon_inbox",
    agentDisplayName: "QuartzCove",
    cwd: "/tmp/open-model-worktree",
    workspaceKind: "git_worktree",
    launchPolicy: { permission: { "*": "allow" } },
    model: "qwen/qwen3-coder",
    reasoningEffort: null,
    permissionProfileId: "full_access",
    configurationRevision: 1,
    supervisorEntryId: "supervised-open-model-1",
    supervisorSocketPath: "/tmp/letagents-supervisor.sock",
    supervisorExecutionGenerationId: "generation-open-model-1",
    supervisorWorkerSession: {
      agentSessionId: "agent-session-open-model-1",
      roomCursor: null,
    },
    providerCredential: {
      apiKey: "provider-api-key-must-stay-out-of-config",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "qwen/qwen3-coder",
    },
    ...overrides,
  };
}

async function spawnAdapter(overrides: Partial<ProviderSpawnRequest> = {}, harness = createHarness()) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-adapter-"));
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });
  const handle = await adapter.spawn(spawnRequest(overrides));
  return { adapter, handle, harness, runtimeRoot };
}

function userMessage(id: string): TranscriptMessage {
  return { info: { id, role: "user", time: { created: 5 } }, parts: [] };
}

/** Mirrors OpenCode's Identifier.create("msg", "ascending"): hex(ms * 0x1000 + counter) + base62 randomness. */
function openCodeStyleAscendingId(timestampMs: number, counter: number): string {
  let encoded = BigInt(timestampMs) * BigInt(0x1000) + BigInt(counter);
  const timeBytes = Buffer.alloc(6);
  for (let index = 5; index >= 0; index -= 1) {
    timeBytes[index] = Number(encoded & BigInt(0xff));
    encoded >>= BigInt(8);
  }
  return `msg_${timeBytes.toString("hex")}00000000000000`;
}

/** A completed model step that ended on one tool call, in the given state. */
function toolStep(turnId: string, id: string, created: number, text: string, status: "running" | "completed"): TranscriptMessage {
  return {
    info: { id, role: "assistant", parentID: turnId, time: { created, completed: created + 1 } },
    parts: [
      { id: `${id}-text`, type: "text", text },
      { id: `${id}-tool`, type: "tool", tool: "bash", callID: `${id}-call`,
        state: { status, input: { command: "ls" }, time: { start: created }, ...(status === "completed" ? { output: "files" } : {}) } },
      { id: `${id}-finish`, type: "step-finish", reason: "tool-calls" },
    ],
  };
}

function assistantMessage(
  turnId: string,
  id: string,
  created: number,
  text: string | null,
  reason: "tool-calls" | "stop" = "stop",
): TranscriptMessage {
  return {
    info: {
      id,
      role: "assistant",
      parentID: turnId,
      time: { created, completed: created + 1 },
    },
    parts: [
      ...(text === null ? [] : [{ id: `${id}-text`, type: "text", text }]),
      { id: `${id}-finish`, type: "step-finish", reason },
    ],
  };
}

/** What OpenCode keeps when a model spends its whole output budget reasoning: no text part. */
function outputLimitedAssistant(turnId: string, id: string, created: number): TranscriptMessage {
  return {
    info: { id, role: "assistant", parentID: turnId, time: { created, completed: created + 1 }, finish: "length" },
    parts: [
      { id: `${id}-start`, type: "step-start" },
      { id: `${id}-reasoning`, type: "reasoning", text: "Reviewing every file in the pull request first." },
      { id: `${id}-finish`, type: "step-finish", reason: "length" },
    ],
  };
}

function assistantWithTool(
  turnId: string,
  id: string,
  created: number,
  toolState: Record<string, unknown>,
  toolCallId = "call-1",
  tool = "bash",
): TranscriptMessage {
  return {
    info: { id, role: "assistant", parentID: turnId, time: { created, completed: created + 1 } },
    parts: [
      { id: `${id}-tool`, type: "tool", tool, callID: toolCallId, state: toolState },
      { id: `${id}-finish`, type: "step-finish", reason: "tool-calls" },
    ],
  };
}

test("Open Model preserves GitHub CLI config discovery while isolating OpenCode child directories", async () => {
  const keys = ["GH_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME", "APPDATA", "GH_TOKEN", "GITHUB_TOKEN"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.HOME = "/tmp/github-user-home";
    delete process.env.APPDATA;
    process.env.GH_TOKEN = "github-token-must-not-be-inherited";
    process.env.GITHUB_TOKEN = "github-token-must-not-be-inherited";
    for (const [explicit, xdg, expected] of [
      ["/tmp/custom-gh", "/tmp/user-config", "/tmp/custom-gh"],
      [null, "/tmp/user-config", "/tmp/user-config/gh"],
      [null, null, "/tmp/github-user-home/.config/gh"],
    ]) {
      if (explicit) process.env.GH_CONFIG_DIR = explicit; else delete process.env.GH_CONFIG_DIR;
      if (xdg) process.env.XDG_CONFIG_HOME = xdg; else delete process.env.XDG_CONFIG_HOME;
      const { harness, runtimeRoot } = await spawnAdapter();
      try {
        const env = harness.launches[0]!.env;
        assert.equal(env.GH_CONFIG_DIR, expected);
        assert.ok(env.XDG_CONFIG_HOME?.startsWith(runtimeRoot));
        assert.notEqual(env.XDG_CONFIG_HOME, xdg);
        assert.equal(env.GH_TOKEN, undefined);
        assert.equal(env.GITHUB_TOKEN, undefined);
      } finally { await rm(runtimeRoot, { recursive: true, force: true }); }
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("Open Model launches a dedicated OpenCode server without putting the provider key in config or MCP", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));

  assert.equal(handle.pid, 6101);
  assert.equal(handle.providerContinuationId, "session-open-model-1");
  assert.deepEqual(observations.map(({ fact }) => fact), [{
    domain: "runtime",
    kind: "state_changed",
    state: "ready",
    sideEffects: "none",
  }], "verified runtime readiness is retained before the first room turn");
  assert.equal(harness.promptBodies.length, 0);
  assert.deepEqual(handle.providerConnection, {
    kind: "opencode_server",
    url: "http://127.0.0.1:43821",
    pid: 6101,
    processIdentity: "opencode-birth-6101",
    serverAuthPath: (handle.providerConnection as { serverAuthPath: string }).serverAuthPath,
  });

  assert.equal(harness.launches.length, 1);
  const launch = harness.launches[0]!;
  assert.equal(launch.binary, "/opt/letagents/opencode");
  assert.deepEqual(launch.args, ["serve", "--hostname", "127.0.0.1", "--port", "43821"]);
  const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
  const auth = JSON.parse(launch.env.OPENCODE_AUTH_CONTENT ?? "{}") as Record<string, unknown>;
  const serializedConfig = JSON.stringify(config);
  const mcpEnvironment = (config.mcp as Record<string, Record<string, unknown>>)
    .letagents.environment as Record<string, string>;

  assert.doesNotMatch(serializedConfig, /provider-api-key-must-stay-out-of-config/);
  assert.match(JSON.stringify(auth), /provider-api-key-must-stay-out-of-config/);
  assert.equal(mcpEnvironment.OPENCODE_AUTH_CONTENT, "");
  assert.equal(mcpEnvironment.OPENCODE_SERVER_PASSWORD, "");
  assert.equal(mcpEnvironment.LETAGENTS_EXECUTION_PROFILE, "supervised_room_turn");
  assert.equal(mcpEnvironment.LETAGENTS_SUPERVISOR_PROVIDER, "open-model");
  assert.equal(mcpEnvironment.LETAGENTS_SUPERVISOR_ENTRY_ID, "supervised-open-model-1");
  assert.deepEqual(config.permission, { "*": "allow" });

  const connection = handle.providerConnection;
  assert.ok(connection?.kind === "opencode_server");
  const serverAuth = await readFile(connection.serverAuthPath, "utf8");
  assert.doesNotMatch(serverAuth, /provider-api-key-must-stay-out-of-config/);
  const serverControl = JSON.parse(serverAuth) as {
    connection?: unknown;
    lifecycleAuthorityMode?: string;
  };
  assert.deepEqual(
    {
      connection: serverControl.connection,
      lifecycleAuthorityMode: serverControl.lifecycleAuthorityMode,
    },
    {
      connection: {
        url: "http://127.0.0.1:43821",
        pid: 6101,
        processIdentity: "opencode-birth-6101",
      },
      lifecycleAuthorityMode: "typed_shadow",
    },
  );
});

test("Open Model launches OpenCode so a denied tool call does not end the turn", async () => {
  const { harness } = await spawnAdapter({
    permissionProfileId: "ask_before_write",
    launchPolicy: { permission: { "*": "allow", edit: "ask", bash: "ask" } },
  });
  const config = JSON.parse(harness.launches[0]!.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
  assert.deepEqual(config.experimental, { continue_loop_on_deny: true });
});

test("Open Model launches ask-before-write with native shell and edit approvals", async () => {
  const { harness } = await spawnAdapter({
    permissionProfileId: "ask_before_write",
    launchPolicy: { permission: { "*": "allow", edit: "ask", bash: "ask" } },
  });
  const config = JSON.parse(harness.launches[0]!.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
  assert.deepEqual(config.permission, { "*": "allow", edit: "ask", bash: "ask" });
});

test("Open Model launches Auto asking as before and with nothing outside the project reachable", async () => {
  const permission = { "*": "allow", edit: "ask", bash: "ask", external_directory: "deny" };
  const { harness } = await spawnAdapter({ permissionProfileId: "auto_review", launchPolicy: { permission } });
  const config = JSON.parse(harness.launches[0]!.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, unknown>;
  assert.deepEqual(config.permission, permission);
  for (const launchPolicy of [{ permission: { "*": "allow", edit: "ask", bash: "ask" } }, { permission: { "*": "allow" } }]) {
    await assert.rejects(spawnAdapter({ permissionProfileId: "auto_review", launchPolicy }), /permission-profile authority/);
  }
});

test("Open Model freezes lifecycle authority across spawn, attach, and resume", async () => {
  const { adapter, handle, harness, runtimeRoot } = await spawnAdapter({ lifecycleAuthorityMode: "typed" });
  const typedHandle = handle as ProviderHandle & { lifecycleAuthorityMode: string };
  const ref = {
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
    lifecycleAuthorityMode: "typed" as const,
  };
  assert.equal(typedHandle.lifecycleAuthorityMode, "typed");
  assert.equal(await adapter.attach(ref), handle);
  assert.equal(await adapter.attach({ ...ref, lifecycleAuthorityMode: "typed_shadow" }), null);
  assert.equal(await adapter.attach({ ...ref, lifecycleAuthorityMode: undefined }), null);
  await assert.rejects(adapter.resume(ref, spawnRequest({ lifecycleAuthorityMode: "typed_shadow" })),
    /does not match the frozen provider birth/);

  const replacement = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });
  assert.equal(await replacement.attach({ ...ref, lifecycleAuthorityMode: "typed_shadow" }), null);
  const attached = await replacement.attach(ref);
  assert.ok(attached && !("state" in attached));
  const attachedObservations: NativeExecutionObservation[] = [];
  replacement.onExecution(attached, (event) => attachedObservations.push(event));
  assert.deepEqual(attachedObservations.map(({ fact }) => fact), [{
    domain: "runtime",
    kind: "state_changed",
    state: "ready",
    sideEffects: "none",
  }]);

  await assert.rejects(adapter.spawn(spawnRequest({
    workAttemptId: "typed-non-daemon",
    lifecycleAuthorityMode: "typed",
    deliveryMode: "desktop_events",
  })), /Typed Open Model lifecycle authority requires daemon-inbox delivery/);
  assert.equal(harness.launches.length, 1);
});

test("a dead Open Model runtime reports terminal evidence even under a mismatched lifecycle authority", async () => {
  const { handle, harness, runtimeRoot } = await spawnAdapter({ lifecycleAuthorityMode: "typed" });
  const ref = {
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
    lifecycleAuthorityMode: "typed" as const,
  };
  const afterDeath = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: { ...harness.dependencies, getProcessIdentity: () => null },
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  // A legacy-frozen birth read back against a typed control file used to
  // return null here, leaving the generation live with no handle forever.
  for (const lifecycleAuthorityMode of ["typed", "typed_shadow", "legacy", undefined] as const) {
    const attached = await afterDeath.attach({ ...ref, lifecycleAuthorityMode } as typeof ref);
    assert.ok(attached && "state" in attached && attached.state === "terminal", String(lifecycleAuthorityMode));
    assert.equal(attached.terminal.providerContinuationId, ref.providerContinuationId);
  }
  assert.equal(harness.launches.length, 1, "death evidence never starts a replacement");
});

test("attach finishes a cached handle whose process died before its exit observer fired", async () => {
  const harness = createHarness();
  let alive = true;
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-adapter-")),
    dependencies: { ...harness.dependencies,
      getProcessIdentity: (pid) => alive ? harness.dependencies.getProcessIdentity(pid) : null },
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  alive = false;

  const attached = await adapter.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
    lifecycleAuthorityMode: "typed_shadow",
  });

  assert.ok(attached && "state" in attached && attached.state === "terminal");
  assert.ok(observations.some(({ fact }) => fact.domain === "runtime" && fact.kind === "state_changed" && fact.state === "exited"),
    "the cached handle's observers learn the runtime exited");
  assert.equal(await adapter.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
    lifecycleAuthorityMode: "typed",
  }).then(value => value && "state" in value ? value.state : "handle"), "terminal", "the dead handle is no longer served from cache");
});

test("resuming a dead runtime under a changed lifecycle authority starts fresh instead of refusing forever", async () => {
  const harness = createHarness();
  let alive = true;
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-adapter-"));
  const dependencies = { ...harness.dependencies,
    getProcessIdentity: (pid: number) => alive ? harness.dependencies.getProcessIdentity(pid) : null };
  const born = new OpenModelProviderAdapter({ binary: "/opt/letagents/opencode", runtimeRoot, dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS, turnTimeoutMs: 100 });
  const handle = await born.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const ref = {
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
    lifecycleAuthorityMode: "typed" as const,
  };
  const afterRestart = new OpenModelProviderAdapter({ binary: "/opt/letagents/opencode", runtimeRoot, dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS, turnTimeoutMs: 100 });

  // Alive: a changed authority is still refused rather than attached.
  await assert.rejects(afterRestart.resume(ref, spawnRequest({ lifecycleAuthorityMode: "typed_shadow" })),
    /does not match the frozen provider birth/);
  alive = false;
  const afterDeath = new OpenModelProviderAdapter({ binary: "/opt/letagents/opencode", runtimeRoot, dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS, turnTimeoutMs: 100 });
  await assert.rejects(afterDeath.resume(ref, spawnRequest({ lifecycleAuthorityMode: "typed_shadow" })),
    (error: unknown) => error instanceof OpenCodeRuntimeGoneError);
  assert.equal(harness.launches.length, 1, "resume itself never launches; the daemon replaces the runtime");
});

test("Open Model reattaches from its exact runtime sidecar when a legacy daemon omitted the connection", async () => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  assert.ok(handle.providerContinuationId);
  const replacement = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  const attached = await replacement.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    providerConnection: null,
  });

  assert.ok(attached && !("state" in attached));
  assert.deepEqual(attached.providerConnection, handle.providerConnection);
  assert.equal(harness.launches.length, 1, "reattachment must not launch another OpenCode server");
});

/*
 * A pre-authority sidecar is an existing durable runtime, not a second lifecycle
 * implementation. Its only safe interpretation is the former default mode.
 */
test("Open Model treats a pre-authority runtime sidecar as typed shadow", async () => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  const connection = handle.providerConnection;
  assert.ok(connection?.kind === "opencode_server");
  const control = JSON.parse(await readFile(connection.serverAuthPath, "utf8")) as Record<string, unknown>;
  delete control.lifecycleAuthorityMode;
  await writeFile(connection.serverAuthPath, `${JSON.stringify(control)}\n`, { mode: 0o600 });
  const replacement = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
  });
  assert.equal(await replacement.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: connection,
    lifecycleAuthorityMode: "typed",
  }), null);
  const attached = await replacement.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: connection,
  });
  assert.ok(attached && !("state" in attached));
});

test("Open Model discovers and checkpoints a pre-sidecar-metadata runtime exactly once", async () => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  assert.ok(handle.providerContinuationId);
  const connection = handle.providerConnection;
  assert.ok(connection?.kind === "opencode_server");
  const legacy = JSON.parse(await readFile(connection.serverAuthPath, "utf8")) as {
    username: string;
    password: string;
  };
  await writeFile(connection.serverAuthPath, `${JSON.stringify({
    username: legacy.username,
    password: legacy.password,
  })}\n`, { mode: 0o600 });
  let discoveries = 0;
  const replacement = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: {
      ...harness.dependencies,
      async discoverRuntimeConnection() {
        discoveries += 1;
        return { pid: 6101, url: "http://127.0.0.1:43821" };
      },
    },
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  const attached = await replacement.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    providerConnection: null,
  });

  assert.ok(attached && !("state" in attached));
  assert.equal(discoveries, 1);
  assert.deepEqual(
    (JSON.parse(await readFile(connection.serverAuthPath, "utf8")) as {
      connection?: unknown;
    }).connection,
    {
      url: "http://127.0.0.1:43821",
      pid: 6101,
      processIdentity: "opencode-birth-6101",
    },
  );
});

test("Open Model runs one bounded OpenCode prompt and returns the exact assistant reply", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const checkpoints: string[] = [];
  const stream: ProviderStreamEvent[] = [];
  const observations: NativeExecutionObservation[] = [];
  adapter.onStream(handle, (event) => stream.push(event));
  adapter.onExecution(handle, (event) => observations.push(event));

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-open-model-1",
    sourceMessage: { id: "message-1", text: "say hi" },
    activation: { decision: "activate", reason: "explicit_mention" },
    actionId: "action-open-model-1",
    observedContext: [{ id: "message-0", text: "Earlier context" }],
  }, {
    beforeNativeDispatch: async () => { checkpoints.push("dispatch"); },
    checkpointTurnStarted: async (turnId) => { checkpoints.push(`turn:${turnId}`); },
    checkpointTerminalResult: async () => { checkpoints.push("terminal"); },
  });

  assert.equal(harness.promptBodies.length, 1);
  const prompt = harness.promptBodies[0]!;
  assert.deepEqual(prompt.model, {
    providerID: "letagents-open-model",
    modelID: "qwen/qwen3-coder",
  });
  assert.match(JSON.stringify(prompt.parts), /daemon-owned room inbox item/);
  assert.match(JSON.stringify(prompt.parts), /chat reply publication does not publish code or create PRs/);
  assert.match(JSON.stringify(prompt.parts), /standing merge approval/);
  assert.match(JSON.stringify(prompt.parts), /GitHub webfetch 404.*gh using its existing authentication/);
  assert.match(JSON.stringify(prompt.parts), /explicit git fetch.*FETCH_HEAD/);
  assert.doesNotMatch(JSON.stringify(prompt.parts), /durable charter/i);
  assert.match(JSON.stringify(prompt.parts), /Earlier context/);
  assert.deepEqual(result, {
    turnId: prompt.messageID,
    outcome: "reply",
    text: "OpenCode bounded reply.",
    evidence: "transcript",
  });
  assert.deepEqual(checkpoints, [
    "dispatch",
    `turn:${String(prompt.messageID)}`,
    "terminal",
  ]);
  assert.ok(stream.some((event) => event.method === "reasoning/summaryTextDelta"));
  assert.ok(stream.some((event) => event.method === "item/agentMessage/delta"));
  const lifecycleFrames = stream.filter((event) => event.lifecycleProjectionOnly);
  assert.deepEqual(lifecycleFrames.map(({ method, nativeLifecyclePhase }) => ({ method, nativeLifecyclePhase })), [
    { method: "turn/started", nativeLifecyclePhase: "turn_active" },
    { method: "turn/completed", nativeLifecyclePhase: "turn_terminal" },
  ]);
  const lifecycleFacts = observations.filter(({ fact }) => fact.domain === "turn");
  assert.deepEqual(lifecycleFrames.map((event) => event.nativeEventId),
    lifecycleFacts.map((event) => event.fact.nativeEventId),
    "typed and legacy shadow witnesses use the same exact native checkpoints");
});

test("Open Model does not mint lifecycle evidence when native prompt dispatch is rejected", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const stream: ProviderStreamEvent[] = [];
  const observations: NativeExecutionObservation[] = [];
  adapter.onStream(handle, (event) => stream.push(event));
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setPromptFailure(new Error("injected prompt rejection"));

  await assert.rejects(
    adapter.runRoomTurn(handle, { inboxItemId: "rejected", sourceMessage: {}, activation: {}, actionId: "rejected" }),
    /injected prompt rejection/,
  );
  assert.equal(stream.some((event) => event.lifecycleProjectionOnly), false);
  assert.equal(observations.some(({ fact }) => fact.domain === "turn"), false);
});

test("Open Model turn ids use OpenCode's ascending scheme so the native loop can exit", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const before = Date.now();

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-native-id",
    sourceMessage: { text: "say hi" },
    activation: { decision: "activate" },
    actionId: "supervised-room:supervised_agent-1:focus_38:msg_15:action:v1",
  });

  const after = Date.now();
  const turnId = String(harness.promptBodies[0]!.messageID);
  assert.equal(result.turnId, turnId);
  assert.match(
    turnId,
    /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    "the user message ID must use OpenCode's native ascending scheme",
  );
  // OpenCode exits its agentic loop only while lastUser.id < lastAssistant.id
  // under raw string comparison. The dispatched ID must therefore sort after
  // everything already in the session and below the assistant IDs OpenCode
  // mints afterwards (its same-millisecond counter starts at 1).
  assert.ok(turnId > openCodeStyleAscendingId(before - 1, 4095));
  assert.ok(turnId < openCodeStyleAscendingId(after, 1));
});

test("Open Model refuses to dispatch into a session poisoned by legacy turn ids", async () => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  const fresh = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });
  const attached = await fresh.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
  });
  assert.ok(attached && !("state" in attached));
  const legacyTurnId = "msg_supervised-room_supervised_agent-1_67453f71";
  harness.setTranscriptFactories([
    () => [
      userMessage(legacyTurnId),
      assistantMessage(legacyTurnId, "assistant-legacy", 10, "Hi EmmyMay!"),
    ],
  ]);
  const checkpoints: string[] = [];

  await assert.rejects(
    fresh.runRoomTurn(attached, {
      inboxItemId: "inbox-poisoned",
      sourceMessage: { text: "say hi again" },
      activation: { decision: "activate" },
      actionId: "poisoned",
    }, {
      beforeNativeDispatch: async () => { checkpoints.push("dispatch"); },
      checkpointTurnStarted: async (turnId) => { checkpoints.push(`turn:${turnId}`); },
    }),
    (error: unknown) => {
      assert.equal(
        (error as { providerFailureCode?: string }).providerFailureCode,
        "provider_continuation_missing",
      );
      assert.equal(
        (error as { providerContinuationId?: string }).providerContinuationId,
        "session-open-model-1",
      );
      return true;
    },
  );
  assert.equal(harness.promptBodies.length, 0, "no model work may start in a poisoned session");
  assert.deepEqual(checkpoints, [], "the failure lands before the dispatch-intent checkpoint");
});

test("Open Model repair replaces a poisoned session instead of rematerializing it", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.setTranscriptFactories([
    () => [userMessage("msg_supervised-room_supervised_agent-1_52a35257")],
  ]);
  const checkpointed: string[] = [];

  const repaired = await adapter.repairContinuation(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "session-open-model-1",
    cwd: "/tmp/open-model-worktree",
    launchPolicy: {},
  }, {
    checkpointReplacement: async (id) => { checkpointed.push(id); },
  });

  assert.equal(repaired.outcome, "replaced");
  assert.equal(repaired.replacementProviderContinuationId, "session-open-model-2");
  assert.deepEqual(checkpointed, ["session-open-model-2"]);
});

test("Open Model surfaces tool calls as neutral tool_lifecycle stream events, deduped by status", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const stream: ProviderStreamEvent[] = [];
  adapter.onStream(handle, (event) => stream.push(event));
  harness.holdTurnOpenWithTranscript();
  // Initial snapshot sees the tool running; a live message.part.updated re-sends
  // the same running part (must dedup); the session.idle snapshot then sees it
  // completed with output plus the final answer.
  harness.setTranscriptFactories([
    (turnId) => [assistantWithTool(turnId, "assistant-tool", 10, { status: "running", input: { command: "ls" } })],
    (turnId) => [
      assistantWithTool(turnId, "assistant-tool", 10, { status: "completed", input: { command: "ls" }, output: "file-a\nfile-b" }),
      assistantMessage(turnId, "assistant-final", 20, "Listed the files."),
    ],
  ]);
  harness.setStreamEvents([
    { type: "message.part.updated", properties: { part: { id: "assistant-tool-tool", messageID: "assistant-tool", type: "tool", tool: "bash", callID: "call-1", state: { status: "running", input: { command: "ls" } } } } },
    { type: "session.idle", properties: { sessionID: "session-open-model-1" } },
  ]);

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-tool",
    sourceMessage: { text: "list files" },
    activation: { decision: "activate" },
    actionId: "tool",
  });
  assert.equal(result.outcome, "reply");

  const toolEvents = stream.filter((event) => event.kind === "tool_lifecycle");
  assert.equal(toolEvents.length, 2, "one event per distinct (callID, status); the repeated running snapshot is deduped");
  for (const event of toolEvents) {
    // Neutral method + non-error kind so the daemon never misreads a tool as
    // a terminal/idle turn boundary.
    assert.equal(event.method, "item/toolCall/updated");
    assert.doesNotMatch(event.method, /completed|finished|idle|stopped|interrupted/);
  }
  const running = toolEvents[0]!.payload as Record<string, unknown>;
  const completed = toolEvents[1]!.payload as Record<string, unknown>;
  assert.deepEqual({ tool: running.tool, callID: running.callID, status: running.status }, { tool: "bash", callID: "call-1", status: "running" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.output, "file-a\nfile-b");
});

test("Open Model announces each provider retry, without provider text or a changed outcome", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const stream: ProviderStreamEvent[] = [];
  adapter.onStream(handle, (event) => stream.push(event));
  harness.holdTurnOpenWithTranscript();
  harness.setTranscriptFactories([
    (turnId) => [{ info: { id: "assistant-retrying", role: "assistant", parentID: turnId, time: { created: 10 } }, parts: [] }],
    (turnId) => [assistantMessage(turnId, "assistant-retrying", 10, "Answer after the retries.")],
  ]);
  const retry = (attempt: number, next: number, message: string, sessionID = "session-open-model-1") => ({
    type: "session.status",
    properties: { sessionID, status: { type: "retry", attempt, message, next } },
  });
  harness.setStreamEvents([
    { type: "session.status", properties: { sessionID: "session-open-model-1", status: { type: "busy" } } },
    retry(1, 1_790_000_002_000, "Rate limit exceeded for key sk-or-v1-0123456789abcdef0123456789abcdef, see https://provider.example/limits"),
    // A repeat of the same scheduled retry, which 1.18.20 does not send, is ignored.
    retry(1, 1_790_000_002_000, "Rate limit exceeded"),
    retry(2, 1_790_000_006_000, "Rate limit exceeded"),
    // Another session's retry is not this agent's.
    retry(3, 1_790_000_014_000, "Rate limit exceeded", "session-of-another-agent"),
    // A later step of the same turn fails and its attempts start again.
    retry(1, 1_790_000_030_000, "Overloaded"),
    { type: "session.status", properties: { sessionID: "session-open-model-1", status: { type: "retry", attempt: "2", message: "x", next: 1 } } },
    { type: "session.idle", properties: { sessionID: "session-open-model-1" } },
  ]);

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-retry-notice",
    sourceMessage: { text: "hello" },
    activation: { decision: "activate" },
    actionId: "retry-notice",
  });

  assert.equal(result.outcome, "reply", "a retry notice never changes how the turn ends");
  assert.equal(result.text, "Answer after the retries.");
  const notices = stream.filter((event) => event.method === OPEN_MODEL_PROVIDER_RETRY_METHOD);
  assert.deepEqual(notices.map((event) => event.summary), [
    "The model provider returned an error. Retrying (attempt 1).",
    "The model provider returned an error. Retrying (attempt 2).",
    "The model provider returned an error. Retrying (attempt 1).",
  ]);
  for (const notice of notices) {
    // The daemon reads a provider_event under a neutral method as ordinary work.
    assert.equal(notice.kind, "provider_event");
    assert.doesNotMatch(notice.method, /^(?:result|turn|thread|item)(?:\/|$)/i);
    assert.doesNotMatch(notice.method, /(?:failed|systemError|error_during_execution|completed|finished|idle|stopped|interrupted)$/i);
    assert.equal(notice.nativeEventId, undefined);
    assert.equal(notice.nativeLifecyclePhase, undefined);
    assert.equal(notice.lifecycleProjectionOnly, undefined);
    const payload = notice.payload as Record<string, unknown>;
    for (const operationalKey of ["status", "subtype", "threadStatus", "turnStatus", "turn", "thread", "item"]) {
      assert.equal(operationalKey in payload, false, `${operationalKey} would be read as lifecycle state`);
    }
  }
  const first = notices[0]!.payload as Record<string, unknown>;
  assert.equal(first.attempt, 1);
  assert.equal(first.nextRetryAt, new Date(1_790_000_002_000).toISOString());
  assert.doesNotMatch(JSON.stringify(notices), /sk-or-v1-0123456789abcdef/, "the provider key is redacted everywhere");
  assert.equal(notices[0]!.payloadRedacted, true, "a redacted payload says so");
  assert.equal(notices[1]!.payloadRedacted, false);
  assert.doesNotMatch(JSON.stringify(notices), /provider\.example/, "provider links are not passed on");
  assert.match(String(first.message), /^Rate limit exceeded for key /);
});

test("Open Model waits for the session boundary and selects the final answer after tool-call children", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.holdTurnOpenWithTranscript();
  harness.setTranscriptFactories([
    (turnId) => [assistantMessage(turnId, "assistant-tool", 10, null, "tool-calls")],
    (turnId) => [
      assistantMessage(turnId, "assistant-tool", 10, null, "tool-calls"),
      assistantMessage(turnId, "assistant-final", 20, "Hi from the final assistant step."),
    ],
  ]);
  harness.setStreamEvents([{
    type: "session.idle",
    properties: { sessionID: "session-open-model-1" },
  }]);

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-tool-first",
    sourceMessage: { text: "say hi" },
    activation: { decision: "activate" },
    actionId: "tool-first",
  });

  assert.equal(result.outcome, "reply");
  assert.equal(result.text, "Hi from the final assistant step.");
  assert.equal(harness.messageReads, 2, "the completed tool child is not a room-turn terminal");
});

test("Open Model does not mistake prompt materialization lag for an empty completed turn", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.setTranscriptFactories([
    () => [],
    (turnId) => [assistantMessage(turnId, "assistant-final", 20, "Materialized reply.")],
  ]);
  harness.setStreamEvents([{
    type: "session.idle",
    properties: { sessionID: "session-open-model-1" },
  }]);

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-materializing",
    sourceMessage: { text: "say hi" },
    activation: { decision: "activate" },
    actionId: "materializing",
  });

  assert.equal(result.outcome, "reply");
  assert.equal(result.text, "Materialized reply.");
  assert.equal(harness.messageReads, 2);
});

test("Open Model classifies the exact no-reply sentinel and a finished empty answer without rerunning", async () => {
  const sentinel = await spawnAdapter();
  sentinel.harness.setAssistantText("LETAGENTS_NO_ROOM_REPLY");
  const noReply = await sentinel.adapter.runRoomTurn(sentinel.handle, {
    inboxItemId: "inbox-no-reply",
    sourceMessage: { text: "observe only" },
    activation: { decision: "activate" },
    actionId: "no-reply",
  });
  assert.equal(noReply.outcome, "no_reply");
  assert.equal(sentinel.harness.promptBodies.length, 1);

  const empty = await spawnAdapter();
  empty.harness.omitAssistantText();
  const missingText = await empty.adapter.runRoomTurn(empty.handle, {
    inboxItemId: "inbox-empty",
    sourceMessage: { text: "reply" },
    activation: { decision: "activate" },
    actionId: "empty",
  });
  assert.deepEqual(missingText, {
    turnId: String(empty.harness.promptBodies[0]?.messageID),
    providerContinuationId: empty.handle.providerContinuationId,
    outcome: "failed",
    text: null,
    evidence: "transcript",
    error: NO_REPLY_FAILURE.emptyAnswer,
  });
  assert.equal(empty.harness.promptBodies.length, 1);
});

test("Open Model settles a turn that hit its output limit before writing text, and a re-read agrees", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  const checkpointed: ProviderRoomTurnResult[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setTranscriptFactories([(turnId) => [outputLimitedAssistant(turnId, "assistant-length", 10)]]);

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-output-limit",
    sourceMessage: { text: "review the pull request" },
    activation: { decision: "activate" },
    actionId: "output-limit",
  }, { checkpointTerminalResult: async (terminal) => { checkpointed.push(terminal); } });

  const turnId = String(harness.promptBodies[0]?.messageID);
  const settled = {
    turnId,
    providerContinuationId: handle.providerContinuationId,
    outcome: "failed",
    text: null,
    evidence: "transcript",
    error: NO_REPLY_FAILURE.outputLimit,
  };
  assert.deepEqual(result, settled);
  assert.deepEqual(checkpointed, [settled], "the exact terminal is checkpointed before the adapter returns");
  assert.ok(observations.some(({ fact }) => fact.domain === "turn" && fact.state === "terminal"
    && fact.providerTurnId === turnId && fact.turnOutcome === "failed"));

  // Retry delivery re-reads the same completed turn. It must reach the same
  // settled answer, not "unreadable", and never prompt the model again.
  const reread = await adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-output-limit", providerTurnId: turnId });
  assert.deepEqual(reread, settled);
  assert.equal(harness.promptBodies.length, 1);
});

test("Open Model does not settle an earlier empty step while the turn's last step is unfinished", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.setTranscriptFactories([(turnId) => [
    outputLimitedAssistant(turnId, "assistant-length", 10),
    { info: { id: "assistant-next", role: "assistant", parentID: turnId, time: { created: 20 } }, parts: [] },
  ]]);

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-unfinished",
    sourceMessage: { text: "review the pull request" },
    activation: { decision: "activate" },
    actionId: "unfinished",
  });

  assert.deepEqual(result, {
    turnId: String(harness.promptBodies[0]?.messageID),
    outcome: "unreadable",
    text: null,
    evidence: "none",
  });
});

test("Open Model reads the answer a turn gives after OpenCode compacts it, without streaming the summary", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const streamed: ProviderStreamEvent[] = [];
  adapter.onStream(handle, (event) => streamed.push(event));
  harness.setTranscriptFactories([(turnId) => compactedTurnTranscript(turnId, {
    after: [assistantMessage("msg_continue", "msg_after", 40, "Answer written after the compaction.")],
  })]);

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-compacted",
    sourceMessage: { text: "wire the reviewed modules" },
    activation: { decision: "activate" },
    actionId: "compacted",
  });

  assert.deepEqual(result, { turnId: String(harness.promptBodies[0]?.messageID), outcome: "reply",
    text: "Answer written after the compaction.", evidence: "transcript" });
  assert.equal(harness.promptBodies.length, 1);
  assert.doesNotMatch(JSON.stringify(streamed), /PRIVATE-COMPACTION-SUMMARY/, "the summary is OpenCode's record, not the agent's words");
  assert.match(JSON.stringify(streamed), /Answer written after the compaction/);

  // With no answer after the compaction, the summary is still not the reply.
  const unanswered = await spawnAdapter();
  unanswered.harness.setTranscriptFactories([(turnId) => compactedTurnTranscript(turnId, {
    after: [assistantWithTool("msg_continue", "msg_denied", 40, { status: "error", input: { filePath: "src/app.mjs" },
      error: "The user rejected permission to use this specific tool call." }, "call_denied", "write")],
  })]);
  const settled = await unanswered.adapter.runRoomTurn(unanswered.handle, {
    inboxItemId: "inbox-compacted-denied",
    sourceMessage: { text: "wire the reviewed modules" },
    activation: { decision: "activate" },
    actionId: "compacted-denied",
  });
  assert.equal(settled.outcome, "failed");
  assert.equal(settled.error, NO_REPLY_FAILURE.deniedTool);
});

test("Open Model follows a turn's steps live across an OpenCode compaction", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const session = handle.providerContinuationId!;
  const toolEvents: Array<Record<string, unknown>> = [];
  const streamed: ProviderStreamEvent[] = [];
  let afterCompletedLive!: () => void;
  const afterCompleted = new Promise<void>((resolve) => { afterCompletedLive = resolve; });
  adapter.onStream(handle, (event) => {
    streamed.push(event);
    if (event.kind !== "tool_lifecycle") return;
    const payload = event.payload as Record<string, unknown>;
    toolEvents.push(payload);
    if (payload.callID === "call_after" && payload.status === "completed") afterCompletedLive();
  });
  const afterStep = (status: "running" | "completed") => assistantWithTool("msg_continue", "msg_after", 40,
    { status, input: { filePath: "src/app.mjs" }, ...(status === "completed" ? { output: "written" } : {}) }, "call_after", "write");
  harness.holdTurnOpenWithTranscript();
  harness.setTranscriptFactories([
    (turnId) => compactedTurnTranscript(turnId).slice(0, 2),
    (turnId) => compactedTurnTranscript(turnId, { after: [afterStep("running")] }),
    (turnId) => compactedTurnTranscript(turnId, { after: [afterStep("completed"),
      assistantMessage("msg_continue", "msg_final", 50, "Rewired after the compaction.")] }),
  ]);
  const initialRead = harness.nextMessageRead();
  const turn = adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-compacting",
    sourceMessage: { text: "wire the reviewed modules" },
    activation: { decision: "activate" },
    actionId: "compacting",
  });
  await initialRead;
  // The summary step streams while OpenCode compacts; none of it is the agent's.
  harness.sendEvent({ type: "message.updated", properties: { sessionID: session, info: { id: "msg_summary", role: "assistant",
    parentID: "msg_compaction", summary: true, mode: "compaction", sessionID: session, time: { created: 21 } } } });
  harness.sendEvent({ type: "message.part.updated", properties: { sessionID: session, part: {
    id: "msg_summary-live", messageID: "msg_summary", sessionID: session, type: "text", text: "PRIVATE-LIVE-SUMMARY" } } });
  harness.sendEvent({ type: "message.part.delta", properties: { sessionID: session, messageID: "msg_summary",
    partID: "msg_summary-live", field: "text", delta: "PRIVATE-LIVE-DELTA" } });
  // A step that answers OpenCode's own "continue" message, then its tool finishing.
  harness.sendEvent({ type: "message.updated", properties: { sessionID: session,
    info: { id: "msg_after", role: "assistant", parentID: "msg_continue", sessionID: session, time: { created: 40 } } } });
  harness.sendEvent({ type: "message.part.updated", properties: { sessionID: session, part: {
    id: "msg_after-tool", messageID: "msg_after", sessionID: session, type: "tool", tool: "write", callID: "call_after",
    state: { status: "completed", input: { filePath: "src/app.mjs" }, output: "written" } } } });
  let timer: NodeJS.Timeout | undefined;
  const live = await Promise.race([afterCompleted.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2_000); })]);
  clearTimeout(timer);
  harness.completeTurn();
  const result = await turn;

  assert.equal(live, true, "the step after the compaction is followed while the turn runs");
  assert.doesNotMatch(JSON.stringify(streamed), /PRIVATE-(LIVE|COMPACTION)-/, "no part of the summary is streamed as the agent's words");
  assert.deepEqual(toolEvents.filter((event) => event.callID === "call_after").map((event) => event.status), ["running", "completed"]);
  assert.equal(result.outcome, "reply");
  assert.equal(result.text, "Rewired after the compaction.");
});

type ToolOutcome = "denied" | "ran";

function toolPart(messageId: string, callId: string, outcome: ToolOutcome, session?: string): Record<string, unknown> {
  return { id: `${callId}-part`, messageID: messageId, ...(session ? { sessionID: session } : {}), type: "tool", tool: "bash", callID: callId,
    state: outcome === "denied"
      ? { status: "error", input: { command: "gh pr view 4" }, error: "The user rejected permission to use this specific tool call." }
      : { status: "completed", input: { command: "git status" }, output: "clean", metadata: { exit: 0 } } };
}

/** One model step of a turn: its tool calls finish in order, then the step ends. */
function stepEvents(session: string, turnId: string, step: number, calls: readonly ToolOutcome[]): Array<Record<string, unknown>> {
  const id = `assistant-step-${step}`;
  const info = { id, role: "assistant", parentID: turnId, sessionID: session, time: { created: 10 + step } };
  return [
    { type: "message.updated", properties: { sessionID: session, info } },
    ...calls.map((outcome, call) => ({ type: "message.part.updated",
      properties: { sessionID: session, part: toolPart(id, `call-${step}-${call}`, outcome, session) } })),
    { type: "message.updated", properties: { sessionID: session, info: { ...info, time: { created: 10 + step, completed: 10 + step } } } },
  ];
}

/** The same step as the transcript keeps it. */
function stepMessage(turnId: string, step: number, calls: readonly ToolOutcome[]): TranscriptMessage {
  const id = `assistant-step-${step}`;
  return { info: { id, role: "assistant", parentID: turnId, time: { created: 10 + step, completed: 10 + step } },
    parts: [...calls.map((outcome, call) => toolPart(id, `call-${step}-${call}`, outcome)),
      { id: `${id}-finish`, type: "step-finish", reason: "tool-calls" }] };
}

/** Runs a held-open turn through `steps`, then ends it unless the adapter already did. */
async function runSteps(steps: ReadonlyArray<readonly ToolOutcome[]>) {
  const harness = createHarness();
  // Long enough that only the denial bound, or the test, ends the turn.
  const adapter = new OpenModelProviderAdapter({ binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-denials-")), dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS, turnTimeoutMs: 10_000 });
  const handle = await adapter.spawn(spawnRequest());
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.holdTurnOpenWithTranscript();
  harness.setTranscriptFactories([() => [], (turnId) => [...steps.map((calls, step) => stepMessage(turnId, step, calls)),
    assistantMessage(turnId, "assistant-final", 90, "Answered without the denied calls.")]]);
  const initialRead = harness.nextMessageRead();
  const turn = adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-denials",
    sourceMessage: { text: "check the pull request" },
    activation: { decision: "activate" },
    actionId: "denials",
  });
  await initialRead;
  const turnId = String(harness.promptBodies[0]?.messageID);
  steps.forEach((calls, step) => { for (const event of stepEvents(handle.providerContinuationId!, turnId, step, calls)) harness.sendEvent(event); });
  let timer: NodeJS.Timeout | undefined;
  const endedByAdapter = await Promise.race([turn.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 300); })]);
  clearTimeout(timer);
  if (!endedByAdapter) harness.completeTurn();
  return { adapter, handle, harness, observations, turnId, endedByAdapter, result: await turn };
}

test("Open Model ends a turn whose model keeps retrying denied tool calls, three steps in a row", async () => {
  const { adapter, handle, harness, observations, turnId, endedByAdapter, result } = await runSteps([["denied"], ["denied", "denied"], ["denied"]]);
  const settled = { turnId, providerContinuationId: handle.providerContinuationId, outcome: "failed", text: null,
    evidence: "transcript", error: NO_REPLY_FAILURE.deniedTool };
  assert.equal(endedByAdapter, true);
  assert.deepEqual(harness.aborts, [handle.providerContinuationId]);
  assert.deepEqual(result, settled);
  assert.ok(observations.some(({ fact }) => fact.domain === "turn" && fact.state === "terminal"
    && fact.providerTurnId === turnId && fact.turnOutcome === "failed"));

  // A re-read finds the three denied steps and the step the abort ended.
  harness.setTranscriptFactories([(id) => [stepMessage(id, 0, ["denied"]), stepMessage(id, 1, ["denied", "denied"]), stepMessage(id, 2, ["denied"]),
    { info: { id: "assistant-step-3", role: "assistant", parentID: id, time: { created: 13, completed: 14 },
      error: { name: "MessageAbortedError", data: { message: "Aborted" } } }, parts: [] }]]);
  assert.deepEqual(await adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-denials", providerTurnId: turnId }), settled,
    "the re-read reports the denials, not the abort that ended the turn");
});

test("Open Model treats one step's parallel denials as one refusal", async () => {
  // One Deny rejects every request pending in the session.
  const { harness, endedByAdapter, result } = await runSteps([["denied", "denied", "denied"], ["denied", "denied"]]);
  assert.equal(endedByAdapter, false);
  assert.deepEqual(harness.aborts, []);
  assert.equal(result.text, "Answered without the denied calls.");
});

test("Open Model lets a turn go on when a step runs a tool among its denied calls", async () => {
  const { harness, endedByAdapter, result } = await runSteps([["denied"], ["denied"], ["denied", "ran"], ["denied"], ["denied"]]);
  assert.equal(endedByAdapter, false);
  assert.deepEqual(harness.aborts, []);
  assert.equal(result.text, "Answered without the denied calls.");
});

test("Open Model recovering a turn does not stop a model writing its answer after denied steps", async () => {
  const harness = createHarness();
  const adapter = new OpenModelProviderAdapter({ binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-answering-")), dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS, turnTimeoutMs: 10_000 });
  const handle = await adapter.spawn(spawnRequest());
  const denied = (turnId: string) => [stepMessage(turnId, 0, ["denied"]), stepMessage(turnId, 1, ["denied"]), stepMessage(turnId, 2, ["denied"])];
  harness.holdTurnOpenWithTranscript();
  harness.setTranscriptFactories([
    (turnId) => [...denied(turnId), { info: { id: "assistant-answer", role: "assistant", parentID: turnId, time: { created: 20 } },
      parts: [{ id: "answer-text", type: "text", text: "Answering without the pull request check" }] }],
    (turnId) => [...denied(turnId), assistantMessage(turnId, "assistant-answer", 20, "Answering without the pull request check.")],
  ]);
  const read = harness.nextMessageRead();
  const turn = adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-answering", providerTurnId: "turn-recovery" });
  await read;
  await new Promise((resolve) => setTimeout(resolve, 100));
  harness.completeTurn();
  const result = await turn;
  assert.deepEqual(harness.aborts, []);
  assert.equal(result.text, "Answering without the pull request check.");
});

test("Open Model settles a turn that stopped on a denied tool call", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  const checkpointed: ProviderRoomTurnResult[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setTranscriptFactories([(turnId) => [assistantWithTool(turnId, "assistant-denied", 10, {
    status: "error", input: { command: "gh pr view 4" }, error: "The user rejected permission to use this specific tool call.",
  })]]);

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-denied",
    sourceMessage: { text: "check the pull request" },
    activation: { decision: "activate" },
    actionId: "denied",
  }, { checkpointTerminalResult: async (terminal) => { checkpointed.push(terminal); } });

  const turnId = String(harness.promptBodies[0]?.messageID);
  const settled = { turnId, providerContinuationId: handle.providerContinuationId, outcome: "failed", text: null,
    evidence: "transcript", error: NO_REPLY_FAILURE.deniedTool };
  assert.deepEqual(result, settled);
  assert.deepEqual(checkpointed, [settled]);
  assert.ok(observations.some(({ fact }) => fact.domain === "turn" && fact.state === "terminal"
    && fact.providerTurnId === turnId && fact.turnOutcome === "failed"));
  assert.deepEqual(await adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-denied", providerTurnId: turnId }), settled,
    "a re-read reaches the same settled answer");
  assert.equal(harness.promptBodies.length, 1);

  // A tool that failed on its own is not a denial; that turn stays unreadable as before.
  const failed = await spawnAdapter();
  failed.harness.setTranscriptFactories([(id) => [assistantWithTool(id, "assistant-failed", 10, {
    status: "error", input: { command: "npm test" }, error: "Command exited with code 1",
  })]]);
  assert.equal((await failed.adapter.runRoomTurn(failed.handle, { inboxItemId: "inbox-failed-tool",
    sourceMessage: { text: "run tests" }, activation: { decision: "activate" }, actionId: "failed-tool" })).outcome, "unreadable");
});

for (const ending of ["output limit", "denied tool call"] as const) test(`an Open Model turn that ended on its ${ending} settles its room message and the next one is delivered`, async () => {
  const { SupervisedAgentDelivery } = await import(new URL("../../daemon/supervised-agent-delivery.ts", import.meta.url).href);
  const { SupervisedAgentInboxStore } = await import(new URL("../../daemon/supervised-agent-inbox-store.ts", import.meta.url).href);
  const { ProviderActionPortRouter } = await import(new URL("../../daemon/provider-action-port-router.ts", import.meta.url).href);
  const harness = createHarness();
  const root = await mkdtemp(join(tmpdir(), "letagents-open-model-delivery-"));
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: join(root, "runtime"),
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });
  const router = new ProviderActionPortRouter({ "open-model": async () => adapter });
  const handle = await router.spawn({ provider: "open-model", ...spawnRequest() });
  // The first room message gets the ending seen in the field; the second gets
  // an ordinary reply.
  harness.setTranscriptFactories([(turnId) => harness.promptBodies.length === 1
    ? [ending === "output limit" ? outputLimitedAssistant(turnId, "assistant-length", 10)
      : assistantWithTool(turnId, "assistant-denied", 10, { status: "error", input: { command: "gh pr view 4" },
        error: "The user rejected permission to use this specific tool call." })]
    : [assistantMessage(turnId, "assistant-reply", 20, "Second message answered.")]]);
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const published: string[] = [];
  let recoveries = 0;
  const recoverRoomTurn = adapter.recoverRoomTurn.bind(adapter);
  adapter.recoverRoomTurn = async (...args) => { recoveries += 1; return recoverRoomTurn(...args); };
  const delivery = new SupervisedAgentDelivery(store, router, {
    poll: async () => ({}),
    publish: async (input: { roomId: string; text: string }) => {
      published.push(input.text);
      return { messageId: `reply-${published.length}`, roomId: input.roomId };
    },
  }, async () => true);
  const agent = {
    agentId: "open-model-agent", roomId: "room", provider: "open-model", deliveryMode: "daemon_inbox" as const,
    apiUrl: "https://letagents.test", agentSessionId: "worker-session", bearer: "memory",
    executionGenerationId: "generation-1", daemonGeneration: 1, handle,
    workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId,
    providerConnection: handle.providerConnection,
  };
  try {
    await delivery.pump(agent);
    for (const id of ["1", "2"]) {
      await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: id,
        messages: [{ source_message_id: id, source_message: { id }, activation: {} }] });
    }
    await delivery.pump(agent);

    const receipts = await store.receipts(agent.agentId);
    assert.deepEqual(receipts.map((item: { state: string }) => item.state), ["acknowledged_failed", "acknowledged"]);
    assert.equal(receipts[0].last_error, ending === "output limit" ? NO_REPLY_FAILURE.outputLimit : NO_REPLY_FAILURE.deniedTool);
    assert.equal(receipts[0].attempt_count, 1);
    assert.equal(receipts[0].timeline.some((event: { phase: string }) => ["result_unreadable", "blocked"].includes(event.phase)), false);
    assert.deepEqual(published, ["Second message answered."]);
    assert.equal(harness.promptBodies.length, 2, "each room message reached the model exactly once");
    assert.equal(recoveries, 0, "a settled answer is never re-read");
  } finally {
    await delivery.fenceAndDrain();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Open Model checkpoints an exact terminal provider rejection before surfacing it", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  let checkpointed: ProviderRoomTurnResult | null = null;
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setTranscriptFactories([
    (turnId) => [{
      info: {
        id: "assistant-provider-error",
        role: "assistant",
        parentID: turnId,
        time: { created: 10, completed: 11 },
        error: {
          name: "APIError",
          data: {
            statusCode: 402,
            message: "This request requires more credits. Visit https://provider.invalid/key/secret-id.",
          },
        },
      },
      parts: [],
    }],
  ]);

  await assert.rejects(
    adapter.runRoomTurn(handle, {
      inboxItemId: "inbox-provider-error",
      sourceMessage: { text: "say hi" },
      activation: { decision: "activate" },
      actionId: "provider-error",
    }, {
      checkpointTerminalResult: async (result) => { checkpointed = result; },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /provider account could not cover this turn's output budget \(HTTP 402\)/);
      assert.doesNotMatch(error.message, /secret-id|provider\.invalid/);
      assert.equal(
        (error as Error & { roomTurnRecoveryOutcome?: string }).roomTurnRecoveryOutcome,
        "terminal_failure",
      );
      return true;
    },
  );
  const turnId = String(harness.promptBodies[0]?.messageID);
  assert.deepEqual(checkpointed, {
    turnId,
    providerContinuationId: handle.providerContinuationId,
    outcome: "failed",
    text: null,
    evidence: "transcript",
    error: "Open Model request was rejected because the model provider account could not cover this turn's output budget (HTTP 402). Add provider credit or choose another model, then retry the unfinished work in LetAgents.",
  });
  const terminal = observations.find(({ fact }) =>
    fact.domain === "turn" && fact.kind === "state_changed" && fact.state === "terminal");
  assert.ok(terminal?.fact.domain === "turn");
  assert.equal(terminal.fact.sideEffects, "none");
  assert.equal(terminal.fact.providerTurnId, turnId);
  assert.equal(terminal.fact.providerContinuationId, handle.providerContinuationId);
  assert.equal(harness.promptBodies.length, 1);
});

test("Open Model preserves safe 403 explanations in terminal checkpoints without blaming the API key", async () => {
  const cases = [
    {
      message: "This model requires you to complete the following before use: 18+ age confirmation. Confirm at https://openrouter.ai/settings/preferences.",
      expected: /18\+ age confirmation\. Confirm at provider settings/,
    },
    { message: "Your organization does not have access to this model.", expected: /organization does not have access/ },
    { message: "  \n  ", expected: /Check the provider's account requirements and model permissions/ },
    { message: undefined, expected: /Check the provider's account requirements and model permissions/ },
    {
      message: `Permission denied. api_key=private-credential-value Authorization: Bearer private-bearer-value https://provider.invalid/secret-link ${"extra ".repeat(100)}`,
      expected: /Permission denied.*\[REDACTED\]/,
    },
  ];
  for (const { message, expected } of cases) {
    const { adapter, handle, harness } = await spawnAdapter();
    let checkpointed: ProviderRoomTurnResult | null = null;
    harness.setTranscriptFactories([(turnId) => [{
      info: { id: "assistant-forbidden", role: "assistant", parentID: turnId,
        time: { created: 10, completed: 11 },
        error: { name: "APIError", data: { statusCode: 403, message } } },
      parts: [],
    }]]);
    await assert.rejects(adapter.runRoomTurn(handle, {
      inboxItemId: "inbox-forbidden", sourceMessage: { text: "hi" },
      activation: { decision: "activate" }, actionId: "forbidden",
    }, { checkpointTerminalResult: async (result) => { checkpointed = result; } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /access was denied by the provider \(HTTP 403\)/);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /Check the API key|private-credential|private-bearer|secret-link|https?:\/\//);
      assert.ok(error.message.length < 400, "provider detail is bounded");
      assert.equal((checkpointed as ProviderRoomTurnResult & { error: string })?.error, error.message);
      assert.equal((error as Error & { roomTurnRecoveryOutcome: string }).roomTurnRecoveryOutcome, "terminal_failure");
      return true;
    });
    assert.equal(harness.promptBodies.length, 1, "a forbidden turn is not replayed");
  }
});

test("a fresh adapter reattaches to the exact OpenCode PID and session", async () => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  const fresh = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  const attached = await fresh.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
  });

  assert.ok(attached && !("state" in attached));
  assert.equal(attached.pid, handle.pid);
  assert.equal(attached.providerContinuationId, handle.providerContinuationId);
  assert.deepEqual(attached.providerConnection, handle.providerConnection);
  assert.equal(harness.launches.length, 1, "reattachment never launches another OpenCode server");
});

test("Open Model refuses to launch without an exact in-memory endpoint credential", async () => {
  const harness = createHarness();
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-no-credential-")),
    dependencies: harness.dependencies,
  });

  await assert.rejects(
    adapter.spawn(spawnRequest({ providerCredential: undefined })),
    /waiting for its desktop-held endpoint credential/,
  );
  assert.equal(harness.launches.length, 0);
});

test("Open Model refuses a fresh spawn without exact supervisor coordinates", async () => {
  const harness = createHarness();
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-no-session-")),
    dependencies: harness.dependencies,
  });

  await assert.rejects(
    adapter.spawn(spawnRequest({ supervisorWorkerSession: undefined })),
    /missing LETAGENTS_SUPERVISOR_AGENT_SESSION_ID/,
  );
  assert.equal(harness.launches.length, 0);
});

test("Open Model interrupts the exact active session through the native abort endpoint", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.holdTurnOpen();
  (handle as unknown as { activeRoomTurnId: string | null }).activeRoomTurnId = "turn-active";
  let dispatchMarked = false;
  let checkpointedTurnId: string | null = null;

  const result = await adapter.controlTurn(handle, null, {
    targetTurnId: "turn-active",
    checkpointTurnStarted: async (turnId) => { checkpointedTurnId = turnId; },
    markDispatched: async () => { dispatchMarked = true; },
  });

  assert.deepEqual(result, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
  assert.equal(checkpointedTurnId, "turn-active");
  assert.equal(dispatchMarked, true);
  assert.deepEqual(harness.aborts, ["session-open-model-1"]);
});

test("Open Model interrupts a session that is waiting to retry a failed model request", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.holdTurnInRetry();
  (handle as unknown as { activeRoomTurnId: string | null }).activeRoomTurnId = "turn-active";

  const result = await adapter.controlTurn(handle, null, { targetTurnId: "turn-active" });

  assert.deepEqual(result, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
  assert.deepEqual(harness.aborts, ["session-open-model-1"], "a retrying turn is still running and must be aborted");
});

test("Open Model keeps observing a recovered turn that is waiting to retry", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.holdTurnInRetry();
  // The assistant message exists from the first attempt but has no answer yet.
  harness.setTranscriptFactories([
    (turnId) => [{ info: { id: "assistant-retrying", role: "assistant", parentID: turnId, time: { created: 10 } }, parts: [] }],
    (turnId) => [assistantMessage(turnId, "assistant-retrying", 10, "Answer after the retry.")],
  ]);
  let settled = false;
  const firstSnapshot = harness.nextMessageRead();
  const recovered = adapter.recoverRoomTurn(handle, {
    inboxItemId: "inbox-recovery",
    providerTurnId: "turn-recovery",
  }).finally(() => { settled = true; });

  // The boundary decision follows the first transcript snapshot and one
  // status read; let both finish before looking.
  await firstSnapshot;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(harness.statusReads >= 1, "the adapter consulted the session status");
  assert.equal(settled, false, "a retrying turn is not a turn boundary");

  harness.completeTurn();
  const result = await recovered;
  assert.equal(result.outcome, "reply");
  assert.equal(result.text, "Answer after the retry.");
});

test("Open Model verifies a Stop only once a retrying session is idle", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.holdTurnInRetry();
  harness.holdStatusAfterAbort(3);
  (handle as unknown as { activeRoomTurnId: string | null }).activeRoomTurnId = "turn-active";
  const readsBeforeStop = harness.statusReads;

  // The adapter's wait between status reads does not hold the event loop open.
  const keepAlive = setInterval(() => undefined, 25);
  const result = await adapter.controlTurn(handle, null, { targetTurnId: "turn-active" })
    .finally(() => clearInterval(keepAlive));

  assert.equal(result.interrupted, true);
  // Two reads precede the abort; the three held reads and the idle read follow it.
  assert.ok(
    harness.statusReads - readsBeforeStop >= 6,
    `the abort is not verified while the session still reports retry (${harness.statusReads - readsBeforeStop} reads)`,
  );
});

test("Open Model settles a turn stopped during a retry as unreadable, not as a provider failure", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.holdTurnInRetry();
  // OpenCode completes the assistant message without an error or any parts
  // when the interrupt lands in a retry backoff, and emits only session.idle.
  harness.setTranscriptFactories([
    (turnId) => [{ info: { id: "assistant-retrying", role: "assistant", parentID: turnId, time: { created: 10 } }, parts: [] }],
    (turnId) => [{ info: { id: "assistant-retrying", role: "assistant", parentID: turnId, time: { created: 10, completed: 11 } }, parts: [] }],
  ]);
  let turnId: string | null = null;
  const firstSnapshot = harness.nextMessageRead();
  const turn = adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-stop-during-retry",
    sourceMessage: { text: "hello" },
    activation: { kind: "mention" },
    actionId: "action-stop-during-retry",
  }, { checkpointTurnStarted: async (id) => { turnId = id; } });
  await firstSnapshot;

  const keepAlive = setInterval(() => undefined, 25);
  try {
    const stopped = await adapter.controlTurn(handle, null, { targetTurnId: turnId! });
    harness.completeTurn();

    assert.equal(stopped.interrupted, true);
    assert.deepEqual(harness.aborts, ["session-open-model-1"]);
    assert.deepEqual(await turn, { turnId, outcome: "unreadable", text: null, evidence: "none" });
  } finally {
    clearInterval(keepAlive);
  }
});

test("OpenCode session status reads every listed session as an active turn", async () => {
  const statusFor = (listed: unknown): Promise<string> => new OpenCodeServerClient(
    "http://127.0.0.1:43821",
    { username: "opencode", password: "secret" },
    async () => json(listed),
  ).status("session-open-model-1");

  assert.equal(await statusFor({ "session-open-model-1": { type: "busy" } }), "busy");
  assert.equal(await statusFor({ "session-open-model-1": { type: "retry", attempt: 1, message: "x", next: 1 } }), "busy");
  assert.equal(await statusFor({ "session-open-model-1": { type: "a-future-active-state" } }), "busy");
  assert.equal(await statusFor({ "session-open-model-1": {} }), "busy");
  assert.equal(await statusFor({ "session-open-model-1": "busy" }), "busy");
  assert.equal(await statusFor({ "session-open-model-1": null }), "idle");
  assert.equal(await statusFor({ "session-open-model-1": { type: "idle" } }), "idle");
  assert.equal(await statusFor({ "another-session": { type: "busy" } }), "idle");
  assert.equal(await statusFor({}), "idle");
});

test("Open Model reports a completed child as active while the native session is still busy", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.holdTurnOpenWithTranscript();
  harness.setTranscriptFactories([
    () => [assistantMessage("turn-active", "assistant-tool", 10, null, "tool-calls")],
  ]);

  assert.equal(await adapter.inspectTurn(handle, "turn-active"), "active");
});

test("Open Model aborts and fences a bounded turn that exceeds its assistant-step budget", async () => {
  const harness = createHarness();
  harness.setTranscriptFactories([
    (turnId) => [
      assistantMessage(turnId, "assistant-1", 10, null, "tool-calls"),
      assistantMessage(turnId, "assistant-2", 20, "A possible answer."),
      assistantMessage(turnId, "assistant-3", 30, "LETAGENTS_NO_ROOM_REPLY"),
    ],
  ]);
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-runaway-")),
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
    maxAssistantSteps: 2,
  });
  const handle = await adapter.spawn(spawnRequest());

  await assert.rejects(
    adapter.runRoomTurn(handle, {
      inboxItemId: "inbox-runaway",
      sourceMessage: { text: "say hi" },
      activation: { decision: "activate" },
      actionId: "runaway",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exceeded the bounded turn limit of 2 assistant steps/);
      assert.equal(
        (error as Error & { roomTurnRecoveryOutcome?: string }).roomTurnRecoveryOutcome,
        "ambiguous",
      );
      return true;
    },
  );
  assert.deepEqual(harness.aborts, ["session-open-model-1"]);
});

test("typed Open Model reports a step guardrail without aborting the native turn", async () => {
  const harness = createHarness();
  harness.setTranscriptFactories([
    (turnId) => [
      assistantMessage(turnId, "assistant-1", 10, null, "tool-calls"),
      assistantMessage(turnId, "assistant-2", 20, "A possible answer."),
      assistantMessage(turnId, "assistant-3", 30, "LETAGENTS_NO_ROOM_REPLY"),
    ],
  ]);
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-soft-steps-")),
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
    maxAssistantSteps: 2,
  });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const stream: ProviderStreamEvent[] = [];
  adapter.onStream(handle, (event) => stream.push(event));

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-soft-steps",
    sourceMessage: { text: "say hi" },
    activation: { decision: "activate" },
    actionId: "soft-steps",
  });

  assert.equal(result.outcome, "no_reply");
  assert.deepEqual(harness.aborts, []);
  assert.deepEqual(
    stream.filter((event) => event.method === "letagents/turnAttention").map((event) => event.payload),
    [{ kind: "step_guardrail", turnId: result.turnId, limit: 2 }],
  );
});

test("Open Model repairs a continuation on the same verified process", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const checkpointed: string[] = [];
  const originalEvents: NativeExecutionObservation[] = [];
  const originalSource = adapter.onExecution(handle, (event) => originalEvents.push(event));
  assert.deepEqual(originalSource.position(), { firstRetainedSequence: 1, latestSequence: 1 });
  await adapter.probeControl(handle);
  assert.equal(originalEvents[0]?.sourceId, originalSource.sourceId);
  assert.deepEqual(originalSource.position(), { firstRetainedSequence: 1, latestSequence: 2 });

  const rematerialized = await adapter.repairContinuation(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "session-open-model-1",
    cwd: "/tmp/open-model-worktree",
    launchPolicy: {},
  }, {
    checkpointReplacement: async (id) => { checkpointed.push(id); },
  });
  assert.equal(rematerialized.outcome, "rematerialized");
  assert.equal(rematerialized.handle.pid, handle.pid);
  assert.equal(rematerialized.replacementProviderContinuationId, "session-open-model-1");
  assert.equal(checkpointed.length, 0);
  const rematerializedSource = adapter.onExecution(rematerialized.handle, () => {});
  assert.equal(rematerializedSource.sourceId, originalSource.sourceId, "reusing the same observer preserves source identity");
  rematerializedSource.dispose();

  const replaced = await adapter.repairContinuation(handle, {
    workAttemptId: handle.workAttemptId,
    expectedProviderContinuationId: "session-open-model-1",
    forceReplacement: true,
    cwd: "/tmp/open-model-worktree",
    launchPolicy: {},
  }, {
    checkpointReplacement: async (id) => { checkpointed.push(id); },
  });
  assert.equal(replaced.outcome, "replaced");
  assert.equal(replaced.handle.pid, handle.pid);
  assert.equal(replaced.replacementProviderContinuationId, "session-open-model-2");
  assert.deepEqual(checkpointed, ["session-open-model-2"]);
  const replacementEvents: NativeExecutionObservation[] = [];
  const replacementSource = adapter.onExecution(replaced.handle, (event) => replacementEvents.push(event));
  assert.notEqual(replacementSource.sourceId, originalSource.sourceId, "withContinuation creates a new observation source, not a continuation of the old sequence");
  assert.deepEqual(replacementSource.position(), { firstRetainedSequence: 1, latestSequence: 1 });
  await adapter.probeControl(replaced.handle);
  assert.equal(replacementEvents[0]?.sourceId, replacementSource.sourceId);
  assert.equal(replacementEvents[0]?.sequence, 1);
  assert.equal(replacementEvents[0]?.nativeProcessIdentity, "opencode-birth-6101");
  assert.equal(replacementEvents[0]?.nativeProcessIdentity, originalEvents[0]?.nativeProcessIdentity,
    "observation source lifetime is independent of the unchanged native process birth");
  assert.equal(originalEvents.length, 2, "replacement observations never enter the old source subscription");
  assert.deepEqual(originalSource.position(), { firstRetainedSequence: 1, latestSequence: 2 });
  assert.equal(harness.launches.length, 1);
  originalSource.dispose();
  replacementSource.dispose();
});

test("Open Model stop escalates the exact process from TERM to KILL", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.completeObservedProcessExit({ type: "exit", code: null, signal: "SIGKILL" });
  const keepAlive = setInterval(() => undefined, 25);

  const terminal = await adapter.stop(handle, { graceMs: 1 }).finally(() => {
    clearInterval(keepAlive);
  });

  assert.deepEqual(harness.signals, [
    { pid: 6101, signal: "SIGTERM" },
    { pid: 6101, signal: "SIGKILL" },
  ]);
  assert.equal(terminal.terminalCause, "killed");
  assert.equal(terminal.signal, "SIGKILL");
});

test("Open Model launch honors its startup budget even when a health request hangs forever", async () => {
  const harness = createHarness();
  const hangingFetch = harness.dependencies.fetch;
  let exitLaunch!: (exit: ProviderProcessExit) => void;
  const launchExited = new Promise<ProviderProcessExit>((resolve) => { exitLaunch = resolve; });
  const signals: Array<NodeJS.Signals> = [];
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-hung-health-")),
    dependencies: {
      ...harness.dependencies,
      launch(input) {
        void hangingFetch;
        void input;
        const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
        Object.assign(child, { pid: 6102, unref() {} });
        return { child, exited: launchExited };
      },
      getProcessIdentity: (pid) => (pid === 6102 ? "opencode-birth-6102" : null),
      signalProcess(_pid, signal) {
        signals.push(signal);
        if (signal === "SIGKILL" || signal === "SIGTERM") {
          exitLaunch({ type: "exit", code: null, signal });
        }
      },
      // OpenCode can accept a startup-era connection and never answer it. A
      // hung request must not stretch the 100ms launch budget to minutes.
      fetch: () => new Promise<Response>(() => undefined),
    },
    startTimeoutMs: 100,
    turnTimeoutMs: 100,
    stopGraceMs: 5,
  });

  const startedAt = Date.now();
  const keepAlive = setInterval(() => undefined, 25);
  await assert.rejects(
    adapter.spawn(spawnRequest()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Timed out waiting for the supervised OpenCode server.");
      assert.equal((error as Error & { phase?: string }).phase, "health");
      assert.equal(
        (error as Error & { transientProviderStart?: boolean }).transientProviderStart,
        true,
        "a launch timeout must be marked transient so the daemon can retry it",
      );
      return true;
    },
  ).finally(() => clearInterval(keepAlive));
  assert.ok(
    Date.now() - startedAt < 5_000,
    "the launch budget stays authoritative despite the hung health request",
  );
  assert.ok(signals.length > 0, "the unhealthy launch is terminated");
});

test("Open Model terminates and retries a fresh server when session creation times out", async () => {
  const harness = createHarness();
  const baseFetch = harness.dependencies.fetch;
  let exitLaunch!: (exit: ProviderProcessExit) => void;
  const launchExited = new Promise<ProviderProcessExit>((resolve) => { exitLaunch = resolve; });
  const signals: Array<NodeJS.Signals> = [];
  let identityChecks = 0;
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-session-timeout-")),
    dependencies: {
      ...harness.dependencies,
      launch() {
        const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
        Object.assign(child, { pid: 6103, unref() {} });
        return { child, exited: launchExited };
      },
      getProcessIdentity: (pid) => {
        identityChecks += 1;
        return pid === 6103 ? "opencode-birth-6103" : null;
      },
      signalProcess(_pid, signal) {
        signals.push(signal);
        exitLaunch({ type: "exit", code: null, signal });
      },
      async fetch(input, init) {
        const url = new URL(input);
        if (url.pathname === "/session" && init?.method === "POST") {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        return baseFetch(input, init);
      },
    },
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
    stopGraceMs: 5,
  });

  await assert.rejects(
    adapter.spawn(spawnRequest()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { transientProviderStart?: boolean }).transientProviderStart,
        true,
        "a session-control timeout must be retried as a clean provider start",
      );
      return true;
    },
  );
  assert.deepEqual(signals, ["SIGTERM"], "the ambiguous fresh runtime is fenced before retry");
  assert.equal(identityChecks, 2, "cleanup re-verifies the captured process birth before signaling");
});

test("Open Model bounds first-session bootstrap by the launch budget and names the phase", async (t) => {
  // The adapter reads the clock to see what is left of the budget. Holding
  // the clock still leaves the whole budget to the first session however
  // long the file writes before it take, so the phase does not depend on the
  // speed of the machine. The request's own deadline is a real timer.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const harness = createHarness();
  const baseFetch = harness.dependencies.fetch;
  let exitLaunch!: (exit: ProviderProcessExit) => void;
  const launchExited = new Promise<ProviderProcessExit>((resolve) => { exitLaunch = resolve; });
  let sessionSignal: AbortSignal | null = null;
  let sessionRequestedAt = 0;
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-session-budget-")),
    dependencies: {
      ...harness.dependencies,
      launch() {
        const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
        Object.assign(child, { pid: 6104, unref() {} });
        return { child, exited: launchExited };
      },
      getProcessIdentity: (pid) => (pid === 6104 ? "opencode-birth-6104" : null),
      signalProcess(_pid, signal) {
        exitLaunch({ type: "exit", code: null, signal });
      },
      fetch(input, init) {
        const url = new URL(input);
        if (url.pathname !== "/session" || init?.method !== "POST") return baseFetch(input, init);
        // A healthy server whose instance bootstrap never finishes: only the
        // request's own deadline can end this wait.
        sessionSignal = init.signal ?? null;
        sessionRequestedAt = performance.now();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    },
    startTimeoutMs: 200,
    turnTimeoutMs: 100,
    stopGraceMs: 5,
  });

  // AbortSignal.timeout does not hold the event loop open by itself.
  const keepAlive = setInterval(() => undefined, 25);
  await assert.rejects(
    adapter.spawn(spawnRequest()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "OpenCodeStartTimeoutError");
      assert.equal((error as Error & { phase?: string }).phase, "session");
      assert.match(error.message, /prepare its first session/);
      assert.equal(
        (error as Error & { transientProviderStart?: boolean }).transientProviderStart,
        true,
      );
      return true;
    },
  ).finally(() => clearInterval(keepAlive));
  assert.ok(sessionSignal, "first-session bootstrap carries an explicit deadline");
  assert.ok(
    performance.now() - sessionRequestedAt < 5_000,
    "the launch budget, not the 15s steady-state control deadline, ends the wait",
  );
  assert.ok(
    performance.now() - sessionRequestedAt >= 150,
    "the 200ms launch budget, not the 100ms turn budget, sets the deadline",
  );
});

test("Open Model gives the first session only what the health wait left of the launch budget", async () => {
  const startTimeoutMs = 2_500;
  // Returns how long after launch the first-session request was aborted,
  // for a server that stays unhealthy for `healthDelayMs` and then never
  // finishes its first session.
  const sessionAbortedAfterMs = async (healthDelayMs: number, pid: number): Promise<number> => {
    const harness = createHarness();
    const baseFetch = harness.dependencies.fetch;
    let exitLaunch!: (exit: ProviderProcessExit) => void;
    const launchExited = new Promise<ProviderProcessExit>((resolve) => { exitLaunch = resolve; });
    let startedAt = 0;
    let abortedAt = 0;
    const adapter = new OpenModelProviderAdapter({
      binary: "/opt/letagents/opencode",
      runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-shared-budget-")),
      dependencies: {
        ...harness.dependencies,
        launch() {
          const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
          Object.assign(child, { pid, unref() {} });
          return { child, exited: launchExited };
        },
        getProcessIdentity: (candidate) => (candidate === pid ? `opencode-birth-${pid}` : null),
        signalProcess(_pid, signal) {
          exitLaunch({ type: "exit", code: null, signal });
        },
        fetch(input, init) {
          const url = new URL(input);
          if (url.pathname === "/global/health" && Date.now() - startedAt < healthDelayMs) {
            return Promise.resolve(json({ healthy: false }, 503));
          }
          if (url.pathname !== "/session" || init?.method !== "POST") return baseFetch(input, init);
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              abortedAt = Date.now();
              reject(init.signal?.reason);
            }, { once: true });
          });
        },
      },
      startTimeoutMs,
      turnTimeoutMs: 100,
      stopGraceMs: 5,
    });
    const keepAlive = setInterval(() => undefined, 25);
    startedAt = Date.now();
    await assert.rejects(
      adapter.spawn(spawnRequest()),
      (error: unknown) => (error as Error & { phase?: string }).phase === "session",
    ).finally(() => clearInterval(keepAlive));
    return abortedAt - startedAt;
  };

  const afterShortHealthWait = await sessionAbortedAfterMs(200, 6105);
  const afterLongHealthWait = await sessionAbortedAfterMs(1_200, 6106);

  // A shared deadline ends both launches at the same moment. Any budget the
  // session owned for itself would move the second one a second later.
  assert.ok(
    Math.abs(afterLongHealthWait - afterShortHealthWait) < 500,
    `the launch deadline must not move with the health wait (${afterShortHealthWait}ms, ${afterLongHealthWait}ms)`,
  );
  assert.ok(afterShortHealthWait >= startTimeoutMs - 50, "the first session may use the whole remainder");
  assert.ok(
    afterShortHealthWait < startTimeoutMs + 1_000,
    `a shared deadline that lands late is still wrong (${afterShortHealthWait}ms)`,
  );
});

test("Open Model still launches when the runtime config directory cannot be seeded", async (t) => {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-unseedable-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const directory = join(runtimeRoot, "work-attempt-open-model-1", "config", "opencode");
  await mkdir(directory, { recursive: true });
  // A regular file where OpenCode expects a directory defeats the seed.
  await writeFile(join(directory, "node_modules"), "");
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  const handle = await adapter.spawn(spawnRequest());

  assert.equal(handle.providerContinuationId, "session-open-model-1");
  assert.equal(harness.launches.length, 1);
  assert.equal((await lstat(join(directory, "AGENTS.md"))).size, 0,
    "a failed seed does not skip the instruction shield");
});

test("Open Model launches without loading the owner's external Claude and agent skills", async (t) => {
  const previous = process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS;
  process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "0";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS;
    else process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = previous;
  });
  const { harness, runtimeRoot } = await spawnAdapter();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  assert.equal(harness.launches[0]?.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1",
    "the runtime always launches with external skills disabled; the owner's value is not inherited");
});

test("Open Model keeps OpenCode's project search inside a room's scratch workspace", async (t) => {
  const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
    else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous;
  });
  const scratch = await spawnAdapter({ workspaceKind: "room_scratch" });
  t.after(() => rm(scratch.runtimeRoot, { recursive: true, force: true }));
  assert.equal(scratch.harness.launches[0]?.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1",
    "a scratch workspace has no repository root to stop the search at");

  // A repository's own AGENTS.md, CLAUDE.md and OpenCode configuration must
  // keep loading, whatever the owner's environment says.
  const worktree = await spawnAdapter({ workspaceKind: "git_worktree" });
  t.after(() => rm(worktree.runtimeRoot, { recursive: true, force: true }));
  assert.equal(worktree.harness.launches[0]?.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
});

test("Open Model reports, and does not fail on, a scratch workspace whose Git OpenCode cannot run", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  const working = await spawnAdapter({ workspaceKind: "room_scratch" });
  t.after(() => rm(working.runtimeRoot, { recursive: true, force: true }));
  const probe = working.harness.gitProbes[0]!;
  const launched = working.harness.launches[0]!;
  assert.equal(working.harness.gitProbes.length, 1);
  assert.equal(probe.workspace, launched.cwd, "the check runs in the workspace OpenCode opens");
  // The launch's own environment, not the daemon's: its config home is private to the runtime.
  assert.equal(probe.environment.XDG_CONFIG_HOME, launched.env.XDG_CONFIG_HOME);
  assert.notEqual(probe.environment.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME);
  assert.equal(probe.environment.PATH, launched.env.PATH);
  assert.equal(working.handle.launchNotices?.length ?? 0, 0);
  assert.equal(warnings.length, 0);

  const harness = createHarness();
  harness.gitProblem = "the Xcode command line tools are not installed (xcode-select -p failed), so /usr/bin/git cannot run";
  const broken = await spawnAdapter({ workspaceKind: "room_scratch" }, harness);
  t.after(() => rm(broken.runtimeRoot, { recursive: true, force: true }));
  assert.equal(broken.harness.launches.length, 1, "the launch goes ahead");
  assert.deepEqual(broken.handle.launchNotices, [
    "Plugin boundary not in effect: the Xcode command line tools are not installed (xcode-select -p failed), so /usr/bin/git cannot run. OpenCode cannot see this room's workspace repository, so plugins in folders above the workspace can load into it.",
  ]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.[0], "[open_model_workspace_boundary]");

  // A Git worktree needs no check: its repository is the owner's.
  const worktree = await spawnAdapter({ workspaceKind: "git_worktree" });
  t.after(() => rm(worktree.runtimeRoot, { recursive: true, force: true }));
  assert.equal(worktree.harness.gitProbes.length, 0);
});

test("Open Model does not launch into a workspace whose kind it was not told", async (t) => {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-unknown-workspace-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  await assert.rejects(
    adapter.spawn(spawnRequest({ workspaceKind: undefined })),
    /requires an explicit workspace kind/,
  );
  assert.equal(harness.launches.length, 0, "an unknown workspace is never treated as a repository");
  assert.deepEqual(await readdir(runtimeRoot), [], "nothing is written for a launch that is refused");
});

test("Open Model launches with an empty global instruction file in place of the owner's", async (t) => {
  const { harness, runtimeRoot } = await spawnAdapter();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const configHome = join(runtimeRoot, "work-attempt-open-model-1", "config");
  assert.equal(harness.launches[0]?.env.XDG_CONFIG_HOME, configHome);
  // OpenCode reads <config>/opencode/AGENTS.md before ~/.claude/CLAUDE.md and
  // stops at the first that exists. An empty one adds nothing to the prompt.
  const shield = await lstat(join(configHome, "opencode", "AGENTS.md"));
  assert.equal(shield.isFile(), true);
  assert.equal(shield.size, 0);
  assert.equal(harness.launches[0]?.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, undefined,
    "a project's CLAUDE.md stays usable, which this flag would also drop");
});

test("Open Model does not launch a runtime whose instruction shield cannot be written", async (t) => {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-shield-blocked-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  // A file where the config directory belongs makes every write below it fail.
  await mkdir(join(runtimeRoot, "work-attempt-open-model-1"), { recursive: true });
  await writeFile(join(runtimeRoot, "work-attempt-open-model-1", "config"), "not a directory");
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  await assert.rejects(adapter.spawn(spawnRequest()), /ENOTDIR|EEXIST/);
  assert.equal(harness.launches.length, 0, "the owner's instructions must not reach a launched runtime");
});

test("Open Model does not launch a runtime whose instruction shield is refused by the file system", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32") {
    t.skip("directory permissions do not refuse a write here");
    return;
  }
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-shield-readonly-"));
  const directory = join(runtimeRoot, "work-attempt-open-model-1", "config", "opencode");
  await mkdir(directory, { recursive: true });
  // The directory is there and can be read, so only the write itself fails.
  await chmod(directory, 0o500);
  t.after(async () => {
    await chmod(directory, 0o700);
    await rm(runtimeRoot, { recursive: true, force: true });
  });
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  await assert.rejects(adapter.spawn(spawnRequest()), /EACCES.*AGENTS\.md/);
  assert.equal(harness.launches.length, 0);
});

test("Open Model gives an already running runtime the instruction shield when it reattaches", async (t) => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  assert.ok(handle.providerContinuationId);
  // As left by a desktop version from before the shield existed.
  const shield = join(runtimeRoot, "work-attempt-open-model-1", "config", "opencode", "AGENTS.md");
  await rm(shield);
  const replacement = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  const attached = await replacement.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    providerConnection: handle.providerConnection,
  });

  assert.ok(attached && !("state" in attached));
  assert.equal((await lstat(shield)).size, 0);
  assert.equal(harness.launches.length, 1);
});

test("Open Model reattaching through a sidecar outside its runtime directory writes nothing there", async (t) => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  const foreign = await mkdtemp(join(tmpdir(), "letagents-opencode-shield-foreign-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  t.after(() => rm(foreign, { recursive: true, force: true }));
  const connection = handle.providerConnection;
  assert.ok(connection?.kind === "opencode_server");
  assert.ok(handle.providerContinuationId);
  const foreignAuthPath = join(foreign, "server-auth.json");
  await writeFile(foreignAuthPath, await readFile(connection.serverAuthPath, "utf8"), { mode: 0o600 });
  const kept = join(foreign, "config", "opencode", "AGENTS.md", "nested", "keep.txt");
  await mkdir(join(kept, ".."), { recursive: true });
  await writeFile(kept, "not ours");
  const replacement = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  const attached = await replacement.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    providerConnection: { ...connection, serverAuthPath: foreignAuthPath },
  });

  assert.ok(attached && !("state" in attached));
  assert.equal(await readFile(kept, "utf8"), "not ours");
});

test("Open Model still reattaches to a running runtime that cannot take the instruction shield", async (t) => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  assert.ok(handle.providerContinuationId);
  const config = join(runtimeRoot, "work-attempt-open-model-1", "config");
  await rm(config, { recursive: true, force: true });
  await writeFile(config, "not a directory");
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const replacement = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  const attached = await replacement.attach({
    workAttemptId: handle.workAttemptId,
    providerContinuationId: handle.providerContinuationId,
    providerConnection: handle.providerConnection,
  });

  assert.ok(attached && !("state" in attached), "a working agent is not taken away");
});

test("Open Model instruction shield empties whatever was at its path", async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), "letagents-opencode-shield-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  const target = join(configHome, "opencode", "AGENTS.md");

  await shieldOwnerInstructions(configHome);
  await shieldOwnerInstructions(configHome);
  assert.equal(await readFile(target, "utf8"), "");

  await writeFile(target, "Always answer in French.\n");
  await shieldOwnerInstructions(configHome);
  assert.equal(await readFile(target, "utf8"), "");

  await rm(target);
  await mkdir(join(target, "nested"), { recursive: true });
  await shieldOwnerInstructions(configHome);
  assert.equal((await lstat(target)).isFile(), true);
  assert.equal(await readFile(target, "utf8"), "");
});

test("Open Model instruction shield replaces a link without writing through it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "letagents-opencode-shield-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configHome = join(root, "config");
  const ownerFile = join(root, "owner-CLAUDE.md");
  const ownerInstructions = "Always answer in French.\n";
  await writeFile(ownerFile, ownerInstructions);
  await mkdir(join(configHome, "opencode"), { recursive: true });
  const target = join(configHome, "opencode", "AGENTS.md");
  await symlink(ownerFile, target);

  await shieldOwnerInstructions(configHome);

  const shield = await lstat(target);
  assert.equal(shield.isSymbolicLink(), false);
  assert.equal(shield.isFile(), true);
  assert.equal(shield.size, 0);
  assert.equal(await readFile(ownerFile, "utf8"), ownerInstructions, "the owner's file is left as it was");

  // An empty file reached through a link is still the owner's file.
  await rm(target);
  await writeFile(ownerFile, "");
  await symlink(ownerFile, target);
  await shieldOwnerInstructions(configHome);
  assert.equal((await lstat(target)).isSymbolicLink(), false);

  // So is an empty file that has a second name.
  await rm(target);
  await link(ownerFile, target);
  await shieldOwnerInstructions(configHome);
  await writeFile(ownerFile, ownerInstructions);
  assert.equal(await readFile(target, "utf8"), "");
  assert.deepEqual(await readdir(join(configHome, "opencode")), ["AGENTS.md"]);
});

test("Open Model instruction shield survives concurrent launches of one runtime", async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), "letagents-opencode-shield-race-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  const target = join(configHome, "opencode", "AGENTS.md");
  await mkdir(join(configHome, "opencode"), { recursive: true });
  await writeFile(target, "Always answer in French.\n");

  await Promise.all(Array.from({ length: 16 }, () => shieldOwnerInstructions(configHome)));

  assert.equal(await readFile(target, "utf8"), "");
  assert.deepEqual(await readdir(join(configHome, "opencode")), ["AGENTS.md"]);
});

test("Open Model seeds a fresh runtime so OpenCode has no plugin SDK to install", async (t) => {
  const { harness, runtimeRoot } = await spawnAdapter();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const configHome = join(runtimeRoot, "work-attempt-open-model-1", "config");
  assert.equal(harness.launches[0]?.env.XDG_CONFIG_HOME, configHome);

  const directory = join(configHome, "opencode");
  const dependencies = { "@opencode-ai/plugin": OPENCODE_RUNTIME_VERSION };
  assert.deepEqual(await readdir(join(directory, "node_modules")), []);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    { dependencies },
  );
  // OpenCode skips its install only when the lockfile's root entry already
  // names every declared dependency.
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8")).packages[""],
    { dependencies },
  );
});

test("Open Model config seeding preserves a directory OpenCode already provisioned", async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), "letagents-opencode-seed-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  const directory = join(configHome, "opencode");
  await mkdir(join(directory, "node_modules", "@opencode-ai"), { recursive: true });
  const provisioned = '{"dependencies":{"@opencode-ai/plugin":"1.18.9"}}';
  await writeFile(join(directory, "package.json"), provisioned);

  await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION);
  await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION);

  assert.equal(await readFile(join(directory, "package.json"), "utf8"), provisioned);
  assert.deepEqual(await readdir(join(directory, "node_modules")), ["@opencode-ai"]);
  assert.ok(JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8")).packages[""]);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["node_modules", "package-lock.json", "package.json"],
    "seeding leaves no staging files behind, including for a file that already existed",
  );
});

test("Open Model config seeding never publishes a file whose write was cut short", async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), "letagents-opencode-seed-partial-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  const directory = join(configHome, "opencode");
  let writes = 0;

  await assert.rejects(seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION, {
    mkdir,
    link,
    unlink,
    // The disk fills halfway through the first file.
    writeFile: (async (path: string, content: string, options: { flag?: string }) => {
      writes += 1;
      await writeFile(path, content.slice(0, Math.floor(content.length / 2)), options);
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }) as typeof writeFile,
  }), /no space left/);

  assert.equal(writes, 1);
  assert.deepEqual(
    await readdir(directory),
    ["node_modules"],
    "neither a truncated target nor its staging file is left for a later launch to preserve",
  );

  await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    { dependencies: { "@opencode-ai/plugin": OPENCODE_RUNTIME_VERSION } },
    "the next launch seeds the directory normally",
  );
});

test("Open Model config seeding writes directly where hard links are unsupported", async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), "letagents-opencode-seed-nolink-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));
  const directory = join(configHome, "opencode");
  await mkdir(directory, { recursive: true });
  const provisioned = '{"dependencies":{"@opencode-ai/plugin":"1.18.9"}}';
  await writeFile(join(directory, "package.json"), provisioned);

  await seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION, {
    mkdir,
    writeFile,
    unlink,
    link: (async () => {
      throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
    }) as typeof link,
  });

  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["node_modules", "package-lock.json", "package.json"],
  );
  assert.equal(
    await readFile(join(directory, "package.json"), "utf8"),
    provisioned,
    "the direct write still refuses to replace an existing file",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8")).packages[""],
    { dependencies: { "@opencode-ai/plugin": OPENCODE_RUNTIME_VERSION } },
  );
});

test("Open Model config seeding survives concurrent seeds of one directory", async (t) => {
  const configHome = await mkdtemp(join(tmpdir(), "letagents-opencode-seed-race-"));
  t.after(() => rm(configHome, { recursive: true, force: true }));

  await Promise.all(Array.from({ length: 16 }, () =>
    seedOpenCodeConfigHome(configHome, OPENCODE_RUNTIME_VERSION)));

  const directory = join(configHome, "opencode");
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ["node_modules", "package-lock.json", "package.json"],
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    { dependencies: { "@opencode-ai/plugin": OPENCODE_RUNTIME_VERSION } },
  );
});

test("Open Model durably fences the crash window between detached launch and PID capture", async (t) => {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-startup-intent-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const authPath = join(runtimeRoot, "work-attempt-open-model-1", "server-auth.json");
  let launches = 0;
  const dependencies: OpenModelProviderAdapterDependencies = {
    ...harness.dependencies,
    launch() {
      launches += 1;
      assert.deepEqual(
        (JSON.parse(readFileSync(authPath, "utf8")) as { startupIntent?: unknown }).startupIntent,
        { url: "http://127.0.0.1:43821" },
        "the intent is durable before a detached process can start",
      );
      // Model a launcher that has detached the process but fails before it can
      // return the PID needed for exact birth evidence.
      throw new Error("simulated crash after detached OpenCode launch");
    },
  };
  const createAdapter = () => new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  await assert.rejects(
    createAdapter().spawn(spawnRequest()),
    /simulated crash after detached OpenCode launch/,
  );
  assert.deepEqual(
    (JSON.parse(await readFile(authPath, "utf8")) as { startupIntent?: unknown }).startupIntent,
    { url: "http://127.0.0.1:43821" },
    "the unresolved launch remains durable without invented PID evidence",
  );

  await assert.rejects(
    createAdapter().spawn(spawnRequest()),
    /startup intent has no durable process identity; refusing to start a competing runtime/,
  );
  assert.equal(launches, 1, "intent-only recovery must not launch a replacement");
});

test("Open Model clears its exact intent after a real no-pid launch failure", async (t) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-no-pid-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const request = spawnRequest({ cwd: runtimeRoot });
  const missingBinaryAdapter = new OpenModelProviderAdapter({
    binary: join(runtimeRoot, "missing-opencode"),
    runtimeRoot,
    dependencies: { allocatePort: async () => 43821 },
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  await assert.rejects(
    missingBinaryAdapter.spawn(request),
    /OpenCode launch did not expose a process id/,
  );
  const authPath = join(runtimeRoot, "work-attempt-open-model-1", "server-auth.json");
  const clearedControl = JSON.parse(await readFile(authPath, "utf8")) as {
    startupIntent?: unknown;
    startupProcess?: unknown;
    connection?: unknown;
  };
  assert.equal(clearedControl.startupIntent, undefined);
  assert.equal(clearedControl.startupProcess, undefined);
  assert.equal(clearedControl.connection, undefined);

  const harness = createHarness();
  const recoveredAdapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });
  const handle = await recoveredAdapter.spawn(request);
  assert.equal(handle.pid, 6101);
  assert.equal(harness.launches.length, 1, "a fixed environment can retry after conclusive no-pid failure");
});

test("Open Model serializes A/B startup ownership for the same runtime path", async (t) => {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-startup-owner-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  let launches = 0;
  let markFirstLaunch!: () => void;
  const firstLaunchStarted = new Promise<void>((resolve) => { markFirstLaunch = resolve; });
  let settleFirstExit!: (exit: ProviderProcessExit) => void;
  const firstExited = new Promise<ProviderProcessExit>((resolve) => { settleFirstExit = resolve; });
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: {
      ...harness.dependencies,
      launch(input) {
        launches += 1;
        if (launches === 1) {
          const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
          Object.assign(child, { pid: undefined, unref() {} });
          markFirstLaunch();
          return { child, exited: firstExited };
        }
        return harness.dependencies.launch(input);
      },
    },
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
  });

  const launchA = adapter.spawn(spawnRequest());
  await firstLaunchStarted;
  const launchB = adapter.spawn(spawnRequest());
  let launchBSettled = false;
  void launchB.then(
    () => { launchBSettled = true; },
    () => { launchBSettled = true; },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(launches, 1, "B cannot enter launch while A still owns the runtime");
  assert.equal(launchBSettled, false, "B remains queued behind A's complete cleanup");

  settleFirstExit({ type: "error", error: new Error("missing binary") });
  await assert.rejects(launchA, /OpenCode launch did not expose a process id/);
  const recovered = await launchB;
  assert.equal(recovered.pid, 6101);
  assert.equal(launches, 2);
  const connection = recovered.providerConnection;
  assert.ok(connection?.kind === "opencode_server");
  const control = JSON.parse(await readFile(connection.serverAuthPath, "utf8")) as {
    startupIntent?: unknown;
    connection?: { pid?: number; processIdentity?: string };
  };
  assert.equal(control.startupIntent, undefined);
  assert.deepEqual(control.connection, {
    url: "http://127.0.0.1:43821",
    pid: 6101,
    processIdentity: "opencode-birth-6101",
  }, "A cannot clear or overwrite B's promoted connection");
});

test("Open Model persists an ambiguous startup birth and fences replacement until it is gone", async (t) => {
  const harness = createHarness();
  const baseFetch = harness.dependencies.fetch;
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-startup-fence-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const neverExits = new Promise<ProviderProcessExit>(() => {});
  let launches = 0;
  let priorIdentity: string | null | undefined = "opencode-birth-6104";
  let failSessionCreation = true;
  const dependencies: OpenModelProviderAdapterDependencies = {
    ...harness.dependencies,
    launch() {
      launches += 1;
      const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
      Object.assign(child, { pid: launches === 1 ? 6104 : 6105, unref() {} });
      return { child, exited: neverExits };
    },
    getProcessIdentity(pid) {
      if (pid === 6104) return priorIdentity;
      return pid === 6105 ? "opencode-birth-6105" : null;
    },
    signalProcess() {
      assert.fail("an unverifiable or recycled startup birth must never be signaled");
    },
    async fetch(input, init) {
      const url = new URL(input);
      if (failSessionCreation && url.pathname === "/session" && init?.method === "POST") {
        priorIdentity = undefined;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return baseFetch(input, init);
    },
  };
  const createAdapter = () => new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
    stopGraceMs: 5,
  });

  await assert.rejects(
    createAdapter().spawn(spawnRequest()),
    /process identity could not be verified during cleanup/,
  );
  const authPath = join(runtimeRoot, "work-attempt-open-model-1", "server-auth.json");
  assert.deepEqual(
    (JSON.parse(await readFile(authPath, "utf8")) as { startupProcess?: unknown }).startupProcess,
    {
      url: "http://127.0.0.1:43821",
      pid: 6104,
      processIdentity: "opencode-birth-6104",
    },
    "the exact startup birth is durable before cleanup can become ambiguous",
  );

  const replacement = createAdapter();
  await assert.rejects(
    replacement.spawn(spawnRequest()),
    /previous OpenCode startup process identity could not be verified/,
  );
  priorIdentity = "opencode-birth-6104";
  await assert.rejects(
    replacement.spawn(spawnRequest()),
    /previous OpenCode startup process is still running/,
  );
  assert.equal(launches, 1, "explicit recovery cannot launch while the exact prior birth is possible");

  priorIdentity = "recycled-birth-6104";
  failSessionCreation = false;
  const handle = await replacement.spawn(spawnRequest());
  assert.equal(launches, 2, "a replacement may launch after the exact prior birth is conclusively gone");
  assert.equal(handle.pid, 6105);
  const recoveredControl = JSON.parse(await readFile(authPath, "utf8")) as {
    startupProcess?: unknown;
    connection?: { pid?: number; processIdentity?: string };
  };
  assert.equal(recoveredControl.startupProcess, undefined);
  assert.deepEqual(recoveredControl.connection, {
    url: "http://127.0.0.1:43821",
    pid: 6105,
    processIdentity: "opencode-birth-6105",
  });

  await assert.rejects(
    createAdapter().spawn(spawnRequest()),
    /previous OpenCode startup process is still running/,
  );
  assert.equal(launches, 2, "connection-only crash recovery cannot launch beside the live runtime birth");
});

test("Open Model persists and fences a fresh pid whose birth is initially unverifiable", async (t) => {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-unknown-startup-birth-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const neverExits = new Promise<ProviderProcessExit>(() => {});
  let launches = 0;
  let firstIdentity: string | null | undefined;
  const dependencies: OpenModelProviderAdapterDependencies = {
    ...harness.dependencies,
    launch() {
      launches += 1;
      const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
      Object.assign(child, { pid: launches === 1 ? 6106 : 6107, unref() {} });
      return { child, exited: neverExits };
    },
    getProcessIdentity(pid) {
      return pid === 6106 ? firstIdentity : "opencode-birth-6107";
    },
    signalProcess() {
      assert.fail("a pid without a captured birth identity must never be signaled");
    },
  };
  const createAdapter = () => new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
    stopGraceMs: 5,
  });

  await assert.rejects(
    createAdapter().spawn(spawnRequest()),
    /OpenCode process identity could not be verified/,
  );
  const authPath = join(runtimeRoot, "work-attempt-open-model-1", "server-auth.json");
  assert.deepEqual(
    (JSON.parse(await readFile(authPath, "utf8")) as { startupProcess?: unknown }).startupProcess,
    {
      url: "http://127.0.0.1:43821",
      pid: 6106,
      processIdentity: null,
    },
    "the sidecar durably records startup ambiguity before identity capture",
  );

  firstIdentity = "some-live-birth";
  await assert.rejects(
    createAdapter().spawn(spawnRequest()),
    /previous OpenCode startup process identity could not be verified/,
  );
  assert.equal(launches, 1, "a later identity cannot be attributed to the uncaptured startup birth");

  firstIdentity = null;
  const recovered = await createAdapter().spawn(spawnRequest());
  assert.equal(launches, 2, "replacement waits until the ambiguous pid is conclusively absent");
  assert.equal(recovered.pid, 6107);
});

test("fresh launch cleanup never signals a recycled or unverifiable pid", async () => {
  const exited = new Promise<ProviderProcessExit>(() => {});
  const signals: Array<NodeJS.Signals> = [];
  const dependencies = {
    getProcessIdentity: () => "replacement-birth",
    signalProcess: (_pid: number, signal: NodeJS.Signals) => { signals.push(signal); },
  };

  await terminateFreshLaunch(
    { pid: 6103, exited, processIdentity: "opencode-birth-6103" },
    dependencies,
    1,
  );
  assert.deepEqual(signals, [], "a recycled pid is treated as the original process already being gone");

  await assert.rejects(
    terminateFreshLaunch(
      { pid: 6103, exited, processIdentity: "opencode-birth-6103" },
      { ...dependencies, getProcessIdentity: () => undefined },
      1,
    ),
    /process identity could not be verified during cleanup/,
  );
  assert.deepEqual(signals, [], "an unverifiable pid remains ambiguous and is never signaled");
});

test("fresh launch cleanup rechecks process birth before kill escalation", async () => {
  const exited = new Promise<ProviderProcessExit>(() => {});
  const signals: Array<NodeJS.Signals> = [];
  let identity = "opencode-birth-6103";
  const keepAlive = setInterval(() => undefined, 25);

  try {
    await terminateFreshLaunch(
      { pid: 6103, exited, processIdentity: "opencode-birth-6103" },
      {
        getProcessIdentity: () => identity,
        signalProcess: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGTERM") identity = "replacement-birth";
        },
      },
      1,
    );
  } finally {
    clearInterval(keepAlive);
  }

  assert.deepEqual(signals, ["SIGTERM"], "a recycled pid is not killed after the grace period");
});

test("Open Model bounded turns time out without polling transcript history", async () => {
  const harness = createHarness();
  harness.holdTurnOpen();
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-timeout-")),
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 10,
  });
  const handle = await adapter.spawn(spawnRequest());

  await assert.rejects(
    adapter.runRoomTurn(handle, {
      inboxItemId: "inbox-timeout",
      sourceMessage: { text: "stay busy" },
      activation: { decision: "activate" },
      actionId: "timeout",
    }),
    /bounded turn timed out/,
  );
  assert.equal(harness.promptBodies.length, 1);
  assert.equal(harness.messageReads, 1, "one bounded snapshot replaces transcript polling");
  assert.deepEqual(harness.aborts, ["session-open-model-1"], "the watchdog stops the exact native session");
});

test("typed Open Model reports a duration guardrail and keeps observing the exact turn", async () => {
  const harness = createHarness();
  harness.holdTurnOpen();
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-opencode-soft-timeout-")),
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 10,
  });
  const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode: "typed" }));
  const attentionEvents: ProviderStreamEvent[] = [];
  adapter.onStream(handle, (event) => {
    if (event.method !== "letagents/turnAttention") return;
    attentionEvents.push(event);
    harness.completeTurn();
  });

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-soft-timeout",
    sourceMessage: { text: "stay busy" },
    activation: { decision: "activate" },
    actionId: "soft-timeout",
  });

  assert.equal(result.outcome, "reply");
  assert.deepEqual(harness.aborts, []);
  assert.deepEqual(attentionEvents.map((event) => event.payload), [
    { kind: "duration_guardrail", turnId: result.turnId, limitMs: 10 },
  ]);
  assert.equal(harness.messageReads, 2, "the guardrail does not restart transcript polling");
});

test("Open Model bounds a hung status probe to the turn-control budget instead of hanging the Stop", async () => {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-stop-budget-"));
  const originalFetch = harness.dependencies.fetch;
  let aborted = false;
  harness.dependencies.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/session/status") {
      // Pre-abort checks see a busy session; the post-abort idle probe hangs to
      // model a server that stopped answering /session/status.
      if (!aborted) return json({ "session-open-model-1": { type: "busy" } });
      return new Promise<Response>(() => {});
    }
    if (url.pathname.endsWith("/abort") && init?.method === "POST") {
      aborted = true;
    }
    return originalFetch(input, init);
  };
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: LAUNCH_BUDGET_MS,
    turnTimeoutMs: 100,
    turnControlTimeoutMs: 120,
  });
  const handle = await adapter.spawn(spawnRequest());
  (handle as unknown as { activeRoomTurnId: string | null }).activeRoomTurnId = "turn-hung-status";

  const startedAt = Date.now();
  await assert.rejects(
    adapter.controlTurn(handle, null, { targetTurnId: "turn-hung-status" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderTurnControlError);
      assert.equal(error.turnControlOutcome, "uncertain");
      assert.match(error.message, /turn boundary could not be verified/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 2_000, "a hung status probe must not stretch the Stop far past its 120ms budget");
  assert.deepEqual(harness.aborts, ["session-open-model-1"]);
});

test("Open Model clears the working projection and active turn id when a non-bounded turn error propagates", async () => {
  const { adapter, handle } = await spawnAdapter();

  await assert.rejects(
    adapter.runRoomTurn(handle, {
      inboxItemId: "inbox-non-bounded-leak",
      sourceMessage: { text: "say hi" },
      activation: { decision: "activate" },
      actionId: "non-bounded-leak",
    }, {
      // A non-bounded failure (here a checkpoint write) after the turn read.
      checkpointTerminalResult: async () => { throw new Error("durable checkpoint write failed"); },
    }),
    /durable checkpoint write failed/,
  );

  assert.equal(handle.observedState(), "idle", "a non-bounded failure must not leak a working projection");
  assert.equal((handle as unknown as { activeRoomTurnId: string | null }).activeRoomTurnId, null, "the stale active turn id is cleared");
});

function permissionFixture(id = "per_a", sessionID = "ses_a"): OpenCodePermissionRequest {
  return {
    id, sessionID, permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" }, always: ["npm *"],
    tool: { messageID: "msg_assistant", callID: "call_a" },
  };
}

function nativeClient(fetchImpl: OpenModelProviderAdapterDependencies["fetch"]): OpenCodeServerClient {
  return new OpenCodeServerClient("http://127.0.0.1:43821", { username: "opencode", password: "client-test" }, fetchImpl);
}

function permissionTurnMessages(sessionID = "ses_a") {
  const assistant = assistantWithTool("msg_user", "msg_assistant", 10,
    { status: "running", input: { command: "private-command" }, output: "private-output" }, "call_a");
  assistant.info.sessionID = sessionID;
  Object.assign(assistant.parts[0]!, { sessionID, messageID: "msg_assistant" });
  const user = userMessage("msg_user"); user.info.sessionID = sessionID;
  user.parts.push({ type: "text", text: "private-user-prompt" });
  return { assistant, user };
}

test("OpenCode permission correlation reads only the exact assistant and user messages and returns structural linkage", async () => {
  const { assistant, user } = permissionTurnMessages();
  const paths: string[] = []; let fences = 0;
  const client = nativeClient(async (input, init) => {
    const url = new URL(input); paths.push(url.pathname);
    assert.equal(init?.method ?? "GET", "GET"); assert.equal(url.search, ""); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:client-test").toString("base64")}`);
    assert.equal(fences, paths.length, "instance fence precedes each exact read");
    return json(paths.length === 1 ? assistant : user);
  });
  const expected = permissionFixture(); expected.permission = "external_directory";
  const correlation = await client.correlatePermissionTurn("ses_a", expected, () => { fences += 1; });
  assert.deepEqual(correlation, { outcome: "correlated", requestId: "per_a", providerContinuationId: "ses_a",
    providerTurnId: "msg_user", assistantMessageId: "msg_assistant", callId: "call_a" });
  assert.deepEqual(paths, ["/session/ses_a/message/msg_assistant", "/session/ses_a/message/msg_user"]);
  assert.equal(fences, 3, "the parent response is fenced too");
  assert.doesNotMatch(JSON.stringify(correlation), /private-|metadata|command|patterns|output/);
});

test("OpenCode permission correlation refuses missing tool and foreign or malformed requests without reading", async () => {
  let reads = 0; const client = nativeClient(async () => { reads += 1; return json({}); });
  const withoutTool = permissionFixture(); delete withoutTool.tool;
  for (const [session, request] of [
    ["", permissionFixture()], ["ses_other", permissionFixture()], ["ses_a", withoutTool],
    ["ses_a", null], ["ses_a", {}], ["ses_a", { ...permissionFixture(), id: "" }],
    ["ses_a", { ...permissionFixture(), metadata: [] }], ["ses_a", { ...permissionFixture(), patterns: [1] }],
    ["ses_a", { ...permissionFixture(), tool: null }],
    ["ses_a", { ...permissionFixture(), tool: { messageID: " ", callID: "call_a" } }],
    ["ses_a", { ...permissionFixture(), tool: { messageID: "msg_assistant", callID: "" } }],
  ] as Array<[string, unknown]>) {
    assert.deepEqual(await client.correlatePermissionTurn(session, request as OpenCodePermissionRequest), { outcome: "correlation_unproven" });
  }
  assert.equal(reads, 0);
});

test("OpenCode permission correlation rejects malformed, ambiguous, and foreign message links", async () => {
  const { assistant, user } = permissionTurnMessages(); const part = assistant.parts[0]!;
  const badAssistants: Array<[string, unknown]> = [
    ["missing envelope", null], ["array envelope", [assistant]], ["missing info", { parts: assistant.parts }],
    ...[{ id: "other" }, { sessionID: "other" }, { sessionID: undefined }, { role: "user" },
      { parentID: undefined }, { parentID: " " }, { parentID: "msg_assistant" }].map(change =>
      [JSON.stringify(change), { ...assistant, info: { ...assistant.info, ...change } }] as [string, unknown]),
    ["missing parts", { info: assistant.info }], ["nonarray parts", { ...assistant, parts: {} }],
    ["no tool part", { ...assistant, parts: [null] }],
    ...[{ id: "" }, { id: undefined }, { type: "text" }, { callID: "other" }, { sessionID: "other" },
      { sessionID: undefined }, { messageID: "other" }, { messageID: undefined }].map(change =>
      [JSON.stringify(change), { ...assistant, parts: [{ ...part, ...change }] }] as [string, unknown]),
    ["duplicate call", { ...assistant, parts: [part, { ...part, id: "second-tool-part" }] }],
  ];
  for (const [name, response] of badAssistants) {
    let reads = 0; const client = nativeClient(async () => { reads += 1; return json(response); });
    assert.deepEqual(await client.correlatePermissionTurn("ses_a", permissionFixture()), { outcome: "correlation_unproven" }, name);
    assert.equal(reads, 1, `${name}: invalid assistant cannot authorize a parent lookup`);
  }
  for (const response of [null, [], {}, ...[{ id: "other" }, { sessionID: "other" }, { sessionID: undefined },
    { role: "assistant" }, { role: undefined }].map(change => ({ ...user, info: { ...user.info, ...change } }))]) {
    let reads = 0; const client = nativeClient(async () => json(++reads === 1 ? assistant : response));
    assert.deepEqual(await client.correlatePermissionTurn("ses_a", permissionFixture()), { outcome: "correlation_unproven" });
    assert.equal(reads, 2);
  }
});

test("OpenCode permission correlation treats missing messages and failed reads as unproven without retry or continuation loss", async () => {
  const { assistant } = permissionTurnMessages();
  for (const hop of [1, 2]) {
    for (const failure of ["404", "401", "500", "bad_json", "transport"] as const) {
      let reads = 0;
      const client = nativeClient(async () => {
        if (++reads !== hop) return json(assistant);
        if (failure === "transport") throw new Error("private-transport-error");
        if (failure === "bad_json") return new Response("private-malformed-body", { status: 200 });
        return json({ error: "private-missing-message" }, Number(failure));
      });
      assert.deepEqual(await client.correlatePermissionTurn("ses_a", permissionFixture()), { outcome: "correlation_unproven" }, `${failure} hop ${hop}`);
      assert.equal(reads, hop, "lookup never retries, lists sessions, or repairs a continuation");
    }
  }
});

test("OpenCode permission correlation snapshots native request identity before awaiting either message", async () => {
  const expected = permissionFixture(); const { assistant, user } = permissionTurnMessages(); const paths: string[] = [];
  const client = nativeClient(async (input) => {
    paths.push(new URL(input).pathname);
    if (paths.length === 1) {
      expected.id = "replacement-request"; expected.sessionID = "replacement-session";
      expected.tool!.messageID = "replacement-message"; expected.tool!.callID = "replacement-call";
      await Promise.resolve(); return json(assistant);
    }
    return json(user);
  });
  assert.deepEqual(await client.correlatePermissionTurn("ses_a", expected), { outcome: "correlated", requestId: "per_a",
    providerContinuationId: "ses_a", providerTurnId: "msg_user", assistantMessageId: "msg_assistant", callId: "call_a" });
  assert.deepEqual(paths, ["/session/ses_a/message/msg_assistant", "/session/ses_a/message/msg_user"]);
});

/**
 * What OpenCode 1.18.20 writes when it compacts a session in the middle of a
 * turn: its compaction request, the summary step, then either a synthetic
 * "continue" message or (after an overflow) a replay of the prompt. Later
 * steps answer that last message, not the prompt that started the turn.
 */
function compactedTurnTranscript(turnId: string, options: {
  replay?: boolean; failedSummary?: boolean; promptBeforeCompaction?: string;
  after?: TranscriptMessage[]; sessionID?: string;
} = {}): TranscriptMessage[] {
  const followUp = options.replay ? "msg_replay" : "msg_continue";
  const prompt = userMessage(turnId);
  prompt.parts.push({ type: "text", text: "room prompt" });
  return [
    prompt,
    assistantWithTool(turnId, "msg_before", 10, { status: "completed", input: { command: "git merge" }, output: "merged" }, "call_before"),
    ...(options.promptBeforeCompaction ? [{ info: { id: options.promptBeforeCompaction, role: "user", time: { created: 15 } },
      parts: [{ type: "text", text: "a later room prompt" }] }] : []),
    { info: { id: "msg_compaction", role: "user", time: { created: 20 } },
      parts: [{ type: "compaction", auto: true, overflow: Boolean(options.replay) }] },
    { info: { id: "msg_summary", role: "assistant", parentID: "msg_compaction", mode: "compaction", agent: "compaction",
      summary: true, time: { created: 21, completed: 22 },
      ...(options.failedSummary ? { error: { name: "ContextOverflowError", data: { message: "too large" } } } : {}) },
    parts: [{ id: "msg_summary-text", type: "text", text: "PRIVATE-COMPACTION-SUMMARY" },
      { id: "msg_summary-finish", type: "step-finish", reason: options.failedSummary ? "error" : "stop" }] },
    { info: { id: followUp, role: "user", time: { created: 30 } },
      parts: options.replay ? [{ type: "text", text: "room prompt" }]
        : [{ type: "text", synthetic: true, metadata: { compaction_continue: true }, text: "Continue if you have next steps." }] },
    ...(options.after ?? []),
  ].map((message) => {
    if (options.sessionID) message.info.sessionID = options.sessionID;
    return message as TranscriptMessage;
  });
}

test("OpenCode permission correlation links a step after a compaction to the room turn it continues", async () => {
  for (const replay of [false, true]) {
    const followUp = replay ? "msg_replay" : "msg_continue";
    const assistant = assistantWithTool(followUp, "msg_assistant", 40,
      { status: "running", input: { filePath: "src/app.mjs" } }, "call_a", "write");
    assistant.info.sessionID = "ses_a";
    Object.assign(assistant.parts[0]!, { sessionID: "ses_a", messageID: "msg_assistant" });
    const transcript = compactedTurnTranscript("msg_user", { replay, sessionID: "ses_a", after: [assistant] });
    const byId = new Map(transcript.map((message) => [String(message.info.id), message]));
    const reads: string[] = []; let fences = 0;
    const client = nativeClient(async (input) => {
      const url = new URL(input); reads.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/session/ses_a/message") return json(transcript);
      const found = byId.get(decodeURIComponent(url.pathname.split("/").at(-1)!));
      return found ? json(found) : json({ error: "missing" }, 404);
    });
    const expected = { ...permissionFixture(), permission: "edit" };

    assert.deepEqual(await client.correlatePermissionTurn("ses_a", expected), { outcome: "correlated", requestId: "per_a",
      providerContinuationId: "ses_a", providerTurnId: followUp, assistantMessageId: "msg_assistant", callId: "call_a" },
    "without an expected turn, the parent message is all the linkage there is");
    assert.equal(reads.length, 2);

    reads.length = 0;
    assert.deepEqual(await client.correlatePermissionTurn("ses_a", expected, () => { fences += 1; }, "msg_user"), {
      outcome: "correlated", requestId: "per_a", providerContinuationId: "ses_a", providerTurnId: "msg_user",
      assistantMessageId: "msg_assistant", callId: "call_a" }, `${followUp} belongs to the prompt it follows`);
    assert.deepEqual(reads, ["/session/ses_a/message/msg_assistant", `/session/ses_a/message/${followUp}`,
      "/session/ses_a/message?limit=128"]);
    assert.equal(fences, 4, "the transcript read is fenced too");

    reads.length = 0;
    assert.equal((await client.correlatePermissionTurn("ses_a", expected, undefined, followUp) as { providerTurnId?: string }).providerTurnId,
      followUp, "an exact parent needs no transcript");
    assert.equal(reads.length, 2);
  }
});

test("OpenCode permission correlation does not carry a step across another prompt or a failed compaction", async () => {
  const cases: Array<[string, Parameters<typeof compactedTurnTranscript>[1]]> = [
    ["a later prompt", { promptBeforeCompaction: "msg_user_2" }],
    ["a failed summary", { failedSummary: true }],
  ];
  for (const [name, options] of cases) {
    const assistant = assistantWithTool("msg_continue", "msg_assistant", 40, { status: "running", input: {} }, "call_a", "write");
    assistant.info.sessionID = "ses_a";
    Object.assign(assistant.parts[0]!, { sessionID: "ses_a", messageID: "msg_assistant" });
    const transcript = compactedTurnTranscript("msg_user", { ...options, sessionID: "ses_a", after: [assistant] });
    const byId = new Map(transcript.map((message) => [String(message.info.id), message]));
    const client = nativeClient(async (input) => {
      const url = new URL(input);
      if (url.pathname === "/session/ses_a/message") return json(transcript);
      const found = byId.get(decodeURIComponent(url.pathname.split("/").at(-1)!));
      return found ? json(found) : json({ error: "missing" }, 404);
    });
    const correlation = await client.correlatePermissionTurn("ses_a", permissionFixture(), undefined, "msg_user");
    assert.equal((correlation as { providerTurnId?: string }).providerTurnId, "msg_continue", name);
  }
  // A transcript that cannot be read proves nothing.
  const { assistant, user } = permissionTurnMessages();
  const client = nativeClient(async (input) => {
    const url = new URL(input);
    if (url.pathname === "/session/ses_a/message") return json({ error: "gone" }, 500);
    return json(url.pathname.endsWith("msg_assistant") ? assistant : user);
  });
  assert.deepEqual(await client.correlatePermissionTurn("ses_a", permissionFixture(), undefined, "msg_other"),
    { outcome: "correlation_unproven" });
});

test("Open Model permission correlation fences process and continuation loss before and during either exact read", async (t) => {
  for (const hop of [0, 1, 2]) {
    for (const loss of ["process_replaced", "process_unknown", "process_exited", "continuation_repaired", "instance_disposed"] as const) {
      await t.test(`${loss} at hop ${hop}`, async (t) => {
        const harness = createHarness(); let identity: string | null | undefined = "opencode-birth-6101";
        const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-permission-correlation-"));
        t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
        const { assistant, user } = permissionTurnMessages("session-open-model-1");
        let reads = 0; let release!: () => void; let readStarted!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { readStarted = resolve; });
        const adapter = new OpenModelProviderAdapter({ runtimeRoot, dependencies: {
          ...harness.dependencies, getProcessIdentity: () => identity,
          fetch: async (input, init) => {
            const match = new URL(input).pathname.match(/^\/session\/[^/]+\/message\/([^/]+)$/);
            if (!match) return harness.dependencies.fetch(input, init);
            if (++reads === hop) { readStarted(); await held; }
            return json(match[1] === "msg_assistant" ? assistant : user);
          },
        } });
        const handle = await adapter.spawn(spawnRequest());
        const expected = permissionFixture("per_a", handle.providerContinuationId!);
        const observations: NativeExecutionObservation[] = []; adapter.onExecution(handle, event => observations.push(event));
        const observer = new AbortController(); let observing: Promise<void> | undefined;
        if (loss === "instance_disposed") {
          let ready!: () => void; const snapshot = new Promise<void>(resolve => { ready = resolve; });
          observing = adapter.observePermissions(handle, event => { if (event.type === "snapshot") ready(); }, observer.signal);
          await snapshot;
        }
        const invalidate = async () => {
          if (loss === "process_replaced") identity = "replacement-birth";
          else if (loss === "process_unknown") identity = undefined;
          else if (loss === "process_exited") identity = null;
          else if (loss === "continuation_repaired") {
            await adapter.repairContinuation(handle, { ...spawnRequest(), expectedProviderContinuationId: handle.providerContinuationId!, forceReplacement: true }, { checkpointReplacement: async () => {} });
          } else { harness.sendEvent({ type: "server.instance.disposed", properties: {} }); await observing; }
        };
        try {
          if (hop === 0) await invalidate();
          const pending = adapter.correlatePermissionTurn(handle, expected);
          if (hop > 0) { await started; await invalidate(); }
          const factsBeforeRelease = observations.length; const stateBeforeRelease = handle.observedState();
          release();
          assert.deepEqual(await pending, { outcome: "correlation_unproven" });
          assert.equal(reads, hop);
          assert.equal(observations.length, factsBeforeRelease, "lookup itself never publishes liveness or execution facts");
          assert.equal(handle.observedState(), stateBeforeRelease);
          assert.deepEqual(harness.permissionReplies, []); assert.deepEqual(harness.promptBodies, []);
          assert.deepEqual(harness.aborts, []); assert.deepEqual(harness.signals, []); assert.equal(harness.launches.length, 1);
        } finally { release(); observer.abort(); await observing; }
      });
    }
  }
});

test("Open Model permission correlation does not use current-turn guesses and rejects foreign, changed, or stopping handles", async (t) => {
  const harness = createHarness(); const { assistant, user } = permissionTurnMessages("session-open-model-1");
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-permission-correlation-handle-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  let reads = 0; let changeConnection = false; let missingMessage: string | null = null;
  let finishExit!: (exit: ProviderProcessExit) => void;
  const exited = new Promise<ProviderProcessExit>(resolve => { finishExit = resolve; });
  const adapter = new OpenModelProviderAdapter({ runtimeRoot, dependencies: {
    ...harness.dependencies, observeProcessExit: () => exited,
    fetch: async (input, init) => {
      const match = new URL(input).pathname.match(/^\/session\/[^/]+\/message\/([^/]+)$/);
      if (!match) return harness.dependencies.fetch(input, init);
      reads += 1;
      if (changeConnection) {
        const connection = handle.providerConnection;
        assert.ok(connection && "url" in connection);
        connection.url = "http://127.0.0.1:9999";
      }
      if (match[1] === missingMessage) return json({ error: "message missing" }, 404);
      return json(match[1] === "msg_assistant" ? assistant : user);
    },
  } });
  const handle: ProviderHandle = await adapter.spawn(spawnRequest());
  const expected = permissionFixture("per_a", handle.providerContinuationId!);
  const observations: NativeExecutionObservation[] = []; adapter.onExecution(handle, event => observations.push(event));
  const initialObservationCount = observations.length;
  (handle as unknown as { activeRoomTurnId: string }).activeRoomTurnId = "unrelated-current-turn";
  assert.deepEqual(await adapter.correlatePermissionTurn(handle, expected), { outcome: "correlated", requestId: "per_a",
    providerContinuationId: handle.providerContinuationId, providerTurnId: "msg_user", assistantMessageId: "msg_assistant", callId: "call_a" });
  assert.equal(reads, 2); assert.equal(observations.length, initialObservationCount);
  for (const foreign of [{ ...handle }, { ...handle, workAttemptId: "foreign" }]) {
    assert.deepEqual(await adapter.correlatePermissionTurn(foreign, expected), { outcome: "correlation_unproven" });
  }
  assert.equal(reads, 2);
  for (const message of ["msg_assistant", "msg_user"]) {
    missingMessage = message; const state = handle.observedState();
    assert.deepEqual(await adapter.correlatePermissionTurn(handle, expected), { outcome: "correlation_unproven" });
    assert.equal(handle.observedState(), state); assert.equal(observations.length, initialObservationCount);
    assert.deepEqual(harness.permissionReplies, []); assert.deepEqual(harness.promptBodies, []);
    assert.deepEqual(harness.aborts, []); assert.deepEqual(harness.signals, []);
    assert.equal(harness.launches.length, 1, "missing messages never repair or restart the native session");
  }
  missingMessage = null;
  assert.equal(reads, 5);
  changeConnection = true;
  assert.deepEqual(await adapter.correlatePermissionTurn(handle, expected), { outcome: "correlation_unproven" });
  assert.equal(reads, 6); assert.equal(observations.length, initialObservationCount);
  const stopped = adapter.stop(handle, { force: true });
  assert.equal(handle.observedState(), "stopping");
  assert.deepEqual(await adapter.correlatePermissionTurn(handle, expected), { outcome: "correlation_unproven" });
  finishExit({ type: "exit", code: null, signal: "SIGKILL" }); await stopped;
  assert.deepEqual(await adapter.correlatePermissionTurn(handle, expected), { outcome: "correlation_unproven" });
  assert.equal(reads, 6); assert.deepEqual(harness.permissionReplies, []); assert.deepEqual(harness.promptBodies, []);
  assert.deepEqual(harness.aborts, []); assert.equal(harness.signals.length, 1, "only the explicitly requested stop signals a process");
});

test("Open Model permission correlation rechecks the exact instance after the client promise resolves", async (t) => {
  const harness = createHarness(); let identity = "opencode-birth-6101";
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-permission-correlation-return-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const adapter = new OpenModelProviderAdapter({ runtimeRoot, dependencies: {
    ...harness.dependencies, getProcessIdentity: () => identity,
  } });
  const handle = await adapter.spawn(spawnRequest());
  const client = (handle as unknown as { client: OpenCodeServerClient }).client;
  const observations: NativeExecutionObservation[] = []; adapter.onExecution(handle, event => observations.push(event));
  const initialObservationCount = observations.length;
  client.correlatePermissionTurn = async (sessionId, request, assertCurrentInstance) => {
    assert.ok(assertCurrentInstance); assertCurrentInstance();
    queueMicrotask(() => { identity = "replacement-birth"; });
    return { outcome: "correlated", requestId: request.id, providerContinuationId: sessionId,
      providerTurnId: "msg_user", assistantMessageId: "msg_assistant", callId: "call_a" };
  };
  const state = handle.observedState();
  assert.deepEqual(await adapter.correlatePermissionTurn(handle, permissionFixture("per_a", handle.providerContinuationId!)),
    { outcome: "correlation_unproven" });
  assert.equal(handle.observedState(), state); assert.equal(observations.length, initialObservationCount);
  assert.deepEqual(harness.permissionReplies, []); assert.deepEqual(harness.promptBodies, []);
  assert.deepEqual(harness.aborts, []); assert.deepEqual(harness.signals, []);
});

test("OpenCode client parses permission SSE records strictly without changing unrelated event handling", async () => {
  const harness = createHarness();
  const asked = { type: "permission.asked", properties: permissionFixture() };
  const replied = { type: "permission.replied", properties: { sessionID: "ses_a", requestID: "per_a", reply: "once" } };
  harness.setStreamEvents([asked, replied]);
  const controller = new AbortController();
  const events = nativeClient(harness.dependencies.fetch).events(controller.signal);
  try {
    assert.equal(parseOpenCodePermissionEvent((await events.next()).value!), null, "server.connected is not a permission");
    assert.deepEqual(parseOpenCodePermissionEvent((await events.next()).value!), asked);
    assert.deepEqual(parseOpenCodePermissionEvent((await events.next()).value!), replied);
  } finally {
    controller.abort();
    await events.return(undefined);
  }
  for (const properties of [null, {}, { ...permissionFixture(), patterns: [1] }, { ...permissionFixture(), tool: null },
    { ...permissionFixture(), metadata: [] }, { ...permissionFixture(), tool: { messageID: "msg_a" } }]) {
    assert.throws(() => parseOpenCodePermissionEvent({ type: "permission.asked", properties }), /malformed permission request/);
  }
  for (const reply of ["always", "reject"]) {
    assert.equal(parseOpenCodePermissionEvent({ ...replied, properties: { ...replied.properties, reply } })?.type, "permission.replied");
  }
  for (const reply of ["allow", ["once"], null]) {
    assert.throws(() => parseOpenCodePermissionEvent({ ...replied, properties: { ...replied.properties, reply } }), /malformed permission reply/);
  }
  const withoutTool = permissionFixture();
  delete withoutTool.tool;
  assert.deepEqual(parseOpenCodePermissionEvent({ type: "permission.asked", properties: withoutTool }), { type: "permission.asked", properties: withoutTool });
});

test("OpenCode client validates the complete permission list and filters the exact session", async () => {
  const harness = createHarness();
  const client = nativeClient(harness.dependencies.fetch);
  harness.setPermissions([permissionFixture(), permissionFixture("per_b", "ses_b")]);
  assert.deepEqual(await client.listPendingPermissions("ses_a"), [permissionFixture()]);
  assert.deepEqual(await client.listPendingPermissions("ses_absent"), []);
  await assert.rejects(client.listPendingPermissions(""), /exact OpenCode session/);
  for (const value of [null, {}, [permissionFixture(), {}], [permissionFixture(), permissionFixture("per_a", "ses_b")]]) {
    harness.setPermissions(value);
    await assert.rejects(client.listPendingPermissions("ses_a"), /malformed|duplicate/);
  }
});

test("OpenCode client uses once or native session-wide reject without widening the launch policy", async () => {
  const harness = createHarness();
  const client = nativeClient(harness.dependencies.fetch);
  harness.setPermissions([permissionFixture(), permissionFixture("per_b"), permissionFixture("per_c", "ses_c")]);
  assert.deepEqual(await client.replyPermission("ses_a", permissionFixture(), "once"), { outcome: "processed", nativeScope: "request" });
  assert.deepEqual(await client.listPendingPermissions("ses_a"), [permissionFixture("per_b")]);
  harness.setPermissions([permissionFixture(), permissionFixture("per_b"), permissionFixture("per_c", "ses_c")]);
  assert.deepEqual(await client.replyPermission("ses_a", permissionFixture(), "reject"), { outcome: "processed", nativeScope: "session_pending" });
  assert.deepEqual(await client.listPendingPermissions("ses_a"), []);
  assert.deepEqual(await client.listPendingPermissions("ses_c"), [permissionFixture("per_c", "ses_c")]);
  assert.deepEqual(harness.permissionReplies, [{ requestId: "per_a", reply: "once" }, { requestId: "per_a", reply: "reject" }]);
  assert.equal(harness.launches.length, 0);
  assert.deepEqual(harness.signals, []);
  assert.deepEqual(harness.aborts, []);
});

test("OpenCode client refuses foreign, missing, widened, or changed permission requests before POST", async () => {
  const harness = createHarness();
  const client = nativeClient(harness.dependencies.fetch);
  harness.setPermissions([permissionFixture()]);
  await assert.rejects(client.replyPermission("ses_b", permissionFixture(), "once"), /exact session/);
  await assert.rejects(client.replyPermission("ses_a", permissionFixture(), "always" as "once"), /once or reject/);
  harness.setPermissions([permissionFixture("per_a", "ses_b")]);
  await assert.rejects(client.replyPermission("ses_a", permissionFixture(), "once"), (error: unknown) =>
    error instanceof OpenCodePermissionReplyError && error.outcome === "not_pending");
  for (const changed of [
    { ...permissionFixture(), metadata: { command: "npm publish" } },
    { ...permissionFixture(), patterns: ["npm publish"] },
    { ...permissionFixture(), tool: { messageID: "msg_other", callID: "call_a" } },
  ]) {
    harness.setPermissions([changed]);
    await assert.rejects(client.replyPermission("ses_a", permissionFixture(), "once"), (error: unknown) =>
      error instanceof OpenCodePermissionReplyError && error.outcome === "request_changed");
  }
  assert.deepEqual(harness.permissionReplies, []);
});

test("OpenCode client snapshots expected permission fields before the re-list await", async () => {
  const expected = permissionFixture();
  let returnList!: (response: Response) => void;
  let posts = 0;
  const client = nativeClient(async (_input, init) => {
    if (init?.method === "POST") { posts += 1; return json(true); }
    return await new Promise<Response>((resolve) => { returnList = resolve; });
  });
  const reply = client.replyPermission("ses_a", expected, "once");
  expected.metadata.command = "npm publish";
  returnList(json([expected]));
  await assert.rejects(reply, (error: unknown) => error instanceof OpenCodePermissionReplyError && error.outcome === "request_changed");
  assert.equal(posts, 0, "mutating the caller snapshot cannot authorize newly listed parameters");
});

test("OpenCode client preserves uncertain permission dispatch and does not retry it", async () => {
  for (const response of [() => json(false), () => json({ message: "private provider detail" }, 500),
    () => { throw new Error("private transport detail"); }]) {
    let posts = 0;
    const client = nativeClient(async (_input, init) => {
      if (init?.method !== "POST") return json([permissionFixture()]);
      posts += 1;
      return response();
    });
    await assert.rejects(client.replyPermission("ses_a", permissionFixture(), "once"), (error: unknown) => {
      assert.ok(error instanceof OpenCodePermissionReplyError);
      assert.equal(error.outcome, "uncertain");
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
    assert.equal(posts, 1);
  }
  const missing = nativeClient(async (_input, init) => init?.method === "POST"
    ? json({ _tag: "PermissionNotFoundError", requestID: "per_a" }, 404)
    : json([permissionFixture()]));
  await assert.rejects(missing.replyPermission("ses_a", permissionFixture(), "once"), (error: unknown) =>
    error instanceof OpenCodePermissionReplyError && error.outcome === "not_pending");
});

test("Open Model permission dispatch fences the awaited broker hook before native POST", async () => {
  const harness = createHarness();
  let identity: string | undefined = "opencode-birth-6101";
  const root = await mkdtemp(join(tmpdir(), "letagents-permission-hook-"));
  try {
    const adapter = new OpenModelProviderAdapter({ runtimeRoot: root, dependencies: { ...harness.dependencies, getProcessIdentity: () => identity } });
    const handle = await adapter.spawn(spawnRequest());
    const expected = permissionFixture("per_hook", handle.providerContinuationId!);
    harness.setPermissions([expected]);
    let syncChecks = 0;
    await assert.rejects(adapter.replyPermission(handle, expected, "once", {
      beforeNativeDispatch: async () => { identity = undefined; }, assertNativeDispatch: () => { syncChecks++; },
    }), { outcome: "not_dispatched" });
    assert.equal(syncChecks, 0); assert.equal(harness.permissionReplies.length, 0);
    identity = "opencode-birth-6101";
    await assert.rejects(adapter.replyPermission(handle, expected, "once", {
      beforeNativeDispatch: async () => {}, assertNativeDispatch: () => { throw new Error("broker closed"); },
    }), /broker closed/);
    assert.equal(harness.permissionReplies.length, 0);
    await adapter.replyPermission(handle, expected, "once", {
      beforeNativeDispatch: async () => {}, assertNativeDispatch: () => { syncChecks++; },
    });
    assert.equal(syncChecks, 1); assert.equal(harness.permissionReplies.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Open Model decisions use the exact live handle and retain native once/reject scope without other actions", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const first = permissionFixture("per_first", handle.providerContinuationId!);
  const second = permissionFixture("per_second", handle.providerContinuationId!);
  const foreign = permissionFixture("per_foreign", "another-session");
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setPermissions([first, second, foreign]);
  await assert.rejects(adapter.replyPermission(handle, foreign, "once"), /exact session/);
  await assert.rejects(adapter.replyPermission(handle, first, "always" as "once"), /once or reject/);
  assert.deepEqual(await adapter.replyPermission(handle, first, "once"), { outcome: "processed", nativeScope: "request" });
  await assert.rejects(adapter.replyPermission(handle, first, "once"), (error: unknown) =>
    error instanceof OpenCodePermissionReplyError && error.outcome === "not_pending");
  assert.deepEqual(await adapter.replyPermission(handle, second, "reject"), { outcome: "processed", nativeScope: "session_pending" });
  assert.deepEqual(await nativeClient(harness.dependencies.fetch).listPendingPermissions(foreign.sessionID), [foreign]);
  assert.deepEqual(harness.permissionReplies, [{ requestId: first.id, reply: "once" }, { requestId: second.id, reply: "reject" }]);
  assert.deepEqual(observations.map(({ fact }) => fact), [{
    domain: "runtime",
    kind: "state_changed",
    state: "ready",
    sideEffects: "none",
  }], "native approval data never enters execution facts");
  assert.deepEqual(harness.promptBodies, []);
  assert.deepEqual(harness.aborts, []);
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1);
  assert.equal(adapter.capabilities().permissionPromptBridging, false);
});

test("Open Model fences permission decisions before lookup and again after its awaited result", async (t) => {
  for (const phase of ["before", "during_get"] as const) {
    for (const loss of ["process_replaced", "process_unverifiable", "process_exited", "continuation_repaired", "instance_disposed"] as const) {
      await t.test(`${loss} ${phase}`, async () => {
        const harness = createHarness();
        let identity: string | null | undefined = "opencode-birth-6101";
        let holdList = false;
        let reads = 0;
        let releaseList!: (response: Response) => void;
        let startedList!: () => void;
        const started = new Promise<void>((resolve) => { startedList = resolve; });
        const adapter = new OpenModelProviderAdapter({ runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-permission-fence-")), dependencies: {
          ...harness.dependencies,
          getProcessIdentity: () => identity,
          fetch: (input, init) => {
            if (new URL(input).pathname === "/permission") {
              reads += 1;
              if (holdList) { startedList(); return new Promise((resolve) => { releaseList = resolve; }); }
            }
            return harness.dependencies.fetch(input, init);
          },
        } });
        const handle = await adapter.spawn(spawnRequest());
        const expected = permissionFixture("per_old", handle.providerContinuationId!);
        harness.setPermissions([expected]);
        const observer = new AbortController();
        let observing: Promise<void> | undefined;
        if (loss === "instance_disposed") {
          let snapshot!: () => void;
          const ready = new Promise<void>((resolve) => { snapshot = resolve; });
          observing = adapter.observePermissions(handle, (event) => { if (event.type === "snapshot") snapshot(); }, observer.signal);
          await ready;
        }
        const invalidate = async () => {
          if (loss === "process_replaced") identity = "different-process-birth";
          else if (loss === "process_unverifiable") identity = undefined;
          else if (loss === "process_exited") identity = null;
          else if (loss === "continuation_repaired") {
            await adapter.repairContinuation(handle, { ...spawnRequest(), expectedProviderContinuationId: handle.providerContinuationId!, forceReplacement: true }, { checkpointReplacement: async () => {} });
          } else {
            harness.sendEvent({ type: "server.instance.disposed", properties: {} });
            await observing;
          }
        };
        try {
          const baselineReads = reads;
          if (phase === "before") await invalidate();
          holdList = phase === "during_get";
          const rejected = assert.rejects(adapter.replyPermission(handle, expected, "once"), (error: unknown) =>
            error instanceof OpenCodePermissionReplyError && error.outcome === "not_dispatched");
          if (phase === "during_get") {
            await started;
            await invalidate();
            releaseList(json([expected]));
          }
          await rejected;
          assert.equal(reads - baselineReads, phase === "before" ? 0 : 1);
          assert.deepEqual(harness.permissionReplies, []);
          assert.deepEqual(harness.promptBodies, []);
          assert.deepEqual(harness.signals, []);
          assert.deepEqual(harness.aborts, []);
          assert.equal(harness.launches.length, 1);
        } finally { observer.abort(); await observing; }
      });
    }
  }
});

test("Open Model cannot approve a stopping or already stopped provider", async () => {
  const harness = createHarness();
  let finishExit!: (exit: ProviderProcessExit) => void;
  const exited = new Promise<ProviderProcessExit>((resolve) => { finishExit = resolve; });
  const adapter = new OpenModelProviderAdapter({ runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-permission-stop-")), dependencies: {
    ...harness.dependencies, observeProcessExit: () => exited,
  } });
  const handle = await adapter.spawn(spawnRequest());
  const expected = permissionFixture("per_old", handle.providerContinuationId!);
  harness.setPermissions([expected]);
  const stopped = adapter.stop(handle, { force: true });
  assert.equal(handle.observedState(), "stopping");
  const refuses = () => assert.rejects(adapter.replyPermission(handle, expected, "once"), (error: unknown) =>
    error instanceof OpenCodePermissionReplyError && error.outcome === "not_dispatched");
  await refuses();
  finishExit({ type: "exit", code: null, signal: "SIGKILL" });
  await stopped;
  await refuses();
  assert.deepEqual(harness.permissionReplies, []);
});

test("Open Model preserves uncertainty when provider identity changes after permission POST", async (t) => {
  for (const outcome of ["processed", "missing", "response_lost", "body_replaced", "unverifiable", "single_unverifiable_probe", "continuation_repaired"] as const) {
    await t.test(outcome, async () => {
      const harness = createHarness();
      let identity: string | undefined = "opencode-birth-6101";
      let missNextProof = false;
      let afterPost!: () => Promise<void>;
      const adapter = new OpenModelProviderAdapter({ runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-permission-uncertain-")), dependencies: {
        ...harness.dependencies,
        getProcessIdentity: () => {
          if (missNextProof) { missNextProof = false; return undefined; }
          return identity;
        },
        fetch: async (input, init) => {
          const response = await harness.dependencies.fetch(input, init);
          if (!new URL(input).pathname.endsWith("/reply")) return response;
          if (outcome === "body_replaced") {
            return new Response(new ReadableStream({ start(controller) {
              queueMicrotask(() => { identity = "new-birth"; controller.enqueue(new TextEncoder().encode("true")); controller.close(); });
            } }));
          }
          await afterPost();
          if (outcome === "response_lost") throw new Error("private transport detail");
          return outcome === "missing" ? json({}, 404) : response;
        },
      } });
      const handle = await adapter.spawn(spawnRequest());
      const expected = permissionFixture("per_old", handle.providerContinuationId!);
      harness.setPermissions([expected]);
      afterPost = async () => {
        if (outcome === "continuation_repaired") {
          await adapter.repairContinuation(handle, { ...spawnRequest(), expectedProviderContinuationId: handle.providerContinuationId!, forceReplacement: true }, { checkpointReplacement: async () => {} });
        } else if (outcome === "single_unverifiable_probe") missNextProof = true;
        else identity = outcome === "unverifiable" ? undefined : "new-birth";
      };
      await assert.rejects(adapter.replyPermission(handle, expected, "once"), (error: unknown) => {
        assert.ok(error instanceof OpenCodePermissionReplyError);
        assert.equal(error.outcome, "uncertain");
        assert.doesNotMatch(error.message, /private/);
        return true;
      });
      assert.equal(harness.permissionReplies.length, 1, "never replay an ambiguous decision");
      assert.deepEqual(harness.promptBodies, []);
      assert.deepEqual(harness.signals, []);
      assert.deepEqual(harness.aborts, []);
      assert.equal(harness.launches.length, 1);
    });
  }
});

test("OpenCode control probe validates authenticated health and keeps failures degraded, never runtime-lost", async () => {
  const healthy = nativeClient(async (input, init) => {
    assert.equal(new URL(input).pathname, "/global/health");
    assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:client-test").toString("base64")}`);
    assert.ok(init?.signal);
    return json({ healthy: true, version: "1.18.20" });
  });
  assert.deepEqual(await healthy.probeControl(), { state: "responsive", version: "1.18.20" });
  const cases = [
    { fetch: async () => json({ healthy: true }), reason: "invalid_response" },
    { fetch: async () => json({ healthy: false, version: "1.18.20" }), reason: "invalid_response" },
    { fetch: async () => new Response("not JSON"), reason: "invalid_response" },
    { fetch: async () => json({}, 401), reason: "authentication_failed" },
    { fetch: async () => json({}, 503), reason: "http_error" },
    { fetch: async () => { throw new Error("private", { cause: Object.assign(new Error("private"), { code: "ECONNREFUSED" }) }); }, reason: "transport_refused" },
    { fetch: async () => { throw new Error("ECONNREFUSED is not structured evidence"); }, reason: "transport_error" },
  ];
  for (const fixture of cases) assert.deepEqual(await nativeClient(fixture.fetch).probeControl(), { state: "degraded", reason: fixture.reason });
  assert.equal(await nativeClient(async () => json({})).health(), true, "legacy startup health keeps its established behavior");
});

test("OpenCode control probe bounds stalled headers or bodies without stopping work", async () => {
  const never = () => new Promise<Response>(() => {});
  const controller = new AbortController();
  const aborted = nativeClient(never).probeControl(controller.signal);
  controller.abort();
  assert.deepEqual(await aborted, { state: "degraded", reason: "aborted" });
  const keepAlive = setInterval(() => undefined, 50);
  try {
    const started = Date.now();
    const results = await Promise.all([
      nativeClient(never).probeControl(),
      nativeClient(async () => new Response(new ReadableStream({ start() {} }))).probeControl(),
    ]);
    assert.deepEqual(results, [{ state: "degraded", reason: "timeout" }, { state: "degraded", reason: "timeout" }]);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    clearInterval(keepAlive);
  }
});

test("Open Model emits exact structural tool outcomes before display without promoting tool failures to runtime failures", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  const order: string[] = [];
  adapter.onExecution(handle, (event) => { observations.push(event); order.push(`fact:${event.fact.domain}:${event.fact.kind}`); });
  adapter.onStream(handle, (event) => { if (event.kind === "tool_lifecycle") order.push("display:tool"); });
  harness.holdTurnOpenWithTranscript();
  harness.setTranscriptFactories([
    (turnId) => [assistantWithTool(turnId, "assistant-tool", 10, { status: "running", input: { command: "secret command" } })],
    (turnId) => [
      assistantWithTool(turnId, "assistant-tool", 10, { status: "error", input: { command: "secret command" }, error: "private error or permission denied" }),
      assistantMessage(turnId, "assistant-final", 20, "Recovered normally."),
    ],
  ]);
  harness.setStreamEvents([{ type: "session.idle", properties: { sessionID: handle.providerContinuationId } }]);
  const result = await adapter.runRoomTurn(handle, { inboxItemId: "typed-tool", sourceMessage: {}, activation: {}, actionId: "typed-tool" });
  const facts = observations.map((event) => event.fact);
  assert.equal(result.outcome, "reply");
  assert.equal(facts.some((fact) => fact.domain === "execution" && fact.kind === "started"), false, "running can still be waiting for permission");
  assert.deepEqual(facts.filter((fact) => fact.domain === "execution"), [{
    domain: "execution", kind: "completed", executionId: "call-1", operation: "command", sideEffects: "possible", outcome: "failed",
    providerContinuationId: handle.providerContinuationId, providerTurnId: result.turnId,
  }]);
  assert.ok(order.indexOf("fact:execution:completed") < order.lastIndexOf("display:tool"));
  assert.equal(facts.some((fact) => fact.domain === "runtime" && fact.state === "exited"), false);
  assert.equal(facts.some((fact) => fact.domain === "turn" && fact.turnOutcome === "failed"), false);
  assert.ok(facts.some((fact) => fact.domain === "turn" && fact.state === "terminal" && fact.turnOutcome === "completed"));
  assert.doesNotMatch(JSON.stringify(observations), /secret command|private error|permission denied|Recovered normally/);
  assert.ok(observations.every((event, index) => event.sequence === index + 1 && event.nativeProcessIdentity === "opencode-birth-6101"));
  const protocolModule = new URL("../../daemon/execution-protocol.ts", import.meta.url).href;
  const { parseExecutionFact } = await import(protocolModule);
  observations.forEach((event, index) => parseExecutionFact({ ...event.fact, factId: `fact_${index}`, agentId: "agent", executionGenerationId: "generation", runtimeGenerationId: "runtime", observerEpoch: 1, sourceSequence: event.sequence, observedAtMs: event.observedAtMs,
    ...("providerTurnId" in event.fact ? { turnId: "turn_internal" } : {}),
  }));
  assert.equal(harness.launches.length, 1);
  assert.deepEqual(harness.aborts, []);
});

test("Open Model typed turns preserve native model errors, next-turn reuse, and empty/no-reply outcomes", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setTranscriptFactories([(turnId) => [{ info: { id: "assistant_error", role: "assistant", parentID: turnId, time: { completed: 11 }, error: { name: "APIError", data: { statusCode: 429 } } }, parts: [] }]]);
  await assert.rejects(adapter.runRoomTurn(handle, { inboxItemId: "model-error", sourceMessage: {}, activation: {}, actionId: "model-error" }));
  assert.ok(observations.some(({ fact }) => fact.domain === "turn" && fact.turnOutcome === "failed"));
  harness.setTranscriptFactories([(turnId) => [assistantMessage(turnId, "assistant_no_reply", 20, "LETAGENTS_NO_ROOM_REPLY")]]);
  const noReply = await adapter.runRoomTurn(handle, { inboxItemId: "no-reply", sourceMessage: {}, activation: {}, actionId: "no-reply" });
  assert.equal(noReply.outcome, "no_reply");
  assert.ok(observations.some(({ fact }) => fact.domain === "turn" && fact.providerTurnId === noReply.turnId && fact.turnOutcome === "completed"));
  harness.setTranscriptFactories([(turnId) => [assistantMessage(turnId, "assistant_empty", 30, null)]]);
  const empty = await adapter.runRoomTurn(handle, { inboxItemId: "empty", sourceMessage: {}, activation: {}, actionId: "empty" });
  assert.equal(empty.outcome, "failed", "a finished step without text cannot become readable on a re-read");
  assert.ok(observations.some(({ fact }) => fact.domain === "turn" && fact.providerTurnId === empty.turnId && fact.turnOutcome === "failed"));
  assert.equal(observations.some(({ fact }) => fact.domain === "runtime" && fact.state === "exited"), false);
  assert.equal(harness.launches.length, 1);
});

test("Open Model session errors do not invent an exact typed or legacy terminal", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  const stream: ProviderStreamEvent[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  adapter.onStream(handle, (event) => stream.push(event));
  harness.setTranscriptFactories([() => []]);
  harness.setStreamEvents([{ type: "session.error", properties: { sessionID: handle.providerContinuationId } }]);

  const result = await adapter.runRoomTurn(handle,
    { inboxItemId: "session-error", sourceMessage: {}, activation: {}, actionId: "session-error" });
  assert.equal(result.outcome, "unreadable");
  assert.equal(observations.some(({ fact }) => fact.domain === "turn" && fact.state === "terminal"), false);
  assert.equal(stream.some((event) => event.lifecycleProjectionOnly && event.nativeLifecyclePhase === "turn_terminal"), false);
});

test("an Open Model turn whose last step ended on tool calls is recorded as ended once its session reports idle", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const turnFacts = (turnId: string) => observations.flatMap(({ fact }) => fact.domain === "turn" && fact.providerTurnId === turnId
    ? [[fact.state, "turnOutcome" in fact ? fact.turnOutcome : undefined]] : []);

  // The model answers and calls a tool in its last step; the session then goes idle.
  harness.holdTurnOpenWithTranscript();
  harness.setTranscriptFactories([(turnId) => [assistantMessage(turnId, "assistant-final", 10, "Answered, and posted it with a tool.", "tool-calls")]]);
  harness.setStreamEvents([{ type: "session.idle", properties: { sessionID: handle.providerContinuationId } }]);
  const first = await adapter.runRoomTurn(handle, { inboxItemId: "tool-ending", sourceMessage: {}, activation: {}, actionId: "tool-ending" });
  assert.equal(first.outcome, "reply", "the turn settles with its answer, as before");
  assert.deepEqual(turnFacts(first.turnId).at(-1), ["terminal", "completed"],
    "and its ending is recorded: left open, it would refuse the agent's next turn in the record");

  // The same last step with nothing readable: the turn is over all the same.
  harness.setTranscriptFactories([(turnId) => [assistantMessage(turnId, "assistant-tool-only", 20, null, "tool-calls")]]);
  harness.setStreamEvents([{ type: "session.idle", properties: { sessionID: handle.providerContinuationId } }]);
  const second = await adapter.runRoomTurn(handle, { inboxItemId: "tool-only-ending", sourceMessage: {}, activation: {}, actionId: "tool-only-ending" });
  assert.equal(second.outcome, "unreadable");
  assert.deepEqual(turnFacts(second.turnId).at(-1), ["terminal", "unreadable"]);

  // A last step whose tool call never returned: what the model said before the call is not its answer.
  harness.setTranscriptFactories([(turnId) => [toolStep(turnId, "assistant-tool-running", 30, "I will inspect the files.", "running")]]);
  harness.setStreamEvents([{ type: "session.idle", properties: { sessionID: handle.providerContinuationId } }]);
  const third = await adapter.runRoomTurn(handle, { inboxItemId: "tool-running", sourceMessage: {}, activation: {}, actionId: "tool-running" });
  assert.equal(third.outcome, "interrupted", "the turn has no answer");
  assert.equal(third.text, null, "and the text before the call is not published as one");
  assert.deepEqual(turnFacts(third.turnId).at(-1), ["terminal", "interrupted"], "its ending says it was cut off, not completed");
  assert.equal(observations.filter(({ fact }) => fact.domain === "turn" && fact.state === "terminal").length, 3, "one ending per turn");
});

test("a re-read Open Model turn the record still holds open is recorded as ended when its last step ended on tool calls", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const endings = () => observations.flatMap(({ fact }) => fact.domain === "turn" && fact.state === "terminal"
    ? [[fact.providerTurnId, "turnOutcome" in fact ? fact.turnOutcome : undefined]] : []);

  // The owner's shape: the turn's only step called a tool and nothing followed; the session is not busy.
  harness.setTranscriptFactories([(turnId) => [assistantMessage(turnId, "assistant-tool-only", 10, null, "tool-calls")]]);
  const first = await adapter.runRoomTurn(handle, { inboxItemId: "left-open", sourceMessage: {}, activation: {}, actionId: "left-open" });
  assert.equal(first.outcome, "unreadable");
  assert.deepEqual(endings(), [], "a missing status entry alone still invents no ending");

  const plain = await adapter.recoverRoomTurn(handle, { inboxItemId: "left-open", providerTurnId: first.turnId });
  assert.equal(plain.outcome, "unreadable");
  assert.deepEqual(endings(), [], "and neither does a re-read the daemon did not ask to close");

  const closing = await adapter.recoverRoomTurn(handle, { inboxItemId: "left-open", providerTurnId: first.turnId, recordEnding: true });
  assert.equal(closing.outcome, "unreadable", "the answer read back is the same");
  assert.deepEqual(endings(), [[first.turnId, "unreadable"]], "but the record's open turn is closed, so the next turn is accepted");

  await adapter.recoverRoomTurn(handle, { inboxItemId: "left-open", providerTurnId: first.turnId, recordEnding: true });
  assert.equal(endings().length, 1, "once");
});

for (const ending of ["idle", "reread", "open"] as const) {
  const title = ending === "idle" ? "is closed in the record when OpenCode reports the session idle, and the next turn is recorded"
    : ending === "reread" ? "is closed in the record when the daemon re-reads it as a turn its record holds open, and the next turn is recorded"
      : "stays open in the record on a re-read the daemon did not ask to close, and refuses the next turn";
  test(`an Open Model turn whose last step ended on tool calls ${title}`, async () => {
    // The real adapter over the fake OpenCode server, feeding the real execution capture and shadow store.
    const { DatabaseSync } = await import("node:sqlite");
    const { DaemonStateSchema } = await import(new URL("../../daemon/daemon-state-database.ts", import.meta.url).href);
    const { ExecutionCaptureCoordinator } = await import(new URL("../../daemon/execution-capture-coordinator.ts", import.meta.url).href);
    const { ExecutionShadowStore, executionRuntimeStorageIdentity } = await import(new URL("../../daemon/execution-shadow-store.ts", import.meta.url).href);
    const { adapter, handle, harness } = await spawnAdapter({ lifecycleAuthorityMode: "typed" });
    const at = "2026-08-31T00:00:00.000Z";
    const attempt = handle.workAttemptId;
    const generation = "generation-open-model-1";
    const connection = handle.providerConnection!;
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    new DaemonStateSchema().createSchema(db);
    db.exec(`INSERT INTO agent_identities VALUES('agent','owner','${at}',0);
      INSERT INTO agent_configurations(agent_id,provider,charter,delivery_mode,provider_launch_policy_present,provider_launch_policy_undefined,config_revision,runtime_configuration_revision)
        VALUES('agent','open-model','charter','daemon_inbox',0,0,1,1);
      INSERT INTO work_attempts(work_attempt_id,task_id,lease_id,current_lease_epoch,workspace_path,workspace_repo,workspace_remote_url,workspace_resolved_revision,workspace_bare_path,state,created_at)
        VALUES('${attempt}','task','lease',1,'/private/workspace','repo','remote','revision','/private/bare','active','${at}');
      INSERT INTO work_attempt_executions VALUES('${generation}','${attempt}','${at}','test',1,NULL);`);
    db.prepare(`INSERT INTO runtime_deployments(agent_id,observed_state,workspace_path_present,work_attempt_id_present,work_attempt_id,
      provider_ref_present,provider_work_attempt_id,provider_continuation_id,provider_connection_kind,provider_connection_pid,
      provider_process_identity_present,provider_process_identity,provider_execution_generation_id,workplace_liveness_present,native_liveness_present,activity_present)
      VALUES('agent','idle',0,1,?,1,?,?,'opencode_server',?,1,?,?,0,0,0)`)
      .run(attempt, attempt, handle.providerContinuationId, connection.pid, connection.processIdentity!, generation);
    new ExecutionShadowStore(db).registerRuntime({ agentId: "agent", executionGenerationId: generation,
      runtimeGenerationId: executionRuntimeStorageIdentity("agent", generation, "opencode_server", connection.pid!, connection.processIdentity!),
      provider: "open-model", authorityMode: "typed", configRevision: 1, createdAtMs: Date.parse(at) });
    const current = { workAttemptId: attempt, pid: handle.pid, providerContinuationId: handle.providerContinuationId,
      providerConnection: connection, observedState: "idle" as const, appliedConfigurationRevision: 1 };
    const diagnostics: string[] = [];
    const capture = new ExecutionCaptureCoordinator(db, {
      provider: { onExecution: (_handle: object, listener: (event: NativeExecutionObservation) => void) => adapter.onExecution(handle, listener) },
      currentHandle: () => current, daemonGeneration: () => 1, diagnostic: (_id: string, code: string) => diagnostics.push(code),
    });
    capture.install(Object.freeze({ nonce: Symbol("installation"), listenerLeaseNonce: Symbol("lease"), entryId: "agent", handle: current,
      executionGenerationId: generation, workAttemptId: attempt, providerContinuationId: handle.providerContinuationId!,
      providerConnection: { ...connection }, configurationRevision: 1, authorityMode: "typed" }));
    /** The daemon saves which message a native turn belongs to when the adapter reports the turn started. */
    const bindTurn = async (turnId: string) => {
      const order = Number(db.prepare("SELECT COUNT(*) n FROM supervised_agent_inbox").get()!.n) + 1;
      db.prepare(`INSERT INTO supervised_agent_inbox(inbox_item_id,agent_id,room_id,source_message_id,source_message_json,activation_json,fifo_sequence,state,attempt_count,action_id,reply_client_message_id,provider_turn_id,created_at,updated_at)
        VALUES(?,'agent','room',?,'{}','{}',?,'awaiting_result',1,?,?,?,?,?)`).run(turnId, `message-${order}`, order, `action-${order}`, `reply-${order}`, turnId, at, at);
      db.prepare("INSERT INTO supervised_agent_provider_turn_bindings VALUES(?,'agent','room',?,?,?,?)").run(turnId, attempt, generation, handle.providerContinuationId, turnId);
      capture.refresh("agent");
    };
    const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
    const turns = () => db.prepare("SELECT provider_turn_id,state FROM execution_turns ORDER BY rowid").all().map((turn) => ({ ...turn }));
    const run = (inboxItemId: string) => adapter.runRoomTurn(handle, { inboxItemId, sourceMessage: {}, activation: {}, actionId: inboxItemId },
      { beforeNativeDispatch: async () => {}, checkpointTurnStarted: bindTurn });
    try {
      // The owner's shape: the turn's only step called a tool, and nothing followed it.
      harness.setTranscriptFactories([(turnId) => [assistantMessage(turnId, "assistant-tool-only", 10, null, "tool-calls")]]);
      if (ending === "idle") {
        harness.holdTurnOpenWithTranscript();
        harness.setStreamEvents([{ type: "session.idle", properties: { sessionID: handle.providerContinuationId } }]);
      }
      const one = await run("inbox-1");
      assert.equal(one.outcome, "unreadable");
      await settle();
      assert.deepEqual(turns(), [{ provider_turn_id: one.turnId, state: ending === "idle" ? "terminal" : "active" }]);
      if (ending !== "idle") {
        // The daemon re-reads an unreadable turn once before it blocks the message.
        const reread = await adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-1", providerTurnId: one.turnId,
          ...(ending === "reread" ? { recordEnding: true } : {}) });
        assert.equal(reread.outcome, "unreadable");
        await settle();
      }
      db.prepare("UPDATE supervised_agent_inbox SET state='blocked' WHERE inbox_item_id=?").run(one.turnId);
      const closed = ending !== "open";
      assert.deepEqual(turns(), [{ provider_turn_id: one.turnId, state: closed ? "terminal" : "active" }]);

      // The next turn.
      harness.setTranscriptFactories([(turnId) => [assistantMessage(turnId, "assistant-next", 20, "Answered.")]]);
      harness.setStreamEvents([{ type: "session.idle", properties: { sessionID: handle.providerContinuationId } }]);
      const two = await run("inbox-2");
      assert.equal(two.outcome, "reply");
      await settle();
      const position = { ...db.prepare("SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers").get()! };
      const stops = diagnostics.filter((code) => ["source_gap", "invalid_observation", "retention_limit"].includes(code));
      if (closed) {
        assert.deepEqual(turns(), [{ provider_turn_id: one.turnId, state: "terminal" }, { provider_turn_id: two.turnId, state: "terminal" }],
          "the next turn is recorded");
        assert.equal(position.max, position.last, "with no gap");
        assert.deepEqual(stops, [], "and the record never stops");
      } else {
        assert.deepEqual(turns(), [{ provider_turn_id: one.turnId, state: "active" }], "the open turn refuses the next one");
        assert.ok(Number(position.max) > Number(position.last), "and the record has a gap from here on");
        assert.ok(stops.includes("invalid_observation"));
      }
    } finally {
      capture.close();
    }
  });
}

test("Open Model does not invent a typed terminal from the legacy tool-child session fallback", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setTranscriptFactories([(turnId) => [assistantMessage(turnId, "assistant_tool_only", 10, null, "tool-calls")]]);
  const result = await adapter.runRoomTurn(handle, { inboxItemId: "tool-only", sourceMessage: {}, activation: {}, actionId: "tool-only" });
  assert.equal(result.outcome, "unreadable", "legacy delivery behavior is unchanged");
  assert.equal(observations.some(({ fact }) => fact.domain === "turn" && fact.state === "terminal"), false);
});

test("Open Model control probes distinguish degraded transport from exact native process replacement", async () => {
  const harness = createHarness();
  let identity: string | null | undefined = "opencode-birth-6101";
  let refused = false;
  let replaceWhileResponding = false;
  const adapter = new OpenModelProviderAdapter({ runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-control-probe-")), dependencies: {
    ...harness.dependencies,
    getProcessIdentity: () => identity,
    fetch: async (input, init) => {
      if (new URL(input).pathname === "/global/health" && refused) throw Object.assign(new Error("private network detail"), { code: "ECONNREFUSED" });
      if (replaceWhileResponding) identity = "different-birth";
      return harness.dependencies.fetch(input, init);
    },
  } });
  const handle = await adapter.spawn(spawnRequest());
  assert.deepEqual(await adapter.probeControl(handle), { state: "responsive" });
  refused = true;
  assert.deepEqual(await adapter.probeControl(handle), { state: "degraded" });
  identity = undefined;
  assert.deepEqual(await adapter.probeControl(handle), { state: "degraded" });
  identity = "opencode-birth-6101";
  refused = false;
  replaceWhileResponding = true;
  assert.deepEqual(await adapter.probeControl(handle), { state: "lost", controlEvidence: "process_birth_changed" });
  assert.deepEqual(harness.signals, []);
  assert.deepEqual(harness.aborts, []);
  assert.equal(harness.launches.length, 1);
});

test("Open Model permission observation re-lists after reconnect and never makes decisions or native turns", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const first = permissionFixture("per_first", handle.providerContinuationId!);
  const second = permissionFixture("per_second", handle.providerContinuationId!);
  harness.setPermissions([first, permissionFixture("per_other", "other-session")]);
  const events: OpenCodePermissionObservation[] = [];
  const controller = new AbortController();
  let sawFirst!: () => void;
  const firstSnapshot = new Promise<void>((resolve) => { sawFirst = resolve; });
  let sawSecond!: () => void;
  const secondSnapshot = new Promise<void>((resolve) => { sawSecond = resolve; });
  const observing = adapter.observePermissions(handle, (event) => {
    events.push(event);
    if (event.type !== "snapshot") return;
    if (event.requests[0]?.id === first.id) sawFirst();
    if (event.requests[0]?.id === second.id) { sawSecond(); controller.abort(); }
  }, controller.signal);
  await firstSnapshot;
  harness.setPermissions([second]);
  harness.closeEvents();
  await secondSnapshot;
  await observing;
  assert.deepEqual(events.filter((event) => event.type === "snapshot").map((event) => event.requests.map((request) => request.id)), [[first.id], [second.id]]);
  assert.equal(harness.eventConnections, 2);
  assert.equal(harness.activeEventStreams, 0);
  assert.deepEqual(harness.permissionReplies, []);
  assert.deepEqual(harness.promptBodies, []);
  assert.deepEqual(harness.aborts, []);
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1);
});

test("Open Model consumes permission SSE while the initial list is pending and discards the overtaken snapshot", async () => {
  const harness = createHarness();
  const first = permissionFixture("per_old", "session-open-model-1");
  const second = permissionFixture("per_new", "session-open-model-1");
  let releaseFirst!: (value: Response) => void;
  let startedFirst!: () => void;
  const started = new Promise<void>((resolve) => { startedFirst = resolve; });
  let reads = 0;
  const adapter = new OpenModelProviderAdapter({ runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-permission-race-")), dependencies: {
    ...harness.dependencies,
    fetch: (input, init) => {
      if (new URL(input).pathname === "/permission" && ++reads === 1) {
        startedFirst();
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      return harness.dependencies.fetch(input, init);
    },
  } });
  const handle = await adapter.spawn(spawnRequest());
  const controller = new AbortController();
  const events: OpenCodePermissionObservation[] = [];
  const observing = adapter.observePermissions(handle, (event) => {
    events.push(event);
    if (event.type === "snapshot") controller.abort();
  }, controller.signal);
  await started;
  harness.setPermissions([second]);
  harness.sendEvent({ type: "permission.asked", properties: second });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst(json([first]));
  await observing;
  assert.deepEqual(events, [{ type: "snapshot", requests: [second] }]);
  assert.equal(reads, 2);
  assert.deepEqual(harness.permissionReplies, []);
});

test("Open Model never resurrects a queued asked event that the authoritative permission list has already removed", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  harness.setStreamEvents([{ type: "permission.asked", properties: permissionFixture("per_stale", handle.providerContinuationId!) }]);
  harness.setPermissions([]);
  const controller = new AbortController();
  const events: OpenCodePermissionObservation[] = [];
  await adapter.observePermissions(handle, (event) => {
    events.push(event);
    if (event.type === "snapshot") controller.abort();
  }, controller.signal);
  assert.deepEqual(events, [{ type: "snapshot", requests: [] }]);
});

test("Open Model disposal invalidates pending permission authority even while a snapshot GET is hung", async () => {
  const harness = createHarness();
  let releaseList!: (value: Response) => void;
  let startedList!: () => void;
  const started = new Promise<void>((resolve) => { startedList = resolve; });
  const adapter = new OpenModelProviderAdapter({ runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-permission-dispose-")), dependencies: {
    ...harness.dependencies,
    fetch: (input, init) => {
      if (new URL(input).pathname === "/permission") {
        startedList();
        return new Promise((resolve) => { releaseList = resolve; });
      }
      return harness.dependencies.fetch(input, init);
    },
  } });
  const handle = await adapter.spawn(spawnRequest());
  const events: OpenCodePermissionObservation[] = [];
  const controller = new AbortController();
  const observing = adapter.observePermissions(handle, (event) => events.push(event), controller.signal);
  await started;
  harness.sendEvent({ type: "server.instance.disposed", properties: {} });
  await observing;
  releaseList(json([permissionFixture("per_dead", handle.providerContinuationId!)]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "unavailable", reason: "control_epoch_gone" }]);
  assert.deepEqual(await adapter.probeControl(handle), { state: "lost", controlEvidence: "control_epoch_gone" }, "same-PID healthy server does not resurrect the disposed instance");
  assert.equal(harness.eventConnections, 1);
  assert.equal(harness.activeEventStreams, 0);
  assert.deepEqual(harness.aborts, []);
  assert.deepEqual(harness.signals, []);
});

test("Open Model completed shell tools use native metadata exit codes and never infer a missing command outcome", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setTranscriptFactories([(turnId) => [
    assistantWithTool(turnId, "assistant_1", 10, { status: "completed", metadata: { exit: 1 } }, "call_failed"),
    assistantWithTool(turnId, "assistant_2", 20, { status: "completed", metadata: { exit: 0 } }, "call_success"),
    assistantWithTool(turnId, "assistant_3", 30, { status: "completed", metadata: { exit: null } }, "call_interrupted"),
    assistantWithTool(turnId, "assistant_4", 40, { status: "completed", metadata: {} }, "call_unknown"),
    assistantWithTool(turnId, "assistant_5", 50, { status: "completed", metadata: { exit: "1" } }, "call_malformed"),
    assistantMessage(turnId, "assistant_final", 60, "Done."),
  ]]);
  await adapter.runRoomTurn(handle, { inboxItemId: "exits", sourceMessage: {}, activation: {}, actionId: "exits" });
  assert.deepEqual(observations.flatMap(({ fact }) => fact.domain === "execution" && fact.kind === "completed"
    ? [{ id: fact.executionId, outcome: fact.outcome, exitCode: fact.exitCode }] : []), [
    { id: "call_failed", outcome: "failed", exitCode: 1 },
    { id: "call_success", outcome: "succeeded", exitCode: 0 },
    { id: "call_interrupted", outcome: "interrupted_after_start", exitCode: undefined },
  ]);
  assert.equal(observations.some(({ fact }) => fact.domain === "runtime" && fact.state === "exited"), false);
});

test("Open Model generic process errors are degraded; actual exit or independently proven disappearance is hard evidence", async () => {
  for (const kind of ["error", "error_with_death", "exit"] as const) {
    const harness = createHarness();
    let settleExit!: (exit: ProviderProcessExit) => void;
    const exited = new Promise<ProviderProcessExit>((resolve) => { settleExit = resolve; });
    let gone = false;
    const adapter = new OpenModelProviderAdapter({ runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-exit-evidence-")), dependencies: {
      ...harness.dependencies,
      launch: (input) => ({ ...harness.dependencies.launch(input), exited }),
      getProcessIdentity: () => gone ? null : "opencode-birth-6101",
    } });
    const handle = await adapter.spawn(spawnRequest());
    const observations: NativeExecutionObservation[] = [];
    adapter.onExecution(handle, (event) => observations.push(event));
    if (kind === "error_with_death") gone = true;
    settleExit(kind === "exit" ? { type: "exit", code: 1, signal: null } : { type: "error", error: new Error("private transport failure") });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observations.some(({ fact }) => fact.domain === "runtime" && fact.state === "exited"), kind !== "error");
    assert.equal(observations.some(({ fact }) => fact.domain === "control" && fact.state === "lost"), kind !== "error");
    assert.equal(observations.some(({ fact }) => fact.domain === "control" && fact.state === "degraded"), kind === "error");
    assert.doesNotMatch(JSON.stringify(observations), /private transport failure/);
  }
});

test("Open Model permission snapshots are rejected when the native process is replaced during GET", async () => {
  const harness = createHarness();
  let identity = "opencode-birth-6101";
  const adapter = new OpenModelProviderAdapter({ runtimeRoot: await mkdtemp(join(tmpdir(), "letagents-permission-birth-")), dependencies: {
    ...harness.dependencies,
    getProcessIdentity: () => identity,
    fetch: async (input, init) => {
      const response = await harness.dependencies.fetch(input, init);
      if (new URL(input).pathname === "/permission") identity = "replacement-birth";
      return response;
    },
  } });
  const handle = await adapter.spawn(spawnRequest());
  harness.setPermissions([permissionFixture("per_old", handle.providerContinuationId!)]);
  const events: OpenCodePermissionObservation[] = [];
  await adapter.observePermissions(handle, (event) => events.push(event), new AbortController().signal);
  assert.ok(events.length >= 1);
  assert.ok(events.every((event) => event.type === "unavailable" && event.reason === "process_birth_changed"));
  assert.equal(harness.eventConnections, 1);
  assert.deepEqual(harness.permissionReplies, []);
});

test("Open Model typed facts reject contradictory session evidence even when a legacy transcript row shares the turn ID", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  harness.setTranscriptFactories([(turnId) => {
    const tool = assistantWithTool(turnId, "foreign_tool", 10, { status: "completed", metadata: { exit: 0 } });
    const final = assistantMessage(turnId, "foreign_final", 20, "Foreign reply.");
    tool.info.sessionID = "other_session";
    final.info.sessionID = "other_session";
    return [tool, final];
  }]);
  await adapter.runRoomTurn(handle, { inboxItemId: "foreign-rows", sourceMessage: {}, activation: {}, actionId: "foreign-rows" });
  assert.equal(observations.some(({ fact }) => fact.domain === "execution" || (fact.domain === "turn" && fact.state === "terminal")), false);
});

/**
 * A real daemon supervising one Open Model agent: the real adapter, action
 * router, delivery, execution capture and stores, over a fake OpenCode. Only
 * the room, the server and the OpenCode processes are doubles. Every fake
 * process serves the sessions the agent's runtime directory keeps, as a real
 * one does, and starts a session of its own.
 */
async function openModelDaemonFixture() {
  const { SupervisorDaemon } = await import(new URL("../../daemon/main.ts", import.meta.url).href);
  const { WorkDurabilityStore } = await import(new URL("../../daemon/durability-store.ts", import.meta.url).href);
  const { DAEMON_PROTOCOL_VERSION } = await import(new URL("../../daemon/types.ts", import.meta.url).href);
  const { ProviderActionPortRouter } = await import(new URL("../../daemon/provider-action-port-router.ts", import.meta.url).href);
  const { createConnection } = await import("node:net");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "open-model-daemon-"));
  const id = "open_model_agent";
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

  type FakeProcess = { pid: number; port: number; alive: boolean; exited: Promise<ProviderProcessExit>; end(exit: ProviderProcessExit): void };
  /** One turn of a session: the prompt's own message id, what the session keeps of the answer, and the process that is running it. */
  type FakeTurn = { id: string; sessionId: string; assistants: TranscriptMessage[]; runningOn: number | null };
  const processes: FakeProcess[] = [];
  /** Kept in the agent's runtime directory: every process reads all of them. */
  const sessions = new Map<string, FakeTurn[]>();
  const turns: FakeTurn[] = [];
  const streams = new Set<{ port: number; send(event: Record<string, unknown>): void; close(): void }>();
  let nextPort = 43_821;
  const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const dependencies: OpenModelProviderAdapterDependencies = {
    launch() {
      let resolveExit!: (exit: ProviderProcessExit) => void;
      const process: FakeProcess = { pid: 6_101 + processes.length, port: nextPort - 1, alive: true,
        exited: new Promise((resolve) => { resolveExit = resolve; }),
        end: (exit) => {
          if (!process.alive) return;
          process.alive = false;
          for (const stream of [...streams]) if (stream.port === process.port) stream.close();
          resolveExit(exit);
        } };
      processes.push(process);
      const child = new EventEmitter() as ReturnType<OpenModelProviderAdapterDependencies["launch"]>["child"];
      Object.assign(child, { pid: process.pid, unref() {} });
      return { child, exited: process.exited };
    },
    getProcessIdentity: (pid) => processes.find((process) => process.pid === pid)?.alive ? `opencode-birth-${pid}` : null,
    observeProcessExit: (pid) => processes.find((process) => process.pid === pid)?.exited ?? Promise.resolve({ type: "exit", code: 1, signal: null }),
    signalProcess: (pid, signal) => processes.find((process) => process.pid === pid)?.end({ type: "exit", code: null, signal }),
    allocatePort: async () => nextPort++,
    discoverRuntimeConnection: async () => null,
    async fetch(input, init) {
      const url = new URL(input);
      const process = processes.find((candidate) => candidate.port === Number(url.port));
      if (!process?.alive) throw refused();
      if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.20" });
      if (url.pathname === "/permission") return json([]);
      if (url.pathname === "/config") return json({ model: "letagents-open-model/qwen/qwen3-coder" });
      if (url.pathname === "/event") {
        const encoder = new TextEncoder();
        let connection: { port: number; send(event: Record<string, unknown>): void; close(): void };
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            connection = { port: process.port,
              send(event) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); },
              close() { if (streams.delete(connection)) controller.close(); } };
            streams.add(connection);
            connection.send({ type: "server.connected", properties: {} });
            init?.signal?.addEventListener("abort", () => connection.close(), { once: true });
          },
          cancel() { streams.delete(connection); },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/session" && init?.method === "POST") {
        const sessionId = `session-open-model-${sessions.size + 1}`;
        sessions.set(sessionId, []);
        return json({ id: sessionId });
      }
      if (url.pathname === "/session") return json([...sessions.keys()].map((sessionId) => ({ id: sessionId })));
      if (url.pathname === "/session/status") {
        // A process knows only the turns it runs itself.
        return json(Object.fromEntries(turns.filter((turn) => turn.runningOn === process.port).map((turn) => [turn.sessionId, { type: "busy" }])));
      }
      const [, sessionId, action] = url.pathname.match(/^\/session\/([^/]+)\/([^/]+)$/) ?? [];
      const session = sessionId ? sessions.get(decodeURIComponent(sessionId)) : undefined;
      if (session && action === "prompt_async" && init?.method === "POST") {
        const turn: FakeTurn = { id: String((JSON.parse(String(init.body)) as { messageID: string }).messageID),
          sessionId: decodeURIComponent(sessionId!), assistants: [], runningOn: process.port };
        session.push(turn);
        turns.push(turn);
        return new Response(null, { status: 204 });
      }
      if (session && action === "message") return json(session.flatMap((turn) => [userMessage(turn.id), ...turn.assistants]));
      if (session && action === "abort" && init?.method === "POST") {
        for (const turn of session) turn.runningOn = null;
        return json(true);
      }
      assert.fail(`Unexpected OpenCode request: ${init?.method ?? "GET"} ${url.pathname}`);
    },
    now: () => new Date().toISOString(),
    probeGit: async () => null,
  };
  const adapter = new OpenModelProviderAdapter({ binary: "/opt/letagents/opencode", runtimeRoot: join(root, "runtime"),
    dependencies, startTimeoutMs: LAUNCH_BUDGET_MS, turnTimeoutMs: 30_000 });
  const roomMessages: Array<Record<string, unknown>> = [];
  const published: string[] = [];
  let mints = 0;
  const daemon = new SupervisorDaemon(paths, "darwin", new ProviderActionPortRouter({ "open-model": async () => adapter }), true,
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
  const read = <T>(sql: string): T[] => {
    const database = new DatabaseSync(paths.manifestPath, { readOnly: true });
    try { return database.prepare(sql).all(id).map((row) => ({ ...row })) as T[]; } finally { database.close(); }
  };
  const cleanup = async () => {
    for (const process of processes) process.end({ type: "exit", code: null, signal: "SIGTERM" });
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  };
  try {
    await daemon.start();
    (daemon as unknown as { publishNativeActivity: () => Promise<boolean> }).publishNativeActivity = async () => true;
    type Receipt = { source_message_id: string; state: string; last_error: string | null; provider_turn_id: string | null };
    const inbox = (daemon as unknown as { supervisedInbox: {
      bootstrapCursor(input: { agent_id: string; room_id: string; last_observed_message_id: string | null }): Promise<unknown>;
      receipts(agentId: string): Promise<Receipt[]>;
    } }).supervisedInbox;
    assert.equal((await request("manifest.put", { entry: {
      id, room_id: "room_1", display_name: "Agent", provider: "open-model", model: "qwen/qwen3-coder", charter: "test",
      desired_state: "running", observed_state: "absent", condition: "none", permission_profile_id: "full_access",
      created_by: "test", created_at: "2026-01-01T00:00:00.000Z", delivery_mode: "daemon_inbox",
      workspace_path: attempt.workspace_path, work_attempt_id: attempt.work_attempt_id,
    } })).ok, true);
    await inbox.bootstrapCursor({ agent_id: id, room_id: "room_1", last_observed_message_id: null });
    const daemonGeneration = (await request("daemon.status")).result.generation;
    // A key of the test's own making, for a provider that is never called.
    assert.equal((await request("supervisor.install_open_model_credential", { entry_id: id, api_key: "test-key-for-the-fake-provider",
      base_url: "https://openrouter.ai/api/v1", model: "qwen/qwen3-coder", daemon_generation: daemonGeneration })).ok, true);
    assert.equal((await request("supervisor.install_host_grant", {
      entry_id: id, room_id: "room_1", agent_key: "owner/agent", grant_id: `grant-${id}`,
      supervisor_grant: `${id}-parent`, grant_generation: 1, api_url: "https://letagents.example", daemon_generation: daemonGeneration,
      host_id: "host-1", installation_id: "installation-1", grant_expires_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    })).ok, true);
    const view = async () => (await request("manifest.list")).result[0] as {
      observed_state: string; condition: string; last_error: string | null; activity?: Array<{ summary: string }>;
      room_agent_state: { ingress: { state: string }; inbox: { state: string; detail: string | null } };
    };
    await eventually(() => processes.length === 1, "OpenCode is launched");
    await eventually(async () => (await view())?.room_agent_state?.ingress.state === "observing", "the agent listens to its room");
    const receipt = async (messageId: string) => (await inbox.receipts(id)).find((item) => item.source_message_id === messageId);
    return { id, request, eventually, view, read, published, roomMessages, turns, sessions, processes, receipt, cleanup,
      receipts: () => inbox.receipts(id),
      /** Send the agent its nth room message and wait until its process has been given the prompt. */
      begin: async (ordinal: number) => {
        // Unless it was sent earlier and has been waiting behind the message before it.
        if (!roomMessages.some((message) => message.id === `msg_${ordinal}`)) {
          roomMessages.push({ id: `msg_${ordinal}`, sender: "someone", text: `request ${ordinal}`, activation: { for_current_agent: { decision: "activate" } } });
        }
        await eventually(async () => turns.length === ordinal && Boolean((await receipt(`msg_${ordinal}`))?.provider_turn_id), `msg_${ordinal} starts its turn`).catch(async (error) => {
          const current = await view();
          const row = await receipt(`msg_${ordinal}`);
          throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); agent is ${current.observed_state}/${current.condition} (${current.last_error}); inbox ${current.room_agent_state.inbox.state} (${current.room_agent_state.inbox.detail})`);
        });
        return turns[ordinal - 1]!;
      },
      /** The turn ends in its session with these assistant messages, and the process that ran it reports the session idle. */
      end: (turn: FakeTurn, assistants: TranscriptMessage[]) => {
        turn.assistants = assistants;
        const port = turn.runningOn;
        turn.runningOn = null;
        for (const stream of streams) if (stream.port === port) stream.send({ type: "session.idle", properties: { sessionID: turn.sessionId } });
      },
      /**
       * From here on a convergence pass that has not begun waits until the
       * returned function lets it go, as passes wait for each other and for
       * the network. What delivery does by itself between two messages is
       * then all that happens between them.
       */
      holdConvergence: () => {
        const execution = (daemon as unknown as { providerExecution: { converge(...args: unknown[]): Promise<void> } }).providerExecution;
        const converge = execution.converge.bind(execution);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        execution.converge = async (...args: unknown[]) => { await held; return converge(...args); };
        return () => { execution.converge = converge; release(); };
      },
      /** The agent's newest process ends now, as it does when it crashes: what its session holds of a running turn stays as it is. */
      exitProcess: () => {
        const process = processes.at(-1)!;
        for (const turn of turns) if (turn.runningOn === process.port) turn.runningOn = null;
        process.end({ type: "exit", code: 1, signal: null });
      },
      /** The turns in the agent's execution record, its recovery boundaries, and whether the record has a gap. */
      recorded: () => ({
        turns: read<{ provider_turn_id: string; state: string }>("SELECT provider_turn_id,state FROM execution_turns WHERE agent_id=? ORDER BY created_at_ms,rowid"),
        boundaries: read<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runtime_recoveries WHERE agent_id=? AND phase='complete'")[0]!.n,
        gaps: read<{ last: number; max: number }>("SELECT last_source_sequence AS last, max_observed_sequence AS max FROM execution_observers WHERE agent_id=?")
          .filter((observer) => observer.max !== observer.last).length,
      }) };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** What an OpenCode session holds of a turn whose process ended under it, and how the message then settles. */
const OPEN_MODEL_SESSION_AFTER_EXIT = {
  "its answer": { settles: "acknowledged", reason: null,
    assistants: (turnId: string, ordinal: number): TranscriptMessage[] => [assistantMessage(turnId, `assistant-${ordinal}`, 10, `Recovered ${ordinal}.`)] },
  "the provider's error": { settles: "acknowledged_failed", reason: /provider failure/i,
    assistants: (turnId: string, ordinal: number): TranscriptMessage[] => [{ info: { id: `assistant-${ordinal}`, role: "assistant", parentID: turnId,
      time: { created: 10, completed: 11 }, error: { name: "APIError", data: { message: "Exact provider failure." } } }, parts: [] }] },
  "a step that never finished": { settles: "acknowledged_failed", reason: PROCESS_ENDED_DURING_TURN,
    assistants: (turnId: string, ordinal: number): TranscriptMessage[] => [{ info: { id: `assistant-${ordinal}`, role: "assistant", parentID: turnId,
      time: { created: 10 } }, parts: [{ id: `text-${ordinal}`, type: "text", text: "Half of" }] }] },
  "nothing but the prompt": { settles: "acknowledged_failed", reason: PROCESS_ENDED_DURING_TURN, assistants: (): TranscriptMessage[] => [] },
  "a step whose tool call never returned": { settles: "acknowledged_failed", reason: PROCESS_ENDED_DURING_TURN,
    assistants: (turnId: string, ordinal: number): TranscriptMessage[] => [toolStep(turnId, `assistant-${ordinal}`, 10, "I will inspect the files.", "running")] },
  "a tool call that returned, with no step after it": { settles: "acknowledged_failed", reason: PROCESS_ENDED_DURING_TURN,
    assistants: (turnId: string, ordinal: number): TranscriptMessage[] => [toolStep(turnId, `assistant-${ordinal}`, 10, "I will inspect the files.", "completed")] },
  // The last step ended at the output limit before it wrote anything.
  "a last step cut off at the output limit with no text": { settles: "acknowledged_failed", reason: NO_REPLY_FAILURE.outputLimit,
    assistants: (turnId: string, ordinal: number): TranscriptMessage[] => [{ info: { id: `assistant-${ordinal}`, role: "assistant", parentID: turnId,
      time: { created: 10, completed: 11 } }, parts: [{ id: `finish-${ordinal}`, type: "step-finish", reason: "length" }] }] },
  // A tool call the owner's policy refused ends the turn there, whatever the model said before it.
  "a refused tool call after some narration": { settles: "acknowledged_failed", reason: NO_REPLY_FAILURE.deniedTool,
    assistants: (turnId: string, ordinal: number): TranscriptMessage[] => [{ info: { id: `assistant-${ordinal}`, role: "assistant", parentID: turnId,
      time: { created: 10, completed: 11 } }, parts: [{ id: `text-${ordinal}`, type: "text", text: "I will list the files." },
      { id: `tool-${ordinal}`, type: "tool", tool: "bash", callID: `call-${ordinal}`,
        state: { status: "error", input: { command: "ls" }, error: "The user rejected permission to use this specific tool call", time: { start: 10, end: 11 } } },
      { id: `finish-${ordinal}`, type: "step-finish", reason: "tool-calls" }] }] },
  // OpenCode goes on after a step it could not read a finish reason for.
  "a finished step with text, and a later step begun": { settles: "acknowledged_failed", reason: PROCESS_ENDED_DURING_TURN,
    assistants: (turnId: string, ordinal: number): TranscriptMessage[] => [
      { info: { id: `assistant-${ordinal}`, role: "assistant", parentID: turnId, time: { created: 10, completed: 11 } },
        parts: [{ id: `text-${ordinal}`, type: "text", text: "Half an answer." }, { id: `finish-${ordinal}`, type: "step-finish", reason: "unknown" }] },
      { info: { id: `assistant-${ordinal}-next`, role: "assistant", parentID: turnId, time: { created: 12 } }, parts: [] }] },
} as const;

for (const [left, session] of Object.entries(OPEN_MODEL_SESSION_AFTER_EXIT)) {
  test(`an Open Model agent whose process ends during two turns in a row, leaving ${left} in the session, settles both without a person and answers its next message`, async () => {
    const { ACTIVITY_RECORD_CONTINUED_NOTICE } = await import(new URL("../../daemon/runtime-recovery-journal.ts", import.meta.url).href);
    const agent = await openModelDaemonFixture();
    let letConverge = () => {};
    try {
      for (const ordinal of [1, 2]) {
        const turn = await agent.begin(ordinal);
        await agent.eventually(() => agent.recorded().turns.at(-1)?.state === "active" && agent.recorded().turns.length === ordinal,
          `turn ${ordinal} is recorded as started`);
        letConverge();
        turn.assistants = session.assistants(turn.id, ordinal);
        // The next message is already waiting behind this one: it is dispatched the moment this one settles.
        agent.roomMessages.push({ id: `msg_${ordinal + 1}`, sender: "someone", text: `request ${ordinal + 1}`, activation: { for_current_agent: { decision: "activate" } } });
        await agent.eventually(async () => Boolean(await agent.receipt(`msg_${ordinal + 1}`)), `msg_${ordinal + 1} waits in the agent's inbox`);
        agent.exitProcess();
        await agent.eventually(() => agent.processes.length === ordinal + 1, `process ${ordinal + 1} replaces it`);
        // No later pass of the daemon comes between this message settling and the next one starting.
        letConverge = agent.holdConvergence();
        await agent.eventually(async () => (await agent.receipt(`msg_${ordinal}`))?.state === session.settles, `msg_${ordinal} settles ${session.settles}`).catch(async (error) => {
          const row = await agent.receipt(`msg_${ordinal}`);
          const current = await agent.view();
          throw new Error(`${(error as Error).message}: row is ${row?.state} (${row?.last_error}); agent is ${current.observed_state}/${current.condition} (${current.last_error})`);
        });
        const reason = (await agent.receipt(`msg_${ordinal}`))!.last_error;
        if (typeof session.reason === "string") assert.equal(reason, session.reason, "the room and the owner read why the message has no answer");
        else if (session.reason) assert.match(reason ?? "", session.reason, "the provider's own reason stays on the message");
      }
      // The third process takes the next message, in a session of its own.
      const third = await agent.begin(3);
      await agent.eventually(() => agent.recorded().turns.length === 3, "turn 3 is recorded as started");
      letConverge();
      agent.end(third, [assistantMessage(third.id, "assistant-3", 10, "Answer 3.")]);
      await agent.eventually(async () => (await agent.receipt("msg_3"))?.state === "acknowledged", "msg_3 is answered");

      assert.deepEqual(agent.published, left === "its answer" ? ["Recovered 1.", "Recovered 2.", "Answer 3."] : ["Answer 3."],
        "an answer the session kept is delivered; a turn that was cut off is never run again");
      assert.deepEqual(agent.turns.map((turn) => turn.sessionId), ["session-open-model-1", "session-open-model-2", "session-open-model-3"],
        "every process ran its turn in its own session, and each earlier turn was read where it ran");
      assert.equal(agent.turns.length, 3, "no prompt was sent twice");
      await agent.eventually(() => agent.recorded().turns.at(-1)?.state === "terminal", "the third turn is recorded to its end");
      const record = agent.recorded();
      // An ended process's turn cannot be given an ending by a process that
      // did not run it: it stays lost, behind the boundary that lets the
      // record go on, and its message carries what was read.
      assert.deepEqual(record.turns.map((turn) => turn.state), ["lost", "lost", "terminal"]);
      assert.equal(record.boundaries, 2, "one boundary for each ended process");
      assert.equal(record.gaps, 0, "the record has no gap");
      const current = await agent.view();
      assert.equal(current.condition, "none", current.last_error ?? "");
      assert.equal(current.room_agent_state.inbox.state, "empty", "nothing waits behind a message that needs a person");
      assert.ok(current.activity?.some((event) => event.summary === ACTIVITY_RECORD_CONTINUED_NOTICE), "the owner reads that part of the record is missing");
    } finally {
      letConverge();
      await agent.cleanup();
    }
  });
}
