import assert from "node:assert/strict";
import test from "node:test";

const { mapDesktopBoardGovernanceSnapshot } = await import(
  "../main/rooms/board-governance/mappers.js"
);

test("mapDesktopBoardGovernanceSnapshot maps capabilities for admin UI gating", () => {
  const snapshot = mapDesktopBoardGovernanceSnapshot({
    room_id: "focus_30",
    settings: {
      room_id: "focus_30",
      manager_mode: "manager_optional",
      updated_by: null,
      created_at: "2026-07-03T00:00:00.000Z",
      updated_at: "2026-07-03T00:00:00.000Z",
    },
    active_manager: null,
    candidates: [
      {
        agent_session_id: "agent_session_244",
        agent_key: "agent:244",
        actor_label: "RiverField",
        display_name: "RiverField",
        runtime: "claude-code",
        runtime_source: "desktop_managed",
        last_seen_at: "2026-07-03T00:00:00.000Z",
        is_active_manager: false,
      },
    ],
    pending_intents: [],
    pending_intent_count: 0,
    audit: [],
    warnings: [],
    capabilities: {
      can_view_governance: true,
      can_assign_manager: true,
      can_release_manager: true,
      can_set_manager_mode: true,
      can_decide_intents: true,
    },
  });

  assert.equal(snapshot.roomId, "focus_30");
  assert.equal(snapshot.candidates[0]?.agentSessionId, "agent_session_244");
  assert.equal(snapshot.capabilities.canAssignManager, true);
});
