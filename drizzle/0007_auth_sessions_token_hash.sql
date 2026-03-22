ALTER TABLE "auth_sessions" RENAME COLUMN "token" TO "token_hash";--> statement-breakpoint
ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_token_unique";--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash");