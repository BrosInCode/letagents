import assert from "node:assert/strict";
import test from "node:test";

import { NativeActivityPublicationCoordinator } from "../native-activity-publication-coordinator.js";
import type { DaemonManifestEntry } from "../types.js";

const HANDOFF_ERROR = "Provider is running; waiting for desktop credential handoff.";
const binding = {
  entry_id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1", execution_generation_id: "gen-1",
  agent_session_id: "session-1", api_url: "https://letagents.test",
};

function blocked(): DaemonManifestEntry {
  return {
    id: "agent-1", room_id: "room-1", work_attempt_id: "attempt-1", desired_state: "running",
    observed_state: "recovering", condition: "coordination_blocked", last_error: HANDOFF_ERROR,
    provider_ref: { execution_generation_id: "gen-1" }, ready_reached_at: null,
  } as unknown as DaemonManifestEntry;
}

function build(runUpdate: (update: (entry: DaemonManifestEntry) => DaemonManifestEntry) => void) {
  const options: unknown[] = [];
  let deliveries = 0;
  const coordinator = new NativeActivityPublicationCoordinator({
    bindings: {
      get: async () => binding,
      credentialFor: async () => "bearer",
      publish: async (_entryId: string, _ms: number, send: (input: unknown) => Promise<{ accepted: boolean }>) => {
        const result = await send({ binding, sequence: 1, observed_at: "2026-10-19T00:00:00.000Z" });
        return { ...result, observed_at: "2026-10-19T00:00:00.000Z" };
      },
    } as never,
    updateEntry: async (_id, update, option) => { options.push(option); runUpdate(update); return blocked(); },
    startDelivery: async () => { deliveries += 1; },
  });
  return { coordinator, options, deliveries: () => deliveries };
}

test("the publish path declares that its update reads no activity", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ accepted: true })));
  const { coordinator, options } = build(() => {});
  assert.equal(await coordinator.publish("agent-1", "native_harness.heartbeat", "working"), true);
  assert.deepEqual(options, [{ readsNoActivity: true }]);
});

test("a second run of the update that changes nothing does not start delivery", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ accepted: true })));
  const notBlocked = { ...blocked(), condition: "none", last_error: null } as DaemonManifestEntry;
  const { coordinator, deliveries } = build((update) => {
    assert.notEqual(update(blocked()), blocked(), "the first run recovers the handoff");
    assert.equal(update(notBlocked), notBlocked, "the second run changes nothing");
  });
  await coordinator.publish("agent-1", "native_harness.heartbeat", "working");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveries(), 0);
});

test("a run that recovers the handoff starts delivery", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ accepted: true })));
  const { coordinator, deliveries } = build((update) => { update(blocked()); });
  await coordinator.publish("agent-1", "native_harness.heartbeat", "working");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveries(), 1);
});

const HEARTBEAT_MS = 15_000;
const LOCAL_ROOM_API = "letagents-local://rooms";

/** A coordinator with a clock, a publication journal and a room server that the test controls. */
function room(options: { apiUrl?: string } = {}) {
  const clock = { now: Date.parse("2026-11-20T10:00:00.000Z") };
  const startedAt = clock.now;
  const state = {
    binding: { ...binding, api_url: options.apiUrl ?? binding.api_url },
    entry: { ...blocked(), observed_state: "idle", condition: "none", last_error: null } as DaemonManifestEntry,
    /** What the room server does with a publication. */
    server: "accepts" as "accepts" | "refuses" | "unreachable",
  };
  /** The publications that reached the room server, with the second they were sent in. */
  const sent: Array<{ at: number; method: string; status: "working" | "idle"; summary: string | null }> = [];
  let reservations = 0;
  let deliveries = 0;
  let timers: Array<{ at: number; run: () => void }> = [];
  const coordinator = new NativeActivityPublicationCoordinator({
    bindings: {
      get: async () => state.binding,
      credentialFor: async () => "bearer",
      publish: async (_entryId: string, _ms: number, send: (input: unknown) => Promise<{ accepted: boolean }>) => {
        reservations += 1;
        const reserved = { sequence: reservations, observed_at: new Date(clock.now).toISOString() };
        return { ...await send({ binding: state.binding, ...reserved }), ...reserved };
      },
    } as never,
    updateEntry: async (_id, update) => (state.entry = update(state.entry)),
    startDelivery: async () => { deliveries += 1; },
    publishWorkerActivity: async (input) => {
      if (state.server === "unreachable") throw new TypeError("fetch failed");
      sent.push({ at: (clock.now - startedAt) / 1_000, method: input.method, status: input.status, summary: input.activitySummary ?? null });
      return state.server === "accepts";
    },
  }, {
    heartbeatIntervalMs: HEARTBEAT_MS,
    nowMs: () => clock.now,
    setTimeout: ((run: () => void, delayMs: number) => {
      const timer = { at: clock.now + delayMs, run };
      timers.push(timer);
      return timer;
    }) as never,
    clearTimeout: ((timer: unknown) => { timers = timers.filter((candidate) => candidate !== timer); }) as never,
  });
  /** Move the clock, and let the activity-line timers that came due run to their end. */
  const advance = async (ms: number) => {
    clock.now += ms;
    const due = timers.filter((timer) => timer.at <= clock.now);
    timers = timers.filter((timer) => timer.at > clock.now);
    for (const timer of due) timer.run();
    if (due.length) await new Promise((resolve) => setImmediate(resolve));
  };
  const heartbeat = (status: "working" | "idle" = "idle") => coordinator.publishIfDue("agent-1", "native_harness.heartbeat", status);
  return { clock, state, sent, coordinator, advance, heartbeat, reservations: () => reservations, deliveries: () => deliveries };
}

test("the first publication for a binding is sent; the same status is not sent again before it is due", async () => {
  const r = room();
  assert.equal(await r.heartbeat(), true);
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat(), false);
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat(), false);
  assert.deepEqual(r.sent, [{ at: 0, method: "native_harness.heartbeat", status: "idle", summary: null }]);
  assert.equal(r.reservations(), 1, "a publication that is not sent reserves no sequence in the journal");
});

test("a status that the room does not have is sent at once", async () => {
  const r = room();
  await r.heartbeat("idle");
  await r.advance(1_000);
  assert.equal(await r.coordinator.publishIfDue("agent-1", "item/started", "working"), true);
  await r.advance(1_000);
  assert.equal(await r.coordinator.publishIfDue("agent-1", "item/updated", "working"), false);
  await r.advance(1_000);
  assert.equal(await r.coordinator.publishIfDue("agent-1", "turn/completed", "idle"), true);
  assert.deepEqual(r.sent.map(({ at, method, status }) => [at, method, status]), [
    [0, "native_harness.heartbeat", "idle"], [1, "item/started", "working"], [3, "turn/completed", "idle"],
  ]);
});

test("a status that the room has is sent again when it is two and a half heartbeats old", async () => {
  const r = room();
  await r.heartbeat();
  await r.advance(37_499);
  assert.equal(await r.heartbeat(), false);
  await r.advance(1);
  assert.equal(await r.heartbeat(), true);
  // A clock that was set back must not hold the refresh off for as long as it was set back.
  await r.advance(-3_600_000);
  assert.equal(await r.heartbeat(), true);
});

test("five idle minutes of heartbeats are 7 publications; every one of the 20 was sent before", async () => {
  const gated = room();
  const always = room();
  for (let tick = 0; tick < 20; tick += 1) {
    await gated.heartbeat();
    await always.coordinator.publish("agent-1", "native_harness.heartbeat", "idle");
    await gated.advance(HEARTBEAT_MS);
    await always.advance(HEARTBEAT_MS);
  }
  assert.equal(always.sent.length, 20);
  assert.deepEqual(gated.sent.map((publication) => publication.at), [0, 45, 90, 135, 180, 225, 270]);
  assert.equal(gated.reservations(), 7);
});

test("a minute of working events is one publication for the change and one refresh", async () => {
  const r = room();
  await r.heartbeat("idle");
  // Ten provider events each second, and the heartbeat every 15 seconds.
  for (let event = 1; event <= 600; event += 1) {
    await r.advance(100);
    await r.coordinator.publishIfDue("agent-1", "item/agentMessage/delta", "working", new Date(r.clock.now).toISOString());
    if (event % 150 === 0) await r.heartbeat("working");
  }
  assert.deepEqual(r.sent.map(({ at, method, status }) => [at, method, status]), [
    [0, "native_harness.heartbeat", "idle"],
    [0.1, "item/agentMessage/delta", "working"],
    [37.6, "item/agentMessage/delta", "working"],
  ]);
  assert.equal(r.reservations(), 3, "604 before");
});

test("a publication that fails is made again by the next call", async () => {
  const r = room();
  r.state.server = "unreachable";
  await assert.rejects(r.heartbeat(), /fetch failed/);
  r.state.server = "accepts";
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat(), true, "nothing was accepted yet");
  // A refresh that fails is made again by the next heartbeat, and then the count starts again.
  await r.advance(3 * HEARTBEAT_MS);
  r.state.server = "unreachable";
  await assert.rejects(r.heartbeat(), /fetch failed/);
  r.state.server = "accepts";
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat(), true);
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat(), false);
  assert.deepEqual(r.sent.map((publication) => publication.at), [15, 75]);
});

test("after a failed publication nothing is known about the room's copy", async () => {
  const r = room();
  await r.heartbeat("idle");
  // The request may have reached the server before the connection broke: the room may show the agent as working.
  r.state.server = "unreachable";
  await r.advance(1_000);
  await assert.rejects(r.coordinator.publish("agent-1", "native_harness.activity_summary", "working"), /fetch failed/);
  r.state.server = "accepts";
  await r.advance(1_000);
  assert.equal(await r.heartbeat("idle"), true, "the idle status is sent again, although it was the last one accepted");
});

test("a publication that the room server refuses is not counted as known there", async () => {
  const r = room();
  r.state.server = "refuses";
  await assert.rejects(r.heartbeat(), /rejected a stale daemon observation/);
  r.state.server = "accepts";
  assert.equal(await r.heartbeat(), true);
  assert.equal(r.sent.length, 2);
});

test("a new binding has told the room nothing yet", async () => {
  const r = room();
  await r.heartbeat();
  for (const change of [{ agent_session_id: "session-2" }, { execution_generation_id: "gen-2" }, { room_id: "room-2" }]) {
    r.state.binding = { ...r.state.binding, ...change };
    assert.equal(await r.heartbeat(), true, `${Object.keys(change)[0]} changed`);
    assert.equal(await r.heartbeat(), false);
  }
  assert.equal(r.sent.length, 4);
});

test("publications that end out of order leave the newest one as the room's copy", async () => {
  const r = room();
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const ports = (r.coordinator as unknown as { ports: { publishWorkerActivity: (input: { sequence: number }) => Promise<boolean> } }).ports;
  const send = ports.publishWorkerActivity;
  ports.publishWorkerActivity = async (input) => {
    if (input.sequence === 1) await firstHeld;
    return send(input);
  };
  const first = r.coordinator.publish("agent-1", "native_harness.heartbeat", "idle");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await r.coordinator.publish("agent-1", "item/started", "working"), true);
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(await r.heartbeat("working"), false, "the room has the working status of sequence 2");
  assert.equal(await r.heartbeat("idle"), true);
});

test("an entry that waits for its credential handoff is recovered by publish, which always sends", async () => {
  const r = room();
  assert.equal(await r.coordinator.publish("agent-1", "native_harness.bound", "working"), true);
  r.state.entry = blocked();
  await r.advance(HEARTBEAT_MS);
  // The gated entry point is not for this entry: the room has the status, so nothing would be sent or recovered.
  assert.equal(await r.heartbeat("working"), false);
  assert.equal(r.state.entry.condition, "coordination_blocked");
  assert.equal(await r.coordinator.publish("agent-1", "native_harness.heartbeat", "working"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.state.entry.condition, "none");
  assert.equal(r.state.entry.observed_state, "working");
  assert.equal(r.state.entry.last_error, null);
  assert.equal(r.deliveries(), 1);
  assert.equal(r.sent.length, 2);
});

test("an activity line that the room does not have makes a working publication due", async () => {
  const r = room();
  let permitted: "working" | null = "working";
  r.coordinator.observeActivitySummary("agent-1", "Reading files", () => permitted);
  await r.advance(0);
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat("working"), false, "the room has this status and this line");
  // A changed line that could not be published at its time, because the agent's bearer was being rotated.
  permitted = null;
  r.coordinator.observeActivitySummary("agent-1", "Running tests", () => permitted);
  await r.advance(0);
  assert.equal(r.sent.length, 1);
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat("working"), true, "the next heartbeat carries the line that waits");
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat("working"), false);
  assert.deepEqual(r.sent.map(({ at, method, summary }) => [at, method, summary]), [
    [0, "native_harness.activity_summary", "Reading files"],
    [30, "native_harness.heartbeat", "Running tests"],
  ]);
});

test("an idle heartbeat that is not sent still clears a line that waits", async () => {
  const r = room();
  await r.heartbeat("idle");
  r.coordinator.observeActivitySummary("agent-1", "Reading files", () => null);
  await r.advance(0);
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat("idle"), false);
  await r.advance(HEARTBEAT_MS);
  assert.equal(await r.heartbeat("working"), true);
  assert.equal(r.sent.at(-1)!.summary, null, "the next turn does not start with the line of the last one");
});

test("a local room gets every publication, as before", async () => {
  const r = room({ apiUrl: LOCAL_ROOM_API });
  for (let tick = 0; tick < 4; tick += 1) {
    assert.equal(await r.heartbeat(), true);
    await r.advance(HEARTBEAT_MS);
  }
  assert.deepEqual(r.sent.map((publication) => publication.at), [0, 15, 30, 45]);
});
