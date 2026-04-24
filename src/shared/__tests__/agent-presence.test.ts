import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_AGENT_DELIVERY_WINDOW_MS,
  ACTIVE_AGENT_PRESENCE_WINDOW_MS,
  getAgentPresenceFreshness,
  isAgentDeliverySessionReachable,
  normalizeAgentPresenceStatus,
} from "../agent-presence.js";

test("normalizeAgentPresenceStatus accepts known presence states", () => {
  assert.equal(normalizeAgentPresenceStatus("idle"), "idle");
  assert.equal(normalizeAgentPresenceStatus(" working "), "working");
  assert.equal(normalizeAgentPresenceStatus("REVIEWING"), "reviewing");
  assert.equal(normalizeAgentPresenceStatus("blocked"), "blocked");
});

test("normalizeAgentPresenceStatus rejects unknown values", () => {
  assert.equal(normalizeAgentPresenceStatus("sleeping"), null);
  assert.equal(normalizeAgentPresenceStatus(""), null);
  assert.equal(normalizeAgentPresenceStatus(null), null);
});

test("getAgentPresenceFreshness reports recent heartbeats as active", () => {
  const now = Date.parse("2026-04-07T21:00:00.000Z");
  const heartbeatAt = new Date(now - ACTIVE_AGENT_PRESENCE_WINDOW_MS + 1000).toISOString();

  assert.equal(getAgentPresenceFreshness(heartbeatAt, now), "active");
});

test("getAgentPresenceFreshness reports old or invalid heartbeats as stale", () => {
  const now = Date.parse("2026-04-07T21:00:00.000Z");
  const heartbeatAt = new Date(now - ACTIVE_AGENT_PRESENCE_WINDOW_MS - 1000).toISOString();

  assert.equal(getAgentPresenceFreshness(heartbeatAt, now), "stale");
  assert.equal(getAgentPresenceFreshness("not-a-date", now), "stale");
});

test("isAgentDeliverySessionReachable requires an active and fresh delivery heartbeat", () => {
  const now = Date.parse("2026-04-24T05:00:00.000Z");
  const freshHeartbeat = new Date(now - ACTIVE_AGENT_DELIVERY_WINDOW_MS + 1000).toISOString();
  const staleHeartbeat = new Date(now - ACTIVE_AGENT_DELIVERY_WINDOW_MS - 1000).toISOString();

  assert.equal(
    isAgentDeliverySessionReachable({
      activeConnectionCount: 1,
      updatedAt: freshHeartbeat,
    }, now),
    true
  );
  assert.equal(
    isAgentDeliverySessionReachable({
      activeConnectionCount: 0,
      updatedAt: freshHeartbeat,
    }, now),
    false
  );
  assert.equal(
    isAgentDeliverySessionReachable({
      activeConnectionCount: 1,
      updatedAt: staleHeartbeat,
    }, now),
    false
  );
});
