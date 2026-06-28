import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  buildGitHubRefFocusKey,
  buildGitHubRefRoomId,
  getExistingGitHubEventRefRoom,
  parseGitHubRefRoomId,
  selectGitHubEventRefRoomTarget,
  shouldCreateGitHubRefRoomForEvent,
  shouldResolveArchivedGitRefRoomForEvent,
} = await import("../github/git-room-routing.js");
const {
  applyGitHubRefRoomLifecycle,
  isGeneratedGitRefFocusRoom,
  selectGitHubRefRoomLifecycleMutation,
} = await import("../github/git-room-lifecycle.js");
const { materializeGitHubWebhookEvent } = await import("../github-room-events.js");

function gitFocusRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: "git-room:github.com:brosincode/letagents:branch:Y29kZXgvR2l0Um9vbXM",
    code: null,
    display_name: "Branch: codex/GitRooms",
    name: null,
    kind: "focus",
    parent_room_id: "github.com/brosincode/letagents",
    focus_key: "git:branch:Y29kZXgvR2l0Um9vbXM",
    source_task_id: null,
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
  } as never;
}

test("buildGitHubRefRoomId keeps branch names opaque and case-preserving", () => {
  const roomId = buildGitHubRefRoomId({
    repositoryFullName: "BrosInCode/letagents",
    refType: "branch",
    refName: "Feature/Caps",
  });

  assert.match(roomId, /^git-room:github\.com:brosincode\/letagents:branch:/);
  assert.equal(roomId.includes("Feature/Caps"), false);
  assert.notEqual(
    roomId,
    buildGitHubRefRoomId({
      repositoryFullName: "BrosInCode/letagents",
      refType: "branch",
      refName: "feature/caps",
    })
  );
  assert.equal(
    buildGitHubRefFocusKey({ refType: "branch", refName: "Feature/Caps" }),
    "git:branch:RmVhdHVyZS9DYXBz"
  );
});

test("parseGitHubRefRoomId decodes canonical generated branch room ids", () => {
  assert.deepEqual(
    parseGitHubRefRoomId("git-room:github.com:brosincode/letagents:branch:Y29kZXgvR2l0Um9vbXM"),
    {
      repositoryFullName: "brosincode/letagents",
      refType: "branch",
      refName: "codex/GitRooms",
    }
  );
});

test("parseGitHubRefRoomId rejects malformed encoded refs", () => {
  assert.equal(
    parseGitHubRefRoomId("git-room:github.com:brosincode/letagents:branch:not/canonical"),
    null
  );
  assert.equal(
    parseGitHubRefRoomId("git-room:github.com:brosincode/letagents:branch:%%%"),
    null
  );
});

test("selectGitHubEventRefRoomTarget routes non-default pull request heads to branch rooms", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "opened",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
          repo: {
            id: 1,
            full_name: "BrosInCode/letagents",
            name: "letagents",
            owner: { login: "BrosInCode" },
          },
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-branch"
  );

  assert.ok(event);
  assert.deepEqual(
    selectGitHubEventRefRoomTarget({ event, defaultBranch: "main" }),
    { refType: "branch", refName: "codex/GitRooms" }
  );
});

test("selectGitHubEventRefRoomTarget keeps default branch pushes in the repo room", () => {
  const event = materializeGitHubWebhookEvent(
    "push",
    {
      ref: "refs/heads/main",
      before: "111",
      after: "222",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-push-main"
  );

  assert.ok(event);
  assert.equal(selectGitHubEventRefRoomTarget({ event, defaultBranch: "main" }), null);
});

test("selectGitHubEventRefRoomTarget can route tag pushes to tag rooms", () => {
  const event = materializeGitHubWebhookEvent(
    "push",
    {
      ref: "refs/tags/v1.2.3",
      before: "111",
      after: "222",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-push-tag"
  );

  assert.ok(event);
  assert.deepEqual(
    selectGitHubEventRefRoomTarget({ event, defaultBranch: "main" }),
    { refType: "tag", refName: "v1.2.3" }
  );
});

test("git ref room lifecycle archives branch delete events", () => {
  const event = materializeGitHubWebhookEvent(
    "delete",
    {
      action: "delete",
      ref: "codex/GitRooms",
      ref_type: "branch",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-delete-branch"
  );

  assert.ok(event);
  assert.deepEqual(
    selectGitHubEventRefRoomTarget({ event, defaultBranch: "main" }),
    { refType: "branch", refName: "codex/GitRooms" }
  );
  assert.equal(selectGitHubRefRoomLifecycleMutation(event), "archive");
  assert.equal(shouldCreateGitHubRefRoomForEvent(event), false);
});

test("git ref room lifecycle concludes merged pull request branch rooms", () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "closed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        state: "closed",
        merged: true,
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-merged"
  );

  assert.ok(event);
  assert.equal(selectGitHubRefRoomLifecycleMutation(event), "conclude");
  assert.equal(shouldCreateGitHubRefRoomForEvent(event), false);
  assert.equal(shouldResolveArchivedGitRefRoomForEvent(event), true);
});

test("git ref room lifecycle activates branch rooms on fresh branch activity", () => {
  const event = materializeGitHubWebhookEvent(
    "push",
    {
      ref: "refs/heads/codex/GitRooms",
      before: "111",
      after: "222",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-push-branch"
  );

  assert.ok(event);
  assert.equal(selectGitHubRefRoomLifecycleMutation(event), "activate");
  assert.equal(shouldCreateGitHubRefRoomForEvent(event), true);
});

test("webhook ref routing does not create missing branch rooms", async () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "opened",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-branch-missing-room"
  );
  assert.ok(event);

  const childLookups: unknown[] = [];
  const upserts: unknown[] = [];
  const result = await getExistingGitHubEventRefRoom({
    event,
    payload: {
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
          repo: {
            id: 1,
            full_name: "BrosInCode/letagents",
            name: "letagents",
            owner: { login: "BrosInCode" },
          },
        },
      },
    },
    repository: {
      id: 1,
      full_name: "BrosInCode/letagents",
      name: "letagents",
      default_branch: "main",
    },
    githubRepoId: "1",
    deps: {
      getGitChildRoom: async (input) => {
        childLookups.push(input);
        return undefined;
      },
      upsertGitRoomBinding: async (input) => {
        upserts.push(input);
        throw new Error("should not upsert a missing branch room");
      },
    },
  } as never);

  assert.equal(result, null);
  assert.deepEqual(childLookups, [{
    roomId: "git-room:github.com:brosincode/letagents:branch:Y29kZXgvR2l0Um9vbXM",
    parentRoomId: "github.com/brosincode/letagents",
    focusKey: "git:branch:Y29kZXgvR2l0Um9vbXM",
  }]);
  assert.deepEqual(upserts, []);
});

test("webhook ref routing updates binding for existing same-repository branch rooms", async () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "opened",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
        private: true,
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
          repo: {
            id: 1,
            full_name: "BrosInCode/letagents",
            name: "letagents",
            owner: { login: "BrosInCode" },
          },
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-existing-branch-room"
  );
  assert.ok(event);

  const room = gitFocusRoom();
  const upserts: unknown[] = [];
  const result = await getExistingGitHubEventRefRoom({
    event,
    payload: {
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
        private: true,
      },
      pull_request: {
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
          repo: {
            id: 1,
            full_name: "BrosInCode/letagents",
            name: "letagents",
            owner: { login: "BrosInCode" },
          },
        },
      },
    },
    repository: {
      id: 1,
      full_name: "BrosInCode/letagents",
      name: "letagents",
      default_branch: "main",
      private: true,
    },
    githubRepoId: "1",
    deps: {
      getGitChildRoom: async () => room,
      upsertGitRoomBinding: async (input) => {
        upserts.push(input);
        return input as never;
      },
    },
  } as never);

  assert.equal(result, room);
  assert.deepEqual(upserts, [{
    room_id: room.id,
    provider: "github",
    host: "github.com",
    repository_id: "1",
    repository_full_name: "BrosInCode/letagents",
    repository_owner: "BrosInCode",
    repository_name: "letagents",
    ref_type: "branch",
    ref_name: "codex/GitRooms",
    default_branch: "main",
    base_ref: "main",
    head_ref: "codex/GitRooms",
    head_repository_id: "1",
    head_repository_full_name: "BrosInCode/letagents",
    head_repository_owner: "BrosInCode",
    head_repository_name: "letagents",
    visibility: "private",
    is_default: false,
    source: "webhook",
  }]);
});

test("webhook ref routing keeps fork pull requests in the repository room", async () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "opened",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
        private: true,
      },
      pull_request: {
        number: 42,
        title: "task_42: fork branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
          repo: {
            id: 2,
            full_name: "Contributor/letagents",
            name: "letagents",
            owner: { login: "Contributor" },
          },
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-fork-branch-room"
  );
  assert.ok(event);

  const childLookups: unknown[] = [];
  const upserts: unknown[] = [];
  const result = await getExistingGitHubEventRefRoom({
    event,
    payload: {
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
        private: true,
      },
      pull_request: {
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
          repo: {
            id: 2,
            full_name: "Contributor/letagents",
            name: "letagents",
            owner: { login: "Contributor" },
          },
        },
      },
    },
    repository: {
      id: 1,
      full_name: "BrosInCode/letagents",
      name: "letagents",
      default_branch: "main",
      private: true,
    },
    githubRepoId: "1",
    deps: {
      getGitChildRoom: async (input) => {
        childLookups.push(input);
        return gitFocusRoom();
      },
      upsertGitRoomBinding: async (input) => {
        upserts.push(input);
        return input as never;
      },
    },
  } as never);

  assert.equal(result, null);
  assert.deepEqual(childLookups, []);
  assert.deepEqual(upserts, []);
});

test("applyGitHubRefRoomLifecycle only mutates generated git focus rooms", async () => {
  const event = materializeGitHubWebhookEvent(
    "delete",
    {
      action: "delete",
      ref: "codex/GitRooms",
      ref_type: "branch",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-delete-branch-apply"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => gitFocusRoom(),
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.equal(
    isGeneratedGitRefFocusRoom(gitFocusRoom({ focus_key: "task_1", source_task_id: "task_1" })),
    false
  );
  assert.equal(
    await applyGitHubRefRoomLifecycle(
      gitFocusRoom({ focus_key: "task_1", source_task_id: "task_1" }),
      event,
      deps
    ),
    null
  );
  assert.deepEqual(calls, []);

  assert.equal(isGeneratedGitRefFocusRoom(gitFocusRoom()), true);
  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(gitFocusRoom(), event, deps),
    { mutation: "archive", applied: true }
  );
  assert.deepEqual(calls, [
    ["archive", ["github.com/brosincode/letagents", "git:branch:Y29kZXgvR2l0Um9vbXM"]],
  ]);
});

test("applyGitHubRefRoomLifecycle skips stale lifecycle events", async () => {
  const event = materializeGitHubWebhookEvent(
    "delete",
    {
      action: "delete",
      ref: "codex/GitRooms",
      ref_type: "branch",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-delete-branch-stale"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const claims: unknown[] = [];
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async (...args: unknown[]) => {
      claims.push(args);
      return null;
    },
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(gitFocusRoom(), event, deps, {
      eventOrderAt: "2026-06-28T11:00:00.000Z",
    }),
    { mutation: "archive", applied: false, skipped: "stale_event" }
  );
  assert.deepEqual(claims, [
    [
      "git-room:github.com:brosincode/letagents:branch:Y29kZXgvR2l0Um9vbXM",
      "2026-06-28T11:00:00.000Z",
    ],
  ]);
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle keeps merged branch rooms visible after delete", async () => {
  const event = materializeGitHubWebhookEvent(
    "delete",
    {
      action: "delete",
      ref: "codex/GitRooms",
      ref_type: "branch",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-delete-branch-after-merge"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const concludedRoom = gitFocusRoom({
    focus_status: "concluded",
    concluded_at: "2026-06-28T10:30:00.000Z",
    conclusion_summary: "Pull request #42 merged.",
  });
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => concludedRoom,
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(concludedRoom, event, deps, {
      eventOrderAt: "2026-06-28T11:00:00.000Z",
    }),
    { mutation: "archive", applied: false, skipped: "already_concluded" }
  );
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle does not reactivate concluded rooms", async () => {
  const event = materializeGitHubWebhookEvent(
    "create",
    {
      action: "create",
      ref: "codex/GitRooms",
      ref_type: "branch",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-create-branch-after-merge"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const concludedRoom = gitFocusRoom({
    focus_status: "concluded",
    concluded_at: "2026-06-28T10:30:00.000Z",
    conclusion_summary: "Pull request #42 merged.",
  });
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => concludedRoom,
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(concludedRoom, event, deps, {
      eventOrderAt: "2026-06-28T11:00:00.000Z",
    }),
    { mutation: "activate", applied: false, skipped: "already_concluded" }
  );
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle lets stale merged PRs conclude archived rooms", async () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "closed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        state: "closed",
        merged: true,
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-merged-after-delete"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const archivedRoom = gitFocusRoom({
    focus_archived_at: "2026-06-28T11:00:00.000Z",
    git_lifecycle_event_order_at: "2026-06-28T11:00:00.000Z",
  });
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => null,
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(archivedRoom, event, deps, {
      eventOrderAt: "2026-06-28T10:00:00.000Z",
    }),
    { mutation: "conclude", applied: true }
  );
  assert.deepEqual(calls, [
    ["activate", ["github.com/brosincode/letagents", "git:branch:Y29kZXgvR2l0Um9vbXM"]],
    [
      "conclude",
      [
        "github.com/brosincode/letagents",
        "git:branch:Y29kZXgvR2l0Um9vbXM",
        "Pull request #42 merged.",
      ],
    ],
  ]);
});

test("applyGitHubRefRoomLifecycle activates archived claimed rooms before concluding", async () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "closed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        state: "closed",
        merged: true,
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-merged-equal-order-after-delete"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const staleActiveRoom = gitFocusRoom({ focus_status: "active" });
  const currentArchivedRoom = gitFocusRoom({
    focus_archived_at: "2026-06-28T11:00:00.000Z",
    git_lifecycle_event_order_at: "2026-06-28T11:00:00.000Z",
  });
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => currentArchivedRoom,
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(staleActiveRoom, event, deps, {
      eventOrderAt: "2026-06-28T11:00:00.000Z",
    }),
    { mutation: "conclude", applied: true }
  );
  assert.deepEqual(calls, [
    ["activate", ["github.com/brosincode/letagents", "git:branch:Y29kZXgvR2l0Um9vbXM"]],
    [
      "conclude",
      [
        "github.com/brosincode/letagents",
        "git:branch:Y29kZXgvR2l0Um9vbXM",
        "Pull request #42 merged.",
      ],
    ],
  ]);
});

test("applyGitHubRefRoomLifecycle rechecks current room state for stale merged PR rescue", async () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "closed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        state: "closed",
        merged: true,
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-merged-concurrent-delete"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const activeSnapshot = gitFocusRoom();
  const currentArchivedRoom = gitFocusRoom({
    focus_archived_at: "2026-06-28T11:00:00.000Z",
    git_lifecycle_event_order_at: "2026-06-28T11:00:00.000Z",
  });
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => null,
    getProjectById: async () => currentArchivedRoom,
    hasGitHubRoomActivationEventAfter: async () => false,
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(activeSnapshot, event, deps, {
      eventOrderAt: "2026-06-28T10:00:00.000Z",
    }),
    { mutation: "conclude", applied: true }
  );
  assert.deepEqual(calls, [
    ["activate", ["github.com/brosincode/letagents", "git:branch:Y29kZXgvR2l0Um9vbXM"]],
    [
      "conclude",
      [
        "github.com/brosincode/letagents",
        "git:branch:Y29kZXgvR2l0Um9vbXM",
        "Pull request #42 merged.",
      ],
    ],
  ]);
});

test("applyGitHubRefRoomLifecycle does not let stale merged PRs conclude branch rooms with newer activation", async () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "closed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        state: "closed",
        merged: true,
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-merged-after-branch-reuse"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const activationChecks: unknown[] = [];
  const archivedRoom = gitFocusRoom({
    focus_archived_at: "2026-06-28T12:00:00.000Z",
    git_lifecycle_event_order_at: "2026-06-28T12:00:00.000Z",
  });
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => null,
    hasGitHubRoomActivationEventAfter: async (...args: unknown[]) => {
      activationChecks.push(args);
      return true;
    },
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(archivedRoom, event, deps, {
      eventOrderAt: "2026-06-28T10:00:00.000Z",
    }),
    { mutation: "conclude", applied: false, skipped: "stale_event" }
  );
  assert.deepEqual(activationChecks, [
    [
      "git-room:github.com:brosincode/letagents:branch:Y29kZXgvR2l0Um9vbXM",
      "2026-06-28T10:00:00.000Z",
    ],
  ]);
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle checks isolated event rooms for newer activation history", async () => {
  const event = materializeGitHubWebhookEvent(
    "pull_request",
    {
      action: "closed",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
      pull_request: {
        number: 42,
        title: "task_42: git room branch routing",
        html_url: "https://github.com/BrosInCode/letagents/pull/42",
        state: "closed",
        merged: true,
        head: {
          ref: "codex/GitRooms",
          sha: "abc123",
        },
        base: {
          ref: "main",
        },
      },
    },
    "delivery-pr-merged-isolated-activation"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const activationChecks: unknown[] = [];
  const archivedRoom = gitFocusRoom({
    focus_archived_at: "2026-06-28T12:00:00.000Z",
    git_lifecycle_event_order_at: "2026-06-28T12:00:00.000Z",
  });
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => null,
    hasGitHubRoomActivationEventAfter: async (...args: unknown[]) => {
      activationChecks.push(args);
      return args[0] === "focus_isolated_1";
    },
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(archivedRoom, event, deps, {
      eventOrderAt: "2026-06-28T10:00:00.000Z",
      activationEventRoomIds: ["focus_isolated_1"],
    }),
    { mutation: "conclude", applied: false, skipped: "stale_event" }
  );
  assert.deepEqual(activationChecks, [
    [
      "git-room:github.com:brosincode/letagents:branch:Y29kZXgvR2l0Um9vbXM",
      "2026-06-28T10:00:00.000Z",
    ],
    ["focus_isolated_1", "2026-06-28T10:00:00.000Z"],
  ]);
  assert.deepEqual(calls, []);
});

test("applyGitHubRefRoomLifecycle checks claimed room state before archiving", async () => {
  const event = materializeGitHubWebhookEvent(
    "delete",
    {
      action: "delete",
      ref: "codex/GitRooms",
      ref_type: "branch",
      repository: {
        id: 1,
        full_name: "BrosInCode/letagents",
        name: "letagents",
        default_branch: "main",
      },
    },
    "delivery-delete-branch-after-claimed-merge"
  );
  assert.ok(event);

  const calls: unknown[] = [];
  const staleActiveRoom = gitFocusRoom({ focus_status: "active" });
  const currentConcludedRoom = gitFocusRoom({
    focus_status: "concluded",
    concluded_at: "2026-06-28T10:30:00.000Z",
    conclusion_summary: "Pull request #42 merged.",
  });
  const deps = {
    claimGitRefFocusRoomLifecycleEvent: async () => currentConcludedRoom,
    activateFocusRoom: async (...args: unknown[]) => calls.push(["activate", args]),
    archiveFocusRoom: async (...args: unknown[]) => calls.push(["archive", args]),
    concludeFocusRoom: async (...args: unknown[]) => calls.push(["conclude", args]),
  };

  assert.deepEqual(
    await applyGitHubRefRoomLifecycle(staleActiveRoom, event, deps, {
      eventOrderAt: "2026-06-28T11:00:00.000Z",
    }),
    { mutation: "archive", applied: false, skipped: "already_concluded" }
  );
  assert.deepEqual(calls, []);
});
