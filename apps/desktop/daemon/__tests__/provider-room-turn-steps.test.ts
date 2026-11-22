// Step 4d-3b: the room turn and its recovery wait for the daemon with `step` envelopes, and the images of a turn
// cross the boundary as base64 text.
import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderHandle, ProviderObservedState, ProviderRoomTurnOptions, ProviderRoomTurnRequest, ProviderRoomTurnResult,
  ProviderSpawnRequest, SupervisedProviderAdapter,
} from "#provider-runtime/agents/provider-adapter.js";
import {
  ROOM_TURN_IMAGE_MAX_BYTES, ROOM_TURN_IMAGES_MAX_TOTAL_BYTES, ROOM_TURN_RECENT_IMAGE_LIMIT,
} from "#provider-runtime/agents/provider-adapter.js";
import {
  OPERATION_STEPS, PROVIDER_BOUNDARY_SCHEMAS, ProviderBoundaryValueError, type ProviderEventEnvelope, ProviderRuntimeBoundary,
  ProviderStepRefusedError, ROOM_TURN_RECOVERY_STEP_NAMES, ROOM_TURN_STEP_NAMES,
} from "#provider-runtime/agents/provider-runtime-boundary.js";
import { ProviderActionPortRouter } from "../provider-action-port-router.js";

class FakeHandle implements ProviderHandle {
  state: ProviderObservedState = "idle";
  providerContinuationId: string | null = "thread-1";
  providerConnection: ProviderHandle["providerConnection"] = { kind: "cursor_cli", pid: 4242, processIdentity: "birth-1" };
  constructor(readonly workAttemptId: string, readonly pid: number | null = 4242) {}
  observedState(): ProviderObservedState { return this.state; }
}

type RoomTurn = (handle: ProviderHandle, request: ProviderRoomTurnRequest, options?: ProviderRoomTurnOptions) => Promise<ProviderRoomTurnResult>;
type Recover = NonNullable<SupervisedProviderAdapter["recoverRoomTurn"]>;

function fakeAdapter(runRoomTurn: RoomTurn, recoverRoomTurn?: Recover): SupervisedProviderAdapter {
  return {
    id: "cursor",
    capabilities: () => ({ resume: true, midTurnInjection: false, transcriptAccess: true, permissionPromptBridging: true, survivesRestart: false }),
    spawn: async (request: ProviderSpawnRequest) => new FakeHandle(request.workAttemptId),
    attach: async () => null,
    resume: async (_ref: unknown, request: ProviderSpawnRequest) => new FakeHandle(request.workAttemptId),
    poke: async () => undefined,
    controlTurn: async () => ({ capability: "native_interrupt", interrupted: true, resumed: false, state: "idle" }),
    stop: async () => ({ endedAt: "2026-11-22T00:00:00.000Z", exitCode: 0, signal: null, terminalCause: "stopped", providerContinuationId: "thread-1" }),
    onExit: () => () => undefined,
    onStream: () => () => undefined,
    runRoomTurn,
    ...(recoverRoomTurn ? { recoverRoomTurn } : {}),
  } as unknown as SupervisedProviderAdapter;
}

const SPAWN = { workAttemptId: "attempt-1", roomId: "room-1", cwd: "/tmp/work", launchPolicy: { mode: "ask" }, provider: "cursor" } as const;
const REQUEST: ProviderRoomTurnRequest = { inboxItemId: "inbox-1", sourceMessage: { id: "msg-1", text: "hello" }, activation: {}, actionId: "action-1" };
const REPLY: ProviderRoomTurnResult = { turnId: "turn-1", outcome: "reply", text: "done" };
const CONNECTION = { kind: "cursor_cli" as const, pid: 5151, processIdentity: "birth-2" };
const OPTION_NAMES = [
  "beforeNativeDispatch", "checkpointTurnStarted", "checkpointPreparedTurn", "checkpointProviderState",
  "settleLifecycleBeforeIdle", "markDurableTurnStarted", "checkpointTerminalResult",
] as const;

async function routed(adapter: SupervisedProviderAdapter) {
  const router = new ProviderActionPortRouter({ cursor: async () => adapter });
  const handle = await router.spawn({ ...SPAWN });
  return { router, handle };
}

test("the room turn and its recovery have steps, and their schemas are wire data", () => {
  assert.deepEqual([...OPERATION_STEPS.runRoomTurn], [
    "before_native_dispatch", "checkpoint_turn_started", "checkpoint_prepared_turn", "checkpoint_provider_state",
    "settle_lifecycle_before_idle", "mark_durable_turn_started (sync)", "checkpoint_terminal_result",
  ]);
  assert.deepEqual([...OPERATION_STEPS.recoverRoomTurn], [...ROOM_TURN_RECOVERY_STEP_NAMES]);
  for (const name of ["providerRoomTurnOptions", "providerRoomTurnRecoveryOptions", "providerRoomTurnResult", "providerRoomTurnCheckpointDisposition"]) {
    assert.ok(name in PROVIDER_BOUNDARY_SCHEMAS, name);
  }
});

test("the adapter gets a function only for each step that the daemon gives, and for no other", async () => {
  const daemonFunctions: Record<(typeof OPTION_NAMES)[number], unknown> = {
    beforeNativeDispatch: async () => undefined,
    checkpointTurnStarted: async () => undefined,
    checkpointPreparedTurn: async () => undefined,
    checkpointProviderState: async () => undefined,
    settleLifecycleBeforeIdle: async () => undefined,
    markDurableTurnStarted: () => undefined,
    checkpointTerminalResult: async () => undefined,
  };
  for (const given of OPTION_NAMES) {
    let seen: string[] = [];
    const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
      seen = OPTION_NAMES.filter((name) => typeof options?.[name] === "function");
      assert.ok(options?.detachSignal instanceof AbortSignal, "the adapter's own detach signal");
      return REPLY;
    }));
    await router.runRoomTurn(handle, REQUEST, { [given]: daemonFunctions[given] });
    assert.deepEqual(seen, [given], `only ${given}`);
  }
  // No function: the adapter sees none, as when the daemon gave no callbacks before.
  let none: string[] = ["unset"];
  const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
    none = OPTION_NAMES.filter((name) => typeof options?.[name] === "function");
    return REPLY;
  }));
  await router.runRoomTurn(handle, REQUEST);
  assert.deepEqual(none, []);
});

test("the old name of the dispatch point is the same step", async () => {
  const order: string[] = [];
  const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
    await options!.beforeNativeDispatch!();
    order.push("native");
    return REPLY;
  }));
  await router.runRoomTurn(handle, REQUEST, { markDispatched: async () => { order.push("daemon"); } });
  assert.deepEqual(order, ["daemon", "native"]);
});

test("each step carries its data to the daemon's function, in the order of the adapter, before the native work goes on", async () => {
  const order: string[] = [];
  const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
    await options!.beforeNativeDispatch!();
    order.push("adapter:dispatch");
    await options!.checkpointPreparedTurn!({ providerTurnId: "turn-1", providerContinuationId: "thread-2", providerConnection: CONNECTION });
    await options!.checkpointProviderState!({ providerContinuationId: "thread-2", providerConnection: CONNECTION });
    await options!.checkpointTurnStarted!("turn-1");
    options!.markDurableTurnStarted!();
    order.push("adapter:durable");
    await options!.settleLifecycleBeforeIdle!();
    const disposition = await options!.checkpointTerminalResult!(REPLY);
    order.push(`adapter:released:${JSON.stringify(disposition)}`);
    return REPLY;
  }));
  const result = await router.runRoomTurn(handle, REQUEST, {
    beforeNativeDispatch: async () => { order.push("daemon:dispatch"); },
    checkpointPreparedTurn: async (state) => { order.push(`daemon:prepared:${state.providerTurnId}:${state.providerContinuationId}:${state.providerConnection.pid}`); },
    checkpointProviderState: async (state) => { order.push(`daemon:state:${state.providerContinuationId}:${state.providerConnection.processIdentity}`); },
    checkpointTurnStarted: async (turnId) => { order.push(`daemon:started:${turnId}`); },
    markDurableTurnStarted: () => { order.push("daemon:durable"); },
    settleLifecycleBeforeIdle: async () => { order.push("daemon:settled"); },
    checkpointTerminalResult: async (terminal) => {
      order.push(`daemon:terminal:${terminal.outcome}`);
      return { acceptedResult: terminal, cleanupRecoveryEvidence: true };
    },
  });
  assert.deepEqual(result, REPLY);
  assert.deepEqual(order, [
    "daemon:dispatch", "adapter:dispatch",
    "daemon:prepared:turn-1:thread-2:5151", "daemon:state:thread-2:birth-2", "daemon:started:turn-1",
    "daemon:durable", "adapter:durable",
    "daemon:settled",
    "daemon:terminal:reply",
    `adapter:released:${JSON.stringify({ acceptedResult: REPLY, cleanupRecoveryEvidence: true })}`,
  ], "the terminal is recorded before the adapter releases its evidence");
});

test("a terminal checkpoint with no disposition is undefined for the adapter, not null and not {}", async () => {
  for (const returned of [undefined, { acceptedResult: REPLY, cleanupRecoveryEvidence: false }]) {
    let seen: unknown = "unset";
    const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
      seen = await options!.checkpointTerminalResult!(REPLY);
      return REPLY;
    }));
    await router.runRoomTurn(handle, REQUEST, { checkpointTerminalResult: async () => returned });
    assert.deepEqual(seen, returned);
  }
});

test("an answer body survives a JSON transport, and an omitted body stays omitted", async () => {
  // A daemon in another process answers through JSON. The sink here serializes each answer as that daemon would.
  for (const body of [undefined, { acceptedResult: REPLY, cleanupRecoveryEvidence: true }]) {
    let seen: unknown = "unset";
    const boundary = new ProviderRuntimeBoundary("cursor", fakeAdapter(async (_handle, _request, options) => {
      seen = await options!.checkpointTerminalResult!(REPLY);
      return REPLY;
    }));
    boundary.connectEventSink((event) => {
      if (event.kind !== "step") return;
      const answer = JSON.parse(JSON.stringify(body === undefined ? { ok: true } : { ok: true, body }));
      queueMicrotask(() => boundary.answerStep(event.operationId, event.seq, answer));
    });
    const runtime = await boundary.spawn({ ...SPAWN });
    await boundary.runRoomTurn(runtime.ref, REQUEST, { operationId: "op-1", steps: ["checkpoint_terminal_result"] });
    assert.deepEqual(seen, body);
  }
});

test("a disposition that is not the contract's shape is refused into the adapter", async () => {
  let thrown: unknown;
  const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
    try { await options!.checkpointTerminalResult!(REPLY); } catch (error) { thrown = error; }
    return REPLY;
  }));
  await router.runRoomTurn(handle, REQUEST, { checkpointTerminalResult: async () => ({ acceptedResult: REPLY, cleanupRecoveryEvidence: "yes" } as never) });
  assert.ok(thrown instanceof Error);
  assert.match((thrown as Error).message, /cleanupRecoveryEvidence/);
});

test("the durable mark is answered on the same stack, before the adapter's next line", async () => {
  const order: string[] = [];
  const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
    options!.markDurableTurnStarted!();
    order.push("adapter:next-line");
    return REPLY;
  }));
  await router.runRoomTurn(handle, REQUEST, { markDurableTurnStarted: () => { order.push("daemon:mark"); } });
  assert.deepEqual(order, ["daemon:mark", "adapter:next-line"]);

  // A daemon that refuses the mark makes the adapter's call throw at once.
  const refused = new Error("the turn is not durable");
  let thrown: unknown;
  const second = await routed(fakeAdapter(async (_handle, _request, options) => {
    try { options!.markDurableTurnStarted!(); } catch (error) { thrown = error; }
    return REPLY;
  }));
  await second.router.runRoomTurn(second.handle, REQUEST, { markDurableTurnStarted: () => { throw refused; } });
  assert.equal((thrown as Error).message, refused.message);
});

test("a detach before the durable mark aborts the adapter's preparation; after it the native turn is not cancelled", async () => {
  // Before the mark: the detach aborts the adapter's own signal, and a step that waits is refused.
  const controller = new AbortController();
  let abortedBeforeMark = false;
  let dispatchRefused: unknown;
  const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
    options!.detachSignal!.addEventListener("abort", () => { abortedBeforeMark = true; }, { once: true });
    try { await options!.beforeNativeDispatch!(); } catch (error) { dispatchRefused = error; }
    return REPLY;
  }));
  await router.runRoomTurn(handle, REQUEST, {
    beforeNativeDispatch: () => { controller.abort(); return new Promise<void>(() => undefined); },
    detachSignal: controller.signal,
  });
  assert.equal(abortedBeforeMark, true);
  assert.ok(dispatchRefused instanceof Error && /detached/.test(dispatchRefused.message), "the waiting step is refused, so nothing is dispatched");

  // After the mark: an adapter that unlinks its preparation detach at the mark keeps its native turn.
  const later = new AbortController();
  let cancelled = false;
  let released!: () => void;
  const native = new Promise<void>((resolve) => { released = resolve; });
  const second = await routed(fakeAdapter(async (_handle, _request, options) => {
    const cancel = () => { cancelled = true; };
    options!.detachSignal!.addEventListener("abort", cancel, { once: true });
    options!.markDurableTurnStarted!();
    options!.detachSignal!.removeEventListener("abort", cancel);
    later.abort();
    await native;
    return REPLY;
  }));
  const turn = second.router.runRoomTurn(second.handle, REQUEST, { markDurableTurnStarted: () => undefined, detachSignal: later.signal });
  released();
  assert.deepEqual(await turn, REPLY);
  assert.equal(cancelled, false);
});

test("a daemon error that refuses a step is the same object when the adapter passes it on", async () => {
  class DaemonFenceLost extends Error {}
  const fence = new DaemonFenceLost("fence lost");
  const { router, handle } = await routed(fakeAdapter(async (_handle, _request, options) => {
    await options!.checkpointTurnStarted!("turn-1");
    return REPLY;
  }));
  await assert.rejects(router.runRoomTurn(handle, REQUEST, { checkpointTurnStarted: async () => { throw fence; } }), (error) => error === fence);
});

test("recovery has the three shared steps and the detach, and no other", async () => {
  let seen: string[] = [];
  const { router, handle } = await routed(fakeAdapter(async () => REPLY, async (_handle, _request, options) => {
    seen = Object.keys(options ?? {}).filter((name) => typeof (options as Record<string, unknown>)[name] === "function").sort();
    assert.ok(options?.detachSignal instanceof AbortSignal);
    const disposition = await options!.checkpointTerminalResult!(REPLY);
    assert.deepEqual(disposition, { acceptedResult: REPLY, cleanupRecoveryEvidence: true });
    return REPLY;
  }));
  const result = await router.recoverRoomTurn(handle, { inboxItemId: "inbox-1", providerTurnId: "turn-1" }, {
    checkpointProviderState: async () => undefined,
    settleLifecycleBeforeIdle: async () => undefined,
    checkpointTerminalResult: async (terminal) => ({ acceptedResult: terminal, cleanupRecoveryEvidence: true }),
  });
  assert.deepEqual(result, REPLY);
  assert.deepEqual(seen, ["checkpointProviderState", "checkpointTerminalResult", "settleLifecycleBeforeIdle"]);
  assert.deepEqual([...ROOM_TURN_RECOVERY_STEP_NAMES].every((step) => (ROOM_TURN_STEP_NAMES as readonly string[]).includes(step)), true);
});

test("an image in memory crosses as base64 text of exactly its bytes", async () => {
  const backing = new Uint8Array([9, 9, 0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 9]);
  const bytes = backing.subarray(2, 9);
  let image: unknown;
  const { router, handle } = await routed(fakeAdapter(async (_handle, request) => {
    image = request.attachments?.[0]?.image;
    return REPLY;
  }));
  await router.runRoomTurn(handle, {
    ...REQUEST,
    attachments: [{ index: 1, fileName: "a.png", mimeType: "image/png", sizeBytes: bytes.length, status: "image", image: { mimeType: "image/png", data: bytes } }],
  } as never);
  assert.deepEqual(image, { mimeType: "image/png", base64: Buffer.from(bytes).toString("base64") });
  assert.deepEqual(Buffer.from((image as { base64: string }).base64, "base64"), Buffer.from(bytes));
});

test("the boundary takes no bytes object, and checks the image limits in bytes of the image", async () => {
  let runs = 0;
  const boundary = new ProviderRuntimeBoundary("cursor", fakeAdapter(async () => { runs += 1; return REPLY; }));
  const runtime = await boundary.spawn({ ...SPAWN });
  const turn = (attachments: unknown[]) => boundary.runRoomTurn(runtime.ref, { ...REQUEST, attachments } as ProviderRoomTurnRequest, { operationId: `op-${runs}-${Math.random()}`, steps: [] });
  const image = (bytes: number, extra: Record<string, unknown> = {}) => ({
    index: 1, fileName: "a.png", mimeType: "image/png", sizeBytes: bytes, status: "image",
    image: { mimeType: "image/png", base64: Buffer.alloc(bytes, 7).toString("base64") }, ...extra,
  });
  const secret = Buffer.from("not-for-any-log").toString("base64");

  await assert.rejects(turn([{ ...image(4), image: { mimeType: "image/png", data: new Uint8Array([1]) } }]), ProviderBoundaryValueError, "a Uint8Array is not plain data");
  await assert.rejects(turn([{ ...image(4), image: { mimeType: "image/png", base64: `${secret}!` } }]), (error: Error) =>
    error instanceof ProviderBoundaryValueError && !error.message.includes(secret) && /attachments\.0\.image: the image is not base64 text/.test(error.message));
  await assert.rejects(turn([image(ROOM_TURN_IMAGE_MAX_BYTES + 1)]), /larger than the limit of one image/);
  const half = Math.floor(ROOM_TURN_IMAGES_MAX_TOTAL_BYTES / 2);
  await assert.rejects(turn([image(half), image(half), image(10)]), /attachments\.2\.image: the images are larger than the limit of a turn/);
  const origin = { origin: { messageId: "m", sender: "s", inThread: false } };
  await assert.rejects(turn(Array.from({ length: ROOM_TURN_RECENT_IMAGE_LIMIT + 1 }, () => image(4, origin))), /more images from recent messages/);
  await assert.rejects(turn([{ ...image(4), image: { mimeType: "image/png", base64: Buffer.alloc(4).toString("base64"), path: "/tmp/a.png" } }]), /base64 text or a file, not both/);
  assert.equal(runs, 0, "a refused request reaches no adapter");

  // The decoded size counts, not the length of the text: an image at the limit is taken.
  assert.deepEqual(await turn([image(ROOM_TURN_IMAGE_MAX_BYTES)]), REPLY);
  assert.deepEqual(await turn([{ ...image(4), image: { mimeType: "image/png", path: "/tmp/a.png" } }]), REPLY);
  assert.equal(runs, 2);
});

test("a result that is not the contract's shape is refused", async () => {
  const boundary = new ProviderRuntimeBoundary("cursor", fakeAdapter(async () => ({ turnId: "t", outcome: "reply", text: null }) as never));
  const runtime = await boundary.spawn({ ...SPAWN });
  await assert.rejects(boundary.runRoomTurn(runtime.ref, REQUEST, { operationId: "op-1", steps: [] }), ProviderBoundaryValueError);
});

test("a step that the options do not name is not offered; an unknown step name is refused", async () => {
  const boundary = new ProviderRuntimeBoundary("cursor", fakeAdapter(async () => REPLY));
  const events: ProviderEventEnvelope[] = [];
  boundary.connectEventSink((event) => { events.push(event); });
  const runtime = await boundary.spawn({ ...SPAWN });
  await assert.rejects(boundary.runRoomTurn(runtime.ref, REQUEST, { operationId: "op-1", steps: ["assert_current" as never] }), ProviderBoundaryValueError);
  await assert.rejects(boundary.recoverRoomTurn(runtime.ref, { inboxItemId: "i", providerTurnId: "t" }, { operationId: "op-2", steps: ["before_native_dispatch" as never] }), ProviderBoundaryValueError);
  assert.equal(events.filter((event) => event.kind === "step").length, 0);
  assert.ok(new ProviderStepRefusedError("x") instanceof Error);
});
