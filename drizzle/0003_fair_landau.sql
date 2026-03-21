ALTER TABLE "owner_tokens" DROP CONSTRAINT "owner_tokens_github_user_id_unique";--> statement-breakpoint
DROP INDEX "owner_tokens_account_id_idx";--> statement-breakpoint
CREATE INDEX "owner_tokens_github_user_id_idx" ON "owner_tokens" USING btree ("github_user_id");--> statement-breakpoint
CREATE INDEX "owner_tokens_account_id_idx" ON "owner_tokens" USING btree ("account_id");