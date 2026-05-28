import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  rentalPatchGateStatusEnum,
  rentalPatchProposalSourceEnum,
} from "./enums.js";
import { rental_sessions } from "./sessions.js";

/**
 * Patch proposals and Signed Change Journal entries for Patch Gate.
 *
 * Each row is idempotent per (session_id, idempotency_key). For
 * `source=signed_change_journal`, `journal_entry` stores the accepted
 * tool-mediated edit that Patch Gate can later reconstruct into a diff.
 */
export const rental_patch_proposals = pgTable(
  "rental_patch_proposals",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    source: rentalPatchProposalSourceEnum("source").notNull(),
    diff_ref: text("diff_ref"),
    summary: text("summary"),
    gate_status: rentalPatchGateStatusEnum("gate_status")
      .notNull()
      .default("pending"),
    risk_score: integer("risk_score"),
    warnings: jsonb("warnings")
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default([]),
    check_results: jsonb("check_results")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    journal_entry: jsonb("journal_entry").$type<Record<string, unknown>>(),
    idempotency_key: text("idempotency_key").notNull(),
    request_hash: text("request_hash").notNull(),
    response_hash: text("response_hash").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_patch_proposals_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    index("rental_patch_proposals_session_id_idx").on(table.session_id),
    index("rental_patch_proposals_gate_status_idx").on(table.gate_status),
    uniqueIndex("rental_patch_proposals_session_idempotency_uq").on(
      table.session_id,
      table.idempotency_key,
    ),
  ],
);
