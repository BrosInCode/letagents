import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { accounts, rooms } from './core.js';
import { desktop_push_devices } from './desktop-push.js';

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

/**
 * One desktop push per admin device for a request to join a members-only
 * room. The worker sends it like a message push; a decided or cancelled
 * request retires its queued rows, and delivered or dead rows lose their
 * preview columns (the room's name and the requester's name).
 */
export const desktop_join_request_pushes = pgTable('desktop_join_request_pushes', {
  id: text('id').primaryKey(),
  join_request_id: text('join_request_id').notNull().references(() => room_join_requests.id, { onDelete: 'cascade' }),
  device_id: text('device_id').notNull().references(() => desktop_push_devices.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  room_id: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  room_display_name: text('room_display_name').notNull().default(''),
  sender: text('sender').notNull().default(''),
  body: text('body').notNull().default(''),
  state: text('state').notNull().default('queued'),
  attempt_count: integer('attempt_count').notNull().default(0),
  next_attempt_at: timestamp('next_attempt_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
  claimed_at: timestamp('claimed_at', { mode: 'string', withTimezone: true }),
  claimed_by: text('claimed_by'),
  apns_id: text('apns_id'),
  last_status: integer('last_status'),
  last_error: text('last_error'),
  delivered_at: timestamp('delivered_at', { mode: 'string', withTimezone: true }),
  created_at: timestamp('created_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { mode: 'string', withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  device_request_uq: uniqueIndex('desktop_join_request_pushes_device_request_uq').on(table.device_id, table.join_request_id),
  ready_idx: index('desktop_join_request_pushes_ready_idx').on(table.state, table.next_attempt_at, table.created_at),
  request_idx: index('desktop_join_request_pushes_request_idx').on(table.join_request_id),
  state_check: check('desktop_join_request_pushes_state_check', sql`${table.state} IN ('queued', 'processing', 'retry', 'delivered', 'dead')`),
}));
