import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomFocusRoutes } = await import("../routes/rooms/focus.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireParticipant: unused,
    requireAdmin: unused,
    resolveProjectRole: unused,
    toRoomResponse: () => ({}),
    normalizeOptionalString: () => null,
    enforceFocusRoomConclusion: unused,
    emitProjectMessage: unused,
    formatFocusRoomConclusionMessage: () => "",
  };
}

test("registerRoomFocusRoutes preserves canonical Focus Room route order", () => {
  const calls: Array<{ method: "delete" | "get" | "patch" | "post"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    delete(path: RegExp) {
      calls.push({ method: "delete", path: path.toString() });
    },
    patch(path: RegExp) {
      calls.push({ method: "patch", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
  };

  registerRoomFocusRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)$/" },
    { method: "patch", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)\\/settings$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/focus-rooms$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/focus-rooms$/" },
    { method: "delete", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)\\/conclude$/" },
  ]);
});

test("focus room archive route requires an admin guard", async () => {
  let deleteHandler: ((req: unknown, res: unknown) => Promise<void>) | null = null;
  let requireAdminCalled = false;
  let requireParticipantCalled = false;
  const app = {
    get() {},
    patch() {},
    post() {},
    delete(_path: RegExp, handler: (req: unknown, res: unknown) => Promise<void>) {
      deleteHandler = handler;
    },
  };
  const deps = {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireAdmin: async () => {
      requireAdminCalled = true;
      return false;
    },
    requireParticipant: async () => {
      requireParticipantCalled = true;
      return false;
    },
  };

  registerRoomFocusRoutes(app as never, deps as never);
  assert.ok(deleteHandler);

  await deleteHandler(
    { params: { 0: "room_1", 1: "focus_1" } },
    { status: () => ({ json: () => undefined }), json: () => undefined },
  );

  assert.equal(requireAdminCalled, true);
  assert.equal(requireParticipantCalled, false);
});
