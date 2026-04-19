CREATE TYPE "task_lease_kind" AS ENUM('work', 'review');--> statement-breakpoint
CREATE TYPE "task_lease_status" AS ENUM('active', 'released', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "task_lock_scope" AS ENUM('room', 'task');--> statement-breakpoint
CREATE TYPE "task_lock_reason" AS ENUM('human_stop', 'duplicate', 'manager_pause', 'revoked', 'policy');--> statement-breakpoint
CREATE TYPE "coordination_decision" AS ENUM('allow', 'deny', 'record');--> statement-breakpoint
CREATE TABLE "task_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"task_id" text NOT NULL,
	"kind" "task_lease_kind" NOT NULL,
	"status" "task_lease_status" DEFAULT 'active' NOT NULL,
	"agent_key" text NOT NULL,
	"agent_instance_id" text,
	"actor_label" text NOT NULL,
	"branch_ref" text,
	"pr_url" text,
	"output_intent" text,
	"expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"revoked_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE TABLE "task_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"task_id" text,
	"scope" "task_lock_scope" NOT NULL,
	"reason" "task_lock_reason" NOT NULL,
	"message" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"cleared_by" text,
	"cleared_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "coordination_events" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"task_id" text,
	"lease_id" text,
	"lock_id" text,
	"event_type" text NOT NULL,
	"decision" "coordination_decision" DEFAULT 'record' NOT NULL,
	"actor_label" text,
	"actor_key" text,
	"actor_instance_id" text,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "task_leases" ADD CONSTRAINT "task_leases_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_locks" ADD CONSTRAINT "task_locks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "coordination_events" ADD CONSTRAINT "coordination_events_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "coordination_events" ADD CONSTRAINT "coordination_events_lease_id_task_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."task_leases"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "coordination_events" ADD CONSTRAINT "coordination_events_lock_id_task_locks_id_fk" FOREIGN KEY ("lock_id") REFERENCES "public"."task_locks"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_locks" ADD CONSTRAINT "task_locks_scope_task_check" CHECK ((
	"task_locks"."scope" = 'room'
	AND "task_locks"."task_id" IS NULL
) OR (
	"task_locks"."scope" = 'task'
	AND "task_locks"."task_id" IS NOT NULL
));--> statement-breakpoint
CREATE INDEX "task_leases_room_task_idx" ON "task_leases" USING btree ("room_id","task_id");--> statement-breakpoint
CREATE INDEX "task_leases_room_agent_idx" ON "task_leases" USING btree ("room_id","agent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_leases_active_work_task_idx" ON "task_leases" USING btree ("room_id","task_id") WHERE "task_leases"."kind" = 'work' AND "task_leases"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "task_leases_active_review_agent_idx" ON "task_leases" USING btree ("room_id","task_id","agent_key") WHERE "task_leases"."kind" = 'review' AND "task_leases"."status" = 'active';--> statement-breakpoint
CREATE INDEX "task_locks_room_scope_idx" ON "task_locks" USING btree ("room_id","scope");--> statement-breakpoint
CREATE INDEX "task_locks_room_task_idx" ON "task_locks" USING btree ("room_id","task_id");--> statement-breakpoint
CREATE INDEX "task_locks_active_room_idx" ON "task_locks" USING btree ("room_id") WHERE "task_locks"."scope" = 'room' AND "task_locks"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "task_locks_active_task_idx" ON "task_locks" USING btree ("room_id","task_id") WHERE "task_locks"."scope" = 'task' AND "task_locks"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "coordination_events_room_task_idx" ON "coordination_events" USING btree ("room_id","task_id");--> statement-breakpoint
CREATE INDEX "coordination_events_room_created_idx" ON "coordination_events" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX "coordination_events_lease_idx" ON "coordination_events" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "coordination_events_lock_idx" ON "coordination_events" USING btree ("lock_id");
