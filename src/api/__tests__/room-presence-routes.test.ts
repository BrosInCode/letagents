import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomPresenceRoutes } = await import("../routes/room-presence.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireAdmin: unused,
    requireParticipant: unused,
    rememberAgentRoomParticipant: unused,
    maybeEmitStaleWorkPrompt: unused,
  };
}

test("registerRoomPresenceRoutes preserves canonical presence route order", () => {
  const calls: Array<{ method: "get" | "post"; path: string }> = [];
  const app = {
    get(path: RegExp) {
      calls.push({ method: "get", path: path.toString() });
    },
    post(path: RegExp) {
      calls.push({ method: "post", path: path.toString() });
    },
  };

  registerRoomPresenceRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^(?:\\/api)?\\/rooms\\/(.+)\\/presence$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/participants$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/activity-history$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/participants\\/(?:clear|archive)-disconnected$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/presence$/" },
  ]);
});
