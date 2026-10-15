import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({ prefix: "letagents-codex-rpc-client-", paths: [] });

const { CodexRpcClient } = await import("../main/agents/codex-rpc-client.js");

test("CodexRpcClient initializes app-server using the documented wire shape", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sentMessages: Array<Record<string, unknown>> = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
      queueMicrotask(() => this.onopen?.());
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id?: number; method?: string };
      sentMessages.push(message);
      if (!message.id) {
        return;
      }
      const result = message.method === "thread/start"
        ? { thread: { id: "thread_1" } }
        : {};
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) });
      });
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500");
    assert.equal(client.currentConnectionId(), null);
    await client.connect();
    assert.match(client.currentConnectionId()!, /^[0-9a-f-]{36}$/);
    await client.request("thread/start", {});
    client.close();
    assert.equal(client.currentConnectionId(), null);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }

  assert.equal(sentMessages[0]?.method, "initialize");
  assert.equal(sentMessages[0]?.jsonrpc, undefined);
  assert.deepEqual((sentMessages[0]?.params as { clientInfo?: unknown } | undefined)?.clientInfo, {
    name: "letagents-desktop-codex-supervisor",
    title: "LetAgents Desktop Codex Supervisor",
    version: "0.1.0",
  });
  assert.equal(sentMessages[1]?.method, "initialized");
  assert.equal(sentMessages[1]?.jsonrpc, undefined);
  assert.equal(sentMessages[2]?.method, "thread/start");
  assert.equal(sentMessages[2]?.jsonrpc, undefined);
});

test("CodexRpcClient fences server requests, malformed replies and reconnects independently of outbound RPC", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    sent: Array<Record<string, unknown>> = [];
    failResponse = false;
    beforeResponseSend: (() => void) | null = null;
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      });
    }
    emit(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
    send(raw: string): void {
      const message = JSON.parse(raw) as Record<string, unknown>;
      this.sent.push(message);
      if (Object.hasOwn(message, "result")) this.beforeResponseSend?.();
      if (this.failResponse && Object.hasOwn(message, "result")) throw new Error("uncertain send");
      if (message.method === "initialize") queueMicrotask(() => this.emit({ id: message.id, result: {} }));
    }
    close(): void { this.readyState = 3; this.onclose?.(); }
  }
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const client = new CodexRpcClient("ws://127.0.0.1:4500");
  try {
    const connecting = client.connect();
    assert.equal(client.currentConnectionId(), null);
    await connecting;
    const socket = sockets[0]!;
    const firstConnection = client.currentConnectionId();
    assert.ok(firstConnection);
    const snapshots: Array<{ connectionId: string | null; ids: Array<string | number> }> = [];
    const unsubscribeChangesThrower = client.onPendingRequestsChanged(() => { throw new Error("observer failure"); });
    const unsubscribeChanges = client.onPendingRequestsChanged(() => snapshots.push({
      connectionId: client.currentConnectionId(), ids: client.listPendingRequests().map(request => request.id),
    }));
    let received = 0;
    const unsubscribeThrower = client.onRequest(() => { throw new Error("consumer failure"); });
    const unsubscribe = client.onRequest(() => { received += 1; });
    let resolved = false;
    const pending = client.request("thread/read", {}).then((value) => { resolved = true; return value; });
    const id = socket.sent.at(-1)!.id;
    socket.emit({ id, method: "item/commandExecution/requestApproval", params: { command: "echo hi" } });
    const request = client.listPendingRequests()[0]!;
    const closures: typeof request[] = [];
    client.onRequestResolved(closed => closures.push(closed));
    assert.equal(request.id, id);
    assert.equal(received, 1);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.params), true);
    assert.equal(request.connectionId, firstConnection);
    assert.equal(snapshots.length, 0);
    for (const malformed of [null, [], 4, { id }, { id, error: null }, { id, result: {}, error: {} }, { id, method: null, result: {} }, { id: String(id), result: {} }]) socket.emit(malformed);
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.deepEqual(snapshots, [{ connectionId: firstConnection, ids: [id] }]);
    assert.throws(() => client.respond({ ...request }, { decision: "accept" }), /no longer pending/);
    socket.beforeResponseSend = () => {
      assert.equal(client.listPendingRequests().length, 0, "retirement must precede socket.send");
      assert.equal(snapshots.length, 1, "pending observers cannot intervene before socket.send");
    };
    client.respond(request, { decision: "decline" });
    socket.beforeResponseSend = null;
    assert.deepEqual(socket.sent.at(-1), { id, result: { decision: "decline" } });
    assert.throws(() => client.respond(request, { decision: "accept" }), /no longer pending/);
    socket.emit({ id, result: { thread: "good" } });
    assert.deepEqual(await pending, { thread: "good" });
    assert.deepEqual(snapshots.at(-1), { connectionId: firstConnection, ids: [] });
    socket.emit({ id, method: "item/commandExecution/requestApproval" });
    assert.equal(received, 2);
    const reused = client.listPendingRequests()[0]!;
    assert.notEqual(reused, request);
    assert.throws(() => client.respond(request, {}), /no longer pending/);
    client.respond(reused, { decision: "decline" });
    socket.emit({ method: "serverRequest/resolved", params: { requestId: id } });
    assert.deepEqual(closures, [], "a reused unresolved ID cannot close either approval by inference");
    unsubscribe();
    unsubscribeThrower();
    await Promise.resolve();

    const beforeCoalescedChange = snapshots.length;
    let disposedCalls = 0;
    const disposeQueued = client.onPendingRequestsChanged(() => { disposedCalls += 1; });
    socket.emit({ id: "request-string", method: "approval", params: {} });
    const stringRequest = client.listPendingRequests()[0]!;
    socket.emit({ method: "serverRequest/resolved", params: { requestId: "request-string" } });
    disposeQueued();
    await Promise.resolve();
    assert.equal(disposedCalls, 0);
    assert.equal(snapshots.length, beforeCoalescedChange + 1, "same-tick mutations coalesce, not replay event history");
    assert.deepEqual(snapshots.at(-1), { connectionId: firstConnection, ids: [] });
    assert.throws(() => client.respond(stringRequest, {}), /no longer pending/);

    socket.emit({ id: "threaded", method: "item/commandExecution/requestApproval", params: { threadId: "thread-current" } });
    const threaded = client.listPendingRequests()[0]!;
    await Promise.resolve();
    const beforeWrongThread = snapshots.length;
    for (const params of [
      { requestId: "threaded" },
      { requestId: "threaded", threadId: "thread-stale" },
      { requestId: "threaded", threadId: null },
      { requestId: "unknown", threadId: "thread-current" },
    ]) socket.emit({ method: "serverRequest/resolved", params });
    await Promise.resolve();
    assert.equal(snapshots.length, beforeWrongThread);
    assert.equal(client.listPendingRequests()[0], threaded);
    socket.emit({ method: "serverRequest/resolved", params: { requestId: "threaded", threadId: "thread-current" } });
    await Promise.resolve();
    assert.equal(snapshots.length, beforeWrongThread + 1);
    assert.equal(client.listPendingRequests().length, 0);
    assert.throws(() => client.respond(threaded, {}), /no longer pending/);
    assert.equal(closures.at(-1), threaded);
    socket.emit({ id: "sent-threaded", method: "approval", params: { threadId: "thread-current" } });
    const sentThreaded = client.listPendingRequests()[0]!;
    client.respond(sentThreaded, {});
    const beforeClosure = closures.length;
    for (const params of [{ requestId: "sent-threaded" }, { requestId: "sent-threaded", threadId: "other" }]) {
      socket.emit({ method: "serverRequest/resolved", params });
    }
    assert.equal(closures.length, beforeClosure);
    socket.emit({ method: "serverRequest/resolved", params: { requestId: "sent-threaded", threadId: "thread-current" } });
    assert.equal(closures.at(-1), sentThreaded, "sent requests retain exact identity until native closure");
    socket.emit({ method: "serverRequest/resolved", params: { requestId: "sent-threaded", threadId: "thread-current" } });
    assert.equal(closures.length, beforeClosure + 1, "closure notifications are idempotent");
    for (const scenario of ["evicted", "already_closed"]) {
      const reusedId = scenario === "evicted" ? 100 : "sent-threaded";
      if (scenario === "evicted") {
        for (let id = 100; id < 165; id++) {
          socket.emit({ id, method: "approval", params: { threadId: "thread-current" } });
          client.respond(client.listPendingRequests()[0]!, {});
        }
      }
      socket.emit({ id: reusedId, method: "approval", params: { threadId: "thread-current" } });
      const successor = client.listPendingRequests()[0]!;
      const closureCount: number = closures.length;
      socket.emit({ method: "serverRequest/resolved", params: { requestId: reusedId, threadId: "thread-current" } });
      assert.equal(client.listPendingRequests()[0], successor, `${scenario}: ambiguous closure must not erase the successor`);
      client.respond(successor, {});
      socket.emit({ method: "serverRequest/resolved", params: { requestId: reusedId, threadId: "thread-current" } });
      assert.equal(closures.length, closureCount, `${scenario}: old closure must not transfer to the reused ID`);
    }
    for (const threadId of [null, "", 4]) {
      socket.emit({ id: "malformed-thread", method: "approval", params: { threadId } });
      const malformedThread = client.listPendingRequests()[0]!;
      socket.emit({ method: "serverRequest/resolved", params: { requestId: "malformed-thread", threadId } });
      assert.equal(client.listPendingRequests()[0], malformedThread, "malformed native thread identity cannot retire a request");
      client.respond(malformedThread, { decision: "decline" });
    }

    let removedObserverCalls = 0;
    const disposeEarlierObserver = client.onPendingRequestsChanged(() => disposeLaterObserver());
    const disposeLaterObserver = client.onPendingRequestsChanged(() => { removedObserverCalls += 1; });
    await Promise.resolve();
    assert.equal(removedObserverCalls, 0, "an observer disposed during notification must not be called");
    disposeEarlierObserver();

    socket.emit({ id: "reply-string", method: "approval" });
    client.respond(client.listPendingRequests()[0]!, { decision: "decline" });
    assert.deepEqual(socket.sent.at(-1), { id: "reply-string", result: { decision: "decline" } });
    socket.emit({ id: "uncertain", method: "approval" });
    const uncertain = client.listPendingRequests()[0]!;
    await Promise.resolve();
    const beforeUncertain = snapshots.length;
    socket.beforeResponseSend = () => {
      assert.equal(client.listPendingRequests().length, 0);
      assert.equal(snapshots.length, beforeUncertain);
    };
    socket.failResponse = true;
    assert.throws(() => client.respond(uncertain, { decision: "decline" }), /uncertain send/);
    socket.beforeResponseSend = null;
    const sends = socket.sent.length;
    assert.throws(() => client.respond(uncertain, { decision: "decline" }), /no longer pending/);
    assert.equal(socket.sent.length, sends);
    socket.failResponse = false;
    await Promise.resolve();
    assert.equal(snapshots.length, beforeUncertain + 1, "uncertain response retirement still invalidates pending state");
    assert.deepEqual(snapshots.at(-1), { connectionId: firstConnection, ids: [] });

    let disconnects = 0;
    client.onDisconnect(() => { disconnects += 1; });
    await assert.rejects(client.request("thread/loaded/list", {}, { timeoutMs: 5 }), /request timed out/);
    assert.equal(disconnects, 0);
    assert.equal(socket.readyState, 1);
    assert.equal(client.currentConnectionId(), firstConnection);
    socket.emit({ id: "stale", method: "approval" });
    const stale = client.listPendingRequests()[0]!;
    const interrupted = client.request("thread/read", {});
    const interruption = assert.rejects(interrupted, /WebSocket closed/);
    socket.close();
    assert.equal(client.currentConnectionId(), null);
    await interruption;
    assert.deepEqual(snapshots.at(-1), { connectionId: null, ids: [] });
    assert.equal(client.listPendingRequests().length, 0);
    assert.throws(() => client.respond(stale, {}), /no longer pending/);
    await client.connect();
    const replacement = sockets[1]!;
    const replacementConnection = client.currentConnectionId();
    assert.ok(replacementConnection);
    assert.notEqual(replacementConnection, firstConnection);
    assert.deepEqual(snapshots.at(-1), { connectionId: replacementConnection, ids: [] });
    const beforeStaleSocket = snapshots.length;
    const healthy = client.request("thread/read", {});
    const healthyId = replacement.sent.at(-1)!.id;
    socket.onclose?.();
    socket.emit({ id: healthyId, result: "stale" });
    replacement.emit({ id: healthyId, result: "current" });
    assert.equal(await healthy, "current");
    assert.equal(disconnects, 1);
    assert.equal(snapshots.length, beforeStaleSocket);

    // A has opened, but its async initialize continuation has not run when B
    // replaces it. A must neither initialize nor close B.
    const connectA = client.connect();
    sockets[2]!.readyState = FakeWebSocket.OPEN;
    sockets[2]!.onopen?.();
    const rejectedA = assert.rejects(connectA, /connection replaced/);
    const connectB = client.connect();
    await Promise.all([rejectedA, connectB]);
    assert.equal(sockets[2]!.sent.length, 0);
    assert.equal(sockets[3]!.sent.filter(message => message.method === "initialize").length, 1);
    assert.equal(sockets[3]!.readyState, 1);
    assert.notEqual(client.currentConnectionId(), replacementConnection);
    assert.deepEqual(snapshots.at(-1), { connectionId: client.currentConnectionId(), ids: [] });
    const beforeClose = snapshots.length;
    client.close();
    assert.equal(client.currentConnectionId(), null);
    assert.equal(snapshots.length, beforeClose);
    await Promise.resolve();
    assert.deepEqual(snapshots.at(-1), { connectionId: null, ids: [] });
    unsubscribeChanges();
    unsubscribeChangesThrower();
  } finally { client.close(); globalThis.WebSocket = originalWebSocket; }
});

test("CodexRpcClient request timeout does not report a live socket as disconnected", async () => {
  const originalWebSocket = globalThis.WebSocket;
  let disconnected = 0;
  let socketClosed = false;

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
      queueMicrotask(() => this.onopen?.());
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id?: number; method?: string };
      if (!message.id || message.method !== "initialize") return;
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) });
      });
    }

    close(): void {
      socketClosed = true;
      this.readyState = 3;
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500", undefined, 5);
    client.onDisconnect(() => { disconnected += 1; });
    await client.connect();

    await assert.rejects(client.request("thread/read", {}), /request timed out: thread\/read/);
    assert.equal(disconnected, 0);
    assert.equal(socketClosed, false);
    client.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("CodexRpcClient rejects requests when the app-server socket is not open", async () => {
  const originalWebSocket = globalThis.WebSocket;

  class FakeWebSocket {
    static readonly OPEN = 1;
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500");

    await assert.rejects(
      () => client.request("thread/start", {}),
      /Codex app-server WebSocket is not open/,
    );
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("CodexRpcClient rejects connect when the app-server socket closes before opening", async () => {
  const originalWebSocket = globalThis.WebSocket;

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 3;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
      queueMicrotask(() => this.onclose?.());
    }

    send(): void {
      throw new Error("unexpected send");
    }

    close(): void {
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500");

    await assert.rejects(
      () => client.connect(),
      /WebSocket closed connecting to ws:\/\/127\.0\.0\.1:4500/,
    );
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});

test("CodexRpcClient rejects connect when the initialized notification fails", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sentMessages: Array<Record<string, unknown>> = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
      queueMicrotask(() => this.onopen?.());
    }

    send(raw: string): void {
      const message = JSON.parse(raw) as { id?: number; method?: string };
      sentMessages.push(message);
      if (!message.id) {
        throw new Error("initialized notification failed");
      }
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) });
      });
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  try {
    const client = new CodexRpcClient("ws://127.0.0.1:4500");

    await assert.rejects(
      () => client.connect(),
      /initialized notification failed/,
    );
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }

  assert.equal(sentMessages[0]?.method, "initialize");
  assert.equal(sentMessages[1]?.method, "initialized");
});
