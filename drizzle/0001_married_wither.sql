CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"login" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"token" text NOT NULL,
	"provider_access_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"redirect_to" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "project_admins" (
	"project_id" text NOT NULL,
	"account_id" text NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_admins_pk" PRIMARY KEY("project_id","account_id")
);
--> statement-breakpoint
DROP TABLE "agents";
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_key" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"owner_login" text NOT NULL,
	"owner_label" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_admins" ADD CONSTRAINT "project_admins_project_id_rooms_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_admins" ADD CONSTRAINT "project_admins_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_user_idx" ON "accounts" USING btree ("provider","provider_user_id");
--> statement-breakpoint
CREATE INDEX "accounts_login_idx" ON "accounts" USING btree ("login");
--> statement-breakpoint
CREATE INDEX "auth_sessions_account_id_idx" ON "auth_sessions" USING btree ("account_id");
--> statement-breakpoint
CREATE INDEX "project_admins_account_id_idx" ON "project_admins" USING btree ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_canonical_key_idx" ON "agents" USING btree ("canonical_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_name_idx" ON "agents" USING btree ("owner_account_id","name");
--> statement-breakpoint
CREATE INDEX "agents_owner_account_id_idx" ON "agents" USING btree ("owner_account_id");
