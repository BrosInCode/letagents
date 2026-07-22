import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE,
  writeCodexSupervisorBridgeContext,
} from "../main/agents/codex-supervisor-bridge-context.js";
import type {
  ProviderActivityEvent,
  ProviderConnectionRef,
  ProviderHandle,
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../main/agents/provider-adapter.js";

type RecordedRequest = { method: string; params: unknown };

function assertProviderHandle(
  value: ProviderHandle | { state: "terminal" } | null,
): asserts value is ProviderHandle {
  assert.ok(value && !("state" in value && value.state === "terminal"), "expected a live provider handle");
}

class FakeRpc implements CodexAdapterRpc {
  readonly requests: RecordedRequest[] = [];
  connected = false;
  closed = false;
  turnStatus = "completed";
  private readonly disconnectListeners = new Set<() => void>();

  constructor(
    readonly threadId: string,
    private readonly notify: (notification: RpcNotification) => void,
    private readonly options: {
      resumeSupported: boolean;
      placeholderResumeIsFatal: boolean;
      workplacePresent: boolean;
      workplaceProbeTimesOut: boolean;
      threadReadFails: boolean;
      threadReadTimesOut: boolean;
      threadReadUnmaterialized: boolean;
    },
  ) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "mcpServerStatus/list") {
      if (this.options.workplaceProbeTimesOut) {
        throw new Error("Codex app-server request timed out: mcpServerStatus/list");
      }
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
        if (this.options.placeholderResumeIsFatal) {
          throw new Error("protocol error: invalid placeholder continuation");
        }
        throw new Error("thread not found");
      }
      return { thread: { id: threadId } } as T;
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.threadId}` } } as T;
    }
    if (method === "turn/interrupt") {
      this.turnStatus = "interrupted";
      return {} as T;
    }
    if (method === "thread/read") {
      if (this.options.threadReadTimesOut) {
        throw new Error("Codex app-server request timed out: thread/read");
      }
      if (this.options.threadReadFails) throw new Error("thread endpoint unavailable");
      if (
        this.options.threadReadUnmaterialized
        && (params as { includeTurns?: boolean } | undefined)?.includeTurns !== false
      ) {
        throw new Error(
          `thread ${this.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
        );
      }
      const requestedThreadId = (params as { threadId?: string } | undefined)?.threadId;
      return {
        thread: {
          id: requestedThreadId ?? this.threadId,
          status: { type: "idle" },
          turns: [{
            id: `turn-${this.threadId}`,
            status: this.turnStatus,
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
  placeholderResumeIsFatal?: boolean;
  workplacePresent?: boolean;
  workplaceProbeTimesOut?: boolean;
  threadReadFails?: boolean;
  threadReadTimesOut?: boolean;
  threadReadUnmaterialized?: boolean;
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
  const supervisorBridgeContexts: Array<{
    cwd: string;
    context: Parameters<CodexProviderAdapterDependencies["writeSupervisorBridgeContext"]>[1];
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
        placeholderResumeIsFatal: options.placeholderResumeIsFatal ?? false,
        workplacePresent: options.workplacePresent ?? true,
        workplaceProbeTimesOut: options.workplaceProbeTimesOut ?? false,
        threadReadFails: options.threadReadFails ?? false,
        threadReadTimesOut: options.threadReadTimesOut ?? false,
        threadReadUnmaterialized: options.threadReadUnmaterialized ?? false,
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
    writeSupervisorBridgeContext: async (cwd, context) => {
      supervisorBridgeContexts.push({ cwd, context });
    },
    now: () => `2026-07-15T00:00:${String(clock++).padStart(2, "0")}.000Z`,
  };

  return {
    dependencies,
    launches,
    clients,
    signals,
    launchOptions,
    supervisorBridgeContexts,
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
  assert.equal(
    harness.clients[0]!.requests.some((entry) => entry.method === "thread/resume"),
    false,
    "a fresh start must never probe resume with a synthetic continuation",
  );

  const turnStart = requestByMethod(harness.clients[0]!, "turn/start");
  const prompt = ((turnStart.params as { input: Array<{ text: string }> }).input[0]?.text) ?? "";
  assert.match(prompt, /join_room/);
  assert.match(prompt, /focus_37/);
  assert.match(prompt, /register_agent_session/);
  assert.match(prompt, /cwd="\/tmp\/letagents-work-attempt"/, "registration binds from the exact daemon-owned worktree rather than the MCP process cwd");
  assert.match(prompt, /wait_for_messages/);
  assert.match(prompt, /LanternSparrow/);
  assert.equal(await adapter.attach({
    workAttemptId: spawnRequest().workAttemptId,
    providerContinuationId: "thread-1",
    providerConnection: handle.providerConnection,
  }), handle);

  assert.deepEqual(adapter.capabilities(), {
    resume: true,
    midTurnInjection: false,
    transcriptAccess: true,
    permissionPromptBridging: false,
    survivesRestart: true,
    turnControl: "native_interrupt",
  });
  await assert.rejects(adapter.poke(handle, "wake up"), /not enabled/);
});

test("Codex fresh spawn does not let a fatal placeholder resume probe block thread/start", async () => {
  const harness = createHarness({ placeholderResumeIsFatal: true });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  const handle = await adapter.spawn(spawnRequest());

  assert.equal(handle.observedState(), "working");
  assert.equal(handle.providerContinuationId, "thread-1");
  assert.deepEqual(
    harness.clients[0]!.requests.map((entry) => entry.method),
    ["mcpServerStatus/list", "thread/start", "turn/start", "thread/read"],
  );
  assert.deepEqual(harness.signals, []);
});

test("Codex workplace status timeout does not kill launch or durable resume", async () => {
  const harness = createHarness({ workplaceProbeTimesOut: true });
  const request = spawnRequest();
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

  const first = await firstAdapter.spawn(request);
  assert.equal(first.observedState(), "working");
  assert.equal(first.providerContinuationId, "thread-1");

  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();

  const resumed = await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
  }, request);

  assert.equal(resumed.observedState(), "working");
  assert.equal(resumed.providerContinuationId, first.providerContinuationId);
  assert.ok(harness.clients[1]!.requests.some((entry) => entry.method === "thread/resume"));
  assert.deepEqual(harness.signals, []);
});

test("Codex turn control interrupts the exact turn and resumes the same thread with the correction", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";

  const result = await adapter.controlTurn!(handle, "Use the corrected acceptance criteria.");

  assert.deepEqual(result, {
    capability: "native_interrupt",
    interrupted: true,
    resumed: true,
    state: "working",
  });
  const interrupt = client.requests.find((request) => request.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, { threadId: "thread-1", turnId: "turn-thread-1" });
  const redirected = client.requests.filter((request) => request.method === "turn/start").at(-1)!;
  assert.equal((redirected.params as { threadId: string }).threadId, "thread-1");
  assert.equal(
    (redirected.params as { input: Array<{ text: string }> }).input[0]?.text,
    "Use the corrected acceptance criteria.",
  );
  assert.equal(handle.providerContinuationId, "thread-1");
});

test("Codex exact legacy-turn control checkpoints once and never selects a newer latest turn", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  let turns: Array<{ id: string; status: string }> = [
    { id: "turn-polling", status: "inProgress" },
    { id: "turn-newer", status: "inProgress" },
  ];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return {
      thread: { id: handle.providerContinuationId, turns: turns.map((turn) => ({ ...turn, items: [] })) },
    } as T;
    if (method === "turn/interrupt") {
      await original<T>(method, params);
      const id = (params as { turnId: string }).turnId;
      turns = turns.map((turn) => turn.id === id ? { ...turn, status: "interrupted" } : turn);
      return {} as T;
    }
    return original<T>(method, params);
  };
  client.requests.length = 0;
  const events: string[] = [];

  const result = await adapter.controlExactTurn!(handle, {
    targetTurnId: "turn-polling",
    checkpointTargetTurn: async (turnId) => { events.push(`checkpoint:${turnId}`); },
    markDispatched: async () => { events.push("dispatch"); },
  });

  assert.deepEqual(result, { outcome: "interrupt_dispatched", targetTurnId: "turn-polling" });
  assert.deepEqual(events, ["checkpoint:turn-polling", "dispatch"]);
  assert.deepEqual(
    client.requests.filter((request) => request.method === "turn/interrupt").map((request) => request.params),
    [{ threadId: "thread-1", turnId: "turn-polling" }],
  );
});

test("Codex exact legacy-turn control proves no-active and persisted terminal boundaries without interrupting", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  let turns: Array<{ id: string; status: string }> = [];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns } } as T;
    return original<T>(method, params);
  };
  client.requests.length = 0;
  const callbacks = { checkpointedTurnIds: [] as string[], dispatch: 0 };
  const options = {
    checkpointTargetTurn: async (turnId: string) => { callbacks.checkpointedTurnIds.push(turnId); },
    markDispatched: async () => { callbacks.dispatch += 1; },
  };
  assert.deepEqual(await adapter.controlExactTurn!(handle, options), { outcome: "no_active", targetTurnId: null });
  turns = [{ id: "turn-polling", status: "interrupted" }, { id: "turn-newer", status: "inProgress" }];
  assert.deepEqual(await adapter.controlExactTurn!(handle, { ...options, targetTurnId: "turn-polling" }), {
    outcome: "terminal", targetTurnId: "turn-polling",
  });
  assert.deepEqual(callbacks, { checkpointedTurnIds: ["turn-polling"], dispatch: 0 }, "a discovered terminal latest is durably fenced before return and cannot be retargeted to turn-newer");
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("Codex exact legacy-turn control refuses missing, unknown, or callback-failed targets before native interrupt", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  let turns: Array<{ id: string; status: string }> = [{ id: "turn-polling", status: "mystery" }];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns } } as T;
    return original<T>(method, params);
  };
  client.requests.length = 0;
  const stable = { checkpointTargetTurn: async () => {}, markDispatched: async () => {} };
  await assert.rejects(adapter.controlExactTurn!(handle, { ...stable, targetTurnId: "turn-missing" }), /cannot find/);
  await assert.rejects(adapter.controlExactTurn!(handle, { ...stable, targetTurnId: "turn-polling" }), /unknown target state/);
  turns = [{ id: "turn-polling", status: "inProgress" }];
  await assert.rejects(adapter.controlExactTurn!(handle, {
    checkpointTargetTurn: async () => {},
    markDispatched: async () => { throw new Error("durable dispatch failed"); },
  }), /durable dispatch failed/);
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("Codex bounded room turn waits for its exact terminal event and publishes only final agent text", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  const causal: string[] = []; let boundedStatus = "inProgress"; let settled = false;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      causal.push("turn/start");
      return { turn: { id: "turn-bounded" } } as T;
    }
    if (method === "thread/read") return {
      thread: { id: handle.providerContinuationId, turns: [{ id: "turn-bounded", status: boundedStatus, items: [
        { type: "userMessage", phase: "final", text: "Never publish this." },
        { type: "agentMessage", phase: "commentary", text: "Thinking aloud." },
        { type: "tool", phase: "final", text: "Tool transcript." },
        { type: "agentMessage", phase: "final", content: [{ text: "Final answer, part one." }, { text: "Part two." }] },
      ] }] },
    } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-1",
    actionId: "action-1",
    sourceMessage: { id: "message-1", text: "Please investigate." },
    activation: { for_current_agent: { reason: "mention" } },
  }, {
    beforeNativeDispatch: async () => { causal.push("before-native"); },
    checkpointTurnStarted: async (turnId) => { causal.push(`started:${turnId}`); },
  });
  void pending.then(() => { settled = true; });
  await flush();
  assert.deepEqual(causal, ["before-native", "turn/start", "started:turn-bounded"]);
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "other-turn" } });
  client.emit({ method: "turn/completed", params: { threadId: "other-thread", turnId: "turn-bounded" } });
  await flush();
  assert.equal(settled, false, "an unrelated turn terminal cannot settle this bounded delivery");
  boundedStatus = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-bounded" } });
  const result = await pending;

  assert.deepEqual(result, {
    turnId: "turn-bounded",
    outcome: "reply",
    text: "Final answer, part one.\nPart two.",
    evidence: "transcript",
  });
  assert.equal(handle.pid, 4100);
  assert.equal(handle.providerContinuationId, "thread-1", "the bounded delivery retains the original app-server thread");
});

test("Codex bounded room turn consumes a fast exact terminal cached before its waiter", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-fast" } });
      return { turn: { id: "turn-fast" } } as T;
    }
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-fast", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "LETAGENTS_NO_ROOM_REPLY" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  assert.deepEqual(await adapter.runRoomTurn!(handle, { inboxItemId: "inbox-fast", actionId: "action-fast", sourceMessage: {}, activation: {} }, {
    beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {},
  }), { turnId: "turn-fast", outcome: "no_reply", text: null, evidence: "transcript" });
});

test("Codex bounded room turn preserves an unreadable completed result without throwing", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-empty" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-empty", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "  " }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, { inboxItemId: "inbox-empty", actionId: "action-empty", sourceMessage: {}, activation: {} }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush(); client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-empty" } });
  assert.deepEqual(await pending, { turnId: "turn-empty", outcome: "unreadable", text: null, evidence: "none" });
});

test("Codex retains stream-only terminal evidence until the daemon durably checkpoints it", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-stream-checkpoint" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-stream-checkpoint", status: "completed" }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-stream-checkpoint", actionId: "action-stream-checkpoint", sourceMessage: {}, activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {},
    checkpointTerminalResult: async () => { throw new Error("SQLite checkpoint unavailable"); },
  });
  await flush();
  client.emit({ method: "item/agentMessage/delta", params: { threadId: handle.providerContinuationId, turnId: "turn-stream-checkpoint", itemId: "answer", delta: "Retained answer" } });
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-stream-checkpoint" } });
  await assert.rejects(pending, /SQLite checkpoint unavailable/);
  let checkpointed: unknown = null;
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, {
    inboxItemId: "inbox-stream-checkpoint", providerTurnId: "turn-stream-checkpoint",
  }, {
    checkpointTerminalResult: async (result) => { checkpointed = result; },
  }), { turnId: "turn-stream-checkpoint", outcome: "reply", text: "Retained answer", evidence: "stream" });
  assert.deepEqual(checkpointed, { turnId: "turn-stream-checkpoint", outcome: "reply", text: "Retained answer", evidence: "stream" });
});

test("Codex bounded room turn does not treat a sentinel with extra text as no-reply", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-sentinel-extra" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-sentinel-extra", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "LETAGENTS_NO_ROOM_REPLY\nextra" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const pending = adapter.runRoomTurn!(handle, { inboxItemId: "inbox-sentinel-extra", actionId: "action-sentinel-extra", sourceMessage: {}, activation: {} }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush(); client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-sentinel-extra" } });
  assert.deepEqual(await pending, { turnId: "turn-sentinel-extra", outcome: "reply", text: "LETAGENTS_NO_ROOM_REPLY\nextra", evidence: "transcript" });
});

test("Codex room-turn recovery reattaches only the persisted exact active turn and never starts another", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-recover", status, items: [{ type: "agentMessage", phase: "final", text: "Recovered reply." }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const startsBefore = client.requests.filter((request) => request.method === "turn/start").length;
  const pending = adapter.recoverRoomTurn!(handle, { inboxItemId: "inbox-recover", providerTurnId: "turn-recover" });
  await flush();
  client.emit({ method: "turn/completed", params: { threadId: "other-thread", turnId: "turn-recover" } });
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "other-turn" } });
  await flush(); status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-recover" } });
  assert.deepEqual(await pending, { turnId: "turn-recover", outcome: "reply", text: "Recovered reply.", evidence: "transcript" });
  assert.equal(client.requests.filter((request) => request.method === "turn/start").length, startsBefore);
});

test("Codex room-turn recovery returns already-terminal exact output without starting a turn", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-done", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Already durable." }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const startsBefore = client.requests.filter((request) => request.method === "turn/start").length;
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, { inboxItemId: "inbox-done", providerTurnId: "turn-done" }), { turnId: "turn-done", outcome: "reply", text: "Already durable.", evidence: "transcript" });
  assert.equal(client.requests.filter((request) => request.method === "turn/start").length, startsBefore);
});

test("Codex room-turn recovery rejects missing and unknown exact turns as ambiguous", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-unknown", status: "mystery" }] } } as T;
    return originalRequest<T>(method, params);
  };
  await assert.rejects(adapter.recoverRoomTurn!(handle, { inboxItemId: "missing", providerTurnId: "turn-missing" }), /cannot find/);
  await assert.rejects(adapter.recoverRoomTurn!(handle, { inboxItemId: "unknown", providerTurnId: "turn-unknown" }), /unknown exact turn state/);
});

test("Codex retirement detaches only its waiter so a successor recovers the same exact turn", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-retired" } } as T;
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-retired", status, items: [{ type: "agentMessage", phase: "final", text: "successor reply" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const controller = new AbortController();
  const old = adapter.runRoomTurn!(handle, { inboxItemId: "old", actionId: "old", sourceMessage: {}, activation: {} }, {
    beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {}, detachSignal: controller.signal,
  });
  await flush(); controller.abort();
  await assert.rejects(old, /observation detached/);
  const successor = adapter.recoverRoomTurn!(handle, { inboxItemId: "successor", providerTurnId: "turn-retired" });
  await flush(); status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-retired" } });
  assert.deepEqual(await successor, { turnId: "turn-retired", outcome: "reply", text: "successor reply", evidence: "transcript" });
  assert.equal(handle.pid, 4100); assert.equal(handle.providerContinuationId, "thread-1");
  assert.equal(client.requests.filter((request) => request.method === "turn/interrupt").length, 0);
});

test("Codex caches a terminal racing observer detach for successor recovery", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest()); const client = harness.clients[0]!; const originalRequest = client.request.bind(client);
  let status = "inProgress";
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return { thread: { id: handle.providerContinuationId, turns: [{ id: "turn-race", status, items: [{ type: "agentMessage", phase: "final", text: "raced" }] }] } } as T;
    return originalRequest<T>(method, params);
  };
  const controller = new AbortController();
  const old = adapter.recoverRoomTurn!(handle, { inboxItemId: "old-race", providerTurnId: "turn-race" }, { detachSignal: controller.signal });
  await flush(); controller.abort(); await assert.rejects(old, /observation detached/);
  status = "completed";
  client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId: "turn-race" } });
  assert.deepEqual(await adapter.recoverRoomTurn!(handle, { inboxItemId: "next-race", providerTurnId: "turn-race" }), { turnId: "turn-race", outcome: "reply", text: "raced", evidence: "transcript" });
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
    LETAGENTS_EXECUTION_PROFILE: "interactive_desktop",
  });
  assert.deepEqual(harness.supervisorBridgeContexts, [{
    cwd: "/tmp/letagents-work-attempt",
    context: {
      entry_id: "manifest_exact",
      room_id: "focus_37",
      work_attempt_id: spawnRequest().workAttemptId,
      execution_generation_id: "execution_exact",
    },
  }]);
});

test("Codex resumed bounded launch supplies only the exact non-secret worker route to the MCP bridge", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest({
    deliveryMode: "daemon_inbox",
    supervisorEntryId: "manifest_exact",
    supervisorSocketPath: "/tmp/daemon.sock",
    supervisorExecutionGenerationId: "execution_exact",
    supervisorWorkerSession: { agentSessionId: "agent_session_exact", roomCursor: "msg_1" },
  });
  const first = await adapter.spawn(request);
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });
  await flush();
  await new CodexProviderAdapter({ dependencies: harness.dependencies }).resume({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
  }, request);
  const expectedEnvironment = {
    LETAGENTS_SUPERVISOR_ENTRY_ID: "manifest_exact",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/daemon.sock",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: spawnRequest().workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: "execution_exact",
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: "agent_session_exact",
    LETAGENTS_SUPERVISOR_ROOM_ID: "focus_37",
    LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: "LanternSparrow",
  };
  assert.deepEqual(harness.launchOptions.map((launch) => launch.options.env), [expectedEnvironment, expectedEnvironment],
    "fresh and resumed bounded app-server launches share the credential-scrubbing marker");
  const expectedBridgeContext = {
    entry_id: "manifest_exact",
    room_id: "focus_37",
    work_attempt_id: spawnRequest().workAttemptId,
    execution_generation_id: "execution_exact",
    agent_session_id: "agent_session_exact",
    agent_display_name: "LanternSparrow",
  };
  assert.deepEqual(harness.supervisorBridgeContexts.map(({ context }) => context), [expectedBridgeContext, expectedBridgeContext]);
  assert.doesNotMatch(JSON.stringify(harness.launchOptions), /session-secret|authorization|bearer/i);
});

test("Codex supervised launch fails closed before app-server start when bridge coordinates are partial", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await assert.rejects(
    adapter.spawn(spawnRequest({ supervisorEntryId: "manifest_exact" })),
    /coordinates are incomplete/,
  );
  assert.deepEqual(harness.supervisorBridgeContexts, []);
  assert.deepEqual(harness.launchOptions, []);
});

test("Codex supervisor bridge context is owner-only, atomic, and contains no worker credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-supervisor-context-"));
  try {
    const base = {
      entry_id: "manifest_exact",
      room_id: "focus_37",
      work_attempt_id: spawnRequest().workAttemptId,
    };
    await writeCodexSupervisorBridgeContext(root, { ...base, execution_generation_id: "generation_first" });
    await writeCodexSupervisorBridgeContext(root, { ...base, execution_generation_id: "generation_resumed" });

    const path = join(root, CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE);
    const encoded = await readFile(path, "utf8");
    assert.equal(JSON.parse(encoded).execution_generation_id, "generation_resumed");
    assert.doesNotMatch(encoded, /session_token|session-secret|authorization/i);
    assert.doesNotMatch(encoded, /socket_path/, "repo-controlled context cannot select the credential transport");
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), [CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE], "atomic rewrite leaves no temporary context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry override adds exact command/args/cwd overrides when devMcpServerEntryPath is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-dev-mcp-entry-"));
  try {
    const quotedDirectory = join(root, 'path with spaces and "quotes"');
    await mkdir(quotedDirectory);
    const entryPath = join(quotedDirectory, "server.js");
    await writeFile(entryPath, "// stub");
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    await adapter.spawn(spawnRequest({ devMcpServerEntryPath: entryPath }));
    assert.deepEqual(harness.launchOptions[0]?.options.configOverrides, [
      ...codexMcpWorkplaceConfigOverrides(spawnRequest().cwd),
      `mcp_servers.letagents.command=${JSON.stringify("node")}`,
      `mcp_servers.letagents.args=${JSON.stringify([entryPath])}`,
    ]);
    assert.equal(
      harness.launchOptions[0]?.options.configOverrides.some((value) =>
        /token|authorization|bearer|password/i.test(value),
      ),
      false,
      "dev entry override must not inject any credential",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry override fails closed for relative, missing, and non-file inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-dev-mcp-invalid-"));
  try {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });

    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: "relative/path/server.js" })),
      /must be absolute/,
      "relative path must fail closed",
    );
    assert.deepEqual(harness.launchOptions, [], "no app-server launch on relative path");

    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: join(root, "nonexistent.js") })),
      /does not exist/,
      "missing file must fail closed",
    );

    const dirPath = join(root, "subdir");
    await mkdir(dirPath);
    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: dirPath })),
      /must be a regular built file/,
      "directory must fail closed",
    );

    const symlinkTarget = join(root, "target.js");
    await writeFile(symlinkTarget, "// target");
    const symlinkPath = join(root, "link.js");
    await symlink(symlinkTarget, symlinkPath);
    await assert.rejects(
      adapter.spawn(spawnRequest({ devMcpServerEntryPath: symlinkPath })),
      /must be a regular built file/,
      "symlink must fail closed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex dev MCP entry is absent by default and does not affect the baseline cwd-only override", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  await adapter.spawn(spawnRequest());
  assert.deepEqual(
    harness.launchOptions[0]?.options.configOverrides,
    codexMcpWorkplaceConfigOverrides(spawnRequest().cwd),
    "baseline spawn must produce only the cwd override",
  );
});

test("Codex resume reopens the exact native thread and preserves the same launch policy", async () => {
  const harness = createHarness();
  const activity: ProviderActivityEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    activitySink: (event) => activity.push(event),
  });
  const request = spawnRequest({
    supervisorWorkerSession: {
      agentSessionId: "agent_session_exact",
      roomCursor: "msg_2819",
    },
  });
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
  const turn = harness.clients[1]!.requests[turnIndex]!.params as { input: Array<{ text: string }> };
  assert.match(turn.input[0]!.text, /agent_session_exact/);
  assert.match(turn.input[0]!.text, /msg_2819/);
  assert.match(turn.input[0]!.text, /Do not call register_agent_session/);
  assert.doesNotMatch(turn.input[0]!.text, /Suggested codename|Call set_agent_name/);
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

  assertProviderHandle(attached);
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

test("cached Codex attach requires the exact continuation and native connection identity", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const handle = await adapter.spawn(request);
  assert.ok(handle.providerConnection?.kind === "codex_app_server");
  const exactRef = {
    workAttemptId: request.workAttemptId,
    providerContinuationId: handle.providerContinuationId!,
    providerConnection: handle.providerConnection,
  };

  assert.equal(await adapter.attach(exactRef), handle);
  assert.equal(await adapter.attach({ ...exactRef, providerContinuationId: "cross-wired-thread" }), null);
  assert.equal(await adapter.attach({ ...exactRef, providerConnection: null }), null);

  const mismatchedConnections: ProviderConnectionRef[] = [
    { ...handle.providerConnection, url: "ws://127.0.0.1:9999" },
    { ...handle.providerConnection, url: "" },
    { ...handle.providerConnection, pid: handle.providerConnection.pid! + 1 },
    { ...handle.providerConnection, pid: null },
    { ...handle.providerConnection, processIdentity: "another-process-birth" },
    { ...handle.providerConnection, processIdentity: null },
    { kind: "claude_cli", pid: handle.providerConnection.pid, processIdentity: handle.providerConnection.processIdentity },
  ];
  for (const providerConnection of mismatchedConnections) {
    assert.equal(await adapter.attach({ ...exactRef, providerConnection }), null);
  }
  assert.equal(harness.launches.length, 1);
  assert.equal(harness.clients.length, 1, "rejected cached refs never contact or launch another endpoint");
});

test("fresh adapter reattaches when only the MCP workplace status probe times out", async () => {
  const harness = createHarness({ workplaceProbeTimesOut: true });
  const firstAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await firstAdapter.spawn(request);
  assert.ok(first.providerConnection);

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assertProviderHandle(attached);
  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(attached.pid, first.pid);
  assert.equal(harness.launches.length, 1);
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
  assertProviderHandle(attached);
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
  assertProviderHandle(attached);
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

test("recycled pid terminalizes the recorded writer without touching the replacement process", async () => {
  const harness = createHarness();
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  harness.launches[0]!.processIdentity = "fake-process-4100-birth-2";

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });
  assert.ok(attached && "state" in attached);
  assert.equal(attached.state, "terminal");
  assert.equal(attached.terminal.terminalCause, "crashed");
  assert.equal(harness.launches.length, 1);
  assert.equal(harness.clients.length, 1, "a recycled pid is rejected before endpoint contact");
  assert.deepEqual(harness.signals, [], "the replacement process must not be signalled");
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

test("fresh attach proves an empty unmaterialized daemon-inbox thread without launching a second writer", async () => {
  const harness = createHarness({ threadReadUnmaterialized: true });
  const request = spawnRequest({ deliveryMode: "daemon_inbox" });
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assertProviderHandle(attached);
  assert.equal(attached.providerContinuationId, first.providerContinuationId);
  assert.equal(harness.launches.length, 1, "the verified existing writer must be retained");
  assert.deepEqual(
    harness.clients[1]!.requests
      .filter((entry) => entry.method === "thread/read")
      .map((entry) => (entry.params as { includeTurns?: boolean }).includeTurns),
    [true, false],
    "metadata-only proof is used only after the exact empty-thread response",
  );
  assert.deepEqual(harness.signals, []);
});

test("fresh attach returns terminal evidence when the recorded app-server is verifiably gone", async () => {
  const harness = createHarness({ threadReadFails: true });
  const request = spawnRequest();
  const first = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(request);
  harness.launches[0]!.resolveExit({ type: "exit", code: null, signal: "SIGKILL" });

  const attached = await new CodexProviderAdapter({ dependencies: harness.dependencies }).attach({
    workAttemptId: request.workAttemptId,
    providerContinuationId: first.providerContinuationId!,
    providerConnection: first.providerConnection,
  });

  assert.ok(attached && "state" in attached);
  assert.equal(attached.state, "terminal");
  assert.equal(attached.terminal.terminalCause, "crashed");
  assert.equal(attached.terminal.providerContinuationId, first.providerContinuationId);
  assert.equal(harness.clients.length, 1, "a proven-absent process is rejected before endpoint contact");
  assert.deepEqual(harness.signals, [], "a proven-absent process is never signalled");
});

test("resume capability fails honestly when app-server lacks thread/resume", async () => {
  const harness = createHarness({ resumeSupported: false });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const request = spawnRequest();
  const first = await adapter.spawn(request);

  assert.equal(
    adapter.capabilities().resume,
    true,
    "fresh thread/start cannot safely infer resume support without a real continuation",
  );
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

test("native stream carries accumulated readable reasoning summaries but never raw reasoning text", async () => {
  const harness = createHarness();
  const nativeStream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => nativeStream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  const identity = {
    threadId: handle.providerContinuationId,
    turnId: "turn-readable-summary",
    itemId: "item-readable-summary",
    summaryIndex: 0,
  };

  harness.clients[0]!.emit({
    method: "item/reasoning/summaryTextDelta",
    params: { ...identity, delta: "Checking the room " },
  });
  harness.clients[0]!.emit({
    method: "item/reasoning/summaryTextDelta",
    params: { ...identity, delta: "delivery path." },
  });
  harness.clients[0]!.emit({
    method: "item/reasoning/textDelta",
    params: { ...identity, delta: "private chain of thought must not become UI copy" },
  });

  const readable = nativeStream.filter((event) => event.method === "item/reasoning/summaryTextDelta");
  assert.deepEqual(readable.map((event) => event.summary), [
    "Checking the room",
    "Checking the room delivery path.",
  ]);
  assert.equal(
    nativeStream.find((event) => event.method === "item/reasoning/textDelta")?.summary,
    "Codex raw reasoning text is streaming.",
  );
  assert.equal(
    nativeStream.some((event) => event.summary?.includes("private chain of thought")),
    false,
    "raw reasoning content never enters the human-readable stream summary",
  );
});

test("native terminal failure status changes the Codex handle to failed", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  harness.clients[0]!.emit({
    method: "turn/completed",
    params: { turn: { status: "failed" } },
  });
  await flush();
  assert.equal(handle.observedState(), "failed");

  harness.clients[0]!.emit({
    method: "thread/status/changed",
    params: { threadStatus: { type: "systemError" } },
  });
  await flush();
  assert.equal(handle.observedState(), "failed");
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
