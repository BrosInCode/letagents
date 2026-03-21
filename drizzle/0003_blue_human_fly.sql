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
ALTER TABLE "messages" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer;--> statement-breakpoint
UPDATE "messages" SET "number" = CAST(SUBSTRING("id" FROM 5) AS integer);--> statement-breakpoint
UPDATE "tasks" SET "number" = CAST(SUBSTRING("id" FROM 6) AS integer);--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_pkey";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_pkey";--> statement-breakpoint
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
