import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerAccountRoomRoutes } = await import("../routes/account-rooms.js");

type Handler = (req: Record<string, any>, res: Record<string, any>) => Promise<void>;

function captureGetHandler(): { handler: () => Handler } & Record<string, unknown> {
  let routeHandler: Handler | undefined;
  return {
    get(path: string, handler: Handler) {
      assert.equal(path, "/account/rooms");
      routeHandler = handler;
    },
    handler() {
      assert.ok(routeHandler);
      return routeHandler;
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
  const app = captureGetHandler();
  registerAccountRoomRoutes(app as never, {
    getAccountRoomsForAccount: async () => {
      throw new Error("not invoked");
    },
  });

  const res = responseStub();
  await app.handler()({ query: {}, sessionAccount: null }, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Authentication required" });
});

test("account room route returns parent rooms with nested focus rooms", async () => {
  const app = captureGetHandler();
  const calls: unknown[] = [];
  registerAccountRoomRoutes(app as never, {
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
  await app.handler()(
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
