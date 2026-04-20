import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerLegacyProjectTaskRoutes } = await import("../routes/legacy-project-tasks.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    requireAdmin: unused,
    requireParticipant: unused,
    normalizeOptionalString: () => null,
    enforceTaskAdmissionCoordination: unused,
    isTrustedAgentCreator: unused,
    emitTaskLifecycleStatusMessage: unused,
    validateOwnerTokenTaskActorKey: unused,
    enforceTaskCoordinationMutation: unused,
  };
}

test("registerLegacyProjectTaskRoutes preserves legacy task route order", () => {
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

  registerLegacyProjectTaskRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "post", path: "/projects/:id/tasks" },
    { method: "get", path: "/projects/:id/tasks" },
    { method: "get", path: "/projects/:id/tasks/:taskId" },
    { method: "patch", path: "/projects/:id/tasks/:taskId" },
  ]);
});
