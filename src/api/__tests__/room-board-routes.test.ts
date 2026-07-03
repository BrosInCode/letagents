import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { authorizeBoardDecision, registerRoomBoardRoutes, requesterLabel } = await import("../routes/rooms/board.js");
import type { BoardManagerAssignment, Project } from "../db.js";
import type { ResolvedRequestAgentIdentity } from "../request/agent-identity.js";

type Handler = (req: Record<string, unknown>, res: ReturnType<typeof createResponseRecorder>) => Promise<void>;

function project(): Project {
  return {
    id: "github.com/brosincode/letagents",
    code: null,
    display_name: "LetAgents",
    name: "github.com/brosincode/letagents",
    kind: "main",
    parent_room_id: null,
    focus_key: null,
    source_task_id: null,
    focus_status: null,
    focus_parent_visibility: null,
    focus_activity_scope: null,
    focus_github_event_routing: null,
    focus_archived_at: null,
    git_lifecycle_event_order_at: null,
    concluded_at: null,
    conclusion_summary: null,
    conclusion_details: null,
    created_at: "2026-07-03T00:00:00.000Z",
  };
}

function workerIdentity(sessionId: string): ResolvedRequestAgentIdentity {
  return {
    actor_label: `Worker (${sessionId})`,
    agent_key: `agent:${sessionId}`,
    agent_instance_id: `instance:${sessionId}`,
    agent_session_id: sessionId,
    session_kind: "worker",
    runtime: "codex",
    display_name: "Worker",
    owner_label: "Emmy",
    ide_label: "Codex",
    repo_branch: "codex/board-manager-intents",
  };
}

function managerAssignment(sessionId: string): BoardManagerAssignment {
  return {
    id: `manager:${sessionId}`,
    room_id: "github.com/brosincode/letagents",
    agent_session_id: sessionId,
    agent_key: `agent:${sessionId}`,
    actor_label: `Manager (${sessionId})`,
    runtime_source: "desktop_managed",
    assigned_by: "admin",
    status: "active",
    last_heartbeat_at: null,
    released_by: null,
    release_reason: null,
    released_at: null,
    created_at: "2026-07-03T00:00:00.000Z",
    updated_at: "2026-07-03T00:00:00.000Z",
  };
}

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function createRouteApp() {
  const handlers = {
    get: new Map<string, Handler>(),
    post: new Map<string, Handler>(),
    patch: new Map<string, Handler>(),
    delete: new Map<string, Handler>(),
  };
  const app = {
    get(path: RegExp, handler: Handler) {
      handlers.get.set(path.toString(), handler);
    },
    patch(path: RegExp, handler: Handler) {
      handlers.patch.set(path.toString(), handler);
    },
    delete(path: RegExp, handler: Handler) {
      handlers.delete.set(path.toString(), handler);
    },
    post(path: RegExp, handler: Handler) {
      handlers.post.set(path.toString(), handler);
    },
  };
  return { app, handlers };
}

function createDeps() {
  const unused = async () => {
    throw new Error("not invoked");
  };

  return {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async () => project(),
    requireParticipant: async () => true,
    requireAdmin: unused,
    normalizeOptionalString: (value: unknown) => typeof value === "string" ? value.trim() || null : null,
  };
}

test("authorizeBoardDecision allows the active board manager without admin fallback", async () => {
  let requireAdminCalled = false;
  const res = createResponseRecorder();

  const allowed = await authorizeBoardDecision({
    req: {} as never,
    res: res as never,
    project: project(),
    workerIdentity: workerIdentity("session_manager"),
    requireAdmin: async () => {
      requireAdminCalled = true;
      return false;
    },
    getActiveBoardManagerForRoom: async () => managerAssignment("session_manager"),
  });

  assert.equal(allowed, true);
  assert.equal(requireAdminCalled, false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
});

test("authorizeBoardDecision denies non-manager workers before admin fallback", async () => {
  let requireAdminCalled = false;
  const res = createResponseRecorder();

  const allowed = await authorizeBoardDecision({
    req: {} as never,
    res: res as never,
    project: project(),
    workerIdentity: workerIdentity("session_worker"),
    requireAdmin: async () => {
      requireAdminCalled = true;
      return true;
    },
    getActiveBoardManagerForRoom: async () => managerAssignment("session_manager"),
  });

  assert.equal(allowed, false);
  assert.equal(requireAdminCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "Only the active Board Manager can decide board intents with worker credentials.",
  });
});

test("authorizeBoardDecision falls back to admin auth for non-worker requests", async () => {
  let requireAdminCalled = false;
  const res = createResponseRecorder();

  const allowed = await authorizeBoardDecision({
    req: {} as never,
    res: res as never,
    project: project(),
    workerIdentity: null,
    requireAdmin: async () => {
      requireAdminCalled = true;
      return true;
    },
    getActiveBoardManagerForRoom: async () => {
      throw new Error("active manager lookup should not run for non-worker requests");
    },
  });

  assert.equal(allowed, true);
  assert.equal(requireAdminCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
});

test("requesterLabel prefers authenticated session identity over body labels", () => {
  const label = requesterLabel(
    {
      sessionAccount: {
        display_name: "Authenticated Admin",
        login: "admin-login",
      },
    } as never,
    { actor_label: "Spoofed Manager" },
    null
  );

  assert.equal(label, "Authenticated Admin");
});

for (const [routeName, routePath] of [
  ["approve", "/^\\/rooms\\/(.+)\\/board-intents\\/([^/]+)\\/approve$/"],
  ["deny", "/^\\/rooms\\/(.+)\\/board-intents\\/([^/]+)\\/deny$/"],
] as const) {
  test(`board intent ${routeName} route denies non-manager workers before admin fallback`, async () => {
    const { app, handlers } = createRouteApp();
    let requireAdminCalled = false;
    const deps = {
      ...createDeps(),
      requireAdmin: async () => {
        requireAdminCalled = true;
        return true;
      },
      resolveOptionalWorkerIdentity: async () => workerIdentity("session_worker"),
      getActiveBoardManagerForRoom: async () => managerAssignment("session_manager"),
    };

    registerRoomBoardRoutes(app as never, deps as never);
    const handler = handlers.post.get(routePath);
    assert.ok(handler);

    const res = createResponseRecorder();
    await handler(
      {
        params: { 0: "github.com/brosincode/letagents", 1: "intent_1" },
        body: {
          agent_session_id: "session_worker",
          agent_session_token: "session_token",
        },
      },
      res
    );

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      error: "Only the active Board Manager can decide board intents with worker credentials.",
    });
    assert.equal(requireAdminCalled, false);
  });
}
