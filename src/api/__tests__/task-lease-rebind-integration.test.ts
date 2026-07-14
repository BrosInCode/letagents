import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "true";
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const db = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { rebindTaskLease, assertLeaseEpochCurrentTx } = await import("../db/coordination/lease-rebind.js");

async function reset(): Promise<void> {
  if (!client) throw new Error("DB-backed rebind tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}

let ordinal = 0;

async function seed(options: { endFrom?: boolean; sameKey?: boolean } = {}) {
  const n = ++ordinal;
  const ownerId = `owner_rebind_${n}`;
  await client!.db.insert(schema!.accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId, display_name: ownerId,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const room = await db!.createProjectWithName(`rebind-room-${n}`);
  const agentKey = `owner/rebind-agent-${n}`;
  const toKey = options.sameKey === false ? `owner/other-agent-${n}` : agentKey;

  const from = await db!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `From${n} | Owner's agent | Agent`, agent_key: agentKey, agent_instance_id: `inst_from_${n}`,
    display_name: `From${n}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
  });
  const to = await db!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `To${n} | Owner's agent | Agent`, agent_key: toKey, agent_instance_id: `inst_to_${n}`,
    display_name: `To${n}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
  });

  const grant = (await db!.createSupervisorHostGrant({
    owner_account_id: ownerId, host_id: `host_${n}`, installation_id: `install_${n}`,
    allowed_room_ids: [room.id], allowed_agent_keys: [agentKey],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })).grant;

  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: `task_${n}`, kind: "work", agent_key: agentKey,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });

  if (options.endFrom !== false) {
    await db!.endRoomAgentSession({ session_id: from.session_id });
  }

  const fence = { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version };
  return { room, ownerId, agentKey, from, to, grant, lease, fence };
}

async function leaseRow(id: string) {
  const [row] = await client!.db.select().from(schema!.task_leases).where(eq(schema!.task_leases.id, id)).limit(1);
  return row;
}

test("rebind moves the lease, bumps epoch, revokes the predecessor, and stale epoch loses", { skip: requiresDatabase }, async () => {
  const { from, to, lease, fence } = await seed();
  const first = await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  assert.equal(first.ok, true);
  const row = await leaseRow(lease.id);
  assert.equal(row.epoch, 1);
  assert.equal(row.agent_session_id, to.session_id);
  assert.equal(row.agent_key, to.agent_key);
  // A second attempt at the now-stale epoch loses the CAS.
  const stale = await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  assert.equal(stale.ok, false);
  assert.equal((stale as { reason: string }).reason, "lost_race");
});

test("a live, reachable predecessor cannot be displaced", { skip: requiresDatabase }, async () => {
  const { room, from, to, lease, fence } = await seed({ endFrom: false });
  // Reachable delivery row (grace window in the future) → predecessor is live.
  const now = new Date().toISOString();
  await client!.db.insert(schema!.room_agent_delivery_sessions).values({
    room_id: room.id, delivery_key: `agent_session:${from.session_id}`, actor_label: from.actor_label,
    agent_key: from.agent_key, agent_instance_id: from.agent_instance_id, display_name: "From",
    owner_label: "Owner", ide_label: "Agent", repo_branch: null, agent_session_id: from.session_id,
    session_kind: "worker", runtime: "codex", transport: "long_poll", active_connection_count: 1,
    last_connected_at: now, last_disconnected_at: null,
    reconnect_grace_expires_at: new Date(Date.now() + 60_000).toISOString(),
    offline_announced_at: null, recovery_announced_at: null, created_at: now, updated_at: now,
  });
  const result = await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "predecessor_live");
});

test("a grant that does not cover the room+agent identity is rejected", { skip: requiresDatabase }, async () => {
  const { from, to, lease } = await seed();
  // Forge a fence for a grant scoped to nothing relevant (different agent key).
  const otherOwner = `owner_scope_${ordinal}`;
  await client!.db.insert(schema!.accounts).values({
    id: otherOwner, provider: "github", provider_user_id: otherOwner, login: otherOwner, display_name: otherOwner,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const wrong = (await db!.createSupervisorHostGrant({
    owner_account_id: otherOwner, host_id: "host_x", installation_id: "install_x",
    allowed_room_ids: ["room_nope"], allowed_agent_keys: ["owner/nope"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })).grant;
  const result = await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: { grant_id: wrong.grant_id, generation: wrong.current_generation, token_version: wrong.token_version } });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "grant_scope");
});

test("a stale grant fence (wrong generation) is rejected", { skip: requiresDatabase }, async () => {
  const { from, to, lease, fence } = await seed();
  const result = await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: { ...fence, generation: fence.generation + 1 } });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "grant_fence_stale");
});

test("concurrent rebinds resolve to exactly one winner", { skip: requiresDatabase }, async () => {
  const { from, to, lease, fence } = await seed();
  const results = await Promise.allSettled([
    rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence }),
    rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence }),
  ]);
  const oks = results.filter((r) => r.status === "fulfilled" && (r.value as { ok: boolean }).ok).length;
  const lost = results.filter((r) => r.status === "fulfilled" && !(r.value as { ok: boolean }).ok && (r.value as { reason?: string }).reason === "lost_race").length;
  assert.equal(oks, 1);
  assert.equal(lost, 1);
  assert.equal((await leaseRow(lease.id)).epoch, 1);
});

test("the epoch guard rejects a partitioned predecessor's stale epoch after rebind", { skip: requiresDatabase }, async () => {
  const { from, to, lease, fence } = await seed();
  await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  await client!.db.transaction(async (tx) => {
    // Predecessor still believes it holds epoch 0 on its old session → rejected.
    assert.equal(await assertLeaseEpochCurrentTx(tx, { lease_id: lease.id, expected_epoch: 0, agent_session_id: from.session_id }), false);
    // The successor at the current epoch is accepted.
    assert.equal(await assertLeaseEpochCurrentTx(tx, { lease_id: lease.id, expected_epoch: 1, agent_session_id: to.session_id }), true);
  });
});
