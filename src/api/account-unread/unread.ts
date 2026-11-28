/**
 * Per-room unread counts for one account, from the read state the account
 * already writes (`PUT /rooms/:room/messages/read`, table
 * `message_human_read_ranges`).
 *
 * 1. A room's read point is the highest message number any of the account's
 *    read ranges covers in that room, from any device or the web.
 * 2. A message after the read point counts when a person can see it in the
 *    room's history: not a blank automatic prompt, not an agent's `[status]`
 *    post (the room view hides both), not a message hidden from
 *    the room (rental visibility), and not the account's own message.
 * 3. GitHub event messages are counted apart (`github_unread_count`): a
 *    client shows them only where its person chose to see GitHub events in
 *    chat. Check runs that ended `success`, `skipped` or `neutral` never count,
 *    as the desktop has always done.
 * 4. `mention_unread_count` is the part of `unread_count` that mentions the
 *    account (`@<login>`, the rule of `mentionsPerson`, case insensitive), from
 *    the same scan. It is null exactly when `unread_count` is null.
 * 5. A room with no read point yet has no count (null): the client seeds it.
 *
 * Counts stop at UNREAD_COUNT_CAP; clients show "99+" long before that.
 */
import { PERSON_MENTION_END, PERSON_MENTION_START } from "../../../shared/room-notification-preferences.mjs";
import { pool } from "../db/client.js";

export const UNREAD_COUNT_CAP = 1000;

export interface AccountRoomUnread {
  room_id: string;
  /** The account's read point in the room, or null when it has none yet. */
  read_message_id: string | null;
  /** Messages after the read point, GitHub events left out; null without a read point. */
  unread_count: number | null;
  /** GitHub event messages after the read point that a person would see; null without a read point. */
  github_unread_count: number | null;
  /** The messages in `unread_count` that mention the account's login; null exactly when `unread_count` is null. */
  mention_unread_count: number | null;
}

/**
 * The desktop's rule for a check-run message that is noise: `Check "<name>"
 * [(<app>)] <conclusion> in <repo> [linked to task_N] [<url>]`, matched case
 * insensitively, with conclusion success, skipped or neutral. Only the
 * conclusion is captured.
 */
const CHECK_CONCLUSION_SQL = String.raw`lower(substring(
  regexp_replace(
    regexp_replace(regexp_replace(m.text, '^\s+|\s+$', '', 'g'), '\s(https?://\S+)$', '', 'i'),
    '^\s+|\s+$', '', 'g')
  from '(?i)^Check "[^"]+"(?: \([^)]+\))?\s+([a-z_]+)\s+in\s+\S+(?:\s+linked to\s+task_\d+)?$'))`;

// Mirrors the room view's hidden messages (apps/desktop/.../room-shell/messages.ts isHiddenChatMessage).
// COALESCE: a message with no source is not a GitHub event (NULL must not drop it from either count).
const GITHUB_SQL = `COALESCE(m.source = 'github' OR lower(m.sender) = 'github', FALSE)`;

/** The read point and both counts for each room, in one statement. */
export async function loadAccountRoomUnread(input: {
  accountId: string;
  /** Names the account posts under from the app (login, display name); a person's own message never counts. */
  ownSenderNames: readonly string[];
  /** The account's login, for the mention count. Without one no message mentions the account. */
  mentionLogin?: string | null;
  roomIds: readonly string[];
}): Promise<AccountRoomUnread[]> {
  const roomIds = [...new Set(input.roomIds.filter(Boolean))];
  if (roomIds.length === 0) return [];
  const ownNames = [...new Set(input.ownSenderNames.map((name) => name.trim().toLowerCase()).filter(Boolean))];
  const counted = `
    m.room_id = c.room_id AND m.number > c.read_number
    AND (m.agent_prompt_kind IS NULL OR m.agent_prompt_kind <> 'auto' OR BTRIM(m.text) <> '')
    -- The room view never shows an agent's [status] post (the desktop's isHiddenChatMessage).
    AND NOT COALESCE(m.source = 'agent' AND m.text ~* '^\\[status\\]', FALSE)
    AND (m.visibility IS NULL OR m.visibility = 'rental_visible')
    AND NOT COALESCE((m.publisher_account_id = $2 AND m.publisher_agent_key IS NULL)
             OR (m.source = 'browser' AND lower(btrim(m.sender)) = ANY($3::text[])), FALSE)`;
  // The pattern the push query uses (notifications/enqueue.ts); null matches nothing.
  const login = input.mentionLogin?.trim() ?? "";
  const mentionPattern = login
    ? PERSON_MENTION_START + login.replace(/[^A-Za-z0-9_-]/g, "\\$&") + PERSON_MENTION_END
    : null;
  const result = await pool.query<{
    room_id: string; read_number: number | null; unread: number | null; github_unread: number | null; mention_unread: number | null;
  }>(`
    WITH cursors AS (
      SELECT wanted.room_id,
             (SELECT max(r.last_message_sequence) FROM message_human_read_ranges r
               WHERE r.room_id = wanted.room_id AND r.account_id = $2) AS read_number
        FROM (SELECT DISTINCT unnest($1::text[]) AS room_id) AS wanted
    )
    SELECT c.room_id, c.read_number,
           CASE WHEN c.read_number IS NULL THEN NULL ELSE plain.unread END AS unread,
           CASE WHEN c.read_number IS NULL THEN NULL ELSE plain.mention_unread END AS mention_unread,
           CASE WHEN c.read_number IS NULL THEN NULL ELSE (
             SELECT count(*)::int FROM (
               SELECT 1 FROM messages m WHERE ${counted} AND ${GITHUB_SQL}
                 AND COALESCE(${CHECK_CONCLUSION_SQL}, '') NOT IN ('success', 'skipped', 'neutral')
               LIMIT $4
             ) AS rows) END AS github_unread
      FROM cursors c
      -- One scan gives both the count and the mention count (a mention is also a counted message).
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS unread, (count(*) FILTER (WHERE rows.mentioned))::int AS mention_unread FROM (
          SELECT COALESCE(m.text ~* $5::text, FALSE) AS mentioned
            FROM messages m WHERE ${counted} AND NOT ${GITHUB_SQL}
           -- Newest first: past the cap the newest messages decide the mention count (a mention is usually recent).
           ORDER BY m.number DESC LIMIT $4
        ) AS rows
      ) AS plain
  `, [roomIds, input.accountId, ownNames, UNREAD_COUNT_CAP, mentionPattern]);
  return result.rows.map((row) => ({
    room_id: row.room_id,
    read_message_id: row.read_number === null ? null : `msg_${row.read_number}`,
    unread_count: row.unread,
    github_unread_count: row.github_unread,
    mention_unread_count: row.mention_unread,
  }));
}
