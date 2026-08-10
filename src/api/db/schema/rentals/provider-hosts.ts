import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { accounts } from "../core.js";

export interface RentalHostRuntime {
  kind: string;
  label: string;
  authenticated: boolean;
  permissionProfiles?: string[];
  modelLabels?: string[];
}

/** A concrete Desktop installation that may accept rental work. */
export const rental_provider_hosts = pgTable(
  "rental_provider_hosts",
  {
    id: text("id").primaryKey(),
    provider_account_id: text("provider_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    host_id: text("host_id").notNull(),
    installation_id: text("installation_id").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    max_concurrent_sessions: integer("max_concurrent_sessions").notNull().default(1),
    default_lrt_limit: integer("default_lrt_limit").notNull().default(50_000),
    default_time_limit_minutes: integer("default_time_limit_minutes").notNull().default(30),
    manual_accept_required: boolean("manual_accept_required").notNull().default(true),
    runtimes: jsonb("runtimes").$type<RentalHostRuntime[]>().notNull().default([]),
    daemon_generation: integer("daemon_generation"),
    last_heartbeat_at: timestamp("last_heartbeat_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("rental_provider_hosts_installation_uq").on(
      table.provider_account_id,
      table.host_id,
      table.installation_id,
    ),
    index("rental_provider_hosts_online_idx").on(table.enabled, table.last_heartbeat_at),
    index("rental_provider_hosts_provider_idx").on(table.provider_account_id),
  ],
);

/** Durable wake hints. Consumers always re-read session state after a wake. */
export const rental_provider_events = pgTable(
  "rental_provider_events",
  {
    id: text("id").primaryKey(),
    provider_account_id: text("provider_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    session_id: text("session_id"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rental_provider_events_provider_created_idx").on(
      table.provider_account_id,
      table.created_at,
      table.id,
    ),
  ],
);
