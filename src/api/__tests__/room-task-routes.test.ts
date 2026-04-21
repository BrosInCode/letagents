import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  isCurrentStalePromptAction,
  registerRoomTaskRoutes,
} = await import("../routes/room-tasks.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    taskEvents: new EventEmitter(),
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireAdmin: unused,
    requireParticipant: unused,
    resolveProjectRole: unused,
    toRoomResponse: () => ({}),
    normalizeOptionalString: () => null,
    enforceTaskAdmissionCoordination: unused,
    isTrustedAgentCreator: unused,
    emitTaskLifecycleStatusMessage: unused,
    validateOwnerTokenTaskActorKey: unused,
    enforceTaskCoordinationMutation: unused,
    emitProjectMessage: unused,
  };
}

test("registerRoomTaskRoutes preserves canonical task route order", () => {
  const calls: Array<{ method: "delete" | "get" | "patch" | "post"; path: string }> = [];
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
    delete(path: RegExp) {
      calls.push({ method: "delete", path: path.toString() });
    },
  };

  registerRoomTaskRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "get", path: "/^\\/rooms\\/(.+)\\/tasks$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/focus-room$/" },
    { method: "post", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/stale-prompt-mute$/" },
    { method: "delete", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)\\/stale-prompt-mute$/" },
    { method: "get", path: "/^(?:\\/api)?\\/rooms\\/(.+)\\/tasks\\/github-status$/" },
    { method: "get", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/" },
    { method: "patch", path: "/^\\/rooms\\/(.+)\\/tasks\\/([^/]+)$/" },
  ]);
});

test("isCurrentStalePromptAction only allows prompts from the current task version", () => {
  assert.equal(
    isCurrentStalePromptAction({
      taskUpdatedAt: "2026-04-21T11:00:00.000Z",
      promptTimestamp: "2026-04-21T11:05:00.000Z",
    }),
    true
  );
  assert.equal(
    isCurrentStalePromptAction({
      taskUpdatedAt: "2026-04-21T11:00:00.000Z",
      promptTimestamp: "2026-04-21T10:59:59.000Z",
    }),
    false
  );
  assert.equal(
    isCurrentStalePromptAction({
      taskUpdatedAt: "2026-04-21T11:00:00.000Z",
      promptTimestamp: null,
    }),
    false
  );
});
