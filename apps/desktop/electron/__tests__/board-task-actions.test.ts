import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReviewWorkerActionBody,
  buildWorkerActionPatch,
  buildWorkerSnapshots,
  getCurrentLocalWorkerSession,
  getLocalWorkerSessions,
  localWorkerState,
  type StoredLetAgentsLocalState,
  type StoredLocalAgentSession,
} from "../board-task-actions.js";

const now = Date.parse("2026-05-08T01:00:00.000Z");

function session(overrides: Partial<StoredLocalAgentSession> = {}): StoredLocalAgentSession {
  return {
    session_id: "agent_session_current",
    session_token: "token_current",
    room_id: "github.com/brosincode/letagents",
    session_kind: "worker",
    runtime: "codex",
    actor_label: "CloudEmber | EmmyMay's agent | Agent",
    agent_key: "EmmyMay/cloudember",
    agent_instance_id: "instance_current",
    display_name: "CloudEmber",
    updated_at: "2026-05-08T00:59:15.000Z",
    last_seen_at: "2026-05-08T00:59:15.000Z",
    ...overrides,
  };
}

test("localWorkerState classifies live, away, and offline worker sessions", () => {
  assert.equal(localWorkerState(session({ last_seen_at: "2026-05-08T00:59:15.000Z" }), now), "connected");
  assert.equal(localWorkerState(session({ last_seen_at: "2026-05-08T00:48:00.000Z" }), now), "away");
  assert.equal(localWorkerState(session({ last_seen_at: "2026-05-08T00:40:00.000Z" }), now), "offline");
  assert.equal(localWorkerState(session({ ended_at: "2026-05-08T00:59:30.000Z" }), now), "offline");
});

test("getCurrentLocalWorkerSession prefers the current room session and falls back to freshest live worker", () => {
  const fallback = session({
    session_id: "agent_session_fallback",
    session_token: "token_fallback",
    updated_at: "2026-05-08T00:59:45.000Z",
    last_seen_at: "2026-05-08T00:59:45.000Z",
  });
  const current = session({
    session_id: "agent_session_current",
    session_token: "token_current",
    updated_at: "2026-05-08T00:58:00.000Z",
    last_seen_at: "2026-05-08T00:58:00.000Z",
  });
  const state: StoredLetAgentsLocalState = {
    agent_sessions: {
      [fallback.session_id!]: fallback,
      [current.session_id!]: current,
    },
    current_agent_session_ids: {
      "github.com/BrosInCode/LetAgents": current.session_id!,
    },
  };

  assert.equal(getCurrentLocalWorkerSession(state, "github.com/brosincode/letagents", now)?.session_id, current.session_id);

  const withoutCurrent: StoredLetAgentsLocalState = {
    agent_sessions: state.agent_sessions,
    current_agent_session_ids: {
      "github.com/brosincode/other": current.session_id!,
    },
  };
  assert.equal(getCurrentLocalWorkerSession(withoutCurrent, "github.com/brosincode/letagents", now)?.session_id, fallback.session_id);
});

test("getLocalWorkerSessions filters unusable workers and sorts by freshness", () => {
  const liveOlder = session({ session_id: "older", session_token: "older-token", updated_at: "2026-05-08T00:58:00.000Z" });
  const liveNewer = session({ session_id: "newer", session_token: "newer-token", updated_at: "2026-05-08T00:59:00.000Z" });
  const controller = session({ session_id: "controller", session_kind: "controller" });
  const noToken = session({ session_id: "no-token", session_token: undefined });
  const otherRoom = session({ session_id: "other-room", room_id: "github.com/brosincode/other" });
  const state: StoredLetAgentsLocalState = {
    agent_sessions: { liveOlder, liveNewer, controller, noToken, otherRoom },
  };

  assert.deepEqual(
    getLocalWorkerSessions(state, "github.com/brosincode/letagents", now).map((entry) => entry.session_id),
    ["newer", "older"]
  );
});

test("buildWorkerActionPatch preserves owner-token fields for task lifecycle mutations", () => {
  const worker = session();
  assert.deepEqual(buildWorkerActionPatch("task_1", worker, { action: "claim" }), {
    agent_session_id: "agent_session_current",
    agent_session_token: "token_current",
    status: "assigned",
    assignee: "CloudEmber | EmmyMay's agent | Agent",
    assignee_agent_key: "EmmyMay/cloudember",
  });
  assert.deepEqual(buildWorkerActionPatch("task_1", worker, { action: "start" }), {
    agent_session_id: "agent_session_current",
    agent_session_token: "token_current",
    status: "in_progress",
  });
  assert.deepEqual(buildWorkerActionPatch("task_1", worker, { action: "block" }), {
    agent_session_id: "agent_session_current",
    agent_session_token: "token_current",
    status: "blocked",
  });
  assert.deepEqual(buildWorkerActionPatch("task_1", worker, { action: "submit_review" }), {
    agent_session_id: "agent_session_current",
    agent_session_token: "token_current",
    status: "in_review",
  });
});

test("buildReviewWorkerActionBody includes worker credentials for review lease actions", () => {
  assert.deepEqual(
    buildReviewWorkerActionBody(session(), {
      action: "release",
      lease_id: "tl_review",
      reason: "review done",
    }),
    {
      action: "release",
      lease_id: "tl_review",
      reason: "review done",
      agent_session_id: "agent_session_current",
      agent_session_token: "token_current",
    }
  );
});

test("buildWorkerSnapshots exposes local worker identity without leaking tokens", () => {
  const snapshots = buildWorkerSnapshots({
    agent_sessions: {
      current: session(),
    },
  }, now);

  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], {
    id: "agent_session_current",
    runtime: "codex",
    state: "connected",
    roomId: "github.com/brosincode/letagents",
    actorLabel: "CloudEmber | EmmyMay's agent | Agent",
    agentKey: "EmmyMay/cloudember",
    agentSessionId: "agent_session_current",
    detail: "CloudEmber | EmmyMay's agent | Agent in github.com/brosincode/letagents",
  });
  assert.equal(JSON.stringify(snapshots).includes("token_current"), false);
});
