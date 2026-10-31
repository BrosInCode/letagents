-- Connectors: GitHub Issues as a third tracker. A GitHub Issues connection
-- holds no token: it names a LetAgents GitHub App installation (auth_kind
-- 'github_app'), and every read uses that installation's short-lived token.
-- Widens the provider checks that named only Jira and Linear. OAuth states and
-- workflow effects keep their checks: GitHub Issues has no tracker OAuth and
-- rules do not write to it yet.
-- Older servers have no GitHub Issues provider: they skip such rows with a
-- logged error, so connect GitHub Issues only after every API instance runs
-- this release.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "tracker_connections" DROP CONSTRAINT IF EXISTS "tracker_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "tracker_connections" ADD CONSTRAINT "tracker_connections_provider_check" CHECK ("provider" IN ('jira', 'linear', 'github')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "tracker_connections" VALIDATE CONSTRAINT "tracker_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "tracker_connections" DROP CONSTRAINT IF EXISTS "tracker_connections_auth_kind_check";
--> statement-breakpoint
ALTER TABLE "tracker_connections" ADD CONSTRAINT "tracker_connections_auth_kind_check" CHECK ("auth_kind" IN ('oauth', 'api_token', 'github_app')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "tracker_connections" VALIDATE CONSTRAINT "tracker_connections_auth_kind_check";
--> statement-breakpoint
ALTER TABLE "external_items" DROP CONSTRAINT IF EXISTS "external_items_provider_check";
--> statement-breakpoint
ALTER TABLE "external_items" ADD CONSTRAINT "external_items_provider_check" CHECK ("provider" IN ('jira', 'linear', 'github')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "external_items" VALIDATE CONSTRAINT "external_items_provider_check";
--> statement-breakpoint
ALTER TABLE "room_tracker_filters" DROP CONSTRAINT IF EXISTS "room_tracker_filters_provider_check";
--> statement-breakpoint
ALTER TABLE "room_tracker_filters" ADD CONSTRAINT "room_tracker_filters_provider_check" CHECK ("provider" IN ('jira', 'linear', 'github')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "room_tracker_filters" VALIDATE CONSTRAINT "room_tracker_filters_provider_check";
