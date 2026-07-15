import assert from "node:assert/strict";
import test from "node:test";

import type {
  CodexAppServerExit,
  CodexAppServerLaunch,
} from "../main/agents/codex-app-server.js";
import {
  CodexProviderAdapter,
  codexMcpWorkplaceConfigOverrides,
  type CodexAdapterRpc,
  type CodexProviderAdapterDependencies,
} from "../main/agents/codex-provider-adapter.js";
import type { RpcNotification } from "../main/agents/codex-rpc-client.js";
import type {
  ProviderActivityEvent,
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../main/agents/provider-adapter.js";

type RecordedRequest = { method: string; params: unknown };

class FakeRpc implements CodexAdapterRpc {
  readonly requests: RecordedRequest[] = [];
  connected = false;
  closed = false;

  constructor(
    readonly threadId: string,
    private readonly notify: (notification: RpcNotification) => void,
    private readonly options: { resumeSupported: boolean; workplacePresent: boolean },
  ) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "mcpServerStatus/list") {
      return {
        data: this.options.workplacePresent ? [{ name: "letagents", status: "ready" }] : [],
      } as T;
    }
    if (method === "thread/start") {
      return { thread: { id: this.threadId } } as T;
    }
    if (method === "thread/resume") {
      const threadId = (params as { threadId: string }).threadId;
      if (!this.options.resumeSupported) throw new Error("JSON-RPC -32601: method not found");
      if (threadId === "00000000-0000-0000-0000-000000000000") {
        throw new Error("thread not found");
      }
      return { thread: { id: threadId } } as T;
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.threadId}` } } as T;
    }
    if (method === "thread/read") {
      return {
        thread: {
          status: { type: "idle" },
          turns: [{
            id: `turn-${this.threadId}`,
            status: "completed",
            items: [{ type: "agentMessage", text: "Transcript checkpoint persisted." }],
          }],
        },
      } as T;
    }
    throw new Error(`Unexpected fake RPC request: ${method}`);
  }

  close(): void {
    this.closed = true;
  }

  emit(notification: RpcNotification): void {
    this.notify(notification);
  }
}

type FakeLaunch = CodexAppServerLaunch & {
  resolveExit(exit: CodexAppServerExit): void;
};

function createHarness(options: { resumeSupported?: boolean; workplacePresent?: boolean } = {}) {
  const launches: FakeLaunch[] = [];
  const clients: FakeRpc[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const launchOptions: Array<{
    serverUrl: string;
    codexBin: string;
    options: { trustedProjectPath: string; configOverrides: string[] };
  }> = [];
  let nextPid = 4100;
  let nextThread = 1;
  let clock = 0;

  const dependencies: CodexProviderAdapterDependencies = {
    resolveServerUrl: async () => `ws://127.0.0.1:${4700 + launches.length}`,
    launchServer: (serverUrl, codexBin, options) => {
      let resolveExit!: (exit: CodexAppServerExit) => void;
      const launch: FakeLaunch = {
        pid: nextPid++,
        exited: new Promise((resolve) => { resolveExit = resolve; }),
        resolveExit,
      };
      launches.push(launch);
      launchOptions.push({ serverUrl, codexBin, options });
      return launch;
    },
    waitForServer: async () => true,
    createRpcClient: (_serverUrl, notify) => {
      const client = new FakeRpc(`thread-${nextThread++}`, notify, {
        resumeSupported: options.resumeSupported ?? true,
        workplacePresent: options.workplacePresent ?? true,
      });
      clients.push(client);
      return client;
    },
    signalProcess: (pid, signal) => signals.push({ pid, signal }),
    now: () => `2026-07-15T00:00:${String(clock++).padStart(2, "0")}.000Z`,
  };

  return { dependencies, launches, clients, signals, launchOptions };
}

function spawnRequest(overrides: Partial<ProviderSpawnRequest> = {}): ProviderSpawnRequest {
  return {
    workAttemptId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    roomId: "focus_37",
    agentDisplayName: "LanternSparrow",
    cwd: "/tmp/letagents-work-attempt",
    launchPolicy: {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    ...overrides,
  };
}

function requestByMethod(client: FakeRpc, method: string): RecordedRequest {
  const request = client.requests.find((entry) => entry.method === method);
  assert.ok(request, `expected ${method} request`);
  return request;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Codex adapter launches app-server, forwards native policy unchanged, and boots the MCP workplace", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({
    codexBin: "/usr/local/bin/codex",
    dependencies: harness.dependencies,
  });
  assert.equal(adapter.capabilities().resume, false, "resume is unknown before the app-server probe");
  const policy = {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  };

  const handle = await adapter.spawn(spawnRequest({ launchPolicy: policy }));

  assert.equal(handle.observedState(), "working");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.equal(harness.launchOptions[0]?.codexBin, "/usr/local/bin/codex");
  assert.deepEqual(harness.launchOptions[0]?.options, {
    trustedProjectPath: "/tmp/letagents-work-attempt",
    configOverrides: codexMcpWorkplaceConfigOverrides("/tmp/letagents-work-attempt"),
  });
  assert.equal(
    harness.launchOptions[0]?.options.configOverrides.some((value) => /token|authorization|env/i.test(value)),
    false,
    "adapter must not inject a bearer or reinterpret provider auth",
  );

  const threadStart = requestByMethod(harness.clients[0]!, "thread/start");
  const threadParams = threadStart.params as Record<string, unknown>;
  assert.equal(threadParams.approvalPolicy, policy.approvalPolicy);
  assert.equal(threadParams.sandboxPolicy, policy.sandboxPolicy, "native sandbox object was forwarded, not remapped");
  assert.equal(threadParams.cwd, "/tmp/letagents-work-attempt");

  const turnStart = requestByMethod(harness.clients[0]!, "turn/start");
  const prompt = ((turnStart.params as { input: Array<{ text: string }> }).input[0]?.text) ?? "";
  assert.match(prompt, /join_room/);
  assert.match(prompt, /focus_37/);
  assert.match(prompt, /register_agent_session/);
  assert.match(prompt, /wait_for_messages/);
  assert.match(prompt, /LanternSparrow/);
  assert.equal(await adapter.attach({
    workAttemptId: spawnRequest().workAttemptId,
    providerContinuationId: "thread-1",
  }), handle);

  assert.deepEqual(adapter.capabilities(), {
    resume: true,
    midTurnInjection: false,
    transcriptAccess: true,
    permissionPromptBridging: false,
    survivesRestart: true,
  });
  await assert.rejects(adapter.poke(handle, "wake up"), /not enabled/);
});

test("Codex resume reopens the exact native thread and preserves the same launch policy", async () => {
  const harness = createHarness();
  const activity: ProviderActivityEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => activity.push(event),
  });
  const request = spawnRequest();
  const first = await adapter.spawn(request);
  const continuation = first.providerContinuationId!;
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  const resumed = await adapter.resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: continuation,
  }, request);

  assert.equal(resumed.providerContinuationId, continuation);
  const resume = harness.clients[1]!.requests.find((entry) =>
    entry.method === "thread/resume"
      && (entry.params as { threadId?: string }).threadId === continuation);
  assert.ok(resume, "expected exact durable continuation resume request");
  const params = resume.params as Record<string, unknown>;
  assert.equal(params.threadId, continuation);
  assert.deepEqual(params.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(
    harness.clients[1]!.requests.filter((entry) => entry.method === "thread/start").length,
    0,
    "resume must not mint a fresh provider thread",
  );
  const readIndex = harness.clients[1]!.requests.findIndex((entry) => entry.method === "thread/read");
  const turnIndex = harness.clients[1]!.requests.findIndex((entry) => entry.method === "turn/start");
  assert.ok(readIndex >= 0 && readIndex < turnIndex, "prior transcript is read before the next turn");
  assert.ok(activity.some((event) =>
    event.providerContinuationId === continuation
      && event.source === "transcript_tail"
      && event.summary === "Transcript checkpoint persisted."));
});

test("resume capability fails honestly when app-server lacks thread/resume", async () => {
  const harness = createHarness({ resumeSupported: false });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await adapter.spawn(request);

  assert.equal(adapter.capabilities().resume, false);
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  await assert.rejects(
    adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: first.providerContinuationId!,
    }, request),
    /bounded recovery must start a fresh generation/,
  );
  assert.equal(adapter.capabilities().resume, false);
});

test("spawn fails clearly when the configured LetAgents MCP workplace is absent", async () => {
  const harness = createHarness({ workplacePresent: false });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(adapter.spawn(spawnRequest()), /LetAgents MCP server is not configured/);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.clients[0]?.closed, true);
});

test("spawn requires manifest identity instead of generating an adapter-local name", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(
    adapter.spawn(spawnRequest({ agentDisplayName: "" })),
    /durable agent display name from the manifest/,
  );
  assert.equal(harness.launches.length, 0);
});

test("observed crash emits one synthesized terminal payload and makes attach absent", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const handle = await adapter.spawn(request);
  const seen: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (payload) => seen.push(payload));

  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.terminalCause, "crashed");
  assert.equal(seen[0]?.providerContinuationId, handle.providerContinuationId);
  assert.equal(handle.observedState(), "failed");
  assert.equal(await adapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
  }), null);
});

test("stop orders SIGTERM before observed terminal and escalates to SIGKILL after grace", async () => {
  const gracefulHarness = createHarness();
  const gracefulAdapter = new CodexProviderAdapter({ dependencies: gracefulHarness.dependencies });
  const gracefulHandle = await gracefulAdapter.spawn(spawnRequest());
  const gracefulStop = gracefulAdapter.stop(gracefulHandle, { graceMs: 50 });
  assert.deepEqual(gracefulHarness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  gracefulHarness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  assert.equal((await gracefulStop).terminalCause, "stopped");

  const forceHarness = createHarness();
  const forceAdapter = new CodexProviderAdapter({ dependencies: forceHarness.dependencies });
  const forceHandle = await forceAdapter.spawn(spawnRequest());
  const forceStop = forceAdapter.stop(forceHandle, { graceMs: 0 });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(forceHarness.signals, [
    { pid: 4100, signal: "SIGTERM" },
    { pid: 4100, signal: "SIGKILL" },
  ]);
  forceHarness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  assert.equal((await forceStop).terminalCause, "killed");
});

test("native notifications and transcript tail become activity evidence", async () => {
  const harness = createHarness();
  const sink: ProviderActivityEvent[] = [];
  const nativeStream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => sink.push(event),
    streamSink: (event) => nativeStream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  const subscribed: ProviderActivityEvent[] = [];
  const subscribedStream: ProviderStreamEvent[] = [];
  adapter.onActivity(handle, (event) => subscribed.push(event));
  adapter.onStream(handle, (event) => subscribedStream.push(event));

  harness.clients[0]!.emit({
    method: "item/agentMessage/delta",
    params: { delta: "Reading the next room message", apiKey: "must-not-leak" },
  });
  harness.clients[0]!.emit({
    method: "command/exec/outputDelta",
    params: { processId: "p1", delta: "npm test: 13 passed" },
  });
  harness.clients[0]!.emit({ method: "turn/started", params: { turnId: "turn-1" } });
  harness.clients[0]!.emit({ method: "item/mcpToolCall/progress", params: { tool: "read_messages" } });
  harness.clients[0]!.emit({ method: "item/commandExecution/requestApproval", params: { command: "git push" } });
  harness.clients[0]!.emit({ method: "error", params: { message: "provider error" } });
  harness.clients[0]!.emit({ method: "thread/tokenUsage/updated", params: { inputTokens: 12 } });

  harness.clients[0]!.emit({
    method: "turn/completed",
    params: { threadId: handle.providerContinuationId, turnId: "turn-thread-1" },
  });
  await flush();

  assert.ok(sink.some((event) => event.source === "native_harness" && event.method === "turn/completed"));
  assert.ok(sink.some((event) =>
    event.source === "transcript_tail" && event.summary === "Transcript checkpoint persisted."));
  assert.ok(subscribed.some((event) => event.source === "transcript_tail"));
  const textDelta = nativeStream.find((event) => event.method === "item/agentMessage/delta");
  assert.equal(textDelta?.kind, "text_delta");
  assert.equal((textDelta?.payload as { delta?: string }).delta, "Reading the next room message");
  assert.equal((textDelta?.payload as { apiKey?: string }).apiKey, "[REDACTED]");
  assert.equal(textDelta?.payloadRedacted, true);
  assert.equal(
    nativeStream.find((event) => event.method === "command/exec/outputDelta")?.kind,
    "command_output",
    "command deltas retain their tool-specific stream category",
  );
  assert.equal(nativeStream.find((event) => event.method === "turn/started")?.kind, "turn_lifecycle");
  assert.equal(nativeStream.find((event) => event.method === "item/mcpToolCall/progress")?.kind, "tool_lifecycle");
  assert.equal(nativeStream.find((event) => event.method.includes("requestApproval"))?.kind, "approval");
  assert.equal(nativeStream.find((event) => event.method === "error")?.kind, "error");
  assert.equal(nativeStream.find((event) => event.method.includes("tokenUsage"))?.kind, "usage");
  assert.ok(nativeStream.some((event) => event.kind === "transcript_snapshot"));
  assert.ok(subscribedStream.some((event) => event.method === "turn/completed"));
  assert.deepEqual(
    nativeStream.map((event) => event.sequence),
    nativeStream.map((_, index) => index + 1),
    "native stream ordering is explicit per provider handle",
  );
});

test("native stream bounds oversized provider payloads without dropping method identity", async () => {
  const harness = createHarness();
  const nativeStream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => nativeStream.push(event),
  });
  await adapter.spawn(spawnRequest());

  harness.clients[0]!.emit({ method: "item/reasoning/textDelta", params: { delta: "x".repeat(40_000) } });
  const event = nativeStream.find((entry) => entry.method === "item/reasoning/textDelta");
  assert.equal(event?.kind, "text_delta");
  assert.equal(event?.payloadTruncated, true);
  assert.equal(typeof (event?.payload as { preview?: unknown }).preview, "string");
  assert.equal(event?.durablePayloadRef, null);
});

test("launch policy cannot override adapter-owned thread fields", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(
    adapter.spawn(spawnRequest({ launchPolicy: { cwd: "/tmp/escape" } })),
    /reserved field 'cwd'/,
  );
  assert.equal(harness.launches.length, 0);
});
