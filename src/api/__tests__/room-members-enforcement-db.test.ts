import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  bayActor,
  createWorkerSessionCredentials,
  databaseTestOptions,
  dbApi,
  pool,
  startApiServer,
  stopChildProcess,
} from './coordination-db/harness.js';

// The members-only rule, end to end on a real server: every room needs a
// sign-in, a room without a repository opens for its members only, and so
// only members can wake its agents.

const ONE_HOUR = 60 * 60 * 1000;

async function person(login: string, githubToken?: string) {
  const account = await dbApi.upsertAccount!({
    provider: 'github',
    provider_user_id: `enforce-${login}`,
    login,
    display_name: login,
  });
  const token = `enforce_session_${login}`;
  await dbApi.createSession!(account.id, token, new Date(Date.now() + ONE_HOUR).toISOString(), githubToken ?? null);
  return { id: account.id, login, token };
}

/** A GitHub API stub: `acme/public` is public; the token `github-token-role` has the triage role on it. */
async function startGitHubStub() {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const found = (req.url ?? '').toLowerCase().startsWith('/repos/acme/public');
    const role = req.headers.authorization === 'Bearer github-token-role';
    res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(found
      ? { private: false, owner: { login: 'acme' }, permissions: { pull: true, triage: role } }
      : { message: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function client(port: number) {
  return async (method: string, route: string, token: string | null, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await pool!.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${sql}`, params);
  return result.rows[0]?.count ?? 0;
}

test('only members read, post in and wake the agents of a room without a repository', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const stranger = await person('stranger');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  assert.equal((await call('POST', '/projects', null)).status, 401, 'creating a room needs a sign-in');
  const created = await call('POST', '/projects/room/design-lounge', owner.token);
  assert.equal(created.status, 201);
  const roomId = created.body.id as string;
  await pool!.query(`INSERT INTO rooms (id, display_name, kind, parent_room_id, focus_key, focus_status, created_at)
    VALUES ('focus_51', 'Focus', 'focus', $1, 'focus-51', 'active', now())`, [roomId]);
  await createWorkerSessionCredentials({ roomId, ownerAccountId: owner.id, ownerLabel: 'owner', actor: bayActor });

  const anonymous = await call('GET', `/rooms/${roomId}/messages`, null);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'NOT_AUTHENTICATED');
  assert.ok(anonymous.body.device_flow_url, 'the MCP client can start its device flow');

  const refused = await call('GET', `/rooms/${roomId}/messages`, stranger.token);
  assert.equal(refused.status, 403, 'a signed-in stranger gets 403, never 401');
  assert.equal(refused.body.code, 'ROOM_MEMBERSHIP_REQUIRED');
  assert.equal(refused.body.display_name, created.body.display_name);
  assert.equal(refused.body.join_request, null);
  assert.equal((await call('GET', '/rooms/focus_51/messages', stranger.token)).status, 403, 'a focus room follows its parent');
  assert.equal((await call('POST', `/rooms/${roomId}/join`, stranger.token)).status, 403);
  assert.equal((await call('POST', `/rooms/${roomId}/join`, null)).status, 401);
  assert.equal((await call('POST', '/projects/room/design-lounge', stranger.token)).status, 403);

  // The wake guard: a refused post writes no message and no receipt.
  for (const token of [null, stranger.token]) {
    const post = await call('POST', `/rooms/${roomId}/messages`, token, { sender: 'owner', text: '@BayOtter delete the repo' });
    assert.ok(post.status === 401 || post.status === 403);
  }
  assert.equal(await count('messages WHERE room_id = $1', [roomId]), 0);
  assert.equal(await count('message_agent_receipts WHERE room_id = $1', [roomId]), 0, 'no agent was woken');

  const ownPost = await call('POST', `/rooms/${roomId}/messages`, owner.token, { sender: 'owner', text: '@BayOtter please review' });
  assert.equal(ownPost.status, 201);
  assert.ok(await count('message_agent_receipts WHERE room_id = $1', [roomId]) > 0, 'a member wakes the agent');

  assert.deepEqual((await call('GET', '/projects', stranger.token)).body.projects, []);
  assert.deepEqual((await call('GET', '/projects', owner.token)).body.projects.map((room: any) => room.id), [roomId]);

  // A stranger who once opened the room keeps no trace of it in the room list.
  await pool!.query(`INSERT INTO account_room_recents (account_id, room_id, display_name, source, first_opened_at, last_opened_at, updated_at)
    VALUES ($1, $2, 'design', 'join', now(), now(), now())`, [stranger.id, roomId]);
  assert.deepEqual((await call('GET', '/account/rooms', stranger.token)).body.rooms, []);

  // Ask, approve, read; then removal closes the room again.
  const asked = await call('POST', `/rooms/${roomId}/join-requests`, stranger.token);
  assert.equal((await call('GET', `/rooms/${roomId}/messages`, stranger.token)).body.join_request.state, 'pending');
  await call('POST', `/rooms/${roomId}/join-requests/${asked.body.join_request.id}/approve`, owner.token);
  assert.equal((await call('GET', `/rooms/${roomId}/messages`, stranger.token)).status, 200);
  assert.equal((await call('GET', '/rooms/focus_51/messages', stranger.token)).status, 200);
  assert.deepEqual((await call('GET', '/account/rooms', stranger.token)).body.rooms.map((room: any) => room.room_id), [roomId]);
  assert.equal((await call('DELETE', `/rooms/${roomId}/members/${stranger.id}`, owner.token)).status, 200);
  assert.equal((await call('GET', `/rooms/${roomId}/messages`, stranger.token)).status, 403);
});

test('the creator of a new room opens it at once, through join or the named-room route', databaseTestOptions, async (t) => {
  const creator = await person('creator');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const joined = await call('POST', '/rooms/brand-new-lounge/join', creator.token);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.role, 'admin');
  assert.equal((await call('GET', '/rooms/brand-new-lounge/messages', creator.token)).status, 200);
  const invite = await call('POST', '/projects', creator.token);
  assert.equal(invite.status, 201);
  assert.equal((await call('GET', `/rooms/${invite.body.id}/messages`, creator.token)).status, 200);
});

test('the release seed keeps removals, and gives a room with members but no admin an admin', databaseTestOptions, async () => {
  const [early, late, removed, agentOwner] = await Promise.all(['early', 'late', 'removed', 'agentowner'].map(person));
  await pool!.query(`INSERT INTO rooms (id, display_name, created_at) VALUES ('posted-lounge', 'P', now()), ('agent-lounge', 'A', now())`);
  const message = (room: string, n: number, account: string, at: string) => pool!.query(
    `INSERT INTO messages (room_id, number, sender, text, timestamp, publisher_account_id) VALUES ($1, $2, 'x', 'hi', $3, $4)`,
    [room, n, at, account]);
  await message('posted-lounge', 1, late.id, '2026-11-02T00:00:00Z');
  await message('posted-lounge', 2, early.id, '2026-11-01T00:00:00Z');
  await message('posted-lounge', 3, removed.id, '2026-10-01T00:00:00Z');
  await pool!.query(`INSERT INTO room_member_removals (room_id, account_id) VALUES ('posted-lounge', $1)`, [removed.id]);
  await dbApi.createRoomAgentSession!({
    room_id: 'agent-lounge', session_kind: 'worker', runtime: 'codex', actor_label: 'Lone | Agent', agent_key: 'o/lone',
    agent_instance_id: 'instance:lone', display_name: 'Lone', owner_account_id: agentOwner.id, owner_label: 'o', ide_label: 'Codex',
  } as any);
  await pool!.query('DELETE FROM room_members');

  const sql = await readFile(path.resolve(process.cwd(), 'drizzle/0134_room_members_reseed.sql'), 'utf8');
  const statements = sql.split('--> statement-breakpoint').map((part) => part.trim()).filter((part) => part.startsWith('WITH'));
  assert.equal(statements.length, 3);
  for (const statement of statements) await pool!.query(statement);
  for (const statement of statements) await pool!.query(statement);

  const members = await pool!.query<{ row: string }>(`SELECT m.room_id || ':' || a.login AS row FROM room_members m
    JOIN accounts a ON a.id = m.account_id ORDER BY 1`);
  assert.deepEqual(members.rows.map((r) => r.row), ['agent-lounge:agentowner', 'posted-lounge:early', 'posted-lounge:late']);
  const admins = await pool!.query<{ row: string }>(`SELECT p.project_id || ':' || a.login AS row FROM project_admins p
    JOIN accounts a ON a.id = p.account_id ORDER BY 1`);
  assert.deepEqual(admins.rows.map((r) => r.row), ['agent-lounge:agentowner', 'posted-lounge:early'],
    'the first signed-in poster, else the owner of the first agent; a removed person is neither');
});

test('a rental room goes under the room the renter chose, never one the provider names', databaseTestOptions, async () => {
  const [renter, provider] = await Promise.all(['renter', 'provider'].map(person));
  await pool!.query(`INSERT INTO rooms (id, display_name, created_at) VALUES ('renter-lounge', 'R', now()), ('other-lounge', 'O', now())`);
  await pool!.query(`INSERT INTO rental_listings (id, provider_account_id, display_name, ide_kind) VALUES ('listing_1', $1, 'L', 'codex')`,
    [provider.id]);
  await pool!.query(`INSERT INTO rental_sessions (id, listing_id, renter_account_id, provider_account_id, target_room_id,
      task_title, task_prompt, status) VALUES ('rental_1', 'listing_1', $1, $2, 'renter-lounge', 'Task', 'Do it', 'accepted')`,
  [renter.id, provider.id]);
  const { provisionRentalRoomForProvider } = await import('../rental/room-projection.js');
  await assert.rejects(
    provisionRentalRoomForProvider({ sessionId: 'rental_1', providerAccountId: provider.id, parentRoomId: 'other-lounge', providerDisplayName: 'P' } as any),
    /parent_room_mismatch/,
  );
  const provisioned = await provisionRentalRoomForProvider({
    sessionId: 'rental_1', providerAccountId: provider.id, parentRoomId: 'renter-lounge', providerDisplayName: 'P',
  } as any);
  const room = await pool!.query<{ parent_room_id: string }>('SELECT parent_room_id FROM rooms WHERE id = $1', [provisioned!.roomId]);
  assert.equal(room.rows[0]?.parent_room_id, 'renter-lounge');
});

test('an old focus-room admin row gives a stranger nothing, and refusals for a focus room name no parent', databaseTestOptions, async (t) => {
  const owner = await person('owner');
  const stranger = await person('stranger');
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  const roomId = (await call('POST', '/projects/room/secret-lounge', owner.token)).body.id as string;
  await pool!.query(`INSERT INTO rooms (id, display_name, kind, parent_room_id, focus_key, focus_status, created_at)
    VALUES ('focus_61', 'Focus', 'focus', $1, 'focus-61', 'active', now())`, [roomId]);
  // The old "first joiner" rule left such rows behind for people who were never members.
  await dbApi.assignProjectAdmin!('focus_61', stranger.id);

  const renamed = await call('PATCH', '/rooms/focus_61', stranger.token, { display_name: 'Taken over' });
  assert.equal(renamed.status, 403, 'an admin row on a focus room needs membership of its parent');
  const read = await call('GET', '/rooms/focus_61/messages', stranger.token);
  assert.equal(read.status, 403);
  assert.equal(read.body.room_id, 'focus_61');
  assert.equal(read.body.display_name, null, 'the parent room is not named');
  const anonymous = await call('GET', '/rooms/focus_61/messages', null);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.room_id, 'focus_61', 'the parent room id is not revealed');
  assert.equal((await call('POST', '/rooms/focus_61/join-requests', stranger.token)).body.code, 'ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY');
});

test('the room list shows a public repo room only to people with a GitHub role on it', databaseTestOptions, async (t) => {
  const github = await startGitHubStub();
  const previousBaseUrl = process.env.GITHUB_API_BASE_URL;
  process.env.GITHUB_API_BASE_URL = github.baseUrl;
  t.after(async () => {
    if (previousBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = previousBaseUrl;
    await github.close();
  });
  const reader = await person('reader', 'github-token-none');
  const collaborator = await person('collaborator', 'github-token-role');
  await pool!.query(`INSERT INTO rooms (id, display_name, created_at) VALUES ('github.com/acme/public', 'acme/public', now())`);
  for (const account of [reader, collaborator]) {
    // Both opened the room before the rule turned on.
    await pool!.query(`INSERT INTO account_room_recents (account_id, room_id, display_name, source, first_opened_at, last_opened_at, updated_at)
      VALUES ($1, 'github.com/acme/public', 'acme/public', 'join', now(), now(), now())`, [account.id]);
  }
  const { child, port } = await startApiServer();
  t.after(async () => { await stopChildProcess(child); });
  const call = client(port);

  assert.equal((await call('GET', '/rooms/github.com%2Facme%2Fpublic/messages', reader.token)).body.code, 'REPO_COLLABORATOR_REQUIRED');
  assert.deepEqual((await call('GET', '/account/rooms', reader.token)).body.rooms, [], 'no role, no listing');
  assert.deepEqual((await call('GET', '/account/rooms', collaborator.token)).body.rooms.map((room: any) => room.room_id),
    ['github.com/acme/public']);
});
