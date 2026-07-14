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
const { applyTaskWorkLeaseAction } = await import("../db/coordination/work-lease-actions.js");

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

async function seed(options: { endFrom?: boolean; successorUnderGrant?: boolean } = {}) {
  const n = ++ordinal;
  const ownerId = `owner_rebind_${n}`;
  await client!.db.insert(schema!.accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId, display_name: ownerId,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const room = await db!.createProjectWithName(`rebind-room-${n}`);
  const agentKey = `owner/rebind-agent-${n}`;

  const grant = (await db!.createSupervisorHostGrant({
    owner_account_id: ownerId, host_id: `host_${n}`, installation_id: `install_${n}`,
    allowed_room_ids: [room.id], allowed_agent_keys: [agentKey],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  })).grant;

  // Both predecessor and successor are minted UNDER this grant (the supervised
  // path). The wrong-host case omits the successor's supervisor_grant_id so the
  // rebind must reject it.
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
    supervisor_grant_id: options.successorUnderGrant === false ? null : grant.grant_id,
  });

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

test("a non-terminal (still-running) predecessor cannot be displaced", { skip: requiresDatabase }, async () => {
  // endFrom:false → the predecessor session is NOT ended. Reachability is not
  // termination, so the rebind must refuse — only a genuinely ended predecessor
  // may be replaced (§4.5 conservative floor).
  const { from, to, lease, fence } = await seed({ endFrom: false });
  const result = await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "predecessor_live");
});

test("a same-room/same-key successor NOT minted under this grant is rejected (wrong host/authority)", { skip: requiresDatabase }, async () => {
  // successorUnderGrant:false → the `to` session has the same agent_key/room/owner
  // but no supervisor_grant_id binding it to this grant, i.e. a session another
  // host registered under the same canonical key. Must not receive the lease.
  const { from, to, lease, fence } = await seed({ successorUnderGrant: false });
  const result = await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "session_mismatch");
  assert.equal((await leaseRow(lease.id)).agent_session_id, from.session_id, "lease stayed with the predecessor");
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

test("a review lease is not rebindable — the generic route rejects the non-work kind", { skip: requiresDatabase }, async () => {
  // A review lease's authority cannot be proven by the work-attempt terminal
  // attestation the rebind consumes (§4.5). The rebind must refuse it outright
  // so a dead reviewer's review lease is released, never silently moved.
  const { room, from, to, fence } = await seed();
  const reviewLease = await db!.createTaskLease({
    room_id: room.id, task_id: `task_review_${ordinal}`, kind: "review", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const result = await rebindTaskLease({ lease_id: reviewLease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "kind_not_rebindable");
  assert.equal((await leaseRow(reviewLease.id)).agent_session_id, from.session_id, "review lease stayed put");
});

test("acquireLeaseFenceTx accepts the current tuple and rejects a rebound-away predecessor", { skip: requiresDatabase }, async () => {
  const { room, from, to, lease, fence } = await seed();
  const { acquireLeaseFenceTx } = await import("../db/coordination/lease-rebind.js");
  // Before rebind: the predecessor's full tuple at epoch 0 is valid.
  await client!.db.transaction(async (tx) => {
    const row = await acquireLeaseFenceTx(tx, { lease_id: lease.id, room_id: room.id, task_id: lease.task_id, kind: "work", expected_epoch: 0, agent_session_id: from.session_id });
    assert.ok(row, "current holder's tuple is accepted");
  });
  await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  await client!.db.transaction(async (tx) => {
    // Predecessor tuple (old session, epoch 0) is now stale → null.
    const stale = await acquireLeaseFenceTx(tx, { lease_id: lease.id, room_id: room.id, task_id: lease.task_id, kind: "work", expected_epoch: 0, agent_session_id: from.session_id });
    assert.equal(stale, null, "rebound-away predecessor is rejected");
    // Successor tuple (new session, epoch 1) is valid.
    const current = await acquireLeaseFenceTx(tx, { lease_id: lease.id, room_id: room.id, task_id: lease.task_id, kind: "work", expected_epoch: 1, agent_session_id: to.session_id });
    assert.ok(current, "successor's current tuple is accepted");
  });
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

test("updateTask fence aborts a stale write when a rebind commits first (barrier) — zero side effect, current epoch succeeds", { skip: requiresDatabase }, async () => {
  // Barrier per §4.5: an authenticated worker's task write and a supervisor
  // rebind race for the same lease. Both take the `task_lease:<id>` advisory
  // lock, so they linearize. We force "rebind first" deterministically by
  // holding that exact lock on a dedicated connection before firing the write,
  // so updateTask blocks at acquireLeaseFenceTx; we commit the rebind under the
  // held lock, release, and the resumed write must observe the advanced epoch
  // and abort with LeaseFenceStaleError, leaving the task untouched.
  const { updateTask } = await import("../db/tasks.js");
  const { room, from, to } = await seed();
  const task = await db!.createTask(room.id, "fenced task", from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const leaseFence = {
    lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work" as const,
    expected_epoch: 0, agent_session_id: from.session_id,
  };
  const initialPrUrl = task.pr_url ?? null;

  const holder = await client!.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`task_lease:${lease.id}`]);

    // Fire the guarded write; it progresses to the fence and blocks on the lock.
    const writePromise = updateTask(room.id, task.id, { pr_url: "https://example.com/pr/stale" }, { leaseFence });

    // A rebind commits while the write waits: repoint to the successor, bump epoch.
    await holder.query(
      "UPDATE task_leases SET agent_session_id = $1, epoch = epoch + 1, updated_at = now() WHERE id = $2",
      [to.session_id, lease.id],
    );
    await holder.query("COMMIT"); // releases the lock

    await assert.rejects(writePromise, (err: Error) => err.name === "LeaseFenceStaleError");
  } finally {
    holder.release();
  }

  // Zero side effect: the stale write never landed.
  const [taskRow] = await client!.db.select().from(schema!.tasks).where(eq(schema!.tasks.id, task.id)).limit(1);
  assert.equal(taskRow.pr_url ?? null, initialPrUrl, "the rebound-away predecessor's write did not land");

  // The successor, presenting the current fence, writes successfully.
  const ok = await updateTask(room.id, task.id, { pr_url: "https://example.com/pr/successor" }, {
    leaseFence: { lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work", expected_epoch: 1, agent_session_id: to.session_id },
  });
  assert.equal(ok?.pr_url, "https://example.com/pr/successor");
});

test("publishWorkerArtifactFenced aborts atomically when a rebind commits first (barrier) — no artifact, no link", { skip: requiresDatabase }, async () => {
  // Same barrier as the task-write test, applied to the artifact upsert+link:
  // the two writes must be atomic AND fenced, so a rebind committing mid-publish
  // leaves neither an orphan artifact nor a stale task binding.
  const { publishWorkerArtifactFenced } = await import("../db/room-shared-artifacts.js");
  const { room, from, to } = await seed();
  const task = await db!.createTask(room.id, "artifact task", from.actor_label);
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: from.agent_key,
    actor_label: from.actor_label, created_by: from.actor_label, agent_session_id: from.session_id,
  });
  const leaseFence = {
    lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work" as const,
    expected_epoch: 0, agent_session_id: from.session_id,
  };
  const artifact = { provider: "github" as const, kind: "commit" as const, id: "sha_barrier" };

  const holder = await client!.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`task_lease:${lease.id}`]);
    const publishPromise = publishWorkerArtifactFenced({ leaseFence, room_id: room.id, artifact, linked_task_id: task.id });
    await holder.query(
      "UPDATE task_leases SET agent_session_id = $1, epoch = epoch + 1, updated_at = now() WHERE id = $2",
      [to.session_id, lease.id],
    );
    await holder.query("COMMIT");
    await assert.rejects(publishPromise, (err: Error) => err.name === "LeaseFenceStaleError");
  } finally {
    holder.release();
  }

  const arts = await client!.db.select().from(schema!.room_shared_artifacts).where(eq(schema!.room_shared_artifacts.room_id, room.id));
  assert.equal(arts.length, 0, "no artifact upserted by the aborted publish");
  const links = await client!.db.select().from(schema!.room_shared_artifact_tasks).where(eq(schema!.room_shared_artifact_tasks.room_id, room.id));
  assert.equal(links.length, 0, "no task link by the aborted publish");

  const ok = await publishWorkerArtifactFenced({
    leaseFence: { ...leaseFence, expected_epoch: 1, agent_session_id: to.session_id },
    room_id: room.id, artifact, linked_task_id: task.id,
  });
  assert.ok(ok.identity_key, "successor at the current epoch publishes");
});

test("a stale-epoch lease-action cannot release the successor's rebound lease, but the current epoch can", { skip: requiresDatabase }, async () => {
  const { room, from, to, lease, fence } = await seed();
  // Predecessor observed epoch 0; rebind commits epoch 1 to the successor.
  const rebind = await rebindTaskLease({ lease_id: lease.id, expected_epoch: 0, from_agent_session_id: from.session_id, to_agent_session_id: to.session_id, supervisor_grant_fence: fence });
  assert.equal(rebind.ok, true);

  // The predecessor's release, carrying its stale epoch 0, must not touch the
  // successor's epoch-1 lease — the destructive UPDATE CAS matches 0 rows.
  const stale = await applyTaskWorkLeaseAction({
    room_id: room.id, task_id: lease.task_id, active_lease_id: lease.id,
    expected_lease_epoch: 0, disposition_status: "released", task_updates: {},
  });
  assert.equal(stale.conflict, "lease_not_active");
  assert.equal(stale.released_lease, null);
  const stillActive = await leaseRow(lease.id);
  assert.equal(stillActive.status, "active");
  assert.equal(stillActive.agent_session_id, to.session_id);

  // The successor, presenting the current epoch, can release it.
  const current = await applyTaskWorkLeaseAction({
    room_id: room.id, task_id: lease.task_id, active_lease_id: lease.id,
    expected_lease_epoch: 1, disposition_status: "released", task_updates: {},
  });
  assert.equal(current.conflict, null);
  assert.equal(current.released_lease?.id, lease.id);
});
