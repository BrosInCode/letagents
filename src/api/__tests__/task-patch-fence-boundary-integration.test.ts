import assert from "node:assert/strict";
import express from "express";
import { once, EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

// Proves the task-PATCH coordination boundary end-to-end through PRODUCTION code
// paths — real bearer auth, the real enforceTaskCoordinationMutation decision,
// the real updateTask fence, and a real rebindTaskLease (no hand-built fence,
// no manual lease-row surgery). RiverRiver's blocker: a rebound-away predecessor
// must never downgrade to an unfenced allow. Two orderings:
//   (A) rebind-before-lookup: enforce resolves the lease now held by the
//       successor, the predecessor's session no longer matches -> deny/409.
//   (B) lookup-before-rebind: enforce captures the predecessor's still-current
//       tuple; the rebind then advances epoch/session and the in-tx fence in
//       updateTask fails -> LeaseFenceStaleError (mapped to 409 by the route).

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";
process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "true";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const db = testDatabaseUrl ? await import("../db.js") : null;
const { resolveRequestAuth } = await import("../request/auth.js");
const { createTaskCoordinationEnforcement } = await import("../tasks/coordination-enforcement.js");
const { updateTask, getTaskById, getTaskOwnershipState, LeaseFenceStaleError } = await import("../db.js");

async function reset(): Promise<void> {
  if (!client) throw new Error("DB-backed fence-route tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}

// The real enforcement service, wired to real lease reads so its decision sees
// actual DB state. Board-intent gating is disabled and non-lease reads are empty
// — this test is about the work-lease fence path only.
function realEnforcement(ownerId: string) {
  return createTaskCoordinationEnforcement({
    getAgentIdentityByCanonicalKey: async (canonical_key) => ({ canonical_key, owner_account_id: ownerId }),
    createCoordinationEvent: async () => {},
    getActiveTaskLocks: async () => [],
    getTasks: async () => ({ tasks: [], has_more: false }),
    getFocusRoomsForParent: async () => [],
    getActiveTaskLeases: db!.getActiveTaskLeases,
    updateTaskLeaseWorkflowRefs: db!.updateTaskLeaseWorkflowRefs,
    shouldRequireBoardIntent: async () => false,
    verifyBoardIntentApproval: async () => ({ kind: "allow" as const }),
  } as never) as { enforceTaskCoordinationMutation: (input: never) => Promise<{ kind: string; code?: string; leaseFence?: unknown; workLeaseCreation?: NonNullable<Parameters<typeof updateTask>[3]>["workLeaseCreation"] }> };
}

let ordinal = 0;

async function seed() {
  const n = ++ordinal;
  const ownerId = `owner_fence_${n}`;
  await client!.db.insert((await import("../db/schema.js")).accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId, display_name: ownerId,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const room = await db!.createProjectWithName(`fence-room-${n}`);
  const agentKey = `owner/fence-agent-${n}`;
  const grant = (await db!.createSupervisorHostGrant({
    owner_account_id: ownerId, host_id: `host_${n}`, installation_id: `install_${n}`,
    allowed_room_ids: [room.id], allowed_agent_keys: [agentKey],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })).grant;
  const from = await db!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `From${n} | Owner's agent | Agent`, agent_key: agentKey, agent_instance_id: `inst_from_${n}`,
    display_name: `From${n}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: grant.grant_id,
  });
  const task = await db!.createTask(room.id, `fenced task ${n}`, from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: agentKey,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const grantFence = { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version };
  // The rebind enforces successor freshness (created after the predecessor
  // terminated), so the successor session is minted by the test AFTER it ends
  // `from` — mirroring the real restart flow.
  const mintSuccessor = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return db!.createRoomAgentSession({
      room_id: room.id, session_kind: "worker", runtime: "codex",
      actor_label: `To${n} | Owner's agent | Agent`, agent_key: agentKey, agent_instance_id: `inst_to_${n}`,
      display_name: `To${n}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
      supervisor_grant_id: grant.grant_id,
    });
  };
  return { room, ownerId, agentKey, from, mintSuccessor, task, lease, grantFence };
}

test("(A) a predecessor whose work lease was rebound away is denied at enforcement, never downgraded to allow", { skip: requiresDatabase }, async () => {
  const { room, ownerId, from, mintSuccessor, task, lease, grantFence } = await seed();
  // Real bearer auth for the predecessor.
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${from.worker_bearer}` } } as never);
  assert.equal(auth.authKind, "agent_session");
  const callerSession = auth.agentSession!.agent_session_id;

  // rebindTaskLease refuses a live predecessor (predecessor_live), so end the
  // from-session first — its bearer/principal was already captured above.
  await db!.endRoomAgentSession({ session_id: from.session_id });
  const to = await mintSuccessor();
  // The supervisor attests the predecessor's termination before it may rebind,
  // then presents that exact proof (id + execution identity) to the rebind.
  const waA = randomUUID();
  const egA = randomUUID();
  const attestedA = await db!.recordRebindAttestation({
    lease_id: lease.id, epoch: 0, from_agent_session_id: from.session_id,
    supervisor_grant_fence: grantFence,
    work_attempt_id: waA, execution_generation_id: egA, cause: "crashed",
  });
  assert.equal(attestedA.ok, true);
  // A real rebind moves the lease to the successor BEFORE the predecessor's write.
  const rebind = await db!.rebindTaskLease({
    lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id,
    supervisor_grant_fence: grantFence,
    attestation_id: (attestedA as { attestation: { id: string } }).attestation.id, work_attempt_id: waA, execution_generation_id: egA,
  });
  assert.equal(rebind.ok, true);

  const enforcement = realEnforcement(ownerId);
  const taskRow = await getTaskById(room.id, task.id);
  const ownership = await getTaskOwnershipState(room.id, task.id);
  const decision = await enforcement.enforceTaskCoordinationMutation({
    req: { authKind: "agent_session", agentSession: auth.agentSession },
    projectId: room.id,
    task: taskRow,
    taskOwnership: ownership,
    updates: { pr_url: "https://example.com/pr/stale" },
    actorLabel: from.actor_label,
    actorKey: from.agent_key,
    actorInstanceId: from.agent_instance_id,
    actorSessionId: callerSession,
  } as never);

  assert.equal(decision.kind, "deny", "moved-lease predecessor must be denied, not allowed");
  assert.equal(decision.code, "coordination_work_lease_required");
});

test("(B) enforcement captures the current tuple, then a rebind makes the in-tx updateTask fence fail", { skip: requiresDatabase }, async () => {
  const { room, ownerId, from, mintSuccessor, task, lease, grantFence } = await seed();
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${from.worker_bearer}` } } as never);
  const callerSession = auth.agentSession!.agent_session_id;

  const enforcement = realEnforcement(ownerId);
  const taskRow = await getTaskById(room.id, task.id);
  const ownership = await getTaskOwnershipState(room.id, task.id);
  // Predecessor still holds the lease: enforcement allows and captures the tuple.
  const decision = await enforcement.enforceTaskCoordinationMutation({
    req: { authKind: "agent_session", agentSession: auth.agentSession },
    projectId: room.id, task: taskRow, taskOwnership: ownership,
    updates: { pr_url: "https://example.com/pr/captured" },
    actorLabel: from.actor_label, actorKey: from.agent_key,
    actorInstanceId: from.agent_instance_id, actorSessionId: callerSession,
  } as never);
  assert.equal(decision.kind, "allow");
  assert.ok(decision.leaseFence, "a held work lease yields a fence tuple");

  // Tuple captured while the predecessor was live+holding; now end it (rebind
  // refuses a live predecessor) and rebind so the captured tuple goes stale.
  await db!.endRoomAgentSession({ session_id: from.session_id });
  const to = await mintSuccessor();
  const waB = randomUUID();
  const egB = randomUUID();
  const attestedB = await db!.recordRebindAttestation({
    lease_id: lease.id, epoch: 0, from_agent_session_id: from.session_id,
    supervisor_grant_fence: grantFence,
    work_attempt_id: waB, execution_generation_id: egB, cause: "crashed",
  });
  assert.equal(attestedB.ok, true);
  // A real rebind advances the lease epoch/session after the tuple was captured.
  const rebind = await db!.rebindTaskLease({
    lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id,
    supervisor_grant_fence: grantFence,
    attestation_id: (attestedB as { attestation: { id: string } }).attestation.id, work_attempt_id: waB, execution_generation_id: egB,
  });
  assert.equal(rebind.ok, true);

  // The captured tuple is now stale: the in-tx fence in updateTask must reject.
  await assert.rejects(
    updateTask(room.id, task.id, { pr_url: "https://example.com/pr/captured" }, { leaseFence: decision.leaseFence as never }),
    (err: Error) => err instanceof LeaseFenceStaleError,
  );
  const after = await getTaskById(room.id, task.id);
  assert.equal(after?.pr_url ?? null, null, "the stale write left no side effect");
});


test("worker claim persists a session-bound lease before advancing accepted work", { skip: requiresDatabase }, async () => {
  const { room, ownerId, from, mintSuccessor } = await seed();
  const task = await db!.createTask(room.id, "new worker claim", from.actor_label);
  await updateTask(room.id, task.id, { status: "accepted" });
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${from.worker_bearer}` } } as never);
  assert.equal(auth.authKind, "agent_session");
  const enforcement = realEnforcement(ownerId);
  const decide = async (updates: Record<string, string>, identity = auth.agentSession!) =>
    enforcement.enforceTaskCoordinationMutation({
      req: { authKind: "agent_session", agentSession: identity }, projectId: room.id,
      task: await getTaskById(room.id, task.id), taskOwnership: await getTaskOwnershipState(room.id, task.id),
      updates, actorLabel: identity.actor_label, actorKey: identity.agent_key,
      actorInstanceId: identity.agent_instance_id, actorSessionId: identity.agent_session_id,
    } as never);
  const claim = await decide({ status: "assigned" });
  assert.equal(claim.kind, "allow");
  assert.ok(claim.workLeaseCreation, "a worker claim must create authority, not an unfenced allow");
  assert.deepEqual(await db!.getActiveTaskLeases(room.id, task.id), [], "enforcement does not write a lease ahead of the task transaction");
  await updateTask(room.id, task.id, {
    status: "assigned", assignee: from.actor_label, assignee_agent_key: from.agent_key,
  }, { workLeaseCreation: claim.workLeaseCreation });
  const leases = await db!.getActiveTaskLeases(room.id, task.id);
  assert.equal(leases.length, 1);
  assert.equal(leases[0]!.kind, "work");
  assert.equal(leases[0]!.agent_session_id, from.session_id);
  assert.equal(leases[0]!.agent_key, from.agent_key);
  assert.equal((await getTaskById(room.id, task.id))?.status, "assigned");

  const advance = await decide({ status: "in_progress" });
  assert.equal(advance.kind, "allow");
  assert.ok(advance.leaseFence);
  await updateTask(room.id, task.id, { status: "in_progress" }, { leaseFence: advance.leaseFence as never });
  assert.equal((await getTaskById(room.id, task.id))?.status, "in_progress");
  const other = await mintSuccessor();
  const otherAuth = await resolveRequestAuth({ headers: { authorization: `Bearer ${other.worker_bearer}` } } as never);
  assert.equal(otherAuth.authKind, "agent_session");
  const rejected = await decide({ status: "in_review" }, otherAuth.agentSession!);
  assert.equal(rejected.kind, "deny");
  assert.equal(rejected.code, "coordination_work_lease_required");
  assert.equal((await getTaskById(room.id, task.id))?.status, "in_progress", "another session cannot advance the claimed task");
});


// Real HTTP middleware and production board/task routes: only publication side
// effects are muted; authentication, room scope, approval and writes stay real.
async function workflowHttp(t: import("node:test").TestContext) {
  const seeded = await seed();
  const { registerHttpMiddleware } = await import("../http/middleware.js");
  const { registerRoomBoardRoutes } = await import("../routes/rooms/board.js");
  const { registerTaskRecordRoutes } = await import("../routes/rooms/tasks/task-record.js");
  const { registerTaskLeaseActionRoute } = await import("../routes/rooms/tasks/lease-action.js");
  const { resolveCanonicalRoomRequestId, resolveRoomOrReply } = await import("../rooms/resolution.js");
  const { requireAdmin, requireParticipant } = await import("../rooms/access.js");
  const services = await import("../server/room-services.js");
  const common = { resolveCanonicalRoomRequestId, resolveRoomOrReply, requireAdmin, requireParticipant,
    normalizeOptionalString: (v: unknown) => typeof v === "string" ? v.trim() || null : null,
    emitProjectMessage: async () => ({ id: "msg_test" }) };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerRoomBoardRoutes(app, common);
  const taskDeps = { ...common, ...services,
    getTaskById, getTaskOwnershipState, updateTask, taskEvents: new EventEmitter(),
    enforceFocusParentBoardWriteIsolation: ({ req, targetProject }: any) => services.enforceFocusParentBoardWriteIsolation({ req, targetProjectId: targetProject.id }),
    emitTaskLifecycleStatusMessage: async () => {},
  };
  registerTaskRecordRoutes(app, taskDeps as never);
  registerTaskLeaseActionRoute(app, taskDeps as never);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = async (token: string | null, suffix: string, body: unknown, method = "POST", roomId = seeded.room.id) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/rooms/${roomId}/${suffix}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const manager = await db!.createRoomAgentSession({ room_id: seeded.room.id, session_kind: "worker", runtime: "codex",
    actor_label: "Manager", agent_key: "owner/manager", agent_instance_id: "manager-instance", display_name: "Manager",
    owner_account_id: seeded.ownerId, owner_label: "Owner", ide_label: "Agent" });
  await db!.assignBoardManager({ room_id: seeded.room.id, agent_session_id: manager.session_id, assigned_by: "Owner" });
  await db!.setRoomBoardManagerMode({ room_id: seeded.room.id, manager_mode: "intent_required", updated_by: "Owner" });
  const freshTask = async (assigned = false) => {
    const task = await db!.createTask(seeded.room.id, "HTTP workflow", seeded.from.actor_label);
    await updateTask(seeded.room.id, task.id, { status: "accepted" });
    if (assigned) await updateTask(seeded.room.id, task.id, { status: "assigned", assignee: seeded.from.actor_label, assignee_agent_key: seeded.from.agent_key });
    return task;
  };
  const approveClaim = async (taskId: string, worker = seeded.from) => {
    const registered = await request(worker.worker_bearer, "board-intents", {
      action_type: "task_claim", task_id: taskId,
      payload: { task_id: taskId, status: "assigned", assignee: worker.actor_label, assignee_agent_key: worker.agent_key, pr_url: null },
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const intentId = registered.body.intent.id as string;
    const approved = await request(manager.worker_bearer, `board-intents/${intentId}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    return intentId;
  };
  const claim = (taskId: string, intentId?: string, worker = seeded.from) => request(worker.worker_bearer, `tasks/${taskId}`, {
    status: "assigned", assignee: worker.actor_label, ...(intentId ? { board_intent_id: intentId } : {}),
  }, "PATCH");
  return { ...seeded, request, manager, freshTask, approveClaim, claim };
}

test("HTTP worker releases its own lease with an approved intent and no token handoff", { skip: requiresDatabase }, async t => {
  const f = await workflowHttp(t);
  const task = await f.freshTask();
  const claimIntent = await f.approveClaim(task.id);
  assert.equal((await f.claim(task.id, claimIntent)).status, 200);
  const [lease] = await db!.getActiveTaskLeases(f.room.id, task.id);
  const payload = { task_id: task.id, action: "release", lease_id: lease!.id, target_actor_key: null, target_agent_session_id: null };
  const registered = await f.request(f.from.worker_bearer, "board-intents", { action_type: "task_override", task_id: task.id, payload });
  assert.equal(registered.status, 201);
  const intent = registered.body.intent.id;
  assert.equal((await f.request(f.manager.worker_bearer, `board-intents/${intent}/approve`, {})).status, 200);
  const action = { action: "release", lease_id: lease!.id, board_intent_id: intent };
  assert.equal((await f.request(f.manager.worker_bearer, `tasks/${task.id}/lease-action`, action)).status, 403, "approval does not grant a different worker the lease");
  const released = await f.request(f.from.worker_bearer, `tasks/${task.id}/lease-action`, action);
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal((await db!.getActiveTaskLeases(f.room.id, task.id)).length, 0);
  assert.equal((await db!.getBoardIntent({ room_id: f.room.id, intent_id: intent }))!.status, "used");
});

test("HTTP worker approved intent claims, retries and advances without a token handoff", { skip: requiresDatabase }, async t => {
  const f = await workflowHttp(t);
  const task = await f.freshTask();
  assert.equal((await f.claim(task.id)).status, 409, "approval is required before the initial claim");
  const intent = await f.approveClaim(task.id);
  const claimed = await f.claim(task.id, intent);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const [lease] = await db!.getActiveTaskLeases(f.room.id, task.id);
  assert.equal(lease!.agent_session_id, f.from.session_id);
  assert.equal((await db!.getBoardIntent({ room_id: f.room.id, intent_id: intent }))!.status, "used");
  assert.equal((await f.claim(task.id)).status, 200, "lost-response retry needs no new intent");
  assert.deepEqual((await db!.getActiveTaskLeases(f.room.id, task.id)).map(l => l.id), [lease!.id]);
  for (const status of ["in_progress", "in_review"]) {
    const advanced = await f.request(f.from.worker_bearer, `tasks/${task.id}`, { status }, "PATCH");
    assert.equal(advanced.status, 200, JSON.stringify(advanced.body));
    assert.equal(advanced.body.status, status);
  }
  assert.equal((await f.request(f.from.worker_bearer, `tasks/${task.id}`, { status: "in_progress", agent_session_id: f.manager.session_id }, "PATCH")).status, 401);
  const otherRoom = await db!.createProjectWithName("other HTTP room");
  assert.equal((await f.request(f.from.worker_bearer, "board-intents", { action_type: "task_claim", payload: {} }, "POST", otherRoom.id)).status, 403);
});

test("HTTP own assigned work recovers a missing lease only through an approved claim", { skip: requiresDatabase }, async t => {
  const f = await workflowHttp(t);
  const task = await f.freshTask(true);
  assert.equal((await f.claim(task.id, undefined, f.manager)).status, 409, "another durable agent cannot recover assigned work");
  assert.deepEqual(await db!.getActiveTaskLeases(f.room.id, task.id), []);
  assert.equal((await f.request(f.from.worker_bearer, `tasks/${task.id}`, { status: "in_progress" }, "PATCH")).status, 409);
  assert.equal((await f.claim(task.id)).status, 409);
  const intent = await f.approveClaim(task.id);
  assert.equal((await f.claim(task.id, intent)).status, 200);
  const leases = await db!.getActiveTaskLeases(f.room.id, task.id);
  assert.equal(leases.length, 1);
  assert.equal(leases[0]!.agent_session_id, f.from.session_id);
  await db!.endRoomAgentSession({ session_id: f.from.session_id });
  const successor = await f.mintSuccessor();
  const stolen = await f.claim(task.id, undefined, successor);
  assert.equal(stolen.status, 409, "restart must rebind existing authority, never mint over it");
  assert.equal((await f.request(f.from.worker_bearer, `tasks/${task.id}`, { status: "in_progress" }, "PATCH")).status, 401);
  assert.equal((await getTaskById(f.room.id, task.id))!.status, "assigned", "revoked bearer must not mutate the recovered task");
  assert.deepEqual((await db!.getActiveTaskLeases(f.room.id, task.id)).map(l => l.id), [leases[0]!.id]);
});

test("HTTP concurrent approved claims mint one work lease", { skip: requiresDatabase }, async t => {
  const f = await workflowHttp(t);
  const task = await f.freshTask();
  const firstIntent = await f.approveClaim(task.id);
  const secondIntent = await f.approveClaim(task.id, f.manager);
  const results = await Promise.all([f.claim(task.id, firstIntent), f.claim(task.id, secondIntent, f.manager)]);
  assert.equal(results.filter(r => r.status === 200).length, 1, JSON.stringify(results));
  assert.equal(results.filter(r => r.status === 409).length, 1, JSON.stringify(results));
  const leases = await db!.getActiveTaskLeases(f.room.id, task.id);
  assert.equal(leases.length, 1);
  const persisted = await getTaskById(f.room.id, task.id);
  assert.equal(persisted!.assignee_agent_key, leases[0]!.agent_key);
  const intents = await Promise.all([firstIntent, secondIntent].map(intent_id => db!.getBoardIntent({ room_id: f.room.id, intent_id })));
  assert.equal(intents.filter(i => i!.status === "used").length, 1, "losing claim must not consume approval");
});
