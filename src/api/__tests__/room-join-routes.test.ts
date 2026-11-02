import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerRoomJoinRoutes } = await import("../routes/rooms/join.js");
const { buildGitHubRefRoomLocator } = await import("../github/git-room-routing.js");
const {
  isRepoBackedRoomId,
  replyRepoRoomAccessDecision,
  resolveRepoRoomAccessDecision,
  unsupportedRepoProviderMessage,
} = await import("../rooms/access.js");

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

test("join route refuses non-GitHub repo room ids with 403 before any room is created", async () => {
  const anonymous = null;
  const signedIn = {
    account_id: "acct_1",
    provider: "github",
    login: "EmmyMay",
    provider_access_token: "secret-token",
  };

  const roomIds = [
    "bitbucket.org/poppix/pdf-service",
    "gitlab.com/team/project",
    "local/Users/someone",
    "gitlab.com/group/sub/project",
    "github-work/acme/app",
    "team/design/ideas",
  ];
  for (const [roomIndex, roomId] of roomIds.entries()) {
    for (const sessionAccount of [anonymous, signedIn]) {
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
        resolveCanonicalRoomRequestId: async (value: string) => value,
        isRepoBackedRoomId,
        resolveRepoRoomAccessDecision,
        replyRepoRoomAccessDecision,
        resolveRoomOrReply: async () => {
          throw new Error("a room must not be resolved or created for a non-GitHub repo room id");
        },
      } as never);

      assert.ok(handler);
      await handler(
        {
          params: { 0: roomId },
          headers: {},
          // One address per room keeps the join rate limit out of this test.
          socket: { remoteAddress: `192.0.2.${100 + roomIndex}` },
          sessionAccount,
        },
        response as never
      );

      assert.equal(response.statusCode, 403, `${roomId} ${sessionAccount ? "signed in" : "anonymous"}`);
      assert.deepEqual(response.body, {
        error: "unsupported_repo_provider",
        code: "UNSUPPORTED_REPO_PROVIDER",
        message: unsupportedRepoProviderMessage(roomId),
        room_id: roomId,
      });
    }
  }
});

test("join route sends GitHub host aliases to the access check as the real github.com room", async () => {
  const privateRoom = "github.com/brosincode/private-repo";
  const aliases = [
    "www.github.com/BrosInCode/Private-Repo",
    "ssh.github.com:443/BrosInCode/Private-Repo",
    "https://www.github.com/BrosInCode/Private-Repo.git",
    "ssh://git@ssh.github.com:443/BrosInCode/Private-Repo.git",
    "git@ssh.github.com:BrosInCode/Private-Repo.git",
  ];

  for (const [aliasIndex, alias] of aliases.entries()) {
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
    const checkedRooms: string[] = [];

    registerRoomJoinRoutes(app as never, {
      ...createDeps(),
      resolveCanonicalRoomRequestId: async (value: string) => value,
      isRepoBackedRoomId,
      resolveRepoRoomAccessDecision: async (input: { roomName: string }) => {
        checkedRooms.push(input.roomName);
        return { kind: "auth_required" } as const;
      },
      replyRepoRoomAccessDecision,
      resolveRoomOrReply: async () => {
        throw new Error("a room must not be resolved or created before the access check passes");
      },
    } as never);

    assert.ok(handler);
    await handler(
      {
        params: { 0: alias },
        headers: {},
        socket: { remoteAddress: `192.0.2.${150 + aliasIndex}` },
        sessionAccount: null,
      },
      response as never
    );

    assert.deepEqual(checkedRooms, [privateRoom], alias);
    assert.equal(response.statusCode, 401, alias);
    assert.equal((response.body as { room_id: string }).room_id, privateRoom, alias);
  }
});

async function joinThroughRoute(roomId: string, overrides: Record<string, unknown>, remoteAddress: string) {
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
    resolveCanonicalRoomRequestId: async (value: string) => value,
    isRepoBackedRoomId,
    ...overrides,
  } as never);
  assert.ok(handler);
  await handler(
    { params: { 0: roomId }, headers: {}, socket: { remoteAddress }, sessionAccount: null },
    response as never
  );
  return response;
}

test("join route does not treat a focus locator under an ad-hoc parent as a repo room", async () => {
  const accessChecks: string[] = [];
  const focusRoom = { id: "focus_9", parent_room_id: "focus-adhoc-parent", display_name: "Focus: Intent" };

  const response = await joinThroughRoute(
    "focus-adhoc-parent/focus/focus-intent-0123abcd",
    {
      resolveRepoRoomAccessDecision: async ({ roomName }: { roomName: string }) => {
        accessChecks.push(roomName);
        return resolveRepoRoomAccessDecision({ roomName, sessionAccount: null });
      },
      replyRepoRoomAccessDecision,
      resolveRoomOrReply: async () => focusRoom,
      getProjectAccessRoomId: () => focusRoom.parent_room_id,
      resolveProjectRole: async () => "anonymous",
      toRoomResponse: () => ({ room_id: focusRoom.id }),
    },
    "192.0.2.81"
  );

  assert.deepEqual(accessChecks, [], "an ad-hoc parent gets no repo pre-check on the raw locator");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { room_id: "focus_9" });
});

test("join route checks a focus locator under a GitHub repo against that repo", async () => {
  const accessChecks: string[] = [];

  const response = await joinThroughRoute(
    "github.com/o/r/focus/focus-intent-0123abcd",
    {
      resolveRepoRoomAccessDecision: async ({ roomName }: { roomName: string }) => {
        accessChecks.push(roomName);
        return { kind: "auth_required" as const };
      },
      replyRepoRoomAccessDecision: (res: any, roomName: string) => {
        res.status(401).json({ error: "auth_required", room_id: roomName });
        return false;
      },
      resolveRoomOrReply: async () => {
        throw new Error("resolveRoomOrReply should not be called after denial");
      },
    },
    "192.0.2.82"
  );

  assert.deepEqual(accessChecks, ["github.com/o/r"]);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: "auth_required", room_id: "github.com/o/r" });
});

test("join route refuses a focus locator under a non-GitHub repo with 403 UNSUPPORTED_REPO_PROVIDER", async () => {
  const response = await joinThroughRoute(
    "bitbucket.org/t/p/focus/focus-intent-0123abcd",
    {
      resolveRepoRoomAccessDecision,
      replyRepoRoomAccessDecision,
      resolveRoomOrReply: async () => {
        throw new Error("resolveRoomOrReply should not be called after denial");
      },
    },
    "192.0.2.83"
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, {
    error: "unsupported_repo_provider",
    code: "UNSUPPORTED_REPO_PROVIDER",
    message: unsupportedRepoProviderMessage("bitbucket.org/t/p"),
    room_id: "bitbucket.org/t/p",
  });
});
