import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerAccountRoomRoutes } = await import("../routes/account/rooms.js");

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

test("account room route returns parent rooms with nested focus rooms", async () => {
  const app = captureAccountRoomHandlers();
  const calls: unknown[] = [];
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
          },
        ],
      },
    ],
  });
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
