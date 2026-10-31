import "./isolated-home.js";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexProviderAdapter,
  codexMcpWorkplaceConfigOverrides,
  type CodexPermissionObservation,
} from "../main/agents/codex-provider-adapter.js";
import type { NativeExecutionObservation } from "../../shared/execution-protocol.js";
import {
  ProviderActionPortRouter,
  HostApprovalBroker,
  ManifestStore,
  SupervisedAgentInboxStore,
  assertProviderHandle,
  createHarness,
  spawnRequest,
  requestByMethod,
  flush,
  approvalParams,
  genericPermissionParams,
  mcpToolPermissionParams,
} from "./codex-provider-adapter.fixture.js";

test("Codex observes native MCP tool approvals without invented item coordinates and replies only once", async () => {
  for (const reply of ["once", "reject"] as const) {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(mcpToolPermissionParams(), 41, "mcpServer/elicitation/request");
    const controller = new AbortController();
    let observed = false;
    const watching = adapter.observePermissions(handle, event => {
      if (event.type === "snapshot") observed ||= event.requests.includes(request);
    }, controller.signal);
    await flush(); assert.equal(observed, true);
    assert.deepEqual(await adapter.inspectPermissionMcpToolCall(handle, request), request.params);
    assert.deepEqual(await adapter.replyPermission(handle, request, reply, {
      beforeNativeDispatch: async () => {}, assertNativeDispatch: () => {},
    }), { outcome: "sent", scope: "request" });
    assert.deepEqual(client.permissionResponses, [{ request, result: {
      action: reply === "once" ? "accept" : "decline", content: reply === "once" ? {} : null, _meta: null,
    } }]);
    assert.equal(await adapter.inspectPermissionMcpToolCall(handle, request), null);
    await assert.rejects(adapter.replyPermission(handle, request, reply), { outcome: "not_dispatched" });
    controller.abort(); await watching;
  }
});

test("Codex approvals use the latest exact turn despite an orphaned in-progress historical turn", async (t) => {
  for (const [method, params] of [
    ["mcpServer/elicitation/request", mcpToolPermissionParams()],
    ["item/commandExecution/requestApproval", approvalParams()],
    ["item/permissions/requestApproval", genericPermissionParams()],
  ] as const) await t.test(method, async () => {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const original = client.request.bind(client);
    let historyReads = 0;
    client.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method !== "thread/read") return original<T>(method, params);
      historyReads++;
      return { thread: { id: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] }, turns: [
        { id: "retired-turn", status: "inProgress" }, { id: "turn-thread-1", status: "inProgress" },
      ] } } as T;
    };
    assert.deepEqual(await adapter.inspectTurnBoundary(handle), { state: "unknown" }, "discovery remains conservative");
    const request = client.askPermission(params, 0, method);
    let admitted = 0;
    assert.deepEqual(await adapter.replyPermission(handle, request, "once", {
      beforeNativeDispatch: async () => { admitted++; },
    }), { outcome: "sent", scope: "request" });
    assert.equal(admitted, 1); assert.equal(client.permissionResponses.length, 1);
    assert.equal(historyReads, 1,
      "only explicit discovery reads history; approval dispatch uses the latest native turn");
    assert.deepEqual(requestByMethod(client, "thread/turns/list").params, {
      threadId: "thread-1", limit: 1, sortDirection: "desc", itemsView: "full",
    });
    await assert.rejects(adapter.replyPermission(handle, request, "once"), { outcome: "not_dispatched" });
    assert.equal(client.permissionResponses.length, 1);
  });
});

test("Codex approval latest-turn inspection refuses stale or ambiguous snapshots before admission", async (t) => {
  for (const data of [undefined, [], [null], [{ id: "retired-turn", status: "inProgress", itemsView: "full" }],
    [{ id: "turn-thread-1", status: "completed", itemsView: "full" }],
    [{ id: "turn-thread-1", status: "inProgress" }],
    [{ id: "turn-thread-1", status: "inProgress", itemsView: "full" }, { id: "other", status: "inProgress", itemsView: "full" }],
  ]) await t.test(JSON.stringify(data) ?? "missing data", async () => {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    const original = client.request.bind(client);
    client.request = async <T>(method: string, params?: unknown): Promise<T> => method === "thread/turns/list"
      ? { data } as T : original<T>(method, params);
    const request = client.askPermission(mcpToolPermissionParams(), 0, "mcpServer/elicitation/request");
    await assert.rejects(adapter.replyPermission(handle, request, "once", {
      beforeNativeDispatch: async () => { assert.fail("invalid snapshot cannot admit dispatch"); },
    }), { outcome: "not_dispatched" });
    assert.deepEqual(client.permissionResponses, []);
  });
});

test("Codex MCP approvals refuse uncorrelated, unsupported, cancelled, replaced, or changed requests", async (t) => {
  const cases = [
    { name: "foreign thread", params: { threadId: "foreign" } },
    { name: "foreign turn", params: { turnId: "foreign" } },
    { name: "uncorrelated elicitation", params: { turnId: null } },
    { name: "URL interaction", params: { mode: "url" } },
    { name: "generic form", params: { _meta: {} } },
    { name: "data-entry form", params: { requestedSchema: { type: "object", properties: { password: { type: "string" } } } } },
    { name: "oversized proposal", params: { message: "x".repeat(25 * 1024) } },
    ...["cancelled", "replacement", "disconnect", "turn completed", "arguments changed"].map(name => ({ name, params: {} })),
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(mcpToolPermissionParams(entry.params), 41, "mcpServer/elicitation/request");
    await assert.rejects(adapter.replyPermission(handle, request, "once", {
      beforeNativeDispatch: async () => {
        if (entry.name === "cancelled") client.emit({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 41 } });
        if (entry.name === "replacement") client.askPermission(mcpToolPermissionParams(), 41, request.method);
        if (entry.name === "disconnect") client.disconnect();
        if (entry.name === "turn completed") client.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" } } });
        if (entry.name === "arguments changed") ((request.params as ReturnType<typeof mcpToolPermissionParams>)._meta.tool_params).room_id = "other-room";
      },
      assertNativeDispatch: () => assert.fail("invalid request must not pass the dispatch fence"),
    }), { outcome: "not_dispatched" });
    assert.deepEqual(client.permissionResponses, []);
  });
});

test("Codex file approval inspection requires exact full pending native edits", async () => {
  const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const request = client.askPermission(approvalParams(), 3, "item/fileChange/requestApproval");
  const changes = [
    { path: "/repo/empty", kind: { type: "add" }, diff: "" },
    { path: "/repo/deleted", kind: { type: "delete" }, diff: "-old" },
    { path: "/repo/update", kind: { type: "update", move_path: null }, diff: "-old\n+new" },
    { path: "/repo/renamed", kind: { type: "update", move_path: "/repo/new" }, diff: "" },
  ];
  const valid = { data: [{ id: "turn-thread-1", status: "inProgress", itemsView: "full",
    items: [{ id: "item-1", type: "fileChange", status: "inProgress", changes }] }] };
  let response: unknown = valid;
  const original = client.request.bind(client);
  client.request = async (method, params) => {
    if (method !== "thread/turns/list") return original(method, params);
    assert.deepEqual(params, { threadId: "thread-1", limit: 1, sortDirection: "desc", itemsView: "full" });
    return response as never;
  };
  assert.deepEqual(await adapter.inspectPermissionFileChanges(handle, request), changes);
  for (const invalid of [null, { data: [] }, { data: [...valid.data, ...valid.data] },
    ...[{ id: "foreign" }, { status: "completed" }, { itemsView: "none" }, { items: [] },
      { items: [...valid.data[0]!.items, ...valid.data[0]!.items] },
      ...[{ status: "completed" }, { type: "commandExecution" }, { changes: [] },
        { changes: [{ ...changes[0], kind: { type: "unknown" } }] },
        { changes: [{ ...changes[0], path: "" }] },
        { changes: [{ ...changes[0], diff: "x".repeat(25 * 1024) }] }]
        .map(item => ({ items: [{ ...valid.data[0]!.items[0], ...item }] }))]
      .map(turn => ({ data: [{ ...valid.data[0], ...turn }] }))]) {
    response = invalid;
    assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null);
  }
  response = valid;
  assert.equal(await adapter.inspectPermissionFileChanges(handle, { ...request }), null);
  client.pendingPermissions.delete(request.id);
  assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null);
  assert.equal(client.permissionResponses.length, 0);
});

test("Codex file approval inspection uses the exact ephemeral proposal when the active turn omits its pending item", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  const request = client.askPermission(approvalParams(), 3, "item/fileChange/requestApproval");
  const changes = structuredClone(client.permissionChanges);
  const original = client.request.bind(client);
  client.request = async (method, params) => method === "thread/turns/list"
    ? { data: [{ id: "turn-thread-1", status: "inProgress", itemsView: "full", items: [] }] } as never
    : original(method, params);

  assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null);
  client.emit({ method: "item/started", params: {
    threadId: "thread-1",
    turnId: "turn-thread-1",
    item: { id: "item-1", type: "fileChange", status: "inProgress", changes },
  } });
  assert.deepEqual(await adapter.inspectPermissionFileChanges(handle, request), changes);
  assert.deepEqual(await adapter.replyPermission(handle, request, "once", {
    expectedFileChanges: changes,
    beforeNativeDispatch: async () => {},
  }), { outcome: "sent", scope: "request" });
  assert.deepEqual(client.permissionResponses, [{ request, result: { decision: "accept" } }]);
});

test("Codex ephemeral file approval proposals expire on item, turn, or connection terminal evidence", async (t) => {
  for (const terminal of ["item", "turn", "connection"] as const) await t.test(terminal, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams(), 3, "item/fileChange/requestApproval");
    const changes = structuredClone(client.permissionChanges);
    const original = client.request.bind(client);
    client.request = async (method, params) => method === "thread/turns/list"
      ? { data: [{ id: "turn-thread-1", status: "inProgress", itemsView: "full", items: [] }] } as never
      : original(method, params);
    client.emit({ method: "item/started", params: {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: { id: "item-1", type: "fileChange", status: "inProgress", changes },
    } });
    assert.deepEqual(await adapter.inspectPermissionFileChanges(handle, request), changes);

    if (terminal === "item") client.emit({ method: "item/completed", params: {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: { id: "item-1", type: "fileChange", status: "declined" },
    } });
    if (terminal === "turn") client.emit({ method: "turn/completed", params: {
      threadId: "thread-1",
      turn: { id: "turn-thread-1", status: "completed" },
    } });
    if (terminal === "connection") client.disconnect();

    assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null);
    assert.deepEqual(client.permissionResponses, []);
  });
});

test("Codex file approval rechecks proposed edits after the broker hook and never sends changed edits", async () => {
  for (const changed of [false, true]) {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams(), 1, "item/fileChange/requestApproval");
    const expected = structuredClone(client.permissionChanges);
    const original = client.request.bind(client);
    client.request = async (method, params) => {
      assert.notEqual(method, "thread/read", "live pending edits cannot require materialized historical items");
      return original(method, params) as never;
    };
    let fences = 0;
    const operation = adapter.replyPermission(handle, request, "once", {
      expectedFileChanges: expected,
      beforeNativeDispatch: async () => { if (changed) client.permissionChanges[0]!.diff = "+changed"; expected[0]!.diff = "+caller-mutated"; },
      assertNativeDispatch: () => { fences++; },
    });
    if (changed) await assert.rejects(operation, { outcome: "not_dispatched" });
    else assert.deepEqual(await operation, { outcome: "sent", scope: "request" });
    assert.equal(fences, changed ? 0 : 1);
    assert.equal(client.permissionResponses.length, changed ? 0 : 1);
  }
});

test("Codex file approval refuses authority loss or unsupported inspection across native reads", async () => {
  for (const race of ["birth", "connection", "resolved", "replacement", "unsupported"]) {
    const harness = createHarness(); const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams(), 1, "item/fileChange/requestApproval");
    const original = client.request.bind(client);
    client.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "thread/turns/list") {
        if (race === "birth") harness.setIdentityObservable(false);
        if (race === "connection") client.disconnect();
        if (race === "resolved") client.pendingPermissions.delete(request.id);
        if (race === "replacement") client.askPermission(approvalParams(), request.id, request.method);
        if (race === "unsupported") throw new Error("method not found");
      }
      return result as never;
    };
    assert.equal(await adapter.inspectPermissionFileChanges(handle, request), null, race);
    assert.equal(client.permissionResponses.length, 0);
  }
});

test("Codex permission dispatch rechecks native authority after the durable broker hook", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const request = client.askPermission(approvalParams());
  let syncChecks = 0;
  await assert.rejects(adapter.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => { harness.setIdentityObservable(false); },
    assertNativeDispatch: () => { syncChecks++; },
  }), { outcome: "not_dispatched" });
  assert.equal(syncChecks, 0); assert.equal(client.permissionResponses.length, 0);
  harness.setIdentityObservable(true);
  await assert.rejects(adapter.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => {}, assertNativeDispatch: () => { throw new Error("broker closed"); },
  }), /broker closed/);
  assert.equal(client.permissionResponses.length, 0);
  await adapter.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => {}, assertNativeDispatch: () => { syncChecks++; },
  });
  assert.equal(syncChecks, 1); assert.equal(client.permissionResponses.length, 1);
});

test("Codex permission replies target exact pending requests and report sent, never applied", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  const facts: NativeExecutionObservation[] = [];
  const subscription = adapter.onExecution(handle, event => facts.push(event));
  assert.equal(facts[0]?.fact.domain, "runtime");
  facts.length = 0;
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    // Same native item, distinct typed RPC IDs: neither callback can authorize the other.
    const once = client.askPermission(approvalParams({ approvalId: "callback-1", availableDecisions: ["accept", "decline"] }), 1, method);
    const reject = client.askPermission(approvalParams({ approvalId: "callback-2", grantRoot: "/host/private" }), "1", method);
    const options = method.includes("fileChange") ? { beforeNativeDispatch: async () => {}, expectedFileChanges: client.permissionChanges } : undefined;
    assert.deepEqual(await adapter.replyPermission(handle, once, "once", options), { outcome: "sent", scope: "request" });
    assert.equal(client.listPendingRequests()[0], reject);
    assert.deepEqual(await adapter.replyPermission(handle, reject, "reject", options), { outcome: "sent", scope: "request" });
    assert.deepEqual(client.permissionResponses.slice(-2), [
      { request: once, result: { decision: "accept" } }, { request: reject, result: { decision: "decline" } },
    ]);
    await assert.rejects(adapter.replyPermission(handle, once, "once"), { outcome: "not_dispatched" });
  }
  assert.equal(client.permissionResponses.length, 4);
  assert.equal(client.requests.filter(request => request.method === "thread/read").length, 0, "approval dispatch never scans historical turns");
  assert.deepEqual(facts, [], "approval payloads and decisions never enter execution evidence");
  assert.deepEqual(harness.signals, []);
  assert.equal(client.requests.some(request => request.method === "turn/start"), false);
  subscription.dispose();
});

test("Codex generic permission replies grant only the exact requested profile for the current turn", async () => {
  for (const reply of ["once", "reject"] as const) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!; client.turnStatus = "inProgress";
    const request = client.askPermission(genericPermissionParams(), 41, "item/permissions/requestApproval");
    assert.deepEqual(await adapter.replyPermission(handle, request, reply, {
      beforeNativeDispatch: async () => {}, assertNativeDispatch: () => {},
    }), { outcome: "sent", scope: "request" });
    const requested = (request.params as { permissions: Record<string, unknown> }).permissions;
    assert.deepEqual(client.permissionResponses, [{ request, result: reply === "once"
      ? { permissions: requested, scope: "turn", strictAutoReview: true }
      : { permissions: {}, scope: "turn" } }]);
    assert.equal(JSON.stringify(client.permissionResponses).includes('"session"'), false);
  }
});

test("Codex generic permission dispatch refuses a changed or malformed requested profile", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!; client.turnStatus = "inProgress";
  const request = client.askPermission(genericPermissionParams(), 41, "item/permissions/requestApproval");
  await assert.rejects(adapter.replyPermission(handle, request, "once", {
    beforeNativeDispatch: async () => {
      ((request.params as { permissions: { network: { enabled: boolean } } }).permissions.network).enabled = false;
    },
    assertNativeDispatch: () => assert.fail("a changed request cannot cross the native dispatch fence"),
  }), { outcome: "not_dispatched" });
  assert.deepEqual(client.permissionResponses, []);

  for (const params of [
    genericPermissionParams({ cwd: "relative/path" }),
    genericPermissionParams({ permissions: { network: { enabled: true, unexpected: true } } }),
    genericPermissionParams({ permissions: { fileSystem: { entries: [{ access: "execute", path: { type: "special", value: { kind: "tmpdir" } } }] } } }),
    genericPermissionParams({ permissions: { network: { enabled: true }, extra: true } }),
  ]) {
    const candidate = client.askPermission(params, 42, "item/permissions/requestApproval");
    await assert.rejects(adapter.replyPermission(handle, candidate, "once"), { outcome: "not_dispatched" });
    client.pendingPermissions.delete(candidate.id);
  }
  assert.deepEqual(client.permissionResponses, []);
});

test("Codex rejects unsupported, stale, malformed, or broader-than-once approval decisions before dispatch", async (t) => {
  const cases: Array<{ name: string; params?: Record<string, unknown>; method?: string; reply?: "once" | "reject"; clone?: boolean }> = [
    { name: "foreign thread", params: { threadId: "foreign" } },
    { name: "foreign turn", params: { turnId: "foreign" } },
    { name: "missing item", params: { itemId: undefined } },
    { name: "invalid start time", params: { startedAtMs: "1" } },
    { name: "generic permission missing profile", method: "item/permissions/requestApproval" },
    { name: "file grantRoot cannot mean once", method: "item/fileChange/requestApproval", params: { grantRoot: "/repo" } },
    { name: "session-only choices", params: { availableDecisions: ["acceptForSession", "cancel"] } },
    { name: "amendment-only choices", params: { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm"] } }] } },
    { name: "decline unavailable", params: { availableDecisions: ["accept"] }, reply: "reject" },
    { name: "malformed choices", params: { availableDecisions: "accept" } },
    { name: "empty choices", params: { availableDecisions: [] } },
    { name: "copied request", clone: true },
    { name: "unknown reply", reply: "acceptForSession" as "once" },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams(entry.params), 1, entry.method);
    await assert.rejects(adapter.replyPermission(handle, entry.clone ? { ...request } : request, entry.reply ?? "once"), {
      name: "CodexPermissionReplyError", outcome: "not_dispatched",
    });
    assert.deepEqual(client.permissionResponses, []);
    assert.equal(client.listPendingRequests()[0], request, "refusal does not consume native pending authority");
    assert.deepEqual(harness.signals, []);
  });
});

test("Codex permission dispatch refuses non-active or inconclusive native turn snapshots", async (t) => {
  for (const status of ["completed", "failed", "interrupted", "unknown", "read-error"]) await t.test(status, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.turnStatus = status;
    if (status === "read-error") client.request = async () => { throw new Error("timed out"); };
    const request = client.askPermission(approvalParams());
    await assert.rejects(adapter.replyPermission(handle, request, "once"), { outcome: "not_dispatched" });
    assert.deepEqual(client.permissionResponses, []);
    assert.equal(handle.observedState(), "idle", "read uncertainty is not runtime failure");
  });
});

test("Codex permission responses do not replay after an uncertain send or changed post-send identity", async (t) => {
  for (const failure of ["send_throw", "process_birth", "unverifiable", "disconnect"]) await t.test(failure, async () => {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
    const client = harness.clients[0]!;
    client.turnStatus = "inProgress";
    const request = client.askPermission(approvalParams());
    const respond = client.respond.bind(client);
    client.respond = (expected, result) => {
      if (failure === "send_throw") client.responseError = true;
      respond(expected, result);
      if (failure === "process_birth") harness.launches[0]!.processIdentity += "-replaced";
      if (failure === "unverifiable") harness.setIdentityObservable(false);
      if (failure === "disconnect") client.disconnect();
    };
    await assert.rejects(adapter.replyPermission(handle, request, "once"), { outcome: "uncertain" });
    assert.equal(client.permissionResponses.length, 1);
    await assert.rejects(adapter.replyPermission(handle, request, "once"), { outcome: "not_dispatched" });
    assert.equal(client.permissionResponses.length, 1);
    assert.deepEqual(harness.signals, failure === "disconnect" ? [{ pid: handle.pid, signal: "SIGTERM" }] : [],
      "only the existing observeFencedExit disconnect policy may signal the process");
  });
});

test("Codex empty permission observations permit exact idle reservation through the router and broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-idle-permissions-"));
  const store = new ManifestStore(join(root, "state.sqlite"));
  const inbox = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const handle = await router.spawn({ provider: "codex", ...spawnRequest({ deliveryMode: "daemon_inbox" }) });
  const broker = new HostApprovalBroker({ store, inbox, provider: router,
    currentHandle: () => handle, isCurrent: () => true, exactAuthority: async () => true,
    fenceCommit: async (commit: () => Promise<void>) => commit() });
  const exact = { entryId: "agent", handle, executionGenerationId: "generation", providerConnection: handle.providerConnection };
  const client = harness.clients[0]!;
  try {
    broker.install("agent", handle, "generation");
    await flush();
    const empty = broker.reserveIdle(exact);
    assert.ok(empty, "an observed empty native approval lane retains its verified RPC identity");
    empty.assertCurrent();
    const pending = client.askPermission(approvalParams());
    await flush();
    assert.throws(empty.assertCurrent, /permissions changed/);
    empty.release();
    assert.equal(broker.reserveIdle(exact), null, "a pending native request blocks refresh");
    client.emit({ method: "serverRequest/resolved", params: { requestId: pending.id, threadId: "thread-1" } });
    await flush();
    const resolved = broker.reserveIdle(exact);
    assert.ok(resolved, "the same connection remains identifiable after its last request closes");
    resolved.assertCurrent();
    harness.setIdentityObservable(false);
    client.askPermission(approvalParams(), "unverifiable-birth");
    await flush();
    assert.throws(resolved.assertCurrent, /permissions changed/);
    resolved.release();
    assert.equal(broker.reserveIdle(exact), null, "unverifiable process identity never establishes idle authority");
    harness.setIdentityObservable(true);
    client.emit({ method: "serverRequest/resolved", params: { requestId: "unverifiable-birth", threadId: "thread-1" } });
    await flush();
    const beforeDisconnect = broker.reserveIdle(exact);
    assert.ok(beforeDisconnect);
    client.disconnect();
    await flush();
    assert.throws(beforeDisconnect.assertCurrent, /permissions changed/);
    beforeDisconnect.release();
    assert.equal(broker.reserveIdle(exact), null, "disconnect cannot retain healthy empty authority");
  } finally {
    broker.close();
    await inbox.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex permission observation tracks pending requests without projecting resolution as an applied decision", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  const initial = client.askPermission(approvalParams());
  client.askPermission(approvalParams({ threadId: "foreign" }), "foreign");
  const controller = new AbortController();
  const events: CodexPermissionObservation[] = [];
  const observation = adapter.observePermissions(handle, event => { events.push(event); }, controller.signal);
  const throwing = adapter.observePermissions(handle, () => { throw new Error("consumer failed"); }, controller.signal);
  assert.deepEqual(events[0], { type: "snapshot", connectionId: client.currentConnectionId(), requests: [initial] });
  const second = client.askPermission(approvalParams({ itemId: "item-2" }), "second");
  await flush();
  assert.deepEqual(events.at(-1), { type: "snapshot", connectionId: client.currentConnectionId(), requests: [initial, second] });
  client.emit({ method: "serverRequest/resolved", params: { requestId: initial.id, threadId: "thread-1" } });
  await flush();
  assert.deepEqual(events.at(-1), { type: "snapshot", connectionId: client.currentConnectionId(), requests: [second] });
  assert.deepEqual(client.permissionResponses, [], "remote resolution is not evidence of our decision or dispatch");
  await adapter.replyPermission(handle, second, "reject");
  await flush();
  assert.deepEqual(events.at(-1), { type: "snapshot", connectionId: client.currentConnectionId(), requests: [] });
  harness.setIdentityObservable(false);
  client.askPermission(approvalParams(), "degraded");
  await flush();
  assert.deepEqual(events.at(-1), { type: "degraded" });
  harness.setIdentityObservable(true);
  client.disconnect();
  await Promise.all([observation, throwing]);
  assert.deepEqual(events.at(-1), { type: "unavailable" });
  assert.equal(client.permissionListeners.size, 0);
  const count = events.length;
  controller.abort();
  client.askPermission(approvalParams(), "after-close");
  await flush();
  assert.equal(events.length, count);
});

test("Codex permission dispatch revalidates exact authority after an awaited native read", async (t) => {
  for (const race of ["resolved", "request_replaced", "process_birth", "unverifiable", "connection", "continuation", "handle", "stopping", "turn_terminal"]) {
    await t.test(race, async () => {
      const harness = createHarness({ exitOnSignal: true });
      const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
      const spawn = spawnRequest({ deliveryMode: "daemon_inbox" });
      const handle = await adapter.spawn(spawn);
      const client = harness.clients[0]!;
      const permission = client.askPermission(approvalParams());
      let release!: () => void;
      let reading!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { reading = resolve; });
      const originalRequest = client.request.bind(client);
      client.request = async <T>(method: string, params?: unknown): Promise<T> => {
        if (method !== "thread/turns/list") return originalRequest<T>(method, params);
        reading();
        await barrier;
        return { data: [{ id: "turn-thread-1", status: "inProgress", itemsView: "full" }] } as T;
      };
      const response = adapter.replyPermission(handle, permission, "once", {
        beforeNativeDispatch: async () => { assert.fail("lost authority cannot admit dispatch"); },
      });
      const rejected = assert.rejects(response, { outcome: "not_dispatched" });
      await started;
      if (race === "resolved") client.emit({ method: "serverRequest/resolved", params: { requestId: permission.id, threadId: "thread-1" } });
      if (race === "request_replaced") client.askPermission(approvalParams({ command: "different command" }));
      if (race === "process_birth") harness.launches[0]!.processIdentity += "-replaced";
      if (race === "unverifiable") harness.setIdentityObservable(false);
      if (race === "connection") client.connectionEpoch = "replacement";
      if (race === "continuation") await adapter.repairContinuation(handle, {
        workAttemptId: handle.workAttemptId, expectedProviderContinuationId: "thread-1",
        checkpointedReplacementProviderContinuationId: "thread-repaired", cwd: spawn.cwd, launchPolicy: spawn.launchPolicy,
      }, { checkpointReplacement: async () => {} });
      if (race === "handle") {
        harness.launches[0]!.resolveExit({ type: "exit", code: 0, signal: null });
        await flush();
        await adapter.spawn(spawn);
      }
      if (race === "stopping") await adapter.stop(handle, { force: true });
      if (race === "turn_terminal") client.emit({ method: "turn/completed", params: {
        threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" },
      } });
      release();
      await rejected;
      assert.deepEqual(client.permissionResponses, []);
    });
  }
});

test("Codex concurrent permission replies send only once for one frozen pending request", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  client.turnStatus = "inProgress";
  const request = client.askPermission(approvalParams());
  const outcomes = await Promise.allSettled([
    adapter.replyPermission(handle, request, "once"), adapter.replyPermission(handle, request, "reject"),
  ]);
  assert.equal(outcomes[0]!.status, "fulfilled");
  assert.equal(outcomes[1]!.status, "rejected");
  assert.equal((outcomes[1] as PromiseRejectedResult).reason.outcome, "not_dispatched");
  assert.equal(client.permissionResponses.length, 1);
});

test("Codex permission observation withdraws replaced/stopped bindings and disposes on abort", async (t) => {
  for (const end of ["abort", "continuation", "connection", "stop", "already_aborted"]) await t.test(end, async () => {
    const harness = createHarness({ exitOnSignal: true });
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const spawn = spawnRequest({ deliveryMode: "daemon_inbox" });
    const handle = await adapter.spawn(spawn);
    const client = harness.clients[0]!;
    client.askPermission(approvalParams());
    const controller = new AbortController();
    if (end === "already_aborted") controller.abort();
    const events: CodexPermissionObservation[] = [];
    const observation = adapter.observePermissions(handle, event => events.push(event), controller.signal);
    if (end === "abort") controller.abort();
    if (end === "continuation") await adapter.repairContinuation(handle, {
      workAttemptId: handle.workAttemptId, expectedProviderContinuationId: "thread-1",
      checkpointedReplacementProviderContinuationId: "thread-repaired", cwd: spawn.cwd, launchPolicy: spawn.launchPolicy,
    }, { checkpointReplacement: async () => {} });
    if (end === "connection") {
      client.connectionEpoch = "replacement";
      client.askPermission(approvalParams(), "replacement-connection");
    }
    if (end === "stop") await adapter.stop(handle, { force: true });
    await observation;
    assert.equal(events.at(-1)?.type, end === "already_aborted" ? undefined : end === "abort" ? "snapshot" : "unavailable");
    assert.equal(client.permissionListeners.size, 0);
    const count = events.length;
    client.askPermission(approvalParams(), "later");
    await flush();
    assert.equal(events.length, count);
  });
});

test("Codex adapter launches app-server, maps attested thread policy, and boots the MCP workplace", async () => {
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
  assert.equal(threadParams.sandbox, "danger-full-access");
  assert.equal(Object.hasOwn(threadParams, "sandboxPolicy"), false);
  assert.equal(Object.hasOwn(threadParams, "cwd"), false, "a thread started in a named folder makes Codex trust the project");
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
    execution: { controlProbe: "rpc", approvals: { kinds: ["command", "file_change", "network"], recovery: "connection_only", denyScope: "request" } },
    deliveryModes: ["mcp_polling", "daemon_inbox"],
    resume: true,
    midTurnInjection: false,
    midTurnCorrection: true,
    transcriptAccess: true,
    permissionPromptBridging: false,
    survivesRestart: true,
    turnControl: "native_interrupt",
    continuationRepair: "same_process",
  });
  await assert.rejects(adapter.poke(handle, "wake up"), /not enabled/);
});

test("Codex Auto keeps project-only writes and its own reviewer on every thread and turn", async () => {
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const launchPolicy = {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    approvalsReviewer: "auto_review",
  };
  const first = await adapter.spawn(spawnRequest({
    deliveryMode: "daemon_inbox", permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy,
  }));
  const thread = requestByMethod(harness.clients[0]!, "thread/start").params as Record<string, unknown>;
  assert.equal(thread.approvalPolicy, "on-request");
  assert.equal(thread.sandbox, "workspace-write");
  assert.equal(thread.approvalsReviewer, "auto_review");
  assert.equal(Object.hasOwn(thread, "sandboxPolicy"), false);

  const attachedAdapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const attached = await attachedAdapter.attach({ workAttemptId: first.workAttemptId,
    providerContinuationId: first.providerContinuationId!, providerConnection: first.providerConnection, launchPolicy });
  assertProviderHandle(attached);
  // A later caller mutation cannot return approvals to nobody or widen the sandbox.
  launchPolicy.sandboxPolicy.type = "dangerFullAccess";
  launchPolicy.approvalsReviewer = "user";
  for (const [runtime, handle, client] of [[adapter, first, harness.clients[0]!], [attachedAdapter, attached, harness.clients[1]!]] as const) {
    await runtime.runRoomTurn(handle, { inboxItemId: "auto-turn", actionId: "auto-turn", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async (turnId) => {
        client.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } });
      },
    });
    const turn = requestByMethod(client, "turn/start").params as Record<string, unknown>;
    assert.equal(turn.approvalPolicy, "on-request");
    assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", networkAccess: false });
    assert.equal(turn.approvalsReviewer, "auto_review");
  }
});

test("Codex Auto refuses a runtime or policy that would not review automatically", async () => {
  const autoPolicy = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" };
  const ignoring = createHarness({ reviewerFromOwnSettings: "user" });
  await assert.rejects(new CodexProviderAdapter({ dependencies: ignoring.dependencies }).spawn(spawnRequest({
    deliveryMode: "daemon_inbox", permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: autoPolicy,
  })), /did not turn on automatic review/);
  assert.equal(ignoring.clients[0]!.requests.some(request => request.method === "turn/start"), false);

  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  for (const [permissionProfileId, launchPolicy, reason] of [
    // Project-only writes never run with the host as the reviewer of record.
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } }, /approvalsReviewer/],
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: true }, approvalsReviewer: "auto_review" }, /sandboxPolicy/],
    ["auto_review", { approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" }, /approvalPolicy/],
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "auto_review" }, /approvalsReviewer/],
    ["full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "guardian_subagent" }, /approvalsReviewer/],
    // A launch that names no access level is still held to the same pairing.
    [null, { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "auto_review" }, /automatic review outside the Auto access level/],
    [null, { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "auto_review" }, /automatic review outside the Auto access level/],
    [null, { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "guardian_subagent" }, /unsupported approval reviewer/],
  ] as const) {
    await assert.rejects(adapter.spawn(spawnRequest({
      deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy,
    })), reason);
  }
  assert.equal(harness.clients.some(client => client.requests.some(request => request.method === "thread/start")), false);
});

test("Codex asks the host, not its own reviewer, on every access level except Auto", async () => {
  for (const [permissionProfileId, launchPolicy] of [
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }],
    ["full_access", { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }],
  ] as const) {
    const harness = createHarness();
    const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
    const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy }));
    // The launch names the host even though the stored policy names nobody.
    assert.equal((requestByMethod(harness.clients[0]!, "thread/start").params as Record<string, unknown>).approvalsReviewer, "user");
    await adapter.runRoomTurn(handle, { inboxItemId: "pinned", actionId: "pinned", sourceMessage: {}, activation: {} }, {
      checkpointTurnStarted: async (turnId) => {
        harness.clients[0]!.emit({ method: "turn/completed", params: { threadId: handle.providerContinuationId, turnId } });
      },
    });
    assert.equal((requestByMethod(harness.clients[0]!, "turn/start").params as Record<string, unknown>).approvalsReviewer, "user");

    // The owner's own Codex settings name a reviewer and the app-server keeps it.
    const owned = createHarness({ reviewerFromOwnSettings: "auto_review" });
    await assert.rejects(new CodexProviderAdapter({ dependencies: owned.dependencies }).spawn(spawnRequest({
      deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy,
    })), /would review approvals itself instead of asking you/);
    assert.equal(owned.clients[0]!.requests.some(request => request.method === "turn/start"), false);
  }
});

test("Codex continuation repair keeps the access level the runtime was launched under", async () => {
  const autoPolicy = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" };
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId: "auto_review", configurationRevision: 1, launchPolicy: autoPolicy }));
  const client = harness.clients[0]!;
  const before = client.requests.length;
  // An agent created in Add Agent stores an empty policy until its settings are edited.
  const result = await adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    forceReplacement: true, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
  }, { checkpointReplacement: async () => {} });
  assert.equal(result.outcome, "replaced");
  const replacement = client.requests.slice(before).find(request => request.method === "thread/start")!.params as Record<string, unknown>;
  assert.equal(replacement.approvalPolicy, "on-request");
  assert.equal(replacement.sandbox, "workspace-write");
  assert.equal(replacement.approvalsReviewer, "auto_review");
});

test("Codex continuation repair refuses a thread that would not review the way the runtime was launched", async () => {
  for (const [permissionProfileId, launchPolicy, reported, reason] of [
    ["auto_review", { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false }, approvalsReviewer: "auto_review" },
      "user", /did not turn on automatic review/],
    ["ask_before_write", { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } },
      "auto_review", /would review approvals itself instead of asking you/],
  ] as const) {
    for (const forceReplacement of [true, false]) {
      const harness = createHarness();
      const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
      const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", permissionProfileId, configurationRevision: 1, launchPolicy }));
      // The app-server honoured the launch, then stops honouring the reviewer.
      harness.clients[0]!.reviewerFromOwnSettings = reported;
      let checkpointed = false;
      await assert.rejects(adapter.repairContinuation!(handle, {
        workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
        forceReplacement, cwd: spawnRequest().cwd, launchPolicy: {}, model: null, reasoningEffort: null,
      }, { checkpointReplacement: async () => { checkpointed = true; } }), reason);
      assert.equal(checkpointed, false, "a refused thread never becomes the agent's conversation");
    }
  }
});

test("a new Codex thread names no folder, and one that starts outside the work attempt's folder is refused", async () => {
  // Codex records a project as trusted, and loads its .codex config, when a
  // thread starts in a named folder with a writable sandbox.
  const harness = createHarness();
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox" }));
  const client = harness.clients[0]!;
  assert.equal(harness.launchOptions[0]?.options.trustedProjectPath, spawnRequest().cwd, "the app-server starts in the folder");
  assert.equal(Object.hasOwn(requestByMethod(client, "thread/start").params as object, "cwd"), false);

  const repair = (cwd: string, checkpointReplacement: () => Promise<void> = async () => {}) => adapter.repairContinuation!(handle, {
    workAttemptId: handle.workAttemptId, expectedProviderContinuationId: handle.providerContinuationId!,
    forceReplacement: true, cwd, launchPolicy: spawnRequest().launchPolicy, model: null, reasoningEffort: null,
  }, { checkpointReplacement });
  let checkpointed = false;
  const conversation = handle.providerContinuationId;
  // The live app-server runs in the folder it was launched in, not this one.
  await assert.rejects(repair("/tmp/letagents-another-attempt", async () => { checkpointed = true; }),
    /^Error: Codex opened this conversation in \/tmp\/letagents-work-attempt, not in the agent's folder \/tmp\/letagents-another-attempt, so LetAgents will not use it\. Restart the agent\.$/);
  assert.equal(checkpointed, false, "a thread in the wrong folder never becomes the agent's conversation");
  // A refused repair uses nothing and stops nothing: the running app-server keeps its conversation.
  assert.equal(handle.providerContinuationId, conversation);
  assert.equal(handle.observedState(), "idle");
  assert.deepEqual(harness.signals, []);
  assert.equal((await repair(`${spawnRequest().cwd}/`)).outcome, "replaced");
  // A request that names no folder has none to compare.
  assert.equal((await repair("")).outcome, "replaced");
  const starts = client.requests.filter((request) => request.method === "thread/start");
  assert.equal(starts.length, 4);
  for (const start of starts) assert.equal(Object.hasOwn(start.params as object, "cwd"), false);

  for (const [threadDirectory, reason] of [
    ["/tmp/letagents-elsewhere", /Codex opened this conversation in \/tmp\/letagents-elsewhere, not in the agent's folder \/tmp\/letagents-work-attempt, so LetAgents will not use it/],
    [null, /Codex did not report the folder this conversation opened in, so LetAgents will not use it/],
  ] as const) {
    const elsewhere = createHarness({ threadDirectory });
    const refused = new CodexProviderAdapter({ dependencies: elsewhere.dependencies });
    await assert.rejects(refused.spawn(spawnRequest({ deliveryMode: "daemon_inbox" })), reason);
    assert.deepEqual(elsewhere.signals, [{ pid: 4100, signal: "SIGTERM" }], "a refused launch stops its app-server");
    assert.equal(elsewhere.clients[0]!.requests.some((request) => request.method === "turn/start"), false);
  }
});

test("a Codex thread's folder is compared by where it really is", async (t) => {
  const real = await realpath(await mkdtemp(join(tmpdir(), "letagents-codex-thread-folder-")));
  const link = `${real}-link`;
  await symlink(real, link);
  t.after(async () => {
    await rm(link, { force: true });
    await rm(real, { recursive: true, force: true });
  });
  // The work attempt names the link; Codex reports the folder it resolves to.
  const harness = createHarness({ threadDirectory: real });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", cwd: link }));
  assert.equal(handle.observedState(), "idle");
});

test("a Codex thread's folder matches under its macOS data-volume path", {
  skip: process.platform === "darwin" ? false : "macOS firmlinks only",
}, async (t) => {
  const real = await realpath(await mkdtemp(join(tmpdir(), "letagents-codex-thread-folder-")));
  t.after(() => rm(real, { recursive: true, force: true }));
  // The same folder, by a path that does not resolve to the one Codex reports.
  const dataVolumePath = join("/System/Volumes/Data", real);
  assert.equal(await realpath(dataVolumePath), dataVolumePath);
  const harness = createHarness({ threadDirectory: real });
  const adapter = new CodexProviderAdapter({ dependencies: harness.dependencies });
  const handle = await adapter.spawn(spawnRequest({ deliveryMode: "daemon_inbox", cwd: dataVolumePath }));
  assert.equal(handle.observedState(), "idle");

  // Another folder is still refused, as is one that cannot be read.
  const other = await realpath(await mkdtemp(join(tmpdir(), "letagents-codex-thread-folder-")));
  t.after(() => rm(other, { recursive: true, force: true }));
  for (const cwd of [join("/System/Volumes/Data", other), join(real, "missing")]) {
    const refused = createHarness({ threadDirectory: real });
    await assert.rejects(new CodexProviderAdapter({ dependencies: refused.dependencies })
      .spawn(spawnRequest({ deliveryMode: "daemon_inbox", cwd })), /not in the agent's folder/);
  }
});
