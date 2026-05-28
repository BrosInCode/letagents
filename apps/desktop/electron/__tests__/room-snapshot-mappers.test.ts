import assert from "node:assert/strict";
import test from "node:test";

import { mapSnapshotData } from "../main/rooms/snapshot/mappers.js";
import type { RoomSnapshotData } from "../main/rooms/snapshot/payloads.js";

const emptySnapshotData: RoomSnapshotData = {
  focusRoomsData: { focus_rooms: [] },
  tasksData: { tasks: [] },
  participantsData: { participants: [], hidden_count: 0 },
  presenceData: { presence: [] },
  reasoningData: { sessions: [], reasoning_sessions: [] },
  activityHistoryData: { entries: [] },
  messagesData: { messages: [] },
};

test("mapSnapshotData preserves snapshot ordering and payload fallbacks", () => {
  const data: RoomSnapshotData = {
    ...emptySnapshotData,
    focusRoomsData: {
      focus_rooms: [{
        room_id: "focus_room",
        name: null,
        display_name: "Focus Room",
        code: "ABCD-1234",
        source_task_id: "task_1",
        focus_status: "active",
        created_at: "2026-05-12T09:00:00.000Z",
      }],
    },
    participantsData: {
      hidden_count: 2,
      participants: [{
        participant_key: "agent:cloud",
        kind: "agent",
        display_name: "Cloud",
        actor_label: "Cloud | Owner | Agent",
        agent_key: "owner/cloud",
        activity_state: "active",
        last_seen_at: "2026-05-12T10:00:00.000Z",
        source_flags: ["presence"],
      }],
    },
    presenceData: {
      presence: [{
        room_id: "room_1",
        actor_label: "Cloud | Owner | Agent",
        agent_key: "owner/cloud",
        agent_instance_id: "instance_1",
        agent_session_id: "session_1",
        session_kind: "worker",
        runtime: "codex",
        display_name: "Cloud",
        owner_label: "Owner",
        ide_label: "Codex",
        status: "working",
        status_text: "Refactoring",
        last_heartbeat_at: "2026-05-12T10:05:00.000Z",
        freshness: "active",
        activity_state: "active",
        source_flags: ["delivery"],
        liveness_observation: null,
      }],
    },
    reasoningData: {
      sessions: [
        {
          id: "reasoning_old",
          actor_label: "Cloud | Owner | Agent",
          title: "Old",
          updated_at: "2026-05-12T09:00:00.000Z",
        },
        {
          id: "reasoning_new",
          actor_label: "Cloud | Owner | Agent",
          title: "New",
          updated_at: "2026-05-12T11:00:00.000Z",
        },
      ],
    },
    activityHistoryData: {
      entries: [{
        id: "activity_1",
        participant: {
          display_name: "Cloud",
          kind: "agent",
          actor_label: "Cloud | Owner | Agent",
          activity_state: "active",
        },
        last_room_activity_at: "2026-05-12T11:30:00.000Z",
        message_count: 3,
        reasoning_session_count: 2,
        current_tasks: [{
          id: "task_1",
          title: "Refactor",
          status: "in_progress",
          updated_at: "2026-05-12T11:20:00.000Z",
          workflow_refs: [{
            provider: "github",
            kind: "pull_request",
            label: "#1",
            url: "https://example.test/pr/1",
          }],
        }],
        completed_tasks: [],
      }],
    },
    messagesData: {
      messages: [
        {
          id: "msg_2",
          sender: "Cloud",
          text: "Second",
          source: "agent",
          timestamp: "2026-05-12T11:01:00.000Z",
        },
        {
          id: "msg_1",
          sender: "Human",
          text: "First",
          source: "browser",
          timestamp: "2026-05-12T11:00:00.000Z",
        },
      ],
    },
  };

  const snapshot = mapSnapshotData(data);

  assert.equal(snapshot.focusRooms[0]?.displayName, "Focus Room");
  assert.equal(snapshot.participantHiddenCount, 2);
  assert.equal(snapshot.participants[0]?.agentKey, "owner/cloud");
  assert.equal(snapshot.presence[0]?.livenessObservation, null);
  assert.deepEqual(snapshot.reasoningSessions.map((session) => session.id), [
    "reasoning_new",
    "reasoning_old",
  ]);
  assert.equal(snapshot.recentActivity[0]?.currentTasks[0]?.workflowRefs[0]?.label, "#1");
  assert.deepEqual(snapshot.messages.map((message) => message.id), ["msg_1", "msg_2"]);
});
