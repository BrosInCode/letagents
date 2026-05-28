import {
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import {
  rentalMeterConfidenceEnum,
  rentalUsageMeterSourceEnum,
} from "./enums.js";
import { rental_sessions } from "./sessions.js";

/**
 * Per-session meter snapshots reported by desktop adapters and MCP tools.
 *
 * Spec §19.6. Each row is one observation: a NativeQuotaSnapshot, UsageDelta,
 * LRT delta, running total, and adapter confidence. Idempotency is per
 * (session_id, idempotency_key) so retries do not double-count usage.
 */
export const rental_usage_meters = pgTable(
  "rental_usage_meters",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    source: rentalUsageMeterSourceEnum("source").notNull(),
    native_unit: text("native_unit"),
    native_used: numeric("native_used"),
    native_remaining: numeric("native_remaining"),
    native_reset_at: timestamp("native_reset_at", { withTimezone: true }),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    cache_creation_tokens: integer("cache_creation_tokens").notNull().default(0),
    cache_read_tokens: integer("cache_read_tokens").notNull().default(0),
    reasoning_tokens: integer("reasoning_tokens").notNull().default(0),
    requests_used: integer("requests_used").notNull().default(0),
    credits_used: numeric("credits_used"),
    usd_used: numeric("usd_used"),
    lrt_delta: integer("lrt_delta").notNull().default(0),
    lrt_total: integer("lrt_total").notNull().default(0),
    confidence: rentalMeterConfidenceEnum("confidence").notNull(),
    adapter_payload: jsonb("adapter_payload"),
    tool_call_count: integer("tool_call_count").notNull().default(0),
    command_run_count: integer("command_run_count").notNull().default(0),
    files_exposed_count: integer("files_exposed_count").notNull().default(0),
    heartbeat_count: integer("heartbeat_count").notNull().default(0),
    last_heartbeat_at: timestamp("last_heartbeat_at", { withTimezone: true }),
    idempotency_key: text("idempotency_key").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_usage_meters_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    index("rental_usage_meters_session_id_idx").on(table.session_id),
    uniqueIndex("rental_usage_meters_session_idempotency_uq").on(
      table.session_id,
      table.idempotency_key,
    ),
    index("rental_usage_meters_session_created_idx").on(
      table.session_id,
      table.created_at,
    ),
  ],
);
