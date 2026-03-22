ALTER TABLE "auth_states"
ADD COLUMN "expires_at" timestamp with time zone NOT NULL DEFAULT (now() + interval '15 minutes');
--> statement-breakpoint
ALTER TABLE "auth_states" ALTER COLUMN "expires_at" DROP DEFAULT;
