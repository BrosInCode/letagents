import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { rooms } from "../core.js";
import {
  rentalActivitySourceEnum,
  rentalVisibilityEnum,
} from "./enums.js";
import { rental_sessions } from "./sessions.js";

export const rental_activity_events = pgTable(
  "rental_activity_events",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    room_id: text("room_id").notNull(),
    event_type: text("event_type").notNull(),
    source: rentalActivitySourceEnum("source").notNull(),
    verified: boolean("verified").notNull().default(false),
    visibility: rentalVisibilityEnum("visibility")
      .notNull()
      .default("rental_visible"),
    payload: jsonb("payload").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_activity_events_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    foreignKey({
      name: "rental_activity_events_room_fk",
      columns: [table.room_id],
      foreignColumns: [rooms.id as AnyPgColumn],
    }),
    index("rental_activity_events_session_id_idx").on(table.session_id),
    index("rental_activity_events_room_id_idx").on(table.room_id),
    index("rental_activity_events_event_type_idx").on(table.event_type),
  ],
);
