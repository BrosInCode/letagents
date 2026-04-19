import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FOCUS_ROOM_SETTINGS,
  normalizeFocusRoomSettings,
  shouldRouteGitHubEventToFocusRoom,
  shouldPostFocusRoomEventToParent,
  validateFocusRoomSettingsPatch,
} from "../focus-room-settings.js";

test("normalizeFocusRoomSettings applies defaults for missing persisted settings", () => {
  assert.deepEqual(normalizeFocusRoomSettings(null), DEFAULT_FOCUS_ROOM_SETTINGS);
  assert.deepEqual(
    normalizeFocusRoomSettings({
      parent_visibility: null,
      activity_scope: "task_only",
      github_event_routing: undefined,
    }),
    {
      parent_visibility: "summary_only",
      activity_scope: "task_only",
      github_event_routing: "task_and_branch",
    }
  );
});

test("validateFocusRoomSettingsPatch accepts partial valid settings", () => {
  assert.deepEqual(
    validateFocusRoomSettingsPatch({
      parent_visibility: "major_activity",
      github_event_routing: "off",
    }),
    {
      parent_visibility: "major_activity",
      github_event_routing: "off",
    }
  );
});

test("validateFocusRoomSettingsPatch rejects invalid or unknown settings", () => {
  assert.throws(
    () => validateFocusRoomSettingsPatch({ parent_visibility: "everything" }),
    /parent_visibility is invalid/
  );
  assert.throws(
    () => validateFocusRoomSettingsPatch({ activity_scope: "task_only", noise: true }),
    /unsupported focus room setting/
  );
});

test("shouldPostFocusRoomEventToParent follows parent visibility policy", () => {
  assert.equal(
    shouldPostFocusRoomEventToParent({ ...DEFAULT_FOCUS_ROOM_SETTINGS, parent_visibility: "summary_only" }, "result_summary"),
    true
  );
  assert.equal(
    shouldPostFocusRoomEventToParent({ ...DEFAULT_FOCUS_ROOM_SETTINGS, parent_visibility: "summary_only" }, "major_activity"),
    false
  );
  assert.equal(
    shouldPostFocusRoomEventToParent({ ...DEFAULT_FOCUS_ROOM_SETTINGS, parent_visibility: "major_activity" }, "major_activity"),
    true
  );
  assert.equal(
    shouldPostFocusRoomEventToParent({ ...DEFAULT_FOCUS_ROOM_SETTINGS, parent_visibility: "silent" }, "result_summary"),
    false
  );
});

test("shouldRouteGitHubEventToFocusRoom follows GitHub routing policy", () => {
  assert.equal(
    shouldRouteGitHubEventToFocusRoom(
      { ...DEFAULT_FOCUS_ROOM_SETTINGS, github_event_routing: "task_and_branch" },
      { matched_workflow_artifact: true }
    ),
    true
  );
  assert.equal(
    shouldRouteGitHubEventToFocusRoom(
      { ...DEFAULT_FOCUS_ROOM_SETTINGS, github_event_routing: "task_only" },
      { matched_workflow_artifact: true }
    ),
    false
  );
  assert.equal(
    shouldRouteGitHubEventToFocusRoom(
      { ...DEFAULT_FOCUS_ROOM_SETTINGS, github_event_routing: "task_only" },
      { matched_task_reference: true }
    ),
    true
  );
  assert.equal(
    shouldRouteGitHubEventToFocusRoom(
      { ...DEFAULT_FOCUS_ROOM_SETTINGS, github_event_routing: "all_parent_repo" },
      { parent_repo_event: true }
    ),
    true
  );
  assert.equal(
    shouldRouteGitHubEventToFocusRoom(
      { ...DEFAULT_FOCUS_ROOM_SETTINGS, github_event_routing: "off" },
      { matched_task_reference: true }
    ),
    false
  );
});
