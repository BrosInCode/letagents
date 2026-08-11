import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const {
  buildLegacyProjectRoomResponse,
  registerLegacyProjectRoutes,
} = await import("../routes/legacy/projects.js");

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
    resolveProjectRepoRoomAccessDecision: async () => ({
      isRepoBacked: false,
      roomName: null,
      repoRoomName: null,
      binding: null,
      decision: { kind: "allow" as const },
    }),
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

test("buildLegacyProjectRoomResponse adds Git Room metadata for repo rooms", () => {
  assert.deepEqual(
    buildLegacyProjectRoomResponse({
      id: "github.com/brosincode/letagents",
      code: null,
      name: "github.com/brosincode/letagents",
      display_name: "BrosInCode/letagents",
    }),
    {
      id: "github.com/brosincode/letagents",
      code: null,
      name: "github.com/brosincode/letagents",
      display_name: "BrosInCode/letagents",
      git_room: {
        room_id: "github.com/brosincode/letagents",
        provider: "github",
        host: "github.com",
        repository: {
          id: null,
          owner: "brosincode",
          name: "letagents",
          full_name: "brosincode/letagents",
        },
        ref: {
          type: "default_branch",
          name: null,
          default_branch: null,
          base_ref: null,
          head_ref: null,
          head_repository: null,
          is_default: true,
        },
        visibility: "unknown",
        access_mode: "unknown",
        source: "manual",
        updated_at: null,
      },
    }
  );
});

test("agent identity registration rejects labels that cannot be routed in messages", async () => {
  let handler: ((req: Record<string, unknown>, res: Record<string, unknown>) => Promise<void>) | undefined;
  const app = {
    get() {},
    patch() {},
    post(path: string, candidate: typeof handler) {
      if (path === "/agents") handler = candidate;
    },
  };
  registerLegacyProjectRoutes(app as never, createDeps() as never);
  assert.ok(handler);

  let statusCode = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  };
  await handler({
    sessionAccount: {
      account_id: "acct_owner",
      login: "owner",
      display_name: "Owner",
    },
    body: { name: "worker", display_name: "x".repeat(2_049) },
  }, response as never);

  assert.equal(statusCode, 400);
  assert.deepEqual(body, {
    error: "Agent identity fields exceed the supported message-routing bounds.",
  });
});
