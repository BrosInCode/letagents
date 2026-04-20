import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomJoinRoutes } = await import("../routes/room-join.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    isRepoBackedRoomId: () => false,
    resolveRepoRoomAccessDecision: unused,
    replyRepoRoomAccessDecision: () => false,
    resolveRoomOrReply: unused,
    getProjectAccessRoomId: () => "room",
    isRepoBackedProject: () => false,
    resolveProjectRole: unused,
    rememberHumanRoomParticipant: unused,
    toRoomResponse: () => ({}),
  };
}

test("registerRoomJoinRoutes preserves canonical join route order", () => {
  const calls: Array<{ method: "post"; path: string }> = [];
  const app = {
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
  };

  registerRoomJoinRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "post", path: "/^\\/rooms\\/(.+)\\/join$/" },
  ]);
});

test("join route applies repo access denial before resolving room", async () => {
  let handler: ((req: Record<string, unknown>, res: Record<string, unknown>) => Promise<void>) | undefined;
  const app = {
    post(_path: RegExp, registeredHandler: typeof handler) {
      handler = registeredHandler;
    },
  };
  const response = {
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

  registerRoomJoinRoutes(app as never, {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    isRepoBackedRoomId: () => true,
    resolveRepoRoomAccessDecision: async () => ({ kind: "auth_required" as const }),
    replyRepoRoomAccessDecision: (res, roomName) => {
      res.status(401).json({ error: "auth_required", room_id: roomName });
      return false;
    },
    resolveRoomOrReply: async () => {
      throw new Error("resolveRoomOrReply should not be called");
    },
  } as never);

  assert.ok(handler);
  await handler(
    {
      params: { 0: "github.com/Owner/Repo" },
      headers: {},
      socket: { remoteAddress: "192.0.2.16" },
      sessionAccount: null,
    },
    response as never
  );

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, {
    error: "auth_required",
    room_id: "github.com/owner/repo",
  });
});
