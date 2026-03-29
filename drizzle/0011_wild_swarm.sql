CREATE TABLE "github_app_installations" (
	"installation_id" text PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_login" text NOT NULL,
	"target_github_id" text NOT NULL,
	"repository_selection" text NOT NULL,
	"permissions_json" text,
	"suspended_at" timestamp with time zone,
	"uninstalled_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_app_repositories" (
	"github_repo_id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"owner_login" text NOT NULL,
	"repo_name" text NOT NULL,
	"full_name" text NOT NULL,
	"room_id" text NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"action" text,
	"installation_id" text,
	"github_repo_id" text,
	"room_id" text,
	"status" text NOT NULL,
	"error" text,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "github_app_repositories" ADD CONSTRAINT "github_app_repositories_installation_id_github_app_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_app_installations"("installation_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "github_app_installations_target_login_idx" ON "github_app_installations" USING btree ("target_login");--> statement-breakpoint
CREATE INDEX "github_app_installations_target_github_id_idx" ON "github_app_installations" USING btree ("target_github_id");--> statement-breakpoint
CREATE INDEX "github_app_repositories_installation_id_idx" ON "github_app_repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_app_repositories_full_name_idx" ON "github_app_repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "github_app_repositories_room_id_idx" ON "github_app_repositories" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_event_name_idx" ON "github_webhook_deliveries" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_installation_id_idx" ON "github_webhook_deliveries" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_room_id_idx" ON "github_webhook_deliveries" USING btree ("room_id");