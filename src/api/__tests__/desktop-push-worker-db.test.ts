import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { ClaimedNotification } from "../notifications/worker.js";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const dbModule = testDatabaseUrl ? await import("../db.js") : null;
const workerModule = testDatabaseUrl ? await import("../notifications/worker.js") : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const addMessage = dbModule?.addMessage;
const createProjectWithName = dbModule?.createProjectWithName;
const upsertAccount = dbModule?.upsertAccount;
const claimNotifications = workerModule?.claimNotifications;
const recordAuthorizationDenied = workerModule?.recordAuthorizationDenied;
const recordResult = workerModule?.recordResult;
const failureThreshold = workerModule?.MAX_CONSECUTIVE_DEVICE_FAILURES;

function requireTestDeps(): void {
  assert.ok(db);
  assert.ok(pool);
  assert.ok(addMessage);
  assert.ok(createProjectWithName);
  assert.ok(upsertAccount);
  assert.ok(claimNotifications);
  assert.ok(recordAuthorizationDenied);
  assert.ok(recordResult);
  assert.ok(failureThreshold);
}

async function resetDatabase(): Promise<void> {
  requireTestDeps();
  await pool!.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool!.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool!.query("CREATE SCHEMA public");
  await migrate(db!, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(resetDatabase);
  test.after(async () => pool?.end());
}

const runOptions = {
  concurrency: false,
  skip: requiresDatabase ? "set TEST_DB_URL to run desktop push worker DB tests" : false,
};

interface SeededScenario {
  accountId: string;
  roomId: string;
  deviceId: string;
  notificationIds: string[];
  claimed(index: number, workerId: string): ClaimedNotification;
}

let scenarioSequence = 0;
async function seedScenario(input: {
  states: Array<"queued" | "retry" | "processing">;
  claimedBy?: string;
  staleProcessing?: boolean;
  failureCount?: number;
  enabled?: boolean;
  accountId?: string;
  roomId?: string;
}): Promise<SeededScenario> {
  requireTestDeps();
  scenarioSequence += 1;
  const key = `push-worker-${scenarioSequence}`;
  const account = input.accountId
    ? { id: input.accountId }
    : await upsertAccount!({
      provider: "github",
      provider_user_id: key,
      login: key,
    });
  const room = input.roomId
    ? { id: input.roomId }
    : await createProjectWithName!(`github.com/acme/${key}`);
  const deviceId = `device-${key}`;
  const now = new Date().toISOString();
  await pool!.query(`
    INSERT INTO desktop_push_devices (
      id, account_id, installation_id, device_token, token_hash, bundle_id,
      environment, enabled, failure_count, last_registered_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, 'chat.letagents.desktop', 'production', $6, $7, $8, $8, $8)
  `, [
    deviceId,
    account.id,
    `installation-${key}`,
    scenarioSequence.toString(16).padStart(64, "0"),
    `hash-${key}`,
    input.enabled ?? true,
    input.failureCount ?? 0,
    now,
  ]);

  const messages: Array<{ id: string; number: number; text: string }> = [];
  const notificationIds: string[] = [];
  for (let index = 0; index < input.states.length; index += 1) {
    const message = await addMessage!(room.id, "Agent", `private body ${index + 1}`, { source: "agent" });
    const messageNumber = Number.parseInt(message.id.replace(/^msg_/, ""), 10);
    assert.equal(Number.isSafeInteger(messageNumber), true, `expected a numeric message id, received ${message.id}`);
    messages.push({ id: message.id, number: messageNumber, text: message.text });
    const notificationId = `notification-${key}-${index + 1}`;
    notificationIds.push(notificationId);
    const processing = input.states[index] === "processing";
    const claimedAt = processing
      ? new Date(Date.now() - (input.staleProcessing ? 10 * 60_000 : 0)).toISOString()
      : null;
    await pool!.query(`
      INSERT INTO desktop_push_notifications (
        id, device_id, room_id, message_number, thread_root_number,
        room_display_name, sender, body, state, attempt_count,
        next_attempt_at, claimed_at, claimed_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, NULL, $5, 'Agent', $6, $7, 0,
                NOW() - INTERVAL '1 minute', $8, $9, NOW(), NOW())
    `, [
      notificationId,
      deviceId,
      room.id,
      messageNumber,
      `Room ${key}`,
      message.text,
      input.states[index],
      claimedAt,
      processing ? input.claimedBy ?? "worker-seed" : null,
    ]);
  }

  return {
    accountId: account.id,
    roomId: room.id,
    deviceId,
    notificationIds,
    claimed(index: number, workerId: string): ClaimedNotification {
      const message = messages[index]!;
      return {
        id: notificationIds[index]!,
        device_id: deviceId,
        account_id: account.id,
        device_token: scenarioSequence.toString(16).padStart(64, "0"),
        environment: "production",
        room_id: room.id,
        room_display_name: `Room ${key}`,
        message_number: message.number,
        thread_root_number: null,
        sender: "Agent",
        body: message.text,
        attempt_count: 1,
      };
    },
  };
}

test("worker claim CTE recovers stale work and skips disabled devices", runOptions, async () => {
  requireTestDeps();
  const ready = await seedScenario({ states: ["queued", "processing"], staleProcessing: true });
  const disabled = await seedScenario({ states: ["queued"], enabled: false });

  const claimed = await claimNotifications!("worker-claim");
  assert.deepEqual(new Set(claimed.map((entry) => entry.id)), new Set(ready.notificationIds));
  assert.equal(claimed.every((entry) => entry.attempt_count === 1), true);

  const rows = await pool!.query<{ id: string; state: string; claimed_by: string | null }>(`
    SELECT id, state, claimed_by
    FROM desktop_push_notifications
    ORDER BY id
  `);
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  assert.equal(byId.get(ready.notificationIds[0]!)?.state, "processing");
  assert.equal(byId.get(ready.notificationIds[1]!)?.claimed_by, "worker-claim");
  assert.equal(byId.get(disabled.notificationIds[0]!)?.state, "queued");
});

test("authorization denial redacts every queued row for the account and room only", runOptions, async () => {
  requireTestDeps();
  const workerId = "worker-auth-denial";
  const denied = await seedScenario({ states: ["processing", "queued", "retry"], claimedBy: workerId });
  const otherRoom = await seedScenario({ states: ["queued"], accountId: denied.accountId });

  await recordAuthorizationDenied!(denied.claimed(0, workerId), workerId);

  const rows = await pool!.query<{
    id: string;
    state: string;
    room_display_name: string;
    sender: string;
    body: string;
  }>(`
    SELECT id, state, room_display_name, sender, body
    FROM desktop_push_notifications
  `);
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  for (const id of denied.notificationIds) {
    assert.deepEqual(byId.get(id), {
      id,
      state: "dead",
      room_display_name: "",
      sender: "",
      body: "",
    });
  }
  assert.equal(byId.get(otherRoom.notificationIds[0]!)?.state, "queued");
  assert.notEqual(byId.get(otherRoom.notificationIds[0]!)?.body, "");
});

test("invalid device response disables the device and redacts its queued cascade", runOptions, async () => {
  requireTestDeps();
  const workerId = "worker-invalid-device";
  const scenario = await seedScenario({ states: ["processing", "queued", "retry"], claimedBy: workerId });

  await recordResult!(scenario.claimed(0, workerId), workerId, {
    status: 410,
    reason: "Unregistered",
    apnsId: null,
  });

  const device = await pool!.query<{ enabled: boolean; failure_count: number }>(`
    SELECT enabled, failure_count FROM desktop_push_devices WHERE id = $1
  `, [scenario.deviceId]);
  assert.equal(device.rows[0]?.enabled, false);
  assert.equal(device.rows[0]?.failure_count, 1);
  const notifications = await pool!.query<{ state: string; body: string }>(`
    SELECT state, body FROM desktop_push_notifications WHERE device_id = $1
  `, [scenario.deviceId]);
  assert.equal(notifications.rows.every((row) => row.state === "dead" && row.body === ""), true);
});

test("consecutive retryable failures hit a bounded threshold and disable the device", runOptions, async () => {
  requireTestDeps();
  const workerId = "worker-failure-threshold";
  const scenario = await seedScenario({
    states: ["processing", "queued"],
    claimedBy: workerId,
    failureCount: failureThreshold! - 1,
  });

  await recordResult!(scenario.claimed(0, workerId), workerId, {
    status: 503,
    reason: "ServiceUnavailable",
    apnsId: null,
  });

  const device = await pool!.query<{ enabled: boolean; failure_count: number }>(`
    SELECT enabled, failure_count FROM desktop_push_devices WHERE id = $1
  `, [scenario.deviceId]);
  assert.deepEqual(device.rows[0], { enabled: false, failure_count: failureThreshold! });
  const notifications = await pool!.query<{ state: string; body: string; last_error: string | null }>(`
    SELECT state, body, last_error FROM desktop_push_notifications WHERE device_id = $1
  `, [scenario.deviceId]);
  assert.equal(notifications.rows.every((row) => row.state === "dead" && row.body === ""), true);
  assert.equal(notifications.rows.some((row) => row.last_error?.includes("consecutive delivery failures")), true);
});
