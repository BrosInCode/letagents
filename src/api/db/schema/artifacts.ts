import { sql } from "drizzle-orm";
import { bigint as pgBigInt, check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { rooms } from "./core.js";

// Structured per-artifact detail. Stored as a single JSONB column and shaped as a
// discriminated union on `type` + `version`, so new artifact kinds can grow their
// own detail variant without a schema change. Only `change_summary` is populated
// today. Never carries source code — for change summaries it is file paths and
// +/- counts (git numstat), safe to share with every room member.
export interface RoomSharedArtifactChangedFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface RoomSharedArtifactChangeSummaryDetail {
  type: "change_summary";
  version: 1;
  changedFileCount: number;
  additions: number;
  deletions: number;
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
  hiddenFileCount: number;
  files: RoomSharedArtifactChangedFile[];
}

// Extend this union as other kinds gain structured detail (pull_request, review, ...).
export type RoomSharedArtifactDetail = RoomSharedArtifactChangeSummaryDetail;

export const ROOM_SHARED_ARTIFACT_PROVIDERS = [
  "git",
  "github",
  "gitlab",
  "bitbucket",
  "unknown",
] as const;

export const ROOM_SHARED_ARTIFACT_KINDS = [
  "issue",
  "branch",
  "commit",
  "diff",
  "change_summary",
  "pull_request",
  "merge_request",
  "review",
  "check_run",
  "merge",
] as const;

export const ROOM_SHARED_ARTIFACT_SOURCES = [
  "task_workflow_artifact",
  "github_event",
  "manual",
] as const;

export type RoomSharedArtifactProvider = (typeof ROOM_SHARED_ARTIFACT_PROVIDERS)[number];
export type RoomSharedArtifactKind = (typeof ROOM_SHARED_ARTIFACT_KINDS)[number];
export type RoomSharedArtifactSource = (typeof ROOM_SHARED_ARTIFACT_SOURCES)[number];

export const room_shared_artifacts = pgTable(
  "room_shared_artifacts",
  {
    room_id: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    identity_key: text("identity_key").notNull(),
    provider: text("provider").notNull().$type<RoomSharedArtifactProvider>(),
    kind: text("kind").notNull().$type<RoomSharedArtifactKind>(),
    artifact_id: text("artifact_id"),
    artifact_number: pgBigInt("artifact_number", { mode: "number" }),
    title: text("title"),
    url: text("url"),
    ref: text("ref"),
    state: text("state"),
    detail: jsonb("detail").$type<RoomSharedArtifactDetail>(),
    source: text("source").notNull().$type<RoomSharedArtifactSource>(),
    first_seen_at: timestamp("first_seen_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "room_shared_artifacts_pk",
      columns: [table.room_id, table.identity_key],
    }),
    room_kind_idx: index("room_shared_artifacts_room_kind_idx").on(
      table.room_id,
      table.kind,
      table.updated_at
    ),
    room_url_idx: index("room_shared_artifacts_room_url_idx")
      .on(table.room_id, table.url)
      .where(sql`${table.url} IS NOT NULL`),
    room_ref_idx: index("room_shared_artifacts_room_ref_idx")
      .on(table.room_id, table.ref)
      .where(sql`${table.ref} IS NOT NULL`),
    provider_check: check(
      "room_shared_artifacts_provider_check",
      sql`${table.provider} IN ('git', 'github', 'gitlab', 'bitbucket', 'unknown')`
    ),
    kind_check: check(
      "room_shared_artifacts_kind_check",
      sql`${table.kind} IN ('issue', 'branch', 'commit', 'diff', 'change_summary', 'pull_request', 'merge_request', 'review', 'check_run', 'merge')`
    ),
    source_check: check(
      "room_shared_artifacts_source_check",
      sql`${table.source} IN ('task_workflow_artifact', 'github_event', 'manual')`
    ),
  })
);

export const room_shared_artifact_tasks = pgTable(
  "room_shared_artifact_tasks",
  {
    room_id: text("room_id").notNull(),
    artifact_identity_key: text("artifact_identity_key").notNull(),
    task_id: text("task_id").notNull(),
    source: text("source").notNull().$type<RoomSharedArtifactSource>(),
    linked_at: timestamp("linked_at", { mode: "string", withTimezone: true }).notNull(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: "room_shared_artifact_tasks_pk",
      columns: [table.room_id, table.artifact_identity_key, table.task_id],
    }),
    artifact_fk: foreignKey({
      name: "room_shared_artifact_tasks_artifact_fk",
      columns: [table.room_id, table.artifact_identity_key],
      foreignColumns: [room_shared_artifacts.room_id, room_shared_artifacts.identity_key],
    }).onDelete("cascade").onUpdate("cascade"),
    room_task_idx: index("room_shared_artifact_tasks_room_task_idx").on(
      table.room_id,
      table.task_id
    ),
    source_check: check(
      "room_shared_artifact_tasks_source_check",
      sql`${table.source} IN ('task_workflow_artifact', 'github_event', 'manual')`
    ),
  })
);
