import assert from 'node:assert/strict';
import test from 'node:test';
import type { Express } from 'express';

import {
  REPO_ROOM_USES_GITHUB_ROLES,
  ROOM_MEMBERSHIP_REQUIRED,
  roomAccessRefusal,
  type RoomMemberRole,
} from '../../../shared/room-membership.mjs';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerRoomMemberRoutes } = await import('../routes/rooms/members.js');

type Auth = 'session' | 'owner_token' | 'agent_session' | 'supervisor_grant' | null;

const rooms = {
  team: { id: 'ops-lounge', display_name: 'Team room', parent_room_id: null },
  focus: { id: 'focus_7', display_name: 'Focus', parent_room_id: 'ops-lounge' },
  repo: { id: 'github.com/acme/app', display_name: 'acme/app', parent_room_id: null },
} as const;

function harness(options: { roles?: Record<string, RoomMemberRole>; participantDenied?: boolean } = {}) {
  const routes: Array<{ method: string; path: RegExp | string; handler: Function }> = [];
  const roles = new Map(Object.entries(options.roles ?? {}));
  const calls: string[] = [];
  const app = Object.fromEntries(['get', 'put', 'post', 'delete'].map((method) => [
    method,
    (path: RegExp | string, handler: Function) => routes.push({ method, path, handler }),
  ])) as unknown as Express;

  registerRoomMemberRoutes(app, {
    resolveCanonicalRoomRequestId: async (id) => id,
    resolveRoomOrReply: async (id, res) => {
      const room = Object.values(rooms).find((candidate) => candidate.id === id);
      if (!room) { res.status(404).json({ error: 'Room not found' }); return null; }
      return room as any;
    },
    requireParticipant: async (_req, res) => {
      if (options.participantDenied) { res.status(403).json({ error: 'private_repo_no_access' }); return false; }
      return true;
    },
    getProjectById: async (id) => (Object.values(rooms).find((room) => room.id === id) ?? null) as any,
    resolveProjectRepoAccessTarget: async (project) => project.id.startsWith('github.com/')
      ? { roomName: project.id, repoRoomName: project.id, binding: null }
      : null,
    endMemberAgentSession: async (session, _person, options) => {
      calls.push(`end:${session.session_id}:${options.closeOpenRequests ? 'close' : 'keep'}`);
      return true;
    },
    endMemberAgentAsk: async (askId) => { calls.push(`end-ask:${askId}`); return true; },
    memberStore: {
      liveAgentAskIdsForAsker: async (roomId: string, accountId: string) => {
        calls.push(`asks:${roomId}:${accountId}`);
        return accountId === 'member' ? ['ask_1'] : [];
      },
      getRoomMemberRole: async (roomId: string, accountId: string) => {
        calls.push(`role:${roomId}`);
        return roles.get(accountId) ?? null;
      },
      getLatestRoomJoinRequest: async () => null,
      listRoomMembers: async (roomId: string) => [...roles].map(([account_id, role]) => ({
        account_id, login: account_id, display_name: null, avatar_url: null, role, added_via: 'seed', joined_at: roomId,
      })),
      getRoomMember: async (_roomId: string, accountId: string) => roles.has(accountId)
        ? { account_id: accountId, role: roles.get(accountId) }
        : null,
      setRoomMemberRole: async (_roomId: string, accountId: string, role: RoomMemberRole, actor: string) => {
        calls.push(`set-role:${accountId}:${role}:by:${actor}`);
        roles.set(accountId, role);
        return { kind: 'changed' };
      },
      removeRoomMember: async (roomId: string, accountId: string, actor: string) => {
        calls.push(`remove:${roomId}:${accountId}:by:${actor}`);
        roles.delete(accountId);
        return { kind: 'removed', login: accountId, agent_sessions: [{ session_id: 'ras_1', room_id: 'focus_7', agent_key: 'k', agent_instance_id: null }] };
      },
      createRoomJoinRequest: async (roomId: string) => {
        calls.push(`request:${roomId}`);
        return { kind: 'created', join_request: { id: 'rjr_1', state: 'pending', created_at: 'now', decided_at: null, retry_after: null } };
      },
      decideRoomJoinRequest: async (input: { roomId: string; decision: string }) => {
        calls.push(`decide:${input.roomId}:${input.decision}`);
        return { kind: 'decided', join_request: { id: 'rjr_1', account_id: 'asker', state: input.decision } };
      },
      listRoomJoinRequests: async () => [],
      listPendingJoinRequestsForAdmin: async () => [],
      cancelRoomJoinRequest: async () => ({ kind: 'not_found' }),
    } as any,
  });

  async function request(method: string, path: string, options: { auth?: Auth; account?: string; body?: any } = {}) {
    const route = routes.find((candidate) => candidate.method === method && (typeof candidate.path === 'string'
      ? candidate.path === path
      : candidate.path.test(path)));
    assert.ok(route, `${method} ${path} is routed`);
    const matches = typeof route.path === 'string' ? [path] : path.match(route.path)!;
    const auth = options.auth === undefined ? 'session' : options.auth;
    const req = {
      method: method.toUpperCase(),
      params: Object.fromEntries(matches.slice(1).map((value, index) => [index, value])),
      query: {},
      body: options.body ?? {},
      authKind: auth,
      sessionAccount: auth && auth !== 'agent_session' && auth !== 'supervisor_grant'
        ? { account_id: options.account ?? 'admin', login: options.account ?? 'admin' }
        : null,
      headers: {},
    };
    let status = 200;
    let body: any;
    const res = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; } };
    await route.handler(req, res);
    return { status, body };
  }

  return { request, calls };
}

test('a person with no sign-in gets 401 and an agent gets 403, never the member list', async () => {
  const { request } = harness({ roles: { admin: 'admin' } });
  const anonymous = await request('get', '/rooms/ops-lounge/members', { auth: null });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'NOT_AUTHENTICATED');
  for (const auth of ['agent_session', 'supervisor_grant'] as const) {
    const agent = await request('get', '/rooms/ops-lounge/members', { auth });
    assert.equal(agent.status, 403, `${auth} is refused`);
    assert.equal(agent.body.code, 'PERSON_REQUIRED');
  }
});

test('a signed-in person who is not a member gets the 403 membership refusal, not a 401', async () => {
  const { request } = harness({ roles: { admin: 'admin' } });
  const refused = await request('get', '/rooms/ops-lounge/members', { account: 'stranger' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, ROOM_MEMBERSHIP_REQUIRED.code);
  assert.equal(refused.body.room_id, 'ops-lounge');
  assert.equal(refused.body.display_name, 'Team room');
  assert.equal(roomAccessRefusal(refused.body), 'membership_required');
});

test('a focus room uses the members and admins of its parent room', async () => {
  const { request, calls } = harness({ roles: { admin: 'admin', member: 'member' } });
  const membership = await request('get', '/rooms/focus_7/membership', { account: 'member' });
  assert.equal(membership.status, 200);
  assert.deepEqual(
    { ...membership.body },
    {
      room_id: 'focus_7', access_room_id: 'ops-lounge', display_name: 'Team room', managed_by: 'letagents',
      member: true, role: 'member', join_request: null,
    },
  );
  const request_ = await request('post', '/rooms/focus_7/join-requests', { account: 'stranger' });
  assert.equal(request_.status, 201);
  assert.ok(calls.includes('request:ops-lounge'), 'the request is for the parent room');
  assert.ok(calls.every((call) => !call.includes('focus_7') || call.startsWith('end:')), calls.join(', '));
});

test('only a person in the app can admit or remove people; an owner token cannot', async () => {
  const { request } = harness({ roles: { admin: 'admin' } });
  for (const [method, path] of [
    ['post', '/rooms/ops-lounge/join-requests/rjr_1/approve'],
    ['post', '/rooms/ops-lounge/join-requests/rjr_1/decline'],
    ['put', '/rooms/ops-lounge/members/other/role'],
    ['delete', '/rooms/ops-lounge/members/other'],
  ] as const) {
    const refused = await request(method, path, { auth: 'owner_token', body: { role: 'admin' } });
    assert.equal(refused.status, 403, `${method} ${path}`);
    assert.equal(refused.body.code, 'PERSON_REQUIRED');
  }
  const approved = await request('post', '/rooms/ops-lounge/join-requests/rjr_1/approve');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.join_request.state, 'approved');
});

test('an owner token reads only its own state: no member list, no requests, no inbox', async () => {
  const { request } = harness({ roles: { admin: 'admin' } });
  for (const path of ['/rooms/ops-lounge/members', '/rooms/ops-lounge/join-requests', '/account/room-join-requests']) {
    const refused = await request('get', path, { auth: 'owner_token' });
    assert.equal(refused.status, 403, path);
    assert.equal(refused.body.code, 'PERSON_REQUIRED');
  }
  const own = await request('get', '/rooms/ops-lounge/membership', { auth: 'owner_token' });
  assert.equal(own.status, 200);
  assert.equal(own.body.role, 'admin');
  assert.equal((await request('post', '/rooms/ops-lounge/join-requests', { auth: 'owner_token', account: 'asker' })).status, 201);
});

test('a member who is not an admin cannot admit people, but can leave with an owner token', async () => {
  const { request, calls } = harness({ roles: { admin: 'admin', member: 'member' } });
  const approve = await request('post', '/rooms/ops-lounge/join-requests/rjr_1/approve', { account: 'member' });
  assert.equal(approve.status, 403);
  assert.equal(approve.body.error, 'Admin privileges required');
  const removeOther = await request('delete', '/rooms/ops-lounge/members/admin', { account: 'member' });
  assert.equal(removeOther.status, 403);
  const leave = await request('delete', '/rooms/ops-lounge/members/member', { auth: 'owner_token', account: 'member' });
  assert.equal(leave.status, 200);
  assert.deepEqual(leave.body, { removed: true, account_id: 'member', ended_agent_sessions: 1, ended_agent_asks: 1 });
  assert.ok(calls.includes('end-ask:ask_1'), 'an agent lent to the person through an ask ends with its ask');
  assert.ok(calls.includes('remove:ops-lounge:member:by:member'));
  assert.ok(calls.includes('end:ras_1:keep'), 'the agents of a person who left end, and nothing is posted for them');

  const removed = await request('delete', '/rooms/ops-lounge/members/other', { account: 'admin' });
  assert.equal(removed.status, 200);
  assert.ok(calls.includes('remove:ops-lounge:other:by:admin'), 'the store re-checks the admin under its lock');
  assert.ok(calls.includes('end:ras_1:close'), 'an admin removal closes the agent\'s open requests');
});

test('repo rooms answer that GitHub roles decide, after the repository access check', async () => {
  const { request, calls } = harness({ roles: { admin: 'admin' } });
  const membership = await request('get', '/rooms/github.com/acme/app/membership', { account: 'anyone' });
  assert.equal(membership.status, 200);
  assert.equal(membership.body.managed_by, 'github');
  assert.equal(membership.body.member, null);
  const members = await request('get', '/rooms/github.com/acme/app/members', { account: 'anyone' });
  assert.deepEqual(members.body.members, []);
  for (const [method, path] of [
    ['post', '/rooms/github.com/acme/app/join-requests'],
    ['post', '/rooms/github.com/acme/app/join-requests/rjr_1/approve'],
    ['delete', '/rooms/github.com/acme/app/members/admin'],
  ] as const) {
    const refused = await request(method, path);
    assert.equal(refused.status, 409, `${method} ${path}`);
    assert.equal(refused.body.code, REPO_ROOM_USES_GITHUB_ROLES.code);
  }
  assert.ok(calls.every((call) => !call.includes('github.com')), 'no member rows are read or written for a repo room');

  const privateRepo = harness({ participantDenied: true });
  const denied = await privateRepo.request('get', '/rooms/github.com/acme/app/membership', { account: 'anyone' });
  assert.equal(denied.status, 403, 'a private repo keeps its own refusal, so its name stays hidden');
  assert.equal(denied.body.error, 'private_repo_no_access');
});

test('join requests have a per-account rate limit', async () => {
  const { request } = harness();
  let last = 0;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    last = (await request('post', '/rooms/ops-lounge/join-requests', { account: 'eager' })).status;
  }
  assert.equal(last, 429);
  assert.equal((await request('post', '/rooms/ops-lounge/join-requests', { account: 'calm' })).status, 201);
});
