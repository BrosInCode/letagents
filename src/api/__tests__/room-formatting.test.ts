import assert from "node:assert/strict";
import test from "node:test";

import type { Project, Task } from "../db.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.ATTACHMENT_S3_BUCKET;
delete process.env.S3_BUCKET;
delete process.env.ATTACHMENT_S3_ACCESS_KEY_ID;
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.ATTACHMENT_S3_SECRET_ACCESS_KEY;
delete process.env.AWS_SECRET_ACCESS_KEY;

const {
  formatFocusRoomAnchorMessage,
  formatFocusRoomConclusionMessage,
  formatFocusRoomReference,
  getFocusRoomSettings,
  toRoomResponse,
} = await import("../room-formatting.js");

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "room_1",
    code: "ABCD-1234",
    display_name: "Main Room",
    name: "main-room",
    kind: "main",
    parent_room_id: null,
    focus_key: null,
    source_task_id: null,
    focus_status: null,
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    concluded_at: null,
    conclusion_summary: null,
    conclusion_details: null,
    created_at: "2026-04-20 00:00:00+00",
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    room_id: "room_1",
    title: "Refactor server",
    description: null,
    status: "in_progress",
    assignee: null,
    created_by: "Agent",
    source_message_id: null,
    pr_url: null,
    workflow_artifacts: [],
    workflow_refs: [],
    created_at: "2026-04-20 00:00:00+00",
    updated_at: "2026-04-20 00:00:00+00",
    ...overrides,
  };
}

test("toRoomResponse preserves non-focus room response shape", () => {
  assert.deepEqual(
    toRoomResponse(project(), {
      role: "participant",
      authenticated: true,
    }),
    {
      room_id: "room_1",
      name: "main-room",
      display_name: "Main Room",
      code: "ABCD-1234",
      kind: "main",
      attachments_enabled: false,
      parent_room_id: null,
      focus_key: null,
      source_task_id: null,
      focus_status: null,
      focus_parent_visibility: null,
      focus_activity_scope: null,
      focus_github_event_routing: null,
      focus_settings: null,
      concluded_at: null,
      conclusion_summary: null,
      conclusion_details: null,
      created_at: "2026-04-20 00:00:00+00",
      role: "participant",
      authenticated: true,
    }
  );
});

test("toRoomResponse normalizes focus settings into flat and nested fields", () => {
  const response = toRoomResponse(
    project({
      id: "focus_5",
      code: null,
      display_name: "Focus Room",
      name: undefined,
      kind: "focus",
      parent_room_id: "github.com/owner/repo",
      focus_key: "task_1",
      source_task_id: "task_1",
      focus_status: "active",
      focus_parent_visibility: "major_activity",
      focus_activity_scope: "room",
      focus_github_event_routing: "all_parent_repo",
      conclusion_summary: "Done",
    }),
    { authenticated: false }
  );

  assert.deepEqual(response, {
    room_id: "focus_5",
    name: null,
    display_name: "Focus Room",
    code: null,
    kind: "focus",
    attachments_enabled: false,
    parent_room_id: "github.com/owner/repo",
    focus_key: "task_1",
    source_task_id: "task_1",
    focus_status: "active",
    focus_parent_visibility: "major_activity",
    focus_activity_scope: "room",
    focus_github_event_routing: "all_parent_repo",
    focus_settings: {
      parent_visibility: "major_activity",
      activity_scope: "room",
      github_event_routing: "all_parent_repo",
    },
    concluded_at: null,
    conclusion_summary: "Done",
    conclusion_details: null,
    created_at: "2026-04-20 00:00:00+00",
    authenticated: false,
  });
});

test("getFocusRoomSettings applies focus room defaults", () => {
  assert.deepEqual(
    getFocusRoomSettings(project({ kind: "focus" })),
    {
      parent_visibility: "summary_only",
      activity_scope: "task_and_branch",
      github_event_routing: "task_and_branch",
    }
  );
});

test("focus room messages preserve task and fallback labels", () => {
  const focusRoom = project({
    id: "focus_5",
    display_name: "Task 1 Focus",
    kind: "focus",
    focus_key: "task_1",
    source_task_id: "task_1",
  });

  assert.equal(
    formatFocusRoomConclusionMessage({
      focusRoom,
      task: task(),
      summary: "Merged safely",
      details: {
        artifact: "PR #316",
        review_state: "reviewed",
        blocker_state: "resolved",
        parent_task_next: "mark_done",
        next_owner: "CrestRaven",
      },
    }),
    [
      "[status] Focus Room concluded for task_1: Refactor server. Result: Merged safely",
      "Artifact: PR #316",
      "Review: reviewed",
      "Blockers: resolved",
      "Parent task next: mark done",
      "Next owner: CrestRaven",
    ].join("\n")
  );
  assert.equal(
    formatFocusRoomConclusionMessage({
      focusRoom: project({
        id: "focus_6",
        display_name: "",
        kind: "focus",
        source_task_id: "task_6",
      }),
      summary: "No PR needed",
    }),
    "[status] Focus Room concluded for task_6. Result: No PR needed"
  );
  assert.equal(formatFocusRoomReference(focusRoom), "Task 1 Focus (task_1)");
  assert.equal(
    formatFocusRoomAnchorMessage({
      task: { id: "task_1", title: "Refactor server" },
      focusRoom,
      activity: "Review",
    }),
    "[status] Review for task_1: Refactor server is in Focus Room Task 1 Focus (task_1)."
  );
});
