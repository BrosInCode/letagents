import assert from "node:assert/strict";
import test from "node:test";

import type { Project } from "../db.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { getGitHubEventLaneRoomId, registerRoomEventRoutes } = await import("../routes/room-events.js");

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "github.com/owner/repo",
    code: null,
    display_name: "Repo Room",
    name: "github.com/owner/repo",
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

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireParticipant: unused,
    getProjectAccessRoomId: () => "room",
  };
}

test("registerRoomEventRoutes preserves canonical event route order", () => {
  const calls: Array<{ method: "get"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
  };

  registerRoomEventRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^(?:\\/api)?\\/rooms\\/(.+)\\/events$/" },
  ]);
});

test("getGitHubEventLaneRoomId keeps default focus rooms on the parent event lane", () => {
  assert.equal(
    getGitHubEventLaneRoomId(
      project({
        id: "focus_default",
        kind: "focus",
        parent_room_id: "github.com/owner/repo",
        focus_key: "task_1",
        source_task_id: "task_1",
        focus_status: "active",
        focus_github_event_routing: "task_and_branch",
      }),
      "github.com/owner/repo"
    ),
    "github.com/owner/repo"
  );
});

test("getGitHubEventLaneRoomId keeps all-parent-repo focus rooms on the parent event lane", () => {
  assert.equal(
    getGitHubEventLaneRoomId(
      project({
        id: "focus_all_parent",
        kind: "focus",
        parent_room_id: "github.com/owner/repo",
        focus_key: "task_1",
        source_task_id: "task_1",
        focus_status: "active",
        focus_github_event_routing: "all_parent_repo",
      }),
      "github.com/owner/repo"
    ),
    "github.com/owner/repo"
  );
});

test("getGitHubEventLaneRoomId uses the focus lane for hard-isolated focus rooms", () => {
  assert.equal(
    getGitHubEventLaneRoomId(
      project({
        id: "focus_isolated",
        kind: "focus",
        parent_room_id: "github.com/owner/repo",
        focus_key: "task_1",
        source_task_id: "task_1",
        focus_status: "active",
        focus_github_event_routing: "focus_owned_only",
      }),
      "github.com/owner/repo"
    ),
    "focus_isolated"
  );
});
