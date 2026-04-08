CREATE TYPE "room_participant_kind" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TABLE "room_participants" (
	"room_id" text NOT NULL,
	"participant_key" text NOT NULL,
	"kind" "room_participant_kind" NOT NULL,
	"actor_label" text,
	"agent_key" text,
	"github_login" text,
	"display_name" text NOT NULL,
	"owner_label" text,
	"ide_label" text,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "room_participants_pk" PRIMARY KEY("room_id","participant_key")
);--> statement-breakpoint
ALTER TABLE "room_participants" ADD CONSTRAINT "room_participants_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "room_participants_room_id_idx" ON "room_participants" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_participants_room_kind_idx" ON "room_participants" USING btree ("room_id","kind");--> statement-breakpoint
CREATE INDEX "room_participants_room_last_seen_idx" ON "room_participants" USING btree ("room_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "room_participants_room_actor_idx" ON "room_participants" USING btree ("room_id","actor_label");--> statement-breakpoint
CREATE INDEX "room_participants_room_login_idx" ON "room_participants" USING btree ("room_id","github_login");--> statement-breakpoint
INSERT INTO "room_participants" (
	"room_id",
	"participant_key",
	"kind",
	"actor_label",
	"agent_key",
	"github_login",
	"display_name",
	"owner_label",
	"ide_label",
	"last_seen_at",
	"created_at",
	"updated_at"
)
SELECT
	"room_id",
	'agent:' || LOWER(REGEXP_REPLACE(BTRIM("actor_label"), '\s+', ' ', 'g')),
	'agent'::"room_participant_kind",
	"actor_label",
	"agent_key",
	NULL,
	"display_name",
	"owner_label",
	"ide_label",
	"last_heartbeat_at",
	"created_at",
	"updated_at"
FROM "room_agent_presence"
ON CONFLICT ("room_id","participant_key") DO UPDATE
SET
	"agent_key" = EXCLUDED."agent_key",
	"display_name" = EXCLUDED."display_name",
	"owner_label" = EXCLUDED."owner_label",
	"ide_label" = EXCLUDED."ide_label",
	"last_seen_at" = EXCLUDED."last_seen_at",
	"updated_at" = EXCLUDED."updated_at";--> statement-breakpoint
INSERT INTO "room_participants" (
	"room_id",
	"participant_key",
	"kind",
	"actor_label",
	"agent_key",
	"github_login",
	"display_name",
	"owner_label",
	"ide_label",
	"last_seen_at",
	"created_at",
	"updated_at"
)
SELECT
	"room_id",
	'human:login:' || LOWER(REGEXP_REPLACE(BTRIM("sender"), '\s+', ' ', 'g')),
	'human'::"room_participant_kind",
	NULL,
	NULL,
	"sender",
	"sender",
	NULL,
	NULL,
	MAX("timestamp") AS "last_seen_at",
	MIN("timestamp") AS "created_at",
	MAX("timestamp") AS "updated_at"
FROM "messages"
WHERE COALESCE("source", '') = 'browser'
	AND BTRIM("sender") <> ''
	AND LOWER(BTRIM("sender")) NOT IN ('letagents', 'system', 'github')
GROUP BY "room_id", "sender"
ON CONFLICT ("room_id","participant_key") DO UPDATE
SET
	"github_login" = EXCLUDED."github_login",
	"display_name" = EXCLUDED."display_name",
	"last_seen_at" = EXCLUDED."last_seen_at",
	"updated_at" = EXCLUDED."updated_at";
