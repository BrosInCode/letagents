import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomMetadataRoutes } = await import("../routes/rooms/metadata.js");

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: unused,
    resolveRoomOrReply: unused,
    requireAdmin: unused,
    updateProjectDisplayName: unused,
    resolveProjectRole: unused,
    toRoomResponse: () => ({}),
  };
}

test("registerRoomMetadataRoutes preserves canonical metadata route order", () => {
  const calls: Array<{ method: "patch"; path: string }> = [];
  const app = {
    patch(path: RegExp) {
      calls.push({ method: "patch", path: path.toString() });
    },
  };

  registerRoomMetadataRoutes(app as never, createDeps() as never);

  assert.deepEqual(calls, [
    { method: "patch", path: "/^\\/rooms\\/(.+)$/" },
  ]);
});

test("metadata update response includes Git Room binding when present", async () => {
  let handler:
    | ((req: Record<string, unknown>, res: Record<string, unknown>) => Promise<void>)
    | undefined;
  const app = {
    patch(_path: RegExp, registeredHandler: typeof handler) {
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
  const project = {
    id: "github.com/brosincode/letagents",
    display_name: "letagents",
  };
  const updatedProject = {
    ...project,
    display_name: "LetAgents",
  };
  const binding = {
    room_id: project.id,
    repository_full_name: "brosincode/letagents",
  };

  registerRoomMetadataRoutes(app as never, {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => project as never,
    requireAdmin: async () => true,
    updateProjectDisplayName: async (projectId, displayName) => {
      assert.equal(projectId, project.id);
      assert.equal(displayName, "LetAgents");
      return updatedProject as never;
    },
    resolveProjectRole: async () => "admin",
    getGitRoomBindingForRoom: async (roomId) =>
      roomId === project.id ? binding as never : null,
    toRoomResponse: (_project, options) => ({
      id: updatedProject.id,
      role: options?.role,
      authenticated: options?.authenticated,
      gitRoomBinding: options?.gitRoomBinding,
    }),
  } as never);

  assert.ok(handler);
  await handler(
    {
      params: { 0: project.id },
      body: { display_name: "LetAgents" },
      sessionAccount: { account_id: "acct_1" },
    },
    response as never
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    id: project.id,
    role: "admin",
    authenticated: true,
    gitRoomBinding: binding,
  });
});
