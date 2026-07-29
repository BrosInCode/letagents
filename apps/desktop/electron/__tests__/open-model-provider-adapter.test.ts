import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
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
        if (holdTurnOpen) return json([]);
        const turnId = String(promptBodies.at(-1)?.messageID ?? "turn-recovery");
        return json([{
          info: {
            id: "assistant-1",
            role: "assistant",
            parentID: turnId,
            time: { completed: 1_700_000_000_000 },
          },
          parts: [
            { id: "reasoning-1", type: "reasoning", text: "Checking the bounded context." },
            ...(includeAssistantText
              ? [{ id: "text-1", type: "text", text: assistantText }]
              : []),
          ],
        }]);
      }
      if (url.pathname === "/session/status") {
        return json(holdTurnOpen ? { "session-open-model-1": { type: "busy" } } : {});
      }
      if (url.pathname.endsWith("/abort") && init?.method === "POST") {
        aborts.push(decodeURIComponent(url.pathname.split("/")[2] ?? ""));
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

  const result = await adapter.controlTurn(handle);

  assert.deepEqual(result, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: false,
    state: "idle",
  });
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
});
