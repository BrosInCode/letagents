import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerLegacyProjectRoutes } = await import("../routes/legacy-projects.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveRequestAuth: unused,
    resolveCanonicalRoomRequestId: unused,
    isRepoBackedRoomId: () => false,
    isRepoBackedProject: () => false,
    resolveRepoRoomAccessDecision: unused,
    replyRepoRoomAccessDecision: () => false,
    resolveProjectRole: unused,
    requireAdmin: unused,
    rememberHumanRoomParticipant: unused,
  };
}

test("registerLegacyProjectRoutes preserves project and agent management route order", () => {
  const calls: Array<{ method: "get" | "post" | "patch"; path: string }> = [];
  const app = {
    get(path: string) {
      calls.push({ method: "get", path });
    },
    post(path: string) {
      calls.push({ method: "post", path });
    },
    patch(path: string) {
      calls.push({ method: "patch", path });
    },
  };

  registerLegacyProjectRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/projects" },
    { method: "post", path: "/projects" },
    { method: "get", path: "/projects/join/:code" },
    { method: "post", path: "/projects/room/:name" },
    { method: "get", path: "/projects/:id/access" },
    { method: "post", path: "/projects/:id/code/rotate" },
    { method: "get", path: "/agents/me" },
    { method: "post", path: "/agents" },
  ]);
});
