import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { LiveDemoAnchor, LiveDemoPoint } from '../../../../shared/live-demo.mjs';
import { accounts } from './core.js';
import { message_attachments } from './messages.js';

/**
 * Saved strokes and pins drawn over an HTML demo in a room message. A demo is
 * one attachment of one message, so its marks go when the message goes. A
 * removed mark is deleted (no history). The author's name and colour are read
 * from the account, so a rename shows on old marks too.
 */
export const demo_marks = pgTable('demo_marks', {
  id: text('id').primaryKey(),
  room_id: text('room_id').notNull(),
  message_number: integer('message_number').notNull(),
  attachment_number: integer('attachment_number').notNull(),
  account_id: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  kind: text('kind').notNull(),
  points: jsonb('points').$type<LiveDemoPoint[]>(),
  pin_at: jsonb('pin_at').$type<LiveDemoPoint>(),
  pin_text: text('pin_text'),
  anchor: jsonb('anchor').$type<LiveDemoAnchor>(),
  created_at: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  attachment_fk: foreignKey({
    name: 'demo_marks_attachment_fk',
    columns: [table.room_id, table.message_number, table.attachment_number],
    foreignColumns: [message_attachments.room_id, message_attachments.message_number, message_attachments.attachment_number],
  }).onDelete('cascade').onUpdate('cascade'),
  demo_idx: index('demo_marks_demo_idx').on(table.room_id, table.message_number, table.attachment_number, table.created_at, table.id),
  account_idx: index('demo_marks_account_idx').on(table.account_id),
  kind_check: check('demo_marks_kind_check', sql`(${table.kind} = 'stroke' AND ${table.points} IS NOT NULL AND ${table.pin_at} IS NULL AND ${table.pin_text} IS NULL)
    OR (${table.kind} = 'pin' AND ${table.points} IS NULL AND ${table.pin_at} IS NOT NULL AND ${table.pin_text} IS NOT NULL)`),
}));
