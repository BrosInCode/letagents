ALTER TABLE "rooms" ADD COLUMN "focus_parent_visibility" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "focus_activity_scope" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "focus_github_event_routing" text;--> statement-breakpoint
UPDATE "rooms"
SET
  "focus_parent_visibility" = 'summary_only',
  "focus_activity_scope" = 'task_and_branch',
  "focus_github_event_routing" = 'task_and_branch'
WHERE "kind" = 'focus';--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_focus_settings_check" CHECK ((
  "rooms"."focus_parent_visibility" IS NULL
  OR "rooms"."focus_parent_visibility" IN ('summary_only', 'major_activity', 'all_activity', 'silent')
) AND (
  "rooms"."focus_activity_scope" IS NULL
  OR "rooms"."focus_activity_scope" IN ('task_and_branch', 'task_only', 'room')
) AND (
  "rooms"."focus_github_event_routing" IS NULL
  OR "rooms"."focus_github_event_routing" IN ('task_and_branch', 'task_only', 'all_parent_repo', 'off')
));
