ALTER TABLE "rooms" DROP CONSTRAINT IF EXISTS "rooms_focus_settings_check";--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_focus_settings_check" CHECK ((
  "rooms"."focus_parent_visibility" IS NULL
  OR "rooms"."focus_parent_visibility" IN ('summary_only', 'major_activity', 'all_activity', 'silent')
) AND (
  "rooms"."focus_activity_scope" IS NULL
  OR "rooms"."focus_activity_scope" IN ('task_and_branch', 'task_only', 'room')
) AND (
  "rooms"."focus_github_event_routing" IS NULL
  OR "rooms"."focus_github_event_routing" IN ('task_and_branch', 'focus_owned_only', 'task_only', 'all_parent_repo', 'off')
));
