import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { accounts, rooms } from './core.js';

/**
 * The members of a top-level room that is not tied to a repository. A focus
 * room has no rows: it uses the members of its parent. A room admin
 * (`project_admins` on the room) is always a member too.
 */
export const room_members = pgTable('room_members', {
  room_id: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  account_id: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  added_via: text('added_via').notNull(),
  added_by: text('added_by').references(() => accounts.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ name: 'room_members_pk', columns: [table.room_id, table.account_id] }),
  account_idx: index('room_members_account_idx').on(table.account_id),
  added_via_check: check('room_members_added_via_check', sql`${table.added_via} IN ('creator', 'seed', 'approved_request')`),
}));

/**
 * A person an admin removed from a room, or who left it. A seed never adds
 * them back; only an approved join request does, and it clears this row.
 */
export const room_member_removals = pgTable('room_member_removals', {
  room_id: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  account_id: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  removed_by: text('removed_by').references(() => accounts.id, { onDelete: 'set null' }),
  removed_at: timestamp('removed_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ name: 'room_member_removals_pk', columns: [table.room_id, table.account_id] }),
}));

export const room_join_requests = pgTable('room_join_requests', {
  id: text('id').primaryKey(),
  room_id: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  account_id: text('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  state: text('state').notNull().default('pending'),
  created_at: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
  decided_by: text('decided_by').references(() => accounts.id, { onDelete: 'set null' }),
  decided_at: timestamp('decided_at', { mode: 'string', withTimezone: true }),
}, (table) => ({
  one_pending_idx: uniqueIndex('room_join_requests_one_pending_idx')
    .on(table.room_id, table.account_id)
    .where(sql`${table.state} = 'pending'`),
  room_state_idx: index('room_join_requests_room_state_idx').on(table.room_id, table.state, table.created_at),
  account_idx: index('room_join_requests_account_idx').on(table.account_id, table.room_id, table.created_at),
  state_check: check('room_join_requests_state_check', sql`${table.state} IN ('pending', 'approved', 'declined', 'cancelled')`),
}));
