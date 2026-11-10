import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
} else {
  process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const deliveries = testDatabaseUrl ? await import("../db/github/webhook-deliveries.js") : null;
const roomEvents = testDatabaseUrl ? await import("../db/github/room-events.js") : null;
const rollout = testDatabaseUrl ? await import("../db/github-webhook-integrity-rollout.js") : null;
const redrive = testDatabaseUrl ? await import("../github/webhook-redrive.js") : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const skip = requiresDatabase ? "set TEST_DB_URL to run DB-backed webhook delivery recovery tests" : false;
const STALE_MS = 5 * 60_000;

test.beforeEach(async () => {
  if (requiresDatabase) return;
  await pool!.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool!.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool!.query("CREATE SCHEMA public");
  await migrate(db!, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
});

if (!requiresDatabase) {
  test.after(async () => {
    await pool?.end();
  });
}

function claim(deliveryId: string, now?: Date) {
  return deliveries!.claimGitHubWebhookDelivery({
    delivery_id: deliveryId,
    event_name: "check_run",
    action: "completed",
    payload: { action: "completed", marker: deliveryId },
    now,
  });
}

async function setDelivery(deliveryId: string, fields: { status?: string; claimed_at?: string; attempts?: number }) {
  await pool!.query(
    `UPDATE github_webhook_deliveries
        SET status = COALESCE($2, status),
            claimed_at = COALESCE($3::timestamptz, claimed_at),
            attempts = COALESCE($4, attempts)
      WHERE delivery_id = $1`,
    [deliveryId, fields.status ?? null, fields.claimed_at ?? null, fields.attempts ?? null],
  );
}

test("a delivery is claimed once; a failed or stale 'received' one is claimed again as a retry", { concurrency: false, skip }, async () => {
  const first = await claim("d-1");
  assert.equal(first.claimed, true);
  assert.equal(first.claimed && first.retry, false);

  assert.equal((await claim("d-1")).claimed, false, "a delivery being processed now is a duplicate");

  await deliveries!.markGitHubWebhookDeliveryProcessed("d-1", { status: "processed" });
  assert.equal((await claim("d-1")).claimed, false, "a processed delivery is a duplicate");

  await deliveries!.markGitHubWebhookDeliveryProcessed("d-1", { status: "failed", error: "boom" });
  const afterFailure = await claim("d-1");
  assert.equal(afterFailure.claimed && afterFailure.retry, true, "a failed delivery is retried");

  await setDelivery("d-1", { claimed_at: new Date(Date.now() - STALE_MS - 1_000).toISOString() });
  const afterStop = await claim("d-1");
  assert.equal(afterStop.claimed && afterStop.retry, true, "a stale 'received' delivery is retried");

  const stored = await pool!.query("SELECT status, attempts, payload FROM github_webhook_deliveries WHERE delivery_id = 'd-1'");
  assert.equal(stored.rows[0].status, "received");
  assert.equal(stored.rows[0].attempts, 3);
  assert.deepEqual(stored.rows[0].payload, { action: "completed", marker: "d-1" });
});

test("concurrent redeliveries of one stale delivery claim it exactly once", { concurrency: false, skip }, async () => {
  await claim("d-race");
  await setDelivery("d-race", { claimed_at: new Date(Date.now() - STALE_MS - 1_000).toISOString() });
  const claims = await Promise.all(Array.from({ length: 8 }, () => claim("d-race")));
  assert.equal(claims.filter((result) => result.claimed).length, 1);
});

test("the liveness redrive processes a stale 'received' delivery once, and gives up on one past its attempts", { concurrency: false, skip }, async () => {
  await claim("d-stuck");
  await claim("d-fresh");
  await claim("d-exhausted");
  const old = new Date(Date.now() - STALE_MS - 1_000).toISOString();
  await setDelivery("d-stuck", { claimed_at: old });
  await setDelivery("d-exhausted", { claimed_at: old, attempts: 5 });

  const calls: Array<{ deliveryId: string; payload: unknown; retry?: boolean }> = [];
  const handleGitHubWebhookEvent = async (
    _eventName: string,
    payload: unknown,
    deliveryId: string,
    options?: { retryFailedDelivery?: boolean },
  ) => {
    calls.push({ deliveryId, payload, retry: options?.retryFailedDelivery });
    return { status: "processed" as const, installationId: null, githubRepoId: null, roomId: null };
  };

  assert.equal(await redrive!.redriveStaleGitHubWebhookDeliveries({ handleGitHubWebhookEvent: handleGitHubWebhookEvent as never }), 1);
  assert.deepEqual(calls, [{ deliveryId: "d-stuck", payload: { action: "completed", marker: "d-stuck" }, retry: true }]);
  const stuck = await pool!.query("SELECT status, payload FROM github_webhook_deliveries WHERE delivery_id = 'd-stuck'");
  assert.equal(stuck.rows[0].status, "processed");
  assert.equal(stuck.rows[0].payload, null);

  const exhausted = await pool!.query("SELECT status, payload, error FROM github_webhook_deliveries WHERE delivery_id = 'd-exhausted'");
  assert.equal(exhausted.rows[0].status, "failed", "a delivery past its attempts is given up, not left 'received'");
  assert.equal(exhausted.rows[0].payload, null);
  assert.match(exhausted.rows[0].error, /Gave up after 5 attempts/);

  assert.equal(await redrive!.redriveStaleGitHubWebhookDeliveries({ handleGitHubWebhookEvent: handleGitHubWebhookEvent as never }), 0);
  assert.equal(calls.length, 1, "a fresh delivery is left alone");
});

test("a runner whose claim was taken over records nothing", { concurrency: false, skip }, async () => {
  const first = await claim("d-slow");
  assert.ok(first.claimed);
  // The first runner is still busy past the stale age; a redelivery takes over.
  await setDelivery("d-slow", { claimed_at: new Date(Date.now() - STALE_MS - 1_000).toISOString() });
  const second = await claim("d-slow");
  assert.ok(second.claimed);
  assert.notEqual(second.attempt, first.attempt);

  assert.equal(await deliveries!.markGitHubWebhookDeliveryProcessed("d-slow", { status: "processed", attempt: second.attempt }), true);
  assert.equal(
    await deliveries!.markGitHubWebhookDeliveryProcessed("d-slow", { status: "failed", error: "late", attempt: first.attempt }),
    false,
  );
  const stored = await pool!.query("SELECT status, error FROM github_webhook_deliveries WHERE delivery_id = 'd-slow'");
  assert.equal(stored.rows[0].status, "processed");
  assert.equal(stored.rows[0].error, null);
});

async function holdWriteOnRoomEvents() {
  const other = await pool!.connect();
  await other.query("BEGIN");
  await other.query(
    `INSERT INTO github_room_events (id, event_type, action, idempotency_key, event_order_at, created_at)
     VALUES ('gre_held', 'push', 'pushed', 'held-key', now(), now())`,
  );
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await other.query("COMMIT");
      other.release();
    },
  };
}

async function validIndexes(): Promise<string[]> {
  const result = await pool!.query<{ name: string }>(
    `SELECT pg_class.relname AS name FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid
      WHERE pg_index.indisvalid AND pg_class.relname = ANY($1) ORDER BY 1`,
    [["github_room_events_semantic_id_unique", "github_webhook_deliveries_received_idx"]],
  );
  return result.rows.map((row) => row.name);
}

test("the index build retries while an older transaction blocks it", { concurrency: false, skip }, async () => {
  const held = await holdWriteOnRoomEvents();
  const lines: string[] = [];
  try {
    const built = await rollout!.reconcileGitHubWebhookIntegrityRollout(pool!, {
      lockTimeout: "200ms",
      lockRetryDelaysMs: [50, 50, 50],
      log: (line) => {
        lines.push(line);
        void held.release();
      },
    });
    assert.deepEqual(built.sort(), ["github_room_events_semantic_id_unique", "github_webhook_deliveries_received_idx"]);
  } finally {
    await held.release();
  }
  assert.ok(lines.some((line) => /waiting for an older transaction; retry 1/.test(line)), lines.join("\n"));
  assert.deepEqual(await validIndexes(), ["github_room_events_semantic_id_unique", "github_webhook_deliveries_received_idx"]);
});

test("when the build cannot run, the rollout says so, does not fail, and a later run builds it", { concurrency: false, skip }, async () => {
  const held = await holdWriteOnRoomEvents();
  const lines: string[] = [];
  try {
    const built = await rollout!.reconcileGitHubWebhookIntegrityRollout(pool!, {
      lockTimeout: "100ms",
      lockRetryDelaysMs: [20],
      log: (line) => lines.push(line),
    });
    assert.ok(!built.includes("github_room_events_semantic_id_unique"));
  } finally {
    await held.release();
  }
  assert.ok(lines.some((line) => /github_room_events_semantic_id_unique was not built/.test(line)), lines.join("\n"));
  assert.ok(
    lines.some((line) => /github_webhook_deliveries_received_idx was not built in this run/.test(line)),
    "after one index gives up, the other is left for the next run",
  );
  assert.deepEqual(await validIndexes(), []);

  await rollout!.reconcileGitHubWebhookIntegrityRollout(pool!, { log: () => {} });
  assert.deepEqual(await validIndexes(), ["github_room_events_semantic_id_unique", "github_webhook_deliveries_received_idx"]);
});

async function insertRawEvent(id: string, semanticId: string, createdAt: string) {
  await pool!.query(
    `INSERT INTO github_room_events (id, event_type, action, idempotency_key, semantic_id, event_order_at, created_at)
     VALUES ($1, 'pull_request', 'opened', $2, $3, $4, $4)`,
    [id, `key-${id}`, semanticId, createdAt],
  );
}

test("the rollout keeps the earliest event of each semantic_id, deletes none, and makes semantic_id unique", { concurrency: false, skip }, async () => {
  await insertRawEvent("gre_late", "repo:pr:1:opened", "2026-11-02T00:00:00.000Z");
  await insertRawEvent("gre_early", "repo:pr:1:opened", "2026-11-01T00:00:00.000Z");
  await insertRawEvent("gre_other", "repo:pr:2:opened", "2026-11-01T00:00:00.000Z");

  const built = await rollout!.reconcileGitHubWebhookIntegrityRollout(pool!);
  assert.deepEqual(built.sort(), ["github_room_events_semantic_id_unique", "github_webhook_deliveries_received_idx"]);
  const rows = await pool!.query("SELECT id, semantic_id FROM github_room_events ORDER BY id");
  assert.deepEqual(rows.rows, [
    { id: "gre_early", semantic_id: "repo:pr:1:opened" },
    { id: "gre_late", semantic_id: null },
    { id: "gre_other", semantic_id: "repo:pr:2:opened" },
  ]);
  assert.deepEqual(await rollout!.reconcileGitHubWebhookIntegrityRollout(pool!), [], "a second run builds nothing");
  await assert.rejects(
    insertRawEvent("gre_again", "repo:pr:2:opened", "2026-11-03T00:00:00.000Z"),
    (error: { code?: string }) => error.code === "23505",
  );
});

test("an insert racing an uncommitted event with the same semantic_id reports a duplicate, not a second row", { concurrency: false, skip }, async () => {
  await rollout!.reconcileGitHubWebhookIntegrityRollout(pool!);
  const other = await pool!.connect();
  try {
    // Another delivery has written this semantic_id and not committed yet, so
    // the read before the insert cannot see it.
    await other.query("BEGIN");
    await other.query(
      `INSERT INTO github_room_events (id, event_type, action, idempotency_key, semantic_id, event_order_at, created_at)
       VALUES ('gre_first', 'pull_request', 'opened', 'repo:pr:7:opened:delivery:a', 'repo:pr:7:opened', now(), now())`,
    );
    const racing = roomEvents!.insertGitHubRoomEvent({
      event_type: "pull_request",
      action: "opened",
      idempotency_key: "repo:pr:7:opened:delivery:b",
      semantic_id: "repo:pr:7:opened",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await other.query("COMMIT");
    const result = await racing;
    assert.equal(result.duplicate, true);
    assert.equal(result.event.id, "gre_first");
  } finally {
    await other.query("ROLLBACK").catch(() => {});
    other.release();
  }
  const count = await pool!.query("SELECT count(*)::int AS n FROM github_room_events WHERE semantic_id = 'repo:pr:7:opened'");
  assert.equal(count.rows[0].n, 1);
});
