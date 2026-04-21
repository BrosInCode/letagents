import assert from "node:assert/strict";
import test from "node:test";

import type { RoomAgentPresence, RoomParticipant } from "../db.js";
import type { RoomActivityHistoryEntry } from "../room-activity-history.js";
import {
  decorateRoomActivityHistoryEntriesWithPresence,
  decorateRoomParticipantsWithPresence,
} from "../room-activity-state.js";

const presence: RoomAgentPresence[] = [
  {
    room_id: "focus_14",
    actor_label: "Maple | EmmyMay's agent | Codex",
    agent_key: "emmymay/maple",
    display_name: "Maple",
    owner_label: "EmmyMay",
    ide_label: "Codex",
    status: "working",
    status_text: "working in focus room",
    last_heartbeat_at: "2026-04-21T11:40:00.000Z",
    created_at: "2026-04-21T10:20:00.000Z",
    updated_at: "2026-04-21T11:40:00.000Z",
    freshness: "active",
    activity_state: "online",
    source_flags: ["presence"],
  },
];

test("decorateRoomParticipantsWithPresence assigns online, historical, and archived agent states", () => {
  const participants: RoomParticipant[] = [
    {
      room_id: "focus_14",
      participant_key: "agent:maple",
      kind: "agent",
      actor_label: "Maple | EmmyMay's agent | Codex",
      agent_key: "emmymay/maple",
      github_login: null,
      display_name: "Maple",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      hidden_at: null,
      hidden_by: null,
      last_seen_at: "2026-04-21T11:39:00.000Z",
      last_room_activity_at: "2026-04-21T11:39:00.000Z",
      last_live_heartbeat_at: null,
      activity_state: null,
      source_flags: [],
      created_at: "2026-04-21T10:20:00.000Z",
      updated_at: "2026-04-21T11:39:00.000Z",
    },
    {
      room_id: "focus_14",
      participant_key: "agent:ember",
      kind: "agent",
      actor_label: "Ember | EmmyMay's agent | Codex",
      agent_key: "emmymay/ember",
      github_login: null,
      display_name: "Ember",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      hidden_at: null,
      hidden_by: null,
      last_seen_at: "2026-04-21T10:00:00.000Z",
      last_room_activity_at: "2026-04-21T10:00:00.000Z",
      last_live_heartbeat_at: null,
      activity_state: null,
      source_flags: [],
      created_at: "2026-04-21T09:00:00.000Z",
      updated_at: "2026-04-21T10:00:00.000Z",
    },
    {
      room_id: "focus_14",
      participant_key: "agent:ash",
      kind: "agent",
      actor_label: "Ash | EmmyMay's agent | Codex",
      agent_key: "emmymay/ash",
      github_login: null,
      display_name: "Ash",
      owner_label: "EmmyMay",
      ide_label: "Codex",
      hidden_at: "2026-04-21T12:00:00.000Z",
      hidden_by: "EmmyMay",
      last_seen_at: "2026-04-21T09:30:00.000Z",
      last_room_activity_at: "2026-04-21T09:30:00.000Z",
      last_live_heartbeat_at: null,
      activity_state: null,
      source_flags: [],
      created_at: "2026-04-21T09:00:00.000Z",
      updated_at: "2026-04-21T12:00:00.000Z",
    },
  ];

  const decorated = decorateRoomParticipantsWithPresence({ participants, presence });
  assert.equal(decorated[0]?.activity_state, "online");
  assert.equal(decorated[0]?.last_live_heartbeat_at, "2026-04-21T11:40:00.000Z");
  assert.equal(decorated[1]?.activity_state, "historical");
  assert.equal(decorated[2]?.activity_state, "archived");
});

test("decorateRoomActivityHistoryEntriesWithPresence carries live state into history entries", () => {
  const entries: RoomActivityHistoryEntry[] = [
    {
      id: "focus_14:agent:maple",
      room: {
        id: "focus_14",
        display_name: "Attachment Work",
        kind: "focus",
        focus_status: "active",
        source_task_id: "task_142",
      },
      participant: {
        participant_key: "agent:maple",
        kind: "agent",
        actor_label: "Maple | EmmyMay's agent | Codex",
        agent_key: "emmymay/maple",
        github_login: null,
        display_name: "Maple",
        owner_label: "EmmyMay",
        ide_label: "Codex",
        hidden_at: null,
        hidden_by: null,
        last_live_heartbeat_at: null,
        activity_state: null,
        source_flags: [],
      },
      first_seen_at: "2026-04-21T10:20:00.000Z",
      last_seen_at: "2026-04-21T11:39:00.000Z",
      last_room_activity_at: "2026-04-21T11:45:00.000Z",
      current_tasks: [{ id: "task_142", title: "Attachment history", status: "in_review", updated_at: "2026-04-21T11:45:00.000Z", workflow_refs: [] }],
      completed_tasks: [],
      created_tasks: [],
    },
  ];

  const decorated = decorateRoomActivityHistoryEntriesWithPresence({ entries, presence });
  assert.equal(decorated[0]?.participant.activity_state, "online");
  assert.deepEqual(decorated[0]?.participant.source_flags, ["presence", "tasks"]);
  assert.equal(decorated[0]?.participant.last_live_heartbeat_at, "2026-04-21T11:40:00.000Z");
});
