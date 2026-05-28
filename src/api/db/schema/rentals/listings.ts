import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import {
  rentalListingStatusEnum,
  rentalMeterConfidenceEnum,
  rentalNativeQuotaUnitEnum,
  rentalVerificationStatusEnum,
} from "./enums.js";

export const rental_listings = pgTable("rental_listings", {
  id: text("id").primaryKey(),
  provider_account_id: text("provider_account_id").notNull(),
  display_name: text("display_name").notNull(),
  status: rentalListingStatusEnum("status").notNull().default("setup_required"),
  verification_status: rentalVerificationStatusEnum("verification_status")
    .notNull()
    .default("experimental"),
  readiness_badges: jsonb("readiness_badges").$type<string[]>().default([]),
  ide_kind: text("ide_kind").notNull(),
  model_label: text("model_label"),
  quota_lane_id: text("quota_lane_id"),
  quota_lane_label: text("quota_lane_label"),
  meter_confidence: rentalMeterConfidenceEnum("meter_confidence")
    .notNull()
    .default("unknown"),
  native_quota_unit: rentalNativeQuotaUnitEnum("native_quota_unit")
    .notNull()
    .default("unknown"),
  last_native_quota_snapshot: jsonb("last_native_quota_snapshot"),
  last_lrt_estimate: integer("last_lrt_estimate"),
  last_quota_reset_at: timestamp("last_quota_reset_at", { withTimezone: true }),
  verified_agent_fingerprint_id: text("verified_agent_fingerprint_id"),
  supported_modes: jsonb("supported_modes")
    .$type<string[]>()
    .notNull()
    .default(["scoped"]),
  max_concurrent_sessions: integer("max_concurrent_sessions").notNull().default(1),
  default_lrt_limit: integer("default_lrt_limit"),
  default_time_limit_minutes: integer("default_time_limit_minutes"),
  manual_accept_required: boolean("manual_accept_required").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
