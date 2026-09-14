import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, text, index } from 'drizzle-orm/pg-core';
import { rooms } from './core.js';
import type { KnowledgeRecord } from '../../../../shared/room-knowledge.mjs';

export const room_knowledge = pgTable('room_knowledge', {
  room_id: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  id: text('id').notNull(), type: text('type').notNull(), version: integer('version').notNull(),
  value: jsonb('value').$type<KnowledgeRecord>().notNull(),
}, table => ({ pk: primaryKey({ columns: [table.room_id, table.id] }), room_type: index('room_knowledge_type_idx').on(table.room_id, table.type), valid_type: check('room_knowledge_type_check', sql`${table.type} IN ('memory', 'attention')`), valid_version: check('room_knowledge_version_check', sql`${table.version} > 0`) }));

export const room_knowledge_revisions = pgTable('room_knowledge_revisions', {
  room_id: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  id: text('id').notNull(), version: integer('version').notNull(),
  value: jsonb('value').$type<KnowledgeRecord>().notNull(),
}, table => ({ pk: primaryKey({ columns: [table.room_id, table.id, table.version] }), valid_version: check('room_knowledge_revisions_version_check', sql`${table.version} > 0`) }));
