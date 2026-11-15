import crypto from 'node:crypto';

import {
  ROOM_INVITE_CODE_ALPHABET,
  ROOM_INVITE_TTL_MS,
  normalizeRoomInviteCode,
  type RoomInvite,
  type RoomInviteKind,
  type RoomInviteOutcome,
  type RoomInvitePlatform,
  type RoomInviteState,
} from '../../../shared/room-invites.mjs';
import type { RoomJoinRequestSummary } from '../../../shared/room-membership.mjs';
import { retireJoinRequestPushes } from '../notifications/join-request-pushes.js';
import { pool } from './client.js';
import { isUniqueViolationOf } from './pg-errors.js';
import {
  addRoomMember,
  createRoomJoinRequestInTransaction,
  getRoomMemberRole,
  inTransaction,
  lockRoomAdmins,
  type Queryable,
} from './room-members.js';
import { wakeJobQueue } from '../server/job-queue-wakes.js';

// Invites are made for, and used on, the ACCESS room: a members-only room
// that is not tied to a repository. The routes check that before they call
// in here; this module keeps the rows and the rules for using one.

/** A maker may hold this many open invites for one room at a time. */
export const MAX_OPEN_INVITES_PER_ROOM = 10;

/** A random code from the unambiguous alphabet: `XXXX-XXXX`. */
export function generateRoomInviteCode(): string {
  const letters = Array.from({ length: 8 }, () => ROOM_INVITE_CODE_ALPHABET[crypto.randomInt(ROOM_INVITE_CODE_ALPHABET.length)]);
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`;
}

/**
 * What the `code` column holds: the SHA-256 of the code. A copy of the table
 * (a backup, a log of a query) then names no code that still works. The code
 * is short, so this does not stand up to a search of every code; the seven
 * days and the single use are what limit a stolen row.
 */
export function hashRoomInviteCode(code: string): string {
  return crypto.createHash('sha256').update(`letagents-room-invite:v1:${code}`).digest('hex');
}

interface StoredInvite {
  id: string;
  room_id: string;
  room_display_name: string | null;
  origin_room_id: string | null;
  created_by: string | null;
  platform: RoomInvitePlatform;
  kind: RoomInviteKind;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  used_at: Date | null;
  used_by: string | null;
  used_by_login: string | null;
  outcome: RoomInviteOutcome | null;
  join_request_id: string | null;
}

const INVITE_SELECT = `SELECT invite.id, invite.room_id, room.display_name AS room_display_name, invite.origin_room_id,
    invite.created_by, invite.platform, invite.kind, invite.created_at, invite.expires_at, invite.revoked_at,
    invite.used_at, invite.used_by, user_account.login AS used_by_login, invite.outcome, invite.join_request_id
  FROM invites AS invite
  INNER JOIN rooms AS room ON room.id = invite.room_id
  LEFT JOIN accounts AS user_account ON user_account.id = invite.used_by`;

function stateOf(row: StoredInvite, now = Date.now()): RoomInviteState {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'cancelled';
  return row.expires_at.getTime() <= now ? 'expired' : 'open';
}

export function toRoomInvite(row: StoredInvite): RoomInvite {
  return {
    id: row.id,
    room_id: row.room_id,
    room_display_name: row.room_display_name ?? row.room_id,
    origin_room_id: row.origin_room_id,
    platform: row.platform,
    kind: row.kind,
    state: stateOf(row),
    outcome: row.outcome,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    used_at: row.used_at?.toISOString() ?? null,
    used_by_login: row.used_by_login,
  };
}

async function inviteRow(client: Queryable, inviteId: string): Promise<StoredInvite | null> {
  const result = await client.query<StoredInvite>(`${INVITE_SELECT} WHERE invite.id = $1`, [inviteId]);
  return result.rows[0] ?? null;
}

export async function getRoomInvite(inviteId: string): Promise<RoomInvite | null> {
  const row = await inviteRow(pool, inviteId);
  return row ? toRoomInvite(row) : null;
}

/** The maker of an invite; null for an unknown id. */
export async function getRoomInviteMaker(inviteId: string): Promise<string | null> {
  const result = await pool.query<{ created_by: string | null }>('SELECT created_by FROM invites WHERE id = $1 AND kind IS NOT NULL', [inviteId]);
  return result.rows[0]?.created_by ?? null;
}

export type RoomInviteCreation =
  | { kind: 'created'; invite: RoomInvite; code: string }
  | { kind: 'not_member' }
  | { kind: 'too_many' };

/**
 * Makes an invite for the access room. The maker's role now decides what it
 * does: an admin's lets the bot in, a member's asks the admins. The code is
 * returned this one time; only its hash is kept.
 */
export async function createRoomInvite(input: {
  roomId: string;
  makerAccountId: string;
  platform: RoomInvitePlatform;
  originRoomId: string | null;
}): Promise<RoomInviteCreation> {
  // Two random codes are not expected to meet; when they do, the unique index
  // refuses the second and a new code is drawn.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await createRoomInviteOnce(input);
    } catch (error) {
      if (attempt >= 3 || !isUniqueViolationOf(error, 'invites_code_unique')) throw error;
    }
  }
}

async function createRoomInviteOnce(input: {
  roomId: string;
  makerAccountId: string;
  platform: RoomInvitePlatform;
  originRoomId: string | null;
}): Promise<RoomInviteCreation> {
  return inTransaction(async (client) => {
    // One maker's invites in one room are made one at a time, so the cap holds.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`room_invite:${input.roomId}:${input.makerAccountId}`]);
    const role = await getRoomMemberRole(input.roomId, input.makerAccountId, client);
    if (!role) return { kind: 'not_member' as const };
    const open = await client.query<{ count: string }>(`SELECT count(*) AS count FROM invites
      WHERE room_id = $1 AND created_by = $2 AND kind IS NOT NULL
        AND revoked_at IS NULL AND used_at IS NULL AND expires_at > now()`, [input.roomId, input.makerAccountId]);
    if (Number(open.rows[0]?.count ?? 0) >= MAX_OPEN_INVITES_PER_ROOM) return { kind: 'too_many' as const };
    const id = `inv_${crypto.randomUUID().replace(/-/g, '')}`;
    const code = generateRoomInviteCode();
    await client.query(`INSERT INTO invites (id, room_id, code, created_by, created_at, kind, platform, origin_room_id, expires_at)
      VALUES ($1, $2, $3, $4, now(), $5, $6, $7, now() + ($8::bigint * interval '1 millisecond'))`, [
      id,
      input.roomId,
      hashRoomInviteCode(code),
      input.makerAccountId,
      role === 'admin' ? 'admit' : 'request',
      input.platform,
      input.originRoomId,
      ROOM_INVITE_TTL_MS,
    ]);
    const row = await inviteRow(client, id);
    return { kind: 'created' as const, invite: toRoomInvite(row!), code };
  });
}

/**
 * The maker's open invites that show in this room: those for it, and those
 * made from it for another room (a Git Room's room picker).
 */
export async function listOpenRoomInvites(makerAccountId: string, roomId: string): Promise<RoomInvite[]> {
  const result = await pool.query<StoredInvite>(`${INVITE_SELECT}
    WHERE invite.created_by = $1 AND (invite.room_id = $2 OR invite.origin_room_id = $2)
      AND invite.kind IS NOT NULL AND invite.revoked_at IS NULL AND invite.used_at IS NULL AND invite.expires_at > now()
    ORDER BY invite.created_at DESC, invite.id DESC
    LIMIT 50`, [makerAccountId, roomId]);
  return result.rows.map(toRoomInvite);
}

export type RoomInviteCancellation =
  | { kind: 'cancelled'; invite: RoomInvite }
  | { kind: 'not_open'; invite: RoomInvite }
  | { kind: 'not_found' };

/** The maker ends an invite before it is used. Cancelling it again answers as done. */
export async function cancelRoomInvite(inviteId: string, makerAccountId: string): Promise<RoomInviteCancellation> {
  return inTransaction(async (client) => {
    const locked = await client.query<{ created_by: string | null }>(`SELECT created_by FROM invites
      WHERE id = $1 AND kind IS NOT NULL FOR UPDATE`, [inviteId]);
    if (locked.rows[0]?.created_by !== makerAccountId) return { kind: 'not_found' };
    await client.query(`UPDATE invites SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL AND used_at IS NULL AND expires_at > now()`, [inviteId]);
    const invite = toRoomInvite((await inviteRow(client, inviteId))!);
    return invite.state === 'cancelled' ? { kind: 'cancelled', invite } : { kind: 'not_open', invite };
  });
}

/** The room an unused code is for, so the route can check the room before it uses the code. */
export async function findRoomInviteByCode(code: string): Promise<{ id: string; room_id: string } | null> {
  const normalized = normalizeRoomInviteCode(code);
  if (!normalized) return null;
  const result = await pool.query<{ id: string; room_id: string }>(`SELECT id, room_id FROM invites
    WHERE code = $1 AND kind IS NOT NULL`, [hashRoomInviteCode(normalized)]);
  return result.rows[0] ?? null;
}

export type RoomInviteRedemption =
  /**
   * The account is a member now (or was already); `joined` when this use
   * added it. `approved_request_id`: the account's own pending request to
   * join, which this admission answered.
   */
  | {
    kind: 'admitted';
    invite: RoomInvite;
    maker_login: string | null;
    joined: boolean;
    repeated: boolean;
    approved_request_id: string | null;
  }
  /** A member's invite asked the admins; `created` when this use filed a new request. */
  | { kind: 'requested'; invite: RoomInvite; join_request: RoomJoinRequestSummary; created: boolean; repeated: boolean }
  | { kind: 'cooldown'; join_request: RoomJoinRequestSummary }
  | { kind: 'not_found' }
  | { kind: 'used' }
  | { kind: 'cancelled' }
  | { kind: 'expired' }
  /** The maker is no longer in the room, so the invite speaks for nobody. */
  | { kind: 'maker_left' }
  /** The room is tied to a repository now; its GitHub roles decide who is in. */
  | { kind: 'repo_room' };

async function makerLogin(client: Queryable, accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  const result = await client.query<{ login: string }>('SELECT login FROM accounts WHERE id = $1', [accountId]);
  return result.rows[0]?.login ?? null;
}

/**
 * Uses an invite for `accountId`. One transaction: the invite row is locked
 * first, then the room's admins (the order of every admin change), so a code
 * is used once, by one account, even when two bots race.
 *
 * An admin's invite lets the account in while its maker is still an admin; a
 * member's invite (or an admin's whose maker stepped down) files a request to
 * join instead. Using a code again from the account that used it answers what
 * it did, so a bot that retries after a lost answer is not refused.
 */
export async function redeemRoomInvite(inviteId: string, accountId: string): Promise<RoomInviteRedemption> {
  let wakePushes = false;
  const outcome = await inTransaction(async (client): Promise<RoomInviteRedemption> => {
    const locked = await client.query('SELECT id FROM invites WHERE id = $1 AND kind IS NOT NULL FOR UPDATE', [inviteId]);
    if (!locked.rows[0]) return { kind: 'not_found' };
    const row = (await inviteRow(client, inviteId))!;
    const state = stateOf(row);
    if (state === 'used') {
      if (row.used_by !== accountId) return { kind: 'used' };
      const invite = toRoomInvite(row);
      if (row.outcome === 'requested') {
        const request = row.join_request_id
          ? (await client.query<{ id: string; state: RoomJoinRequestSummary['state']; created_at: Date; decided_at: Date | null }>(
            'SELECT id, state, created_at, decided_at FROM room_join_requests WHERE id = $1', [row.join_request_id])).rows[0]
          : undefined;
        if (!request) return { kind: 'used' };
        return {
          kind: 'requested',
          invite,
          join_request: {
            id: request.id,
            state: request.state,
            created_at: request.created_at.toISOString(),
            decided_at: request.decided_at?.toISOString() ?? null,
            retry_after: null,
          },
          created: false,
          repeated: true,
        };
      }
      // Answered again only while the account is still in the room: an admin
      // who removed it since is not overruled by an old code.
      if (!(await getRoomMemberRole(row.room_id, accountId, client))) return { kind: 'used' };
      return {
        kind: 'admitted',
        invite,
        maker_login: await makerLogin(client, row.created_by),
        joined: false,
        repeated: true,
        approved_request_id: null,
      };
    }
    if (state === 'cancelled') return { kind: 'cancelled' };
    if (state === 'expired') return { kind: 'expired' };

    await lockRoomAdmins(client, row.room_id);
    // The route checked the room's repository before; a binding made since is
    // caught here, under the lock. Stricter than the access rule on purpose:
    // any binding refuses.
    const repo = await client.query<{ repo: boolean }>(`SELECT room.origin = 'repo'
        OR EXISTS (SELECT 1 FROM room_git_bindings WHERE room_id = room.id) AS repo
      FROM rooms AS room WHERE room.id = $1`, [row.room_id]);
    if (repo.rows[0]?.repo) return { kind: 'repo_room' };
    const makerRole = row.created_by ? await getRoomMemberRole(row.room_id, row.created_by, client) : null;
    if (!makerRole) return { kind: 'maker_left' };

    if (row.kind === 'admit' && makerRole === 'admin') {
      const joined = !(await getRoomMemberRole(row.room_id, accountId, client));
      if (joined) {
        await addRoomMember({ roomId: row.room_id, accountId, addedVia: 'invite', addedBy: row.created_by }, client);
        await client.query('DELETE FROM room_member_removals WHERE room_id = $1 AND account_id = $2', [row.room_id, accountId]);
      }
      // A request to join that the account sent before is answered by this
      // admission, so it does not wait in the admins' Requests.
      const answered = await client.query<{ id: string }>(`UPDATE room_join_requests
        SET state = 'approved', decided_by = $3, decided_at = now()
        WHERE room_id = $1 AND account_id = $2 AND state = 'pending' RETURNING id`, [row.room_id, accountId, row.created_by]);
      const approvedRequestId = answered.rows[0]?.id ?? null;
      if (approvedRequestId) await retireJoinRequestPushes(client, approvedRequestId, 'Join request approved by an invite');
      await client.query(`UPDATE invites SET used_at = now(), used_by = $2, outcome = 'admitted' WHERE id = $1`, [inviteId, accountId]);
      return {
        kind: 'admitted',
        invite: toRoomInvite((await inviteRow(client, inviteId))!),
        maker_login: await makerLogin(client, row.created_by),
        joined,
        repeated: false,
        approved_request_id: approvedRequestId,
      };
    }

    const creation = await createRoomJoinRequestInTransaction(client, row.room_id, accountId);
    if (creation.kind === 'cooldown') return { kind: 'cooldown', join_request: creation.join_request };
    if (creation.kind === 'member') {
      // Already in the room: nothing to ask for, and the invite has done its job.
      await client.query(`UPDATE invites SET used_at = now(), used_by = $2, outcome = 'admitted' WHERE id = $1`, [inviteId, accountId]);
      return {
        kind: 'admitted',
        invite: toRoomInvite((await inviteRow(client, inviteId))!),
        maker_login: await makerLogin(client, row.created_by),
        joined: false,
        repeated: false,
        approved_request_id: null,
      };
    }
    wakePushes = creation.kind === 'created';
    await client.query(`UPDATE invites SET used_at = now(), used_by = $2, outcome = 'requested', join_request_id = $3 WHERE id = $1`,
      [inviteId, accountId, creation.join_request.id]);
    return {
      kind: 'requested',
      invite: toRoomInvite((await inviteRow(client, inviteId))!),
      join_request: creation.join_request,
      created: creation.kind === 'created',
      repeated: false,
    };
  });
  // The admins' pushes for a new request are due now.
  if (wakePushes) wakeJobQueue('desktop_push');
  return outcome;
}
