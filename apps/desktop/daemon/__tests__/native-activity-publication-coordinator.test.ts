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
