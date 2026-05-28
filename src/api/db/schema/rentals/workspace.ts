import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import {
  rentalExposureTypeEnum,
  rentalSecretScanStatusEnum,
  rentalWorkspaceRetentionStatusEnum,
} from "./enums.js";
import { rental_sessions } from "./sessions.js";

/**
 * Workspace manifest per spec §10.6.
 *
 * Records the materialized workspace for a rental session: base commit,
 * disposable work branch, exposed scope globs, and retention lifecycle.
 */
export const rental_workspace_manifests = pgTable(
  "rental_workspace_manifests",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    base_commit_sha: text("base_commit_sha").notNull(),
    work_branch: text("work_branch").notNull(),
    scope_globs: jsonb("scope_globs").notNull().default([]),
    workspace_path: text("workspace_path"),
    files_materialized: integer("files_materialized").notNull().default(0),
    bytes_materialized: integer("bytes_materialized").notNull().default(0),
    retention_status: rentalWorkspaceRetentionStatusEnum("retention_status")
      .notNull()
      .default("active"),
    materialized_at: timestamp("materialized_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    deleted_at: timestamp("deleted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_workspace_manifests_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    index("rental_workspace_manifests_session_id_idx").on(table.session_id),
    index("rental_workspace_manifests_retention_idx").on(
      table.retention_status,
      table.expires_at,
    ),
  ],
);

/**
 * Workspace exposure ledger per spec §19.4.
 *
 * Records each file or context fragment exposed to the provider agent. Patch
 * Gate uses this to validate edits only touch exposed files.
 */
export const rental_workspace_exposures = pgTable(
  "rental_workspace_exposures",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    path: text("path").notNull(),
    exposure_type: rentalExposureTypeEnum("exposure_type").notNull(),
    reason: text("reason"),
    redaction_count: integer("redaction_count").notNull().default(0),
    secret_scan_status: rentalSecretScanStatusEnum("secret_scan_status")
      .notNull()
      .default("passed"),
    requested_by: text("requested_by"),
    approved_by: text("approved_by"),
    scope_id: text("scope_id"),
    bytes_exposed: integer("bytes_exposed").notNull().default(0),
    content_hash: text("content_hash"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "rental_workspace_exposures_session_fk",
      columns: [table.session_id],
      foreignColumns: [rental_sessions.id],
    }),
    index("rental_workspace_exposures_session_id_idx").on(table.session_id),
    index("rental_workspace_exposures_session_path_idx").on(
      table.session_id,
      table.path,
    ),
  ],
);
