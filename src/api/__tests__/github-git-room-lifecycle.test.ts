import assert from "node:assert/strict";
import test from "node:test";

import {
  PR_MERGED_SUMMARY,
  REPO_ROOM_ID,
  WEBHOOK_BRANCH_FOCUS_KEY,
  branchRefPayload,
  gitFocusRoom,
  lifecycleDeps,
  pullRequestPayload,
  pushPayload,
} from "./git-room-test-helpers.js";
import type { GitHubWebhookPayload } from "../github/app.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  applyGitHubRefRoomLifecycle,
  isGeneratedGitRefFocusRoom,
  selectGitHubRefRoomLifecycleMutation,
} = await import("../github/git-room-lifecycle.js");
const {
  selectGitHubEventRefRoomTarget,
  shouldCreateGitHubRefRoomForEvent,
  shouldResolveArchivedGitRefRoomForEvent,
} = await import("../github/git-room-routing.js");
const { materializeGitHubWebhookEvent } = await import("../github-room-events.js");

const ROOM_ARGS = [REPO_ROOM_ID, WEBHOOK_BRANCH_FOCUS_KEY];
const CONCLUDE_ARGS = [...ROOM_ARGS, PR_MERGED_SUMMARY];
const ORDER_10 = "2026-06-28T10:00:00.000Z";
const ORDER_11 = "2026-06-28T11:00:00.000Z";
const ORDER_12 = "2026-06-28T12:00:00.000Z";

function event(type: string, payload: GitHubWebhookPayload, deliveryId: string) {
  const materialized = materializeGitHubWebhookEvent(type, payload, deliveryId);
  assert.ok(materialized);
  return materialized;
}

function deleteBranchEvent(deliveryId = "delivery-delete-branch") {
  return event("delete", branchRefPayload("delete"), deliveryId);
}

function mergedPullRequestEvent(deliveryId = "delivery-pr-merged") {
  return event(
    "pull_request",
    pullRequestPayload({ action: "closed", merged: true }),
    deliveryId
  );
}

function concludedRoom() {
  return gitFocusRoom({
    focus_status: "concluded",
    concluded_at: "2026-06-28T10:30:00.000Z",
    conclusion_summary: PR_MERGED_SUMMARY,
  });
}

function archivedRoom(eventOrderAt = ORDER_11) {
  return gitFocusRoom({
    focus_archived_at: eventOrderAt,
    git_lifecycle_event_order_at: eventOrderAt,
  });
}

test("git ref room lifecycle archives branch delete events", () => {
  const deleteEvent = deleteBranchEvent();

  assert.deepEqual(
    selectGitHubEventRefRoomTarget({ event: deleteEvent, defaultBranch: "main" }),
    { refType: "branch", refName: "codex/GitRooms" }
  );
  assert.equal(selectGitHubRefRoomLifecycleMutation(deleteEvent), "archive");
  assert.equal(shouldCreateGitHubRefRoomForEvent(deleteEvent), false);
});

test("git ref room lifecycle concludes merged pull request branch rooms", () => {
  const mergedEvent = mergedPullRequestEvent();

  assert.equal(selectGitHubRefRoomLifecycleMutation(mergedEvent), "conclude");
  assert.equal(shouldCreateGitHubRefRoomForEvent(mergedEvent), false);
  assert.equal(shouldResolveArchivedGitRefRoomForEvent(mergedEvent), true);
});

test("git ref room lifecycle activates branch rooms on fresh branch activity", () => {
  const pushEvent = event(
    "push",
    pushPayload("refs/heads/codex/GitRooms"),
    "delivery-push-branch"
  );

  assert.equal(selectGitHubRefRoomLifecycleMutation(pushEvent), "activate");
  assert.equal(shouldCreateGitHubRefRoomForEvent(pushEvent), true);
});

test("applyGitHubRefRoomLifecycle only mutates generated git focus rooms", async () => {
  const deleteEvent = deleteBranchEvent("delivery-delete-branch-apply");
  const { calls, deps } = lifecycleDeps();

  assert.equal(
    isGeneratedGitRefFocusRoom(gitFocusRoom({ focus_key: "task_1", source_task_id: "task_1" })),
    false
  );
  assert.equal(
    await applyGitHubRefRoomLifecycle(
      gitFocusRoom({ focus_key: "task_1", source_task_id: "task_1" }),
      deleteEvent,
      deps
    ),
    null
  );
  assert.deepEqual(calls, []);

  assert.equal(isGeneratedGitRefFocusRoom(gitFocusRoom()), true);
  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(gitFocusRoom(), deleteEvent, deps),
    { mutation: "archive", applied: true }
  );
  assert.deepEqual(calls, [["archive", ROOM_ARGS]]);
});

test("applyGitHubRefRoomLifecycle skips stale lifecycle events", async () => {
  const claims: unknown[] = [];
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async (...args) => {
      claims.push(args);
      return null;
    },
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(gitFocusRoom(), deleteBranchEvent(), deps, {
      eventOrderAt: ORDER_11,
    }),
    { mutation: "archive", applied: false, skipped: "stale_event" }
  );
  assert.deepEqual(claims, [[gitFocusRoom().id, ORDER_11]]);
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle keeps merged branch rooms visible after delete", async () => {
  const room = concludedRoom();
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async () => room,
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(room, deleteBranchEvent(), deps, {
      eventOrderAt: ORDER_11,
    }),
    { mutation: "archive", applied: false, skipped: "already_concluded" }
  );
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle does not reactivate concluded rooms", async () => {
  const room = concludedRoom();
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async () => room,
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(
      room,
      event("create", branchRefPayload("create"), "delivery-create-branch-after-merge"),
      deps,
      { eventOrderAt: ORDER_11 }
    ),
    { mutation: "activate", applied: false, skipped: "already_concluded" }
  );
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle lets stale merged PRs conclude archived rooms", async () => {
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async () => null,
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(archivedRoom(), mergedPullRequestEvent(), deps, {
      eventOrderAt: ORDER_10,
    }),
    { mutation: "conclude", applied: true }
  );
  assert.deepEqual(calls, [
    ["activate", ROOM_ARGS],
    ["conclude", CONCLUDE_ARGS],
  ]);
});

test("applyGitHubRefRoomLifecycle activates archived claimed rooms before concluding", async () => {
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async () => archivedRoom(),
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(
      gitFocusRoom({ focus_status: "active" }),
      mergedPullRequestEvent(),
      deps,
      { eventOrderAt: ORDER_11 }
    ),
    { mutation: "conclude", applied: true }
  );
  assert.deepEqual(calls, [
    ["activate", ROOM_ARGS],
    ["conclude", CONCLUDE_ARGS],
  ]);
});

test("applyGitHubRefRoomLifecycle rechecks current room state for stale merged PR rescue", async () => {
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async () => null,
    getProjectById: async () => archivedRoom(),
    hasGitHubRoomActivationEventAfter: async () => false,
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(gitFocusRoom(), mergedPullRequestEvent(), deps, {
      eventOrderAt: ORDER_10,
    }),
    { mutation: "conclude", applied: true }
  );
  assert.deepEqual(calls, [
    ["activate", ROOM_ARGS],
    ["conclude", CONCLUDE_ARGS],
  ]);
});

test("applyGitHubRefRoomLifecycle blocks stale merged PRs after newer activation", async () => {
  const activationChecks: unknown[] = [];
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async () => null,
    hasGitHubRoomActivationEventAfter: async (...args) => {
      activationChecks.push(args);
      return true;
    },
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(archivedRoom(ORDER_12), mergedPullRequestEvent(), deps, {
      eventOrderAt: ORDER_10,
    }),
    { mutation: "conclude", applied: false, skipped: "stale_event" }
  );
  assert.deepEqual(activationChecks, [[gitFocusRoom().id, ORDER_10]]);
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle checks isolated event rooms for newer activation history", async () => {
  const activationChecks: unknown[] = [];
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async () => null,
    hasGitHubRoomActivationEventAfter: async (...args) => {
      activationChecks.push(args);
      return args[0] === "focus_isolated_1";
    },
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(archivedRoom(ORDER_12), mergedPullRequestEvent(), deps, {
      eventOrderAt: ORDER_10,
      activationEventRoomIds: ["focus_isolated_1"],
    }),
    { mutation: "conclude", applied: false, skipped: "stale_event" }
  );
  assert.deepEqual(activationChecks, [
    [gitFocusRoom().id, ORDER_10],
    ["focus_isolated_1", ORDER_10],
  ]);
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle checks claimed room state before archiving", async () => {
  const { calls, deps } = lifecycleDeps({
    claimGitRefFocusRoomLifecycleEvent: async () => concludedRoom(),
  });

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(
      gitFocusRoom({ focus_status: "active" }),
      deleteBranchEvent(),
      deps,
      { eventOrderAt: ORDER_11 }
    ),
    { mutation: "archive", applied: false, skipped: "already_concluded" }
  );
  assert.deepEqual(calls, []);
});
