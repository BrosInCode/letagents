CREATE TABLE IF NOT EXISTS "room_shared_artifacts" (
  "room_id" text NOT NULL,
  "identity_key" text NOT NULL,
  "provider" text NOT NULL,
  "kind" text NOT NULL,
  "artifact_id" text,
  "artifact_number" integer,
  "title" text,
  "url" text,
  "ref" text,
  "state" text,
  "source" text NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "room_shared_artifacts_pk" PRIMARY KEY ("room_id","identity_key"),
  CONSTRAINT "room_shared_artifacts_provider_check" CHECK ("provider" IN ('github', 'gitlab', 'bitbucket', 'unknown')),
  CONSTRAINT "room_shared_artifacts_kind_check" CHECK ("kind" IN ('issue', 'branch', 'pull_request', 'merge_request', 'review', 'check_run', 'merge')),
  CONSTRAINT "room_shared_artifacts_source_check" CHECK ("source" IN ('task_workflow_artifact', 'github_event', 'manual'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "room_shared_artifacts" ADD CONSTRAINT "room_shared_artifacts_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_shared_artifacts_room_kind_idx" ON "room_shared_artifacts" USING btree ("room_id","kind","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_shared_artifacts_room_url_idx" ON "room_shared_artifacts" USING btree ("room_id","url") WHERE "url" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_shared_artifacts_room_ref_idx" ON "room_shared_artifacts" USING btree ("room_id","ref") WHERE "ref" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_shared_artifact_tasks" (
  "room_id" text NOT NULL,
  "artifact_identity_key" text NOT NULL,
  "task_id" text NOT NULL,
  "source" text NOT NULL,
  "linked_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "room_shared_artifact_tasks_pk" PRIMARY KEY ("room_id","artifact_identity_key","task_id"),
  CONSTRAINT "room_shared_artifact_tasks_source_check" CHECK ("source" IN ('task_workflow_artifact', 'github_event', 'manual'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "room_shared_artifact_tasks" ADD CONSTRAINT "room_shared_artifact_tasks_artifact_fk" FOREIGN KEY ("room_id","artifact_identity_key") REFERENCES "public"."room_shared_artifacts"("room_id","identity_key") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_shared_artifact_tasks_room_task_idx" ON "room_shared_artifact_tasks" USING btree ("room_id","task_id");--> statement-breakpoint
WITH raw_task_artifacts AS (
  SELECT
    "tasks"."room_id",
    'task_' || "tasks"."number"::text AS "task_id",
    "tasks"."created_at",
    "tasks"."updated_at",
    "artifact"
  FROM "tasks"
  CROSS JOIN LATERAL jsonb_array_elements("tasks"."workflow_artifacts") AS "artifact"
),
task_artifacts AS (
  SELECT
    "room_id",
    "task_id",
    "created_at",
    "updated_at",
    "artifact",
    CASE
      WHEN COALESCE(NULLIF("artifact"->>'provider', ''), 'unknown') IN ('github', 'gitlab', 'bitbucket') THEN
        COALESCE(NULLIF("artifact"->>'provider', ''), 'unknown')
      ELSE 'unknown'
    END AS "provider",
    CASE COALESCE(NULLIF("artifact"->>'kind', ''), 'pull_request')
      WHEN 'issue' THEN 'issue'
      WHEN 'issue_comment' THEN 'issue'
      WHEN 'branch' THEN 'branch'
      WHEN 'branch_ref' THEN 'branch'
      WHEN 'push' THEN
        CASE WHEN NULLIF("artifact"->>'ref', '') IS NOT NULL THEN 'branch' ELSE NULL END
      WHEN 'pull_request' THEN 'pull_request'
      WHEN 'merge_request' THEN 'merge_request'
      WHEN 'review' THEN 'review'
      WHEN 'pull_request_review' THEN 'review'
      WHEN 'check_run' THEN 'check_run'
      WHEN 'merge' THEN 'merge'
      ELSE NULL
    END AS "kind",
    NULLIF("artifact"->>'id', '') AS "artifact_id",
    CASE
      WHEN NULLIF("artifact"->>'number', '') ~ '^[0-9]+$' THEN ("artifact"->>'number')::integer
      ELSE NULL
    END AS "artifact_number",
    NULLIF("artifact"->>'title', '') AS "title",
    NULLIF("artifact"->>'url', '') AS "url",
    NULLIF("artifact"->>'ref', '') AS "ref",
    NULLIF("artifact"->>'state', '') AS "state"
  FROM raw_task_artifacts
),
keyed_task_artifacts AS (
  SELECT
    *,
    CASE
      WHEN "url" IS NOT NULL THEN "provider" || ':' || "kind" || ':url:' || "url"
      WHEN "artifact_id" IS NOT NULL THEN "provider" || ':' || "kind" || ':id:' || "artifact_id"
      WHEN "artifact_number" IS NOT NULL THEN "provider" || ':' || "kind" || ':number:' || "artifact_number"::text
      WHEN "ref" IS NOT NULL THEN "provider" || ':' || "kind" || ':ref:' || "ref"
      WHEN "title" IS NOT NULL THEN "provider" || ':' || "kind" || ':title:' || "title"
      ELSE "provider" || ':' || "kind" || ':generic'
    END AS "identity_key"
  FROM task_artifacts
  WHERE "kind" IS NOT NULL
),
ranked_artifacts AS (
  SELECT
    *,
    MIN("created_at") OVER (PARTITION BY "room_id", "identity_key") AS "first_seen_at",
    MAX("updated_at") OVER (PARTITION BY "room_id", "identity_key") AS "latest_updated_at",
    ROW_NUMBER() OVER (
      PARTITION BY "room_id", "identity_key"
      ORDER BY "updated_at" DESC, "created_at" DESC, "task_id" DESC
    ) AS "artifact_rank"
  FROM keyed_task_artifacts
)
INSERT INTO "room_shared_artifacts" (
  "room_id",
  "identity_key",
  "provider",
  "kind",
  "artifact_id",
  "artifact_number",
  "title",
  "url",
  "ref",
  "state",
  "source",
  "first_seen_at",
  "updated_at"
)
SELECT
  "room_id",
  "identity_key",
  "provider",
  "kind",
  "artifact_id",
  "artifact_number",
  "title",
  "url",
  "ref",
  "state",
  'task_workflow_artifact',
  "first_seen_at",
  "latest_updated_at"
FROM ranked_artifacts
WHERE "artifact_rank" = 1
ON CONFLICT ("room_id","identity_key") DO UPDATE SET
  "provider" = excluded."provider",
  "kind" = excluded."kind",
  "artifact_id" = excluded."artifact_id",
  "artifact_number" = excluded."artifact_number",
  "title" = excluded."title",
  "url" = excluded."url",
  "ref" = excluded."ref",
  "state" = excluded."state",
  "source" = excluded."source",
  "updated_at" = excluded."updated_at";--> statement-breakpoint
WITH raw_task_artifacts AS (
  SELECT
    "tasks"."room_id",
    'task_' || "tasks"."number"::text AS "task_id",
    "tasks"."created_at",
    "tasks"."updated_at",
    "artifact"
  FROM "tasks"
  CROSS JOIN LATERAL jsonb_array_elements("tasks"."workflow_artifacts") AS "artifact"
),
task_artifacts AS (
  SELECT
    "room_id",
    "task_id",
    "created_at",
    "updated_at",
    "artifact",
    CASE
      WHEN COALESCE(NULLIF("artifact"->>'provider', ''), 'unknown') IN ('github', 'gitlab', 'bitbucket') THEN
        COALESCE(NULLIF("artifact"->>'provider', ''), 'unknown')
      ELSE 'unknown'
    END AS "provider",
    CASE COALESCE(NULLIF("artifact"->>'kind', ''), 'pull_request')
      WHEN 'issue' THEN 'issue'
      WHEN 'issue_comment' THEN 'issue'
      WHEN 'branch' THEN 'branch'
      WHEN 'branch_ref' THEN 'branch'
      WHEN 'push' THEN
        CASE WHEN NULLIF("artifact"->>'ref', '') IS NOT NULL THEN 'branch' ELSE NULL END
      WHEN 'pull_request' THEN 'pull_request'
      WHEN 'merge_request' THEN 'merge_request'
      WHEN 'review' THEN 'review'
      WHEN 'pull_request_review' THEN 'review'
      WHEN 'check_run' THEN 'check_run'
      WHEN 'merge' THEN 'merge'
      ELSE NULL
    END AS "kind",
    NULLIF("artifact"->>'id', '') AS "artifact_id",
    CASE
      WHEN NULLIF("artifact"->>'number', '') ~ '^[0-9]+$' THEN ("artifact"->>'number')::integer
      ELSE NULL
    END AS "artifact_number",
    NULLIF("artifact"->>'title', '') AS "title",
    NULLIF("artifact"->>'url', '') AS "url",
    NULLIF("artifact"->>'ref', '') AS "ref",
    NULLIF("artifact"->>'state', '') AS "state"
  FROM raw_task_artifacts
),
keyed_task_artifacts AS (
  SELECT
    *,
    CASE
      WHEN "url" IS NOT NULL THEN "provider" || ':' || "kind" || ':url:' || "url"
      WHEN "artifact_id" IS NOT NULL THEN "provider" || ':' || "kind" || ':id:' || "artifact_id"
      WHEN "artifact_number" IS NOT NULL THEN "provider" || ':' || "kind" || ':number:' || "artifact_number"::text
      WHEN "ref" IS NOT NULL THEN "provider" || ':' || "kind" || ':ref:' || "ref"
      WHEN "title" IS NOT NULL THEN "provider" || ':' || "kind" || ':title:' || "title"
      ELSE "provider" || ':' || "kind" || ':generic'
    END AS "identity_key"
  FROM task_artifacts
  WHERE "kind" IS NOT NULL
)
INSERT INTO "room_shared_artifact_tasks" (
  "room_id",
  "artifact_identity_key",
  "task_id",
  "source",
  "linked_at",
  "updated_at"
)
SELECT
  "room_id",
  "identity_key",
  "task_id",
  'task_workflow_artifact',
  MIN("created_at"),
  MAX("updated_at")
FROM keyed_task_artifacts
GROUP BY "room_id", "identity_key", "task_id"
ON CONFLICT ("room_id","artifact_identity_key","task_id") DO UPDATE SET
  "source" = excluded."source",
  "updated_at" = excluded."updated_at";
