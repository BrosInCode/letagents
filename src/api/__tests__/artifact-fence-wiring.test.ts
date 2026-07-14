import assert from "node:assert/strict";
import test from "node:test";

// No DB. Surface (5): an agent-attributed artifact published via OWNER_TOKEN +
// agent-session credentials in the body must be fenced exactly like the
// agent_session-bearer path — the earlier gate (`authKind === 'agent_session'`)
// let it skip the lease fence and take the unfenced upsert+link path. These
// tests register the real artifacts POST handler with injected deps and assert
// the owner_token+credentials publish routes through publishWorkerArtifactFenced
// (never the unfenced upsert) and still enforces the caller-holds-the-lease gate.

process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const { registerRoomArtifactRoutes } = await import("../routes/rooms/artifacts.js");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
  };
}

const WORKER_SESSION = "agent_session_owner";

function buildRoute(opts: { activeLeases: unknown[] }) {
  const fenced: Array<Record<string, unknown>> = [];
  const unfenced: Array<Record<string, unknown>> = [];
  const handlers: Array<(...args: any[]) => Promise<void>> = [];
  const app = { get() {}, post(_re: RegExp, handler: (...args: any[]) => Promise<void>) { handlers.push(handler); } };
  registerRoomArtifactRoutes(app as never, {
    artifactEvents: { emit() {} },
    resolveCanonicalRoomRequestId: async () => "room_1",
    resolveRoomOrReply: async () => ({ id: "room_1" }),
    requireParticipant: async () => true,
    // Owner-token presenting agent-session credentials resolves to a worker.
    requireWorkerRequestAgentIdentity: async () => ({
      ok: true,
      identity: { agent_key: "owner/worker", agent_session_id: WORKER_SESSION, actor_label: "Worker", agent_instance_id: "inst_1" },
    }),
    getActiveTaskLeases: async () => opts.activeLeases,
    getRoomSharedArtifacts: async () => [],
    getRoomSharedArtifactByIdentityKey: async () => ({ identity_key: "artifact", linked_task_ids: ["task_1"] }),
    upsertRoomSharedArtifact: async (input: Record<string, unknown>) => { unfenced.push(input); return { identity_key: "artifact" }; },
    linkRoomSharedArtifactToTask: async () => {},
    publishWorkerArtifactFenced: async (input: Record<string, unknown>) => { fenced.push(input); return { identity_key: "artifact" }; },
  } as never);
  return { handler: handlers[0]!, fenced, unfenced };
}

function ownerTokenPublish(body: Record<string, unknown>) {
  // owner_token auth + agent_session_id in the body => the agent-credentialed path.
  return { params: { 0: "room_1" }, query: {}, body: { ...body, agent_session_id: WORKER_SESSION }, authKind: "owner_token" as const };
}

const BASE = { provider: "github", kind: "commit", id: "sha_owner", task_id: "task_1" };

test("owner_token + agent credentials routes an artifact through the FENCED publish, never the unfenced upsert", async () => {
  const heldLease = { id: "tl_owner", room_id: "room_1", task_id: "task_1", kind: "work", status: "active", epoch: 4, agent_session_id: WORKER_SESSION };
  const { handler, fenced, unfenced } = buildRoute({ activeLeases: [heldLease] });

  const res = responseRecorder();
  await handler(ownerTokenPublish(BASE), res);

  assert.equal(res.statusCode, 200);
  assert.equal(fenced.length, 1, "publishWorkerArtifactFenced was used");
  assert.equal(unfenced.length, 0, "the unfenced upsert path was NOT used for an agent-attributed publish");
  assert.deepEqual(fenced[0]!.leaseFence, {
    lease_id: "tl_owner", room_id: "room_1", task_id: "task_1", kind: "work", expected_epoch: 4, agent_session_id: WORKER_SESSION,
  }, "the fence carries the held lease's exact tuple");
});

test("owner_token + agent credentials without the caller's active work lease is rejected (403), not published", async () => {
  const { handler, fenced, unfenced } = buildRoute({ activeLeases: [] });
  const res = responseRecorder();
  await handler(ownerTokenPublish(BASE), res);
  assert.equal(res.statusCode, 403);
  assert.equal(fenced.length, 0);
  assert.equal(unfenced.length, 0, "no unfenced fallback publish");
});
