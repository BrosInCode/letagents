import assert from 'node:assert/strict';
import test from 'node:test';

import {
  databaseTestOptions,
  dbApi,
  pool,
  startApiServer,
  stopChildProcess,
} from './coordination-db/harness.js';

const ONE_HOUR = 60 * 60 * 1000;
const workerModule = pool ? await import('../notifications/worker.js') : null;
const pushModule = pool ? await import('../notifications/join-request-pushes.js') : null;

async function person(login: string, displayName = login) {
  const account = await dbApi.upsertAccount!({
    provider: 'github',
    provider_user_id: `alerts-${login}`,
    login,
    display_name: displayName,
  });
  const token = `alerts_session_${login}`;
  await dbApi.createSession!(account.id, token, new Date(Date.now() + ONE_HOUR).toISOString());
  return { id: account.id, login, token };
}

function client(port: number) {
  return async (method: string, route: string, token: string | null, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
}

async function device(accountId: string, key: string): Promise<string> {
  const id = `device-${key}`;
  await pool!.query(`INSERT INTO desktop_push_devices (
      id, account_id, installation_id, device_token, token_hash, bundle_id, environment, enabled, failure_count,
      last_registered_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, 'chat.letagents.desktop', 'production', TRUE, 0, now(), now(), now())`,
  [id, accountId, `installation-${key}`, key.padStart(64, '0'), `hash-${key}`]);
  return id;
}

/** Opens one server-sent event stream and collects its typed frames until closed. */
function openStream(url: string, token: string) {
  const frames: Array<{ event: string; data: any }> = [];
  const abort = new AbortController();
  let opened = false;
  const done = (async () => {
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    assert.equal(response.status, 200, `${url} opens`);
    opened = true;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1] ?? 'message';
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (data) frames.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* closed */ }
  })();
  return {
    frames,
    async waitFor(predicate: (frame: { event: string; data: any }) => boolean, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = frames.find(predicate);
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    },
    async ready(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (!opened && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(opened, `${url} opened`);
    },
    close() { abort.abort(); return done.catch(() => undefined); },
  };
}

test('a join request is streamed to the admins only, queues one push per admin device, and dies when answered', databaseTestOptions, async (t) => {
  const owner = await person('owner', 'Olive Owner');
  const bob = await person('bob');
  const stranger = await person('stranger', 'Sam Stranger');
  const ownerDevice = await device(owner.id, 'owner1');
  await device(bob.id, 'bob1');
  await device(stranger.id, 'stranger1');

  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);
  const base = `http://127.0.0.1:${port}`;

  const created = await call('POST', '/projects/room/alert-lounge', owner.token);
  const roomId = created.body.id as string;
  const roomName = created.body.display_name as string;
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed')`, [roomId, bob.id]);

  const ownerRoom = openStream(`${base}/rooms/${roomId}/messages/stream`, owner.token);
  const bobRoom = openStream(`${base}/rooms/${roomId}/messages/stream`, bob.token);
  const ownerAccount = openStream(`${base}/account/activity/stream`, owner.token);
  const bobAccount = openStream(`${base}/account/activity/stream`, bob.token);
  t.after(async () => { await Promise.all([ownerRoom, bobRoom, ownerAccount, bobAccount].map((stream) => stream.close())); });
  await Promise.all([ownerRoom.ready(), bobRoom.ready(), ownerAccount.ready(), bobAccount.ready()]);
  assert.ok(await ownerRoom.waitFor((frame) => frame.event === 'room_sync'), 'the room stream handshake landed');
  assert.ok(await ownerAccount.waitFor((frame) => frame.event === 'snapshot'), 'the account stream snapshot landed');

  const asked = await call('POST', `/rooms/${roomId}/join-requests`, stranger.token);
  assert.equal(asked.status, 201);
  const requestId = asked.body.join_request.id as string;

  const roomFrame = await ownerRoom.waitFor((frame) => frame.event === 'join_request');
  assert.ok(roomFrame, 'the admin hears it in the room');
  assert.equal(roomFrame!.data.room_id, roomId);
  assert.equal(roomFrame!.data.request.id, requestId);
  assert.equal(roomFrame!.data.request.login, 'stranger');
  assert.equal(roomFrame!.data.request.display_name, 'Sam Stranger');
  assert.equal(roomFrame!.data.request.state, 'pending');
  const accountFrame = await ownerAccount.waitFor((frame) => frame.event === 'join_request');
  assert.ok(accountFrame, 'the admin hears it on the account stream too');
  assert.equal(accountFrame!.data.request.room_display_name, roomName);

  // Pushes: the admin's device, not the member's, not the requester's.
  const queued = await pool!.query<{ device_id: string; sender: string; room_display_name: string; state: string }>(
    `SELECT device_id, sender, room_display_name, state FROM desktop_join_request_pushes WHERE join_request_id = $1 ORDER BY device_id`, [requestId]);
  assert.deepEqual(queued.rows, [{ device_id: ownerDevice, sender: 'Sam Stranger', room_display_name: roomName, state: 'queued' }]);

  // The worker claims it and would send a join-request alert.
  const claimed = await workerModule!.claimJoinRequestPushes('worker-alerts');
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.join_request_id, requestId);
  assert.equal(claimed[0]!.account_id, owner.id);
  const sent: any[] = [];
  await workerModule!.deliverNotification(
    { send: async (input) => { sent.push(input); return { status: 200, reason: null, apnsId: 'apns-1' }; } },
    'worker-alerts',
    claimed[0]!,
    async () => 'allow',
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].joinRequestId, requestId);
  assert.equal(sent[0].roomDisplayName, roomName);
  assert.equal(sent[0].sender, 'Sam Stranger');
  const delivered = await pool!.query<{ state: string; sender: string; room_display_name: string }>(
    `SELECT state, sender, room_display_name FROM desktop_join_request_pushes WHERE join_request_id = $1`, [requestId]);
  assert.deepEqual(delivered.rows, [{ state: 'delivered', sender: '', room_display_name: '' }], 'the preview is blanked once delivered');

  // The member never hears of it, in the room or on the account stream.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(bobRoom.frames.filter((frame) => frame.event === 'join_request').length, 0);
  assert.equal(bobAccount.frames.filter((frame) => frame.event === 'join_request').length, 0);
  assert.equal(JSON.stringify([...bobRoom.frames, ...bobAccount.frames]).includes('Sam Stranger'), false, 'the requester never leaks');

  // The decision is announced too, and the request leaves every admin's banner.
  const approved = await call('POST', `/rooms/${roomId}/join-requests/${requestId}/approve`, owner.token);
  assert.equal(approved.status, 200);
  const decided = await ownerRoom.waitFor((frame) => frame.event === 'join_request' && frame.data.request.state === 'approved');
  assert.ok(decided, 'the approval reaches the room stream');
  assert.equal(decided!.data.request.decided_by_login, 'owner');

  // A second request whose push is still queued dies with the decision, and a claimed one is not sent.
  const carol = await person('carol', 'Carol');
  const askedAgain = await call('POST', `/rooms/${roomId}/join-requests`, carol.token);
  const secondId = askedAgain.body.join_request.id as string;
  assert.equal((await pool!.query(`SELECT state FROM desktop_join_request_pushes WHERE join_request_id = $1`, [secondId])).rows[0]?.state, 'queued');
  const claimedSecond = await workerModule!.claimJoinRequestPushes('worker-late');
  assert.equal(claimedSecond.length, 1);
  assert.equal((await call('POST', `/rooms/${roomId}/join-requests/${secondId}/decline`, owner.token)).status, 200);
  await workerModule!.deliverNotification(
    { send: async () => { throw new Error('a decided request must not be sent'); } },
    'worker-late',
    claimedSecond[0]!,
    async () => 'allow',
  );
  const late = await pool!.query<{ state: string; last_error: string; sender: string }>(
    `SELECT state, last_error, sender FROM desktop_join_request_pushes WHERE join_request_id = $1`, [secondId]);
  assert.deepEqual(late.rows, [{ state: 'dead', last_error: 'Join request already decided', sender: '' }]);

  // A muted admin gets no push; a member promoted to admin starts hearing requests on their open stream.
  await pool!.query(`INSERT INTO account_room_notification_preferences (account_id, room_id, level) VALUES ($1, $2, 'muted')`, [owner.id, roomId]);
  assert.equal((await call('PUT', `/rooms/${roomId}/members/${bob.id}/role`, owner.token, { role: 'admin' })).status, 200);
  const dave = await person('dave', 'Dave');
  const thirdId = (await call('POST', `/rooms/${roomId}/join-requests`, dave.token)).body.join_request.id as string;
  const bobHears = await bobRoom.waitFor((frame) => frame.event === 'join_request' && frame.data.request.id === thirdId);
  assert.ok(bobHears, 'the promoted admin hears the next request without reconnecting');
  const thirdPushes = await pool!.query<{ device_id: string }>(`SELECT device_id FROM desktop_join_request_pushes WHERE join_request_id = $1`, [thirdId]);
  assert.deepEqual(thirdPushes.rows.map((row) => row.device_id), ['device-bob1'], 'the muted admin gets no push; the new admin does');

  // The store helpers: a retired request, and a preview for a person who is no longer an admin.
  assert.equal(await pushModule!.retireJoinRequestPushes(pool!, thirdId, 'test'), 1);
  const preview = await pushModule!.loadJoinRequestPushPreview(thirdId, stranger.id);
  assert.deepEqual(preview, { pending: true, admin: false, roomDisplayName: roomName, requester: 'Dave' });
});
