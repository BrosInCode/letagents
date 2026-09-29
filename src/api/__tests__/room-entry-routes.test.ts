import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  buildApiRoomResolvePayload,
  buildPublicRoomResolvePayload,
  buildRoomEntryPath,
  registerRoomEntryRoutes,
} = await import("../routes/rooms/entry.js");

function createDeps() {
  return {
    getProjectById: async () => null,
    resolveExistingRoomRequest: async () => null,
    isRepoBackedRoomId: () => false,
    resolveGitHubRoomEntryDecision: async () => ({ kind: "allow" as const }),
    resolveProjectRoomEntryDecision: async () => ({ kind: "allow" as const }),
  };
}

test("registerRoomEntryRoutes preserves public entry route order", () => {
  const calls: Array<{ method: "get"; path: string }> = [];
  const app = {
    get(path: RegExp | string) {
      calls.push({ method: "get", path: path.toString() });
    },
  };

  registerRoomEntryRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^\\/api\\/rooms\\/resolve\\/(.+)$/" },
    { method: "get", path: "/:provider/:owner/:repo" },
    { method: "get", path: "/^\\/in\\/(.+)$/" },
    { method: "get", path: "/rooms/resolve/:identifier" },
  ]);
});

test("buildRoomEntryPath preserves the original room query string", () => {
  assert.equal(
    buildRoomEntryPath(
      "github.com/brosincode/letagents",
      "/in/github.com/BrosInCode/letagents?view=board"
    ),
    "/in/github.com/brosincode/letagents?view=board"
  );

  assert.equal(
    buildRoomEntryPath("github.com/brosincode/letagents", "/in/github.com/BrosInCode/letagents"),
    "/in/github.com/brosincode/letagents"
  );
});

test("focus locator entry redirects to the canonical opaque room id", async () => {
  const handlers: Array<(req: any, res: any) => Promise<void> | void> = [];
  const app = {
    get(_path: RegExp | string, handler: (req: any, res: any) => Promise<void> | void) {
      handlers.push(handler);
    },
  };
  registerRoomEntryRoutes(app as never, {
    ...createDeps(),
    resolveExistingRoomRequest: async () => ({ id: "focus_37" }) as never,
  } as never);

  let redirect: { status: number; location: string } | null = null;
  await handlers[2]?.({
    params: { 0: "github.com/owner/repo/focus/git:branch:RmVhdHVyZQ" },
    originalUrl: "/in/github.com/owner/repo/focus/git:branch:RmVhdHVyZQ?tab=chat",
    sessionAccount: null,
  }, {
    redirect(status: number, location: string) { redirect = { status, location }; },
  });

  assert.deepEqual(redirect, { status: 301, location: "/in/focus_37?tab=chat" });
});

test("public room resolution hands a focus locator off as its canonical room id", async () => {
  const payload = await buildPublicRoomResolvePayload(
    "github.com/owner/repo/focus/git:branch:RmVhdHVyZQ",
    {
      resolveExistingRoomRequest: async () => ({ id: "focus_37" }) as never,
      getGitRoomBindingForRoom: async () => null,
    },
  );

  assert.equal(payload.canonical_room_id, "focus_37");
  assert.equal(payload.room_exists, true);
});

test("buildApiRoomResolvePayload includes public persisted Git Room metadata", async () => {
  const payload = await buildApiRoomResolvePayload(
    "github.com/BrosInCode/letagents",
    {
      resolveExistingRoomRequest: async () => ({
        id: "github.com/brosincode/letagents",
      }) as never,
      getGitRoomBindingForRoom: async (roomId) => {
        assert.equal(roomId, "github.com/brosincode/letagents");
        return {
          room_id: roomId,
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
          visibility: "public",
          is_default: true,
          source: "github_repository",
          created_at: "2026-04-20T00:00:00.000Z",
          updated_at: "2026-04-21T00:00:00.000Z",
        };
      },
    }
  );

  assert.equal(payload.canonical_room_id, "github.com/brosincode/letagents");
  assert.deepEqual(payload.git_room, {
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
    visibility: "public",
    access_mode: "public",
    source: "github_repository",
    updated_at: "2026-04-21T00:00:00.000Z",
  });
});

test("buildApiRoomResolvePayload redacts private persisted Git Room metadata", async () => {
  const payload = await buildApiRoomResolvePayload(
    "github.com/BrosInCode/letagents",
    {
      resolveExistingRoomRequest: async () => ({
        id: "github.com/brosincode/letagents",
      }) as never,
      getGitRoomBindingForRoom: async (roomId) => ({
        room_id: roomId,
        provider: "github",
        host: "github.com",
        repository_id: "repo_private",
        repository_owner: "BrosInCode",
        repository_name: "letagents",
        repository_full_name: "BrosInCode/letagents",
        ref_type: "branch",
        ref_name: "codex/private-branch",
        default_branch: "staging",
        base_ref: "staging",
        head_ref: "codex/private-branch",
        head_repository_id: "fork_private",
        head_repository_full_name: "Contributor/letagents",
        head_repository_owner: "Contributor",
        head_repository_name: "letagents",
        visibility: "private",
        is_default: false,
        source: "github_webhook",
        created_at: "2026-04-20T00:00:00.000Z",
        updated_at: "2026-04-21T00:00:00.000Z",
      }),
    }
  );

  assert.deepEqual(payload.git_room, {
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
  });
});

test("buildPublicRoomResolvePayload derives Git Room metadata for repo-shaped rooms", async () => {
  const payload = await buildPublicRoomResolvePayload(
    "https://github.com/BrosInCode/letagents.git",
    {
      resolveExistingRoomRequest: async () => null,
      getGitRoomBindingForRoom: async () => null,
    }
  );

  assert.equal(payload.canonical_room_id, "github.com/brosincode/letagents");
  assert.deepEqual(payload.git_room, {
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
  });
});
