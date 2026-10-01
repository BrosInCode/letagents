import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";

// Every path that locks both a task and its work lease must take the locks in
// one order: the task_lease:<id> advisory lock, then the worker's session row,
// then the lease row, then the task row. Two requests that take them in
// opposite orders can each hold what the other waits for, and Postgres aborts
// one with 40P01.
// Each test holds one path at the point where the opposite order would bite,
// then lets the other path run into it.

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const db = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { applyTaskWorkLeaseAction } = await import("../db/coordination/work-lease-actions.js");
const { acquireLeaseFenceTx } = await import("../db/coordination/lease-rebind.js");
const { expireStaleTaskLeases, updateTaskLeaseWorkflowRefs } = await import("../db/coordination/task-leases.js");
const { relabelTaskWorkTx } = await import("../db/coordination/lease-adoption.js");

async function reset(): Promise<void> {
  if (!client) throw new Error("DB-backed lock-order tests require TEST_DB_URL");
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

// A worker in the middle of its task: in progress, assigned to it, and held
// by its active work lease.
async function seed(options: { leaseTtlMs?: number } = {}) {
  const n = ++ordinal;
  const ownerId = `owner_lock_order_${n}`;
  const now = new Date().toISOString();
  await client!.db.insert(schema!.accounts).values({
    id: ownerId, provider: "github", provider_user_id: ownerId, login: ownerId, display_name: ownerId,
    avatar_url: null, created_at: now, updated_at: now,
  });
  const room = await db!.createProjectWithName(`lock-order-room-${n}`);
  const agentKey = `owner/lock-order-agent-${n}`;
  const session = await db!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "codex",
    actor_label: `Worker${n} | Owner's agent | Agent`, agent_key: agentKey, agent_instance_id: `inst_${n}`,
    display_name: `Worker${n}`, owner_account_id: ownerId, owner_label: "Owner", ide_label: "Agent",
  });
  const task = await db!.createTask(room.id, `lock order task ${n}`, session.actor_label);
  await db!.updateTask(room.id, task.id, { status: "accepted" });
  await db!.updateTask(room.id, task.id, { status: "assigned", assignee: session.actor_label, assignee_agent_key: agentKey });
  await db!.updateTask(room.id, task.id, { status: "in_progress" });
  const lease = await db!.createTaskLease({
    room_id: room.id, task_id: task.id, kind: "work", agent_key: agentKey,
    actor_label: session.actor_label, created_by: session.actor_label, agent_session_id: session.session_id,
    expires_at: options.leaseTtlMs ? new Date(Date.now() + options.leaseTtlMs).toISOString() : null,
  });
  const fence = {
    lease_id: lease.id, room_id: room.id, task_id: task.id, kind: "work" as const,
    expected_epoch: lease.epoch, agent_session_id: session.session_id,
  };
  const release = () => applyTaskWorkLeaseAction({
    room_id: room.id, task_id: task.id, active_lease_id: lease.id, expected_lease_epoch: lease.epoch,
    disposition_status: "revoked", disposition_reason: "Handed back to the board.",
    task_updates: { status: "accepted", assignee: null, assignee_agent_key: null },
  });
  const taskWhere = and(eq(schema!.tasks.room_id, room.id), eq(schema!.tasks.number, Number(task.id.replace("task_", ""))));
  return { room, session, task, lease, fence, release, agentKey, taskWhere };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

// Resolves once `count` backends in this database are waiting on a lock, so a
// test knows the path it started has reached the lock it should block on.
async function waitForLockWaiters(count: number, options: { rowLocksOnly?: boolean } = {}): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { rows } = await client!.pool.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND ($1::boolean IS NOT TRUE OR wait_event <> 'advisory')`,
      [options.rowLocksOnly ?? false],
    );
    if ((rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} lock waiter(s).`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertNoDeadlock(results: PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status === "rejected") {
      const error = result.reason as { code?: string; cause?: { code?: string } };
      const code = error?.code ?? error?.cause?.code;
      assert.notEqual(code, "40P01", `deadlock: ${String(result.reason)}`);
      throw result.reason;
    }
  }
}

async function leaseRow(leaseId: string) {
  const [row] = await client!.db.select().from(schema!.task_leases).where(eq(schema!.task_leases.id, leaseId));
  return row!;
}

test("a fenced pr_url update and a lease revoke on the same task both commit", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const prUrl = "https://github.com/example/repo/pull/7";
  // Hold the fenced update after it has written the task: the board-intent
  // read that follows the task write waits on this table lock.
  const blocker = await client!.pool.connect();
  let fenced: Promise<unknown> | undefined;
  let revoked: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE board_intents IN ACCESS EXCLUSIVE MODE");
    fenced = db!.updateTask(s.room.id, s.task.id, { status: "in_review", pr_url: prUrl }, { leaseFence: s.fence });
    fenced.catch(() => {});
    await waitForLockWaiters(1);
    revoked = s.release();
    revoked.catch(() => {});
    await waitForLockWaiters(2);
  } finally {
    await blocker.query("COMMIT");
    blocker.release();
  }
  const results = await Promise.allSettled([fenced!, revoked!]);
  assertNoDeadlock(results);

  // The fenced update ran first, so the revoke saw its writes and undid only
  // what it owns: the assignment, not the PR.
  const task = await db!.getTaskById(s.room.id, s.task.id);
  assert.equal(task?.status, "accepted");
  assert.equal(task?.assignee_agent_key, null);
  assert.equal(task?.pr_url, prUrl);
  const lease = await leaseRow(s.lease.id);
  assert.equal(lease.status, "revoked");
  assert.equal(lease.pr_url, prUrl);
});

test("a lease revoke waits for a fenced write that has already checked the lease", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const fenceHeld = gate();
  const finishFencedWrite = gate();
  const fenced = client!.db.transaction(async (tx) => {
    assert.ok(await acquireLeaseFenceTx(tx, s.fence));
    fenceHeld.open();
    await finishFencedWrite.opened;
  });
  fenced.catch(() => {});
  await Promise.race([fenceHeld.opened, fenced]);
  const revoked = s.release();
  revoked.catch(() => {});
  try {
    const first = await Promise.race([
      revoked.then(() => "revoked", () => "revoked"),
      waitForLockWaiters(1).then(() => "waiting"),
    ]);
    assert.equal(first, "waiting", "the revoke must not move the lease under a fenced write that already checked it");
    assert.equal((await leaseRow(s.lease.id)).status, "active");
  } finally {
    finishFencedWrite.open();
  }
  await fenced;
  const result = await revoked;
  assert.equal(result.conflict, null);
  assert.equal((await leaseRow(s.lease.id)).status, "revoked");
});

test("a lease revoke does not hold the lease lock while it expires other leases", { skip: requiresDatabase }, async () => {
  const s = await seed();
  // An expired lease on another task in the room that no sweep has marked yet.
  const other = await db!.createTask(s.room.id, "other task", s.session.actor_label);
  await db!.createTaskLease({
    room_id: s.room.id, task_id: other.id, kind: "work", agent_key: s.agentKey,
    actor_label: s.session.actor_label, created_by: s.session.actor_label,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
  // A board-intent claim expires stale leases and then takes the lease lock.
  const swept = gate();
  const takeLeaseLock = gate();
  const claim = client!.db.transaction(async (tx) => {
    assert.equal(await expireStaleTaskLeases(s.room.id, new Date(), tx), 1);
    swept.open();
    await takeLeaseLock.opened;
    assert.ok(await acquireLeaseFenceTx(tx, s.fence));
  });
  claim.catch(() => {});
  await Promise.race([swept.opened, claim]);
  const revoked = s.release();
  revoked.catch(() => {});
  try {
    await waitForLockWaiters(1);
  } finally {
    takeLeaseLock.open();
  }
  const results = await Promise.allSettled([claim, revoked]);
  assertNoDeadlock(results);
  assert.equal((await leaseRow(s.lease.id)).status, "revoked");
});

test("a fenced pr_url update does not hold the task while it waits for the lease row", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const prUrl = "https://github.com/example/repo/pull/8";
  const renamed = "Renamed | Owner's agent | Agent";
  // A registration that relabels the agent's work writes its leases, then its
  // tasks, without the lease advisory lock.
  const leaseWritten = gate();
  const writeTask = gate();
  const relabel = client!.db.transaction(async (tx) => {
    await tx.update(schema!.task_leases).set({ actor_label: renamed }).where(eq(schema!.task_leases.id, s.lease.id));
    leaseWritten.open();
    await writeTask.opened;
    await tx.update(schema!.tasks).set({ assignee: renamed }).where(s.taskWhere);
  });
  relabel.catch(() => {});
  await Promise.race([leaseWritten.opened, relabel]);
  const fenced = db!.updateTask(s.room.id, s.task.id, { pr_url: prUrl }, { leaseFence: s.fence });
  fenced.catch(() => {});
  try {
    await waitForLockWaiters(1);
  } finally {
    writeTask.open();
  }
  const results = await Promise.allSettled([relabel, fenced]);
  assertNoDeadlock(results);

  const task = await db!.getTaskById(s.room.id, s.task.id);
  assert.equal(task?.assignee, renamed);
  assert.equal(task?.pr_url, prUrl);
  const lease = await leaseRow(s.lease.id);
  assert.equal(lease.actor_label, renamed);
  assert.equal(lease.pr_url, prUrl);
});

for (const taskAlreadyRenamed of [false, true]) {
  const when = taskAlreadyRenamed ? "only the lease has the old label" : "the task and lease have the old label";
  test(`a fenced exact retry and a registration relabelling the worker both commit when ${when}`, { skip: requiresDatabase }, async () => {
    const s = await seed();
    const prUrl = "https://github.com/example/repo/pull/9";
    const renamed = "Renamed | Owner's agent | Agent";
    // The first attempt commits; the worker then sends the same request again.
    await db!.updateTask(s.room.id, s.task.id, { status: "in_review", pr_url: prUrl }, { leaseFence: s.fence });
    if (taskAlreadyRenamed) {
      // The relabel then has nothing to write on the task and needs only the lease row.
      await client!.db.update(schema!.tasks).set({ assignee: renamed }).where(s.taskWhere);
    }
    // A registration locks the worker's session row, then relabels its work.
    const sessionLocked = gate();
    const relabelWork = gate();
    const registration = client!.db.transaction(async (tx) => {
      await tx.select().from(schema!.room_agent_sessions)
        .where(eq(schema!.room_agent_sessions.session_id, s.session.session_id)).for("update");
      sessionLocked.open();
      await relabelWork.opened;
      await relabelTaskWorkTx(tx, {
        room_id: s.room.id, agent_key: s.agentKey, session_id: s.session.session_id,
        actor_label: renamed, now: new Date().toISOString(),
      });
    });
    registration.catch(() => {});
    await Promise.race([sessionLocked.opened, registration]);
    const retried = db!.updateTask(s.room.id, s.task.id, { status: "in_review", pr_url: prUrl }, { leaseFence: s.fence });
    retried.catch(() => {});
    try {
      await waitForLockWaiters(1);
    } finally {
      relabelWork.open();
    }
    const results = await Promise.allSettled([registration, retried]);
    assertNoDeadlock(results);

    // The retry returns the task as committed, relabelled, without writing it.
    const retriedTask = await retried;
    assert.equal(retriedTask?.status, "in_review");
    assert.equal(retriedTask?.assignee, renamed);
    assert.equal(retriedTask?.pr_url, prUrl);
    const lease = await leaseRow(s.lease.id);
    assert.equal(lease.actor_label, renamed);
    assert.equal(lease.status, "active");
  });
}

test("a lease revoke stamps its write after the fenced write it waited for", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const fenceHeld = gate();
  const finishFencedWrite = gate();
  let fencedWriteAt = "";
  const fenced = client!.db.transaction(async (tx) => {
    assert.ok(await acquireLeaseFenceTx(tx, s.fence));
    fenceHeld.open();
    await finishFencedWrite.opened;
    const written = await updateTaskLeaseWorkflowRefs(s.room.id, s.lease.id, { pr_url: "https://github.com/example/repo/pull/10" }, tx);
    fencedWriteAt = written!.updated_at;
  });
  fenced.catch(() => {});
  await Promise.race([fenceHeld.opened, fenced]);
  const revoked = s.release();
  revoked.catch(() => {});
  try {
    await waitForLockWaiters(1);
    // Let the clock move on past the moment the revoke started waiting.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    finishFencedWrite.open();
  }
  await fenced;
  const result = await revoked;
  assert.equal(result.conflict, null);
  const { rows } = await client!.pool.query<{ ordered: boolean }>(
    "SELECT updated_at >= $1::timestamptz AS ordered FROM task_leases WHERE id = $2",
    [fencedWriteAt, s.lease.id],
  );
  assert.equal(rows[0]?.ordered, true, "the revoke's updated_at must not precede the write it waited for");
});

test("a lease revoke treats a lease that expired while it waited as expired", { skip: requiresDatabase }, async () => {
  const s = await seed({ leaseTtlMs: 1_000 });
  const fenceHeld = gate();
  const finishFencedWrite = gate();
  const fenced = client!.db.transaction(async (tx) => {
    assert.ok(await acquireLeaseFenceTx(tx, s.fence));
    fenceHeld.open();
    await finishFencedWrite.opened;
  });
  fenced.catch(() => {});
  await Promise.race([fenceHeld.opened, fenced]);
  const revoked = s.release();
  revoked.catch(() => {});
  try {
    await waitForLockWaiters(1);
    const expiresAt = Date.parse(s.lease.expires_at!);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 50));
  } finally {
    finishFencedWrite.open();
  }
  await fenced;
  const result = await revoked;
  assert.equal(result.conflict, "lease_not_active");
  assert.equal((await db!.getTaskById(s.room.id, s.task.id))?.status, "in_progress");
});

test("a fenced write that becomes an exact retry only under the task lock and a relabel both commit", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const prUrl = "https://github.com/example/repo/pull/11";
  const renamed = "Renamed | Owner's agent | Agent";
  // A registration holds the worker's session row and is about to relabel its work.
  const sessionLocked = gate();
  const relabelWork = gate();
  const registration = client!.db.transaction(async (tx) => {
    await tx.select().from(schema!.room_agent_sessions)
      .where(eq(schema!.room_agent_sessions.session_id, s.session.session_id)).for("update");
    sessionLocked.open();
    await relabelWork.opened;
    await relabelTaskWorkTx(tx, {
      room_id: s.room.id, agent_key: s.agentKey, session_id: s.session.session_id,
      actor_label: renamed, now: new Date().toISOString(),
    });
  });
  registration.catch(() => {});
  await Promise.race([sessionLocked.opened, registration]);
  // The first of two identical requests holds the lease lock while it writes
  // the change. It writes unfenced, which takes no session lock, so it can
  // finish while the registration holds the session.
  const firstWritten = gate();
  const commitFirst = gate();
  const first = client!.db.transaction(async (tx) => {
    assert.ok(await acquireLeaseFenceTx(tx, s.fence));
    await db!.updateTask(s.room.id, s.task.id, { status: "in_review", pr_url: prUrl }, undefined, tx);
    firstWritten.open();
    await commitFirst.opened;
  });
  first.catch(() => {});
  await Promise.race([firstWritten.opened, first]);
  // The second reads the task while it is still in progress, so it is not a
  // retry until it reads the task again under its lock.
  const second = db!.updateTask(s.room.id, s.task.id, { status: "in_review", pr_url: prUrl }, { leaseFence: s.fence });
  second.catch(() => {});
  try {
    await waitForLockWaiters(1);
    commitFirst.open();
    await first;
    await waitForLockWaiters(1, { rowLocksOnly: true });
  } finally {
    commitFirst.open();
    relabelWork.open();
  }
  const results = await Promise.allSettled([registration, second]);
  assertNoDeadlock(results);

  // The second returns the first's commit, as the registration relabelled it.
  const secondTask = await second;
  assert.equal(secondTask?.status, "in_review");
  assert.equal(secondTask?.assignee, renamed);
  assert.equal(secondTask?.pr_url, prUrl);
  assert.equal((await leaseRow(s.lease.id)).actor_label, renamed);
});

test("a fenced task write stamps its update after the write it waited for", { skip: requiresDatabase }, async () => {
  const s = await seed();
  const fenceHeld = gate();
  const finishOtherWrite = gate();
  let otherWriteAt = "";
  const other = client!.db.transaction(async (tx) => {
    assert.ok(await acquireLeaseFenceTx(tx, s.fence));
    fenceHeld.open();
    await finishOtherWrite.opened;
    const written = await db!.updateTask(s.room.id, s.task.id, { description: "Rescoped while the fenced write waited." }, undefined, tx);
    otherWriteAt = written!.updated_at;
  });
  other.catch(() => {});
  await Promise.race([fenceHeld.opened, other]);
  const fenced = db!.updateTask(s.room.id, s.task.id, { pr_url: "https://github.com/example/repo/pull/12" }, { leaseFence: s.fence });
  fenced.catch(() => {});
  try {
    await waitForLockWaiters(1);
    // Let the clock move on past the moment the fenced write started waiting.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    finishOtherWrite.open();
  }
  await other;
  await fenced;
  const { rows } = await client!.pool.query<{ ordered: boolean }>(
    "SELECT updated_at >= $1::timestamptz AS ordered FROM tasks WHERE room_id = $2 AND number = $3",
    [otherWriteAt, s.room.id, Number(s.task.id.replace("task_", ""))],
  );
  assert.equal(rows[0]?.ordered, true, "the fenced write's updated_at must not precede the write it waited for");
});
