import "./isolated-home.js";
import assert from "node:assert/strict";
import test from "node:test";
import { CodexProviderAdapter } from "../main/agents/codex-provider-adapter.js";
import { CodexRpcClient } from "../main/agents/codex-rpc-client.js";
import type { ProviderStreamEvent } from "../main/agents/provider-adapter.js";
import { ProviderTurnControlError } from "../main/agents/provider-adapter.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import {
  type RecordedRequest,
  roomReadiness,
  assertProviderHandle,
  createHarness,
  spawnRequest,
  flush,
  codexRoomTurnInput,
} from "./codex-provider-adapter.fixture.js";

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

test("Codex turn control cannot clear or act past a genuine runtime failure", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  client.requests.length = 0;

  await assert.rejects(adapter.controlTurn!(handle, "Do not dispatch this correction.", {
    checkpointTurnStarted: async () => {},
    markDispatched: async () => {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
    },
  }), (error: unknown) => error instanceof ProviderTurnControlError
    && error.turnControlOutcome === "uncertain");
  assert.equal(handle.observedState(), "failed");
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);

  client.turnStatus = "completed";
  await assert.rejects(adapter.controlTurn!(handle, null), (error: unknown) =>
    error instanceof ProviderTurnControlError && error.turnControlOutcome === "uncertain");
  assert.equal(handle.observedState(), "failed");
});

test("Codex retry never retargets completed A to newer active B", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const original = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read") return {
      thread: { id: handle.providerContinuationId, turns: [
        { id: "turn-A", status: "interrupted", items: [] },
        { id: "turn-B", status: "inProgress", items: [] },
      ] },
    } as T;
    return original<T>(method, params);
  };
  client.requests.length = 0;
  const checkpoints: string[] = [];

  const stopped = await adapter.controlTurn!(handle, null, {
    targetTurnId: "turn-A",
    checkpointTurnStarted: async (turnId) => { checkpoints.push(turnId); },
    markDispatched: async () => { throw new Error("must not dispatch against B"); },
  });
  assert.deepEqual(stopped, { capability: "native_interrupt", interrupted: false, resumed: false, state: "working" });
  await assert.rejects(() => adapter.controlTurn!(handle, "apply exact correction", {
    targetTurnId: "turn-A",
    checkpointTurnStarted: async () => {},
    markDispatched: async () => { throw new Error("must not dispatch against B"); },
  }), /newer turn is active/);
  assert.deepEqual(checkpoints, ["turn-A"]);
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(client.requests.some((request) => request.method === "turn/start"), false);
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
      const prompt = (params as { input: Array<{ text: string }> }).input[0]!.text;
      assert.match(prompt, /chat reply publication does not publish code or create PRs/);
      assert.match(prompt, /standing merge approval/);
      assert.match(prompt, /LetAgents room tools do not provide browser automation or a preview service/);
      assert.match(prompt, /capabilities actually exposed and authorized in this runtime/);
      assert.match(prompt, /report the specific gap once and continue independent feasible work/);
      assert.match(prompt, /leave affected verification incomplete/);
      assert.match(prompt, /Do not repeat an unchanged capability attempt or blocker report/);
      assert.match(prompt, /Still respond to explicit user instructions and new questions/);
      assert.match(prompt, /acknowledgment-only closing messages.*no-reply completion/);
      assert.match(prompt, /return exactly LETAGENTS_NO_ROOM_REPLY with no other text/);
      assert.doesNotMatch(prompt, /Browser QA is unavailable here/, "Codex may have separately configured authorized tools; the shared prompt must not claim Cursor's sealed capability limits");
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

test("Codex bounded room turn passes included images as labelled local image paths after the prompt", async () => {
  const { adapter, input } = await codexRoomTurnInput([
    { index: 1, fileName: "notes.pdf", mimeType: "application/pdf", sizeBytes: 500, status: "not_image" },
    { index: 2, fileName: 'shot "1".png', mimeType: "image/png", sizeBytes: 2048, status: "image",
      image: { mimeType: "image/png", path: "/scratch/turn-1/image-1.png" } },
    { index: 3, fileName: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 4096, status: "image",
      image: { mimeType: "image/jpeg", path: "/scratch/turn-1/image-2.jpg" } },
  ]);
  assert.equal(adapter.roomTurnImageDelivery(), "file");
  const [prompt, ...rest] = input;
  assert.equal(prompt!.type, "text");
  assert.deepEqual(prompt!.text_elements, []);
  assert.deepEqual(rest, [
    { type: "text", text: 'Image 1: "shot \\"1\\".png"', text_elements: [] },
    { type: "localImage", path: "/scratch/turn-1/image-1.png" },
    { type: "text", text: 'Image 2: "photo.jpg"', text_elements: [] },
    { type: "localImage", path: "/scratch/turn-1/image-2.jpg" },
  ], "labels and paths follow the prompt in the order the notes number them");
  const lines = String(prompt!.text).split("\n");
  const header = lines.indexOf("Files attached to the source message (LetAgents prepared them for this turn; do not try to download them):");
  assert.ok(header > 0, "the prompt lists the attached files");
  assert.deepEqual(lines.slice(header + 1, header + 4), [
    '- Attachment 1: "notes.pdf" (application/pdf, 500 bytes). Not shown: only images (PNG, JPEG, GIF, WebP) reach agents.',
    '- Attachment 2: "shot \\"1\\".png" (image/png, 2 KB). Included after this text as image 1.',
    '- Attachment 3: "photo.jpg" (image/jpeg, 4 KB). Included after this text as image 2.',
  ]);
  assert.equal(JSON.stringify(rest).includes("notes.pdf"), false, "a file that is not an image is only a note in the text");
});

test("Codex bounded room turn adds nothing for an image without a file path or for a turn without images", async () => {
  const withoutPath = await codexRoomTurnInput([
    { index: 1, fileName: "inline.png", mimeType: "image/png", sizeBytes: 3, status: "image",
      image: { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) } },
    { index: 2, fileName: "huge.png", mimeType: "image/png", sizeBytes: 11 * 1024 * 1024, status: "too_large" },
  ]);
  assert.equal(withoutPath.input.length, 1, "bytes in memory are not an input Codex reads; only the prompt text is sent");
  assert.equal(withoutPath.input[0]!.type, "text");
  const none = await codexRoomTurnInput(undefined);
  assert.equal(none.input.length, 1);
  assert.doesNotMatch(String(none.input[0]!.text), /Files attached to the source message/);
  const empty = await codexRoomTurnInput([]);
  assert.equal(empty.input.length, 1);
  assert.doesNotMatch(String(empty.input[0]!.text), /Files attached to the source message/);
});

test("Codex bounded room turn verifies its exact terminal state when thread idle arrives without a turn terminal event", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest());
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let boundedStatus = "inProgress";
  let settled = false;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-idle-reconcile" } } as T;
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [{ id: "turn-idle-reconcile", status: boundedStatus, items: [
        { type: "agentMessage", phase: "final", text: "Verified after idle." },
      ] }],
    } } as T;
    return originalRequest<T>(method, params);
  };

  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-idle-reconcile",
    actionId: "action-idle-reconcile",
    sourceMessage: {},
    activation: {},
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  void pending.then(() => { settled = true; });
  await flush();

  client.emit({ method: "thread/status/changed", params: {
    threadId: "other-thread", status: { type: "idle" },
  } });
  await flush();
  assert.equal(settled, false, "another thread becoming idle cannot settle the bounded turn");

  client.emit({ method: "thread/status/changed", params: {
    threadId: handle.providerContinuationId, status: { type: "idle" },
  } });
  await flush();
  assert.equal(settled, false, "idle alone cannot be treated as successful terminal evidence");

  boundedStatus = "completed";
  client.emit({ method: "thread/status/changed", params: {
    threadId: handle.providerContinuationId, status: { type: "idle" },
  } });
  assert.deepEqual(await pending, {
    turnId: "turn-idle-reconcile",
    outcome: "reply",
    text: "Verified after idle.",
    evidence: "transcript",
  });
});

test("room readiness targets the exact thread's LetAgents server while unrelated discovery hangs", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  const probes: RecordedRequest[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "mcpServerStatus/list") {
      probes.push({ method, params });
      return new Promise<T>(() => {});
    }
    if (method === "mcpServer/resource/read") {
      probes.push({ method, params });
      await ready;
      return roomReadiness() as T;
    }
    return originalRequest<T>(method, params);
  };
  let dispatches = 0;
  const running = adapter.runRoomTurn!(handle, {
    inboxItemId: "target-tools", actionId: "target-tools-action", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => { dispatches += 1; } });
  void running.catch(() => undefined);
  await flush();
  assert.equal(dispatches, 0, "a pending readiness read cannot start model work");
  assert.deepEqual(probes, [{ method: "mcpServer/resource/read", params: {
    threadId: handle.providerContinuationId, server: "letagents", uri: "letagents://runtime/readiness",
  } }]);
  release(); await flush();
  assert.equal(dispatches, 1);
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId, turnId: `turn-${handle.providerContinuationId}`,
  } });
  await running;
  assert.equal(probes.length, 1, "no aggregate discovery or polling is needed");
});

test("Codex blocks invalid or unavailable room readiness before any dispatch", async (t) => {
  const payload = JSON.parse(roomReadiness().contents[0].text);
  const resource = (value: unknown) => ({ contents: [{ ...roomReadiness().contents[0], text: JSON.stringify(value) }] });
  for (const [name, readiness] of Object.entries({
    "missing resource": { contents: [] },
    "old runtime without resource": new Error("Resource not found"),
    "failed connection": new Error("MCP server connection failed"),
    "malformed result": {},
    "ambiguous resource": { contents: [...roomReadiness().contents, ...roomReadiness().contents] },
    "wrong URI": { contents: [{ ...roomReadiness().contents[0], uri: "letagents://other" }] },
    "wrong MIME type": { contents: [{ ...roomReadiness().contents[0], mimeType: "text/plain" }] },
    "malformed JSON": { contents: [{ ...roomReadiness().contents[0], text: "{" }] },
    "oversized resource": { contents: [{ ...roomReadiness().contents[0], text: " ".repeat(64 * 1024 + 1) }] },
    "wrong format": resource({ ...payload, format: 2 }),
    "wrong profile": resource({ ...payload, profile: "autonomous_mcp_worker" }),
    "wrong provider": resource({ ...payload, provider: "cursor" }),
    "malformed tools": resource({ ...payload, tools: { get_board: {} } }),
    "missing board tool": roomReadiness(["claim_task", "read_messages", "send_message"]),
    "probe timeout": new Error("request timed out"),
  })) await t.test(name, async () => {
    const harness = createHarness();
    const spawn = spawnRequest({ deliveryMode: "daemon_inbox" });
    const original = await new CodexProviderAdapter({ dependencies: harness.dependencies }).spawn(spawn);
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.attach({ workAttemptId: spawn.workAttemptId,
      providerContinuationId: original.providerContinuationId!, providerConnection: original.providerConnection,
      launchPolicy: spawn.launchPolicy });
    assertProviderHandle(handle);
    const client = harness.clients.at(-1)!;
    const originalRequest = client.request.bind(client);
    let probes = 0;
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "mcpServer/resource/read") {
        probes += 1;
        assert.deepEqual(params, { threadId: original.providerContinuationId, server: "letagents", uri: "letagents://runtime/readiness" });
        if (readiness instanceof Error) throw readiness;
        return readiness as T;
      }
      return originalRequest<T>(method, params);
    };
    let dispatches = 0;
    await assert.rejects(adapter.runRoomTurn!(handle, {
      inboxItemId: "inbox-tools", actionId: "action-tools", sourceMessage: {}, activation: {},
    }, { beforeNativeDispatch: async () => { dispatches += 1; } }), {
      providerFailureCode: "provider_room_tools_unavailable",
      ...(name === "probe timeout" ? { message: "Room tool discovery timed out. No model turn was started. Retry the message." } : {}),
      ...(name === "missing board tool" ? { message: "Required LetAgents room tools are missing from this conversation. No model turn was started. Retry the message." } : {}),
    });
    assert.equal(dispatches, 0);
    assert.equal(client.requests.some(request => request.method === "turn/start"), false);
    assert.equal(probes, 1, "unavailable readiness never falls back to aggregate discovery");
    assert.equal(client.closed, false, "observation remains attached");
    assert.deepEqual(harness.signals, [], "a missing tool never kills the provider");
    assert.equal(harness.launches.length, 1);
  });
});

test("room readiness uses the unchanged bounded RPC budget without dispatching early", async (t) => {
  for (const delayMs of [6_500, 35_000]) await t.test(`inventory after ${delayMs}ms`, async (t) => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    const originalRequest = client.request.bind(client);
    const originalWebSocket = globalThis.WebSocket;
    let probes = 0;
    class DiscoverySocket {
      static readonly OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close() { this.readyState = 3; }
      send(raw: string) {
        const message = JSON.parse(raw);
        if (message.id === undefined) return;
        if (message.method === "initialize") {
          queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) }));
          return;
        }
        assert.equal(message.method, "mcpServer/resource/read");
        assert.equal(message.params.threadId, handle.providerContinuationId);
        probes += 1;
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: roomReadiness() }) }), delayMs);
      }
    }
    globalThis.WebSocket = DiscoverySocket as unknown as typeof WebSocket;
    const rpc = new CodexRpcClient("ws://synthetic.invalid");
    try {
      await rpc.connect();
      client.request = <T>(method: string, params?: unknown, options?: { timeoutMs?: number }) =>
        method === "mcpServer/resource/read" ? rpc.request<T>(method, params, options) : originalRequest<T>(method, params);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let dispatches = 0; let settled = false;
      const running = adapter.runRoomTurn!(handle, {
        inboxItemId: "slow-tools", actionId: "slow-tools-action", sourceMessage: {}, activation: {},
      }, { beforeNativeDispatch: async () => { dispatches += 1; } });
      void running.then(() => { settled = true; }, () => { settled = true; });
      const timeout = delayMs > 30_000 ? assert.rejects(running, /Room tool discovery timed out/) : null;
      await flush();
      t.mock.timers.tick(5_001); await flush();
      assert.equal(settled, false, "healthy MCP startup may exceed five seconds");
      assert.equal(dispatches, 0, "discovery itself never starts a model turn");
      if (timeout) {
        t.mock.timers.tick(30_000 - 5_001); await timeout;
        assert.equal(dispatches, 0);
        t.mock.timers.tick(delayMs - 30_000); await flush();
        assert.equal(dispatches, 0, "a late response cannot revive a timed-out delivery");
      } else {
        t.mock.timers.tick(delayMs - 5_001); await flush();
        assert.equal(dispatches, 1);
        client.emit({ method: "turn/completed", params: {
          threadId: handle.providerContinuationId, turnId: `turn-${handle.providerContinuationId}`,
        } });
        await running;
      }
      assert.equal(probes, 1, "discovery does not add a retry or polling loop");
    } finally { rpc.close(); globalThis.WebSocket = originalWebSocket; }
  });
});

test("Codex rechecks target readiness on each new turn but not exact prior-turn recovery", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let healthy = true;
  const probes: unknown[] = [];
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "mcpServer/resource/read") {
      probes.push(params);
      return (healthy ? roomReadiness() : roomReadiness([])) as T;
    }
    return originalRequest<T>(method, params);
  };
  const request = { inboxItemId: "inbox-ready", actionId: "action-ready", sourceMessage: {}, activation: {} };
  const running = adapter.runRoomTurn!(handle, request);
  await flush();
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId, turnId: `turn-${handle.providerContinuationId}`,
  } });
  await running;
  assert.deepEqual(probes, [
    { threadId: handle.providerContinuationId, server: "letagents", uri: "letagents://runtime/readiness" },
  ]);
  healthy = false;
  await assert.rejects(adapter.runRoomTurn!(handle, { ...request, inboxItemId: "inbox-next", actionId: "action-next" }), {
    providerFailureCode: "provider_room_tools_unavailable",
  });
  assert.equal(client.requests.filter(request => request.method === "turn/start").length, 1);
  assert.equal((await adapter.recoverRoomTurn!(handle, { inboxItemId: request.inboxItemId,
    providerTurnId: `turn-${handle.providerContinuationId}` })).turnId, `turn-${handle.providerContinuationId}`);
  assert.equal(probes.length, 2, "exact prior-turn recovery does not depend on current tool availability");
});

test("Codex refuses readiness evidence from a replaced RPC connection", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    const response = await originalRequest<T>(method, params);
    if (method === "mcpServer/resource/read") client.connectionEpoch = "replacement";
    return response;
  };
  let dispatched = false;
  await assert.rejects(adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-stale-tools", actionId: "action-stale-tools", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => { dispatched = true; } }), /runtime is unavailable/);
  assert.equal(dispatched, false);
  assert.equal(client.requests.some(request => request.method === "turn/start"), false);
});

test("an exact missing conversation during tool discovery retains automatic continuation repair", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "mcpServer/resource/read") throw new Error(`thread not found: ${handle.providerContinuationId}`);
    return originalRequest<T>(method, params);
  };
  await assert.rejects(adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-missing", actionId: "action-missing", sourceMessage: {}, activation: {},
  }), { providerFailureCode: "provider_continuation_missing", providerContinuationId: handle.providerContinuationId });
  assert.equal(client.requests.some(request => request.method === "turn/start"), false);
});

test("a failed Codex room turn leaves the same runtime available for its successor", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  let turnNumber = 0;
  const statuses = new Map<string, string>();
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") {
      const turnId = turnNumber++ === 0 ? "turn-failed" : "turn-successor";
      statuses.set(turnId, "inProgress");
      return { turn: { id: turnId } } as T;
    }
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [...statuses].map(([id, status]) => ({
        id,
        status,
        error: status === "failed" ? { message: "HTTP 503 unavailable" } : null,
        items: id === "turn-successor"
          ? [{ type: "agentMessage", phase: "final", text: "Successor completed." }]
          : [],
      })),
    } } as T;
    return originalRequest<T>(method, params);
  };

  const failed = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-failed", actionId: "action-failed", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush();
  statuses.set("turn-failed", "failed");
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId, turnId: "turn-failed", turn: { id: "turn-failed", status: "failed" },
  } });
  assert.deepEqual(await failed, { turnId: "turn-failed", providerContinuationId: handle.providerContinuationId,
    outcome: "failed", text: null, evidence: "transcript", error: "HTTP 503 unavailable" });
  assert.equal(handle.observedState(), "idle");
  assert.equal(harness.launches[0]?.alive, true);

  const successor = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-successor", actionId: "action-successor", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush();
  statuses.set("turn-successor", "completed");
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId, turnId: "turn-successor", turn: { id: "turn-successor", status: "completed" },
  } });
  assert.deepEqual(await successor, {
    turnId: "turn-successor", outcome: "reply", text: "Successor completed.", evidence: "transcript",
  });
  assert.equal(handle.observedState(), "idle");
  assert.equal(harness.launches.length, 1, "the successor reuses the same native app-server");
  assert.deepEqual(harness.signals, []);
});

test("a runtime failure during the turn checkpoint cannot be cleared by turn settlement", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: "turn-runtime-failure" } } as T;
    if (method === "thread/read") return { thread: {
      id: handle.providerContinuationId,
      turns: [{ id: "turn-runtime-failure", status: "completed", items: [
        { type: "agentMessage", phase: "final", text: "Turn completed after runtime failure." },
      ] }],
    } } as T;
    return originalRequest<T>(method, params);
  };

  const pending = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-runtime-failure", actionId: "action-runtime-failure", sourceMessage: {}, activation: {},
  }, {
    beforeNativeDispatch: async () => {},
    checkpointTurnStarted: async () => {
      client.emit({ method: "thread/status/changed", params: {
        threadId: handle.providerContinuationId, status: { type: "systemError" },
      } });
      await flush();
    },
  });
  await flush();
  assert.equal(handle.observedState(), "failed");
  client.emit({ method: "turn/completed", params: {
    threadId: handle.providerContinuationId,
    turnId: "turn-runtime-failure",
    turn: { id: "turn-runtime-failure", status: "completed" },
  } });
  assert.deepEqual(await pending, {
    turnId: "turn-runtime-failure", outcome: "reply",
    text: "Turn completed after runtime failure.", evidence: "transcript",
  });
  assert.equal(handle.observedState(), "failed");
});

test("a provider-refused turn on a daemon-inbox lane fails the turn, not the runtime, and the thread takes the next turn", async () => {
  const refusal = "The provider refused this turn. Try rephrasing your request.";
  const harness = createHarness();
  const stream: ProviderStreamEvent[] = [];
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies, streamSink: (event) => stream.push(event) });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed" }));
  const observations: NativeExecutionObservation[] = [];
  adapter.onExecution(handle, (event) => observations.push(event));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  const threadId = handle.providerContinuationId;
  const turns = [
    { id: "turn-refused", status: "failed", error: { message: refusal, codexErrorInfo: "cyberPolicy" }, items: [] },
    { id: "turn-refused-again", status: "failed", error: { message: refusal, codexErrorInfo: "cyberPolicy" }, items: [] },
    { id: "turn-answered", status: "completed", items: [{ type: "agentMessage", phase: "final", text: "Answered on the same thread." }] },
  ];
  let started = 0;
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: turns[started++]!.id } } as T;
    if (method === "thread/read") return { thread: { id: threadId, turns: turns.slice(0, started) } } as T;
    return originalRequest<T>(method, params);
  };
  const checkpointed: Array<{ outcome: string; runtime: string }> = [];
  const run = (turn: typeof turns[number]) => {
    const pending = adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-${turn.id}`, actionId: `action-${turn.id}`, sourceMessage: {}, activation: {},
    }, {
      beforeNativeDispatch: async () => {},
      checkpointTurnStarted: async () => {},
      checkpointTerminalResult: async (result) => {
        checkpointed.push({ outcome: result.outcome, runtime: handle.observedState() });
        return { acceptedResult: result, cleanupRecoveryEvidence: true };
      },
    });
    return { pending, identity: { threadId, turnId: turn.id } };
  };
  const refuse = async (turn: typeof turns[number]) => {
    const { pending, identity } = run(turn);
    await flush();
    client.emit({ method: "turn/started", params: { ...identity, turn: { id: turn.id, status: "inProgress" } } });
    // The order the app-server sends when the provider refuses a turn.
    client.emit({ method: "thread/status/changed", params: { threadId, status: { type: "systemError" } } });
    assert.equal(handle.observedState(), "working", "the thread's systemError status does not end the runtime");
    client.emit({ method: "error", params: { ...identity, willRetry: false, error: turn.error } });
    client.emit({ method: "turn/completed", params: { ...identity, turn } });
    assert.deepEqual(await pending, { turnId: turn.id, providerContinuationId: threadId,
      outcome: "failed", text: null, evidence: "transcript", error: refusal, refusal: true });
    assert.equal(handle.observedState(), "idle");
  };

  await refuse(turns[0]!);
  await refuse(turns[1]!);
  assert.notEqual((await adapter.probeControl(handle)).state, "lost", "a control probe does not report the runtime gone");

  const answered = run(turns[2]!);
  await flush();
  client.emit({ method: "turn/started", params: { ...answered.identity, turn: { id: "turn-answered", status: "inProgress" } } });
  client.emit({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
  client.emit({ method: "turn/completed", params: { ...answered.identity, turn: turns[2] } });
  assert.deepEqual(await answered.pending, {
    turnId: "turn-answered", outcome: "reply", text: "Answered on the same thread.", evidence: "transcript",
  });

  assert.deepEqual(checkpointed, [
    { outcome: "failed", runtime: "idle" }, { outcome: "failed", runtime: "idle" }, { outcome: "reply", runtime: "idle" },
  ], "each ending is offered for checkpoint on a runtime the daemon may still use");
  const lifecycle = observations.map((event) => event.fact)
    .filter((fact) => fact.domain === "runtime" || fact.domain === "turn")
    .map((fact) => [fact.domain, fact.state, "turnOutcome" in fact ? fact.turnOutcome : undefined]);
  assert.equal(observations.some((event) => event.fact.domain === "control" && event.fact.state === "lost"), false);
  assert.deepEqual(lifecycle, [
    ["runtime", "ready", undefined],
    ["runtime", "ready", undefined], ["turn", "active", undefined], ["turn", "terminal", "failed"],
    ["runtime", "ready", undefined], ["turn", "active", undefined], ["turn", "terminal", "failed"],
    ["runtime", "ready", undefined], ["turn", "active", undefined], ["turn", "terminal", "completed"],
  ], "each refusal is one failed turn; nothing is reported lost and the runtime never exits");
  assert.equal(harness.launches.length, 1, "one app-server served all three turns");
  assert.deepEqual(harness.signals, []);
  assert.deepEqual(stream.filter((event) => event.method === "error").map((event) => event.summary),
    [`Codex error: ${refusal}`, `Codex error: ${refusal}`], "the owner's activity names the provider's reason");
});

test("only a policy refusal is marked as one; other failed turns are not", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", lifecycleAuthorityMode: "typed" }));
  const client = harness.clients[0]!;
  const originalRequest = client.request.bind(client);
  const threadId = handle.providerContinuationId;
  let current: Record<string, unknown> = {};
  client.request = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/start") return { turn: { id: current.id } } as T;
    if (method === "thread/read") return { thread: { id: threadId, turns: [current] } } as T;
    return originalRequest<T>(method, params);
  };
  const cases: Array<[unknown, boolean]> = [
    ["cyberPolicy", true], ["misalignmentPolicyViolation", true],
    ["unauthorized", false], ["usageLimitExceeded", false], ["rateLimitExceeded", false], ["contextWindowExceeded", false],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, false], ["other", false], [null, false],
  ];
  for (const [index, [codexErrorInfo, refusal]] of cases.entries()) {
    current = { id: `turn-${index}`, status: "failed", error: { message: "The turn failed.", codexErrorInfo }, items: [] };
    const pending = adapter.runRoomTurn!(handle, {
      inboxItemId: `inbox-${index}`, actionId: `action-${index}`, sourceMessage: {}, activation: {},
    }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
    await flush();
    client.emit({ method: "turn/completed", params: { threadId, turnId: current.id, turn: current } });
    const result = await pending;
    assert.equal(result.outcome, "failed");
    assert.equal("refusal" in result && result.refusal === true, refusal, JSON.stringify(codexErrorInfo));
  }

  // A turn someone stopped is not a refusal, whatever error it carries.
  current = { id: "turn-stopped", status: "interrupted", error: { message: "The turn was stopped.", codexErrorInfo: "cyberPolicy" }, items: [] };
  const stopped = adapter.runRoomTurn!(handle, {
    inboxItemId: "inbox-stopped", actionId: "action-stopped", sourceMessage: {}, activation: {},
  }, { beforeNativeDispatch: async () => {}, checkpointTurnStarted: async () => {} });
  await flush();
  client.emit({ method: "turn/completed", params: { threadId, turnId: current.id, turn: current } });
  const interrupted = await stopped;
  assert.equal(interrupted.outcome, "interrupted");
  assert.equal("refusal" in interrupted, false, "an interrupted turn carries no refusal mark");
});

test("a lane that polls for itself still ends its runtime on a thread systemError", async () => {
  for (const lifecycleAuthorityMode of ["typed_shadow", "legacy"] as const) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ lifecycleAuthorityMode }));
    const observations: NativeExecutionObservation[] = [];
    adapter.onExecution(handle, (event) => observations.push(event));
    harness.clients[0]!.emit({ method: "thread/status/changed", params: {
      threadId: handle.providerContinuationId, status: { type: "systemError" },
    } });
    assert.equal(handle.observedState(), "failed", lifecycleAuthorityMode);
    assert.deepEqual(observations.at(-1)?.fact, { domain: "runtime", kind: "state_changed", state: "exited",
      controlEvidence: "native_session_terminated", sideEffects: "none" }, lifecycleAuthorityMode);
  }
});
