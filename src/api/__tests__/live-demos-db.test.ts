import assert from 'node:assert/strict';
import test from 'node:test';

import { LIVE_DEMO, liveDemoColor, parseDemoMark } from '../../../shared/live-demo.mjs';
import {
  databaseTestOptions,
  dbApi,
  pool,
  startApiServer,
  stopChildProcess,
} from './coordination-db/harness.js';
import { joinLive, openLive, pause } from './live-demo-client.js';

// Live demos end to end on the real API server (`tsx src/api/server.ts`) and
// Postgres: the upgrade checks, cursors between members, and the saved marks.

const ONE_HOUR = 60 * 60 * 1000;
const DEMO = 'msg_1/att_1';

async function person(login: string, displayName: string | null = login) {
  const account = await dbApi.upsertAccount!({
    provider: 'github',
    provider_user_id: `live-${login}`,
    login,
    display_name: displayName,
  });
  const token = `live_session_${login}`;
  await dbApi.createSession!(account.id, token, new Date(Date.now() + ONE_HOUR).toISOString(), null);
  return { id: account.id, login, token };
}

function client(port: number) {
  return async (method: string, route: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
}

/** A message with an HTML attachment: demo `msg_<n>/att_1` of the room. */
async function addDemo(roomId: string, messageNumber: number, accountId: string) {
  await pool!.query(`INSERT INTO messages (room_id, number, sender, text, timestamp, publisher_account_id)
    VALUES ($1, $2, 'owner', 'Here is the demo', now(), $3)`, [roomId, messageNumber, accountId]);
  const upload = `upl_${roomId}_${messageNumber}`;
  const objectKey = `rooms/${roomId}/demo-${messageNumber}.html`;
  await pool!.query(`INSERT INTO message_attachment_uploads (upload_id, room_id, filename, content_type, byte_size,
      storage_provider, bucket, object_key, status, expires_at, attached_message_number, created_at, attached_at)
    VALUES ($1, $2, 'demo.html', 'text/html', 120, 's3', 'letagents-test', $3, 'attached', now() + interval '1 hour', $4, now(), now())`,
  [upload, roomId, objectKey, messageNumber]);
  await pool!.query(`INSERT INTO message_attachments (room_id, message_number, attachment_number, upload_id, filename,
      content_type, byte_size, storage_provider, bucket, object_key, created_at)
    VALUES ($1, $2, 1, $3, 'demo.html', 'text/html', 120, 's3', 'letagents-test', $4, now())`,
  [roomId, messageNumber, upload, objectKey]);
}

async function setup(t: test.TestContext) {
  const owner = await person('owner', 'Room Owner');
  const member = await person('member', null);
  const stranger = await person('stranger');
  const outsider = await person('outsider');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);
  const created = await call('POST', '/projects/room/live-lounge', owner.token);
  assert.equal(created.status, 201);
  const roomId = created.body.id as string;
  const other = await call('POST', '/projects/room/other-lounge', outsider.token);
  assert.equal(other.status, 201);
  const otherRoomId = other.body.id as string;
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed')`, [roomId, member.id]);
  await addDemo(roomId, 1, owner.id);
  // The same demo key in another room.
  await addDemo(otherRoomId, 1, outsider.id);
  return { owner, member, stranger, outsider, port, call, roomId, otherRoomId };
}

test('the live socket opens for members only and relays cursors within one room', databaseTestOptions, async (t) => {
  const { owner, member, stranger, outsider, port, roomId, otherRoomId } = await setup(t);
  const path = `/rooms/${encodeURIComponent(roomId)}/live`;

  assert.equal((await openLive(port, path)).status, 401, 'no sign-in');
  assert.equal((await openLive(port, path, { headers: { cookie: `letagents_session=${owner.token}` } })).status, 401, 'a cookie is not enough');
  assert.equal((await openLive(port, path, { token: owner.token, headers: { origin: 'https://letagents.chat' } })).status, 403, 'a web page');
  assert.equal((await openLive(port, path, { token: stranger.token })).status, 403, 'signed in, not a member');
  assert.equal((await openLive(port, path, { token: outsider.token })).status, 403, 'a member of another room');
  assert.equal((await openLive(port, '/rooms/no-such-room/live', { token: owner.token })).status, 404);
  await dbApi.createOwnerToken!({ accountId: owner.id, githubUserId: 'live-owner', token: 'live_owner_token' });
  assert.equal((await openLive(port, path, { token: 'live_owner_token' })).status, 401, 'an owner token is not an app session');
  // The API still answers ordinary requests after refusing upgrades.
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);

  const ada = await joinLive(port, roomId, owner.token);
  const bea = await joinLive(port, roomId, member.token);
  const cy = await joinLive(port, otherRoomId, outsider.token);
  assert.deepEqual([ada.hello.name, ada.hello.color], ['Room Owner', liveDemoColor(owner.id)]);
  assert.equal(bea.hello.name, 'member');

  for (const person of [ada, bea, cy]) person.send({ t: 'join', demo: DEMO });
  const presence = await ada.frames.next((frame) => frame.t === 'presence' && frame.people.length === 2);
  assert.deepEqual(presence.people.map((p: any) => p.name).sort(), ['Room Owner', 'member']);
  await cy.frames.next((frame) => frame.t === 'presence');

  ada.send({ t: 'cur', demo: DEMO, x: 100, y: 50 });
  assert.deepEqual(await bea.frames.next((frame) => frame.t === 'cur'), { t: 'cur', demo: DEMO, cid: ada.hello.cid, x: 100, y: 50 });
  bea.send({ t: 'ink', demo: DEMO, id: 'stroke_bea_1', pts: [[1, 1], [2, 2]], end: true });
  assert.equal((await ada.frames.next((frame) => frame.t === 'ink')).cid, bea.hello.cid);
  await pause(150);
  assert.equal(cy.frames.frames.filter((frame) => frame.t === 'cur' || frame.t === 'ink').length, 0, 'the other room hears nothing');

  bea.send({ t: 'join', demo: 'msg_99/att_1' });
  const refused = await bea.frames.next((frame) => frame.t === 'error');
  assert.deepEqual([refused.code, refused.demo], ['demo_not_found', 'msg_99/att_1']);

  for (const person of [ada, bea, cy]) person.ws.close();
});

test('marks: members read and save them, the author or an admin removes one, viewers hear at once', databaseTestOptions, async (t) => {
  const { owner, member, stranger, port, call, roomId } = await setup(t);
  const route = `/rooms/${encodeURIComponent(roomId)}/demo-marks`;
  const viewer = await joinLive(port, roomId, owner.token);
  viewer.send({ t: 'join', demo: DEMO });
  await viewer.frames.next((frame) => frame.t === 'presence');

  const stroke = { demo: DEMO, kind: 'stroke', points: [[10.04, 20.06], [30, 40.55], [50, 60]], anchor: null };
  assert.equal((await call('POST', route, null, stroke)).status, 401);
  assert.equal((await call('POST', route, stranger.token, stroke)).status, 403);
  assert.equal((await call('POST', route, member.token, { ...stroke, points: [[1, 1]] })).status, 400, 'a stroke needs two points');
  assert.equal((await call('POST', route, member.token, { ...stroke, demo: 'msg_99/att_1' })).status, 404, 'not a demo of this room');

  const saved = await call('POST', route, member.token, stroke);
  assert.equal(saved.status, 201);
  const mark = saved.body.mark;
  assert.ok(parseDemoMark(mark), 'the app can read the saved mark');
  assert.equal(mark.kind, 'stroke');
  assert.deepEqual(mark.points, [[10, 20.1], [30, 40.6], [50, 60]], 'points kept to a tenth of a pixel');
  assert.deepEqual(mark.author, { accountId: member.id, name: 'member', color: liveDemoColor(member.id) });
  assert.deepEqual(await viewer.frames.next((frame) => frame.t === 'mark'), { t: 'mark', demo: DEMO, mark });

  const pin = await call('POST', route, owner.token, {
    demo: DEMO, kind: 'pin', at: [700, 1500], text: 'The total is wrong here', anchor: { path: 'main > table', dx: 4, dy: 8 },
  });
  assert.equal(pin.status, 201);
  assert.ok(parseDemoMark(pin.body.mark));
  assert.deepEqual(pin.body.mark.anchor, { path: 'main > table', dx: 4, dy: 8 });
  await viewer.frames.next((frame) => frame.t === 'mark' && frame.mark.id === pin.body.mark.id);

  assert.equal((await call('GET', `${route}?demo=${encodeURIComponent(DEMO)}`, stranger.token)).status, 403);
  assert.equal((await call('GET', `${route}?demo=nope`, member.token)).status, 400);
  const listed = await call('GET', `${route}?demo=${encodeURIComponent(DEMO)}`, member.token);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.marks.map((m: any) => m.id), [mark.id, pin.body.mark.id], 'oldest first');
  assert.ok(listed.body.marks.every((m: unknown) => parseDemoMark(m)));
  assert.deepEqual((await call('GET', `${route}?demo=msg_99%2Fatt_1`, member.token)).body, { marks: [] });

  // The member cannot remove the admin's pin; the admin can remove the member's stroke.
  assert.equal((await call('DELETE', `${route}/${pin.body.mark.id}`, member.token)).status, 403);
  assert.equal((await call('DELETE', `${route}/${mark.id}`, stranger.token)).status, 403);
  assert.equal((await call('DELETE', `${route}/${mark.id}`, owner.token)).status, 204);
  assert.deepEqual(await viewer.frames.next((frame) => frame.t === 'unmark'), { t: 'unmark', demo: DEMO, id: mark.id });
  assert.equal((await call('DELETE', `${route}/${mark.id}`, owner.token)).status, 404, 'already gone');
  assert.equal((await call('DELETE', `${route}/${pin.body.mark.id}`, owner.token)).status, 204, 'the author removes their own');

  // A cookie write from another site is refused even for a member.
  const crossSite = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `letagents_session=${member.token}`, origin: 'https://evil.example' },
    body: JSON.stringify(stroke),
  });
  assert.equal(crossSite.status, 403);

  viewer.ws.close();
});

test('a demo keeps at most 500 marks, and its marks go with its message', databaseTestOptions, async (t) => {
  const { owner, call, roomId } = await setup(t);
  const route = `/rooms/${encodeURIComponent(roomId)}/demo-marks`;
  await pool!.query(`INSERT INTO demo_marks (id, room_id, message_number, attachment_number, account_id, kind, pin_at, pin_text)
    SELECT 'dmk_seed_' || n, $1, 1, 1, $2, 'pin', '[1, 1]'::jsonb, 'seed' FROM generate_series(1, $3::int - 1) AS n`,
  [roomId, owner.id, LIVE_DEMO.marksPerDemo]);
  const pin = { demo: DEMO, kind: 'pin', at: [1, 2], text: 'Last one' };
  const results = await Promise.all([call('POST', route, owner.token, pin), call('POST', route, owner.token, pin)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409], 'two saves at once still keep the limit');
  const count = await pool!.query(`SELECT COUNT(*)::int AS count FROM demo_marks WHERE room_id = $1`, [roomId]);
  assert.equal(count.rows[0].count, LIVE_DEMO.marksPerDemo);
  assert.equal((await call('GET', `${route}?demo=${encodeURIComponent(DEMO)}`, owner.token)).body.marks.length, LIVE_DEMO.marksPerDemo);

  await pool!.query('DELETE FROM message_attachments WHERE room_id = $1', [roomId]);
  const left = await pool!.query(`SELECT COUNT(*)::int AS count FROM demo_marks WHERE room_id = $1`, [roomId]);
  assert.equal(left.rows[0].count, 0);
});
