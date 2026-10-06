import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { mentionsPerson } from '../../../shared/room-notification-preferences.mjs';

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
const preferenceStore = testDatabaseUrl ? await import('../db/room-notification-preferences.js') : null;
const enqueueModule = testDatabaseUrl ? await import('../notifications/enqueue.js') : null;

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

test("human login and display-name mentions reach push enqueue without addressing their owner's agents", runOptions, async () => {
  requireTestDeps();
  const person = await upsertAccount!({
    provider: "github", provider_user_id: "notification-person", login: "person-login", display_name: "PersonName",
  });
  const other = await upsertAccount!({ provider: "github", provider_user_id: "notification-other", login: "other-login" });
  const scenario = await seedScenario({ states: [], accountId: person.id });
  const otherScenario = await seedScenario({ states: [], accountId: other.id, roomId: scenario.roomId });
  for (const accountId of [person.id, other.id]) {
    await pool!.query(`INSERT INTO account_room_recents
      (account_id, room_id, first_opened_at, last_opened_at, updated_at)
      VALUES ($1, $2, NOW(), NOW(), NOW())`, [accountId, scenario.roomId]);
  }
  for (const [name, owner, login] of [["Oak", person.id, person.login], ["Pine", person.id, person.login], ["Ash", other.id, other.login]]) {
    const key = `${login}/${name!.toLowerCase()}`;
    await pool!.query(`INSERT INTO room_agent_sessions
      (session_id, room_id, token_hash, session_kind, runtime, actor_label, agent_key, display_name,
       owner_account_id, owner_label, ide_label, created_at, updated_at, last_seen_at)
      VALUES ($1, $2, $1, 'worker', 'test', $3, $4, $5, $6, $7, 'Codex', NOW(), NOW(), NOW())`,
    [`session-${name}`, scenario.roomId, `${name} | ${login}'s agent | Codex`, key, name, owner, login]);
  }
  for (const [token, expectedAgents] of [
    [person.login, []],
    [person.display_name!, []],
    ["Oak", ["person-login/oak"]],
  ] as const) {
    const message = await addMessage!(scenario.roomId, "A different person", `@${token} please inspect`, { source: "browser" });
    const number = Number(message.id.slice(4));
    const pushes = await pool!.query(`SELECT device_id FROM desktop_push_notifications
      WHERE room_id=$1 AND message_number=$2 ORDER BY device_id`, [scenario.roomId, number]);
    assert.deepEqual(pushes.rows.map((row) => row.device_id).sort(), [scenario.deviceId, otherScenario.deviceId].sort(),
      `@${token} is ordinary message text, not the addressed_to control lane`);
    const receipts = await pool!.query(`SELECT agent_key FROM message_agent_receipts
      WHERE message_room_id=$1 AND message_number=$2 ORDER BY agent_key`, [scenario.roomId, number]);
    assert.deepEqual(receipts.rows.map((row) => row.agent_key), expectedAgents, `@${token} activation recipients`);
  }
});

async function notificationFixture() {
  const person = await upsertAccount!({ provider: 'github', provider_user_id: 'notification-a', login: 'person-login' });
  const other = await upsertAccount!({ provider: 'github', provider_user_id: 'notification-b', login: 'other-login' });
  const a = await seedScenario({ states: [], accountId: person.id });
  const b = await seedScenario({ states: [], accountId: other.id, roomId: a.roomId });
  const otherRoom = await createProjectWithName!('notification-other-room');
  for (const accountId of [person.id, other.id]) for (const roomId of [a.roomId, otherRoom.id]) {
    await pool!.query(`INSERT INTO account_room_recents (account_id, room_id, first_opened_at, last_opened_at, updated_at)
      VALUES ($1,$2,NOW(),NOW(),NOW())`, [accountId, roomId]);
  }
  async function send(text: string, roomId = a.roomId, options: Parameters<NonNullable<typeof addMessage>>[3] = {}) {
    const message = await addMessage!(roomId, 'Sender', text, { source: 'browser', ...options });
    const rows = await pool!.query(`SELECT device_id FROM desktop_push_notifications WHERE room_id=$1 AND message_number=$2 ORDER BY device_id`, [roomId, Number(message.id.slice(4))]);
    return { message, devices: rows.rows.map((row) => row.device_id).sort() };
  }
  return { person, other, a, b, otherRoom, send, both: [a.deviceId, b.deviceId].sort() };
}

test('muting and snoozing suppress only that account and room; expiry restores the chosen level', runOptions, async () => {
  const f = await notificationFixture();
  assert.deepEqual((await f.send('default')).devices, f.both);
  for (const change of [
    { level: 'muted' as const },
    { level: 'all' as const, snoozed_until: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    await preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, change);
    assert.deepEqual((await f.send('quiet')).devices, [f.b.deviceId]);
    assert.deepEqual((await f.send('other room', f.otherRoom.id)).devices, f.both);
    assert.deepEqual(await preferenceStore!.getRoomNotificationPreference(f.other.id, f.a.roomId), { room_id: f.a.roomId, level: 'all', snoozed_until: null });
  }
  await pool!.query(`UPDATE account_room_notification_preferences SET snoozed_until=statement_timestamp()-INTERVAL '1 second'
    WHERE account_id=$1 AND room_id=$2`, [f.person.id, f.a.roomId]);
  assert.deepEqual((await f.send('expired')).devices, f.both);
  await preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, { level: 'mentions' });
  assert.deepEqual((await f.send('expired mentions without token')).devices, [f.b.deviceId]);
  assert.deepEqual((await f.send('@person-login expired mentions')).devices, f.both);
});

test('mentions-only uses the full text and literal whole login; SQL and client decisions agree', runOptions, async () => {
  const f = await notificationFixture();
  await preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, { level: 'mentions' });
  await preferenceStore!.setRoomNotificationPreference(f.other.id, f.a.roomId, { level: 'mentions' });
  for (const text of [
    '@PERSON-LOGIN hello', '(@person-login), hello', 'Hello @person-login.', 'x'.repeat(1100) + ' @person-login',
    '@other-login hello', '@person-login @other-login', 'no mention', '@person-login-extra', 'mail@person-login',
    '@person-login/agent', '@person-login.other', '@everyone hello', '@agent:person-login', '@person-login_suffix',
  ]) {
    const expected = [
      ...(mentionsPerson(text, f.person.login) ? [f.a.deviceId] : []),
      ...(mentionsPerson(text, f.other.login) ? [f.b.deviceId] : []),
    ].sort();
    assert.deepEqual((await f.send(text)).devices, expected, text);
    assert.deepEqual((await f.send(text, f.otherRoom.id)).devices, f.both, 'the other room is unchanged');
  }
  await pool!.query('UPDATE accounts SET login=$2 WHERE id=$1', [f.person.id, 'person.+(x)']);
  for (const text of ['@person.+(x) hello', '@person.zzx hello']) {
    assert.deepEqual((await f.send(text)).devices, mentionsPerson(text, 'person.+(x)') ? [f.a.deviceId] : [], 'regex metacharacters are literal');
  }
});

test('preferences reject invalid DB times and preserve independent updates without message or delivery effects', runOptions, async () => {
  const f = await notificationFixture();
  const initial = await f.send('unchanged message');
  const snapshot = async () => ({
    message: await dbModule!.getMessageById(f.a.roomId, initial.message.id),
    receipts: (await pool!.query('SELECT * FROM message_agent_receipts')).rows,
    delivery: (await pool!.query('SELECT * FROM room_agent_delivery_sessions')).rows,
    pushes: (await pool!.query('SELECT * FROM desktop_push_notifications ORDER BY id')).rows,
    recents: (await pool!.query('SELECT * FROM account_room_recents ORDER BY account_id, room_id')).rows,
  });
  const before = await snapshot();
  for (const timestamp of [new Date(Date.now() - 1000), new Date(Date.now() + 8 * 86400_000)]) {
    assert.equal(await preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, { snoozed_until: timestamp.toISOString() }), null);
  }
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await Promise.all([
    preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, { level: 'muted' }),
    preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, { snoozed_until: until }),
  ]);
  const current = await preferenceStore!.getRoomNotificationPreference(f.person.id, f.a.roomId);
  assert.equal(current.level, 'muted');
  assert.equal(Date.parse(current.snoozed_until!), Date.parse(until));
  await preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, { snoozed_until: null });
  assert.equal((await preferenceStore!.getRoomNotificationPreference(f.person.id, f.a.roomId)).level, 'muted');
  assert.equal((await preferenceStore!.listRoomNotificationPreferences(f.other.id)).preferences.length, 0);
  assert.deepEqual(await snapshot(), before);
});

test('preference writes, single reads and lists return UTC ISO timestamps across database time zones', runOptions, async () => {
  const f = await notificationFixture();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const originalZone = (await pool!.query('SHOW TIME ZONE')).rows[0].TimeZone;
  try {
    // These sequential store calls reuse the idle connection whose session zone
    // was set here; the raw text check proves PostgreSQL is not returning UTC.
    for (const zone of ['Pacific/Auckland', 'America/New_York']) {
      await pool!.query("SELECT set_config('TimeZone', $1, false)", [zone]);
      const written = await preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, { snoozed_until: until });
      assert.equal((await pool!.query('SHOW TIME ZONE')).rows[0].TimeZone, zone);
      const raw = (await pool!.query('SELECT snoozed_until::text FROM account_room_notification_preferences WHERE account_id=$1 AND room_id=$2', [f.person.id, f.a.roomId])).rows[0].snoozed_until;
      assert.notEqual(raw, until);
      assert.match(raw, zone === 'Pacific/Auckland' ? /\+\d{2}$/ : /-\d{2}$/);
      assert.ok(!raw.endsWith('+00'));
      assert.equal(written!.snoozed_until, until);
      assert.equal((await preferenceStore!.getRoomNotificationPreference(f.person.id, f.a.roomId)).snoozed_until, until);
      assert.equal((await preferenceStore!.listRoomNotificationPreferences(f.person.id)).preferences[0]!.snoozed_until, until);
    }
  } finally {
    await pool!.query("SELECT set_config('TimeZone', $1, false)", [originalZone]);
  }
});

test('enqueue retains publisher, archive, prompt-only and idempotency rules', runOptions, async () => {
  const f = await notificationFixture();
  assert.deepEqual((await f.send('own publication', f.a.roomId, { account_id: f.person.id })).devices, [f.b.deviceId]);
  await pool!.query('UPDATE account_room_recents SET archived=TRUE WHERE account_id=$1 AND room_id=$2', [f.other.id, f.a.roomId]);
  assert.deepEqual((await f.send('archived recipient')).devices, [f.a.deviceId]);
  assert.deepEqual((await f.send('', f.a.roomId, { source: 'agent', agent_prompt_kind: 'auto' })).devices, []);
  const sent = await f.send('idempotent');
  const { rows: [row] } = await pool!.query('SELECT * FROM messages WHERE room_id=$1 AND number=$2', [f.a.roomId, Number(sent.message.id.slice(4))]);
  await db!.transaction((tx) => enqueueModule!.enqueueDesktopPushNotifications(tx, row));
  const count = await pool!.query('SELECT count(*)::int AS n FROM desktop_push_notifications WHERE room_id=$1 AND message_number=$2', [f.a.roomId, row.number]);
  assert.equal(count.rows[0].n, 1);
});

test('enqueue preference join is unique on the complete primary key and uses its index', runOptions, async () => {
  const f = await notificationFixture();
  await preferenceStore!.setRoomNotificationPreference(f.person.id, f.a.roomId, { level: 'mentions' });
  await pool!.query(`INSERT INTO accounts (id,provider,provider_user_id,login,created_at,updated_at)
    SELECT 'explain-'||n, 'github', 'explain-'||n, 'explain-'||n, NOW(), NOW() FROM generate_series(1,10000) n`);
  await pool!.query(`INSERT INTO account_room_notification_preferences (account_id,room_id,level)
    SELECT 'explain-'||n, $1, 'muted' FROM generate_series(1,10000) n`, [f.a.roomId]);
  await pool!.query('ANALYZE account_room_notification_preferences; ANALYZE desktop_push_devices; ANALYZE account_room_recents; ANALYZE accounts');
  const sent = await f.send('@person-login plan');
  const { rows: [row] } = await pool!.query('SELECT * FROM messages WHERE room_id=$1 AND number=$2', [f.a.roomId, Number(sent.message.id.slice(4))]);
  let plan: any;
  await db!.transaction(async (tx) => {
    await enqueueModule!.enqueueDesktopPushNotifications({ execute: async (statement: any) => {
      const result = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`);
      plan = result.rows[0]!['QUERY PLAN'];
      return result;
    } } as any, row);
  });
  const nodes = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
  const lookup = nodes(plan[0].Plan).find((node) => node['Index Name'] === 'account_room_notification_preferences_pk');
  assert.ok(lookup, JSON.stringify(plan));
  const join = nodes(plan[0].Plan).find((node) => node['Merge Cond']?.includes('preference.account_id') || node['Hash Cond']?.includes('preference.account_id'));
  assert.ok(lookup['Index Cond'].includes('account_id') || (join?.['Inner Unique'] && join['Merge Cond']?.includes('device.account_id')));
  const key = await pool!.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='account_room_notification_preferences_pk'");
  assert.equal(key.rows[0].definition, 'PRIMARY KEY (account_id, room_id)');
  assert.match(lookup['Index Cond'], /room_id/);
  console.log('notification preference EXPLAIN:', JSON.stringify({ lookup, accountJoin: join?.['Merge Cond'], innerUnique: join?.['Inner Unique'], executionMs: plan[0]['Execution Time'] }));
});


test('bulk preferences are personal, non-default and capped at 500', runOptions, async () => {
  const f = await notificationFixture();
  await pool!.query(`INSERT INTO rooms (id,display_name,created_at)
    SELECT 'bulk-room-'||n, 'Bulk room', NOW() FROM generate_series(1,503) n`);
  await pool!.query(`INSERT INTO account_room_notification_preferences (account_id,room_id,level)
    SELECT $1, 'bulk-room-'||n, 'muted' FROM generate_series(1,501) n`, [f.person.id]);
  await preferenceStore!.setRoomNotificationPreference(f.person.id, 'bulk-room-502', { level: 'all' });
  await pool!.query(`INSERT INTO account_room_notification_preferences (account_id,room_id,level,snoozed_until)
    VALUES ($1,'bulk-room-503','all',NOW()-INTERVAL '1 second')`, [f.person.id]);
  const list = await preferenceStore!.listRoomNotificationPreferences(f.person.id);
  assert.equal(list.preferences.length, 500);
  assert.equal(list.truncated, true);
  assert.ok(list.preferences.every((row) => row.level === 'muted'));
  assert.deepEqual(await preferenceStore!.listRoomNotificationPreferences(f.other.id), { preferences: [], truncated: false });
});
