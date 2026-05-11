CREATE TABLE "account_room_recents" (
	"account_id" text NOT NULL,
	"room_id" text NOT NULL,
	"display_name" text,
	"source" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"first_opened_at" timestamp with time zone NOT NULL,
	"last_opened_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_room_recents_pk" PRIMARY KEY("account_id","room_id")
);
--> statement-breakpoint
ALTER TABLE "account_room_recents" ADD CONSTRAINT "account_room_recents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_room_recents" ADD CONSTRAINT "account_room_recents_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "account_room_recents_account_last_opened_idx" ON "account_room_recents" USING btree ("account_id","last_opened_at");--> statement-breakpoint
CREATE INDEX "account_room_recents_room_id_idx" ON "account_room_recents" USING btree ("room_id");
--> statement-breakpoint
CREATE INDEX "room_agent_sessions_owner_account_id_idx" ON "room_agent_sessions" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "room_participants_participant_key_idx" ON "room_participants" USING btree ("participant_key");--> statement-breakpoint
CREATE INDEX "room_participants_github_login_idx" ON "room_participants" USING btree ("github_login");
