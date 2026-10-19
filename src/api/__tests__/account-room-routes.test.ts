import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerAccountRoomRoutes } = await import("../routes/account/rooms.js");
const { generateRoomDisplayName } = await import("../rooms/display-name.js");
const { resolveAccountRoomAliasIdentifier } = await import("../../../apps/desktop/renderer/src/domain/sidebar-rooms.js");
import type { DesktopAccountRoomEntry } from "../../../apps/desktop/electron/ipc-types.js";

type Handler = (req: Record<string, any>, res: Record<string, any>) => Promise<void>;

function captureAccountRoomHandlers(): {
  deleteHandler: () => Handler;
  getHandler: () => Handler;
  patchHandler: () => Handler;
  postHandler: () => Handler;
} & Record<string, unknown> {
  let getRouteHandler: Handler | undefined;
  let postRouteHandler: Handler | undefined;
  let patchRouteHandler: Handler | undefined;
  let deleteRouteHandler: Handler | undefined;
  return {
    get(path: string, handler: Handler) {
      assert.equal(path, "/account/rooms");
      getRouteHandler = handler;
    },
    post(path: RegExp, handler: Handler) {
      assert.equal(path.source, "^\\/account\\/rooms\\/(.+)\\/leave$");
      postRouteHandler = handler;
    },
    patch(path: RegExp, handler: Handler) {
      assert.equal(path.source, "^\\/account\\/rooms\\/(.+)$");
      patchRouteHandler = handler;
    },
    delete(path: RegExp, handler: Handler) {
      assert.equal(path.source, "^\\/account\\/rooms\\/(.+)$");
      deleteRouteHandler = handler;
    },
    deleteHandler() {
      assert.ok(deleteRouteHandler);
      return deleteRouteHandler;
    },
    getHandler() {
      assert.ok(getRouteHandler);
      return getRouteHandler;
    },
    postHandler() {
      assert.ok(postRouteHandler);
      return postRouteHandler;
    },
    patchHandler() {
      assert.ok(patchRouteHandler);
      return patchRouteHandler;
    },
  };
}

function responseStub() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

test("account room route requires authentication", async () => {
  const app = captureAccountRoomHandlers();
  registerAccountRoomRoutes(app as never, {
    archiveAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    deleteAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    updateAccountRoomPreferences: async () => {
      throw new Error("not invoked");
    },
    getAccountRoomsForAccount: async () => {
      throw new Error("not invoked");
    },
  });

  const res = responseStub();
  await app.getHandler()({ query: {}, sessionAccount: null }, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Authentication required" });
});

test("account listing resolves generated project aliases while retaining explicit room and focus names", async () => {
  const app = captureAccountRoomHandlers();
  const repo = "github.com/brosincode/letagents";
  const room = { room_id: repo, kind: "main", display_name: generateRoomDisplayName(repo),
    focus_rooms: [{ room_id: "focus_123", kind: "focus", display_name: "Focus: Launch" }] };
  registerAccountRoomRoutes(app as never, {
    getAccountRoomsForAccount: async () => [room,
      { room_id: "github.com/team/custom", kind: "main", display_name: "Release planning", focus_rooms: [] },
      { room_id: "ABCD-1234", kind: "main", display_name: "Design team", focus_rooms: [] },
      { room_id: "github.com/team/new-project", kind: "main", display_name: "new-project", focus_rooms: [] }] as never,
    getGitRoomBindingsForRooms: async () => new Map(),
    archiveAccountRoomForAccount: async () => null,
    deleteAccountRoomForAccount: async () => null,
    updateAccountRoomPreferences: async () => null,
  });
  const res = responseStub();
  await app.getHandler()({ query: {}, sessionAccount: { account_id: "account", login: "EmmyMay" } }, res);
  assert.equal(res.statusCode, 200);
  const rooms = (res.body as { rooms: Array<{ room_id: string; id: string; name: string; display_name: string; focus_rooms: Array<{ display_name: string }> }> }).rooms;
  assert.deepEqual(rooms.map((entry) => entry.display_name), ["letagents", "Release planning", "Design team", "new-project"]);
  assert.equal(rooms[0].room_id, repo);
  assert.equal(rooms[0].id, repo);
  assert.equal(rooms[0].name, "sky-lake");
  assert.equal(rooms[1].name, "github.com/team/custom");
  assert.equal(rooms[2].name, "ABCD-1234");
  assert.equal(rooms[3].name, "github.com/team/new-project");
  assert.equal(rooms[0].focus_rooms[0].display_name, "Focus: Launch");
  // Same identity/name mapping used by Electron, consumed by the unchanged
  // alias resolver shipped in older desktop releases.
  const clientRooms = rooms.map((entry) => ({
    roomIdentifier: entry.room_id, displayName: entry.display_name, name: entry.name,
  })) as DesktopAccountRoomEntry[];
  assert.equal(resolveAccountRoomAliasIdentifier("sky-lake", clientRooms), repo);
  assert.equal(resolveAccountRoomAliasIdentifier(repo, clientRooms), null);
  assert.equal(resolveAccountRoomAliasIdentifier("Release planning", clientRooms), "github.com/team/custom");
  assert.equal(resolveAccountRoomAliasIdentifier("sky-lake", [...clientRooms,
    { roomIdentifier: "other-room", displayName: "sky-lake", name: "other-room" } as DesktopAccountRoomEntry]), null);
  assert.equal(resolveAccountRoomAliasIdentifier("sky-lake", [...clientRooms,
    { roomIdentifier: "sky-lake", displayName: "Exact room", name: "sky-lake" } as DesktopAccountRoomEntry]), null);
});

test("account room route returns parent rooms with nested focus rooms", async () => {
  const app = captureAccountRoomHandlers();
  const calls: unknown[] = [];
  const bindingCalls: string[][] = [];
  const branchRoomId = "focus_37";
  registerAccountRoomRoutes(app as never, {
    archiveAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    deleteAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    updateAccountRoomPreferences: async () => {
      throw new Error("not invoked");
    },
    async getGitRoomBindingsForRooms(roomIds) {
      bindingCalls.push(roomIds);
      return new Map([
        [
          branchRoomId,
          {
            room_id: branchRoomId,
            provider: "github",
            host: "github.com",
            repository_id: "repo_1",
            repository_owner: "owner",
            repository_name: "repo",
            repository_full_name: "owner/repo",
            ref_type: "branch",
            ref_name: "codex/GitRooms",
            default_branch: "main",
            base_ref: "main",
            head_ref: "codex/GitRooms",
            head_repository_id: null,
            head_repository_full_name: null,
            head_repository_owner: null,
            head_repository_name: null,
            visibility: "public",
            is_default: false,
            source: "webhook",
            created_at: "2026-05-02T11:00:00.000Z",
            updated_at: "2026-05-02T11:00:00.000Z",
          },
        ],
        [
          "github.com/owner/repo",
          {
            room_id: "github.com/owner/repo",
            provider: "github",
            host: "github.com",
            repository_id: "repo_1",
            repository_owner: "owner",
            repository_name: "repo",
            repository_full_name: "owner/repo",
            ref_type: "default_branch",
            ref_name: "main",
            default_branch: "main",
            base_ref: null,
            head_ref: null,
            head_repository_id: null,
            head_repository_full_name: null,
            head_repository_owner: null,
            head_repository_name: null,
            visibility: "public",
            is_default: true,
            source: "github_repository",
            created_at: "2026-05-01T10:00:00.000Z",
            updated_at: "2026-05-01T10:00:00.000Z",
          },
        ],
      ]) as never;
    },
    async getAccountRoomsForAccount(accountId, options) {
      calls.push({ accountId, options });
      return [
        {
          room_id: "github.com/owner/repo",
          display_name: "owner/repo",
          kind: "main",
          role: "admin",
          source: "admin",
          pinned: false,
          archived: false,
          can_leave: true,
          can_delete: true,
          delete_reason: null,
          first_opened_at: "2026-05-01T10:00:00.000Z",
          last_opened_at: "2026-05-02T10:00:00.000Z",
          latest_message_id: "msg_14",
          latest_message_at: "2026-05-02T10:05:00.000Z",
          focus_rooms: [
            {
              room_id: "github.com/owner/repo/focus/task_1",
              display_name: "Focus: task_1",
              kind: "focus",
              parent_room_id: "github.com/owner/repo",
              focus_key: "task_1",
              source_task_id: "task_1",
              focus_status: "active",
              role: "participant",
              source: "participant",
              first_opened_at: "2026-05-02T09:00:00.000Z",
              last_opened_at: "2026-05-02T09:30:00.000Z",
              latest_message_id: "msg_3",
              latest_message_at: "2026-05-02T09:32:00.000Z",
            },
            {
              room_id: branchRoomId,
              display_name: "Branch: codex/GitRooms",
              kind: "focus",
              parent_room_id: "github.com/owner/repo",
              focus_key: "git:branch:Y29kZXgvR2l0Um9vbXM",
              source_task_id: null,
              focus_status: "active",
              role: "admin",
              source: null,
              first_opened_at: null,
              last_opened_at: null,
              latest_message_id: "msg_12",
              latest_message_at: "2026-05-02T10:02:00.000Z",
            },
          ],
        },
      ];
    },
  });

  const res = responseStub();
  await app.getHandler()(
    {
      query: { limit: "25", include_archived: "true" },
      sessionAccount: {
        account_id: "acct_1",
        login: "EmmyMay",
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    {
      accountId: "acct_1",
      options: {
        login: "EmmyMay",
        limit: 25,
        includeArchived: true,
      },
    },
  ]);
  assert.deepEqual(bindingCalls, [
    [
      "github.com/owner/repo",
      "github.com/owner/repo/focus/task_1",
      branchRoomId,
    ],
  ]);
  assert.deepEqual(res.body, {
    rooms: [
      {
        room_id: "github.com/owner/repo",
        id: "github.com/owner/repo",
        display_name: "owner/repo",
        name: "github.com/owner/repo",
        kind: "main",
        parent_room_id: null,
        focus_key: null,
        source_task_id: null,
        focus_status: null,
        role: "admin",
        source: "admin",
        pinned: false,
        archived: false,
        can_leave: true,
        can_delete: true,
        delete_reason: null,
        first_opened_at: "2026-05-01T10:00:00.000Z",
        last_opened_at: "2026-05-02T10:00:00.000Z",
        latest_message_id: "msg_14",
        latest_message_at: "2026-05-02T10:05:00.000Z",
        git_room: {
          room_id: "github.com/owner/repo",
          provider: "github",
          host: "github.com",
          repository: {
            id: "repo_1",
            owner: "owner",
            name: "repo",
            full_name: "owner/repo",
          },
          ref: {
            type: "default_branch",
            name: "main",
            default_branch: "main",
            base_ref: null,
            head_ref: null,
            head_repository: null,
            is_default: true,
          },
          visibility: "public",
          access_mode: "public",
          source: "github_repository",
          updated_at: "2026-05-01T10:00:00.000Z",
        },
        focus_rooms: [
          {
            room_id: "github.com/owner/repo/focus/task_1",
            id: "github.com/owner/repo/focus/task_1",
            display_name: "Focus: task_1",
            name: "github.com/owner/repo/focus/task_1",
            kind: "focus",
            parent_room_id: "github.com/owner/repo",
            focus_key: "task_1",
            source_task_id: "task_1",
            focus_status: "active",
            role: "participant",
            source: "participant",
            first_opened_at: "2026-05-02T09:00:00.000Z",
            last_opened_at: "2026-05-02T09:30:00.000Z",
            latest_message_id: "msg_3",
            latest_message_at: "2026-05-02T09:32:00.000Z",
          },
          {
            room_id: branchRoomId,
            id: branchRoomId,
            display_name: "Branch: codex/GitRooms",
            name: branchRoomId,
            kind: "focus",
            parent_room_id: "github.com/owner/repo",
            focus_key: "git:branch:Y29kZXgvR2l0Um9vbXM",
            source_task_id: null,
            focus_status: "active",
            role: "admin",
            source: null,
            first_opened_at: null,
            last_opened_at: null,
            latest_message_id: "msg_12",
            latest_message_at: "2026-05-02T10:02:00.000Z",
            git_room: {
              room_id: branchRoomId,
              provider: "github",
              host: "github.com",
              repository: {
                id: "repo_1",
                owner: "owner",
                name: "repo",
                full_name: "owner/repo",
              },
              ref: {
                type: "branch",
                name: "codex/GitRooms",
                default_branch: "main",
                base_ref: "main",
                head_ref: "codex/GitRooms",
                head_repository: null,
                is_default: false,
              },
              visibility: "public",
              access_mode: "public",
              source: "webhook",
              updated_at: "2026-05-02T11:00:00.000Z",
            },
          },
        ],
      },
    ],
  });
});

test("account room route derives Git Room metadata when repo binding is missing", async () => {
  const app = captureAccountRoomHandlers();
  const bindingCalls: string[][] = [];
  registerAccountRoomRoutes(app as never, {
    archiveAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    deleteAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    updateAccountRoomPreferences: async () => {
      throw new Error("not invoked");
    },
    async getGitRoomBindingsForRooms(roomIds) {
      bindingCalls.push(roomIds);
      return new Map();
    },
    async getAccountRoomsForAccount() {
      return [
        {
          room_id: "github.com/owner/repo",
          display_name: "owner/repo",
          kind: "main",
          role: "participant",
          source: "participant",
          pinned: false,
          archived: false,
          can_leave: true,
          can_delete: false,
          delete_reason: "participant",
          first_opened_at: "2026-05-01T10:00:00.000Z",
          last_opened_at: "2026-05-02T10:00:00.000Z",
          latest_message_id: null,
          latest_message_at: null,
          focus_rooms: [],
        },
      ];
    },
  });

  const res = responseStub();
  await app.getHandler()(
    {
      query: {},
      sessionAccount: {
        account_id: "acct_1",
        login: "EmmyMay",
      },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(bindingCalls, [["github.com/owner/repo"]]);
  assert.equal(
    (res.body as { rooms: Array<{ git_room?: { source?: string } }> })
      .rooms[0]?.git_room?.source,
    "manual"
  );
  assert.deepEqual(
    (res.body as { rooms: Array<{ git_room?: unknown }> }).rooms[0]?.git_room,
    {
      room_id: "github.com/owner/repo",
      provider: "github",
      host: "github.com",
      repository: {
        id: null,
        owner: "owner",
        name: "repo",
        full_name: "owner/repo",
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
});

test("leave route archives the account room", async () => {
  const app = captureAccountRoomHandlers();
  const calls: unknown[] = [];
  registerAccountRoomRoutes(app as never, {
    async archiveAccountRoomForAccount(input) {
      calls.push(input);
      return { room_id: input.roomId, archived: true, pinned: false };
    },
    deleteAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    updateAccountRoomPreferences: async () => {
      throw new Error("not invoked");
    },
    getAccountRoomsForAccount: async () => {
      throw new Error("not invoked");
    },
  });

  const res = responseStub();
  await app.postHandler()(
    {
      params: { 0: encodeURIComponent("github.com/owner/repo") },
      sessionAccount: { account_id: "acct_1", login: "EmmyMay" },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    { accountId: "acct_1", roomId: "github.com/owner/repo", login: "EmmyMay" },
  ]);
  assert.deepEqual(res.body, {
    room_id: "github.com/owner/repo",
    archived: true,
    pinned: false,
  });
});

test("patch route updates account room preferences", async () => {
  const app = captureAccountRoomHandlers();
  const calls: unknown[] = [];
  registerAccountRoomRoutes(app as never, {
    archiveAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    deleteAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    getAccountRoomsForAccount: async () => {
      throw new Error("not invoked");
    },
    async updateAccountRoomPreferences(input) {
      calls.push(input);
      return {
        room_id: input.roomId,
        pinned: input.pinned === true,
        archived: input.archived === true,
      };
    },
  });

  const res = responseStub();
  await app.patchHandler()(
    {
      body: { pinned: true, archived: false },
      params: { 0: encodeURIComponent("github.com/owner/repo") },
      sessionAccount: { account_id: "acct_1", login: "EmmyMay" },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    {
      accountId: "acct_1",
      roomId: "github.com/owner/repo",
      login: "EmmyMay",
      pinned: true,
      archived: false,
    },
  ]);
  assert.deepEqual(res.body, {
    room_id: "github.com/owner/repo",
    pinned: true,
    archived: false,
  });
});

test("delete route blocks rooms the account cannot delete", async () => {
  const app = captureAccountRoomHandlers();
  registerAccountRoomRoutes(app as never, {
    archiveAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    updateAccountRoomPreferences: async () => {
      throw new Error("not invoked");
    },
    async deleteAccountRoomForAccount(input) {
      return {
        room_id: input.roomId,
        deleted: false,
        error: "forbidden",
        reason: "LetAgents can only delete invite rooms this account created.",
      };
    },
    getAccountRoomsForAccount: async () => {
      throw new Error("not invoked");
    },
  });

  const res = responseStub();
  await app.deleteHandler()(
    {
      params: { 0: encodeURIComponent("github.com/owner/repo") },
      sessionAccount: { account_id: "acct_1", login: "EmmyMay" },
    },
    res
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "LetAgents can only delete invite rooms this account created.",
  });
});

test("delete route deletes account-owned invite rooms", async () => {
  const app = captureAccountRoomHandlers();
  const calls: unknown[] = [];
  registerAccountRoomRoutes(app as never, {
    archiveAccountRoomForAccount: async () => {
      throw new Error("not invoked");
    },
    updateAccountRoomPreferences: async () => {
      throw new Error("not invoked");
    },
    async deleteAccountRoomForAccount(input) {
      calls.push(input);
      return {
        room_id: input.roomId,
        deleted: true,
      };
    },
    getAccountRoomsForAccount: async () => {
      throw new Error("not invoked");
    },
  });

  const res = responseStub();
  await app.deleteHandler()(
    {
      params: { 0: "ABCD-1234" },
      sessionAccount: { account_id: "acct_1" },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    { accountId: "acct_1", roomId: "ABCD-1234" },
  ]);
  assert.deepEqual(res.body, {
    room_id: "ABCD-1234",
    deleted: true,
  });
});
