import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BRANCH,
  REPO_FULL_NAME,
  REPO_NAME,
  REPO_OWNER,
  TASK_BRANCH,
  TASK_BRANCH_FOCUS_KEY,
  TASK_BRANCH_ROOM_ID,
  project,
  repoBinding,
  workLease,
} from "./git-room-test-helpers.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { ensureTaskGitRoomForActiveWorkLease } = await import("../github/task-git-room.js");

const PARENT_ROOM_ID = "github.com/BrosInCode/letagents";

function expectedBranchBinding(roomId: string, overrides: Record<string, unknown> = {}) {
  return {
    room_id: roomId,
    provider: "github",
    host: "github.com",
    repository_id: "123",
    repository_full_name: REPO_FULL_NAME,
    repository_owner: REPO_OWNER,
    repository_name: REPO_NAME,
    ref_type: "branch",
    ref_name: TASK_BRANCH,
    default_branch: DEFAULT_BRANCH,
    base_ref: DEFAULT_BRANCH,
    head_ref: TASK_BRANCH,
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "private",
    is_default: false,
    source: "manual",
    ...overrides,
  };
}

test("ensureTaskGitRoomForActiveWorkLease attaches Git binding to existing task focus room", async () => {
  const calls: unknown[] = [];
  const focusRoom = project();
  const deps = {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease(`refs/heads/${TASK_BRANCH}`)],
    getActiveFocusRoomForTask: async () => focusRoom,
    getGitChildRoom: async () => {
      throw new Error("should not create a generated branch room");
    },
    upsertGitRoomBinding: async (input: unknown) => {
      calls.push(input);
      return repoBinding({
        room_id: focusRoom.id,
        ref_type: "branch",
        ref_name: TASK_BRANCH,
        head_ref: TASK_BRANCH,
        is_default: false,
        source: "manual",
      });
    },
  };

  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: PARENT_ROOM_ID,
    taskId: "task_1",
  }, deps);

  assert.equal(result.room?.id, "focus_1");
  assert.equal(result.attached_to_focus, true);
  assert.deepEqual(calls, [expectedBranchBinding(focusRoom.id)]);
});

test("ensureTaskGitRoomForActiveWorkLease skips generated branch room creation", async () => {
  const branchLookups: unknown[] = [];
  const deps = {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease(TASK_BRANCH)],
    getActiveFocusRoomForTask: async () => undefined,
    getGitChildRoom: async (input: unknown) => {
      branchLookups.push(input);
      return undefined;
    },
    upsertGitRoomBinding: async () => {
      throw new Error("should not bind a missing branch room");
    },
  };

  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: PARENT_ROOM_ID,
    taskId: "task_1",
  }, deps);

  assert.deepEqual(result, {
    room: null,
    binding: null,
    attached_to_focus: false,
    skipped: "missing_existing_branch_room",
  });
  assert.deepEqual(branchLookups, [{
    roomId: TASK_BRANCH_ROOM_ID,
    parentRoomId: PARENT_ROOM_ID,
    focusKey: TASK_BRANCH_FOCUS_KEY,
  }]);
});

test("ensureTaskGitRoomForActiveWorkLease attaches to an existing branch room", async () => {
  const existingBranchRoom = project({
    id: TASK_BRANCH_ROOM_ID,
    display_name: `Branch: ${TASK_BRANCH}`,
    focus_key: TASK_BRANCH_FOCUS_KEY,
    source_task_id: null,
  });
  const upserts: unknown[] = [];
  const deps = {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease(TASK_BRANCH)],
    getActiveFocusRoomForTask: async () => undefined,
    getGitChildRoom: async () => existingBranchRoom,
    upsertGitRoomBinding: async (input: unknown) => {
      upserts.push(input);
      return repoBinding({
        room_id: existingBranchRoom.id,
        ref_type: "branch",
        ref_name: TASK_BRANCH,
        head_ref: TASK_BRANCH,
        is_default: false,
        source: "manual",
      });
    },
  };

  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: PARENT_ROOM_ID,
    taskId: "task_1",
  }, deps);

  assert.equal(result.room?.id, existingBranchRoom.id);
  assert.equal(result.attached_to_focus, false);
  assert.deepEqual(upserts, [expectedBranchBinding(existingBranchRoom.id)]);
});

test("ensureTaskGitRoomForActiveWorkLease preserves richer existing branch bindings", async () => {
  const upserts: unknown[] = [];
  const createdRoom = project({
    id: TASK_BRANCH_ROOM_ID,
    display_name: `Branch: ${TASK_BRANCH}`,
    focus_key: TASK_BRANCH_FOCUS_KEY,
    source_task_id: null,
  });
  const parentBinding = repoBinding({
    repository_id: null,
    default_branch: null,
    visibility: "unknown",
    source: "manual",
  });
  const webhookBinding = repoBinding({
    room_id: createdRoom.id,
    ref_type: "branch",
    ref_name: TASK_BRANCH,
    default_branch: DEFAULT_BRANCH,
    base_ref: DEFAULT_BRANCH,
    head_ref: TASK_BRANCH,
    head_repository_id: "456",
    head_repository_full_name: "Contributor/letagents",
    head_repository_owner: "Contributor",
    head_repository_name: "letagents",
    visibility: "private",
    is_default: false,
    source: "webhook",
  });
  const deps = {
    getGitRoomBindingForRoom: async (roomId: string) =>
      roomId === createdRoom.id ? webhookBinding : parentBinding,
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease(TASK_BRANCH)],
    getActiveFocusRoomForTask: async () => undefined,
    getGitChildRoom: async () => createdRoom,
    upsertGitRoomBinding: async (input: unknown) => {
      upserts.push(input);
      return webhookBinding;
    },
  };

  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: PARENT_ROOM_ID,
    taskId: "task_1",
  }, deps);

  assert.equal(result.room?.id, createdRoom.id);
  assert.equal(result.attached_to_focus, false);
  assert.deepEqual(upserts, [expectedBranchBinding(createdRoom.id, {
    head_repository_id: "456",
    head_repository_full_name: "Contributor/letagents",
    head_repository_owner: "Contributor",
    head_repository_name: "letagents",
    source: "webhook",
  })]);
});

test("ensureTaskGitRoomForActiveWorkLease skips non-Git parent rooms", async () => {
  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: "support-room",
    taskId: "task_1",
  }, {
    getGitRoomBindingForRoom: async () => null,
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => {
      throw new Error("should stop before lease lookup");
    },
    getActiveFocusRoomForTask: async () => {
      throw new Error("should stop before focus lookup");
    },
    getGitChildRoom: async () => {
      throw new Error("should stop before child room creation");
    },
    upsertGitRoomBinding: async () => {
      throw new Error("should stop before binding");
    },
  });

  assert.deepEqual(result, {
    room: null,
    binding: null,
    attached_to_focus: false,
    skipped: "not_git_repo_room",
  });
});

test("ensureTaskGitRoomForActiveWorkLease skips leases without branch refs", async () => {
  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: PARENT_ROOM_ID,
    taskId: "task_1",
  }, {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => {
      throw new Error("existing binding should be used");
    },
    getActiveTaskLeases: async () => [workLease("  ")],
    getActiveFocusRoomForTask: async () => {
      throw new Error("should stop before focus lookup");
    },
    getGitChildRoom: async () => {
      throw new Error("should stop before child room creation");
    },
    upsertGitRoomBinding: async () => {
      throw new Error("should stop before binding");
    },
  });

  assert.deepEqual(result, {
    room: null,
    binding: null,
    attached_to_focus: false,
    skipped: "missing_work_lease_branch",
  });
});

test("ensureTaskGitRoomForActiveWorkLease skips default branch leases", async () => {
  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: PARENT_ROOM_ID,
    taskId: "task_1",
  }, {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease(DEFAULT_BRANCH)],
    getActiveFocusRoomForTask: async () => {
      throw new Error("should stop before focus lookup");
    },
    getGitChildRoom: async () => {
      throw new Error("should stop before child room creation");
    },
    upsertGitRoomBinding: async () => {
      throw new Error("should stop before binding");
    },
  });

  assert.deepEqual(result, {
    room: null,
    binding: null,
    attached_to_focus: false,
    skipped: "default_branch",
  });
});
