import type { PoolClient } from "pg";

import { pool } from "../db/client.js";

type Queryable = Pick<PoolClient, "query">;

/**
 * Queues one desktop push per enabled device of each admin of the room, in the
 * transaction that created the request. An admin who muted or snoozed the room
 * gets none, as for a message. The requester's own devices get none either.
 * The preview columns hold the room's name and the requester's name until the
 * worker delivers the row.
 */
export async function enqueueJoinRequestPushes(
  client: Queryable,
  input: { roomId: string; requestId: string; requesterAccountId: string },
): Promise<number> {
  const result = await client.query(`
    INSERT INTO desktop_join_request_pushes (
      id, join_request_id, device_id, room_id, room_display_name, sender, body,
      state, attempt_count, next_attempt_at, created_at, updated_at
    )
    SELECT
      CONCAT('lj_', REPLACE(device.id, '-', ''), '_', LEFT(MD5($2::text), 12)),
      $2,
      device.id,
      $1,
      room.display_name,
      COALESCE(NULLIF(TRIM(requester.display_name), ''), requester.login),
      '',
      'queued', 0, now(), now(), now()
    FROM project_admins AS admin
    INNER JOIN desktop_push_devices AS device
      ON device.account_id = admin.account_id AND device.enabled = TRUE
    INNER JOIN rooms AS room ON room.id = $1
    INNER JOIN accounts AS requester ON requester.id = $3
    LEFT JOIN account_room_notification_preferences AS preference
      ON preference.account_id = device.account_id AND preference.room_id = $1
    WHERE admin.project_id = $1
      AND device.account_id <> $3
      AND (preference.snoozed_until IS NULL OR preference.snoozed_until <= statement_timestamp())
      AND COALESCE(preference.level, 'all') <> 'muted'
    ON CONFLICT (device_id, join_request_id) DO NOTHING
  `, [input.roomId, input.requestId, input.requesterAccountId]);
  return result.rowCount ?? 0;
}

/**
 * A request that was answered or cancelled needs no alert any more: its queued
 * rows die with their preview blanked. A row the worker holds right now is
 * checked again before it is sent.
 */
export async function retireJoinRequestPushes(client: Queryable, requestId: string, reason: string): Promise<number> {
  const result = await client.query(`
    UPDATE desktop_join_request_pushes
    SET state = 'dead', room_display_name = '', sender = '', body = '',
        last_error = $2, claimed_at = NULL, claimed_by = NULL, updated_at = now()
    WHERE join_request_id = $1 AND state IN ('queued', 'retry')
  `, [requestId, reason.slice(0, 1000)]);
  return result.rowCount ?? 0;
}

/** Retires the queued pushes of every pending request of one account in a room (the person was removed). */
export async function retireJoinRequestPushesForAccount(client: Queryable, roomId: string, accountId: string): Promise<void> {
  await client.query(`
    UPDATE desktop_join_request_pushes AS push
    SET state = 'dead', room_display_name = '', sender = '', body = '',
        last_error = 'Join request cancelled', claimed_at = NULL, claimed_by = NULL, updated_at = now()
    FROM room_join_requests AS request
    WHERE push.join_request_id = request.id
      AND request.room_id = $1 AND request.account_id = $2
      AND push.state IN ('queued', 'retry')
  `, [roomId, accountId]);
}

export interface JoinRequestPushPreview {
  pending: boolean;
  /** The device's account is still an admin of the room. */
  admin: boolean;
  roomDisplayName: string;
  requester: string;
}

/**
 * What the worker checks right before it sends: the request still waits, and
 * the account still decides for the room. The names are read fresh too, so a
 * renamed room or person is shown by its current name.
 */
export async function loadJoinRequestPushPreview(requestId: string, accountId: string): Promise<JoinRequestPushPreview | null> {
  const result = await pool.query<{ state: string; admin: boolean; room_display_name: string; requester: string }>(`
    SELECT request.state,
      EXISTS (SELECT 1 FROM project_admins AS admin WHERE admin.project_id = request.room_id AND admin.account_id = $2) AS admin,
      room.display_name AS room_display_name,
      COALESCE(NULLIF(TRIM(requester.display_name), ''), requester.login) AS requester
    FROM room_join_requests AS request
    INNER JOIN rooms AS room ON room.id = request.room_id
    INNER JOIN accounts AS requester ON requester.id = request.account_id
    WHERE request.id = $1
  `, [requestId, accountId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    pending: row.state === "pending",
    admin: row.admin,
    roomDisplayName: row.room_display_name,
    requester: row.requester,
  };
}
