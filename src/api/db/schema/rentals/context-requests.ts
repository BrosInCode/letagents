import {
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { rental_sessions } from "./sessions.js";

/**
 * Context access requests.
 *
 * When a rented provider agent needs context outside the approved scope
 * (a file that was not materialized into its workspace), it files a
 * request here instead of getting silent file_not_found errors. The
 * renter reviews pending requests and approves or denies each one; an
 * approval materializes the requested file into the session workspace so
 * the existing context broker can serve (and ledger) it.
 */
export const rentalContextRequestTypeEnum = pgEnum(
  "rental_context_request_type",
  ["read_file", "search", "directory_listing", "command_output"],
);

export const rentalContextRequestStatusEnum = pgEnum(
  "rental_context_request_status",
  ["pending", "approved", "denied", "expired"],
);

export const rental_context_requests = pgTable(
  "rental_context_requests",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    path: text("path").notNull(),
    request_type: rentalContextRequestTypeEnum("request_type")
      .notNull()
      .default("read_file"),
    status: rentalContextRequestStatusEnum("status")
      .notNull()
      .default("pending"),
    reason: text("reason"),
    /** Account id of the requesting provider agent. */
    requested_by: text("requested_by"),
    /** Account id of the renter who decided the request. */
    decided_by: text("decided_by"),
    decided_at: timestamp("decided_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_context_requests_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    index("rental_context_requests_session_id_idx").on(table.session_id),
    index("rental_context_requests_status_idx").on(
      table.session_id,
      table.status,
    ),
    // At most one open request per (session, path) — repeat asks are
    // deduplicated onto the existing pending row.
    uniqueIndex("rental_context_requests_pending_path_uq")
      .on(table.session_id, table.path)
      .where(sql`${table.status} = 'pending'`),
  ],
);
