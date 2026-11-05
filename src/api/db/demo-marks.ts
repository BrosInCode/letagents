import crypto from 'node:crypto';

import {
  LIVE_DEMO,
  liveDemoColor,
  liveDemoKey,
  parseLiveDemoKey,
  type DemoMark,
  type DemoMarkInput,
  type LiveDemoAnchor,
  type LiveDemoPoint,
} from '../../../shared/live-demo.mjs';
import { pool } from './client.js';
import { formatAttachmentId, formatMessageId, parseScopedId } from './utils.js';

interface StoredDemoMark {
  id: string;
  message_number: number;
  attachment_number: number;
  account_id: string;
  kind: 'stroke' | 'pin';
  points: LiveDemoPoint[] | null;
  pin_at: LiveDemoPoint | null;
  pin_text: string | null;
  anchor: LiveDemoAnchor | null;
  created_at: Date;
  login: string;
  display_name: string | null;
}

export interface DemoRef {
  messageNumber: number;
  attachmentNumber: number;
}

/** Points over all marks of one demo (a pin counts as one), so its marks stay small to load. */
export const DEMO_MARK_POINTS_PER_DEMO = 100_000;

export type CreateDemoMarkResult =
  | { kind: 'created'; mark: DemoMark }
  | { kind: 'demo_not_found' }
  /** `marks`: 500 marks already; `points`: this mark would pass the points budget. */
  | { kind: 'full'; reason: 'marks' | 'points' };

/** The message and attachment a demo key names, or null for a key in another shape. */
export function demoRef(demo: string): DemoRef | null {
  const key = parseLiveDemoKey(demo);
  const messageNumber = key ? parseScopedId(key.messageId, 'msg') : null;
  const attachmentNumber = key ? parseScopedId(key.attachmentId, 'att') : null;
  return messageNumber && attachmentNumber ? { messageNumber, attachmentNumber } : null;
}

// A tenth of a demo pixel is finer than any screen shows, and keeps a long stroke small.
const round = (value: number) => Math.round(value * 10) / 10;
const roundPoint = ([x, y]: LiveDemoPoint): LiveDemoPoint => [round(x), round(y)];

const MARK_COLUMNS = `m.id, m.message_number, m.attachment_number, m.account_id, m.kind, m.points, m.pin_at, m.pin_text,
  m.anchor, m.created_at, a.login, a.display_name`;

function toDemoMark(row: StoredDemoMark): DemoMark {
  const base = {
    id: row.id,
    demo: liveDemoKey(formatMessageId(row.message_number), formatAttachmentId(row.attachment_number))!,
    author: {
      accountId: row.account_id,
      name: (row.display_name?.trim() || row.login).slice(0, LIVE_DEMO.name),
      color: liveDemoColor(row.account_id),
    },
    anchor: row.anchor ?? null,
    createdAt: row.created_at.toISOString(),
  };
  return row.kind === 'stroke'
    ? { ...base, kind: 'stroke', points: row.points ?? [] }
    : { ...base, kind: 'pin', at: row.pin_at!, text: row.pin_text ?? '' };
}

/** The saved marks of one demo in one room, oldest first. */
export async function listDemoMarks(roomId: string, demo: string): Promise<DemoMark[]> {
  const ref = demoRef(demo);
  if (!ref) return [];
  const result = await pool.query<StoredDemoMark>(`SELECT ${MARK_COLUMNS}
    FROM demo_marks m JOIN accounts a ON a.id = m.account_id
    WHERE m.room_id = $1 AND m.message_number = $2 AND m.attachment_number = $3
    ORDER BY m.created_at, m.id
    LIMIT ${LIVE_DEMO.marksPerDemo}`, [roomId, ref.messageNumber, ref.attachmentNumber]);
  return result.rows.map(toDemoMark);
}

/**
 * Saves a mark if the demo is an attachment of a message in this room and has
 * room for one more (marks and points). Locking the attachment row makes
 * concurrent saves count one at a time, so the limits hold.
 */
export async function createDemoMark(roomId: string, accountId: string, input: DemoMarkInput): Promise<CreateDemoMarkResult> {
  const ref = demoRef(input.demo);
  if (!ref) return { kind: 'demo_not_found' };
  const params = [roomId, ref.messageNumber, ref.attachmentNumber];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const demo = await client.query(`SELECT 1 FROM message_attachments
      WHERE room_id = $1 AND message_number = $2 AND attachment_number = $3 FOR NO KEY UPDATE`, params);
    if (!demo.rowCount) {
      await client.query('ROLLBACK');
      return { kind: 'demo_not_found' };
    }
    const pointCount = input.kind === 'stroke' ? input.points.length : 1;
    const used = await client.query<{ marks: number; points: number }>(`SELECT COUNT(*)::int AS marks,
        COALESCE(SUM(point_count), 0)::int AS points
      FROM demo_marks WHERE room_id = $1 AND message_number = $2 AND attachment_number = $3`, params);
    const { marks = 0, points = 0 } = used.rows[0] ?? {};
    if (marks >= LIVE_DEMO.marksPerDemo || points + pointCount > DEMO_MARK_POINTS_PER_DEMO) {
      await client.query('ROLLBACK');
      return { kind: 'full', reason: marks >= LIVE_DEMO.marksPerDemo ? 'marks' : 'points' };
    }
    const inserted = await client.query<StoredDemoMark>(`WITH m AS (
        INSERT INTO demo_marks (id, room_id, message_number, attachment_number, account_id, kind, points, pin_at, pin_text, anchor, point_count)
        VALUES ($4, $1, $2, $3, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11)
        RETURNING *
      )
      SELECT ${MARK_COLUMNS} FROM m JOIN accounts a ON a.id = m.account_id`, [
      ...params,
      `dmk_${crypto.randomBytes(16).toString('base64url')}`,
      accountId,
      input.kind,
      input.kind === 'stroke' ? JSON.stringify(input.points.map(roundPoint)) : null,
      input.kind === 'pin' ? JSON.stringify(roundPoint(input.at)) : null,
      input.kind === 'pin' ? input.text : null,
      input.anchor ? JSON.stringify(input.anchor) : null,
      pointCount,
    ]);
    await client.query('COMMIT');
    return { kind: 'created', mark: toDemoMark(inserted.rows[0]!) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Who made a mark in this room, and on which demo. */
export async function getDemoMarkOwner(roomId: string, markId: string): Promise<{ accountId: string; demo: string } | null> {
  const result = await pool.query<{ account_id: string; message_number: number; attachment_number: number }>(
    'SELECT account_id, message_number, attachment_number FROM demo_marks WHERE room_id = $1 AND id = $2',
    [roomId, markId],
  );
  const row = result.rows[0];
  return row
    ? { accountId: row.account_id, demo: liveDemoKey(formatMessageId(row.message_number), formatAttachmentId(row.attachment_number))! }
    : null;
}

/** Deletes a mark of this room; true when it was there. */
export async function deleteDemoMark(roomId: string, markId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM demo_marks WHERE room_id = $1 AND id = $2', [roomId, markId]);
  return (result.rowCount ?? 0) > 0;
}
