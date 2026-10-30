import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CodexProviderAdapter } from "../main/agents/codex-provider-adapter.js";
import type {
  ProviderActivityEvent,
  ProviderContinuationRef,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../main/agents/provider-adapter.js";
import { ProviderExecutionObserver } from "../main/agents/provider-execution-observer.js";
import type { NativeExecutionObservation, NativeTurnBoundary } from "../../shared/execution-protocol.js";
import {
  providerStreamLifecycle,
  emptyExecutionProjection,
  reduceExecutionFact,
  type RecordedRequest,
  FakeRpc,
  createHarness,
  spawnRequest,
  flush,
} from "./codex-provider-adapter.fixture.js";
import { OS_BIRTH } from "./platform.js";

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
  assert.deepEqual(seen[0]?.nativeRuntimeDeath, { kind: "codex_app_server", pid: 4100, processIdentity: handle.providerConnection!.processIdentity });
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

test("stop refuses signals without the exact process birth before dispatch or escalation", async (t) => {
  for (const evidence of ["reused", "absent", "unknown"] as const) {
    for (const stage of ["graceful", "force", "escalation"] as const) {
      await t.test(`${stage}: ${evidence}`, async () => {
        const harness = createHarness();
        const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
        const handle = await adapter.spawn(spawnRequest());
        const initialState = handle.observedState();
        const terminals: ProviderTerminalPayload[] = [];
        adapter.onExit(handle, (terminal) => terminals.push(terminal));
        const invalidate = () => {
          if (evidence === "reused") harness.launches[0]!.processIdentity += "-reused";
          else if (evidence === "absent") harness.launches[0]!.alive = false;
          else harness.setIdentityObservable(false);
        };
        if (stage !== "escalation") invalidate();
        const stopped = adapter.stop(handle, { force: stage === "force", graceMs: 0 });
        if (stage === "escalation") invalidate();
        // Keep the event loop alive for the adapter's existing unref'd grace timer.
        const keepAlive = setTimeout(() => {}, 1_000);
        try {
          await assert.rejects(stopped, /exact process birth cannot be verified/);
          assert.deepEqual(harness.signals, stage === "escalation" ? [{ pid: 4100, signal: "SIGTERM" }] : []);
          assert.equal(handle.observedState(), stage === "escalation" ? "stopping" : initialState);
          assert.equal(terminals.length, 0, "a refused signal must not manufacture a terminal payload");
        } finally {
          clearTimeout(keepAlive);
          harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
        }
      });
    }
  }
});

test("Codex exact-reference stop validates the complete recorded owner before signalling", async () => {
  const harness = createHarness({ processIdentity: OS_BIRTH.first });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const ref: ProviderContinuationRef = {
    workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!,
    providerConnection: { ...handle.providerConnection! },
  };
  for (const patch of [
    { workAttemptId: "" }, { providerContinuationId: "" }, { providerConnection: null },
    { providerConnection: { kind: "claude_cli", pid: 4100, processIdentity: "fake-process-4100-birth-1" } },
    { providerConnection: { ...ref.providerConnection, pid: 0 } },
    { providerConnection: { ...ref.providerConnection, pid: 1.5 } },
    { providerConnection: { ...ref.providerConnection, processIdentity: " " } },
    { providerConnection: { ...ref.providerConnection, processIdentity: "unreadable birth" } },
    { providerConnection: { ...ref.providerConnection, processIdentity: "Mon Aug 99 25:00:00 2026" } },
    { providerConnection: { ...ref.providerConnection, url: "" } },
    { workAttemptId: "different-owner" }, { providerContinuationId: "different-thread" },
    { providerConnection: { ...ref.providerConnection, url: "ws://127.0.0.1:9999" } },
  ]) {
    await assert.rejects(adapter.stopRef({ ...ref, ...patch } as ProviderContinuationRef, { graceMs: 0 }), /exact-reference stop/);
  }
  assert.deepEqual(harness.signals, []);
  assert.equal(handle.observedState(), "idle");
  for (const identity of [undefined, "unreadable birth", "Mon Aug 99 25:00:00 2026", null, OS_BIRTH.second] as const) {
    const freshAdapter = new CodexProviderAdapter({ dependencies: { ...harness.dependencies, getProcessIdentity: () => identity } });
    if (identity === undefined || identity === "unreadable birth" || identity === "Mon Aug 99 25:00:00 2026") {
      assert.equal(harness.launches[0]!.alive, true);
      await assert.rejects(freshAdapter.stopRef(ref), /birth cannot be verified/, "malformed ps text cannot prove a live process was replaced");
    }
    else {
      const { endedAt, ...terminal } = await freshAdapter.stopRef(ref);
      assert.ok(endedAt);
      assert.deepEqual(terminal, { exitCode: null, signal: null, terminalCause: "stopped", providerContinuationId: ref.providerContinuationId,
        nativeRuntimeDeath: { kind: "codex_app_server", pid: 4100, processIdentity: ref.providerConnection!.processIdentity } });
    }
  }
  assert.deepEqual(harness.signals, [], "no attachment or signal is needed after exact birth absence/replacement");
  assert.equal(harness.clients.length, 1);
});

test("Codex exact-reference stop proves OS death even with a cached protocol terminal", async () => {
  const harness = createHarness({ processIdentity: OS_BIRTH.first });
  const signalProcess = harness.dependencies.signalProcess;
  harness.dependencies.signalProcess = (pid, signal) => {
    signalProcess(pid, signal);
    if (signal === "SIGKILL") harness.launches[0]!.alive = false;
  };
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const ref = { workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: { ...handle.providerConnection! } };
  harness.launches[0]!.resolveExit({ type: "error", error: new Error("protocol error, not OS death") });
  harness.launches[0]!.alive = true;
  await flush();
  assert.equal(handle.observedState(), "failed");
  const before = harness.clients[0]!.requests.length;
  const terminal = await adapter.stopRef(ref, { graceMs: 0 });
  assert.equal(terminal.terminalCause, "stopped");
  assert.equal(terminal.exitCode, null, "the signal's exit status is not invented");
  assert.equal(terminal.signal, null);
  assert.deepEqual(harness.signals, [{ pid: 4100, signal: "SIGTERM" }, { pid: 4100, signal: "SIGKILL" }]);
  assert.equal(harness.clients[0]!.requests.length, before, "stopRef does not depend on a functioning native transport");
  assert.equal(harness.launches.length, 1);
});

test("Codex exact-reference stop rechecks birth at escalation and never trusts a signal as death", async () => {
  for (const evidence of ["unknown", "malformed", "replaced", "absent", "still_alive", "force"] as const) {
    const harness = createHarness({ processIdentity: OS_BIRTH.first });
    const signalProcess = harness.dependencies.signalProcess;
    const getProcessIdentity = harness.dependencies.getProcessIdentity;
    let signalled = false;
    let readsAfterSignal = 0;
    harness.dependencies.getProcessIdentity = (pid) => {
      if (signalled && ++readsAfterSignal === 2) {
        if (evidence === "unknown") harness.setIdentityObservable(false);
        if (evidence === "malformed") harness.launches[0]!.processIdentity = "unreadable birth";
        if (evidence === "replaced") harness.launches[0]!.processIdentity = OS_BIRTH.second;
      }
      return getProcessIdentity(pid);
    };
    harness.dependencies.signalProcess = (pid, signal) => {
      signalProcess(pid, signal);
      signalled = true;
      if (evidence === "absent" || evidence === "force") harness.launches[0]!.alive = false;
    };
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const ref = { workAttemptId: handle.workAttemptId, providerContinuationId: handle.providerContinuationId!, providerConnection: { ...handle.providerConnection! } };
    const stoppingAdapter = evidence === "force" ? new CodexProviderAdapter({ dependencies: harness.dependencies }) : adapter;
    const stopped = stoppingAdapter.stopRef(ref, { graceMs: 0, force: evidence === "force" });
    if (evidence === "unknown" || evidence === "malformed" || evidence === "still_alive") await assert.rejects(stopped, /cannot be verified|not yet proved/);
    else assert.equal((await stopped).terminalCause, "stopped");
    assert.deepEqual(harness.signals, evidence === "still_alive"
      ? [{ pid: 4100, signal: "SIGTERM" }, { pid: 4100, signal: "SIGKILL" }]
      : [{ pid: 4100, signal: evidence === "force" ? "SIGKILL" : "SIGTERM" }]);
    assert.equal(handle.observedState(), evidence === "force" ? "idle" : "stopping", "the reference proof does not mint a native lifecycle event");
    assert.equal(harness.clients.length, 1, "a fresh adapter stops the saved birth without attaching its native transport");
  }
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

test("native turn failure leaves the Codex runtime reusable while system failure latches", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());

  harness.clients[0]!.emit({
    method: "turn/completed",
    params: { turn: { status: "failed" } },
  });
  await flush();
  assert.equal(handle.observedState(), "idle");

  harness.clients[0]!.emit({
    method: "thread/status/changed",
    params: { threadId: handle.providerContinuationId, status: { type: "systemError" } },
  });
  await flush();
  assert.equal(handle.observedState(), "failed");

  harness.clients[0]!.emit({
    method: "turn/completed",
    params: { turn: { status: "completed" } },
  });
  await flush();
  assert.equal(handle.observedState(), "failed", "turn settlement cannot clear process/control failure");
});

test("Codex spawn cannot clear runtime failure observed before handle admission or initial turn acknowledgement", async () => {
  const queuedHarness = createHarness();
  const queuedCreateClient = queuedHarness.dependencies.createRpcClient;
  const queuedAdapter = new CodexProviderAdapter({ dependencies: {
    ...queuedHarness.dependencies,
    createRpcClient: (serverUrl, notify) => {
      const client = queuedCreateClient(serverUrl, notify) as FakeRpc;
      client.emit({ method: "thread/status/changed", params: {
        threadId: "thread-1", status: { type: "systemError" },
      } });
      return client;
    },
  } });
  const queuedHandle = await queuedAdapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  assert.equal(queuedHandle.observedState(), "failed", "queued native failure survives the idle launch baseline");

  const pollingHarness = createHarness();
  const pollingCreateClient = pollingHarness.dependencies.createRpcClient;
  const pollingAdapter = new CodexProviderAdapter({ dependencies: {
    ...pollingHarness.dependencies,
    createRpcClient: (serverUrl, notify) => {
      const client = pollingCreateClient(serverUrl, notify) as FakeRpc;
      const request = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await request<T>(method, params);
        if (method === "turn/start") {
          client.emit({ method: "thread/status/changed", params: {
            threadId: "thread-1", status: { type: "systemError" },
          } });
          await flush();
        }
        return result;
      };
      return client;
    },
  } });
  const pollingHandle = await pollingAdapter.spawn(spawnRequest());
  assert.equal(pollingHandle.observedState(), "failed", "turn acknowledgement cannot clear runtime failure");
});

test("execution failures preserve the Codex runtime and subsequent exact room turns", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const failures = [
    { method: "item/commandExecution/failed", kind: "command_output", params: { status: "failed", exitCode: 1 } },
    { method: "item/mcpToolCall/failed", kind: "tool_lifecycle", params: { status: "error" } },
    { method: "item/fileChange/failed", kind: "tool_lifecycle", params: { status: "failed" } },
    { method: "command/exec/failed", kind: "command_output", params: { status: "failed" } },
    { method: "item/completed", kind: "item_lifecycle", params: { item: { type: "commandExecution", status: "failed", error: { message: "exit 1" } } } },
    { method: "item/completed", kind: "item_lifecycle", params: { item: { type: "fileChange", status: "failed", error: { message: "write denied" } } } },
    { method: "item/failed", kind: "error", params: { status: "failed" } },
  ];
  for (const failure of failures) {
    client.emit(failure);
    assert.equal(stream.at(-1)?.kind, failure.kind, failure.method);
    assert.equal(providerStreamLifecycle(stream.at(-1)!), "working", failure.method);
    assert.equal(handle.observedState(), "working", failure.method);
  }
  await flush();
  assert.equal(harness.launches[0]!.alive, true);
  assert.deepEqual(harness.signals, []);

  // Item failures neither settle the containing turn nor poison its successor.
  const originalRequest = client.request.bind(client);
  let nativeTurn = 0;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: `turn-after-error-${nativeTurn++}` } } as T;
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [{ id: `turn-after-error-${nativeTurn - 1}`, status: "completed" }],
    } } as T;
    return originalRequest<T>(method, params);
  };
  for (let index = 0; index < 2; index += 1) {
    const running = adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-after-tool-error-${index}`,
      actionId: `action-after-tool-error-${index}`,
      sourceMessage: {}, activation: {},
    }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
    await flush();
    client.emit({ method: "item/commandExecution/failed", params: { status: "failed", exitCode: 1 } });
    assert.equal(handle.observedState(), "working");
    client.emit({ method: "item/agentMessage/delta", params: {
      threadId: handle.providerContinuationId, turnId: `turn-after-error-${index}`,
      itemId: `answer-${index}`, delta: "Recovered from command failure.",
    } });
    client.emit({ method: "turn/completed", params: {
      threadId: handle.providerContinuationId, turnId: `turn-after-error-${index}`,
    } });
    assert.equal((await running).outcome, "reply");
    assert.equal(handle.observedState(), "idle");
  }
  assert.equal(harness.launches.length, 1, "both turns reuse the same app-server");
  assert.deepEqual(harness.signals, []);
  client.emit({ method: "process/systemError", params: { status: "systemError" } });
  assert.equal(stream.at(-1)?.kind, "error", "process errors are not command failures");
  assert.equal(handle.observedState(), "failed", "genuine runtime failure still latches");
});

test("typed Codex authority is daemon-inbox only and ignores raw execution failure classification", async () => {
  const rejectedHarness = createHarness();
  const rejected = new CodexProviderAdapter({ dependencies: rejectedHarness.dependencies });
  await assert.rejects(
    rejected.spawn(spawnRequest({ deliveryMode: "mcp_polling", lifecycleAuthorityMode: "typed" })),
    /Typed Codex lifecycle authority requires daemon-inbox delivery/,
  );
  assert.equal(rejectedHarness.launches.length, 0, "an invalid authority/delivery pair starts no runtime");

  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({
    deliveryMode: "daemon_inbox",
    lifecycleAuthorityMode: "typed",
  }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, event => observations.push(event));
  assert.equal(observations[0]?.fact.domain, "runtime");
  assert.equal(observations[0]?.fact.state, "ready",
    "successful app-server setup emits replayable runtime readiness before room work");
  const client = harness.clients[0]!;
  client.emit({ method: "turn/started", params: {
    threadId: handle.providerContinuationId,
    turnId: "typed-turn",
    turn: { id: "typed-turn", status: "inProgress" },
  } });
  assert.equal(handle.observedState(), "working");
  client.emit({ method: "thread/status/changed", params: {
    threadId: "unrelated-thread",
    status: { type: "systemError" },
  } });
  assert.equal(handle.observedState(), "working",
    "an unrelated raw runtime failure cannot mutate the exact typed runtime handle");
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

test("Codex typed shadow separates exact tool and turn failures from the reusable runtime handle", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies, streamSink: (event) => stream.push(event) });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, () => { throw new Error("shadow writer unavailable"); });
  const unsubscribe = adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const threadId = handle.providerContinuationId;
  const emit = (method: string, params: Record<string, unknown>) => client.emit({ method, params: { threadId, turnId: "turn-1", ...params } });
  emit("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
  emit("item/started", { item: { id: "command-1", type: "commandExecution", status: "inProgress", processId: "pty-1", command: "SECRET=hidden npm test", cwd: "/private/project" } });
  emit("item/commandExecution/outputDelta", { itemId: "command-1", delta: "secret output" });
  emit("item/completed", { item: { id: "command-1", type: "commandExecution", status: "failed", exitCode: 1 } });
  assert.equal(handle.observedState(), "working");
  assert.equal(providerStreamLifecycle(stream.at(-1)!), "working");
  const failedTurn = { turn: { id: "turn-1", status: "failed" } };
  emit("turn/completed", failedTurn);
  emit("turn/completed", failedTurn);
  emit("turn/failed", failedTurn);
  assert.equal(handle.observedState(), "idle", "the failed turn does not poison the reusable runtime handle");
  for (const event of stream.filter((candidate) => /^turn\/(?:completed|failed)$/.test(candidate.method))) {
    assert.equal(event.kind, "turn_lifecycle", "the adapter preserves exact turn identity ahead of generic failure labels");
    assert.equal(providerStreamLifecycle(event), "terminal",
      "the daemon agrees that an exact failed turn leaves the Codex app-server reusable");
  }
  emit("turn/started", { turnId: "turn-2", turn: { id: "turn-2", status: "inProgress" } });
  let projection = emptyExecutionProjection();
  for (const observation of observations) {
    projection = reduceExecutionFact(projection, {
      ...observation.fact, factId: `fact-${observation.sequence}`, agentId: "agent", executionGenerationId: "generation",
      runtimeGenerationId: "runtime", observerEpoch: 1, sourceSequence: observation.sequence, observedAtMs: observation.observedAtMs,
      ...("providerTurnId" in observation.fact ? { turnId: `local-${observation.fact.providerTurnId}` } : {}),
    });
    assert.equal(observation.nativeProcessIdentity, handle.providerConnection?.processIdentity);
    assert.equal(projection.runtime, "ready", "the exact native start proves readiness from an empty projection");
  }
  assert.equal(projection.runtime, "ready", "native turn failure never says the app-server died");
  assert.equal(projection.turns.get("local-turn-1").outcome, "failed");
  assert.equal(projection.turns.get("local-turn-1").operations.get("command-1").exitCode, 1);
  assert.equal(projection.turns.get("local-turn-2").state, "active");
  assert.equal(/SECRET|secret output|private\/project/.test(JSON.stringify(observations)), false);
  const streamCheckpointIds = [...new Set(stream.flatMap((event) => event.nativeEventId ? [event.nativeEventId] : []))];
  const typedCheckpointIds = [...new Set(observations.flatMap((event) => event.fact.nativeEventId ? [event.fact.nativeEventId] : []))];
  assert.deepEqual(typedCheckpointIds, streamCheckpointIds,
    "exact native turn lifecycle events carry the same opaque identity in typed and legacy projections");
  assert.equal(stream.every((event) => !event.nativeEventId || event.nativeLifecyclePhase ===
    (event.method === "turn/started" ? "turn_active" : "turn_terminal")), true,
  "correlated Codex events expose only the closed structural lifecycle phase");
  assert.equal(streamCheckpointIds.length, 3, "two native starts and one native terminal are independently correlated");
  const terminalIds = stream.filter((event) => event.method === "turn/completed")
    .map((event) => event.nativeEventId);
  assert.equal(terminalIds.length, 2);
  assert.equal(terminalIds[0], terminalIds[1], "an identical terminal replay keeps the first checkpoint identity");
  assert.ok(streamCheckpointIds.every((value) => /^nlc1:[A-Za-z0-9_-]{43}$/.test(value)));
  assert.equal(stream.some((event) => event.method.startsWith("item/") && event.nativeEventId !== undefined), false,
    "execution and display events are outside turn-lifecycle checkpoint identity");
  assert.equal(observations.some((event) => event.fact.domain === "execution" && event.fact.nativeEventId !== undefined), false);
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1);
  unsubscribe.dispose();
  const replayed: NativeExecutionObservation[] = [];
  const stopReplay = adapter.onExecution(handle, (event) => replayed.push(event));
  assert.deepEqual(replayed, observations, "late installation receives the same structural facts, not a reconstructed transcript");
  assert.equal(stopReplay.sourceId, unsubscribe.sourceId);
  assert.ok(replayed.every(event => event.sourceId === stopReplay.sourceId));
  stopReplay.dispose();
});

test("direct Codex turn/failed emits its own typed terminal checkpoint", async () => {
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({
    dependencies: harness.dependencies,
    streamSink: (event) => stream.push(event),
  });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const params = { threadId: handle.providerContinuationId, turnId: "turn-direct-failed" };
  client.emit({ method: "turn/started", params: {
    ...params, turn: { id: params.turnId, status: "inProgress" },
  } });
  client.emit({ method: "turn/failed", params: {
    ...params, turn: { id: params.turnId, status: "failed" },
  } });

  const failedStream = stream.find((event) => event.method === "turn/failed");
  assert.ok(failedStream?.nativeEventId);
  assert.equal(failedStream.kind, "turn_lifecycle");
  assert.equal(providerStreamLifecycle(failedStream), "terminal");
  const failedFact = observations.find((event) => event.fact.domain === "turn"
    && event.fact.providerTurnId === params.turnId
    && event.fact.state === "terminal");
  assert.ok(failedFact && failedFact.fact.domain === "turn");
  assert.equal(failedFact.fact.turnOutcome, "failed");
  assert.equal(failedFact.fact.nativeEventId, failedStream.nativeEventId,
    "the direct failure carries one shared typed/legacy checkpoint identity");
});

test("execution observation replay stays bounded and preserves source gaps", () => {
  const observer = new ProviderExecutionObserver(() => "2026-08-31T00:00:00.000Z");
  const fact = { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" } as const;
  for (let index = 0; index < 300; index++) observer.emit(fact, `birth-${index}`);
  const replay: NativeExecutionObservation[] = [];
  const stop = observer.subscribe(event => replay.push(event));
  assert.equal(replay.length, 256);
  assert.equal(replay[0]!.sequence, 45);
  assert.equal(replay.at(-1)!.sequence, 300);
  assert.equal(replay[0]!.nativeProcessIdentity, "birth-44");
  assert.equal(replay[0]!.observedAtMs, Date.parse("2026-08-31T00:00:00.000Z"));
  assert.ok(Object.isFrozen(replay[0]) && Object.isFrozen(replay[0]!.fact));
  assert.deepEqual(stop.position(), { firstRetainedSequence: 45, latestSequence: 300 });
  stop.dispose();

  // UTF-8 bytes, not character count, bound even malformed adapter input.
  for (let index = 0; index < 100; index++) observer.emit({ ...fact, nativeEventId: "😀".repeat(1024) });
  const bounded: NativeExecutionObservation[] = [];
  const stopBounded = observer.subscribe(event => bounded.push(event));
  stopBounded.dispose();
  assert.ok(bounded.length < 100);
  assert.equal(bounded.at(-1)!.sequence, 400);
  assert.ok(bounded.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= 256 * 1024);
  observer.emit({ ...fact, nativeEventId: "x".repeat(256 * 1024) });
  assert.equal(stopBounded.position().latestSequence, 401, "a dropped trailing observation remains visible in the source watermark");
  observer.emit(fact, "final-birth");
  const afterGap: NativeExecutionObservation[] = [];
  observer.subscribe(event => afterGap.push(event)).dispose();
  assert.deepEqual(afterGap.slice(-2).map(event => event.sequence), [400, 402]);
  assert.equal(replay.length, 256, "unsubscribed observers receive neither live events nor later replay");
});

test("execution observation replay and live fan-out preserve reentrant order and listener isolation", () => {
  const observer = new ProviderExecutionObserver(() => "2026-08-31T00:00:00.000Z");
  let emitted = 0;
  // Alternate real transitions so this ordering test remains independent of
  // steady-state control-observation coalescing.
  const emit = () => observer.emit({ domain: "control", kind: "state_changed",
    state: emitted++ % 2 === 0 ? "responsive" : "degraded", sideEffects: "none" });
  emit(); emit();
  const first: number[] = [];
  const second: number[] = [];
  observer.subscribe(event => {
    first.push(event.sequence);
    if (event.sequence === 1 || event.sequence === 4) emit();
    throw new Error("journal unavailable");
  });
  const secondSubscription = observer.subscribe(event => {
    second.push(event.sequence);
    if (event.sequence === 4) secondSubscription.dispose();
  });
  emit(); emit();
  assert.deepEqual(first, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(second, [1, 2, 3, 4], "unsubscribe during fan-out prevents later facts, including reentrant ones");
  const replay: number[] = [];
  observer.subscribe(event => replay.push(event.sequence)).dispose();
  assert.deepEqual(replay, first);
  const replacement = new ProviderExecutionObserver(() => "2026-08-31T00:00:00.000Z");
  const otherSource = replacement.subscribe(() => {});
  assert.notEqual(otherSource.sourceId, secondSubscription.sourceId, "observer replacement is independent of native process identity");
  assert.deepEqual(otherSource.position(), { firstRetainedSequence: 1, latestSequence: 0 });
  otherSource.dispose();
});

test("Codex pending approval is not execution start; malformed exact terminals consume an unavailable source position", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const params = { threadId: handle.providerContinuationId, turnId: "pending-turn" };
  client.emit({ method: "item/started", params: { ...params, item: { id: "pending", type: "commandExecution", status: "inProgress", processId: null } } });
  client.emit({ method: "item/started", params: { ...params, item: { id: "patch", type: "fileChange", status: "inProgress" } } });
  client.emit({ method: "turn/completed", params: { ...params, turn: { id: "pending-turn", status: "futureStatus" } } });
  assert.equal(observations.length, 2);
  assert.equal(observations[1]!.sequence, 3, "the malformed terminal consumes one position after runtime readiness");
  assert.deepEqual(observations[1]!.fact, {
    domain: "control", kind: "state_changed", state: "degraded", sideEffects: "none",
  });
  client.emit({ method: "item/commandExecution/outputDelta", params: { ...params, threadId: "wrong", itemId: "pending", delta: "data" } });
  client.emit({ method: "item/completed", params: { threadId: params.threadId, item: { id: "no-turn", type: "commandExecution", status: "failed" } } });
  client.emit({ method: "item/reasoning/textDelta", params: { ...params, delta: "private reasoning" } });
  assert.equal(observations.length, 2, "unrelated malformed item/display events still mint no structural facts");
  client.emit({ method: "item/completed", params: { ...params, item: { id: "pending", type: "commandExecution", status: "declined" } } });
  assert.equal(observations.length, 3);
  const fact = observations[2]!.fact;
  assert.equal(fact.domain, "execution");
  assert.equal(fact.kind, "completed");
  assert.equal("outcome" in fact && fact.outcome, "denied_before_start");
  assert.equal(fact.sideEffects, "none");
  client.emit({ method: "turn/started", params: { ...params, turn: { id: params.turnId, status: "inProgress" } } });
  client.emit({ method: "item/started", params: { ...params, item: { id: "orphan", type: "commandExecution", status: "inProgress", processId: "pty" } } });
  harness.launches[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  const orphan = observations.find((entry) => entry.fact.domain === "execution" && entry.fact.kind === "completed" && entry.fact.executionId === "orphan");
  assert.equal(orphan?.fact.domain === "execution" && orphan.fact.kind === "completed" && orphan.fact.outcome, "lost_after_start");
  assert.equal(observations.at(-1)?.fact.domain, "runtime");
  assert.equal(await adapter.probeControl(handle).then((result) => result.state), "lost");
  assert.deepEqual(harness.signals, []);
});

test("explicit Codex system errors emit one typed hard-runtime terminal before process exit", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({
    deliveryMode: "daemon_inbox",
    lifecycleAuthorityMode: "typed",
  }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const params = { threadId: handle.providerContinuationId, turnId: "system-error-turn" };
  let resolveProbe!: (value: unknown) => void;
  client.request = <T>(): Promise<T> => new Promise((resolve) => {
    resolveProbe = resolve as (value: unknown) => void;
  });
  const pendingProbe = adapter.probeControl(handle);
  client.emit({ method: "turn/started", params: { ...params, turn: { id: params.turnId, status: "inProgress" } } });
  client.emit({ method: "item/started", params: { ...params,
    item: { id: "system-error-command", type: "commandExecution", status: "inProgress", processId: "pty-system-error" } } });
  // On a typed lane a thread's `systemError` status is a failed turn; only a
  // process-level system error ends the runtime.
  client.emit({ method: "process/systemError", params: { status: "systemError" } });

  const hardTerminals = observations.filter((event) => event.fact.domain === "runtime" || event.fact.domain === "control");
  assert.deepEqual(hardTerminals.map((event) => event.fact), [
    { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
    { domain: "runtime", kind: "state_changed", state: "ready", sideEffects: "none" },
    { domain: "control", kind: "state_changed", state: "lost", controlEvidence: "native_session_terminated", sideEffects: "none" },
    { domain: "runtime", kind: "state_changed", state: "exited", controlEvidence: "native_session_terminated", sideEffects: "none" },
  ]);
  assert.equal(observations.some((event) => event.fact.domain === "turn" && event.fact.state === "lost"), true);
  assert.equal(observations.some((event) => event.fact.domain === "execution" && event.fact.kind === "completed"
    && event.fact.outcome === "lost_after_start"), true);

  const terminalCount = observations.length;
  resolveProbe({ data: [], nextCursor: null });
  assert.deepEqual(await pendingProbe, {
    state: "lost", controlEvidence: "native_session_terminated",
  }, "an in-flight probe cannot reopen a conclusively lost runtime");
  assert.equal(observations.length, terminalCount);
  client.emit({ method: "turn/started", params: {
    ...params, turnId: "late-turn", turn: { id: "late-turn", status: "inProgress" },
  } });
  client.emit({ method: "item/started", params: {
    ...params, turnId: "late-turn", item: {
      id: "late-command", type: "commandExecution", status: "inProgress", processId: "pty-late",
    },
  } });
  client.emit({ method: "process/systemError", params: { status: "systemError" } });
  client.emit({ method: "thread/status/changed", params: {
    threadId: handle.providerContinuationId, status: { type: "systemError" },
  } });
  client.disconnect();
  harness.launches[0]!.resolveExit({ type: "exit", code: 1, signal: null });
  await flush();
  assert.equal(observations.length, terminalCount,
    "late activity, disconnect, repeated system error, and process exit cannot reopen or extend the terminal tail");
  assert.deepEqual(await adapter.probeControl(handle), {
    state: "lost", controlEvidence: "native_session_terminated",
  }, "a probe preserves the first conclusive terminal without appending another fact");
  assert.equal(observations.length, terminalCount);
  assert.equal(handle.observedState(), "failed");
});

test("Codex cheap probes degrade on uncertainty and lose control only on exact process proof", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const probes: unknown[] = [];
  let response: unknown = { data: [], nextCursor: null };
  client.request = async <T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T> => {
    probes.push({ method, params, options });
    if (response instanceof Error) throw response;
    return response as T;
  };
  assert.deepEqual(await adapter.probeControl(handle), { state: "responsive" });
  response = new Error("request timed out");
  for (let i = 0; i < 3; i++) assert.deepEqual(await adapter.probeControl(handle), { state: "degraded" });
  response = { data: "malformed" };
  assert.deepEqual(await adapter.probeControl(handle), { state: "degraded" });
  response = new Error("JSON-RPC -32601: method not found");
  assert.deepEqual(await adapter.probeControl(handle), { state: "unprobeable" });
  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(probes[0], { method: "thread/loaded/list", params: { limit: 1 }, options: { timeoutMs: 2_000 } });
  assert.equal(probes.every((probe) => (probe as { method: string }).method === "thread/loaded/list"), true);
  harness.setIdentityObservable(false);
  const count = probes.length;
  assert.deepEqual(await adapter.probeControl(handle), { state: "degraded" });
  assert.equal(probes.length, count, "unverified process never receives a probe");
  harness.setIdentityObservable(true);
  harness.launches[0]!.processIdentity += "-replaced";
  assert.deepEqual(await adapter.probeControl(handle), { state: "lost", controlEvidence: "process_birth_changed" });
  assert.equal(probes.length, count);
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1);
});

test("Codex turn-boundary inspection validates the complete native snapshot without changing execution", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const identity = { providerContinuationId: "thread-1", nativeProcessIdentity: harness.launches[0]!.processIdentity };
  const idle = (latestProviderTurnId: string | null): NativeTurnBoundary => ({ state: "idle", ...identity, latestProviderTurnId });
  const active: NativeTurnBoundary = { state: "active", ...identity, providerTurnId: "waiting-turn" };
  const unknown: NativeTurnBoundary = { state: "unknown" };
  const snapshot = (turns: unknown, status: unknown = { type: "idle" }, id: unknown = "thread-1") => ({ thread: { id, status, turns } });
  const terminal = { id: "last-turn", status: "completed" };
  const waiting = { id: "waiting-turn", status: "inProgress", items: [{ type: "mcpToolCall", server: "letagents", tool: "wait_for_messages", status: "inProgress" }] };
  const cases: Array<[string, unknown, NativeTurnBoundary]> = [
    ["empty idle", snapshot([]), idle(null)],
    ["all terminal", snapshot(["completed", "interrupted", "failed", "cancelled", "stopped"].map(status => ({ id: status, status })), "idle"), idle("stopped")],
    ["nested turn status", snapshot([{ id: "nested", status: { status: "completed" } }]), idle("nested")],
    ["MCP waiting before latest terminal", snapshot([waiting, terminal], { type: "active" }), active],
    ["MCP waiting after terminal", snapshot([terminal, waiting], { type: "active" }), active],
    ["missing response", undefined, unknown], ["missing thread", {}, unknown],
    ["missing turns", snapshot(undefined), unknown], ["null turns", snapshot(null), unknown],
    ["object turns", snapshot({}), unknown], ["malformed turn", snapshot([null, terminal]), unknown],
    ["missing turn status", snapshot([{ id: "missing" }, terminal]), unknown],
    ["malformed turn status", snapshot([{ id: "malformed", status: { status: 1 } }]), unknown],
    ["unknown turn status", snapshot([{ id: "unknown", status: "futureStatus" }, terminal]), unknown],
    ["missing turn id", snapshot([{ status: "completed" }]), unknown],
    ["malformed turn id", snapshot([{ id: 1, status: "completed" }]), unknown],
    ["unsafe turn id", snapshot([{ id: "turn\nspoof", status: "completed" }]), unknown],
    ["oversized turn id", snapshot([{ id: "x".repeat(513), status: "completed" }]), unknown],
    ["wrong continuation", snapshot([], "idle", "different-thread"), unknown],
    ["duplicate turn", snapshot([terminal, terminal]), unknown],
    ["multiple active", snapshot([waiting, { ...waiting, id: "other-active" }]), unknown],
    ["active thread but terminal turns", snapshot([terminal], { type: "active" }), unknown],
    ["active thread but no turns", snapshot([], { type: "active" }), unknown],
    ["missing thread status", { thread: { id: "thread-1", turns: [] } }, unknown],
    ["malformed thread status", snapshot([], { type: 1 }), unknown],
    ["timeout", new Error("Codex app-server request timed out: thread/read"), unknown],
    ["unsupported", new Error("JSON-RPC -32601: method not found"), unknown],
    ["unmaterialized", new Error("thread is not materialized yet; includeTurns is unavailable before first user message"), unknown],
  ];
  const observations: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(handle, event => observations.push(event));
  assert.equal(observations[0]?.fact.domain, "runtime");
  assert.equal(observations[0]?.fact.state, "ready");
  observations.length = 0;
  const reads: RecordedRequest[] = [];
  let response: unknown;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    reads.push({ method, params });
    client.requests.push({ method, params });
    if (response instanceof Error) throw response;
    return response as T;
  };
  for (const [name, value, expected] of cases) {
    response = value;
    assert.deepEqual(await adapter.inspectTurnBoundary(handle), expected, name);
    assert.equal(handle.observedState(), "idle", `${name}: native inspection must not mutate the handle`);
  }
  assert.equal(observations.length, 0, "native snapshot inspection emits no lifecycle facts");
  assert.equal(reads.length, cases.length);
  assert.ok(reads.every(read => read.method === "thread/read"));
  assert.deepEqual(reads[0]!.params, { threadId: "thread-1", includeTurns: true });
  harness.setIdentityObservable(false);
  assert.deepEqual(await adapter.inspectTurnBoundary(handle), unknown);
  assert.equal(reads.length, cases.length, "unverifiable process receives no native read");
  harness.setIdentityObservable(true);
  client.emit({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "live-turn", status: "inProgress" } } });
  assert.deepEqual(observations.map(event => event.fact.domain), ["runtime", "turn"], "ordinary native capture still receives real observations");
  assert.equal(handle.observedState(), "working");
  response = snapshot([]);
  assert.deepEqual(await adapter.inspectTurnBoundary(handle), idle(null));
  assert.equal(handle.observedState(), "working", "native idle discovery must not rewrite legacy lifecycle state");
  assert.equal(observations.length, 2);
  assert.deepEqual(harness.signals, []);
  assert.equal(harness.launches.length, 1);
  assert.equal(client.requests.some(request => request.method === "turn/start" || request.method === "turn/interrupt"), false);
  subscription.dispose();
});

test("an unloaded Codex thread proves idle only when its exact app-server has no loaded threads", async () => {
  const cases = [
    { name: "empty", loaded: { data: [], nextCursor: null }, idle: true },
    { name: "same thread loaded", loaded: { data: ["thread-1"], nextCursor: null } },
    { name: "another thread loaded", loaded: { data: ["other-thread"], nextCursor: null } },
    { name: "incomplete page", loaded: { data: [], nextCursor: "next" } },
    { name: "missing cursor", loaded: { data: [] } },
    { name: "missing data", loaded: { nextCursor: null } },
    { name: "null data", loaded: { data: null, nextCursor: null } },
    { name: "unavailable", loaded: new Error("read failed") },
    { name: "process replaced", loaded: { data: [], nextCursor: null }, race: true },
  ];
  for (const testCase of cases) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    const calls: string[] = [];
    client.request = async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === "thread/read") return { thread: { id: handle.providerContinuationId,
        status: { type: "notLoaded" }, turns: [{ id: "finished", status: "completed" }] } } as T;
      assert.equal(method, "thread/loaded/list");
      if (testCase.race) harness.launches[0]!.processIdentity += "-replaced";
      if (testCase.loaded instanceof Error) throw testCase.loaded;
      return testCase.loaded as T;
    };
    assert.equal((await adapter.inspectTurnBoundary(handle)).state, testCase.idle ? "idle" : "unknown", testCase.name);
    assert.deepEqual(calls, ["thread/read", "thread/loaded/list"], testCase.name);
    assert.deepEqual(harness.signals, []);
  }
});

for (const race of ["process_birth", "continuation", "owned_handle"] as const) {
  test(`Codex turn-boundary inspection rejects ${race} changes during its native read`, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const request = spawnRequest({ deliveryMode: "daemon_inbox" });
    const handle = await adapter.spawn(request);
    const client = harness.clients[0]!;
    const originalRequest = client.request.bind(client);
    let release!: () => void;
    let markReading!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { markReading = resolve; });
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method !== "thread/read") return originalRequest<T>(method, params);
      client.requests.push({ method, params });
      markReading();
      await waiting;
      return { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } } as T;
    };
    const observations: NativeExecutionObservation[] = [];
    const subscription = adapter.onExecution(handle, event => observations.push(event));
    const pending = adapter.inspectTurnBoundary(handle);
    await reading;
    if (race === "process_birth") harness.launches[0]!.processIdentity += "-replaced";
    else if (race === "continuation") {
      await adapter.repairContinuation(handle, {
        workAttemptId: handle.workAttemptId, expectedProviderContinuationId: "thread-1",
        checkpointedReplacementProviderContinuationId: "thread-repaired", cwd: request.cwd, launchPolicy: request.launchPolicy,
      }, { checkpointReplacement: async () => {} });
      assert.equal(handle.providerContinuationId, "thread-repaired");
    } else {
      harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
      await flush();
      const replacement = await adapter.spawn(request);
      assert.notEqual(replacement, handle);
    }
    const factsBeforeReadCompletes = observations.length;
    const stateBeforeReadCompletes = handle.observedState();
    release();
    assert.deepEqual(await pending, { state: "unknown" });
    assert.equal(observations.length, factsBeforeReadCompletes);
    assert.equal(handle.observedState(), stateBeforeReadCompletes);
    assert.deepEqual(harness.signals, [], "inspection never kills or interrupts a raced provider");
    assert.equal(harness.launches.length, race === "owned_handle" ? 2 : 1, "only the test's explicit replacement may launch");
    subscription.dispose();
  });
}

for (const race of ["none", "unloaded", "unloaded_permission", "unloaded_connection", "permission", "connection", "birth", "active", "unknown", "reservation"] as const) {
  test(`idle replacement sends no signal after ${race} proof changes`, async () => {
    const harness = createHarness({ exitOnSignal: true });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.request = async <T>(method: string): Promise<T> => {
      if (method === "thread/loaded/list") {
        if (race === "unloaded_permission") client.pendingPermissions.set(22, { id: 22, method: "unknown/request", params: {}, connectionId: client.connectionEpoch });
        if (race === "unloaded_connection") client.connectionEpoch = "replacement";
        return { data: [], nextCursor: null } as T;
      }
      if (race === "permission") client.pendingPermissions.set(22, { id: 22, method: "unknown/request", params: {}, connectionId: client.connectionEpoch });
      if (race === "connection") client.connectionEpoch = "replacement";
      if (race === "birth") harness.launches[0]!.processIdentity += "-replacement";
      return (race === "unknown" ? {} : { thread: { id: handle.providerContinuationId,
        status: { type: race.startsWith("unloaded") ? "notLoaded" : race === "active" ? "active" : "idle" },
        turns: race === "active" ? [{ id: "turn-live", status: "inProgress" }] : [] } }) as T;
    };
    let finalChecks = 0;
    const stopping = adapter.stopIdle(handle, () => {
      finalChecks += 1;
      if (race === "reservation") throw new Error("reservation changed");
    });
    if (race === "none" || race === "unloaded") {
      assert.equal((await stopping).terminalCause, "stopped");
      assert.equal(finalChecks, 1);
      assert.deepEqual(harness.signals, [{ pid: handle.pid, signal: "SIGTERM" }]);
    } else {
      await assert.rejects(stopping, /not provably idle|reservation changed/);
      assert.deepEqual(harness.signals, []);
    }
  });
}
