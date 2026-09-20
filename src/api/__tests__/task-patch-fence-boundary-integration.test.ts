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

for (const expired of [false, true]) {
  test(`same-scope grant recovery ${expired ? "after expiry" : "after a lost response"} preserves task and review authority`, { skip: requiresDatabase }, async () => {
    const { room, ownerId, from, mintSuccessor, task, lease, grantFence } = await seed();
    await updateTask(room.id, task.id, { status: "accepted" });
    await updateTask(room.id, task.id, { status: "assigned", assignee: from.actor_label, assignee_agent_key: from.agent_key });
    await updateTask(room.id, task.id, { status: "in_progress" });
    const reviewTask = await db!.createTask(room.id, "Review another worker's PR", "Another worker");
    const review = await db!.createTaskLease({
      room_id: room.id, task_id: reviewTask.id, kind: "review", agent_key: from.agent_key,
      actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
    });
    const other = await mintSuccessor();
    const grant = await db!.getSupervisorHostGrantById(grantFence.grant_id);
    assert.ok(grant);
    if (expired) {
      await client!.pool.query("UPDATE supervisor_host_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE grant_id = $1", [grant.grant_id]);
      assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${from.worker_bearer}` } } as never)).authKind, null);
    }
    const recovered = await db!.createSupervisorHostGrant({ ...grant, expires_at: new Date(Date.now() + 120_000).toISOString() });
    assert.equal(recovered.grant.grant_id, grant.grant_id);
    assert.equal(recovered.grant.current_generation, grant.current_generation);
    const refreshed = await db!.createOrRotateSupervisorWorkerSession({
      room_id: room.id, session_kind: "worker", runtime: from.runtime,
      actor_label: from.actor_label, agent_key: from.agent_key, agent_instance_id: from.agent_instance_id!,
      display_name: from.display_name, owner_account_id: ownerId, owner_label: from.owner_label, ide_label: from.ide_label,
      supervisor_grant_id: recovered.grant.grant_id,
      supervisor_grant_fence: { grant_id: recovered.grant.grant_id, generation: recovered.grant.current_generation, token_version: recovered.grant.token_version },
    });
    assert.equal(refreshed.session.session_id, from.session_id);
    assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${from.worker_bearer}` } } as never)).authKind, null);
    const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${refreshed.session.worker_bearer}` } } as never);
    const otherAuth = await resolveRequestAuth({ headers: { authorization: `Bearer ${other.worker_bearer}` } } as never);
    assert.equal(auth.authKind, "agent_session");
    assert.equal(otherAuth.authKind, "agent_session", "an independent instance keeps its own session");
    const enforcement = realEnforcement(ownerId);
    const decide = async (identity: NonNullable<typeof auth.agentSession>) => enforcement.enforceTaskCoordinationMutation({
      req: { authKind: "agent_session", agentSession: identity }, projectId: room.id,
      task: await getTaskById(room.id, task.id), taskOwnership: await getTaskOwnershipState(room.id, task.id),
      updates: { status: "in_review" }, actorLabel: identity.actor_label, actorKey: identity.agent_key,
      actorInstanceId: identity.agent_instance_id, actorSessionId: identity.agent_session_id,
    } as never);
    assert.equal((await decide(otherAuth.agentSession!)).kind, "deny", "same agent key is not task ownership");
    const decision = await decide(auth.agentSession!);
    assert.equal(decision.kind, "allow");
    assert.ok(decision.leaseFence);
    await updateTask(room.id, task.id, { status: "in_review" }, { leaseFence: decision.leaseFence as never });
    assert.equal((await getTaskById(room.id, task.id))?.status, "in_review");
    const [retained] = await db!.getActiveTaskLeases(room.id, task.id);
    assert.equal(retained?.id, lease.id);
    assert.equal(retained?.epoch, lease.epoch);
    assert.equal(await db!.releaseTaskLease(room.id, review.id, {
      kind: "review", expected_epoch: review.epoch, expected_agent_session_id: otherAuth.agentSession!.agent_session_id,
    }), null, "a separate instance cannot release the original review assignment");
    const released = await db!.releaseTaskLease(room.id, review.id, {
      kind: "review", expected_epoch: review.epoch, expected_agent_session_id: auth.agentSession!.agent_session_id,
    });
    assert.equal(released?.status, "released");
  });
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
async function workflowHttp(t: import("node:test").TestContext, effects: Record<string, unknown> = {}) {
  const seeded = await seed();
  const { registerHttpMiddleware } = await import("../http/middleware.js");
  const { registerRoomBoardRoutes } = await import("../routes/rooms/board.js");
  const { registerTaskRecordRoutes } = await import("../routes/rooms/tasks/task-record.js");
  const { registerLegacyProjectTaskRoutes } = await import("../routes/legacy/tasks.js");
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
    ...effects,
  };
  registerTaskRecordRoutes(app, taskDeps as never);
  registerLegacyProjectTaskRoutes(app, { ...taskDeps, getProjectById: db!.getProjectById } as never);
  registerTaskLeaseActionRoute(app, taskDeps as never);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = async (token: string | { sessionToken: string } | null, suffix: string, body: unknown,
    method = "POST", roomId = seeded.room.id, namespace = "rooms") => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (typeof token === "string") headers.authorization = `Bearer ${token}`;
    else if (token) headers.cookie = `letagents_session=${encodeURIComponent(token.sessionToken)}`;
    const response = await fetch(`http://127.0.0.1:${address.port}/${namespace}/${roomId}/${suffix}`, {
      method, headers, body: JSON.stringify(body),
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

test("HTTP admin edits persist Markdown and clearing through PATCH and GET without changing workflow", { skip: requiresDatabase }, async t => {
  const f = await workflowHttp(t);
  const sessionToken = randomUUID();
  await db!.createSession(f.ownerId, sessionToken, new Date(Date.now() + 60_000).toISOString());
  await db!.assignProjectAdmin(f.room.id, f.ownerId);
  const auth = { sessionToken };
  const before = await getTaskById(f.room.id, f.task.id);
  const leases = await db!.getActiveTaskLeases(f.room.id, f.task.id);
  const description = "# Acceptance\n\n- [ ] Keep **Markdown**\n\n```ts\nconst ok = true;\n```\n";
  const edited = await f.request(auth, `tasks/${f.task.id}`, { title: "  Edited ticket  ", description }, "PATCH");
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.title, "Edited ticket");
  assert.equal(edited.body.description, description);
  const read = await f.request(auth, `tasks/${f.task.id}`, undefined, "GET");
  assert.equal(read.status, 200);
  assert.equal(read.body.title, "Edited ticket");
  assert.equal(read.body.description, description);
  assert.equal(read.body.status, before!.status);
  assert.equal(read.body.assignee, before!.assignee);
  assert.deepEqual(await db!.getActiveTaskLeases(f.room.id, f.task.id), leases);
  const cleared = await f.request(auth, `tasks/${f.task.id}`, { description: "" }, "PATCH");
  assert.equal(cleared.status, 200);
  assert.equal((await getTaskById(f.room.id, f.task.id))!.description, "");
  assert.equal((await getTaskById(f.room.id, f.task.id))!.title, "Edited ticket");
  const accepted = await f.request(auth, `tasks/${f.task.id}`, { status: "accepted" }, "PATCH");
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.status, "accepted");
  assert.equal(accepted.body.title, "Edited ticket");
  assert.equal(accepted.body.description, "");
  const ownerToken = randomUUID();
  await db!.createOwnerToken({ accountId: f.ownerId, githubUserId: f.ownerId, token: ownerToken });
  const desktopEdit = await f.request(sessionToken, `tasks/${f.task.id}`, {
    title: "Desktop edit",
  }, "PATCH");
  assert.equal(desktopEdit.status, 200, JSON.stringify(desktopEdit.body));
  assert.equal((await getTaskById(f.room.id, f.task.id))!.title, "Desktop edit");
  const workerEdit = await f.request(ownerToken, `tasks/${f.task.id}`, {
    title: "Worker edit", agent_session_id: f.from.session_id, agent_session_token: f.from.session_token,
  }, "PATCH");
  assert.equal(workerEdit.status, 403, JSON.stringify(workerEdit.body));
  assert.equal((await getTaskById(f.room.id, f.task.id))!.title, "Desktop edit");
});

test("HTTP content edits require human admin even for manager workers and intent-bearing requests", { skip: requiresDatabase }, async t => {
  const f = await workflowHttp(t);
  const sessionToken = randomUUID();
  await db!.createSession(f.ownerId, sessionToken, new Date(Date.now() + 60_000).toISOString());
  const before = await getTaskById(f.room.id, f.task.id);
  for (const namespace of ["rooms", "projects"]) {
    for (const [auth, status] of [[null, 401], [{ sessionToken }, 403], [f.from.worker_bearer, 403], [f.manager.worker_bearer, 403]] as const) {
      const response = await f.request(auth, `tasks/${f.task.id}`, {
        title: "Unauthorized edit", status: "accepted", board_intent_id: "intent_not_authority",
      }, "PATCH", f.room.id, namespace);
      assert.equal(response.status, status, JSON.stringify(response.body));
      assert.deepEqual(await getTaskById(f.room.id, f.task.id), before);
    }
  }
});

test("HTTP concurrent admin content edits merge different fields and conflict only on edited content", { skip: requiresDatabase }, async t => {
  const f = await workflowHttp(t);
  const editors = [{ sessionToken: randomUUID() }, { sessionToken: randomUUID() }];
  for (const editor of editors) await db!.createSession(f.ownerId, editor.sessionToken, new Date(Date.now() + 60_000).toISOString());
  await db!.assignProjectAdmin(f.room.id, f.ownerId);
  const patch = (index: number, body: unknown) => f.request(editors[index]!, `tasks/${f.task.id}`, body, "PATCH");
  const separateFields = await Promise.all([
    patch(0, { title: "Renamed", expected_content: { title: f.task.title } }),
    patch(1, { description: "# Body", expected_content: { description: "" } }),
  ]);
  assert.deepEqual(separateFields.map(result => result.status), [200, 200]);
  let current = (await getTaskById(f.room.id, f.task.id))!;
  assert.equal(current.title, "Renamed");
  assert.equal(current.description, "# Body", "null descriptions compare as empty strings");

  for (const field of ["title", "description"] as const) {
    const baseline = current[field] ?? "";
    const results = await Promise.all([
      patch(0, { [field]: "Editor one", expected_content: { [field]: baseline } }),
      patch(1, { [field]: "Editor two", expected_content: { [field]: baseline } }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(results.find(result => result.status === 409)!.body.code, "task_content_conflict");
    current = (await getTaskById(f.room.id, f.task.id))!;
    assert.equal(current[field], results.find(result => result.status === 200)!.body[field]);
  }

  const mixedConflict = await patch(0, { title: "Stale title", description: "Must not persist", status: "accepted",
    expected_content: { title: "Renamed", description: current.description } });
  assert.equal(mixedConflict.status, 409);
  assert.deepEqual(await getTaskById(f.room.id, f.task.id), current, "a conflict rejects the entire patch");
  const workflowAndBody = await Promise.all([
    patch(0, { status: "accepted" }),
    patch(1, { description: "", expected_content: { description: current.description } }),
  ]);
  assert.deepEqual(workflowAndBody.map(result => result.status), [200, 200]);
  const read = await f.request(editors[0]!, `tasks/${f.task.id}`, undefined, "GET");
  assert.equal(read.body.status, "accepted");
  assert.equal(read.body.title, current.title);
  assert.equal(read.body.description, "");
});

test("HTTP invalid content rejects the entire update with 400", { skip: requiresDatabase }, async t => {
  const f = await workflowHttp(t);
  const sessionToken = randomUUID();
  await db!.createSession(f.ownerId, sessionToken, new Date(Date.now() + 60_000).toISOString());
  await db!.assignProjectAdmin(f.room.id, f.ownerId);
  const before = await getTaskById(f.room.id, f.task.id);
  for (const body of [
    { title: "" }, { title: " \n " }, { title: null }, { title: 42 }, { title: "x".repeat(513) },
    { description: null }, { description: {} }, { description: "x".repeat(100_001) },
    { title: "Next", expected_content: null }, { title: "Next", expected_content: [] },
    { title: "Next", expected_content: {} }, { title: "Next", expected_content: { title: 42 } },
    { title: "Next", expected_content: { description: "" } },
    { title: "Next", description: "Body", expected_content: { title: "Original" } },
    { title: "Next", expected_content: { title: "Original", extra: "Not allowed" } },
    { expected_content: { title: "Original" } },
  ]) {
    const response = await f.request({ sessionToken }, `tasks/${f.task.id}`, { ...body, status: "accepted" }, "PATCH");
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.match(response.body.error, /^(title|description|expected_content)/);
    assert.deepEqual(await getTaskById(f.room.id, f.task.id), before);
  }
});

for (const conflict of [false, true]) {
test(`DB content baseline ${conflict ? "rejects a concurrent same-field edit" : "preserves concurrent workflow and omitted content"}`, { skip: requiresDatabase }, async () => {
  const { room, task } = await seed();
  const holder = await client!.pool.connect();
  const artifacts = [
    { provider: "git", kind: "branch", ref: "concurrent-work" },
    { provider: "unknown", kind: "pull_request", url: "https://example.com/pr/new" },
  ];
  let pending: ReturnType<typeof updateTask> | undefined;
  try {
    await holder.query("BEGIN");
    const { rows: [connection] } = await holder.query("SELECT pg_backend_pid() AS pid");
    await holder.query(`UPDATE tasks SET title = $3, status = 'accepted', assignee = 'Other worker',
      assignee_agent_key = 'owner/other', pr_url = 'https://example.com/pr/new',
      workflow_artifacts = $1, description = 'Concurrent body' WHERE room_id = $2 AND number = 1`,
      [JSON.stringify(artifacts), room.id, conflict ? "Concurrent title" : task.title]);
    pending = updateTask(room.id, task.id, { title: "New title", expected_content: { title: task.title } });
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const { rows: [state] } = await client!.pool.query(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [connection.pid]);
      blocked = state.blocked;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
    }
    await holder.query("COMMIT");
    if (conflict) await assert.rejects(pending, { code: "task_content_conflict" });
    const updated = conflict ? await getTaskById(room.id, task.id) : await pending;
    assert.equal(blocked, true, "the content writer read the pre-commit row and waited behind the concurrent update");
    assert.ok(updated);
    assert.equal(updated.title, conflict ? "Concurrent title" : "New title");
    assert.equal(updated.description, "Concurrent body");
    assert.equal(updated.status, "accepted");
    assert.equal(updated.assignee, "Other worker");
    assert.equal(updated.assignee_agent_key, "owner/other");
    assert.equal(updated.pr_url, "https://example.com/pr/new");
    assert.deepEqual(updated.workflow_artifacts, artifacts);
    assert.deepEqual(await getTaskById(room.id, task.id), updated);
    const cleared = await updateTask(room.id, task.id, { description: "", expected_content: { description: "Concurrent body" } });
    assert.equal(cleared!.title, updated.title);
    assert.equal(cleared!.description, "");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await pending?.catch(() => {});
  }
});
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


test("HTTP exact progress retries preserve committed state and reject changed fields and stale workers", { skip: requiresDatabase }, async t => {
  let notifications = 0;
  const f = await workflowHttp(t, { emitTaskLifecycleStatusMessage: async () => { notifications++; } });
  const task = await f.freshTask();
  assert.equal((await f.claim(task.id, await f.approveClaim(task.id))).status, 200);
  for (const status of ["in_progress", "in_review"]) {
    const patch = { status, pr_url: "https://github.com/example/repo/pull/1", workflow_artifacts: [
      { provider: "git", kind: "branch", ref: "retry-proof" },
    ] };
    const first = await f.request(f.from.worker_bearer, `tasks/${task.id}`, patch, "PATCH");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const before = await getTaskById(f.room.id, task.id);
    const leases = await db!.getActiveTaskLeases(f.room.id, task.id);
    const count = notifications;
    const retry = await f.request(f.from.worker_bearer, `tasks/${task.id}`, patch, "PATCH");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(await getTaskById(f.room.id, task.id), before);
    assert.deepEqual(await db!.getActiveTaskLeases(f.room.id, task.id), leases);
    assert.equal(notifications, count);
    const workLease = leases.find(lease => lease.kind === "work")!;
    for (const content of [{ title: "Not an exact retry" }, { description: "Not an exact retry" }]) {
      await assert.rejects(updateTask(f.room.id, task.id, { ...patch, ...content } as Parameters<typeof updateTask>[2], {
        leaseFence: { lease_id: workLease.id, room_id: f.room.id, task_id: task.id, kind: "work",
          expected_epoch: workLease.epoch, agent_session_id: f.from.session_id },
      }), /Invalid transition/);
      assert.deepEqual(await getTaskById(f.room.id, task.id), before);
    }
    assert.equal((await f.request(f.from.worker_bearer, `tasks/${task.id}`, { ...patch, pr_url: "https://github.com/example/repo/pull/2" }, "PATCH")).status, 400);
    assert.equal((await f.request(f.manager.worker_bearer, `tasks/${task.id}`, patch, "PATCH")).status, 409);
  }
  const before = await getTaskById(f.room.id, task.id);
  await db!.endRoomAgentSession({ session_id: f.from.session_id });
  assert.equal((await f.request(f.from.worker_bearer, `tasks/${task.id}`, { status: "in_review" }, "PATCH")).status, 401);
  assert.deepEqual(await getTaskById(f.room.id, task.id), before);
});

test("HTTP committed progress succeeds despite failed lifecycle and Git room publication", { skip: requiresDatabase }, async t => {
  let notifications = 0;
  const events = new EventEmitter();
  events.on("task:updated", () => { throw new Error("event delivery failed"); });
  const f = await workflowHttp(t, {
    taskEvents: events,
    emitTaskLifecycleStatusMessage: async () => { notifications++; throw new Error("fetch failed"); },
    ensureTaskGitRoomForActiveWorkLease: async () => { throw new Error("fetch failed"); },
  });
  const task = await f.freshTask();
  assert.equal((await f.claim(task.id, await f.approveClaim(task.id))).status, 200);
  const first = await f.request(f.from.worker_bearer, `tasks/${task.id}`, { status: "in_review" }, "PATCH");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const count = notifications;
  assert.equal((await f.request(f.from.worker_bearer, `tasks/${task.id}`, { status: "in_review" }, "PATCH")).status, 200);
  assert.equal(notifications, count);
  assert.equal((await getTaskById(f.room.id, task.id))!.status, "in_review");
});


test("HTTP concurrent identical progress requests converge on one committed timestamp", { skip: requiresDatabase }, async t => {
  const publicationIds: string[] = [];
  const f = await workflowHttp(t, {
    emitTaskLifecycleStatusMessage: async (_room: string, task: { status: string }, options: { client_message_id: string }) => {
      if (task.status === "in_review") publicationIds.push(options.client_message_id);
    },
  });
  const task = await f.freshTask();
  assert.equal((await f.claim(task.id, await f.approveClaim(task.id))).status, 200);
  const replies = await Promise.all(Array.from({ length: 4 }, () =>
    f.request(f.from.worker_bearer, `tasks/${task.id}`, { status: "in_review" }, "PATCH")));
  for (const reply of replies) assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(new Set(replies.map(r => Date.parse(r.body.updated_at))).size, 1);
  assert.equal(new Set(publicationIds).size, 1, "concurrent notifications share the existing durable deduplication key");
});
