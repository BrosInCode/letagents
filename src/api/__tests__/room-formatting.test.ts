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
  formatGitRoomSummary,
  formatManualGitRoomSummaryForRoomId,
  formatFocusRoomAnchorMessage,
  formatFocusRoomConclusionMessage,
  formatFocusRoomReference,
  getFocusRoomSettings,
  toRoomResponse,
} = await import("../rooms/formatting.js");

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
    focus_archived_at: null,
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
      focus_archived_at: null,
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
    focus_archived_at: null,
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

test("formatGitRoomSummary exposes header metadata without head SHA", () => {
  assert.deepEqual(
    formatGitRoomSummary({
      room_id: "github.com/brosincode/letagents",
      provider: "github",
      host: "github.com",
      repository_id: "repo_1",
      repository_owner: "BrosInCode",
      repository_name: "letagents",
      repository_full_name: "BrosInCode/letagents",
      ref_type: "default_branch",
      ref_name: "staging",
      default_branch: "staging",
      base_ref: null,
      head_ref: null,
      head_repository_id: null,
      head_repository_full_name: null,
      head_repository_owner: null,
      head_repository_name: null,
      visibility: "private",
      is_default: true,
      source: "github_repository",
      created_at: "2026-04-20T00:00:00.000Z",
      updated_at: "2026-04-21T00:00:00.000Z",
    }),
    {
      room_id: "github.com/brosincode/letagents",
      provider: "github",
      host: "github.com",
      repository: {
        id: "repo_1",
        owner: "BrosInCode",
        name: "letagents",
        full_name: "BrosInCode/letagents",
      },
      ref: {
        type: "default_branch",
        name: "staging",
        default_branch: "staging",
        base_ref: null,
        head_ref: null,
        head_repository: null,
        is_default: true,
      },
      visibility: "private",
      access_mode: "private",
      source: "github_repository",
      updated_at: "2026-04-21T00:00:00.000Z",
    }
  );
});

test("formatGitRoomSummary preserves fork head repository identity", () => {
  const summary = formatGitRoomSummary({
    room_id: "focus_27",
    provider: "github",
    host: "github.com",
    repository_id: "base_repo",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    repository_full_name: "BrosInCode/letagents",
    ref_type: "pull_request",
    ref_name: "fix-login",
    default_branch: "staging",
    base_ref: "staging",
    head_ref: "fix-login",
    head_repository_id: "fork_repo",
    head_repository_owner: "contributor",
    head_repository_name: "letagents",
    head_repository_full_name: "contributor/letagents",
    visibility: "public",
    is_default: false,
    source: "webhook",
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-21T00:00:00.000Z",
  });

  assert.deepEqual(summary?.ref.head_repository, {
    id: "fork_repo",
    owner: "contributor",
    name: "letagents",
    full_name: "contributor/letagents",
  });
});

test("formatManualGitRoomSummaryForRoomId derives read-only GitHub repo metadata", () => {
  assert.deepEqual(
    formatManualGitRoomSummaryForRoomId("github.com/brosincode/letagents"),
    {
      room_id: "github.com/brosincode/letagents",
      provider: "github",
      host: "github.com",
      repository: {
        id: null,
        owner: "brosincode",
        name: "letagents",
        full_name: "brosincode/letagents",
      },
      ref: {
        type: "default_branch",
        name: null,
        default_branch: null,
        base_ref: null,
        head_ref: null,
        head_repository: null,
        is_default: true,
      },
      visibility: "unknown",
      access_mode: "unknown",
      source: "manual",
      updated_at: null,
    }
  );

  assert.equal(formatManualGitRoomSummaryForRoomId("focus_27"), null);
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
