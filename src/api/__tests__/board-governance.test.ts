import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  buildBoardGovernanceCapabilities,
  buildBoardGovernanceWarnings,
} = await import("../db/coordination/board-governance.js");

test("buildBoardGovernanceCapabilities hides admin mutations for non-admins", () => {
  const capabilities = buildBoardGovernanceCapabilities({
    is_admin: false,
    active_manager: null,
  });

  assert.equal(capabilities.can_view_governance, true);
  assert.equal(capabilities.can_assign_manager, false);
  assert.equal(capabilities.can_release_manager, false);
  assert.equal(capabilities.can_set_manager_mode, false);
  assert.equal(capabilities.can_decide_intents, false);
});

test("buildBoardGovernanceCapabilities allows active manager intent decisions", () => {
  const capabilities = buildBoardGovernanceCapabilities({
    is_admin: false,
    active_manager: {
      id: "bm_1",
      room_id: "focus_30",
      agent_session_id: "agent_session_244",
      agent_key: "agent:244",
      actor_label: "RiverField",
      runtime_source: "desktop_managed",
      assigned_by: "admin",
      status: "active",
      last_heartbeat_at: null,
      released_by: null,
      release_reason: null,
      released_at: null,
      created_at: "2026-07-03T00:00:00.000Z",
      updated_at: "2026-07-03T00:00:00.000Z",
    },
    viewer_agent_session_id: "agent_session_244",
  });

  assert.equal(capabilities.can_decide_intents, true);
  assert.equal(capabilities.can_assign_manager, false);
});

test("buildBoardGovernanceWarnings flags intent_required without manager", () => {
  const warnings = buildBoardGovernanceWarnings({
    settings: {
      room_id: "focus_30",
      manager_mode: "intent_required",
      updated_by: null,
      created_at: "2026-07-03T00:00:00.000Z",
      updated_at: "2026-07-03T00:00:00.000Z",
    },
    active_manager: null,
    pending_intent_count: 0,
    intents_required: true,
  });

  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["intent_required_without_manager"]
  );
});

test("buildBoardGovernanceWarnings surfaces pending intent queue info", () => {
  const warnings = buildBoardGovernanceWarnings({
    settings: {
      room_id: "focus_30",
      manager_mode: "manager_optional",
      updated_by: null,
      created_at: "2026-07-03T00:00:00.000Z",
      updated_at: "2026-07-03T00:00:00.000Z",
    },
    active_manager: {
      id: "bm_1",
      room_id: "focus_30",
      agent_session_id: "agent_session_244",
      agent_key: "agent:244",
      actor_label: "RiverField",
      runtime_source: "desktop_managed",
      assigned_by: "admin",
      status: "active",
      last_heartbeat_at: null,
      released_by: null,
      release_reason: null,
      released_at: null,
      created_at: "2026-07-03T00:00:00.000Z",
      updated_at: "2026-07-03T00:00:00.000Z",
    },
    pending_intent_count: 2,
    intents_required: true,
  });

  assert.ok(warnings.some((warning) => warning.code === "pending_intents_awaiting_decision"));
});
