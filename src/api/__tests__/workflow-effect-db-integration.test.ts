import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const db = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;

async function reset(): Promise<void> {
  if (!client) throw new Error("DB-backed workflow effect tests require TEST_DB_URL");
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

async function seed() {
  const n = ++ordinal;
  const ownerId = `effect_owner_${n}`;
  const now = new Date().toISOString();
  await client!.db.insert(schema!.accounts).values({
    id: ownerId,
    provider: "github",
    provider_user_id: ownerId,
    login: ownerId,
    display_name: ownerId,
    avatar_url: null,
    created_at: now,
    updated_at: now,
  });
  const room = await db!.createProjectWithName(`workflow-effect-room-${n}`);
  const task = await db!.createTask(room.id, `Effect task ${n}`, ownerId);
  const makeSession = (suffix: string) => db!.createRoomAgentSession({
    room_id: room.id,
    session_kind: "worker",
    runtime: "codex",
    actor_label: `Reviewer ${suffix}`,
    agent_key: `${ownerId}/reviewer-${suffix}`,
    agent_instance_id: `effect_instance_${n}_${suffix}`,
    display_name: `Reviewer ${suffix}`,
    owner_account_id: ownerId,
    owner_label: ownerId,
    ide_label: "Agent",
  });
  const [firstSession, secondSession] = await Promise.all([makeSession("a"), makeSession("b")]);
  const makeLease = (session: Awaited<ReturnType<typeof makeSession>>) => db!.createTaskLease({
    room_id: room.id,
    task_id: task.id,
    kind: "review",
    agent_key: session.agent_key,
    actor_label: session.actor_label,
    created_by: session.actor_label,
    agent_session_id: session.session_id,
  });
  const [firstLease, secondLease] = await Promise.all([makeLease(firstSession), makeLease(secondSession)]);
  return { room, task, firstSession, secondSession, firstLease, secondLease };
}

function reserveInput(
  seeded: Awaited<ReturnType<typeof seed>>,
  which: "first" | "second" = "first",
) {
  const session = which === "first" ? seeded.firstSession : seeded.secondSession;
  const lease = which === "first" ? seeded.firstLease : seeded.secondLease;
  return {
    room_id: seeded.room.id,
    task_id: seeded.task.id,
    lease_id: lease.id,
    lease_epoch: lease.epoch,
    agent_key: session.agent_key,
    agent_session_id: session.session_id,
    kind: "github_review_verdict" as const,
    provider: "github" as const,
    idempotency_key: "review-head-sha",
    request_payload: {
      owner: "BrosInCode",
      repo: "letagents",
      pull_number: 777,
      expected_head_sha: "a".repeat(40),
      installation_id: "installation_1",
      verdict: "approve",
      body: "Verified exact head.",
    },
    created_by: session.actor_label,
  };
}

test("PostgreSQL unique reservation lets concurrent reviewers create one effect", { skip: requiresDatabase }, async () => {
  const seeded = await seed();
  const results = await Promise.all([
    db!.reserveWorkflowEffect(reserveInput(seeded, "first")),
    db!.reserveWorkflowEffect(reserveInput(seeded, "second")),
  ]);
  assert.equal(new Set(results.map((result) => result.effect.id)).size, 1);
  assert.equal(results.filter((result) => result.claimed).length, 1);
  const rows = await client!.db.select().from(schema!.workflow_effects).where(and(
    eq(schema!.workflow_effects.room_id, seeded.room.id),
    eq(schema!.workflow_effects.idempotency_key, "review-head-sha"),
  ));
  assert.equal(rows.length, 1);
});

test("expected head SHA participates in the durable replay fingerprint", { skip: requiresDatabase }, async () => {
  const seeded = await seed();
  const first = await db!.reserveWorkflowEffect(reserveInput(seeded));
  assert.equal(first.effect.request_payload.expected_head_sha, "a".repeat(40));
  await assert.rejects(
    db!.reserveWorkflowEffect({
      ...reserveInput(seeded),
      request_payload: {
        ...reserveInput(seeded).request_payload,
        expected_head_sha: "b".repeat(40),
      },
    }),
    (error: Error & { code?: string }) => error.code === "workflow_effect_idempotency_conflict",
  );
});

test("release-first barrier rejects a stale reservation and persists no effect", { skip: requiresDatabase }, async () => {
  const seeded = await seed();
  const holder = await client!.pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("UPDATE task_leases SET status = 'released', updated_at = now() WHERE id = $1", [seeded.firstLease.id]);
    let settled = false;
    const reservation = db!.reserveWorkflowEffect(reserveInput(seeded)).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "reservation waits on the uncommitted lease release");
    await holder.query("COMMIT");
    await assert.rejects(reservation, (error: Error) => error.name === "WorkflowEffectLeaseStaleError");
  } finally {
    if (!holder.released) {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }
  const rows = await client!.db.select().from(schema!.workflow_effects)
    .where(eq(schema!.workflow_effects.room_id, seeded.room.id));
  assert.equal(rows.length, 0);
});

test("reserve-first barrier commits authority before a concurrent release", { skip: requiresDatabase }, async () => {
  const seeded = await seed();
  let signalLocked!: () => void;
  let allowReservation!: () => void;
  const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
  const gate = new Promise<void>((resolve) => { allowReservation = resolve; });
  const reservation = db!.reserveWorkflowEffect({
    ...reserveInput(seeded),
    on_lease_locked_for_test: async () => {
      signalLocked();
      await gate;
    },
  });
  await locked;
  let releaseSettled = false;
  const release = db!.releaseTaskLease(seeded.room.id, seeded.firstLease.id, {
    kind: "review",
    expected_epoch: seeded.firstLease.epoch,
    expected_agent_session_id: seeded.firstSession.session_id,
  }).finally(() => { releaseSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(releaseSettled, false, "release waits for the reservation's lease-row lock");
  allowReservation();
  const reserved = await reservation;
  assert.equal(reserved.claimed, true);
  assert.ok(await release, "release proceeds only after reservation commits");
  const [row] = await client!.db.select().from(schema!.workflow_effects)
    .where(eq(schema!.workflow_effects.id, reserved.effect.id));
  assert.ok(row, "the authorized effect remains durable after the later release");
});

test("settled effect retention prunes only terminal rows older than the bounded window", { skip: requiresDatabase }, async () => {
  const retentionIndexes = await client!.pool.query<{ indexdef: string }>(`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'workflow_effects'
      AND indexname = 'workflow_effects_retention_idx'
  `);
  assert.equal(retentionIndexes.rowCount, 1, "migration creates the bounded retention index");
  assert.match(retentionIndexes.rows[0]!.indexdef, /USING btree \(updated_at\) WHERE/);
  assert.match(retentionIndexes.rows[0]!.indexdef, /quarantined_at IS NOT NULL/);

  const seeded = await seed();
  const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
  const reserve = async (key: string, quarantineReason?: string) => db!.reserveWorkflowEffect({
    ...reserveInput(seeded),
    idempotency_key: key,
    quarantine_reason: quarantineReason,
  });
  const succeeded = await reserve("settled-succeeded");
  const failed = await reserve("settled-failed");
  const quarantined = await reserve("settled-quarantined", "Blocking verdict was junk.");
  const ambiguous = await reserve("old-ambiguous");
  const recent = await reserve("recent-succeeded");

  await client!.db.update(schema!.workflow_effects).set({
    state: "succeeded",
    processing_token: null,
    processing_started_at: null,
    external_id: "review_old",
    completed_at: old,
    updated_at: old,
  }).where(eq(schema!.workflow_effects.id, succeeded.effect.id));
  await client!.db.update(schema!.workflow_effects).set({
    state: "failed",
    attempt_count: 3,
    processing_token: null,
    processing_started_at: null,
    updated_at: old,
  }).where(eq(schema!.workflow_effects.id, failed.effect.id));
  await client!.db.update(schema!.workflow_effects).set({ updated_at: old })
    .where(eq(schema!.workflow_effects.id, quarantined.effect.id));
  await client!.db.update(schema!.workflow_effects).set({
    state: "ambiguous",
    processing_token: null,
    processing_started_at: null,
    updated_at: old,
  }).where(eq(schema!.workflow_effects.id, ambiguous.effect.id));
  await client!.db.update(schema!.workflow_effects).set({
    state: "succeeded",
    processing_token: null,
    processing_started_at: null,
    external_id: "review_recent",
    completed_at: new Date().toISOString(),
  }).where(eq(schema!.workflow_effects.id, recent.effect.id));

  assert.equal(await db!.pruneSettledWorkflowEffects({
    settled_before: new Date(Date.now() - 30 * 24 * 60 * 60_000),
  }), 3);
  const remaining = await client!.db.select({ id: schema!.workflow_effects.id })
    .from(schema!.workflow_effects)
    .where(eq(schema!.workflow_effects.room_id, seeded.room.id));
  assert.deepEqual(
    new Set(remaining.map((row) => row.id)),
    new Set([ambiguous.effect.id, recent.effect.id]),
  );
});
