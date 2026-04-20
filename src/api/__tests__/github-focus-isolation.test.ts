import assert from "node:assert/strict";
import test from "node:test";

import type { Project, Task } from "../db.js";
import { createGitHubFocusIsolationResolver } from "../github-focus-isolation.js";

function makeTask(id: string): Pick<Task, "id"> {
  return { id };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? "focus_1",
    code: overrides.code ?? null,
    display_name: overrides.display_name ?? "Focus One",
    name: overrides.name,
    kind: overrides.kind ?? "focus",
    parent_room_id: overrides.parent_room_id ?? "parent",
    focus_key: overrides.focus_key ?? "task_1",
    source_task_id: overrides.source_task_id ?? "task_1",
    focus_status: overrides.focus_status ?? "active",
    focus_parent_visibility: overrides.focus_parent_visibility ?? null,
    focus_activity_scope: overrides.focus_activity_scope ?? null,
    focus_github_event_routing: overrides.focus_github_event_routing ?? null,
    concluded_at: overrides.concluded_at ?? null,
    conclusion_summary: overrides.conclusion_summary ?? null,
    created_at: overrides.created_at ?? "2026-04-20T18:00:00.000Z",
  };
}

function createHarness(activeFocusRoom: Project | null) {
  const calls: Array<{ projectId: string; taskId: string }> = [];
  const resolver = createGitHubFocusIsolationResolver({
    getActiveTaskFocusRoom: async (projectId, taskId) => {
      calls.push({ projectId, taskId });
      return activeFocusRoom;
    },
  });

  return { calls, resolver };
}

test("getHardIsolatedFocusRoomForGitHubEvent skips lookup without a linked task", async () => {
  const { calls, resolver } = createHarness(makeProject());

  const focusRoom = await resolver.getHardIsolatedFocusRoomForGitHubEvent(
    "parent",
    undefined,
    { matched_task_reference: true }
  );

  assert.equal(focusRoom, null);
  assert.deepEqual(calls, []);
});

test("getHardIsolatedFocusRoomForGitHubEvent returns null without active focus", async () => {
  const { calls, resolver } = createHarness(null);

  const focusRoom = await resolver.getHardIsolatedFocusRoomForGitHubEvent(
    "parent",
    makeTask("task_1"),
    { matched_task_reference: true }
  );

  assert.equal(focusRoom, null);
  assert.deepEqual(calls, [{ projectId: "parent", taskId: "task_1" }]);
});

test("getHardIsolatedFocusRoomForGitHubEvent returns focus-owned GitHub rooms", async () => {
  const activeFocusRoom = makeProject({
    focus_github_event_routing: "focus_owned_only",
  });
  const { resolver } = createHarness(activeFocusRoom);

  const focusRoom = await resolver.getHardIsolatedFocusRoomForGitHubEvent(
    "parent",
    makeTask("task_1"),
    { matched_task_reference: true }
  );

  assert.equal(focusRoom, activeFocusRoom);
});

test("getHardIsolatedFocusRoomForGitHubEvent does not isolate non-hard routing modes", async () => {
  const activeFocusRoom = makeProject({
    focus_github_event_routing: "task_and_branch",
  });
  const { resolver } = createHarness(activeFocusRoom);

  const focusRoom = await resolver.getHardIsolatedFocusRoomForGitHubEvent(
    "parent",
    makeTask("task_1"),
    { matched_workflow_artifact: true }
  );

  assert.equal(focusRoom, null);
});
