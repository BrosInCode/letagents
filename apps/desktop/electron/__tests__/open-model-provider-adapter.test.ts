import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OpenModelProviderAdapter,
  type OpenCodePermissionObservation,
  type OpenModelProviderAdapterDependencies,
} from "../main/agents/open-model-provider-adapter.js";
import {
  ProviderTurnControlError,
  type ProviderHandle,
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
      if (url.pathname === "/global/health") return json({ healthy: true, version: "1.18.9" });
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
        return json(holdTurnOpen ? { "session-open-model-1": { type: "busy" } } : {});
      }
      if (url.pathname.endsWith("/abort") && init?.method === "POST") {
        aborts.push(decodeURIComponent(url.pathname.split("/")[2] ?? ""));
        holdTurnOpen = false;
        return json(true);
      }
      assert.fail(`Unexpected OpenCode request: ${init?.method ?? "GET"} ${url.pathname}`);
    },
    now: () => "2026-07-28T00:00:00.000Z",
  };

  return {
    dependencies,
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

async function spawnAdapter(overrides: Partial<ProviderSpawnRequest> = {}) {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-adapter-"));
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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

test("Open Model reattaches from its exact runtime sidecar when a legacy daemon omitted the connection", async () => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  assert.ok(handle.providerContinuationId);
  const replacement = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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

test("Open Model classifies the exact no-reply sentinel and unreadable completion without rerunning", async () => {
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

  const unreadable = await spawnAdapter();
  unreadable.harness.omitAssistantText();
  const missingText = await unreadable.adapter.runRoomTurn(unreadable.handle, {
    inboxItemId: "inbox-unreadable",
    sourceMessage: { text: "reply" },
    activation: { decision: "activate" },
    actionId: "unreadable",
  });
  assert.equal(missingText.outcome, "unreadable");
  assert.equal(unreadable.harness.promptBodies.length, 1);
});

test("Open Model surfaces a terminal provider rejection instead of misclassifying it as unreadable", async () => {
  const { adapter, handle, harness } = await spawnAdapter();
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
  assert.equal(harness.promptBodies.length, 1);
});

test("a fresh adapter reattaches to the exact OpenCode PID and session", async () => {
  const { handle, harness, runtimeRoot } = await spawnAdapter();
  const fresh = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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
      assert.match(error.message, /Timed out waiting for the supervised OpenCode server/);
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
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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
    startTimeoutMs: 100,
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
    return json({ healthy: true, version: "1.18.9" });
  });
  assert.deepEqual(await healthy.probeControl(), { state: "responsive", version: "1.18.9" });
  const cases = [
    { fetch: async () => json({ healthy: true }), reason: "invalid_response" },
    { fetch: async () => json({ healthy: false, version: "1.18.9" }), reason: "invalid_response" },
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

test("Open Model typed turns preserve native model errors, next-turn reuse, and unreadable/no-reply outcomes", async () => {
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
  const unreadable = await adapter.runRoomTurn(handle, { inboxItemId: "empty", sourceMessage: {}, activation: {}, actionId: "empty" });
  assert.equal(unreadable.outcome, "unreadable");
  assert.ok(observations.some(({ fact }) => fact.domain === "turn" && fact.providerTurnId === unreadable.turnId && fact.turnOutcome === "unreadable"));
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
