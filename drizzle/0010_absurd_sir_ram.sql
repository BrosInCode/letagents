CREATE TABLE "github_repositories" (
	"github_repo_id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"owner_login" text NOT NULL,
	"repo_name" text NOT NULL,
	"full_name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_aliases" (
	"alias" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "room_aliases" ADD CONSTRAINT "room_aliases_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_room_id_idx" ON "github_repositories" USING btree ("room_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_full_name_idx" ON "github_repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "room_aliases_room_id_idx" ON "room_aliases" USING btree ("room_id");