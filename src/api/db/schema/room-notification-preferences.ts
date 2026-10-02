import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { accounts, rooms } from './core.js';

export const account_room_notification_preferences = pgTable('account_room_notification_preferences', {
  account_id: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  room_id: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  level: text('level').notNull().default('all'),
  snoozed_until: timestamp('snoozed_until', { mode: 'string', withTimezone: true }),
}, (table) => ({
  pk: primaryKey({ name: 'account_room_notification_preferences_pk', columns: [table.account_id, table.room_id] }),
  level_check: check('account_room_notification_preferences_level_check', sql`${table.level} IN ('all', 'mentions', 'muted')`),
}));
