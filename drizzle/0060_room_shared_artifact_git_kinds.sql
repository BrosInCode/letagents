ALTER TABLE "room_shared_artifacts" DROP CONSTRAINT IF EXISTS "room_shared_artifacts_provider_check";--> statement-breakpoint
ALTER TABLE "room_shared_artifacts" ADD CONSTRAINT "room_shared_artifacts_provider_check" CHECK ("provider" IN ('git', 'github', 'gitlab', 'bitbucket', 'unknown'));--> statement-breakpoint
ALTER TABLE "room_shared_artifacts" DROP CONSTRAINT IF EXISTS "room_shared_artifacts_kind_check";--> statement-breakpoint
ALTER TABLE "room_shared_artifacts" ADD CONSTRAINT "room_shared_artifacts_kind_check" CHECK ("kind" IN ('issue', 'branch', 'commit', 'diff', 'change_summary', 'pull_request', 'merge_request', 'review', 'check_run', 'merge'));
