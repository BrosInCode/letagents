import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OpenModelProviderAdapter,
  type OpenModelProviderAdapterDependencies,
} from "../main/agents/open-model-provider-adapter.js";
import type {
  ProviderHandle,
  ProviderSpawnRequest,
  ProviderStreamEvent,
} from "../main/agents/provider-adapter.js";
import type { ProviderProcessExit } from "../main/agents/provider-evidence.js";

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
  let observedProcessExit: Promise<ProviderProcessExit>;
  let messageReads = 0;

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
      if (url.pathname === "/global/health") return json({ healthy: true });
      if (url.pathname === "/event") {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(
              'data: {"type":"server.connected","properties":{}}\n\n',
            ));
            for (const event of streamEvents) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            init?.signal?.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
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
    setTranscriptFactories(factories: TranscriptFactory[]) {
      transcriptFactories = factories;
    },
    setStreamEvents(events: Array<Record<string, unknown>>) {
      streamEvents = events;
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

async function spawnAdapter() {
  const harness = createHarness();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "letagents-opencode-adapter-"));
  const adapter = new OpenModelProviderAdapter({
    binary: "/opt/letagents/opencode",
    runtimeRoot,
    dependencies: harness.dependencies,
    startTimeoutMs: 100,
    turnTimeoutMs: 100,
  });
  const handle = await adapter.spawn(spawnRequest());
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

test("Open Model launches a dedicated OpenCode server without putting the provider key in config or MCP", async () => {
  const { handle, harness } = await spawnAdapter();

  assert.equal(handle.pid, 6101);
  assert.equal(handle.providerContinuationId, "session-open-model-1");
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
  assert.deepEqual(
    (JSON.parse(serverAuth) as { connection?: unknown }).connection,
    {
      url: "http://127.0.0.1:43821",
      pid: 6101,
      processIdentity: "opencode-birth-6101",
    },
  );
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
  adapter.onStream(handle, (event) => stream.push(event));

  const result = await adapter.runRoomTurn(handle, {
    inboxItemId: "inbox-open-model-1",
    sourceMessage: { id: "message-1", text: "say hi" },
    activation: { decision: "activate", reason: "explicit_mention" },
    actionId: "action-open-model-1",
    charter: "Help the room.",
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
  let dispatchMarked = false;

  const result = await adapter.controlTurn(handle, null, {
    markDispatched: async () => { dispatchMarked = true; },
  });

  assert.deepEqual(result, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
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

test("Open Model repairs a continuation on the same verified process", async () => {
  const { adapter, handle } = await spawnAdapter();
  const checkpointed: string[] = [];

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
