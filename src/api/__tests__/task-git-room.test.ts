import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { ensureTaskGitRoomForActiveWorkLease } = await import("../github/task-git-room.js");
const { buildGitHubRefRoomId } = await import("../github/git-room-routing.js");
import type { GitRoomBinding, Project, TaskLease } from "../db.js";

function repoBinding(overrides: Partial<GitRoomBinding> = {}): GitRoomBinding {
  return {
    room_id: "github.com/BrosInCode/letagents",
    provider: "github",
    host: "github.com",
    repository_id: "123",
    repository_full_name: "BrosInCode/letagents",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    ref_type: "default_branch",
    ref_name: "main",
    default_branch: "main",
    base_ref: null,
    head_ref: null,
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "private",
    is_default: true,
    source: "github_repository",
    created_at: "2026-06-28T10:00:00.000Z",
    updated_at: "2026-06-28T10:00:00.000Z",
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "focus_1",
    code: null,
    display_name: "Focus: Git Rooms",
    name: null,
    kind: "focus",
    parent_room_id: "github.com/BrosInCode/letagents",
    focus_key: "task_1",
    source_task_id: "task_1",
    focus_status: "active",
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    focus_archived_at: null,
    git_lifecycle_event_order_at: null,
    concluded_at: null,
    conclusion_summary: null,
    conclusion_details: null,
    created_at: "2026-06-28T10:00:00.000Z",
    ...overrides,
  };
}

function workLease(branchRef: string): TaskLease {
  return {
    id: "lease_1",
    room_id: "github.com/BrosInCode/letagents",
    task_id: "task_1",
    kind: "work",
    status: "active",
    agent_key: "EmmyMay/timbercalm",
    agent_instance_id: null,
    agent_session_id: null,
    actor_label: "TimberCalm",
    branch_ref: branchRef,
    pr_url: null,
    output_intent: "Git Rooms",
    created_by: "TimberCalm",
    revoked_reason: null,
    expires_at: null,
    created_at: "2026-06-28T10:00:00.000Z",
    updated_at: "2026-06-28T10:00:00.000Z",
  };
}

test("ensureTaskGitRoomForActiveWorkLease attaches Git binding to existing task focus room", async () => {
  const calls: unknown[] = [];
  const focusRoom = project();
  const deps = {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease("refs/heads/codex/git-rooms")],
    getActiveFocusRoomForTask: async () => focusRoom,
    getGitChildRoom: async () => {
      throw new Error("should not create a generated branch room");
    },
    upsertGitRoomBinding: async (input: unknown) => {
      calls.push(input);
      return repoBinding({
        room_id: focusRoom.id,
        ref_type: "branch",
        ref_name: "codex/git-rooms",
        head_ref: "codex/git-rooms",
        is_default: false,
        source: "manual",
      });
    },
  };

  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: "github.com/BrosInCode/letagents",
    taskId: "task_1",
  }, deps);

  assert.equal(result.room?.id, "focus_1");
  assert.equal(result.attached_to_focus, true);
  assert.deepEqual(calls, [{
    room_id: "focus_1",
    provider: "github",
    host: "github.com",
    repository_id: "123",
    repository_full_name: "BrosInCode/letagents",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    ref_type: "branch",
    ref_name: "codex/git-rooms",
    default_branch: "main",
    base_ref: "main",
    head_ref: "codex/git-rooms",
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "private",
    is_default: false,
    source: "manual",
  }]);
});

test("ensureTaskGitRoomForActiveWorkLease skips generated branch room creation", async () => {
  const branchRoomId = buildGitHubRefRoomId({
    repositoryFullName: "BrosInCode/letagents",
    refType: "branch",
    refName: "codex/git-rooms",
  });
  const branchLookups: unknown[] = [];
  const deps = {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease("codex/git-rooms")],
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
    parentRoomId: "github.com/BrosInCode/letagents",
    taskId: "task_1",
  }, deps);

  assert.deepEqual(result, {
    room: null,
    binding: null,
    attached_to_focus: false,
    skipped: "missing_existing_branch_room",
  });
  assert.deepEqual(branchLookups, [{
    roomId: branchRoomId,
    parentRoomId: "github.com/BrosInCode/letagents",
    focusKey: "git:branch:Y29kZXgvZ2l0LXJvb21z",
  }]);
});

test("ensureTaskGitRoomForActiveWorkLease attaches to an existing branch room", async () => {
  const existingBranchRoom = project({
    id: buildGitHubRefRoomId({
      repositoryFullName: "BrosInCode/letagents",
      refType: "branch",
      refName: "codex/git-rooms",
    }),
    display_name: "Branch: codex/git-rooms",
    focus_key: "git:branch:Y29kZXgvZ2l0LXJvb21z",
    source_task_id: null,
  });
  const upserts: unknown[] = [];
  const deps = {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease("codex/git-rooms")],
    getActiveFocusRoomForTask: async () => undefined,
    getGitChildRoom: async () => existingBranchRoom,
    upsertGitRoomBinding: async (input: unknown) => {
      upserts.push(input);
      return repoBinding({
        room_id: existingBranchRoom.id,
        ref_type: "branch",
        ref_name: "codex/git-rooms",
        head_ref: "codex/git-rooms",
        is_default: false,
        source: "manual",
      });
    },
  };

  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: "github.com/BrosInCode/letagents",
    taskId: "task_1",
  }, deps);

  assert.equal(result.room?.id, existingBranchRoom.id);
  assert.equal(result.attached_to_focus, false);
  assert.deepEqual(upserts, [{
    room_id: existingBranchRoom.id,
    provider: "github",
    host: "github.com",
    repository_id: "123",
    repository_full_name: "BrosInCode/letagents",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    ref_type: "branch",
    ref_name: "codex/git-rooms",
    default_branch: "main",
    base_ref: "main",
    head_ref: "codex/git-rooms",
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "private",
    is_default: false,
    source: "manual",
  }]);
});

test("ensureTaskGitRoomForActiveWorkLease preserves richer existing branch bindings", async () => {
  const upserts: unknown[] = [];
  const createdRoom = project({
    id: buildGitHubRefRoomId({
      repositoryFullName: "BrosInCode/letagents",
      refType: "branch",
      refName: "codex/git-rooms",
    }),
    display_name: "Branch: codex/git-rooms",
    focus_key: "git:branch:Y29kZXgvZ2l0LXJvb21z",
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
    ref_name: "codex/git-rooms",
    default_branch: "main",
    base_ref: "main",
    head_ref: "codex/git-rooms",
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
    getActiveTaskLeases: async () => [workLease("codex/git-rooms")],
    getActiveFocusRoomForTask: async () => undefined,
    getGitChildRoom: async () => createdRoom,
    upsertGitRoomBinding: async (input: unknown) => {
      upserts.push(input);
      return webhookBinding;
    },
  };

  const result = await ensureTaskGitRoomForActiveWorkLease({
    parentRoomId: "github.com/BrosInCode/letagents",
    taskId: "task_1",
  }, deps);

  assert.equal(result.room?.id, createdRoom.id);
  assert.equal(result.attached_to_focus, false);
  assert.deepEqual(upserts, [{
    room_id: createdRoom.id,
    provider: "github",
    host: "github.com",
    repository_id: "123",
    repository_full_name: "BrosInCode/letagents",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    ref_type: "branch",
    ref_name: "codex/git-rooms",
    default_branch: "main",
    base_ref: "main",
    head_ref: "codex/git-rooms",
    head_repository_id: "456",
    head_repository_full_name: "Contributor/letagents",
    head_repository_owner: "Contributor",
    head_repository_name: "letagents",
    visibility: "private",
    is_default: false,
    source: "webhook",
  }]);
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
    parentRoomId: "github.com/BrosInCode/letagents",
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
    parentRoomId: "github.com/BrosInCode/letagents",
    taskId: "task_1",
  }, {
    getGitRoomBindingForRoom: async () => repoBinding(),
    ensureGitHubRepoRoomBinding: async () => null,
    getActiveTaskLeases: async () => [workLease("main")],
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
