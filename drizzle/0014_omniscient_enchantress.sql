CREATE TABLE "system_github_app" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"app_slug" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"private_key" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
