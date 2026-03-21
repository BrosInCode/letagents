CREATE TABLE "owner_tokens" (
	"token_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"github_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"provider_access_token" text,
	"oauth_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "owner_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "owner_tokens" ADD CONSTRAINT "owner_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_tokens_account_id_idx" ON "owner_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "owner_tokens_github_user_id_idx" ON "owner_tokens" USING btree ("github_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_tokens_token_hash_idx" ON "owner_tokens" USING btree ("token_hash");