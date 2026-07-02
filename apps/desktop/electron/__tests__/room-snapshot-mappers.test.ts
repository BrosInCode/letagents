import assert from "node:assert/strict";
import test from "node:test";

import { mapSnapshotData } from "../main/rooms/snapshot/mappers.js";
import { mapDesktopGitRoomPayload } from "../main/rooms/git-room.js";
import type { RoomSnapshotData } from "../main/rooms/snapshot/payloads.js";

const emptySnapshotData: RoomSnapshotData = {
  focusRoomsData: { focus_rooms: [] },
  tasksData: { tasks: [] },
  participantsData: { participants: [], hidden_count: 0 },
  presenceData: { presence: [] },
  reasoningData: { sessions: [], reasoning_sessions: [] },
  activityHistoryData: { entries: [] },
  roomArtifactsData: { artifacts: [] },
  boardSettingsData: {
    settings: { manager_mode: "manager_optional" },
    active_manager: null,
    pending_intent_count: 0,
  },
  messagesData: { messages: [] },
  githubEventsData: null,
};

test("mapDesktopGitRoomPayload accepts locally persisted desktop Git metadata", () => {
  const gitRoom = mapDesktopGitRoomPayload({
    provider: "git",
    host: "local",
    repository: {
      id: "local:repo",
      fullName: "FBRF",
      owner: "local",
      name: "FBRF",
    },
    ref: {
      type: "branch",
      name: "feature/player-3d-presentation",
      defaultBranch: "main",
      baseRef: "main",
      headRef: "feature/player-3d-presentation",
      headRepository: null,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: false,
    source: "local_git",
  });

  assert.equal(gitRoom?.repository.fullName, "FBRF");
  assert.equal(gitRoom?.ref.name, "feature/player-3d-presentation");
  assert.equal(gitRoom?.accessMode, "local");
  assert.equal(gitRoom?.source, "local_git");
});

test("mapSnapshotData preserves snapshot ordering and payload fallbacks", () => {
  const data: RoomSnapshotData = {
    ...emptySnapshotData,
    focusRoomsData: {
      focus_rooms: [{
        room_id: "focus_room",
        name: null,
        display_name: "Focus Room",
        code: "ABCD-1234",
        parent_room_id: "parent_room",
        focus_key: "task_1",
        source_task_id: "task_1",
        focus_status: "active",
        focus_settings: {
          parent_visibility: "major_activity",
          activity_scope: "task_only",
          github_event_routing: "off",
        },
        conclusion_summary: "Ready for review",
        conclusion_details: {
          artifact: "PR #1",
          review_state: "needs_review",
          blocker_state: "none",
          parent_task_next: "move_to_review",
          next_owner: "EmmyMay",
        },
        git_room: {
          provider: "github",
          host: "github.com",
          repository: {
            id: "1",
            full_name: "BrosInCode/letagents",
            owner: "BrosInCode",
            name: "letagents",
          },
          ref: {
            type: "branch",
            name: "feature/git-rooms",
            default_branch: "main",
            base_ref: "main",
            head_ref: "feature/git-rooms",
            head_repository: {
              id: "2",
              full_name: "Contributor/letagents",
              owner: "Contributor",
              name: "letagents",
            },
          },
          visibility: "private",
          access_mode: "private",
          is_default: false,
          source: "webhook",
        },
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
        repo_branch: "feature/git-rooms",
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
          repo_branch: "codex/desktop-events",
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
    roomArtifactsData: {
      artifacts: [
        {
          room_id: "room_1",
          identity_key: "github:branch:ref:codex/desktop-events",
          provider: "github",
          kind: "branch",
          artifact_id: null,
          artifact_number: null,
          title: "Branch codex/desktop-events",
          url: null,
          ref: "codex/desktop-events",
          state: "pushed",
          source: "github_event",
          first_seen_at: "2026-05-12T10:40:00.000Z",
          updated_at: "2026-05-12T11:10:00.000Z",
          linked_task_ids: ["task_1"],
        },
      ],
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
    githubEventsData: {
      room_id: "room_1",
      github_room_id: "github.com/BrosInCode/letagents",
      has_more: true,
      events: [
        {
          id: "evt_older",
          event_type: "pull_request_review",
          action: "submitted",
          github_object_id: "434",
          github_object_url: "https://github.com/BrosInCode/letagents/pull/434#pullrequestreview-1",
          title: "Review requested changes",
          state: "changes_requested",
          actor_login: "RepoMorrow",
          metadata: { pull_request: { head_ref: "codex/desktop-events" } },
          linked_task_id: "task_1",
          created_at: "2026-05-12T10:55:00.000Z",
        },
        {
          id: "evt_newer",
          event_type: "check_run",
          action: "completed",
          github_object_id: "check_1",
          github_object_url: "https://github.com/BrosInCode/letagents/actions/runs/1",
          title: "deploy",
          state: "failure",
          actor_login: "github-actions",
          metadata: { app_name: "GitHub Actions", head_branch: "codex/desktop-events" },
          linked_task_id: "task_1",
          created_at: "2026-05-12T11:05:00.000Z",
        },
      ],
    },
  };

  const snapshot = mapSnapshotData(data);

  assert.equal(snapshot.focusRooms[0]?.displayName, "Focus Room");
  assert.equal(snapshot.focusRooms[0]?.parentRoomId, "parent_room");
  assert.equal(snapshot.focusRooms[0]?.focusSettings?.parent_visibility, "major_activity");
  assert.equal(snapshot.focusRooms[0]?.focusSettings?.github_event_routing, "off");
  assert.equal(snapshot.focusRooms[0]?.conclusionSummary, "Ready for review");
  assert.equal(snapshot.focusRooms[0]?.conclusionDetails?.parent_task_next, "move_to_review");
  assert.equal(snapshot.focusRooms[0]?.gitRoom?.repository.fullName, "BrosInCode/letagents");
  assert.equal(snapshot.focusRooms[0]?.gitRoom?.ref.headRepository?.owner, "Contributor");
  assert.equal(snapshot.focusRooms[0]?.gitRoom?.accessMode, "private");
  assert.equal(snapshot.participantHiddenCount, 2);
  assert.equal(snapshot.participants[0]?.agentKey, "owner/cloud");
  assert.equal(snapshot.presence[0]?.repoBranch, "feature/git-rooms");
  assert.equal(snapshot.presence[0]?.livenessObservation, null);
  assert.deepEqual(snapshot.reasoningSessions.map((session) => session.id), [
    "reasoning_new",
    "reasoning_old",
  ]);
  assert.equal(snapshot.recentActivity[0]?.currentTasks[0]?.workflowRefs[0]?.label, "#1");
  assert.equal(snapshot.recentActivity[0]?.repoBranch, "codex/desktop-events");
  assert.deepEqual(snapshot.messages.map((message) => message.id), ["msg_1", "msg_2"]);
  assert.equal(snapshot.roomArtifacts[0]?.identityKey, "github:branch:ref:codex/desktop-events");
  assert.equal(snapshot.roomArtifacts[0]?.kind, "branch");
  assert.deepEqual(snapshot.roomArtifacts[0]?.linkedTaskIds, ["task_1"]);
  assert.equal(snapshot.githubEvents?.githubRoomIdentifier, "github.com/BrosInCode/letagents");
  assert.equal(snapshot.githubEvents?.hasMore, true);
  assert.deepEqual(snapshot.githubEvents?.events.map((event) => event.id), ["evt_newer", "evt_older"]);
  assert.equal(snapshot.githubEvents?.events[0]?.eventType, "check_run");
  assert.deepEqual(snapshot.githubEvents?.events[0]?.metadata, {
    app_name: "GitHub Actions",
    head_branch: "codex/desktop-events",
  });
});
