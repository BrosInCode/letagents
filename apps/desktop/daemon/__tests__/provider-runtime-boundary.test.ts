import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { assertPlainWireValue, toWireJsonSchema } from "#daemon-contract/wire-boundary.js";
import type { ProviderHandle, ProviderObservedState, ProviderSpawnRequest, ProviderTerminalPayload, SupervisedProviderAdapter } from "#provider-runtime/agents/provider-adapter.js";
import {
  DATA_OPERATIONS,
  PROVIDER_BOUNDARY_SCHEMAS,
  ProviderBoundaryValueError,
  type ProviderEventEnvelope,
  ProviderRuntimeBoundary,
  ProviderStepRefusedError,
  PROVIDER_ERROR_FIELDS,
  PROVIDER_STEP_BODY_SCHEMAS,
  PROVIDER_STEP_NAMES,
  StaleProviderRuntimeRefError,
  TRANSITIONAL_OPERATIONS,
  TRANSPORT_OPERATIONS,
  providerEventEnvelopeSchema,
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
  assert.throws(() => boundary.subscribe(first.ref, "exit", "s-stale"), StaleProviderRuntimeRefError);
  await assert.rejects(boundary.stopIdle(first.ref, { operationId: "op-stale" }), StaleProviderRuntimeRefError);
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

test("the start hints of the adapter arrive as start events with the operation id of the start", async () => {
  let seen: ProviderSpawnRequest | undefined;
  const { adapter } = fakeAdapter({ spawn: async (request) => {
    seen = request;
    request.onNativeStarted?.();
    request.onProgress?.();
    return new FakeHandle(request.workAttemptId);
  } });
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => events.push(event));
  await boundary.spawn(SPAWN, { startOperationId: "start-1" });
  assert.equal(seen?.launchPolicy, SPAWN.launchPolicy);
  assert.deepEqual(events, [
    { kind: "start", operationId: "start-1", order: 1, body: { hint: "native_started" } },
    { kind: "start", operationId: "start-1", order: 2, body: { hint: "progress" } },
  ]);
  for (const event of events) providerEventEnvelopeSchema.parse(jsonRoundTrip(event));

  // With no operation id the adapter gets no hint function.
  await boundary.spawn(SPAWN);
  assert.equal(seen?.onProgress, undefined);
  assert.equal(seen?.onNativeStarted, undefined);
  await assert.rejects(boundary.spawn(SPAWN, { startOperationId: "x", extra: 1 } as never), ProviderBoundaryValueError);
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
  const internal = new Set(["constructor", "has", "inspectIfHeld", "required", "matches", "held", "continuation", "terminal", "installed", "snapshot", "reference", "stopOptions", "deliver", "startHints", "send",
    "operation", "step", "check", "openStep", "sendStep", "answered", "refusal", "permissionRequest", "connectionKey", "tokensOf"]);
  const listed = new Set<string>([...DATA_OPERATIONS, ...TRANSPORT_OPERATIONS, ...Object.keys(TRANSITIONAL_OPERATIONS)]);
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
  await assert.rejects(boundary.replyPermission(runtime.ref, bad, "once", { operationId: "op-bad" }), ProviderBoundaryValueError);
  assert.equal(inspections, 0);

  // A plain request passes, and the adapter gets the same object: the Codex adapter matches it by identity.
  const good = { method: "item/permissions/requestApproval", params: { threadId: "thread-1" } } as never;
  assert.deepEqual(await boundary.inspectPermissionProfile(runtime.ref, good), { network: true });
  assert.equal(seen[0], good);

  // Plain stop options pass.
  await boundary.stop(runtime.ref, { force: true });
  assert.equal(stops, 1);
});

/** An adapter whose listeners a test can call, as a provider would. */
function eventAdapter() {
  const exit: Array<(terminal: ProviderTerminalPayload) => void> = [];
  const stream: Array<(event: never) => void> = [];
  const execution: Array<(event: never) => void> = [];
  const permissions: Array<{ listener: (event: never) => void; signal: AbortSignal }> = [];
  const retained: unknown[] = [];
  let disposed = 0;
  const adapter = fakeAdapter({
    onExit: (_handle, listener) => { exit.push(listener); return () => { exit.splice(exit.indexOf(listener), 1); }; },
    onStream: (_handle, listener) => { stream.push(listener as never); return () => { stream.splice(stream.indexOf(listener as never), 1); }; },
    onExecution: (_handle, listener) => {
      // As the real observer: the retained history is delivered before the call returns.
      for (const event of retained) listener(event as never);
      execution.push(listener as never);
      return { sourceId: "observer-1", position: () => ({ firstRetainedSequence: 1, latestSequence: retained.length }), dispose: () => { disposed += 1; } };
    },
    observePermissions: async (_handle, listener, signal) => { permissions.push({ listener: listener as never, signal }); },
  }).adapter;
  return { adapter, exit, stream, execution, permissions, retained, disposedCount: () => disposed };
}

const STREAM_EVENT = { workAttemptId: "attempt-1", providerContinuationId: "thread-1", observedAt: "2026-11-21T00:00:00.000Z", sequence: 7, provider: "codex", kind: "text_delta", method: "item/agentMessage/delta", payload: { delta: "hi" }, payloadTruncated: false, payloadRedacted: false, durablePayloadRef: null };

test("events reach one sink as envelopes: a count for each subscription, one order for the boundary, and the body unchanged", async () => {
  const fake = eventAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => events.push(event));
  assert.throws(() => boundary.connectEventSink(() => undefined), /already has an event sink/);
  const runtime = await boundary.spawn(SPAWN);

  assert.deepEqual(boundary.subscribe(runtime.ref, "stream", "s-stream"), { subscriptionId: "s-stream" });
  assert.deepEqual(boundary.subscribe(runtime.ref, "exit", "s-exit"), { subscriptionId: "s-exit" });
  fake.stream[0]!(STREAM_EVENT as never);
  fake.stream[0]!({ ...STREAM_EVENT, sequence: 8 } as never);
  fake.exit[0]!(TERMINAL);
  fake.stream[0]!({ ...STREAM_EVENT, sequence: 9 } as never); // An adapter can still send a stream event after the exit.

  assert.deepEqual(events.map((event) => [event.kind, "subscriptionId" in event ? event.subscriptionId : null, "seq" in event ? event.seq : null, event.order]), [
    ["stream", "s-stream", 1, 1], ["stream", "s-stream", 2, 2], ["exit", "s-exit", 1, 3], ["stream", "s-stream", 3, 4],
  ]);
  assert.equal(events[0]!.body, STREAM_EVENT, "the body is the adapter's own event");
  assert.equal((events[1]!.body as { sequence: number }).sequence, 8, "the adapter's own sequence number is kept");
  assert.equal((events[2] as { final?: true }).final, true);
  assert.equal((events[3] as { final?: true }).final, undefined);
  assert.deepEqual((events[0] as { ref: unknown }).ref, runtime.ref);
  for (const event of events) providerEventEnvelopeSchema.parse(jsonRoundTrip(event));

  // The exit subscription ended with its last event. The stream subscription ends when the daemon ends it.
  fake.exit[0]?.(TERMINAL);
  assert.equal(events.length, 4);
  boundary.unsubscribe("s-stream");
  boundary.unsubscribe("s-stream");
  boundary.unsubscribe("never-made");
  assert.equal(fake.stream.length, 0, "the adapter's listener is removed");
});

test("a subscription is refused for a stale reference, an id in use, a kind that is not known, and a boundary with no sink", async () => {
  const fake = eventAdapter();
  const noSink = new ProviderRuntimeBoundary("codex", fake.adapter);
  const orphan = await noSink.spawn(SPAWN);
  assert.throws(() => noSink.subscribe(orphan.ref, "stream", "s-1"), /no event sink/);

  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  boundary.connectEventSink(() => undefined);
  const runtime = await boundary.spawn(SPAWN);
  boundary.subscribe(runtime.ref, "stream", "s-1");
  assert.throws(() => boundary.subscribe(runtime.ref, "exit", "s-1"), ProviderBoundaryValueError);
  assert.throws(() => boundary.subscribe(runtime.ref, "activity" as never, "s-2"), ProviderBoundaryValueError);
  assert.throws(() => boundary.subscribe(runtime.ref, "stream", "" as never), ProviderBoundaryValueError);
  assert.throws(() => boundary.subscribe({ ...runtime.ref, runtimeId: "made-up" }, "stream", "s-3"), StaleProviderRuntimeRefError);
  assert.equal(fake.stream.length, 1, "no adapter listener for a refused subscription");
});

test("an execution subscription gets the retained history under its own id, and its identity and position are data", async () => {
  const fake = eventAdapter();
  fake.retained.push({ sourceId: "observer-1", sequence: 1, observedAtMs: 1, fact: { domain: "control", kind: "state_changed", state: "responsive" } });
  fake.retained.push({ sourceId: "observer-1", sequence: 2, observedAtMs: 2, fact: { domain: "control", kind: "state_changed", state: "degraded" } });
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => events.push(event));
  const runtime = await boundary.spawn(SPAWN);

  const subscription = boundary.subscribe(runtime.ref, "execution", "s-exec");
  assert.deepEqual(subscription, { subscriptionId: "s-exec", sourceId: "observer-1" });
  assert.deepEqual(jsonRoundTrip(subscription), subscription);
  // The two retained events arrived before `subscribe` returned, with the id that the caller chose.
  assert.deepEqual(events.map((event) => ["subscriptionId" in event ? event.subscriptionId : null, (event.body as { sequence: number }).sequence]), [["s-exec", 1], ["s-exec", 2]]);
  assert.deepEqual(boundary.subscriptionPosition("s-exec"), { firstRetainedSequence: 1, latestSequence: 2 });

  boundary.unsubscribe("s-exec");
  assert.equal(fake.disposedCount(), 1);
  assert.equal(boundary.subscriptionPosition("s-exec"), null);
  fake.execution[0]!({ sourceId: "observer-1", sequence: 3 } as never);
  assert.equal(events.length, 2, "no event after the subscription ended");
});

test("an event that is not plain data never reaches the daemon as it is: a gap, a protocol-error exit, or an unavailable permission lane", async () => {
  const fake = eventAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => events.push(event));
  const runtime = await boundary.spawn(SPAWN);
  boundary.subscribe(runtime.ref, "stream", "s-stream");
  boundary.subscribe(runtime.ref, "exit", "s-exit");
  boundary.subscribe(runtime.ref, "permissions", "s-perm");
  await Promise.resolve();
  events.length = 0;

  // The adapter's call does not throw for any of them.
  fake.stream[0]!({ ...STREAM_EVENT, payload: { secret: () => "do-not-leak" } } as never);
  fake.stream[0]!(STREAM_EVENT as never);
  fake.permissions[0]!.listener({ type: "snapshot", requests: [{ native: new Date(0) }] } as never);
  fake.exit[0]!({ ...TERMINAL, terminalCause: "vanished", cleanup: () => undefined } as never);

  assert.deepEqual(events.map((event) => [event.kind, "seq" in event ? event.seq : null]), [["gap", 1], ["stream", 2], ["permissions", 2], ["exit", 1]]);
  assert.deepEqual(events[0]!.body, { dropped: "stream", count: 1 });
  assert.deepEqual(events[2]!.body, { type: "unavailable" });
  const terminal = events[3]!.body as ProviderTerminalPayload;
  assert.equal(terminal.terminalCause, "protocol_error");
  // Malformed data proves no process death: the replacement carries no witnessed death and no exit code.
  assert.equal("nativeRuntimeDeath" in terminal, false);
  assert.deepEqual([terminal.exitCode, terminal.signal], [null, null]);
  assert.equal(terminal.providerContinuationId, "thread-1");
  assert.equal((events[3] as { final?: true }).final, true);
  providerTerminalSchema.parse(jsonRoundTrip(terminal));
  for (const event of events) {
    assertPlainWireValue(event);
    providerEventEnvelopeSchema.parse(jsonRoundTrip(event));
    assert.doesNotMatch(JSON.stringify(event), /do-not-leak/);
  }
});

test("a permission subscription reports the end of the adapter's call as data, stays open, and ends with an abort inside the adapter", async () => {
  const fake = eventAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => events.push(event));
  const runtime = await boundary.spawn(SPAWN);
  boundary.subscribe(runtime.ref, "permissions", "s-perm");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events.map((event) => event.body), [{ type: "settled", outcome: "ended" }]);
  fake.permissions[0]!.listener({ type: "snapshot", connectionId: "socket-1", requests: [] } as never);
  assert.equal(events.length, 2, "the listener still works after the adapter's promise settled");
  assert.equal(fake.permissions[0]!.signal.aborted, false);
  boundary.unsubscribe("s-perm");
  assert.equal(fake.permissions[0]!.signal.aborted, true);
  fake.permissions[0]!.listener({ type: "degraded" } as never);
  assert.equal(events.length, 2);
});

test("through the router: each exit listener of a replaced runtime still gets the exit, and an error of one listener stays out of the adapter", async () => {
  const { adapter, exit } = recordingAdapter();
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const first = await router.spawn({ ...SPAWN, provider: "codex" });
  const seen: string[] = [];
  await router.onExit(first, () => { throw new Error("listener failed"); });
  const stopListening = await router.onExit(first, (terminal) => { seen.push(terminal.terminalCause); });
  await router.spawn({ ...SPAWN, provider: "codex" });
  // The router's own exit watch runs first and forgets the replaced runtime; the two daemon listeners come after it.
  // The first of them throws: the adapter's call does not throw, and the second still gets the exit.
  exit(0);
  assert.deepEqual(seen, ["stopped"]);
  stopListening();
});

test("through the router: a stream event after the exit of a replaced runtime still reaches its listener, and a dropped one arrives as a fault", async () => {
  const streamListeners = new Map<ProviderHandle, (event: never) => void>();
  const base = recordingAdapter();
  const adapter = { ...base.adapter, onStream: (handle: ProviderHandle, listener: (event: never) => void) => { streamListeners.set(handle, listener); return () => { streamListeners.delete(handle); }; } } as unknown as SupervisedProviderAdapter;
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const first = await router.spawn({ ...SPAWN, provider: "codex" });
  const seen: Array<{ kind: string; method: string; sequence: number }> = [];
  const stop = await router.onStream(first, (event) => { seen.push({ kind: event.kind, method: event.method, sequence: event.sequence }); });
  await router.spawn({ ...SPAWN, provider: "codex" });
  base.exit(0); // The first runtime is replaced and has exited: the boundary forgets it here.
  await assert.rejects(router.poke(first, "x"), STALE);

  const emit = streamListeners.get(base.handles[0]!)!;
  emit(STREAM_EVENT as never);
  emit({ ...STREAM_EVENT, payload: { callback: () => undefined } } as never);
  assert.deepEqual(seen, [
    { kind: "text_delta", method: "item/agentMessage/delta", sequence: 7 },
    { kind: "error", method: "boundary/event_dropped", sequence: 0 },
  ]);
  stop();
  emit?.(STREAM_EVENT as never);
  assert.equal(seen.length, 2);
  assert.equal(streamListeners.size, 0, "the dispose removed the adapter's listener");
});

test("an execution subscription keeps its identity and position with an empty history, a dropped observation shows in the position, and an unsubscribe inside the replay stops it", async () => {
  const fake = eventAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => {
    events.push(event);
    // The daemon ends the subscription while the adapter replays its history.
    if ("subscriptionId" in event && event.subscriptionId === "s-replay") boundary.unsubscribe("s-replay");
  });
  const runtime = await boundary.spawn(SPAWN);

  assert.deepEqual(boundary.subscribe(runtime.ref, "execution", "s-empty"), { subscriptionId: "s-empty", sourceId: "observer-1" });
  assert.deepEqual(boundary.subscriptionPosition("s-empty"), { firstRetainedSequence: 1, latestSequence: 0 });
  assert.equal(events.length, 0);

  // A dropped last observation: nothing follows it, and the position still counts it. The capture compares its
  // stored position with this value, so the difference is its source gap.
  fake.retained.push({ sourceId: "observer-1", sequence: 1, fact: { domain: "control", kind: "state_changed", state: "responsive" } });
  fake.execution[0]!({ sourceId: "observer-1", sequence: 1, fact: { hook: () => undefined } } as never);
  assert.deepEqual(events.map((event) => [event.kind, event.body]), [["gap", { dropped: "execution", count: 1 }]]);
  assert.deepEqual(boundary.subscriptionPosition("s-empty"), { firstRetainedSequence: 1, latestSequence: 1 });

  events.length = 0;
  fake.retained.push({ sourceId: "observer-1", sequence: 2, fact: { domain: "control", kind: "state_changed", state: "degraded" } });
  fake.retained.push({ sourceId: "observer-1", sequence: 3, fact: { domain: "control", kind: "state_changed", state: "responsive" } });
  boundary.subscribe(runtime.ref, "execution", "s-replay");
  assert.equal(events.filter((event) => "subscriptionId" in event && event.subscriptionId === "s-replay").length, 1, "one event, then the unsubscribe");
  assert.equal(boundary.subscriptionPosition("s-replay"), null);
  assert.equal(fake.disposedCount(), 1, "the adapter's subscription of the ended replay is disposed");
});

test("a sink that throws does not throw into the adapter and makes no further event", async () => {
  const fake = eventAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  let calls = 0;
  boundary.connectEventSink(() => { calls += 1; throw new Error("sink failed"); });
  const runtime = await boundary.spawn(SPAWN);
  boundary.subscribe(runtime.ref, "stream", "s-stream");
  boundary.subscribe(runtime.ref, "exit", "s-exit");
  fake.stream[0]!(STREAM_EVENT as never);
  fake.exit[0]!(TERMINAL);
  assert.equal(calls, 2);
});

test("through the router: start hints reach the daemon's two functions, also after the start", async () => {
  let hints: Pick<ProviderSpawnRequest, "onProgress" | "onNativeStarted"> = {};
  const { adapter } = fakeAdapter({ spawn: async (request) => { hints = request; request.onNativeStarted?.(); return new FakeHandle(request.workAttemptId); } });
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const seen: string[] = [];
  await router.spawn({ ...SPAWN, provider: "codex", onProgress: () => seen.push("progress"), onNativeStarted: () => seen.push("native") });
  assert.deepEqual(seen, ["native"]);
  hints.onProgress?.();
  assert.deepEqual(seen, ["native", "progress"]);
});

test("a callback of an ended subscription delivers nothing under a new subscription that uses the same id", async () => {
  const fake = eventAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => events.push(event));
  const first = await boundary.spawn(SPAWN);
  boundary.subscribe(first.ref, "exit", "s-same");
  const oldCallback = fake.exit[0]!;
  boundary.unsubscribe("s-same");
  boundary.release(first.ref);
  const second = await boundary.spawn(SPAWN);
  boundary.subscribe(second.ref, "exit", "s-same");

  oldCallback(TERMINAL); // A late call from the first runtime.
  assert.deepEqual(events, [], "nothing arrives under the second runtime's reference");
  fake.exit.at(-1)!({ ...TERMINAL, terminalCause: "killed" });
  assert.deepEqual(events.map((event) => [(event as { ref: { runtimeId: string } }).ref.runtimeId, (event.body as ProviderTerminalPayload).terminalCause]), [[second.ref.runtimeId, "killed"]]);
});

test("a subscription whose adapter result is not valid leaves no adapter subscription behind", async () => {
  let disposed = 0;
  const { adapter } = fakeAdapter({ onExecution: () => ({ sourceId: (() => "x") as never, position: () => ({ firstRetainedSequence: 1, latestSequence: 0 }), dispose: () => { disposed += 1; } }) });
  const boundary = new ProviderRuntimeBoundary("codex", adapter);
  boundary.connectEventSink(() => undefined);
  const runtime = await boundary.spawn(SPAWN);
  assert.throws(() => boundary.subscribe(runtime.ref, "execution", "s-bad"), ProviderBoundaryValueError);
  assert.equal(disposed, 1);
  assert.equal(boundary.subscriptionPosition("s-bad"), null);
});

test("a permission event that is not a known event becomes unavailable, also when it is plain data", async () => {
  const fake = eventAdapter();
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => events.push(event));
  const runtime = await boundary.spawn(SPAWN);
  boundary.subscribe(runtime.ref, "permissions", "s-perm");
  await Promise.resolve();
  await Promise.resolve();
  events.length = 0;
  for (const body of [null, "snapshot", 7, [], {}, { type: "made_up" }, { type: 3 }]) fake.permissions[0]!.listener(body as never);
  assert.deepEqual(events.map((event) => event.body), Array.from({ length: 7 }, () => ({ type: "unavailable" })));
  // A known event with a field that the daemon cannot read is the same case.
  const malformed = [{ type: "snapshot", connectionId: "socket", requests: null }, { type: "snapshot", connectionId: "socket" },
    { type: "snapshot", connectionId: "socket", requests: [null] }, { type: "snapshot", connectionId: 7, requests: [] },
    { type: "request_closed", request: null }, { type: "request_closed" }, { type: "settled", outcome: "made_up" }];
  events.length = 0;
  for (const body of malformed) fake.permissions[0]!.listener(body as never);
  assert.deepEqual(events.map((event) => event.body), malformed.map(() => ({ type: "unavailable" })));
  const request = { id: 1, method: "item/commandExecution/requestApproval", connectionId: "socket-1", params: {} };
  const snapshot = { type: "snapshot", connectionId: "socket-1", requests: [request] };
  fake.permissions[0]!.listener(snapshot as never);
  assert.equal(events.at(-1)!.body, snapshot, "a known event is the adapter's own object");
  assert.equal((events.at(-1)!.body as typeof snapshot).requests[0], request, "and its request is the adapter's own object");
});

test("through the router: aborting a permission observation settles its promise, also when the adapter's call is still open or the signal is aborted already", async () => {
  const signals: AbortSignal[] = [];
  // As the real adapters: the observation call stays open until the abort.
  const { adapter } = fakeAdapter({ observePermissions: (_handle, _listener, signal) => { signals.push(signal); return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); } });
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const handle = await router.spawn({ ...SPAWN, provider: "codex" });

  const controller = new AbortController();
  let settled = "pending";
  const observation = router.observePermissions(handle, () => undefined, controller.signal).then(() => { settled = "resolved"; }, () => { settled = "rejected"; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, "pending");
  controller.abort();
  await observation;
  assert.equal(settled, "resolved");
  assert.equal(signals[0]!.aborted, true, "the abort reached the adapter");

  const already = new AbortController();
  already.abort();
  await router.observePermissions(handle, () => undefined, already.signal);
});

test("through the router: a dropped execution observation calls the consumer's gap function", async () => {
  const fake = eventAdapter();
  const router = new ProviderActionPortRouter({ codex: async () => fake.adapter });
  const handle = await router.spawn({ ...SPAWN, provider: "codex" });
  const received: unknown[] = [];
  let gaps = 0;
  const subscription = await router.onExecution(handle, (event) => received.push(event), () => { gaps += 1; });
  fake.retained.push({ sourceId: "observer-1", sequence: 1 });
  fake.execution[0]!({ sourceId: "observer-1", sequence: 1, fact: { hook: () => undefined } } as never);
  assert.deepEqual([received.length, gaps], [0, 1]);
  assert.equal(subscription.position().latestSequence, 1);
  subscription.dispose();
  assert.equal(subscription.position().latestSequence, 1, "the last position stays the answer after the dispose");
});

// Step 4d-3a: an operation waits for the daemon with a `step` envelope, and the daemon answers with data.

type StepEvent = Extract<ProviderEventEnvelope, { kind: "step" }>;
const CONTROLLED = { capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" } as const;

/** A boundary whose sink keeps the step envelopes and answers each one with `answer`, when it is given. */
function steppedBoundary(overrides: Partial<SupervisedProviderAdapter>, answer?: (event: StepEvent, boundary: ProviderRuntimeBoundary) => void) {
  const fake = fakeAdapter(overrides);
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const steps: StepEvent[] = [];
  boundary.connectEventSink((event) => { if (event.kind === "step") { steps.push(event); answer?.(event, boundary); } });
  return { ...fake, boundary, steps };
}

test("a step is an envelope, the daemon answers it by operation and number, and the next step waits for the answer", async () => {
  const order: string[] = [];
  const { boundary, steps } = steppedBoundary({
    controlTurn: async (_handle, _correction, options) => {
      await options!.checkpointTurnStarted!("turn-9");
      order.push("checkpointed");
      await options!.markDispatched!();
      order.push("dispatched");
      return CONTROLLED;
    },
  });
  const runtime = await boundary.spawn(SPAWN);
  const result = boundary.controlTurn(runtime.ref, null, { operationId: "op-1", targetTurnId: "turn-9" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps.map((step) => [step.operationId, step.step, step.seq, step.body]), [["op-1", "checkpoint_turn_started", 1, { turnId: "turn-9" }]]);
  assert.deepEqual(order, [], "the adapter waits at the step");
  assert.equal(providerEventEnvelopeSchema.safeParse(JSON.parse(JSON.stringify(steps[0]))).success, true);
  assert.throws(() => boundary.answerStep("op-1", 2, { ok: true }), ProviderStepRefusedError, "an answer for a step that is not open");
  assert.throws(() => boundary.answerStep("op-other", 1, { ok: true }), ProviderStepRefusedError, "an answer for an unknown operation");
  boundary.answerStep("op-1", 1, { ok: true });
  assert.throws(() => boundary.answerStep("op-1", 1, { ok: true }), ProviderStepRefusedError, "a second answer");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["checkpointed"]);
  assert.deepEqual([steps[1]!.step, steps[1]!.seq], ["mark_dispatched", 2]);
  boundary.answerStep("op-1", 2, { ok: true });
  assert.deepEqual(await result, CONTROLLED);
  assert.deepEqual(order, ["checkpointed", "dispatched"]);
  assert.throws(() => boundary.answerStep("op-1", 2, { ok: true }), ProviderStepRefusedError, "an answer after the end of the operation");
  await assert.rejects(boundary.controlTurn(runtime.ref, null, { operationId: "" }), ProviderBoundaryValueError);
});

test("a refused step stops the adapter before its native work, and a sink that throws is a refusal", async () => {
  let dispatched = 0;
  const controlTurn: SupervisedProviderAdapter["controlTurn"] = async (_handle, _correction, options) => {
    await options!.markDispatched!();
    dispatched += 1;
    return CONTROLLED;
  };
  const refused = steppedBoundary({ controlTurn }, (event, boundary) => {
    boundary.answerStep(event.operationId, event.seq, { ok: false, error: { name: "Error", message: "the journal is closed", fields: { code: "JOURNAL_CLOSED" } } });
  });
  const runtime = await refused.boundary.spawn(SPAWN);
  await assert.rejects(refused.boundary.controlTurn(runtime.ref, null, { operationId: "op-1" }),
    (error: Error & { code?: string; daemonStep?: number }) => error.message === "the journal is closed" && error.code === "JOURNAL_CLOSED" && error.daemonStep === 1);

  const fake = fakeAdapter({ controlTurn });
  const broken = new ProviderRuntimeBoundary("codex", fake.adapter);
  broken.connectEventSink(() => { throw new Error("sink is down"); });
  const second = await broken.spawn(SPAWN);
  await assert.rejects(broken.controlTurn(second.ref, null, { operationId: "op-2" }), /the event sink did not take the step/);

  const silent = new ProviderRuntimeBoundary("codex", fakeAdapter({ controlTurn }).adapter);
  const third = await silent.spawn(SPAWN);
  await assert.rejects(silent.controlTurn(third.ref, null, { operationId: "op-3" }), /the event sink did not take the step/);
  assert.equal(dispatched, 0);
});

test("a synchronous check needs its answer inside the delivery: no answer and a late answer are refusals", async () => {
  let stopped = 0;
  const stopIdle: SupervisedProviderAdapter["stopIdle"] = async (_handle, assertCurrent) => { assertCurrent(); stopped += 1; return TERMINAL; };
  const unanswered = steppedBoundary({ stopIdle });
  const runtime = await unanswered.boundary.spawn(SPAWN);
  await assert.rejects(unanswered.boundary.stopIdle(runtime.ref, { operationId: "op-1" }), /the check got no answer/);
  assert.deepEqual(unanswered.steps.map((step) => [step.step, step.sync]), [["assert_current", true]]);
  assert.equal(stopped, 0);

  const late = steppedBoundary({ stopIdle }, (event, boundary) => { queueMicrotask(() => { assert.throws(() => boundary.answerStep(event.operationId, event.seq, { ok: true }), ProviderStepRefusedError); }); });
  const second = await late.boundary.spawn(SPAWN);
  await assert.rejects(late.boundary.stopIdle(second.ref, { operationId: "op-2" }), /the check got no answer/);
  assert.equal(stopped, 0);

  const answered = steppedBoundary({ stopIdle }, (event, boundary) => boundary.answerStep(event.operationId, event.seq, { ok: true }));
  const third = await answered.boundary.spawn(SPAWN);
  assert.deepEqual(await answered.boundary.stopIdle(third.ref, { operationId: "op-3" }), TERMINAL);
  assert.equal(stopped, 1);
});

test("a detach ends the observation only: the adapter sees its signal, and a step that waits takes a refusal", async () => {
  const seen: boolean[] = [];
  let dispatched = 0;
  const { boundary, steps } = steppedBoundary({
    controlExactTurn: async (_handle, options) => {
      seen.push(options.detachSignal!.aborted);
      if (options.detachSignal!.aborted) throw new Error("observation detached");
      await options.checkpointTargetTurn("turn-3");
      dispatched += 1;
      return { outcome: "interrupt_dispatched", targetTurnId: "turn-3" };
    },
  });
  const runtime = await boundary.spawn(SPAWN);
  const waiting = boundary.controlExactTurn(runtime.ref, { operationId: "op-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(steps.length, 1);
  boundary.detachOperation("op-1");
  await assert.rejects(waiting, /the operation was detached/);
  assert.throws(() => boundary.answerStep("op-1", 1, { ok: true }), ProviderStepRefusedError);
  await assert.rejects(boundary.controlExactTurn(runtime.ref, { operationId: "op-2", detached: true }), /observation detached/);
  assert.deepEqual(seen, [false, true]);
  assert.equal(dispatched, 0);
  boundary.detachOperation("op-unknown");
});

test("an error leaves an operation as data: its name, its message and the listed fields, and nothing else", async () => {
  const thrown = Object.assign(new Error("interrupt was not applied"), { turnControlOutcome: "not_applied", secret: "token-1", client: { send: () => undefined } });
  const { boundary } = steppedBoundary({ controlTurn: async () => { throw thrown; } });
  const runtime = await boundary.spawn(SPAWN);
  const error = await boundary.controlTurn(runtime.ref, null, { operationId: "op-1" }).then(() => null, (reason: Error) => reason);
  assert.ok(error instanceof Error);
  assert.notEqual(error, thrown, "not the adapter's own object");
  assert.deepEqual([error.name, error.message, (error as { turnControlOutcome?: string }).turnControlOutcome], ["Error", "interrupt was not applied", "not_applied"]);
  assert.deepEqual(Object.keys(error).sort(), ["turnControlOutcome"]);
});

test("each error field that an adapter sets is in the list of fields that cross the boundary", () => {
  const root = new URL("../../provider-runtime/agents/", import.meta.url);
  const set = new Set<string>();
  const scan = (directory: URL) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== "__tests__") scan(new URL(`${entry.name}/`, directory)); continue; }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(new URL(entry.name, directory), "utf8");
      for (const match of source.matchAll(/Object\.assign\(new Error\([^;]*?\), \{ ([a-zA-Z]+):/g)) set.add(match[1]!);
      for (const match of source.matchAll(/readonly ([a-zA-Z]*(?:Outcome|FailureCode))\b/g)) set.add(match[1]!);
    }
  };
  scan(root);
  assert.ok(set.size >= 5, "the scan found the adapters' error fields");
  // Fields that only code inside the package reads.
  const inside = new Set(["transientProviderStart"]);
  assert.deepEqual([...set].filter((field) => !PROVIDER_ERROR_FIELDS.includes(field as never) && !inside.has(field)).sort(), []);
});

test("a permission request has a token while it is open, and the permission operations take the token", async () => {
  const fake = eventAdapter();
  const replies: unknown[] = [];
  fake.adapter.replyPermission = async (_handle, request, _reply, options) => {
    await options!.beforeNativeDispatch();
    options!.assertNativeDispatch!();
    replies.push(request);
    return { outcome: "sent", scope: "request" };
  };
  fake.adapter.inspectPermissionProfile = async (_handle, request) => { replies.push(request); return { network: true }; };
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => {
    if (event.kind === "step") boundary.answerStep(event.operationId, event.seq, { ok: true });
    else events.push(event);
  });
  const runtime = await boundary.spawn(SPAWN);
  const other = await boundary.spawn({ ...SPAWN, workAttemptId: "attempt-2" });
  boundary.subscribe(runtime.ref, "permissions", "s-perm");
  await new Promise((resolve) => setImmediate(resolve));
  events.length = 0;
  const emit = fake.permissions[0]!.listener as (event: unknown) => void;
  const tokens = () => (events.at(-1) as { permissionTokens?: string[] }).permissionTokens;

  const first = { id: 7, method: "item/commandExecution/requestApproval", connectionId: "socket-1", params: {} };
  const second = { id: 8, method: "item/permissions/requestApproval", connectionId: "socket-1", params: {} };
  emit({ type: "snapshot", connectionId: "socket-1", requests: [first] });
  const [tokenOfFirst] = tokens()!;
  emit({ type: "snapshot", connectionId: "socket-1", requests: [first, second] });
  assert.equal(tokens()![0], tokenOfFirst, "the same request keeps its token");
  const tokenOfSecond = tokens()![1]!;
  assert.notEqual(tokenOfSecond, tokenOfFirst);

  // The token crosses as JSON, and the adapter gets its own request object.
  const named = JSON.parse(JSON.stringify({ token: tokenOfFirst }));
  assert.deepEqual(await boundary.replyPermission(runtime.ref, named, "once", { operationId: "op-1" }), { outcome: "sent", scope: "request" });
  assert.deepEqual(await boundary.inspectPermissionProfile(runtime.ref, { token: tokenOfSecond }), { network: true });
  assert.equal(replies[0], first);
  assert.equal(replies[1], second);

  const refused = (error: Error & { outcome?: string }) => error.outcome === "not_dispatched";
  await assert.rejects(boundary.replyPermission(other.ref, { token: tokenOfFirst }, "once", { operationId: "op-2" }), refused, "a token of another runtime");
  emit({ type: "request_closed", request: first });
  assert.deepEqual(tokens(), [tokenOfFirst]);
  await assert.rejects(boundary.replyPermission(runtime.ref, { token: tokenOfFirst }, "once", { operationId: "op-3" }), refused, "a closed request");
  // Codex uses the request id again: the new request is another object, and it gets a new token.
  const again = { ...first };
  emit({ type: "snapshot", connectionId: "socket-1", requests: [again] });
  assert.notEqual(tokens()![0], tokenOfFirst);
  await assert.rejects(boundary.replyPermission(runtime.ref, { token: tokenOfSecond }, "once", { operationId: "op-4" }), refused, "a request that the snapshot no longer has");
  boundary.release(runtime.ref);
  assert.equal(replies.length, 2);
});

test("the lines of a repair are acknowledged by a data call, one time", async () => {
  let recorded = 0;
  const { boundary, handles } = steppedBoundary({
    repairContinuation: async (handle, request, options) => {
      await options.checkpointReplacement("thread-2");
      return { handle, outcome: "rematerialized", previousProviderContinuationId: request.expectedProviderContinuationId,
        replacementProviderContinuationId: "thread-1", notices: ["said once"], noticesRecorded: () => { recorded += 1; } };
    },
  }, (event, target) => target.answerStep(event.operationId, event.seq, { ok: true }));
  const runtime = await boundary.spawn(SPAWN);
  const result = await boundary.repairContinuation(runtime.ref, { workAttemptId: "attempt-1", expectedProviderContinuationId: "thread-1", cwd: "/tmp/work", launchPolicy: {} }, { operationId: "op-1" });
  assert.equal(handles.length, 1);
  assert.deepEqual([result.runtime.ref.runtimeId, result.noticesAwaitAcknowledgement, result.notices], [runtime.ref.runtimeId, true, ["said once"]]);
  assertPlainWireValue(result, "repair result");
  assert.equal(recorded, 0);
  boundary.acknowledgeRepairNotices("op-1");
  boundary.acknowledgeRepairNotices("op-1");
  assert.equal(recorded, 1);
});

test("through the router: the daemon's functions run at the steps, and a function that throws fails the operation with its own error", async () => {
  const order: string[] = [];
  const { adapter } = fakeAdapter({
    controlTurn: async (_handle, _correction, options) => {
      await options!.checkpointTurnStarted!("turn-9");
      await options!.markDispatched!();
      order.push("native interrupt");
      return CONTROLLED;
    },
  });
  const router = new ProviderActionPortRouter({ codex: async () => adapter });
  const handle = await router.spawn({ ...SPAWN, provider: "codex" });
  assert.deepEqual(await router.controlTurn(handle, null, {
    checkpointTurnStarted: async (turnId) => { order.push(`checkpoint ${turnId}`); },
    markDispatched: async () => { order.push("dispatch saved"); },
  }), CONTROLLED);
  assert.deepEqual(order, ["checkpoint turn-9", "dispatch saved", "native interrupt"]);

  class JournalClosed extends Error { readonly lease = { private: true }; }
  const own = new JournalClosed("the journal is closed");
  order.length = 0;
  await assert.rejects(router.controlTurn(handle, null, { markDispatched: async () => { throw own; } }), (error) => error === own);
  assert.deepEqual(order, [], "no native work after a refused step");
  assert.deepEqual(await router.controlTurn(handle, null), CONTROLLED, "a call with no functions");
});

test("a sink that answers a step and then throws does not authorize native work", async () => {
  let work = 0;
  const overrides: Partial<SupervisedProviderAdapter> = {
    controlTurn: async (_handle, _correction, options) => { await options!.markDispatched!(); work += 1; return CONTROLLED; },
    stopIdle: async (_handle, assertCurrent) => { assertCurrent(); work += 1; return TERMINAL; },
  };
  const boundary = new ProviderRuntimeBoundary("codex", fakeAdapter(overrides).adapter);
  const late: Array<() => void> = [];
  boundary.connectEventSink((event) => {
    if (event.kind !== "step") return;
    boundary.answerStep(event.operationId, event.seq, { ok: true });
    late.push(() => boundary.answerStep(event.operationId, event.seq, { ok: true }));
    throw new Error("sink failed after its answer");
  });
  const runtime = await boundary.spawn(SPAWN);
  await assert.rejects(boundary.controlTurn(runtime.ref, null, { operationId: "op-1" }), /the event sink did not take the step/);
  await assert.rejects(boundary.stopIdle(runtime.ref, { operationId: "op-2" }), /the event sink did not take the check/);
  assert.equal(work, 0);
  for (const answer of late) assert.throws(answer, ProviderStepRefusedError);
});

test("the body of a step is checked before it is an envelope, and each step shape is JSON data", async () => {
  let work = 0;
  const { boundary, steps } = steppedBoundary({
    controlTurn: async (_handle, _correction, options) => { await options!.checkpointTurnStarted!((() => "turn") as never); work += 1; return CONTROLLED; },
    controlExactTurn: async (_handle, options) => { await options.checkpointTargetTurn(""); work += 1; return { outcome: "interrupt_dispatched", targetTurnId: "" }; },
    repairContinuation: async (handle, _request, options) => {
      await options.checkpointReplacement({ id: "thread-2" } as never);
      work += 1;
      return { handle, outcome: "replaced", previousProviderContinuationId: "thread-1", replacementProviderContinuationId: "thread-2" };
    },
  }, (event, target) => target.answerStep(event.operationId, event.seq, { ok: true }));
  const runtime = await boundary.spawn(SPAWN);
  await assert.rejects(boundary.controlTurn(runtime.ref, null, { operationId: "op-1" }), ProviderBoundaryValueError);
  await assert.rejects(boundary.controlExactTurn(runtime.ref, { operationId: "op-2" }), ProviderBoundaryValueError);
  await assert.rejects(boundary.repairContinuation(runtime.ref, { workAttemptId: "attempt-1", expectedProviderContinuationId: "thread-1", cwd: "/tmp/work", launchPolicy: {} }, { operationId: "op-3" }), ProviderBoundaryValueError);
  assert.deepEqual([steps.length, work], [0, 0], "no envelope and no native work for a body that is not valid");
  // The refused step left no open wait: the same ids can be used again.
  await assert.rejects(boundary.controlTurn(runtime.ref, null, { operationId: "op-1" }), ProviderBoundaryValueError);

  const samples: Record<(typeof PROVIDER_STEP_NAMES)[number], unknown> = {
    checkpoint_turn_started: { turnId: "turn-9" }, mark_dispatched: null, checkpoint_target_turn: { turnId: "turn-9" },
    before_native_dispatch: null, assert_native_dispatch: null, assert_current: null, checkpoint_replacement: { providerContinuationId: "thread-2" },
  };
  for (const step of PROVIDER_STEP_NAMES) {
    const envelope = JSON.parse(JSON.stringify({ kind: "step", operationId: "op-1", ref: runtime.ref, step, seq: 1, order: 1, body: samples[step] }));
    assert.equal(providerEventEnvelopeSchema.safeParse(envelope).success, true, step);
    assert.equal(PROVIDER_STEP_BODY_SCHEMAS[step].safeParse(envelope.body).success, true, step);
    assert.equal(PROVIDER_STEP_BODY_SCHEMAS[step].safeParse({ turnId: 7 }).success, false, step);
  }
});

test("a permission token ends with the authority that gave it", async () => {
  for (const provider of ["codex", "open-model"] as const) {
    const fake = eventAdapter();
    const reached: string[] = [];
    fake.adapter.replyPermission = async () => { reached.push("reply"); return { outcome: "sent", scope: "request" }; };
    fake.adapter.inspectPermissionProfile = async () => { reached.push("profile"); return {}; };
    fake.adapter.inspectPermissionFileChanges = async () => { reached.push("files"); return []; };
    fake.adapter.inspectPermissionMcpToolCall = async () => { reached.push("mcp"); return {}; };
    const boundary = new ProviderRuntimeBoundary(provider, fake.adapter);
    const events: ProviderEventEnvelope[] = [];
    boundary.connectEventSink((event) => { if (event.kind !== "step") events.push(event); });
    const runtime = await boundary.spawn(SPAWN);
    boundary.subscribe(runtime.ref, "permissions", "s-perm");
    await new Promise((resolve) => setImmediate(resolve));
    const emit = fake.permissions[0]!.listener as (event: unknown) => void;
    const tokens = () => (events.at(-1) as { permissionTokens?: string[] }).permissionTokens;
    const request = () => ({ id: 7, method: "item/commandExecution/requestApproval", connectionId: "socket-1", params: {} });
    const refused = (error: Error & { outcome?: string }) => error.outcome === "not_dispatched";
    const allRefused = async (token: string, label: string) => {
      await assert.rejects(boundary.replyPermission(runtime.ref, { token }, "once", { operationId: `op-${label}` }), refused, label);
      await assert.rejects(boundary.inspectPermissionProfile(runtime.ref, { token }), refused, label);
      await assert.rejects(boundary.inspectPermissionFileChanges(runtime.ref, { token }), refused, label);
      await assert.rejects(boundary.inspectPermissionMcpToolCall(runtime.ref, { token }), refused, label);
    };

    const first = request();
    emit({ type: "snapshot", connectionId: "socket-1", requests: [first] });
    const [issued] = tokens()!;
    emit({ type: "snapshot", connectionId: "socket-1", requests: [provider === "codex" ? first : request()] });
    assert.deepEqual(tokens(), [issued], "an unchanged snapshot keeps the token");

    for (const lost of [{ type: "unavailable" }, { type: "degraded" }, { type: "snapshot", requests: null }]) {
      emit({ type: "snapshot", connectionId: "socket-1", requests: [first] });
      const [before] = tokens()!;
      emit(lost);
      await allRefused(before!, `${provider} after ${JSON.stringify(lost)}`);
      // The lane is read again: the same request, or an equal one, gets a new token.
      emit({ type: "snapshot", connectionId: "socket-1", requests: [provider === "codex" ? first : request()] });
      assert.notEqual(tokens()![0], before);
    }

    const [beforeChange] = tokens()!;
    emit({ type: "snapshot", connectionId: "socket-2", requests: [first] });
    assert.notEqual(tokens()![0], beforeChange, "another connection id gives new tokens");
    await allRefused(beforeChange!, `${provider} after a changed connection id`);

    const [beforeProcess] = tokens()!;
    assert.deepEqual(reached, [], "no adapter call for a token whose authority ended");
    assert.deepEqual(await boundary.inspectPermissionProfile(runtime.ref, { token: beforeProcess! }), {});
    assert.deepEqual(reached, ["profile"], "a live token reaches the adapter");
  }
});

test("a permission token is refused after the native connection of its runtime changed", async () => {
  const fake = eventAdapter();
  let reached = 0;
  fake.adapter.inspectPermissionProfile = async () => { reached += 1; return {}; };
  const created: FakeHandle[] = [];
  const spawn = fake.adapter.spawn.bind(fake.adapter);
  fake.adapter.spawn = async (request) => { const handle = await spawn(request) as FakeHandle; created.push(handle); return handle; };
  const boundary = new ProviderRuntimeBoundary("codex", fake.adapter);
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => events.push(event));
  const runtime = await boundary.spawn(SPAWN);
  boundary.subscribe(runtime.ref, "permissions", "s-perm");
  await new Promise((resolve) => setImmediate(resolve));
  (fake.permissions[0]!.listener as (event: unknown) => void)({ type: "snapshot", connectionId: "socket-1", requests: [{ id: 7, method: "m", connectionId: "socket-1" }] });
  const [token] = (events.at(-1) as { permissionTokens: string[] }).permissionTokens;
  created[0]!.providerConnection = { kind: "codex_app_server", url: "ws://127.0.0.1:1", pid: 5151, processIdentity: "birth-2" };
  await assert.rejects(boundary.inspectPermissionProfile(runtime.ref, { token: token! }), (error: Error & { outcome?: string }) => error.outcome === "not_dispatched");
  assert.equal(reached, 0);
});
