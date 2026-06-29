ALTER TABLE "github_repositories" ADD COLUMN IF NOT EXISTS "default_branch" text;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_git_bindings" (
  "room_id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "host" text NOT NULL,
  "repository_id" text,
  "repository_full_name" text NOT NULL,
  "repository_owner" text NOT NULL,
  "repository_name" text NOT NULL,
  "ref_type" text NOT NULL,
  "ref_name" text,
  "default_branch" text,
  "base_ref" text,
  "head_ref" text,
  "head_repository_id" text,
  "head_repository_full_name" text,
  "head_repository_owner" text,
  "head_repository_name" text,
  "visibility" text DEFAULT 'unknown' NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "room_git_bindings_provider_check" CHECK ("provider" IN ('github')),
  CONSTRAINT "room_git_bindings_ref_type_check" CHECK ("ref_type" IN ('default_branch', 'branch', 'tag', 'pull_request')),
  CONSTRAINT "room_git_bindings_visibility_check" CHECK ("visibility" IN ('public', 'private', 'unknown')),
  CONSTRAINT "room_git_bindings_source_check" CHECK ("source" IN ('github_repository', 'webhook', 'manual'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "room_git_bindings" ADD CONSTRAINT "room_git_bindings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_git_bindings_repository_idx" ON "room_git_bindings" USING btree ("provider","host","repository_full_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_git_bindings_repository_id_idx" ON "room_git_bindings" USING btree ("provider","repository_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_git_bindings_ref_idx" ON "room_git_bindings" USING btree ("provider","host","repository_full_name","ref_type","ref_name");--> statement-breakpoint
INSERT INTO "room_git_bindings" (
  "room_id",
  "provider",
  "host",
  "repository_id",
  "repository_full_name",
  "repository_owner",
  "repository_name",
  "ref_type",
  "ref_name",
  "default_branch",
  "visibility",
  "is_default",
  "source",
  "created_at",
  "updated_at"
)
SELECT
  "github_repositories"."room_id",
  'github',
  'github.com',
  "github_repositories"."github_repo_id",
  "github_repositories"."full_name",
  "github_repositories"."owner_login",
  "github_repositories"."repo_name",
  'default_branch',
  "github_repositories"."default_branch",
  "github_repositories"."default_branch",
  COALESCE(NULLIF("github_repositories"."visibility", ''), 'unknown'),
  true,
  'github_repository',
  "github_repositories"."created_at",
  "github_repositories"."updated_at"
FROM "github_repositories"
INNER JOIN "rooms" ON "rooms"."id" = "github_repositories"."room_id"
ON CONFLICT ("room_id") DO UPDATE SET
  "provider" = excluded."provider",
  "host" = excluded."host",
  "repository_id" = excluded."repository_id",
  "repository_full_name" = excluded."repository_full_name",
  "repository_owner" = excluded."repository_owner",
  "repository_name" = excluded."repository_name",
  "ref_type" = excluded."ref_type",
  "ref_name" = excluded."ref_name",
  "default_branch" = excluded."default_branch",
  "visibility" = excluded."visibility",
  "is_default" = excluded."is_default",
  "source" = excluded."source",
  "updated_at" = excluded."updated_at";
--> statement-breakpoint
INSERT INTO "room_git_bindings" (
  "room_id",
  "provider",
  "host",
  "repository_id",
  "repository_full_name",
  "repository_owner",
  "repository_name",
  "ref_type",
  "ref_name",
  "default_branch",
  "visibility",
  "is_default",
  "source",
  "created_at",
  "updated_at"
)
SELECT
  "rooms"."id",
  'github',
  'github.com',
  NULL,
  split_part("rooms"."id", '/', 2) || '/' || split_part("rooms"."id", '/', 3),
  split_part("rooms"."id", '/', 2),
  split_part("rooms"."id", '/', 3),
  'default_branch',
  NULL,
  NULL,
  'unknown',
  true,
  'manual',
  "rooms"."created_at",
  "rooms"."created_at"
FROM "rooms"
WHERE "rooms"."id" ~ '^github\.com/[^/[:space:]:]+/[^/[:space:]:]+$'
ON CONFLICT ("room_id") DO NOTHING;
