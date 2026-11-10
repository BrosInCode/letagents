import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { migrate } from "drizzle-orm/node-postgres/migrator";

// The background job workers (Jev routing, desktop pushes, wake deliveries)
// against a real database: idle they run no claim between fallbacks, a
// committed row is claimed at once, and a row due later is claimed at its
// due time. The fallback is set far beyond each case, so only a wake or a
// due time can explain a claim.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
// No APNs key: the push worker still turns due reminders into deliveries.
delete process.env.APNS_TEAM_ID;
delete process.env.APNS_KEY_ID;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the job queue wake DB tests";
const client = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const wakes = testDatabaseUrl ? await import("../server/job-queue-wakes.js") : null;
const jev = testDatabaseUrl ? await import("../messages/jev-routing-worker.js") : null;
const push = testDatabaseUrl ? await import("../notifications/worker.js") : null;
const wakeDeliveries = testDatabaseUrl ? await import("../notifications/wake-webhooks.js") : null;
const reminders = testDatabaseUrl ? await import("../notifications/reminders.js") : null;
const settle = testDatabaseUrl ? await import("./settle-background-db-work.js") : null;

const FAR_FALLBACK_MS = 600_000;
/**
 * How long a claim may take on a slow shared runner. Every bound here is
 * generous: with the fallback ten minutes away, a claim within it can only
 * come from a wake or a due time, so the bound proves nothing by being tight.
 */
const CLAIM_WITHIN_MS = 15_000;

if (testDatabaseUrl) {
  test.beforeEach(async () => {
    await settle!.settleBackgroundDbWork();
    await client!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client!.pool.query("CREATE SCHEMA public");
    await migrate(client!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  });
  test.after(async () => {
    await settle!.settleBackgroundDbWork();
    await client!.pool.end();
  });
}

/** Counts every statement and transaction the process starts on the shared pool. */
function countPoolUse(): { count(): number; reset(): void; restore(): void } {
  const pool = client!.pool;
  const query = pool.query;
  const connect = pool.connect;
  let used = 0;
  pool.query = function (this: typeof pool, ...args: unknown[]) {
    used += 1;
    return (query as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof pool.query;
  pool.connect = function (this: typeof pool, ...args: unknown[]) {
    used += 1;
    return (connect as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof pool.connect;
  return {
    count: () => used,
    reset: () => { used = 0; },
    restore: () => { pool.query = query; pool.connect = connect; },
  };
}

async function until(label: string, check: () => Promise<boolean>, limitMs = CLAIM_WITHIN_MS): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (await check()) return Date.now() - started;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

let sequence = 0;
async function seedRoom() {
  sequence += 1;
  const account = await api!.upsertAccount({ provider: "github", provider_user_id: `jobs-${sequence}`, login: `jobs-${sequence}` });
  const room = await api!.createProjectWithName(`jobs-room-${sequence}`);
  const message = await api!.addMessage(room.id, "Agent", "hello", { source: "agent" });
  return { account, room, messageNumber: Number(message.id.slice(4)) };
}

async function jobState(roomId: string, messageNumber: number): Promise<string | undefined> {
  const result = await client!.pool.query<{ state: string }>(
    "SELECT state FROM jev_routing_jobs WHERE room_id = $1 AND message_number = $2", [roomId, messageNumber]);
  return result.rows[0]?.state;
}

async function insertJevJob(roomId: string, messageNumber: number, dueInMs: number): Promise<string> {
  // A shadow plan past its deadline completes with no inference call.
  const plan = { mode: "shadow", roomId, message: { number: messageNumber, publisher_agent_key: null },
    heuristic: null, agent_count: 3, no_wake: null };
  const inserted = await client!.pool.query<{ due: string }>(`
    INSERT INTO jev_routing_jobs (room_id, message_number, plan, available_at, expires_at)
    VALUES ($1, $2, $3, now() + ($4::int * interval '1 millisecond'), now() - interval '1 second')
    RETURNING available_at::text AS due
  `, [roomId, messageNumber, JSON.stringify(plan), dueInMs]);
  // A claim moves available_at to the end of its lease: keep the due time it was inserted with.
  return inserted.rows[0]!.due;
}

test("idle workers run no claim query between fallbacks", { skip }, async () => {
  const counter = countPoolUse();
  const stopJev = jev!.startJevRoutingWorker({ fallbackMs: FAR_FALLBACK_MS });
  const stopPush = push!.startDesktopPushWorker({ fallbackMs: FAR_FALLBACK_MS });
  try {
    // The start pass of every loop (claims, cleanup, next-due reads).
    await until("the start passes", async () => { const before = counter.count(); await delay(300); return counter.count() === before && before > 0; });
    counter.reset();
    await delay(2_000);
    // Before: Jev claimed every 250 ms, the three wake lanes every second
    // and the push worker every 2 s: about 15 claims in these 2 seconds.
    assert.equal(counter.count(), 0, "no query while idle");
  } finally {
    await Promise.all([stopJev(), stopPush()]);
    counter.restore();
  }
});

test("a Jev job is claimed at once on a wake and a lease or retry at its due time", { skip }, async () => {
  const stop = jev!.startJevRoutingWorker({ fallbackMs: FAR_FALLBACK_MS });
  try {
    await delay(200);
    const { room, messageNumber } = await seedRoom();
    await insertJevJob(room.id, messageNumber, 0);
    wakes!.wakeJobQueue("jev_routing");
    await until("the woken claim", async () => await jobState(room.id, messageNumber) === "completed");

    const later = await api!.addMessage(room.id, "Agent", "later", { source: "agent" });
    const laterNumber = Number(later.id.slice(4));
    const dueAt = await insertJevJob(room.id, laterNumber, 1_500);
    wakes!.wakeJobQueue("jev_routing");
    // Until the database says the job is due, it must still be pending; then it is claimed.
    let sawPendingBeforeDue = false;
    await until("the due claim", async () => {
      const row = (await client!.pool.query<{ state: string; due: boolean }>(
        "SELECT state, $3::timestamptz <= now() AS due FROM jev_routing_jobs WHERE room_id = $1 AND message_number = $2",
        [room.id, laterNumber, dueAt])).rows[0]!;
      if (!row.due && row.state !== "pending") assert.fail(`claimed before its due time (${row.state})`);
      if (!row.due) sawPendingBeforeDue = true;
      return row.state === "completed";
    });
    assert.ok(sawPendingBeforeDue, "the job was seen waiting before its due time");
  } finally {
    await stop();
  }
});

test("a message send wakes the push queue after its rows commit", { skip }, async () => {
  const { account, room } = await seedRoom();
  await client!.pool.query(`
    INSERT INTO desktop_push_devices (id, account_id, installation_id, device_token, token_hash, bundle_id,
      environment, enabled, failure_count, last_registered_at, created_at, updated_at)
    VALUES ('device-jobs', $1, 'installation-jobs', $2, 'hash-jobs', 'chat.letagents.desktop', 'production', TRUE, 0, now(), now(), now())
  `, [account.id, "a".repeat(64)]);
  await client!.pool.query(`INSERT INTO account_room_recents (account_id, room_id, first_opened_at, last_opened_at, updated_at)
    VALUES ($1, $2, now(), now(), now())`, [account.id, room.id]);
  const seen: Array<Promise<number>> = [];
  const off = wakes!.onJobQueueWake("desktop_push", () => {
    // Read on another connection: the row is visible only after commit.
    seen.push(client!.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM desktop_push_notifications")
      .then((result) => result.rows[0]!.n));
  });
  try {
    await api!.addMessage(room.id, "Agent", "ping", { source: "agent" });
    assert.equal(seen.length, 1, "one wake for the send");
    assert.equal(await seen[0], 1, "the queued push is committed when the wake fires");
    // A send that queues no push (the room's only device belongs to the sender) does not wake.
    await api!.addMessage(room.id, "Ada", "mine", { source: "browser", account_id: account.id });
    assert.equal(seen.length, 1);
  } finally {
    off();
  }
});

test("a reminder becomes a push at its due time, and push retries are scheduled", { skip }, async () => {
  const stop = push!.startDesktopPushWorker({ fallbackMs: FAR_FALLBACK_MS });
  try {
    await delay(200);
    const { account, room, messageNumber } = await seedRoom();
    const created = await reminders!.createMessageReminder({ accountId: account.id, roomId: room.id, messageNumber,
      dueAt: new Date(Date.now() + 1_500).toISOString() });
    assert.ok(created.reminder);
    let sawPendingBeforeDue = false;
    await until("the due reminder", async () => {
      const row = (await client!.pool.query<{ state: string; due: boolean }>(
        "SELECT state, due_at <= now() AS due FROM message_reminders WHERE id = $1", [created.reminder.id])).rows[0]!;
      if (!row.due && row.state !== "pending") assert.fail("enqueued before its due time");
      if (!row.due) sawPendingBeforeDue = true;
      return row.state === "due";
    });
    assert.ok(sawPendingBeforeDue, "the reminder was seen waiting before its due time");

    // The next due time counts a retry of any outbox.
    assert.equal(await push!.nextDesktopPushDueInMs(true), null);
    await client!.pool.query(`
      INSERT INTO desktop_push_devices (id, account_id, installation_id, device_token, token_hash, bundle_id,
        environment, enabled, failure_count, last_registered_at, created_at, updated_at)
      VALUES ('device-retry', $1, 'installation-retry', $2, 'hash-retry', 'chat.letagents.desktop', 'production', TRUE, 0, now(), now(), now())
    `, [account.id, "b".repeat(64)]);
    await client!.pool.query(`
      INSERT INTO desktop_push_notifications (id, device_id, room_id, message_number, room_display_name, sender, body,
        state, attempt_count, next_attempt_at, created_at, updated_at)
      VALUES ('retry-1', 'device-retry', $1, $2, 'Room', 'Agent', 'hello', 'retry', 1, now() + interval '90 seconds', now(), now())
    `, [room.id, messageNumber]);
    const dueIn = await push!.nextDesktopPushDueInMs(true);
    assert.ok(dueIn !== null && dueIn > 85_000 && dueIn <= 90_000, `retry due in ${dueIn} ms`);
    assert.equal(await push!.nextDesktopPushDueInMs(false), null, "without APNs only reminders count");
  } finally {
    await stop();
  }
});

test("a wake delivery is claimed at once on a wake and a retry at its due time", { skip }, async () => {
  const stop = wakeDeliveries!.startWakeWebhookWorker({ fallbackMs: FAR_FALLBACK_MS });
  try {
    await delay(200);
    const { account, room } = await seedRoom();
    await client!.pool.query(`
      INSERT INTO agent_wake_rules (id, room_id, agent_key, agent_name, event, arguments, identity_key, cursor_at,
        created_at, updated_at, owner_account_id, delivery_kind, delivery_target)
      VALUES ('rule-jobs', $1, 'owner/agent', 'Agent', 'room.message', '{}', 'jobs', now(), now(), now(), $2,
        'webhook', '{"sealed": "never opened by a test delivery"}')
    `, [room.id, account.id]);
    // A test delivery left behind is dropped on its first attempt: no network.
    const insert = (id: string, dueInMs: number) => client!.pool.query(`
      INSERT INTO wake_webhook_deliveries (id, rule_id, room_id, kind, purpose, sender, text_preview, state,
        scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id)
      VALUES ($1, 'rule-jobs', $2, 'webhook', 'test', '', '', 'retry',
        now(), now() + ($3::int * interval '1 millisecond'), now(), now(), $4)
    `, [id, room.id, dueInMs, account.id]);
    const state = async (id: string) => (await client!.pool.query<{ state: string }>(
      "SELECT state FROM wake_webhook_deliveries WHERE id = $1", [id])).rows[0]?.state;

    await insert("whd-now", 0);
    wakes!.wakeJobQueue("wake_delivery");
    await until("the woken claim", async () => await state("whd-now") === "dead");

    await insert("whd-later", 1_500);
    wakes!.wakeJobQueue("wake_delivery");
    let sawWaitingBeforeDue = false;
    await until("the due claim", async () => {
      const row = (await client!.pool.query<{ state: string; due: boolean }>(
        "SELECT state, next_attempt_at <= now() AS due FROM wake_webhook_deliveries WHERE id = 'whd-later'")).rows[0]!;
      if (!row.due && row.state !== "retry") assert.fail(`claimed before its due time (${row.state})`);
      if (!row.due) sawWaitingBeforeDue = true;
      return row.state === "dead";
    });
    assert.ok(sawWaitingBeforeDue, "the delivery was seen waiting before its due time");
    assert.equal(await wakeDeliveries!.nextWakeDeliveryDueInMs("webhook"), null);
  } finally {
    await stop();
  }
});

test("a finished delivery of one kind wakes the lanes its account cap was blocking", { skip }, async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deps = {
    ...wakeDeliveries!.defaultWakeWebhookDeps(),
    credentialLive: async () => true,
    // Three webhook deliveries hold the account's in-flight cap until the gate opens.
    authorize: async () => { await gate; return "deny" as const; },
  };
  const stop = wakeDeliveries!.startWakeWebhookWorker({ fallbackMs: FAR_FALLBACK_MS, deps });
  try {
    await delay(200);
    const { account, room } = await seedRoom();
    await client!.pool.query(`
      INSERT INTO agent_wake_rules (id, room_id, agent_key, agent_name, event, arguments, identity_key, cursor_at,
        created_at, updated_at, owner_account_id, delivery_kind, delivery_target)
      VALUES ('rule-cap', $1, 'owner/agent', 'Agent', 'room.message', '{}', 'cap', now(), now(), now(), $2,
        'webhook', '{"sealed": "never opened: access is denied first"}')
    `, [room.id, account.id]);
    const insert = (id: string, kind: string, purpose: string) => client!.pool.query(`
      INSERT INTO wake_webhook_deliveries (id, rule_id, room_id, kind, purpose, message_number, sender, text_preview, state,
        scheduled_at, next_attempt_at, created_at, updated_at, owner_account_id)
      VALUES ($1, 'rule-cap', $2, $3, $4, 1, 'Agent', 'hi', 'retry', now(), now(), now(), now(), $5)
    `, [id, room.id, kind, purpose, account.id]);
    const state = async (id: string) => (await client!.pool.query<{ state: string }>(
      "SELECT state FROM wake_webhook_deliveries WHERE id = $1", [id])).rows[0]?.state;
    for (const id of ["cap-1", "cap-2", "cap-3"]) await insert(id, "webhook", "message");
    wakes!.wakeJobQueue("wake_delivery");
    await until("three webhook deliveries in flight", async () =>
      (await Promise.all(["cap-1", "cap-2", "cap-3"].map(state))).every((value) => value === "processing"));
    await insert("cap-email", "email", "message");
    wakes!.wakeJobQueue("wake_delivery");
    await delay(500);
    assert.equal(await state("cap-email"), "retry", "the account cap holds the email back");
    release();
    // The fallback is ten minutes away: only the finished webhooks' wake explains the claim.
    await until("the email claim", async () => await state("cap-email") === "dead");
  } finally {
    release();
    await stop();
  }
});

test("a row that falls due between a claim and the next-due read is still found, not left for the fallback", { skip }, async () => {
  // The race behind CI run 42751540606: the timer fires a moment before the row
  // is claimable (timers may fire early, and now() is the start of each
  // statement), the claim finds nothing, and by the next-due read the row is
  // due. A read that only looks at rows due later then sees nothing and the
  // loop sleeps for the whole fallback.
  const { room, messageNumber } = await seedRoom();
  await insertJevJob(room.id, messageNumber, 300);
  assert.equal((await jev!.claimJevRoutingJobs()).length, 0, "not due yet");
  await delay(400);
  const jevDue = await jev!.nextJevRoutingJobDueInMs();
  assert.ok(jevDue !== null && jevDue <= 0, `the overdue job is reported as due now (got ${jevDue})`);

  const { account } = await seedRoom();
  await client!.pool.query(`
    INSERT INTO desktop_push_devices (id, account_id, installation_id, device_token, token_hash, bundle_id,
      environment, enabled, failure_count, last_registered_at, created_at, updated_at)
    VALUES ('device-overdue', $1, 'installation-overdue', $2, 'hash-overdue', 'chat.letagents.desktop', 'production', TRUE, 0, now(), now(), now())
  `, [account.id, "c".repeat(64)]);
  await client!.pool.query(`
    INSERT INTO desktop_push_notifications (id, device_id, room_id, message_number, room_display_name, sender, body,
      state, attempt_count, next_attempt_at, created_at, updated_at)
    VALUES ('overdue-1', 'device-overdue', $1, $2, 'Room', 'Agent', 'hello', 'retry', 1, now() - interval '1 second', now(), now())
  `, [room.id, messageNumber]);
  const pushDue = await push!.nextDesktopPushDueInMs(true);
  assert.ok(pushDue !== null && pushDue <= 0, `an overdue push retry is due now (got ${pushDue})`);
});
