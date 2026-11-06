import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { BoardPlanningDocument } from "../../../../shared/board-planning.mjs";
import { rooms } from "./core.js";

/** Planning is additive to task execution, never a second source of lifecycle authority. */
export const room_board_planning = pgTable("room_board_planning", {
  room_id: text("room_id").primaryKey().references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
  revision: integer("revision").notNull().default(0),
  document: jsonb("document").$type<BoardPlanningDocument>().notNull(),
  updated_by: text("updated_by").notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, table => ({ revision_check: check("room_board_planning_revision_check", sql`${table.revision} >= 0`) }));
