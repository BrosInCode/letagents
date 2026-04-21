import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomReasoningRoutes } = await import("../routes/room-reasoning.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireParticipant: unused,
  };
}

test("registerRoomReasoningRoutes preserves canonical route order", () => {
  const calls: Array<{ method: "get" | "post" | "patch"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
    patch(path: RegExp) {
      calls.push({ method: "patch", path: path.toString() });
    },
  };

  registerRoomReasoningRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^\\/rooms\\/(.+)\\/reasoning$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)$/" },
    { method: "patch", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/reasoning-sessions\\/([^/]+)\\/updates$/" },
  ]);
});
