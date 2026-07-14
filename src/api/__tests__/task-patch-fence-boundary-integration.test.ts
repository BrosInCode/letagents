import assert from "node:assert/strict";
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
  } as never) as { enforceTaskCoordinationMutation: (input: never) => Promise<{ kind: string; code?: string; leaseFence?: unknown }> };
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
  const to = await db!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `To${n} | Owner's agent | Agent`, agent_key: agentKey, agent_instance_id: `inst_to_${n}`,
    display_name: `To${n}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: grant.grant_id,
  });
  const task = await db!.createTask(room.id, `fenced task ${n}`, from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: agentKey,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const grantFence = { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version };
  return { room, ownerId, agentKey, from, to, task, lease, grantFence };
}

test("(A) a predecessor whose work lease was rebound away is denied at enforcement, never downgraded to allow", { skip: requiresDatabase }, async () => {
  const { room, ownerId, from, to, task, lease, grantFence } = await seed();
  // Real bearer auth for the predecessor.
  const auth = await resolveRequestAuth({ headers: { authorization: `Bearer ${from.worker_bearer}` } } as never);
  assert.equal(auth.authKind, "agent_session");
  const callerSession = auth.agentSession!.agent_session_id;

  // rebindTaskLease refuses a live predecessor (predecessor_live), so end the
  // from-session first — its bearer/principal was already captured above.
  await db!.endRoomAgentSession({ session_id: from.session_id });
  // A real rebind moves the lease to the successor BEFORE the predecessor's write.
  const rebind = await db!.rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: grantFence });
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
  const { room, ownerId, from, to, task, lease, grantFence } = await seed();
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
  // A real rebind advances the lease epoch/session after the tuple was captured.
  const rebind = await db!.rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: grantFence });
  assert.equal(rebind.ok, true);

  // The captured tuple is now stale: the in-tx fence in updateTask must reject.
  await assert.rejects(
    updateTask(room.id, task.id, { pr_url: "https://example.com/pr/captured" }, { leaseFence: decision.leaseFence as never }),
    (err: Error) => err instanceof LeaseFenceStaleError,
  );
  const after = await getTaskById(room.id, task.id);
  assert.equal(after?.pr_url ?? null, null, "the stale write left no side effect");
});
