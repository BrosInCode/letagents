import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PRESENCE_CHANGE_CHANNEL } from '../../shared/presence-change-channel.js';

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const client = url ? await import('../db/client.js') : null;
const rooms = url ? await import('../db.js') : null;
const loaders = url ? (await import('../account-activity/loaders.js')).databaseAccountActivityLoaders : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve('drizzle') }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? 'Set TEST_DB_URL to run PostgreSQL integration tests.' : false };
let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;

/** Every presence-change notification a statement caused, heard after it commits. */
async function notificationsFrom(work: () => Promise<void>): Promise<string[]> {
  const listener = await client!.pool.connect();
  const heard: string[] = [];
  const onNotification = (message: { channel: string; payload?: string }) => {
    if (message.channel === PRESENCE_CHANGE_CHANNEL) heard.push(message.payload ?? '');
  };
  listener.on('notification', onNotification);
  try {
    await listener.query(`LISTEN ${PRESENCE_CHANGE_CHANNEL}`);
    await work();
    // Notifications arrive asynchronously after commit.
    await new Promise(resolve => setTimeout(resolve, 150));
    return heard;
  } finally {
    listener.off('notification', onNotification);
    await listener.query(`UNLISTEN ${PRESENCE_CHANGE_CHANNEL}`);
    listener.release();
  }
}

async function setPresence(roomId: string, actor: string, status: string, heartbeat = new Date().toISOString(), displayName = actor) {
  await client!.pool.query(`
    INSERT INTO room_agent_presence (room_id, actor_label, agent_key, display_name, status, last_heartbeat_at, created_at, updated_at)
    VALUES ($1, $2, $2, $4, $3, $5, now(), now())
    ON CONFLICT (room_id, actor_label) DO UPDATE SET status = EXCLUDED.status, display_name = EXCLUDED.display_name,
      last_heartbeat_at = EXCLUDED.last_heartbeat_at, updated_at = now()`, [roomId, actor, status, displayName, heartbeat]);
}

test('the trigger announces starting and stopping work, and nothing else', options, async () => {
  const room = await rooms!.createProjectWithName(unique('activity-trigger'));
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'maple', 'idle')), [], 'an idle agent joining is not work');
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'maple', 'working')), [room.id]);
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'maple', 'working')), [], 'a heartbeat while working is silent');
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'maple', 'reviewing')), [], 'working to reviewing is still work');
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'maple', 'working', undefined, 'Maple')), [room.id], 'a renamed worker is shown under its new name');
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'maple', 'idle')), [room.id]);
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'maple', 'blocked')), [], 'blocked is not work');
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'cedar', 'working')), [room.id], 'a new worker announces itself');
  assert.deepEqual(
    await notificationsFrom(async () => { await client!.pool.query('DELETE FROM room_agent_presence WHERE room_id = $1', [room.id]); }),
    [room.id],
    'a working agent whose session ends announces it; the idle one does not add a second notice',
  );
});

test('a working agent that went quiet and comes back is announced again', options, async () => {
  const room = await rooms!.createProjectWithName(unique('activity-revival'));
  const longAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  await setPresence(room.id, 'maple', 'working', longAgo);
  assert.deepEqual(await notificationsFrom(() => setPresence(room.id, 'maple', 'working')), [room.id]);
});

test('nothing is announced for work that rolls back', options, async () => {
  const room = await rooms!.createProjectWithName(unique('activity-rollback'));
  const heard = await notificationsFrom(async () => {
    const tx = await client!.pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(`INSERT INTO room_agent_presence (room_id, actor_label, display_name, status, last_heartbeat_at, created_at, updated_at)
        VALUES ($1, 'maple', 'maple', 'working', now(), now(), now())`, [room.id]);
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
  });
  assert.deepEqual(heard, []);
});

test('the loader lists who is working, and leaves out agents gone quiet', options, async () => {
  const busy = await rooms!.createProjectWithName(unique('activity-busy'));
  const quiet = await rooms!.createProjectWithName(unique('activity-quiet'));
  const now = Date.now();
  await setPresence(busy.id, 'b-cedar', 'working', new Date(now - 10_000).toISOString(), 'CedarRidge');
  await setPresence(busy.id, 'a-maple', 'reviewing', new Date(now - 20_000).toISOString(), 'MapleRidge');
  await setPresence(busy.id, 'c-oak', 'idle', new Date(now).toISOString(), 'OakRidge');
  await setPresence(quiet.id, 'd-pine', 'working', new Date(now - 5 * 60_000).toISOString(), 'PineRidge');
  const loaded = await loaders!.loadWorking([busy.id, quiet.id], now - 90_000);
  assert.deepEqual(loaded.get(busy.id)?.agents.map(a => a.display_name), ['CedarRidge', 'MapleRidge'], 'sorted by name; idle agents left out');
  assert.equal(loaded.get(busy.id)?.oldestHeartbeatMs, Date.parse(new Date(now - 20_000).toISOString()));
  assert.equal(loaded.has(quiet.id), false, 'an agent quiet for five minutes is not shown as working');
});

test('the loader reports the latest message the room list would', options, async () => {
  const room = await rooms!.createProjectWithName(unique('activity-latest'));
  assert.deepEqual([...(await loaders!.loadLatest([room.id])).keys()], []);
  const message = await rooms!.addMessage(room.id, 'Emmy', 'Ready for review');
  const latest = await loaders!.loadLatest([room.id]);
  assert.equal(latest.get(room.id)?.latest_message_id, message.id);
});
