import assert from "node:assert/strict";
import test from "node:test";

// No DB. Proves the Express task-PATCH SEAM (independently of DB linearization,
// per RiverRiver msg_593): the registered handler forwards the exact leaseFence
// that enforcement produced into updateTask, and maps a LeaseFenceStaleError
// from updateTask to a 409 with its code. All collaborators are injected.

process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";
// The db client requires DB_URL at import time (pool is lazy — no connection is
// made). This test never issues a real query: updateTask is injected.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { registerTaskRecordRoutes } = await import("../routes/rooms/tasks/task-record.js");
const { LeaseFenceStaleError } = await import("../db.js");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
}

function workerPrincipal() {
  return {
    bearer_id: "agent_bearer_1", bearer_generation: 1, capabilities: ["coordination.self_write"],
    room_id: "room_1", agent_session_id: "agent_session_1",
    actor_label: "Worker | Owner's agent | Agent", agent_key: "owner/worker", agent_instance_id: "inst_1",
    session_kind: "worker" as const, runtime: "codex", display_name: "Worker",
    owner_label: "Owner", ide_label: "Agent", repo_branch: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

const SENTINEL_FENCE = {
  lease_id: "tl_sentinel", room_id: "room_1", task_id: "task_1",
  kind: "work" as const, expected_epoch: 3, agent_session_id: "agent_session_1",
};

function buildRoute(overrides: {
  updateTask: (...args: any[]) => Promise<unknown>;
  replayStoredPullRequestMerge?: (...args: any[]) => Promise<unknown>;
}) {
  const patchHandlers: Array<(...args: any[]) => Promise<void>> = [];
  const app = {
    get() {},
    patch(_re: RegExp, handler: (...args: any[]) => Promise<void>) { patchHandlers.push(handler); },
  };
  const deps = {
    taskEvents: { emit() {} },
    getTaskById: async () => ({ id: "task_1", status: "in_progress", title: "t", pr_url: null }),
    getTaskOwnershipState: async () => ({ status: "in_progress", assignee: "Worker | Owner's agent | Agent", assignee_agent_key: "owner/worker" }),
    updateTask: overrides.updateTask,
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    requireAdmin: async () => true,
    normalizeOptionalString: (v: unknown) => (typeof v === "string" ? v : null),
    validateOwnerTokenTaskActorKey: async (i: { actorKey: string | null }) => ({ actorKey: i.actorKey, error: null }),
    enforceFocusParentBoardWriteIsolation: async () => ({ kind: "allow" as const }),
    // Enforcement approves and hands back the sentinel fence to forward.
    enforceTaskCoordinationMutation: async () => ({ kind: "allow" as const, leaseFence: SENTINEL_FENCE }),
    emitTaskLifecycleStatusMessage: async () => ({}),
    ensureTaskGitRoomForActiveWorkLease: async () => {},
    replayStoredPullRequestMerge: overrides.replayStoredPullRequestMerge,
  };
  registerTaskRecordRoutes(app as never, deps as never);
  return patchHandlers[0]!;
}

test("PATCH forwards enforcement's exact leaseFence into updateTask and maps LeaseFenceStaleError to 409", async () => {
  let receivedFence: unknown;
  const handler = buildRoute({
    updateTask: async (_room: string, _task: string, _updates: unknown, options?: { leaseFence?: unknown }) => {
      receivedFence = options?.leaseFence;
      throw new LeaseFenceStaleError();
    },
  });

  const res = responseRecorder();
  await handler(
    { params: { 0: "room_1", 1: "task_1" }, body: { pr_url: "https://example.com/pr/wiring" }, authKind: "agent_session", agentSession: workerPrincipal() },
    res,
  );

  assert.deepEqual(receivedFence, SENTINEL_FENCE, "the exact fence from enforcement was forwarded to updateTask");
  assert.equal(res.statusCode, 409, "a stale fence maps to 409");
  assert.equal((res.body as { code?: string }).code, "coordination_lease_fence_stale");
});

// A pull request can merge before it is linked. After the worker's own write the
// route asks for the stored merge to be applied, and the write stays the worker's.
const committedTask = {
  id: "task_1", room_id: "room_1", title: "t", description: null, status: "in_review", assignee: null,
  assignee_agent_key: null, pr_url: "https://github.com/BrosInCode/letagents/pull/1", updated_at: new Date().toISOString(),
};

async function patchWith(
  body: Record<string, unknown>,
  replay: ((...args: any[]) => Promise<unknown>) | undefined,
  principal: { authKind?: string; agentSession?: unknown } = { authKind: "agent_session", agentSession: workerPrincipal() },
) {
  const handler = buildRoute({ updateTask: async () => committedTask, replayStoredPullRequestMerge: replay });
  const res = responseRecorder();
  await handler({ params: { 0: "room_1", 1: "task_1" }, body, ...principal }, res);
  return res;
}

test("PATCH answers with the task a stored merge replay moved, and hands the replay the committed task", async () => {
  const calls: any[] = [];
  const res = await patchWith({ status: "in_review" }, async (input: unknown) => {
    calls.push(input);
    return { ...committedTask, status: "merged" };
  });

  assert.equal(res.statusCode, 200);
  assert.equal((res.body as { status?: string }).status, "merged");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].task, committedTask);
  assert.equal(calls[0].project.id, "room_1");
  assert.equal(calls[0].actorLabel, workerPrincipal().actor_label);
});

test("PATCH keeps the committed write when the stored merge replay fails or applies nothing", async (t) => {
  t.mock.method(console, "warn", () => {});
  const failed = await patchWith({ status: "in_review" }, async () => { throw new Error("replay broke"); });
  assert.equal(failed.statusCode, 200, "a failed replay never fails the worker's write");
  assert.equal((failed.body as { status?: string }).status, "in_review");

  const unchanged = await patchWith({ pr_url: committedTask.pr_url }, async () => null);
  assert.equal(unchanged.statusCode, 200);
  assert.equal((unchanged.body as { status?: string }).status, "in_review");
});

test("PATCH asks for the replay only after a write that links a pull request or sets a status", async () => {
  let asked = 0;
  const replay = async () => { asked += 1; return null; };
  // A title edit by an admin links nothing and moves nothing.
  await patchWith({ title: "A new title" }, replay, {});
  assert.equal(asked, 0);
  await patchWith({ pr_url: committedTask.pr_url }, replay);
  await patchWith({ workflow_artifacts: [] }, replay);
  await patchWith({ status: "in_review" }, replay);
  assert.equal(asked, 3);
});
