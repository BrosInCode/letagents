import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomJoinRoutes } = await import("../routes/rooms/join.js");
const { buildGitHubRefRoomLocator } = await import("../github/git-room-routing.js");

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
    resolveProjectRepoRoomAccessDecision: async () => ({
      isRepoBacked: false,
      roomName: null,
      repoRoomName: null,
      binding: null,
      decision: { kind: "allow" as const },
    }),
    resolveProjectRole: unused,
    rememberHumanRoomParticipant: unused,
    rememberAccountRoom: unused,
    assignInitialProjectAdmin: unused,
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

test("join route can resolve existing rooms without creating missing ones", async () => {
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
  const resolveOptions: unknown[] = [];
  const project = {
    id: "focus_37",
    display_name: "Branch: codex",
  };

  registerRoomJoinRoutes(app as never, {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    isRepoBackedRoomId: () => false,
    resolveRepoRoomAccessDecision: async () => ({ kind: "allow" as const }),
    resolveRoomOrReply: async (_roomId, _res, options) => {
      resolveOptions.push(options);
      return project as never;
    },
    getProjectAccessRoomId: () => project.id,
    resolveProjectRole: async () => "anonymous",
    toRoomResponse: () => ({ room_id: project.id }),
  } as never);

  assert.ok(handler);
  await handler(
    {
      params: { 0: project.id },
      query: { create: "false" },
      headers: {},
      socket: { remoteAddress: "192.0.2.21" },
      sessionAccount: null,
    },
    response as never
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(resolveOptions, [{ allowCreate: false }]);
  assert.deepEqual(response.body, { room_id: project.id });
});

test("join route denies binding-backed projects after room resolution", async () => {
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
  const project = {
    id: "focus_27",
    display_name: "Git Room",
  };

  registerRoomJoinRoutes(app as never, {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    isRepoBackedRoomId: () => false,
    resolveRoomOrReply: async () => project as never,
    getProjectAccessRoomId: () => project.id,
    resolveProjectRepoRoomAccessDecision: async () => ({
      isRepoBacked: true,
      roomName: project.id,
      repoRoomName: "github.com/BrosInCode/letagents",
      binding: null,
      decision: { kind: "auth_required" as const },
    }),
    replyRepoRoomAccessDecision: (res, roomName) => {
      res.status(401).json({ error: "auth_required", room_id: roomName });
      return false;
    },
    resolveProjectRole: async () => {
      throw new Error("resolveProjectRole should not be called after denial");
    },
  } as never);

  assert.ok(handler);
  await handler(
    {
      params: { 0: "focus_27" },
      headers: {},
      socket: { remoteAddress: "192.0.2.18" },
      sessionAccount: null,
    },
    response as never
  );

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, {
    error: "auth_required",
    room_id: "focus_27",
  });
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

test("join route applies repo access denial before resolving a contextual Git ref locator", async () => {
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
  const roomId = buildGitHubRefRoomLocator({
    repositoryFullName: "BrosInCode/private-repo",
    refType: "branch",
    refName: "feature/private-room",
  });
  const accessChecks: string[] = [];

  registerRoomJoinRoutes(app as never, {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (value: string) => value,
    isRepoBackedRoomId: () => false,
    resolveRepoRoomAccessDecision: async ({ roomName }) => {
      accessChecks.push(roomName);
      return { kind: "auth_required" as const };
    },
    replyRepoRoomAccessDecision: (res, roomName) => {
      res.status(401).json({ error: "auth_required", room_id: roomName });
      return false;
    },
    resolveRoomOrReply: async () => {
      throw new Error("resolveRoomOrReply should not be called before Git ref access denial");
    },
  } as never);

  assert.ok(handler);
  await handler(
    {
      params: { 0: roomId },
      headers: {},
      socket: { remoteAddress: "192.0.2.19" },
      sessionAccount: null,
    },
    response as never
  );

  assert.equal(response.statusCode, 401);
  assert.deepEqual(accessChecks, ["github.com/brosincode/private-repo"]);
  assert.deepEqual(response.body, {
    error: "auth_required",
    room_id: "github.com/brosincode/private-repo",
  });
});

test("non-repo joins initialize first admin without forcing every joiner to admin", async () => {
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
  const assignedAdmins: Array<{ projectId: string; accountId: string }> = [];
  const project = {
    id: "room_non_repo",
    display_name: "General Room",
  };

  registerRoomJoinRoutes(app as never, {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    isRepoBackedRoomId: () => false,
    resolveRoomOrReply: async () => project as never,
    getProjectAccessRoomId: () => project.id,
    isRepoBackedProject: () => false,
    assignInitialProjectAdmin: async (input) => {
      assignedAdmins.push(input);
    },
    resolveProjectRole: async () => "participant",
    rememberHumanRoomParticipant: async () => {},
    rememberAccountRoom: async () => {},
    toRoomResponse: (_project, options) => ({
      id: project.id,
      role: options?.role,
      authenticated: options?.authenticated,
    }),
  } as never);

  assert.ok(handler);
  await handler(
    {
      params: { 0: "general" },
      headers: {},
      socket: { remoteAddress: "192.0.2.17" },
      sessionAccount: { account_id: "acct_later_joiner" },
    },
    response as never,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(assignedAdmins, [
    { projectId: "room_non_repo", accountId: "acct_later_joiner" },
  ]);
  assert.deepEqual(response.body, {
    id: "room_non_repo",
    role: "participant",
    authenticated: true,
  });
});

test("canonical focus joins authorize after resolution and prefer the current Git Room binding", async () => {
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
  const project = {
    id: "focus_42",
    parent_room_id: "github.com/brosincode/letagents",
    display_name: "Branch Room",
  };
  const branchBinding = { room_id: project.id, ref_name: "codex/GitRooms" };
  const parentBinding = { room_id: project.parent_room_id, ref_name: "main" };
  const accessChecks: string[] = [];

  registerRoomJoinRoutes(app as never, {
    ...createDeps(),
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    isRepoBackedRoomId: (roomId: string) => roomId === project.parent_room_id,
    resolveRepoRoomAccessDecision: async ({ roomName }) => {
      accessChecks.push(roomName);
      return { kind: "allow" as const };
    },
    resolveRoomOrReply: async () => project as never,
    getProjectAccessRoomId: () => project.parent_room_id,
    resolveProjectRepoRoomAccessDecision: async () => ({
      isRepoBacked: true,
      roomName: project.parent_room_id,
      repoRoomName: project.parent_room_id,
      binding: null,
      decision: { kind: "allow" as const },
    }),
    getGitRoomBindingForRoom: async (roomId) =>
      roomId === project.id
        ? branchBinding as never
        : roomId === project.parent_room_id
          ? parentBinding as never
          : null,
    resolveProjectRole: async () => "anonymous",
    toRoomResponse: (_project, options) => ({
      id: project.id,
      gitRoomBinding: options?.gitRoomBinding,
    }),
  } as never);

  assert.ok(handler);
  await handler(
    {
      params: { 0: project.id },
      headers: {},
      socket: { remoteAddress: "192.0.2.19" },
      sessionAccount: null,
    },
    response as never
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(accessChecks, []);
  assert.deepEqual(response.body, {
    id: project.id,
    gitRoomBinding: branchBinding,
  });
});
