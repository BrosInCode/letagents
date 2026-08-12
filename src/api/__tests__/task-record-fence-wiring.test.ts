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

function buildRoute(overrides: { updateTask: (...args: any[]) => Promise<unknown> }) {
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
