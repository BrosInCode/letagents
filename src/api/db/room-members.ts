import crypto from 'node:crypto';
import type { PoolClient } from 'pg';

import {
  ROOM_JOIN_REQUEST_DECLINE_COOLDOWN_MS,
  type RoomJoinRequest,
  type RoomJoinRequestState,
  type RoomJoinRequestSummary,
  type RoomMember,
  type RoomMemberRole,
  type RoomMemberSource,
} from '../../../shared/room-membership.mjs';
import {
  enqueueJoinRequestPushes,
  retireJoinRequestPushes,
  retireJoinRequestPushesForAccount,
} from '../notifications/join-request-pushes.js';
import { pool } from './client.js';

// Every function takes the ACCESS room: the room itself, or the parent of a
// focus room. Rows exist only on top-level rooms. A room admin
// (`project_admins` on the access room) is always a member.

type Queryable = Pick<PoolClient, 'query'>;

interface StoredJoinRequest {
  id: string;
  room_id: string;
  account_id: string;
  state: RoomJoinRequestState;
  created_at: Date;
  decided_at: Date | null;
}

interface StoredAdminJoinRequest extends StoredJoinRequest {
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  decided_by_login: string | null;
  room_display_name?: string;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

function retryAfter(row: StoredJoinRequest): string | null {
  if (row.state !== 'declined' || !row.decided_at) return null;
  return new Date(row.decided_at.getTime() + ROOM_JOIN_REQUEST_DECLINE_COOLDOWN_MS).toISOString();
}

export function toJoinRequestSummary(row: StoredJoinRequest): RoomJoinRequestSummary {
  return {
    id: row.id,
    state: row.state,
    created_at: row.created_at.toISOString(),
    decided_at: iso(row.decided_at),
    retry_after: retryAfter(row),
  };
}

function toAdminJoinRequest(row: StoredAdminJoinRequest): RoomJoinRequest {
  return {
    ...toJoinRequestSummary(row),
    room_id: row.room_id,
    account_id: row.account_id,
    login: row.login,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    decided_by_login: row.decided_by_login,
  };
}

async function inTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// The same lock as assignProjectAdminIfRoomHasNoAdmins: every change to the
// admins of a room runs one at a time, so the last admin can never be removed.
async function lockRoomAdmins(client: Queryable, roomId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`project_admin:${roomId}`]);
}

async function lockJoinRequests(client: Queryable, roomId: string, accountId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`room_join_request:${roomId}:${accountId}`]);
}

export async function getRoomMemberRole(roomId: string, accountId: string, client: Queryable = pool): Promise<RoomMemberRole | null> {
  const result = await client.query<{ admin: boolean; member: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM project_admins WHERE project_id = $1 AND account_id = $2) AS admin,
      EXISTS (SELECT 1 FROM room_members WHERE room_id = $1 AND account_id = $2) AS member`, [roomId, accountId]);
  const row = result.rows[0];
  if (row?.admin) return 'admin';
  return row?.member ? 'member' : null;
}

export async function isRoomMember(roomId: string, accountId: string): Promise<boolean> {
  return (await getRoomMemberRole(roomId, accountId)) !== null;
}

export async function addRoomMember(input: {
  roomId: string;
  accountId: string;
  addedVia: RoomMemberSource;
  addedBy?: string | null;
}, client: Queryable = pool): Promise<void> {
  await client.query(`INSERT INTO room_members (room_id, account_id, added_via, added_by)
    VALUES ($1, $2, $3, $4) ON CONFLICT (room_id, account_id) DO NOTHING`,
  [input.roomId, input.accountId, input.addedVia, input.addedBy ?? null]);
}

/** The person who made a room is its first admin and its first member. */
export async function recordRoomCreator(roomId: string, accountId: string): Promise<void> {
  await inTransaction(async (client) => {
    await client.query(`INSERT INTO project_admins (project_id, account_id, assigned_at)
      VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`, [roomId, accountId]);
    await addRoomMember({ roomId, accountId, addedVia: 'creator' }, client);
  });
}

/**
 * Makes the account the creator of a room that nobody holds yet: no admin and
 * no member. Returns false when someone already holds it, for example when two
 * people created the same new room at the same moment.
 */
export async function claimRoomAsCreator(roomId: string, accountId: string): Promise<boolean> {
  return inTransaction(async (client) => {
    await lockRoomAdmins(client, roomId);
    const held = await client.query<{ held: boolean }>(`SELECT
        EXISTS (SELECT 1 FROM project_admins WHERE project_id = $1)
        OR EXISTS (SELECT 1 FROM room_members WHERE room_id = $1) AS held`, [roomId]);
    if (held.rows[0]?.held) return false;
    await client.query(`INSERT INTO project_admins (project_id, account_id, assigned_at)
      VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`, [roomId, accountId]);
    await addRoomMember({ roomId, accountId, addedVia: 'creator' }, client);
    return true;
  });
}

/** Which of these top-level rooms the account is a member or admin of. */
export async function memberRoomIdsForAccount(accountId: string, roomIds: readonly string[]): Promise<Set<string>> {
  if (!roomIds.length) return new Set();
  const result = await pool.query<{ room_id: string }>(`SELECT room_id FROM room_members
      WHERE account_id = $1 AND room_id = ANY($2::text[])
    UNION
    SELECT project_id FROM project_admins WHERE account_id = $1 AND project_id = ANY($2::text[])`,
  [accountId, [...roomIds]]);
  return new Set(result.rows.map((row) => row.room_id));
}

/** The top-level rooms the account is a member or admin of, by name. */
export async function listMemberRooms(accountId: string): Promise<Array<{ id: string; display_name: string }>> {
  const result = await pool.query<{ id: string; display_name: string }>(`SELECT room.id, room.display_name
    FROM rooms AS room
    WHERE room.kind = 'main' AND (
      EXISTS (SELECT 1 FROM room_members WHERE room_id = room.id AND account_id = $1)
      OR EXISTS (SELECT 1 FROM project_admins WHERE project_id = room.id AND account_id = $1))
    ORDER BY lower(room.display_name), room.id
    LIMIT 1000`, [accountId]);
  return result.rows;
}

interface StoredRoomMember {
  account_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  role: RoomMemberRole;
  added_via: RoomMemberSource | null;
  joined_at: Date;
}

/** Members of the room, admins first. `$2` limits it to one account when set. */
const ROOM_MEMBER_SELECT = `SELECT account.id AS account_id, account.login, account.display_name, account.avatar_url,
    CASE WHEN admin.account_id IS NOT NULL THEN 'admin' ELSE 'member' END AS role,
    member.added_via,
    COALESCE(member.created_at, admin.assigned_at) AS joined_at
  FROM (
    SELECT account_id FROM room_members WHERE room_id = $1
    UNION
    SELECT account_id FROM project_admins WHERE project_id = $1
  ) AS ids
  INNER JOIN accounts AS account ON account.id = ids.account_id
  LEFT JOIN room_members AS member ON member.room_id = $1 AND member.account_id = account.id
  LEFT JOIN project_admins AS admin ON admin.project_id = $1 AND admin.account_id = account.id
  WHERE $2::text IS NULL OR account.id = $2
  ORDER BY (admin.account_id IS NULL), joined_at, lower(account.login)`;

function toRoomMember(row: StoredRoomMember): RoomMember {
  return { ...row, joined_at: new Date(row.joined_at).toISOString() };
}

/** Every member; a room has far fewer than this bound, which only guards the response size. */
export async function listRoomMembers(roomId: string): Promise<RoomMember[]> {
  const result = await pool.query<StoredRoomMember>(`${ROOM_MEMBER_SELECT} LIMIT 5000`, [roomId, null]);
  return result.rows.map(toRoomMember);
}

export async function getRoomMember(roomId: string, accountId: string): Promise<RoomMember | null> {
  const result = await pool.query<StoredRoomMember>(ROOM_MEMBER_SELECT, [roomId, accountId]);
  return result.rows[0] ? toRoomMember(result.rows[0]) : null;
}

async function countRoomAdmins(client: Queryable, roomId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM project_admins WHERE project_id = $1', [roomId]);
  return result.rows[0]?.count ?? 0;
}

// The focus rooms under a top-level room: their own admin rows go with the
// parent's, so an admin who stepped down or left keeps no admin anywhere below.
const FOCUS_ROOMS_OF = `SELECT id FROM rooms WHERE parent_room_id = $1 AND kind = 'focus'`;

/** The focus rooms under a top-level room; a join-request event is published on each of them too. */
export async function listFocusRoomIds(roomId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`${FOCUS_ROOMS_OF} ORDER BY id LIMIT 500`, [roomId]);
  return result.rows.map((row) => row.id);
}

export type RoomMemberChange =
  | { kind: 'changed' }
  | { kind: 'forbidden' }
  | { kind: 'not_member' }
  | { kind: 'last_admin' };

/** `actorAccountId` must be an admin, checked again under the lock. */
export async function setRoomMemberRole(
  roomId: string,
  accountId: string,
  role: RoomMemberRole,
  actorAccountId: string,
): Promise<RoomMemberChange> {
  return inTransaction(async (client) => {
    await lockRoomAdmins(client, roomId);
    if (await getRoomMemberRole(roomId, actorAccountId, client) !== 'admin') return { kind: 'forbidden' };
    const current = await getRoomMemberRole(roomId, accountId, client);
    if (!current) return { kind: 'not_member' };
    if (current === role) return { kind: 'changed' };
    if (role === 'admin') {
      await client.query(`INSERT INTO project_admins (project_id, account_id, assigned_at)
        VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`, [roomId, accountId]);
      return { kind: 'changed' };
    }
    if (await countRoomAdmins(client, roomId) <= 1) return { kind: 'last_admin' };
    // An admin from before members existed may have no member row yet.
    await addRoomMember({ roomId, accountId, addedVia: 'seed' }, client);
    await client.query(`DELETE FROM project_admins WHERE account_id = $2
      AND (project_id = $1 OR project_id IN (${FOCUS_ROOMS_OF}))`, [roomId, accountId]);
    return { kind: 'changed' };
  });
}

/** An agent session the removed account owns in the room or one of its focus rooms. */
export interface RemovedMemberAgentSession {
  session_id: string;
  room_id: string;
  agent_key: string;
  agent_instance_id: string | null;
}

export type RoomMemberRemoval =
  | { kind: 'removed'; login: string | null; agent_sessions: RemovedMemberAgentSession[] }
  | { kind: 'forbidden' }
  | { kind: 'not_member' }
  | { kind: 'last_admin' };

/**
 * Removes the account from the room: its member row, its admin rows on the
 * room and on the focus rooms under it, and its pending request. A removal
 * record keeps every seed from adding the account back. `actorAccountId` is
 * the account itself (it leaves) or an admin, checked again under the lock.
 *
 * Returns the account's own live agent sessions there, for the caller to
 * end. An agent the account lent to someone else (a rental or an agent ask)
 * is that person's, so it is not listed; agents lent to the account end with
 * their ask (liveAgentAskIdsForAsker).
 */
export async function removeRoomMember(roomId: string, accountId: string, actorAccountId: string): Promise<RoomMemberRemoval> {
  return inTransaction(async (client) => {
    await lockRoomAdmins(client, roomId);
    if (actorAccountId !== accountId && await getRoomMemberRole(roomId, actorAccountId, client) !== 'admin') {
      return { kind: 'forbidden' };
    }
    const current = await getRoomMemberRole(roomId, accountId, client);
    if (!current) return { kind: 'not_member' };
    if (current === 'admin' && await countRoomAdmins(client, roomId) <= 1) return { kind: 'last_admin' };
    await client.query('DELETE FROM room_members WHERE room_id = $1 AND account_id = $2', [roomId, accountId]);
    await client.query(`DELETE FROM project_admins WHERE account_id = $2
      AND (project_id = $1 OR project_id IN (${FOCUS_ROOMS_OF}))`, [roomId, accountId]);
    await client.query(`INSERT INTO room_member_removals (room_id, account_id, removed_by) VALUES ($1, $2, $3)
      ON CONFLICT (room_id, account_id) DO UPDATE SET removed_by = EXCLUDED.removed_by, removed_at = now()`,
    [roomId, accountId, actorAccountId]);
    await client.query(`UPDATE room_join_requests SET state = 'cancelled', decided_at = now()
      WHERE room_id = $1 AND account_id = $2 AND state = 'pending'`, [roomId, accountId]);
    await retireJoinRequestPushesForAccount(client, roomId, accountId);
    // The person's ticket filters stop bringing their tracker's tickets into
    // the room as cards. They stay, switched off, for an admin to see.
    await client.query(`UPDATE room_tracker_filters SET enabled = false
      WHERE created_by_account_id = $2 AND enabled
        AND (room_id = $1 OR room_id IN (${FOCUS_ROOMS_OF}))`, [roomId, accountId]);
    const sessions = await client.query<RemovedMemberAgentSession>(`SELECT session.session_id, session.room_id,
        session.agent_key, session.agent_instance_id
      FROM room_agent_sessions AS session
      LEFT JOIN supervisor_host_grants AS grant_row ON grant_row.grant_id = session.supervisor_grant_id
      WHERE session.ended_at IS NULL
        AND (session.room_id = $1 OR session.room_id IN (${FOCUS_ROOMS_OF}))
        AND session.owner_account_id = $2
        AND grant_row.rental_session_id IS NULL
        AND COALESCE(grant_row.scope_key, '') NOT LIKE 'ask:%'
        AND NOT EXISTS (SELECT 1 FROM rental_sessions WHERE room_agent_session_id = session.session_id)
        AND NOT EXISTS (SELECT 1 FROM agent_asks WHERE room_agent_session_id = session.session_id)
      ORDER BY session.created_at`, [roomId, accountId]);
    const account = await client.query<{ login: string }>('SELECT login FROM accounts WHERE id = $1', [accountId]);
    return { kind: 'removed', login: account.rows[0]?.login ?? null, agent_sessions: sessions.rows };
  });
}

/** Live agent asks the account made in the room or its focus rooms: their agents work for it. */
export async function liveAgentAskIdsForAsker(roomId: string, accountId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM agent_asks
    WHERE asker_account_id = $2
      AND state IN ('open', 'claimed', 'on_hold', 'active', 'paused')
      AND (room_id = $1 OR room_id IN (${FOCUS_ROOMS_OF}))
    ORDER BY created_at`, [roomId, accountId]);
  return result.rows.map((row) => row.id);
}

const JOIN_REQUEST_COLUMNS = 'id, room_id, account_id, state, created_at, decided_at';

export async function getLatestRoomJoinRequest(
  roomId: string,
  accountId: string,
  client: Queryable = pool,
): Promise<RoomJoinRequestSummary | null> {
  const row = await latestJoinRequestRow(client, roomId, accountId);
  return row ? toJoinRequestSummary(row) : null;
}

async function latestJoinRequestRow(client: Queryable, roomId: string, accountId: string): Promise<StoredJoinRequest | null> {
  const result = await client.query<StoredJoinRequest>(`SELECT ${JOIN_REQUEST_COLUMNS}
    FROM room_join_requests WHERE room_id = $1 AND account_id = $2
    ORDER BY created_at DESC, id DESC LIMIT 1`, [roomId, accountId]);
  return result.rows[0] ?? null;
}

export type RoomJoinRequestCreation =
  | { kind: 'created'; join_request: RoomJoinRequestSummary }
  | { kind: 'pending'; join_request: RoomJoinRequestSummary }
  | { kind: 'cooldown'; join_request: RoomJoinRequestSummary }
  | { kind: 'member' };

export async function createRoomJoinRequest(roomId: string, accountId: string): Promise<RoomJoinRequestCreation> {
  return inTransaction(async (client) => {
    await lockJoinRequests(client, roomId, accountId);
    if (await getRoomMemberRole(roomId, accountId, client)) return { kind: 'member' };
    const latest = await latestJoinRequestRow(client, roomId, accountId);
    if (latest?.state === 'pending') return { kind: 'pending', join_request: toJoinRequestSummary(latest) };
    const summary = latest ? toJoinRequestSummary(latest) : null;
    if (summary?.retry_after && Date.parse(summary.retry_after) > Date.now()) {
      return { kind: 'cooldown', join_request: summary };
    }
    const id = `rjr_${crypto.randomUUID().replace(/-/g, '')}`;
    const inserted = await client.query<StoredJoinRequest>(`INSERT INTO room_join_requests (id, room_id, account_id)
      VALUES ($1, $2, $3) RETURNING ${JOIN_REQUEST_COLUMNS}`, [id, roomId, accountId]);
    // The admins' desktops learn of it even while the app is quit.
    await enqueueJoinRequestPushes(client, { roomId, requestId: id, requesterAccountId: accountId });
    return { kind: 'created', join_request: toJoinRequestSummary(inserted.rows[0]!) };
  });
}

const ADMIN_JOIN_REQUEST_COLUMNS = `request.id, request.room_id, request.account_id, request.state,
    request.created_at, request.decided_at,
    account.login, account.display_name, account.avatar_url,
    decider.login AS decided_by_login`;
const ADMIN_JOIN_REQUEST_FROM = `FROM room_join_requests AS request
  INNER JOIN accounts AS account ON account.id = request.account_id
  LEFT JOIN accounts AS decider ON decider.id = request.decided_by`;
const ADMIN_JOIN_REQUEST_SELECT = `SELECT ${ADMIN_JOIN_REQUEST_COLUMNS} ${ADMIN_JOIN_REQUEST_FROM}`;

export async function listRoomJoinRequests(roomId: string, state: 'pending' | 'all'): Promise<RoomJoinRequest[]> {
  const result = await pool.query<StoredAdminJoinRequest>(`${ADMIN_JOIN_REQUEST_SELECT}
    WHERE request.room_id = $1 AND ($2::text = 'all' OR request.state = 'pending')
    ORDER BY CASE WHEN request.state = 'pending' THEN 0 ELSE 1 END, request.created_at, request.id
    LIMIT 500`, [roomId, state]);
  return result.rows.map(toAdminJoinRequest);
}

export async function getRoomJoinRequest(roomId: string, requestId: string): Promise<RoomJoinRequest | null> {
  const result = await pool.query<StoredAdminJoinRequest>(`${ADMIN_JOIN_REQUEST_SELECT}
    WHERE request.room_id = $1 AND request.id = $2`, [roomId, requestId]);
  return result.rows[0] ? toAdminJoinRequest(result.rows[0]) : null;
}

/** Pending requests in every room where the account is an admin, oldest first. */
export async function listPendingJoinRequestsForAdmin(accountId: string): Promise<Array<RoomJoinRequest & { room_display_name: string }>> {
  const result = await pool.query<StoredAdminJoinRequest & { room_display_name: string }>(`SELECT
      ${ADMIN_JOIN_REQUEST_COLUMNS}, room.display_name AS room_display_name
    ${ADMIN_JOIN_REQUEST_FROM}
    INNER JOIN project_admins AS admin ON admin.project_id = request.room_id AND admin.account_id = $1
    INNER JOIN rooms AS room ON room.id = request.room_id
    WHERE request.state = 'pending'
    ORDER BY request.created_at, request.id
    LIMIT 500`, [accountId]);
  return result.rows.map((row) => ({ ...toAdminJoinRequest(row), room_display_name: row.room_display_name }));
}

export type RoomJoinRequestDecision =
  | { kind: 'decided'; join_request: RoomJoinRequest }
  | { kind: 'not_pending'; join_request: RoomJoinRequest }
  | { kind: 'forbidden' }
  | { kind: 'not_found' };

/**
 * Approves or declines a pending request. The same decision again answers as
 * done; another decision on a decided request is refused. An approval adds
 * the person as a member in the same transaction and clears any removal
 * record. The decider must be an admin, checked again under the admin lock,
 * which also orders this change after any removal in the same room.
 */
export async function decideRoomJoinRequest(input: {
  roomId: string;
  requestId: string;
  decision: 'approved' | 'declined';
  deciderAccountId: string;
}): Promise<RoomJoinRequestDecision> {
  const outcome = await inTransaction(async (client) => {
    await lockRoomAdmins(client, input.roomId);
    if (await getRoomMemberRole(input.roomId, input.deciderAccountId, client) !== 'admin') return 'forbidden' as const;
    const locked = await client.query<StoredJoinRequest>(`SELECT ${JOIN_REQUEST_COLUMNS}
      FROM room_join_requests WHERE room_id = $1 AND id = $2 FOR UPDATE`, [input.roomId, input.requestId]);
    const row = locked.rows[0];
    if (!row) return 'not_found' as const;
    if (row.state !== 'pending') return row.state === input.decision ? 'decided' as const : 'not_pending' as const;
    await client.query(`UPDATE room_join_requests SET state = $3, decided_by = $4, decided_at = now()
      WHERE room_id = $1 AND id = $2`, [input.roomId, input.requestId, input.decision, input.deciderAccountId]);
    await retireJoinRequestPushes(client, input.requestId, `Join request ${input.decision}`);
    if (input.decision === 'approved') {
      await addRoomMember({
        roomId: input.roomId,
        accountId: row.account_id,
        addedVia: 'approved_request',
        addedBy: input.deciderAccountId,
      }, client);
      await client.query('DELETE FROM room_member_removals WHERE room_id = $1 AND account_id = $2',
        [input.roomId, row.account_id]);
    }
    return 'decided' as const;
  });
  if (outcome === 'not_found' || outcome === 'forbidden') return { kind: outcome };
  const joinRequest = await getRoomJoinRequest(input.roomId, input.requestId);
  if (!joinRequest) return { kind: 'not_found' };
  return { kind: outcome, join_request: joinRequest };
}

export type RoomJoinRequestCancellation =
  | { kind: 'cancelled'; join_request: RoomJoinRequestSummary }
  | { kind: 'not_pending'; join_request: RoomJoinRequestSummary }
  | { kind: 'not_found' };

export async function cancelRoomJoinRequest(roomId: string, requestId: string, accountId: string): Promise<RoomJoinRequestCancellation> {
  return inTransaction(async (client) => {
    const locked = await client.query<StoredJoinRequest>(`SELECT ${JOIN_REQUEST_COLUMNS}
      FROM room_join_requests WHERE room_id = $1 AND id = $2 AND account_id = $3 FOR UPDATE`, [roomId, requestId, accountId]);
    const row = locked.rows[0];
    if (!row) return { kind: 'not_found' };
    if (row.state === 'cancelled') return { kind: 'cancelled', join_request: toJoinRequestSummary(row) };
    if (row.state !== 'pending') return { kind: 'not_pending', join_request: toJoinRequestSummary(row) };
    const updated = await client.query<StoredJoinRequest>(`UPDATE room_join_requests SET state = 'cancelled', decided_at = now()
      WHERE room_id = $1 AND id = $2 RETURNING ${JOIN_REQUEST_COLUMNS}`, [roomId, requestId]);
    await retireJoinRequestPushes(client, requestId, 'Join request cancelled');
    return { kind: 'cancelled', join_request: toJoinRequestSummary(updated.rows[0]!) };
  });
}
