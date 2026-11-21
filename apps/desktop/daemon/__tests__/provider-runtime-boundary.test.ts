import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertPlainWireValue, toWireJsonSchema } from "#daemon-contract/wire-boundary.js";
import type { ProviderHandle, ProviderObservedState, ProviderSpawnRequest, ProviderTerminalPayload, SupervisedProviderAdapter } from "#provider-runtime/agents/provider-adapter.js";
import {
  DATA_OPERATIONS,
  PROVIDER_BOUNDARY_SCHEMAS,
  ProviderBoundaryValueError,
  ProviderRuntimeBoundary,
  StaleProviderRuntimeRefError,
  TRANSITIONAL_OPERATIONS,
  providerRuntimeSnapshotSchema,
  providerTerminalSchema,
} from "#provider-runtime/agents/provider-runtime-boundary.js";
import { ProviderActionPortRouter } from "../provider-action-port-router.js";

class FakeHandle implements ProviderHandle {
  state: ProviderObservedState = "idle";
  providerContinuationId: string | null = "thread-1";
  providerConnection: ProviderHandle["providerConnection"] = { kind: "codex_app_server", url: "ws://127.0.0.1:1", pid: 4242, processIdentity: "birth-1" };
  /** A process-local value: it must never reach the daemon. */
  readonly client = { send: () => undefined };
  constructor(readonly workAttemptId: string, readonly pid: number | null = 4242) {}
  observedState(): ProviderObservedState { return this.state; }
}

const TERMINAL: ProviderTerminalPayload = { endedAt: "2026-11-21T00:00:00.000Z", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread-1" };

function fakeAdapter(overrides: Partial<SupervisedProviderAdapter> = {}) {
  const calls: string[] = [];
  const handles: FakeHandle[] = [];
  const adapter = {
    id: "codex",
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: true, survivesRestart: true }),
    spawn: async (request: ProviderSpawnRequest) => {
      calls.push("spawn");
      const handle = new FakeHandle(request.workAttemptId);
      handles.push(handle);
      return handle;
    },
    attach: async () => null,
    resume: async (_ref: unknown, request: ProviderSpawnRequest) => {
      calls.push("resume");
      const handle = new FakeHandle(request.workAttemptId);
      handles.push(handle);
      return handle;
    },
    poke: async () => { calls.push("poke"); },
    controlTurn: async () => ({ capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" }),
    stop: async () => { calls.push("stop"); return TERMINAL; },
    onExit: () => () => undefined,
    onStream: () => () => undefined,
    ...overrides,
  } as unknown as SupervisedProviderAdapter;
  return { adapter, calls, handles };
}

const SPAWN = { workAttemptId: "attempt-1", roomId: "room-1", cwd: "/tmp/work", launchPolicy: { mode: "ask" } };

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("each schema of the provider boundary meets the shared wire rule and has a JSON Schema", () => {
  for (const [name, schema] of Object.entries(PROVIDER_BOUNDARY_SCHEMAS)) {
    const document = toWireJsonSchema(schema);
    assert.equal(typeof document, "object", name);
    assertPlainWireValue(document, name);
  }
});

test("a started runtime is plain data that survives a JSON round trip and holds no provider object", async () => {
  const { adapter } = fakeAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  const runtime = await boundary.spawn(SPAWN);

  assertPlainWireValue(runtime);
  assert.deepEqual(jsonRoundTrip(runtime), runtime);
  providerRuntimeSnapshotSchema.parse(jsonRoundTrip(runtime));
  assert.deepEqual(runtime, {
    ref: { provider: "codex", workAttemptId: "attempt-1", runtimeId: runtime.ref.runtimeId },
    pid: 4242,
    providerContinuationId: "thread-1",
    providerConnection: { kind: "codex_app_server", url: "ws://127.0.0.1:1", pid: 4242, processIdentity: "birth-1" },
    observedState: "idle",
  });
  // A reference that went through JSON names the same runtime.
  assert.equal(boundary.inspect(jsonRoundTrip(runtime.ref)).pid, 4242);
});

test("a snapshot is a value: it does not change when the runtime changes", async () => {
  const { adapter, handles } = fakeAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  const runtime = await boundary.spawn(SPAWN);
  handles[0]!.state = "working";
  handles[0]!.providerContinuationId = "thread-2";
  assert.equal(runtime.observedState, "idle");
  assert.equal(runtime.providerContinuationId, "thread-1");
  assert.deepEqual(
    [boundary.inspect(runtime.ref).observedState, boundary.inspect(runtime.ref).providerContinuationId],
    ["working", "thread-2"],
  );
});

test("a stale reference is refused and is never resolved to the newest runtime of the work attempt", async () => {
  const { adapter, calls } = fakeAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  const first = await boundary.spawn(SPAWN);
  const second = await boundary.spawn(SPAWN);
  assert.notEqual(first.ref.runtimeId, second.ref.runtimeId);
  assert.equal(first.ref.workAttemptId, second.ref.workAttemptId);

  boundary.release(first.ref);
  calls.length = 0;
  assert.throws(() => boundary.inspect(first.ref), StaleProviderRuntimeRefError);
  assert.equal(boundary.inspectIfHeld(first.ref), null);
  await assert.rejects(boundary.stop(first.ref), StaleProviderRuntimeRefError);
  await assert.rejects(boundary.poke(first.ref, "hello"), StaleProviderRuntimeRefError);
  assert.throws(() => boundary.onExit(first.ref, () => undefined), StaleProviderRuntimeRefError);
  assert.throws(() => boundary.stopIdle(first.ref, () => undefined), StaleProviderRuntimeRefError);
  assert.deepEqual(calls, [], "no provider call for a stale reference");

  // The same work attempt with an id that was never made, another provider, and another work attempt.
  for (const ref of [
    { ...second.ref, runtimeId: "made-up" },
    { ...second.ref, provider: "cursor" },
    { ...second.ref, workAttemptId: "attempt-2" },
  ]) {
    assert.throws(() => boundary.inspect(ref), StaleProviderRuntimeRefError);
    await assert.rejects(boundary.stop(ref), StaleProviderRuntimeRefError);
  }
  assert.deepEqual(calls, []);
  assert.equal(boundary.inspect(second.ref).pid, 4242);
});

test("the same provider handle keeps its reference, and a new handle gets a new one", async () => {
  const kept = new FakeHandle("attempt-1");
  const { adapter } = fakeAdapter({ attach: async () => kept });
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  const continuation = { workAttemptId: "attempt-1", providerContinuationId: "thread-1" };
  const first = await boundary.attach(continuation);
  const again = await boundary.attach(continuation);
  assert.equal(first.state, "attached");
  assert.equal(again.state, "attached");
  if (first.state !== "attached" || again.state !== "attached") return;
  assert.equal(first.runtime.ref.runtimeId, again.runtime.ref.runtimeId);
  const other = await boundary.spawn(SPAWN);
  assert.notEqual(other.ref.runtimeId, first.runtime.ref.runtimeId);
});

test("a released reference stays stale when the adapter returns the same handle object again", async () => {
  const kept = new FakeHandle("attempt-1");
  const boundary = new ProviderRuntimeBoundary("codex", fakeAdapter({ attach: async () => kept }).adapter);
  const continuation = { workAttemptId: "attempt-1", providerContinuationId: "thread-1" };
  const first = await boundary.attach(continuation);
  assert.equal(first.state, "attached");
  if (first.state !== "attached") return;
  boundary.release(first.runtime.ref);
  const again = await boundary.attach(continuation);
  assert.equal(again.state, "attached");
  if (again.state !== "attached") return;
  assert.notEqual(again.runtime.ref.runtimeId, first.runtime.ref.runtimeId);
  assert.throws(() => boundary.inspect(first.runtime.ref), StaleProviderRuntimeRefError);
  assert.equal(boundary.inspect(again.runtime.ref).pid, 4242);
});

test("attach reports absent, attached and terminal as data", async () => {
  const absent = new ProviderRuntimeBoundary("codex", fakeAdapter().adapter);
  assert.deepEqual(await absent.attach({ workAttemptId: "attempt-1", providerContinuationId: "thread-1" }), { state: "absent" });

  const ended = new ProviderRuntimeBoundary("codex", fakeAdapter({
    attach: async () => ({ state: "terminal" as const, terminal: TERMINAL, notices: ["stopped by the adapter"] }),
  }).adapter);
  const result = await ended.attach({ workAttemptId: "attempt-1", providerContinuationId: "thread-1" });
  assert.deepEqual(result, { state: "terminal", terminal: TERMINAL, notices: ["stopped by the adapter"] });
  assert.deepEqual(jsonRoundTrip(result), result);
});

test("a value that is not plain data does not cross the boundary, in either direction", async () => {
  // Into the adapter: the request is refused before the adapter is called.
  const inward = fakeAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", inward.adapter);
  await assert.rejects(
    boundary.spawn({ ...SPAWN, launchPolicy: { changed: new Date(0) } }),
    ProviderBoundaryValueError,
  );
  await assert.rejects(
    boundary.spawn({ ...SPAWN, launchPolicy: { hook: () => "secret-value" } }),
    (error: Error) => error instanceof ProviderBoundaryValueError && !error.message.includes("secret-value"),
  );
  await assert.rejects(
    boundary.attach({ workAttemptId: "attempt-1", providerContinuationId: "thread-1", unknownField: 1 } as never),
    ProviderBoundaryValueError,
  );
  assert.deepEqual(inward.calls, []);

  // Out of the adapter: a terminal that holds a function, and one of a shape that the contract does not have.
  for (const terminal of [
    { ...TERMINAL, cleanup: () => undefined },
    { ...TERMINAL, terminalCause: "vanished" },
    { ...TERMINAL, exitCode: "0" },
  ]) {
    const outward = fakeAdapter({ stop: async () => terminal as never });
    const outwardBoundary = new ProviderRuntimeBoundary("codex", outward.adapter);
    const runtime = await outwardBoundary.spawn(SPAWN);
    await assert.rejects(outwardBoundary.stop(runtime.ref), ProviderBoundaryValueError);
  }

  // A handle whose fields are not what the contract says is refused when it is installed.
  const badHandle = fakeAdapter({ spawn: async () => Object.assign(new FakeHandle("attempt-1"), { providerContinuationId: 7 }) as never });
  await assert.rejects(new ProviderRuntimeBoundary("codex", badHandle.adapter).spawn(SPAWN), ProviderBoundaryValueError);
});

test("the start hints stay beside the request and reach the adapter", async () => {
  let seen: ProviderSpawnRequest | undefined;
  const { adapter } = fakeAdapter({ spawn: async (request) => { seen = request; return new FakeHandle(request.workAttemptId); } });
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  const onProgress = () => undefined;
  await boundary.spawn(SPAWN, { onProgress });
  assert.equal(seen?.onProgress, onProgress);
  assert.equal(seen?.launchPolicy, SPAWN.launchPolicy);
});

test("stop and the exact stop return a terminal that meets its schema", async () => {
  const death = { ...TERMINAL, nativeRuntimeDeath: { kind: "codex_app_server" as const, pid: 4242, processIdentity: "birth-1" } };
  const { adapter } = fakeAdapter({ stopRef: async () => death });
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  const runtime = await boundary.spawn(SPAWN);
  const stopped = await boundary.stop(runtime.ref, { force: true, graceMs: 10 });
  providerTerminalSchema.parse(jsonRoundTrip(stopped));
  const exact = await boundary.stopRef({ workAttemptId: "attempt-1", providerContinuationId: "thread-1", providerConnection: { kind: "codex_app_server", url: "ws://127.0.0.1:1", pid: 4242, processIdentity: "birth-1" } });
  assert.deepEqual(jsonRoundTrip(exact), death);
  await assert.rejects(boundary.stop(runtime.ref, { force: true, actionId: "a" } as never), ProviderBoundaryValueError);
});

test("the boundary reports the optional operations of its adapter as data", () => {
  const boundary = new ProviderRuntimeBoundary("codex", fakeAdapter({ stopRef: async () => TERMINAL, inspectTurn: async () => "unknown" }).adapter);
  assert.deepEqual(boundary.operations().sort(), ["inspectTurn", "stopRef"]);
  assert.equal(boundary.has("stopRef"), true);
  assert.equal(boundary.has("stopIdle"), false);
});

test("each public operation of the boundary is listed as a data operation or as a transitional operation", () => {
  const internal = new Set(["constructor", "has", "inspectIfHeld", "required", "matches", "held", "continuation", "terminal", "installed", "snapshot", "reference", "stopOptions"]);
  const listed = new Set<string>([...DATA_OPERATIONS, ...Object.keys(TRANSITIONAL_OPERATIONS)]);
  const actual = Object.getOwnPropertyNames(ProviderRuntimeBoundary.prototype).filter((name) => !internal.has(name));
  assert.deepEqual(actual.filter((name) => !listed.has(name)), [], "an operation that is in no list");
  assert.deepEqual([...listed].filter((name) => !actual.includes(name)), [], "a listed operation that the boundary does not have");
});

test("the router gives the daemon no provider object: a public handle reads plain values through the reference", async () => {
  const { adapter, handles } = fakeAdapter();
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const handle = await router.spawn({ ...SPAWN, provider: "codex" });

  for (const key of Object.keys(handle) as Array<keyof typeof handle>) assertPlainWireValue(handle[key] ?? null, String(key));
  assert.deepEqual(JSON.parse(JSON.stringify(handle)), {
    workAttemptId: "attempt-1", pid: 4242, providerContinuationId: "thread-1",
    providerConnection: { kind: "codex_app_server", url: "ws://127.0.0.1:1", pid: 4242, processIdentity: "birth-1" },
    observedState: "idle",
  }, "the JSON form of a handle has data fields only");
  assert.notEqual(handle.providerConnection, handles[0]!.providerConnection, "a copy, not the adapter's own object");
  handles[0]!.state = "working";
  assert.equal(handle.observedState, "working");

  // The router file names no provider handle type; only the boundary resolves a reference.
  const source = readFileSync(new URL("../provider-action-port-router.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bProviderHandle\b/);
  assert.doesNotMatch(source, /adapter\.(?!capabilities\b)[a-zA-Z]+\(/, "the router calls the adapter only through the boundary");
});

/** An adapter that records which handle each call was made on, and lets a test end a handle. */
function recordingAdapter(pidOf: (index: number) => number = () => 4242) {
  const handles: FakeHandle[] = [];
  const calls: Array<{ operation: string; handle: FakeHandle }> = [];
  const exitListeners = new Map<FakeHandle, Array<(terminal: ProviderTerminalPayload) => void>>();
  const record = (operation: string, handle: ProviderHandle) => { calls.push({ operation, handle: handle as FakeHandle }); };
  const adapter = {
    id: "codex",
    capabilities: () => ({ resume: true, midTurnInjection: true, transcriptAccess: true, permissionPromptBridging: true, survivesRestart: true }),
    spawn: async (request: ProviderSpawnRequest) => {
      const index = handles.length;
      const handle = new FakeHandle(request.workAttemptId, pidOf(index));
      handle.providerConnection = { kind: "codex_app_server", url: "ws://127.0.0.1:1", pid: pidOf(index), processIdentity: `birth-${index}` };
      handles.push(handle);
      return handle;
    },
    attach: async () => handles.at(-1) ?? null,
    resume: async () => { throw new Error("not used"); },
    poke: async (handle: ProviderHandle) => { record("poke", handle); },
    controlTurn: async (handle: ProviderHandle) => { record("controlTurn", handle); return { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" }; },
    inspectTurn: async (handle: ProviderHandle) => { record("inspectTurn", handle); return "unknown"; },
    runRoomTurn: async (handle: ProviderHandle) => { record("runRoomTurn", handle); return { turnId: "t", outcome: "no_reply", text: null }; },
    stopIdle: async (handle: ProviderHandle) => { record("stopIdle", handle); return TERMINAL; },
    stop: async (handle: ProviderHandle) => { record("stop", handle); return TERMINAL; },
    onExit: (handle: ProviderHandle, listener: (terminal: ProviderTerminalPayload) => void) => {
      const list = exitListeners.get(handle as FakeHandle) ?? [];
      list.push(listener);
      exitListeners.set(handle as FakeHandle, list);
      // The router's own exit watch is the first listener of each handle; later ones are calls of a test.
      if (list.length > 1) record("onExit", handle);
      return () => undefined;
    },
    onStream: (handle: ProviderHandle) => { record("onStream", handle); return () => undefined; },
  } as unknown as SupervisedProviderAdapter;
  const exit = (index: number) => { for (const listener of exitListeners.get(handles[index]!) ?? []) listener(TERMINAL); };
  return { adapter, handles, calls, exit };
}

const STALE = /not owned by the current daemon generation/;

async function assertEveryCallRefused(router: ProviderActionPortRouter, stale: Awaited<ReturnType<ProviderActionPortRouter["spawn"]>>): Promise<void> {
  await assert.rejects(router.stop(stale), STALE);
  await assert.rejects(router.stop(stale, { force: true }), STALE);
  await assert.rejects(router.poke(stale, "hello"), STALE);
  await assert.rejects(router.controlTurn(stale, null), STALE);
  await assert.rejects(router.inspectTurn(stale, "turn-1"), STALE);
  await assert.rejects(router.runRoomTurn(stale, { inboxItemId: "i", sourceMessage: {}, activation: {}, actionId: "a" }), STALE);
  await assert.rejects(router.stopIdle(stale, () => undefined), STALE);
  await assert.rejects(router.onExit(stale, () => undefined), STALE);
  await assert.rejects(router.onStream(stale, () => undefined), STALE);
  assert.equal(await router.readUsage(stale).catch(() => "refused"), "refused");
}

for (const order of ["exit before the replacement", "replacement before the exit", "replacement with no exit"] as const) {
  test(`a handle of a replaced runtime reaches no adapter call on its replacement (${order}; equal continuation and process id, another birth)`, async () => {
    const { adapter, handles, calls, exit } = recordingAdapter();
    const router = new ProviderActionPortRouter({ codex: async () => adapter });
    const first = await router.spawn({ ...SPAWN, provider: "codex" });
    if (order === "exit before the replacement") exit(0);
    const second = await router.spawn({ ...SPAWN, provider: "codex" });
    if (order === "replacement before the exit") exit(0);

    // What a handle shows cannot tell the two runtimes apart, except by the process birth.
    assert.equal(first.pid, second.pid);
    assert.equal(first.providerContinuationId, second.providerContinuationId);
    assert.notEqual(first.providerConnection?.processIdentity, second.providerConnection?.processIdentity);

    await assertEveryCallRefused(router, first);
    assert.deepEqual(calls, [], "no call on any runtime for the replaced handle");

    await router.stop(second);
    assert.deepEqual(calls.map((call) => [call.operation, handles.indexOf(call.handle)]), [["stop", 1]]);
  });
}

test("a Cursor handle of a replaced runtime is refused, also when the process id differs", async () => {
  const { adapter, calls, exit } = recordingAdapter((index) => 5000 + index);
  const router = new ProviderActionPortRouter({ cursor: async () => adapter });
  const first = await router.spawn({ ...SPAWN, provider: "cursor" });
  exit(0);
  const second = await router.spawn({ ...SPAWN, provider: "cursor" });
  assert.notEqual(first.pid, second.pid);
  await assertEveryCallRefused(router, first);
  assert.deepEqual(calls, []);
  await router.poke(second, "hello");
  assert.equal(calls.length, 1);
});

test("each handle of the installed runtime is accepted, and a handle that the router did not make is refused", async () => {
  const { adapter, handles, calls } = recordingAdapter();
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const spawned = await router.spawn({ ...SPAWN, provider: "codex" });
  const attached = await router.attach({ workAttemptId: "attempt-1", providerContinuationId: "thread-1", provider: "codex" });
  assert.ok(attached && !("state" in attached));
  assert.notEqual(attached, spawned, "a second handle object of the same runtime");

  await router.poke(spawned, "one");
  await router.poke(attached, "two");
  assert.deepEqual(calls.map((call) => handles.indexOf(call.handle)), [0, 0]);

  const copy = { workAttemptId: spawned.workAttemptId, pid: spawned.pid, providerContinuationId: spawned.providerContinuationId, providerConnection: spawned.providerConnection, observedState: spawned.observedState };
  await assert.rejects(router.poke(copy, "three"), STALE);
  await assert.rejects(router.stop(JSON.parse(JSON.stringify(spawned))), STALE);
  assert.equal(calls.length, 2, "an object with equal fields that is not a copy of a handle names no runtime");

  // A copy of a handle names the runtime of that handle, and no other.
  await router.poke({ ...spawned }, "four");
  assert.deepEqual(calls.map((call) => handles.indexOf(call.handle)), [0, 0, 0]);
  await router.spawn({ ...SPAWN, provider: "codex" });
  await assert.rejects(router.poke({ ...spawned }, "five"), STALE);
  await assert.rejects(router.poke({ ...attached }, "six"), STALE);
  assert.equal(calls.length, 3);
});

test("an input that is declared data is checked before a property is read and before the adapter is called", async () => {
  let stops = 0;
  let inspections = 0;
  const seen: unknown[] = [];
  const { adapter } = fakeAdapter({
    stop: async () => { stops += 1; return TERMINAL; },
    stopRef: async () => { stops += 1; return TERMINAL; },
    inspectPermissionProfile: async (_handle, request) => { inspections += 1; seen.push(request); return { network: true }; },
    inspectPermissionFileChanges: async () => { inspections += 1; return null; },
    inspectPermissionMcpToolCall: async () => { inspections += 1; return null; },
    replyPermission: async () => { inspections += 1; return { outcome: "sent" as const, scope: "request" as const }; },
  });
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  const runtime = await boundary.spawn(SPAWN);

  // Stop options with an accessor: the accessor is never evaluated.
  let reads = 0;
  const options = { get force() { reads += 1; return true; } };
  await assert.rejects(boundary.stop(runtime.ref, options), ProviderBoundaryValueError);
  await assert.rejects(boundary.stopRef({ workAttemptId: "attempt-1", providerContinuationId: "thread-1" }, options), ProviderBoundaryValueError);
  assert.deepEqual([reads, stops], [0, 0]);

  // A runtime reference with an accessor, with a function, and with a field that the schema does not have.
  let refReads = 0;
  const accessorRef = { provider: "codex", workAttemptId: "attempt-1", get runtimeId() { refReads += 1; return runtime.ref.runtimeId; } };
  for (const ref of [accessorRef, { ...runtime.ref, extra: () => undefined }, { ...runtime.ref, extra: 1 }]) {
    assert.throws(() => boundary.inspect(ref as never), ProviderBoundaryValueError);
    assert.throws(() => boundary.inspectIfHeld(ref as never), ProviderBoundaryValueError);
    assert.throws(() => boundary.release(ref as never), ProviderBoundaryValueError);
    await assert.rejects(boundary.stop(ref as never), ProviderBoundaryValueError);
  }
  assert.deepEqual([refReads, stops], [0, 0]);
  assert.equal(boundary.inspect(runtime.ref).pid, 4242, "the runtime is still held");

  // A permission request that holds a function reaches no adapter.
  const bad = { method: "item/permissions/requestApproval", params: { privateCallback: () => undefined } } as never;
  await assert.rejects(boundary.inspectPermissionProfile(runtime.ref, bad), ProviderBoundaryValueError);
  await assert.rejects(boundary.inspectPermissionFileChanges(runtime.ref, bad), ProviderBoundaryValueError);
  await assert.rejects(boundary.inspectPermissionMcpToolCall(runtime.ref, bad), ProviderBoundaryValueError);
  assert.throws(() => boundary.replyPermission(runtime.ref, bad, "once"), ProviderBoundaryValueError);
  assert.equal(inspections, 0);

  // A plain request passes, and the adapter gets the same object: the Codex adapter matches it by identity.
  const good = { method: "item/permissions/requestApproval", params: { threadId: "thread-1" } } as never;
  assert.deepEqual(await boundary.inspectPermissionProfile(runtime.ref, good), { network: true });
  assert.equal(seen[0], good);

  // Plain stop options pass.
  await boundary.stop(runtime.ref, { force: true });
  assert.equal(stops, 1);
});
