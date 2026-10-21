import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SupervisedAgentDelivery } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import {
  agent,
  currentAuthority,
  TEST_PROVIDER_TURN_AUTHORITY,
  provider,
  deferred,
  waitFor,
  waitForAsync,
  enqueue,
  ingest,
} from "./helpers/supervised-agent-delivery-fixture.js";

for (const phase of ["preflight", "admitted"] as const) {
  test(`duplicate same-owner start preserves Codex ${phase} and publishes exactly once`, async () => {
    const root = await mkdtemp(join(tmpdir(), "letagents-delivery-duplicate-start-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    const release = deferred<void>();
    let calls = 0; let recovered = 0; let published = 0; let normalizations = 0; let entered = false;
    let turnSignal: AbortSignal | undefined;
    const normalize = store.normalizeStartupRecovery.bind(store);
    store.normalizeStartupRecovery = async (...args) => { normalizations += 1; return normalize(...args); };
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      calls += 1;
      turnSignal = options?.detachSignal;
      if (phase === "admitted") {
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("turn:one");
      }
      entered = true;
      await Promise.race([release.promise, new Promise<void>(resolve => {
        options?.detachSignal?.addEventListener("abort", () => resolve(), { once: true });
      })]);
      if (options?.detachSignal?.aborted) throw new Error("delivery detached during preflight");
      if (phase === "preflight") {
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("turn:one");
      }
      return { turnId: "turn:one", outcome: "reply", text: "Ready." };
    }, async () => { recovered += 1; return { turnId: "turn:one", outcome: "unreadable", text: null }; }), {
      poll: ({ signal }) => new Promise(resolve => {
        if (signal.aborted) resolve({});
        else signal.addEventListener("abort", () => resolve({}), { once: true });
      }),
      publish: async input => { published += 1; return { messageId: "reply:one", roomId: input.roomId }; },
    }, currentAuthority);
    try {
      await ingest(store);
      await delivery.start(agent);
      await waitFor(() => entered);
      const duplicate = delivery.refresh({ ...agent });
      await Promise.race([duplicate, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("duplicate start did not settle")), 1000))]);
      await delivery.refresh({ ...agent });
      assert.equal(turnSignal?.aborted, false, "duplicate readiness must not detach the existing turn");
      assert.equal(normalizations, 1, "a live owner must not be mistaken for crash recovery");
      release.resolve();
      await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged");
      assert.equal(calls, 1); assert.equal(recovered, 0); assert.equal(published, 1);
    } finally {
      release.resolve(); await delivery.fenceAndDrain(); await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("refresh still replaces changed ownership, including provider-less lanes, but adopts a rotated bearer in place", async (t) => {
  for (const coordinate of ["handle", "agentSessionId", "executionGenerationId", "daemonGeneration", "bearer", "no-provider-api", "no-provider-workspace"] as const) {
    await t.test(coordinate, async () => {
      const root = await mkdtemp(join(tmpdir(), "letagents-delivery-owner-change-"));
      const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
      const original = { ...agent, handle: coordinate.startsWith("no-provider") ? null : agent.handle };
      const pollSignals: AbortSignal[] = [];
      const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("no work queued"); }), {
        poll: ({ signal }) => new Promise(resolve => {
          pollSignals.push(signal);
          if (signal.aborted) resolve({});
          else signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async () => { throw new Error("no reply expected"); },
      }, currentAuthority);
      try {
        await delivery.start(original);
        await waitFor(() => pollSignals.length === 1);
        if (coordinate === "handle") original.handle = { ...agent.handle };
        if (coordinate === "agentSessionId") original.agentSessionId = "new-worker";
        if (coordinate === "executionGenerationId") original.executionGenerationId = "new-execution";
        if (coordinate === "daemonGeneration") original.daemonGeneration = 2;
        if (coordinate === "bearer") original.bearer = "rotated-memory-only-token";
        if (coordinate === "no-provider-api") original.apiUrl = "https://other.letagents.test";
        if (coordinate === "no-provider-workspace") original.workAttemptId = "new-attempt";
        await delivery.refresh(original);
        if (coordinate === "bearer") {
          // Same worker session, new memory-only bearer: the lane is kept.
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(pollSignals.length, 1, "a rotated bearer of the same session keeps the registered lane");
          assert.equal(pollSignals[0]?.aborted, false);
          await delivery.refresh({ ...original });
          assert.equal(pollSignals.length, 1, "the rotated owner is idempotent too");
          return;
        }
        await waitFor(() => pollSignals.length === 2);
        assert.equal(pollSignals[0]?.aborted, true, "changed owner must retire the registered lane");
        assert.equal(pollSignals[1]?.aborted, false);
        await delivery.refresh({ ...original });
        assert.equal(pollSignals.length, 2, "the new exact owner is idempotent too");
      } finally {
        await delivery.fenceAndDrain(); await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a same-session bearer rotation keeps the in-flight turn, its approvals and the pump; a new session still tears down", async (t) => {
  for (const change of ["rotation", "new-session", "stale-bearer"] as const) {
    await t.test(change, async () => {
      const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rotation-"));
      const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
      let currentBearer = "bearer-before";
      let authorityGate: Promise<void> = Promise.resolve();
      const entered = deferred<void>();
      const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
      let detachSignal: AbortSignal | undefined;
      const publishedWith: string[] = [];
      const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
        await options?.beforeNativeDispatch?.();
        await options?.checkpointTurnStarted?.("turn:rotation");
        detachSignal = options?.detachSignal;
        entered.resolve();
        return release.promise;
      }), {
        poll: ({ signal }) => new Promise((resolve) => {
          if (signal.aborted) resolve({});
          else signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async (input) => {
          publishedWith.push(input.bearer);
          return { messageId: "reply:rotation", roomId: input.roomId };
        },
      }, async (authority) => { await authorityGate; return authority.bearer === currentBearer; });
      const before = { ...agent, bearer: "bearer-before" };
      try {
        await ingest(store);
        await delivery.start(before);
        await entered.promise;
        const successor = change === "rotation"
          ? { ...agent, bearer: "bearer-after" }
          : change === "stale-bearer"
            // Same session, but not the bearer the binding now holds.
            ? { ...agent, bearer: "bearer-stale" }
            : { ...agent, agentSessionId: "session-2", bearer: "bearer-after" };
        currentBearer = "bearer-after";
        const gate = deferred<void>();
        authorityGate = gate.promise;
        const refreshed = delivery.refresh(successor);
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (change === "rotation") {
          assert.equal(delivery.activeTurn(successor)?.inboxItemId !== undefined, true,
            "an approval arriving during the rotation still matches the bounded turn");
        }
        gate.resolve();
        authorityGate = Promise.resolve();
        await refreshed;
        if (change !== "rotation") {
          assert.equal(detachSignal?.aborted, true, change === "new-session"
            ? "a different worker session still replaces the lane"
            : "a bearer the binding no longer holds is never adopted");
          return;
        }
        assert.equal(detachSignal?.aborted, false, "rotation never detaches the in-flight provider turn");
        assert.ok(delivery.activeTurn(successor), "the active turn survives for approvals and bounded effects");
        assert.notEqual((await store.ingressHealth(agent.agentId))?.state, "stopped");
        release.resolve({ turnId: "turn:rotation", outcome: "reply", text: "Done." });
        await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged");
        assert.deepEqual(publishedWith, ["bearer-after"], "the live turn publishes with the rotated bearer");
        const timeline = (await store.receipts(agent.agentId))[0]!.timeline;
        assert.equal(timeline.filter((event) => event.phase === "queued").length, 1,
          "no restart recovery was written onto the in-flight row");
        assert.equal(timeline.some((event) => /restarted/i.test(event.detail ?? "")), false);
      } finally {
        authorityGate = Promise.resolve();
        release.resolve({ turnId: "turn:rotation", outcome: "reply", text: "cleanup" });
        await delivery.fenceAndDrain(); await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a turn that ends before delivery adopts a rotated bearer is recovered instead of stranding the FIFO", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rotation-window-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let currentBearer = "bearer-before";
  const entered = deferred<void>();
  const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
  const publishedWith: string[] = [];
  let recovers = 0;
  let runError = "";
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn:rotation");
    entered.resolve();
    const raw = await release.promise;
    try { return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw; }
    catch (error) { runError = String(error); throw error; }
  }, async (_handle, _request, options) => {
    recovers += 1;
    const raw = { turnId: "turn:rotation", outcome: "reply" as const, text: "Done." };
    return (await options?.checkpointTerminalResult?.(raw))?.acceptedResult ?? raw;
  }), {
    poll: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) resolve({});
      else signal.addEventListener("abort", () => resolve({}), { once: true });
    }),
    publish: async (input) => {
      publishedWith.push(input.bearer);
      return { messageId: "reply:rotation", roomId: input.roomId };
    },
  }, async (authority) => authority.bearer === currentBearer);
  try {
    await ingest(store);
    await delivery.start({ ...agent, bearer: "bearer-before" });
    await entered.promise;
    // The binding rotates before delivery hears of it, and the turn ends then.
    currentBearer = "bearer-after";
    release.resolve({ turnId: "turn:rotation", outcome: "reply", text: "Done." });
    await waitFor(() => runError !== "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "dispatching",
      "the revoked bearer could not record the result, so the row has no owner");
    await delivery.refresh({ ...agent, bearer: "bearer-after" });
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged", 3_000);
    assert.deepEqual(publishedWith, ["bearer-after"]);
    assert.equal(recovers, 1, "the saved turn is re-read once and never rerun");
  } finally {
    release.resolve({ turnId: "turn:rotation", outcome: "reply", text: "cleanup" });
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an older rotation that finishes its authority check last cannot replace a newer adopted bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rotation-order-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const entered = deferred<void>();
  const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
  const firstCheck = deferred<void>();
  let detachSignal: AbortSignal | undefined;
  const publishedWith: string[] = [];
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("turn:rotation-order");
    detachSignal = options?.detachSignal;
    entered.resolve();
    return release.promise;
  }), {
    poll: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) resolve({});
      else signal.addEventListener("abort", () => resolve({}), { once: true });
    }),
    publish: async (input) => {
      publishedWith.push(input.bearer);
      return { messageId: "reply:rotation-order", roomId: input.roomId };
    },
  }, async (authority) => {
    // The first rotation's check passed before the second rotation landed.
    if (authority.bearer === "bearer-1") await firstCheck.promise;
    return ["bearer-before", "bearer-1", "bearer-2"].includes(authority.bearer);
  });
  try {
    await ingest(store);
    await delivery.start({ ...agent, bearer: "bearer-before" });
    await entered.promise;
    const older = delivery.refresh({ ...agent, bearer: "bearer-1" });
    await delivery.refresh({ ...agent, bearer: "bearer-2" });
    firstCheck.resolve();
    await older;
    assert.equal(detachSignal?.aborted, false);
    release.resolve({ turnId: "turn:rotation-order", outcome: "reply", text: "Done." });
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged");
    assert.deepEqual(publishedWith, ["bearer-2"], "the newest rotation's bearer stays adopted");
  } finally {
    firstCheck.resolve();
    release.resolve({ turnId: "turn:rotation-order", outcome: "reply", text: "cleanup" });
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stop or ingress pause during a refresh's authority check is not undone by that refresh", async (t) => {
  for (const interruption of ["stop", "pause"] as const) {
    await t.test(interruption, async () => {
      const root = await mkdtemp(join(tmpdir(), "letagents-delivery-refresh-interrupted-"));
      const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
      const pollSignals: AbortSignal[] = [];
      const checking = deferred<void>();
      const gate = deferred<void>();
      const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("no work queued"); }), {
        poll: ({ signal }) => new Promise((resolve) => {
          pollSignals.push(signal);
          if (signal.aborted) resolve({});
          else signal.addEventListener("abort", () => resolve({}), { once: true });
        }),
        publish: async () => { throw new Error("no reply expected"); },
      }, async (authority) => {
        if (authority.bearer === "bearer-after") { checking.resolve(); await gate.promise; }
        return true;
      });
      try {
        await delivery.start({ ...agent, bearer: "bearer-before" });
        await waitFor(() => pollSignals.length === 1);
        const refreshed = delivery.refresh({ ...agent, bearer: "bearer-after" });
        await checking.promise;
        const interrupted = interruption === "stop" ? delivery.stop(agent.agentId) : delivery.pauseIngress(agent.agentId);
        gate.resolve();
        await refreshed; await interrupted;
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(pollSignals.length, 1, `the ${interruption} owns the lane; the stale refresh must not restart it`);
        assert.equal(pollSignals[0]?.aborted, true);
      } finally {
        gate.resolve();
        await delivery.fenceAndDrain(); await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a task ownership lookup revoked by a same-session rotation is retried with the adopted bearer", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rotation-lookup-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  let currentBearer = "bearer-before";
  let runs = 0;
  let completed = false;
  const lookups: string[] = [];
  const lookupInFlight = deferred<void>();
  const rotated = deferred<void>();
  const task = { id: "task_1", title: "Finish the existing change", leaseId: "lease-1", epoch: 0 };
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs += 1;
    await options?.beforeNativeDispatch?.();
    const turnId = `turn-${runs}`;
    await options?.checkpointTurnStarted?.(turnId);
    if (runs === 1) {
      return { turnId, providerContinuationId: "thread", outcome: "failed", text: null,
        evidence: "stream", error: "HTTP 503 Service Unavailable" };
    }
    completed = true;
    return { turnId, outcome: "reply", text: "The remaining work is finished." };
  }), {
    poll: ({ signal }) => new Promise((resolve) => {
      if (signal.aborted) resolve({});
      else signal.addEventListener("abort", () => resolve({}), { once: true });
    }),
    ownedTasks: async (input) => {
      lookups.push(input.bearer);
      if (input.bearer === "bearer-before") {
        lookupInFlight.resolve();
        await rotated.promise;
        throw new Error("HTTP 401 Unauthorized");
      }
      return completed ? [] : [task];
    },
    publish: async () => ({ roomId: agent.roomId, messageId: "msg_2" }),
  }, async (authority) => authority.bearer === currentBearer, 0, async () => {});
  try {
    await ingest(store);
    await delivery.start({ ...agent, bearer: "bearer-before" });
    await lookupInFlight.promise;
    currentBearer = "bearer-after";
    await delivery.refresh({ ...agent, bearer: "bearer-after" });
    rotated.resolve();
    await waitFor(() => completed, 3_000);
    assert.equal(runs, 2, "the unfinished task continues after the rotation");
    assert.deepEqual(lookups.slice(0, 2), ["bearer-before", "bearer-after"]);
    assert.equal((await store.receipts(agent.agentId)).some((receipt) => receipt.state === "blocked"), false);
  } finally {
    rotated.resolve();
    await delivery.fenceAndDrain(); await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rebind waits for an old provider turn, recovers its interrupted FIFO head, then processes it and the next item", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-rebind-drain-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const entered = deferred<void>(); const release = deferred<{ turnId: string; outcome: "reply"; text: string }>();
    let turns = 0; let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      turns += 1;
      if (turns === 1) { entered.resolve(); return release.promise; }
      return { turnId: `turn:${turns}`, outcome: "no_reply", text: null };
    }), {
      poll: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })),
      publish: async (input) => { published += 1; return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority);
    await delivery.pump(agent);
    await ingest(store, "1"); await ingest(store, "2");
    const oldPump = delivery.pump(agent); await entered.promise;
    const successor = {
      ...agent,
      bearer: "rotated-memory-only-token",
      executionGenerationId: "generation-2",
      handle: { ...agent.handle, pid: 2 },
    };
    let refreshed = false;
    const refresh = delivery.refresh(successor).then(() => { refreshed = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(refreshed, false, "successor must not overlap the old non-abortable provider turn");
    release.resolve({ turnId: "turn:1", outcome: "reply", text: "late" });
    await refresh; await oldPump;
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "blocked");
    assert.equal(published, 0, "the stale provider reply is never published");
    await delivery.retry(successor, "1");
    await waitForAsync(async () => (await store.receipts(agent.agentId)).every((item) => item.state === "acknowledged_no_reply"));
    assert.equal(turns, 3, "the explicit recovery processes the blocked head before the next FIFO item");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh fences a poll paused in ingest and lets the successor recover before its first hanging poll", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-ingest-rebind-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const ingestEntered = deferred<void>(); const releaseIngest = deferred<void>(); const successorPoll = deferred<void>();
    const ingest = store.ingestSuccessfulPoll.bind(store);
    (store as unknown as { ingestSuccessfulPoll(input: Parameters<typeof store.ingestSuccessfulPoll>[0]): ReturnType<typeof store.ingestSuccessfulPoll> }).ingestSuccessfulPoll = async (input) => {
      ingestEntered.resolve(); await releaseIngest.promise; return ingest(input);
    };
    let polls = 0; let turns = 0; const turnHandles: unknown[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (handle) => {
      turns += 1;
      turnHandles.push(handle);
      return { turnId: `turn:${turns}`, outcome: "no_reply", text: null };
    }), {
      poll: ({ signal }) => {
        polls += 1;
        if (polls === 1) return Promise.resolve({ messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] });
        successorPoll.resolve();
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
      },
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority);
    await delivery.start(agent); await ingestEntered.promise;
    const successor = { ...agent, executionGenerationId: "generation-2", handle: { ...agent.handle, pid: 2 } };
    let refreshed = false;
    const refresh = delivery.refresh(successor).then(() => { refreshed = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(refreshed, false, "refresh waits for the old poll's ingest commit");
    releaseIngest.resolve();
    await refresh; await successorPoll.promise;
    await waitForAsync(async () => (await store.receipts(agent.agentId))[0]?.state === "acknowledged_no_reply");
    assert.equal(turns, 1, "the stopped poll cannot launch a stale delivery pump after ingest");
    assert.equal(turnHandles[0], successor.handle, "only the successor context may run the recovered delivery turn");
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply", "successor recovery and delivery finish independently of its hanging poll");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh joins a start paused in its health write before installing the successor loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-start-health-"));
  const releaseStarting = deferred<void>();
  let store: SupervisedAgentInboxStore | undefined;
  let delivery: SupervisedAgentDelivery | undefined;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    await ingest(store, "1");
    const startingEntered = deferred<void>();
    const setIngressHealth = store.setIngressHealth.bind(store);
    let startingWrites = 0;
    (store as unknown as { setIngressHealth(input: Parameters<typeof store.setIngressHealth>[0]): ReturnType<typeof store.setIngressHealth> }).setIngressHealth = async (input) => {
      if (input.state === "starting" && startingWrites++ === 0) {
        startingEntered.resolve();
        await releaseStarting.promise;
      }
      return setIngressHealth(input);
    };
    const turnHandles: unknown[] = [];
    delivery = new SupervisedAgentDelivery(store, provider(async (handle) => {
      turnHandles.push(handle);
      return { turnId: `turn:${turnHandles.length}`, outcome: "no_reply", text: null };
    }), {
      poll: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })),
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority);

    const staleStart = delivery.start(agent);
    await startingEntered.promise;
    const internals = delivery as unknown as { loops: Map<string, Promise<void>>; loopEpochs: Map<string, number> };
    assert.equal(internals.loops.has(agent.agentId), true, "the paused startup is registered before its health write settles");
    assert.equal(internals.loopEpochs.get(agent.agentId), 0);

    const successor = { ...agent, executionGenerationId: "generation-successor", handle: { ...agent.handle, pid: 2 } };
    let refreshed = false;
    const refresh = delivery.refresh(successor).then(() => { refreshed = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(refreshed, false, "refresh must drain the registered stale startup before starting its successor");

    releaseStarting.resolve();
    await Promise.all([staleStart, refresh]);
    await waitForAsync(async () => (await store!.receipts(agent.agentId))[0]?.state === "acknowledged_no_reply");
    assert.deepEqual(turnHandles, [successor.handle], "only the successor handle may drain recovered FIFO work");
    assert.equal(internals.loops.has(agent.agentId), true, "the successor remains in its long poll");
    assert.equal(internals.loopEpochs.get(agent.agentId), 1, "the live loop belongs to the successor epoch");
  } finally {
    releaseStarting.resolve();
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("convergence ensure never joins or replaces a mismatched loop and fills the later absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-ensure-loop-"));
  let store: SupervisedAgentInboxStore | undefined;
  let delivery: SupervisedAgentDelivery | undefined;
  try {
    store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const pollBearers: string[] = [];
    const deliveryStarted = deferred<void>();
    const successorStarted = deferred<void>();
    delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: ({ bearer, signal }) => new Promise((resolve) => {
        pollBearers.push(bearer);
        if (pollBearers.length === 1) deliveryStarted.resolve();
        if (pollBearers.length === 2) successorStarted.resolve();
        signal.addEventListener("abort", () => resolve({}), { once: true });
      }),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);

    await delivery.start(agent);
    await deliveryStarted.promise;
    const internals = delivery as unknown as {
      loops: Map<string, Promise<void>>;
      loopEpochs: Map<string, number>;
      loopControllers: Map<string, AbortController>;
      refreshEpochs: Map<string, number>;
    };
    const existingLoop = internals.loops.get(agent.agentId);
    const existingController = internals.loopControllers.get(agent.agentId);
    assert.ok(existingLoop);
    assert.ok(existingController);
    assert.equal(internals.loopEpochs.get(agent.agentId), 0);

    // Model convergence observing an epoch that advanced while the lifecycle
    // owner is still draining the old loop under the same per-entry lock.
    internals.refreshEpochs.set(agent.agentId, 1);
    const successor = { ...agent, bearer: "successor-memory-token", executionGenerationId: "generation-successor" };
    await Promise.race([
      delivery.ensureStarted(successor),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("ensure joined the mismatched loop")), 100)),
    ]);
    assert.equal(internals.loops.get(agent.agentId), existingLoop, "ensure leaves the lifecycle-owned loop in place");
    assert.equal(internals.loopControllers.get(agent.agentId), existingController, "ensure does not replace its controller");
    assert.equal(existingController.signal.aborted, false, "ensure does not abort work owned by another lifecycle path");
    assert.deepEqual(pollBearers, [agent.bearer], "ensure cannot overlap the mismatched loop");

    await delivery.stop(agent.agentId);
    assert.equal(internals.loops.has(agent.agentId), false, "the lifecycle owner completes its own drain");
    await delivery.ensureStarted(successor);
    await successorStarted.promise;
    assert.deepEqual(pollBearers, [agent.bearer, successor.bearer], "a later convergence pass fills the genuine absence");
  } finally {
    await delivery?.fenceAndDrain().catch(() => undefined);
    await store?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent refreshes install only the newest epoch and its handle drains recovered FIFO work", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-refresh-epoch-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const ingestEntered = deferred<void>(); const releaseIngest = deferred<void>(); const currentPoll = deferred<void>();
    const ingest = store.ingestSuccessfulPoll.bind(store);
    (store as unknown as { ingestSuccessfulPoll(input: Parameters<typeof store.ingestSuccessfulPoll>[0]): ReturnType<typeof store.ingestSuccessfulPoll> }).ingestSuccessfulPoll = async (input) => {
      ingestEntered.resolve(); await releaseIngest.promise; return ingest(input);
    };
    let polls = 0; const turnHandles: unknown[] = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (handle) => {
      turnHandles.push(handle);
      return { turnId: `turn:${turnHandles.length}`, outcome: "no_reply", text: null };
    }), {
      poll: ({ signal }) => {
        polls += 1;
        if (polls === 1) return Promise.resolve({ last_observed_message_id: "2", messages: [
          { id: "1", activation: { for_current_agent: { decision: "activate" } } },
          { id: "2", activation: { for_current_agent: { decision: "activate" } } },
        ] });
        currentPoll.resolve();
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }));
      },
      publish: async () => { throw new Error("no-reply must not publish"); },
    }, currentAuthority);
    await delivery.start(agent); await ingestEntered.promise;
    const stale = { ...agent, executionGenerationId: "generation-stale", handle: { ...agent.handle, pid: 2 } };
    const current = { ...agent, executionGenerationId: "generation-current", handle: { ...agent.handle, pid: 3 } };
    const staleRefresh = delivery.refresh(stale);
    const currentRefresh = delivery.refresh(current);
    releaseIngest.resolve();
    await Promise.all([staleRefresh, currentRefresh]); await currentPoll.promise;
    await waitForAsync(async () => (await store.receipts(agent.agentId)).every(item => item.state === "acknowledged_no_reply"));
    assert.deepEqual(turnHandles, [current.handle, current.handle], "the stale refresh cannot own either recovered FIFO turn");
    const internals = delivery as unknown as { loops: Map<string, Promise<void>>; loopEpochs: Map<string, number> };
    assert.equal(internals.loops.has(agent.agentId), true, "the current successor remains in its long poll");
    assert.equal(internals.loopEpochs.get(agent.agentId), 2, "the live loop belongs to the latest refresh epoch");
    assert.equal((await store.receipts(agent.agentId)).every((item) => item.state === "acknowledged_no_reply"), true);
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an external stop invalidates a refresh reservation still waiting on drain", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-stop-epoch-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const ingestEntered = deferred<void>(); const releaseIngest = deferred<void>();
    const ingest = store.ingestSuccessfulPoll.bind(store);
    (store as unknown as { ingestSuccessfulPoll(input: Parameters<typeof store.ingestSuccessfulPoll>[0]): ReturnType<typeof store.ingestSuccessfulPoll> }).ingestSuccessfulPoll = async (input) => {
      ingestEntered.resolve(); await releaseIngest.promise; return ingest(input);
    };
    let polls = 0; let turns = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => {
      turns += 1;
      return { turnId: "unexpected", outcome: "no_reply", text: null };
    }), {
      poll: async () => { polls += 1; return { messages: [{ id: "1", activation: { for_current_agent: { decision: "activate" } } }] }; },
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    await delivery.start(agent); await ingestEntered.promise;
    const refresh = delivery.refresh({ ...agent, executionGenerationId: "generation-successor", handle: { ...agent.handle, pid: 2 } });
    const stop = delivery.stop(agent.agentId);
    releaseIngest.resolve();
    await Promise.all([refresh, stop]);
    const internals = delivery as unknown as { loops: Map<string, Promise<void>> };
    assert.equal(polls, 1);
    assert.equal(turns, 0);
    assert.equal(internals.loops.has(agent.agentId), false);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a credential-only rebind clears recovery ownership for the successor context", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-credential-rebind-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    let normalizations = 0;
    const normalize = store.normalizeStartupRecovery.bind(store);
    store.normalizeStartupRecovery = async (agentId) => {
      normalizations += 1;
      return normalize(agentId);
    };
    const delivery = new SupervisedAgentDelivery(store, provider(async () => ({ turnId: "unused", outcome: "no_reply", text: null })), {
      poll: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true })),
      publish: async () => { throw new Error("must not publish"); },
    }, currentAuthority);
    await delivery.pump(agent);
    await delivery.refresh({ ...agent, bearer: "new-memory-only-token" });
    await waitFor(() => normalizations === 2);
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("startup recovery publishes durable work before a hanging first poll settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-startup-pump-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); const item = await enqueue(store);
    await store.checkpointTurnStarted(item.inbox_item_id, "turn", TEST_PROVIDER_TURN_AUTHORITY);
    await store.transition(item.inbox_item_id, "awaiting_result", { outcome: JSON.stringify({ kind: "reply", text: "durable" }) });
    await store.transition(item.inbox_item_id, "publishing");
    const pollEntered = deferred<void>(); let published = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async () => { throw new Error("provider must not rerun"); }), {
      poll: ({ signal }) => new Promise((resolve) => {
        pollEntered.resolve(); signal.addEventListener("abort", () => resolve({}), { once: true });
      }),
      publish: async (input) => { published += 1; return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId }; },
    }, currentAuthority);
    void delivery.start(agent);
    await waitFor(() => published === 1);
    await pollEntered.promise;
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    await delivery.fenceAndDrain();
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
