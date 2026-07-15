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
  private readonly disconnectListeners = new Set<() => void>();

  constructor(
    readonly threadId: string,
    private readonly notify: (notification: RpcNotification) => void,
    private readonly options: {
      resumeSupported: boolean;
      workplacePresent: boolean;
      threadReadFails: boolean;
      threadReadTimesOut: boolean;
    },
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
      if (this.options.threadReadTimesOut) {
        throw new Error("Codex app-server request timed out: thread/read");
      }
      if (this.options.threadReadFails) throw new Error("thread endpoint unavailable");
      const requestedThreadId = (params as { threadId?: string } | undefined)?.threadId;
      return {
        thread: {
          id: requestedThreadId ?? this.threadId,
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

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) listener();
    this.disconnectListeners.clear();
  }

  emit(notification: RpcNotification): void {
    this.notify(notification);
  }
}

type FakeLaunch = CodexAppServerLaunch & {
  alive: boolean;
  processIdentity: string;
  resolveExit(exit: CodexAppServerExit): void;
};

function createHarness(options: {
  resumeSupported?: boolean;
  workplacePresent?: boolean;
  threadReadFails?: boolean;
  threadReadTimesOut?: boolean;
  identityUnavailableAtLaunch?: boolean;
  exitOnSignal?: boolean;
} = {}) {
  const launches: FakeLaunch[] = [];
  const clients: FakeRpc[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const launchOptions: Array<{
    serverUrl: string;
    codexBin: string;
    options: { trustedProjectPath: string; configOverrides: string[]; env?: Record<string, string> };
  }> = [];
  let nextPid = 4100;
  let nextThread = 1;
  let clock = 0;
  let identityObservable = !(options.identityUnavailableAtLaunch ?? false);

  const dependencies: CodexProviderAdapterDependencies = {
    resolveServerUrl: async () => `ws://127.0.0.1:${4700 + launches.length}`,
    launchServer: (serverUrl, codexBin, options) => {
      let resolveExit!: (exit: CodexAppServerExit) => void;
      const launch: FakeLaunch = {
        pid: nextPid++,
        alive: true,
        processIdentity: "",
        exited: new Promise((resolve) => { resolveExit = resolve; }),
        resolveExit: (exit) => {
          launch.alive = false;
          resolveExit(exit);
        },
      };
      launch.processIdentity = `fake-process-${launch.pid}-birth-1`;
      launches.push(launch);
      launchOptions.push({ serverUrl, codexBin, options });
      return launch;
    },
    waitForServer: async () => true,
    createRpcClient: (_serverUrl, notify) => {
      const client = new FakeRpc(`thread-${nextThread++}`, notify, {
        resumeSupported: options.resumeSupported ?? true,
        workplacePresent: options.workplacePresent ?? true,
        threadReadFails: options.threadReadFails ?? false,
        threadReadTimesOut: options.threadReadTimesOut ?? false,
      });
      clients.push(client);
      return client;
    },
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
      if (options.exitOnSignal) {
        const launch = launches.find((entry) => entry.pid === pid && entry.alive);
        launch?.resolveExit({ type: "exit", code: null, signal });
      }
    },
    getProcessIdentity: (pid) => identityObservable
      ? launches.find((launch) => launch.pid === pid && launch.alive)?.processIdentity ?? null
      : undefined,
    observeProcessExit: async (pid, processIdentity) => {
      const launch = launches.find((entry) => entry.pid === pid);
      if (!launch) throw new Error(`Unknown fake process ${pid}`);
      if (launch.processIdentity !== processIdentity) {
        return { type: "exit", code: null, signal: null };
      }
      return launch.exited;
    },
    now: () => `2026-07-15T00:00:${String(clock++).padStart(2, "0")}.000Z`,
  };

  return {
    dependencies,
    launches,
    clients,
    signals,
    launchOptions,
    setIdentityObservable: (observable: boolean) => { identityObservable = observable; },
  };
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
  assert.equal(adapter.capabilities().resume, true, "P0-backed resume is available to a fresh reconciler");
  const policy = {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  };

  const handle = await adapter.spawn(spawnRequest({ launchPolicy: policy }));

  assert.equal(handle.observedState(), "working");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.deepEqual(handle.providerConnection, {
    kind: "codex_app_server",
    url: "ws://127.0.0.1:4700",
    pid: 4100,
    processIdentity: "fake-process-4100-birth-1",
  });
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

test("Codex supervised launch passes only its daemon generation binding to the MCP child", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest({
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
  }));
  assert.deepEqual(harness.launchOptions[0]?.options.env, {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: spawnRequest().workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "execution_exact",
  });
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

  const resumedAdapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => activity.push(event),
  });
  assert.equal(resumedAdapter.capabilities().resume, true);
  const resumed = await resumedAdapter.resume({
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

test("fresh adapter reattaches the durable app-server endpoint without launching a duplicate child", async () => {
  const harness = createHarness();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  assert.ok(first.providerConnection);

  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assert.ok(attached);
  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(attached.pid, first.pid);
  assert.equal(harness.launches.length, 1, "reattach must not create a second native writer");
  assert.equal(
    harness.clients[1]!.requests.some((entry) => entry.method === "thread/start" || entry.method === "turn/start"),
    false,
  );
  assert.equal(await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  }), attached);
});

test("reattached RPC disconnect fences the exact child and waits for verified exit", async () => {
  const harness = createHarness();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assert.ok(attached);
  const terminals: ProviderTerminalPayload[] = [];
  freshAdapter.onExit(attached, (terminal) => terminals.push(terminal));

  assert.equal(harness.dependencies.getProcessIdentity(4100), "fake-process-4100-birth-1");
  harness.clients[1]!.disconnect();
  await flush();

  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.launches[0]?.alive, true);
  assert.equal(terminals.length, 0, "RPC loss alone cannot make a live writer restartable");
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.terminalCause, "crashed");
  assert.equal(attached.observedState(), "failed");
});

test("unverifiable process identity keeps RPC loss ambiguous until actual exit", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assert.ok(attached);
  const terminals: ProviderTerminalPayload[] = [];
  freshAdapter.onExit(attached, (terminal) => terminals.push(terminal));

  harness.setIdentityObservable(false);
  harness.clients[1]!.disconnect();
  await flush();
  assert.deepEqual(harness.signals, [], "an unverifiable pid must not be signalled");
  assert.equal(terminals.length, 0, "unverifiable liveness must remain restart-blocking");

  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();
  assert.equal(terminals.length, 1, "the actual child-exit observation remains authoritative");
});

test("pid-less durable endpoint stays ambiguous even when exact thread RPC succeeds", async () => {
  const healthy = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: healthy.dependencies }).spawn(request);
  const pidlessConnection = { ...first.providerConnection!, pid: null };
  await assert.rejects(new CodexProviderAdapter({ dependencies: healthy.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: pidlessConnection,
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(healthy.launches.length, 1);

  const unavailable = createHarness({ threadReadFails: true });
  const unavailableFirst = await new CodexProviderAdapter({
    dependencies: unavailable.dependencies,
  }).spawn(request);
  await assert.rejects(new CodexProviderAdapter({
    dependencies: unavailable.dependencies,
  }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: unavailableFirst.providerContinuationId!,
    providerConnection: { ...unavailableFirst.providerConnection!, pid: null },
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(unavailable.launches.length, 1);
});

test("recycled pid cannot authenticate a durable endpoint or become exit evidence", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  harness.launches[0]!.processIdentity = "fake-process-4100-birth-2";

  await assert.rejects(new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(harness.launches.length, 1);
  assert.deepEqual(harness.signals, [], "the recycled pid must not be signalled");
});

test("fresh attach fences an unverifiable live app-server instead of allowing a duplicate writer", async () => {
  const harness = createHarness({ threadReadFails: true });
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  const freshAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(freshAdapter.attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  }), /attach is ambiguous; refusing to launch a second writer/);
  assert.equal(harness.launches.length, 1);
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

test("request timeout leaves a slow live writer working and unsignalled", async () => {
  const harness = createHarness({ threadReadTimesOut: true });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));
  await flush();

  assert.equal(handle.observedState(), "working");
  assert.equal(harness.launches[0]?.alive, true);
  assert.deepEqual(harness.signals, []);
  assert.deepEqual(terminals, []);
});

test("startup identity failure terminates and awaits the known fresh child", async () => {
  const harness = createHarness({ identityUnavailableAtLaunch: true, exitOnSignal: true });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  await assert.rejects(adapter.spawn(spawnRequest()), /process identity could not be verified/);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(harness.launches[0]?.alive, false);
  assert.equal(harness.clients.length, 0, "no RPC thread may start before process identity is durable");
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

test("spawned RPC disconnect fences the child and waits for observed exit", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const terminals: ProviderTerminalPayload[] = [];
  adapter.onExit(handle, (terminal) => terminals.push(terminal));

  harness.clients[0]!.disconnect();
  await flush();

  assert.equal(harness.launches[0]?.alive, true);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }]);
  assert.equal(terminals.length, 0, "RPC loss is not child-exit evidence");
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGTERM" });
  await flush();

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.terminalCause, "crashed");
  assert.equal(handle.observedState(), "failed");
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
