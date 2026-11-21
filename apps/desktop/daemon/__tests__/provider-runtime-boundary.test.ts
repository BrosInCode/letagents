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
  const internal = new Set(["constructor", "has", "inspectIfHeld", "required", "matches", "held", "continuation", "terminal", "installed", "snapshot"]);
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
  assert.notEqual(handle.providerConnection, handles[0]!.providerConnection, "a copy, not the adapter's own object");
  handles[0]!.state = "working";
  assert.equal(handle.observedState, "working");

  // The router file names no provider handle type; only the boundary resolves a reference.
  const source = readFileSync(new URL("../provider-action-port-router.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bProviderHandle\b/);
  assert.doesNotMatch(source, /adapter\.(?!capabilities\b)[a-zA-Z]+\(/, "the router calls the adapter only through the boundary");
});
