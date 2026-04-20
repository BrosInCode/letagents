import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomFocusRoutes } = await import("../routes/room-focus.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireParticipant: unused,
    resolveProjectRole: unused,
    toRoomResponse: () => ({}),
    normalizeOptionalString: () => null,
    enforceFocusRoomConclusion: unused,
    emitProjectMessage: unused,
    formatFocusRoomConclusionMessage: () => "",
  };
}

test("registerRoomFocusRoutes preserves canonical Focus Room route order", () => {
  const calls: Array<{ method: "get" | "patch" | "post"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
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
    { method: "post", path: "/^\\/rooms\\/(.+)\\/focus\\/([^/]+)\\/conclude$/" },
  ]);
});
