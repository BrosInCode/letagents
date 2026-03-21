-- Empty-DB-only migration for the room-identity reset.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "rooms" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "messages" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "tasks" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "participants" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "project_admins" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "invites" LIMIT 1) THEN
    RAISE EXCEPTION '0003_blue_human_fly is empty-DB-only. Wipe room data before applying.';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_code_unique";--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_name_unique";--> statement-breakpoint
ALTER TABLE "invites" DROP CONSTRAINT "invites_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "participants" DROP CONSTRAINT "participants_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "project_admins" DROP CONSTRAINT "project_admins_project_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_pkey";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_pkey";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_pk" PRIMARY KEY("room_id","number");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pk" PRIMARY KEY("room_id","number");--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "project_admins" ADD CONSTRAINT "project_admins_project_id_rooms_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "code";--> statement-breakpoint
ALTER TABLE "rooms" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "id";
