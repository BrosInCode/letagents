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
let addressCounter = 0;

async function person(login: string) {
  const account = await dbApi.upsertAccount!({
    provider: 'github',
    provider_user_id: `invites-${login}`,
    login,
    display_name: `${login} display`,
  });
  const token = `invites_session_${login}`;
  await dbApi.createSession!(account.id, token, new Date(Date.now() + ONE_HOUR).toISOString());
  return { id: account.id, login, token };
}

/** Each call comes from its own address unless one is given, so only the account limit applies. */
function client(port: number) {
  return async (method: string, route: string, token: string | null, body?: unknown, address?: string) => {
    addressCounter += 1;
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': address ?? `10.0.${Math.floor(addressCounter / 250)}.${addressCounter % 250}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
}

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

async function memberRows(roomId: string): Promise<string[]> {
  const result = await pool!.query<{ login: string; added_via: string; added_by: string | null }>(`SELECT a.login, m.added_via, adder.login AS added_by
    FROM room_members m JOIN accounts a ON a.id = m.account_id LEFT JOIN accounts adder ON adder.id = m.added_by
    WHERE m.room_id = $1 ORDER BY a.login`, [roomId]);
  return result.rows.map((row) => `${row.login}:${row.added_via}:${row.added_by ?? '-'}`);
}

async function systemLines(roomId: string): Promise<string[]> {
  const result = await pool!.query<{ text: string }>(`SELECT text FROM messages
    WHERE room_id = $1 AND source = 'system' ORDER BY number`, [roomId]);
  return result.rows.map((row) => row.text);
}

test('an admin\'s invite lets a bot in once, tells the room who let it in, and updates the maker live', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const alice = await person('alice');
  const bob = await person('bob');
  await dbApi.createOwnerToken!({ accountId: alice.id, githubUserId: 'invites-alice', token: 'alice_owner_token', providerAccessToken: null } as any);
  await dbApi.createOwnerToken!({ accountId: owner.id, githubUserId: 'invites-owner', token: 'owner_owner_token', providerAccessToken: null } as any);

  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);
  const base = `http://127.0.0.1:${port}`;

  const roomId = (await call('POST', '/projects/room/bot-lounge', owner.token)).body.id as string;
  const ownerAccount = openStream(`${base}/account/activity/stream`, owner.token);
  const aliceAccount = openStream(`${base}/account/activity/stream`, alice.token);
  t.after(async () => { await Promise.all([ownerAccount.close(), aliceAccount.close()]); });
  await Promise.all([ownerAccount.ready(), aliceAccount.ready()]);
  assert.ok(await ownerAccount.waitFor((frame) => frame.event === 'snapshot'), 'the account stream snapshot landed');

  // Only a person in the app makes an invite; an MCP client only uses codes.
  assert.equal((await call('POST', `/rooms/${roomId}/invites`, 'owner_owner_token', { platform: 'grok' })).body.code, 'PERSON_REQUIRED');
  assert.equal((await call('POST', `/rooms/${roomId}/invites`, owner.token, { platform: 'robot' })).body.code, 'INVITE_PLATFORM_INVALID');
  assert.equal((await call('POST', `/rooms/${roomId}/invites`, bob.token, { platform: 'grok' })).status, 403, 'a stranger cannot invite');

  const made = await call('POST', `/rooms/${roomId}/invites`, owner.token, { platform: 'grok' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const code = made.body.code as string;
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(made.body.invite.kind, 'admit');
  assert.equal(made.body.invite.state, 'open');
  assert.equal(made.body.invite.platform, 'grok');
  assert.equal(made.body.invite.origin_room_id, roomId);
  assert.ok(Date.parse(made.body.invite.expires_at) - Date.now() > 6.9 * 24 * ONE_HOUR, 'it works for seven days');
  const stored = await pool!.query<{ code: string }>('SELECT code FROM invites WHERE id = $1', [made.body.invite.id]);
  assert.notEqual(stored.rows[0]!.code, code, 'the server keeps a hash, never the code');
  assert.ok(!stored.rows[0]!.code.includes(code.slice(0, 4)));
  assert.ok(await ownerAccount.waitFor((frame) => frame.event === 'room_invite' && frame.data.invite.id === made.body.invite.id
    && frame.data.invite.state === 'open'), 'the maker\'s other devices hear the new invite');

  const listed = await call('GET', `/rooms/${roomId}/invites`, owner.token);
  assert.deepEqual(listed.body.invites.map((invite: any) => invite.id), [made.body.invite.id]);
  assert.equal('code' in listed.body.invites[0], false, 'a listed invite never carries the code');

  // Alice's bot uses the code from her MCP client (lower case, no dash: forgiven).
  const used = await call('POST', '/invites/redeem', 'alice_owner_token', { code: code.toLowerCase().replace('-', '') });
  assert.equal(used.status, 200, JSON.stringify(used.body));
  assert.deepEqual(used.body, { outcome: 'admitted', room_id: roomId, display_name: used.body.display_name, joined: true });
  assert.deepEqual(await memberRows(roomId), ['alice:invite:owner', 'owner:creator:-']);
  assert.deepEqual(await systemLines(roomId), ['Grok Bot joined with owner\'s invite']);
  const usedFrame = await ownerAccount.waitFor((frame) => frame.event === 'room_invite' && frame.data.invite.state === 'used');
  assert.ok(usedFrame, 'the maker\'s pill hears the join');
  assert.equal(usedFrame!.data.invite.outcome, 'admitted');
  assert.equal(usedFrame!.data.invite.used_by_login, 'alice');
  assert.deepEqual((await call('GET', `/rooms/${roomId}/invites`, owner.token)).body.invites, [], 'a used invite leaves the list');
  // The maker reads it again by id after a gap in the stream, and learns that the bot came in.
  const readAgain = await call('GET', `/rooms/${roomId}/invites/${made.body.invite.id}`, owner.token);
  assert.equal(readAgain.status, 200, JSON.stringify(readAgain.body));
  assert.equal(readAgain.body.invite.state, 'used');
  assert.equal(readAgain.body.invite.outcome, 'admitted');
  assert.equal('code' in readAgain.body.invite, false, 'a read invite never carries the code');
  assert.equal((await call('GET', `/rooms/${roomId}/invites/${made.body.invite.id}`, alice.token)).status, 404,
    'a member who is not the maker cannot read it');
  assert.equal((await call('GET', `/rooms/${roomId}/invites/${made.body.invite.id}`, bob.token)).status, 403,
    'a stranger is refused at the room');
  assert.equal((await call('GET', `/rooms/${roomId}/invites/inv_missing`, owner.token)).status, 404);

  // Alice's bot can now join the room itself.
  assert.equal((await call('POST', `/rooms/${roomId}/join`, 'alice_owner_token')).status, 200);

  // The same account again (a lost answer) is answered, not refused, and posts nothing new.
  const again = await call('POST', '/invites/redeem', 'alice_owner_token', { code });
  assert.equal(again.status, 200);
  assert.equal(again.body.joined, false);
  assert.equal((await systemLines(roomId)).length, 1);
  // Anyone else is refused: a code works one time.
  const second = await call('POST', '/invites/redeem', bob.token, { code });
  assert.equal(second.status, 410);
  assert.equal(second.body.code, 'INVITE_USED');

  // A cancelled code is refused, and only the maker can cancel.
  const another = await call('POST', `/rooms/${roomId}/invites`, owner.token, { platform: 'chatgpt' });
  assert.equal((await call('POST', `/rooms/${roomId}/invites/${another.body.invite.id}/cancel`, alice.token)).status, 404);
  const cancelled = await call('POST', `/rooms/${roomId}/invites/${another.body.invite.id}/cancel`, owner.token);
  assert.equal(cancelled.body.invite.state, 'cancelled');
  assert.ok(await ownerAccount.waitFor((frame) => frame.event === 'room_invite' && frame.data.invite.id === another.body.invite.id
    && frame.data.invite.state === 'cancelled'));
  const refusedCancelled = await call('POST', '/invites/redeem', bob.token, { code: another.body.code });
  assert.equal(refusedCancelled.status, 410);
  assert.equal(refusedCancelled.body.code, 'INVITE_CANCELLED');
  assert.equal((await call('POST', `/rooms/${roomId}/invites/${another.body.invite.id}/cancel`, owner.token)).status, 200,
    'cancelling again is done, not an error');

  // An ended code is refused.
  const old = await call('POST', `/rooms/${roomId}/invites`, owner.token, { platform: 'claude' });
  await pool!.query(`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [old.body.invite.id]);
  const refusedOld = await call('POST', '/invites/redeem', bob.token, { code: old.body.code });
  assert.equal(refusedOld.body.code, 'INVITE_EXPIRED');
  assert.equal((await call('POST', `/rooms/${roomId}/invites/${old.body.invite.id}/cancel`, owner.token)).body.code, 'INVITE_NOT_OPEN');

  // A made-up code, and no code, are not found; nobody signed in is asked to sign in.
  assert.equal((await call('POST', '/invites/redeem', bob.token, { code: 'AAAA-BBBB' })).body.code, 'INVITE_NOT_FOUND');
  assert.equal((await call('POST', '/invites/redeem', bob.token, {})).body.code, 'INVITE_NOT_FOUND');
  assert.equal((await call('POST', '/invites/redeem', null, { code })).status, 401);
  assert.deepEqual(await memberRows(roomId), ['alice:invite:owner', 'owner:creator:-'], 'none of that let anyone in');

  // An admin's invite answers the account's own waiting request, so it does not sit in Requests.
  const carol = await person('carol');
  assert.equal((await call('POST', `/rooms/${roomId}/join-requests`, carol.token)).status, 201);
  const forCarol = await call('POST', `/rooms/${roomId}/invites`, owner.token, { platform: 'other' });
  assert.equal((await call('POST', '/invites/redeem', carol.token, { code: forCarol.body.code })).body.joined, true);
  assert.deepEqual((await call('GET', '/account/room-join-requests', owner.token)).body.join_requests, []);
  const carolRequest = await pool!.query<{ state: string; decided_by: string }>(
    'SELECT state, decided_by FROM room_join_requests WHERE room_id = $1 AND account_id = $2', [roomId, carol.id]);
  assert.deepEqual(carolRequest.rows, [{ state: 'approved', decided_by: owner.id }]);
  // Removed since: the old code does not answer "admitted" again.
  assert.equal((await call('DELETE', `/rooms/${roomId}/members/${carol.id}`, owner.token)).status, 200);
  assert.equal((await call('POST', '/invites/redeem', carol.token, { code: forCarol.body.code })).body.code, 'INVITE_USED');

  // A person inviting their own bot (the same account) is in already: the invite is used and the room sees the bot arrive.
  const own = await call('POST', `/rooms/${roomId}/invites`, owner.token, { platform: 'chatgpt' });
  const ownUse = await call('POST', '/invites/redeem', 'owner_owner_token', { code: own.body.code });
  assert.equal(ownUse.body.outcome, 'admitted');
  assert.equal(ownUse.body.joined, false);
  assert.deepEqual(await systemLines(roomId), [
    'Grok Bot joined with owner\'s invite',
    'A bot joined with owner\'s invite',
    'ChatGPT joined with owner\'s invite',
  ]);
  assert.ok(await aliceAccount.waitFor((frame) => frame.event === 'snapshot'));
  assert.equal(aliceAccount.frames.some((frame) => frame.event === 'room_invite'), false, 'only the maker hears invite events');
});

test('a member\'s invite asks the admins; a code waits while its maker stays in the room; Git Rooms take none', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const bob = await person('bob');
  const carol = await person('carol');
  const dave = await person('dave');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const roomId = (await call('POST', '/projects/room/member-lounge', owner.token)).body.id as string;
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed')`, [roomId, bob.id]);

  const made = await call('POST', `/rooms/${roomId}/invites`, bob.token, { platform: 'claude' });
  assert.equal(made.status, 201);
  assert.equal(made.body.invite.kind, 'request', 'a member\'s invite does not bypass the admins');
  const used = await call('POST', '/invites/redeem', carol.token, { code: made.body.code });
  assert.equal(used.status, 200, JSON.stringify(used.body));
  assert.equal(used.body.outcome, 'requested');
  assert.equal(used.body.join_request.state, 'pending');
  assert.deepEqual(await memberRows(roomId), ['bob:seed:-', 'owner:creator:-'], 'carol is not in yet');
  assert.deepEqual(await systemLines(roomId), [], 'a request posts no room line');
  const inbox = await call('GET', '/account/room-join-requests', owner.token);
  assert.deepEqual(inbox.body.join_requests.map((request: any) => request.login), ['carol'], 'the admin sees the usual request');
  const usedRow = await pool!.query<{ outcome: string; join_request_id: string }>('SELECT outcome, join_request_id FROM invites WHERE id = $1',
    [made.body.invite.id]);
  assert.equal(usedRow.rows[0]!.outcome, 'requested');
  assert.equal(usedRow.rows[0]!.join_request_id, used.body.join_request.id);
  assert.equal((await call('POST', '/invites/redeem', dave.token, { code: made.body.code })).body.code, 'INVITE_USED');

  // An admin's invite whose maker has left speaks for nobody.
  const second = await person('second');
  await pool!.query(`INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, now())`, [roomId, second.id]);
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed')`, [roomId, second.id]);
  const fromSecond = await call('POST', `/rooms/${roomId}/invites`, second.token, { platform: 'grok' });
  assert.equal(fromSecond.body.invite.kind, 'admit');
  assert.equal((await call('DELETE', `/rooms/${roomId}/members/${second.id}`, owner.token)).status, 200);
  assert.equal((await call('POST', '/invites/redeem', dave.token, { code: fromSecond.body.code })).body.code, 'INVITE_MAKER_LEFT');

  // A Git Room takes no invites: not made there, and not used after a room becomes one.
  const pending = await call('POST', `/rooms/${roomId}/invites`, owner.token, { platform: 'grok' });
  await pool!.query(`UPDATE rooms SET origin = 'repo' WHERE id = $1`, [roomId]);
  const refusedMake = await call('POST', `/rooms/${roomId}/invites`, owner.token, { platform: 'grok' });
  assert.equal(refusedMake.status, 409);
  assert.equal(refusedMake.body.code, 'INVITE_REPO_ROOM');
  const refusedUse = await call('POST', '/invites/redeem', dave.token, { code: pending.body.code });
  assert.equal(refusedUse.status, 409);
  assert.equal(refusedUse.body.code, 'INVITE_REPO_ROOM');
  assert.equal((await pool!.query('SELECT 1 FROM room_members WHERE room_id = $1 AND account_id = $2', [roomId, dave.id])).rowCount, 0);
  await pool!.query(`UPDATE rooms SET origin = 'named' WHERE id = $1`, [roomId]);
});

test('a Git Room\'s picker lists the invite rooms, and its invites show their pill in the Git Room', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const bob = await person('bob');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const skyOwl = (await call('POST', '/projects/room/sky-owl', owner.token)).body.id as string;
  const fern = (await call('POST', '/projects/room/fern-river', bob.token)).body.id as string;
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed')`, [fern, owner.id]);
  const gitRoom = 'github.com/acme/app';
  await pool!.query(`INSERT INTO rooms (id, display_name, kind, origin, created_at) VALUES ($1, 'acme/app', 'main', 'repo', now())`, [gitRoom]);
  await pool!.query(`INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, now())`, [gitRoom, owner.id]);

  const rooms = await call('GET', '/account/invite-rooms', owner.token);
  assert.equal(rooms.status, 200, JSON.stringify(rooms.body));
  assert.deepEqual(
    rooms.body.rooms.map((room: any) => `${room.id}:${room.role}:${room.member_count}`).sort(),
    [`${fern}:member:2`, `${skyOwl}:admin:1`].sort(),
    'the invite rooms, with the role that decides what an invite does; never the Git Room',
  );

  const made = await call('POST', `/rooms/${skyOwl}/invites`, owner.token, { platform: 'grok', origin_room_id: gitRoom });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.invite.room_id, skyOwl);
  assert.equal(made.body.invite.origin_room_id, gitRoom);
  // Reading the Git Room's pills needs access to the Git Room; skipped here (GitHub roles), checked through the store.
  const { listOpenRoomInvites } = await import('../db/room-invites.js');
  assert.deepEqual((await listOpenRoomInvites(owner.id, gitRoom)).map((invite) => invite.id), [made.body.invite.id]);
  assert.deepEqual((await listOpenRoomInvites(owner.id, skyOwl)).map((invite) => invite.id), [made.body.invite.id]);
  assert.deepEqual(await listOpenRoomInvites(bob.id, skyOwl), [], 'only the maker sees their invites');
});

test('using codes is limited per account and per address', databaseTestOptions, async (t) => {
  const eve = await person('eve');
  const frank = await person('frank');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await call('POST', '/invites/redeem', eve.token, { code: 'AAAA-BBBB' })).status, 404);
  }
  const limited = await call('POST', '/invites/redeem', eve.token, { code: 'AAAA-BBBB' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await call('POST', '/invites/redeem', frank.token, { code: 'AAAA-BBBB' }, '203.0.113.9');
  }
  const sameAddress = await person('grace');
  assert.equal((await call('POST', '/invites/redeem', sameAddress.token, { code: 'AAAA-BBBB' }, '203.0.113.9')).status, 429,
    'another account from the same address waits too');
});
