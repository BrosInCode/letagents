-- Additive: the members of rooms that are not tied to a repository, and the
-- requests people send to join one. Rows exist only on top-level rooms; a
-- focus room uses the members of its parent. A room admin is always a member.
-- Nothing reads these tables for access yet: a later release turns the
-- members-only rule on, and runs the seed below again before it does.
--
-- The seed gives each top-level room that is not tied to a repository (not
-- repo-shaped, no GitHub binding) the people with proof: its admins, the
-- people who posted in it or its focus rooms while signed in, and the owners
-- of agents that joined. An agent lent through a rental or an agent ask does
-- not make its owner a member. A person an admin removed, or who left, is
-- recorded in room_member_removals and is never added back by a seed. The
-- seed changes no admin. Older servers never read these tables.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_members" (
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"added_via" text NOT NULL,
	"added_by" text REFERENCES "accounts"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_members_pk" PRIMARY KEY ("room_id", "account_id"),
	CONSTRAINT "room_members_added_via_check" CHECK ("added_via" IN ('creator', 'seed', 'approved_request'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_members_account_idx" ON "room_members" USING btree ("account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_member_removals" (
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"removed_by" text REFERENCES "accounts"("id") ON DELETE SET NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_member_removals_pk" PRIMARY KEY ("room_id", "account_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_join_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
	"account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text REFERENCES "accounts"("id") ON DELETE SET NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "room_join_requests_state_check" CHECK ("state" IN ('pending', 'approved', 'declined', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "room_join_requests_one_pending_idx" ON "room_join_requests" USING btree ("room_id", "account_id") WHERE "state" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_join_requests_room_state_idx" ON "room_join_requests" USING btree ("room_id", "state", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_join_requests_account_idx" ON "room_join_requests" USING btree ("account_id", "room_id", "created_at");
--> statement-breakpoint
WITH member_rooms AS (
	SELECT "id" FROM "rooms"
	WHERE "kind" = 'main'
		AND "id" !~ '^[A-Za-z0-9.-]+/[^/]+/[^/]+$'
		AND NOT (lower(split_part("id", '/', 1)) = 'gitlab.com' AND "id" LIKE '%/%/%')
		AND NOT EXISTS (
			SELECT 1 FROM "room_git_bindings" AS binding
			WHERE binding."room_id" = "rooms"."id" AND binding."provider" = 'github'
		)
), scope AS (
	SELECT "id" AS room_id, "id" AS access_room_id FROM member_rooms
	UNION ALL
	SELECT focus."id", focus."parent_room_id"
	FROM "rooms" AS focus
	INNER JOIN member_rooms ON member_rooms."id" = focus."parent_room_id"
	WHERE focus."kind" = 'focus'
), lent_sessions AS (
	SELECT session."session_id"
	FROM "room_agent_sessions" AS session
	INNER JOIN "supervisor_host_grants" AS grant_row ON grant_row."grant_id" = session."supervisor_grant_id"
	WHERE grant_row."rental_session_id" IS NOT NULL OR grant_row."scope_key" LIKE 'ask:%'
	UNION
	SELECT "room_agent_session_id" FROM "rental_sessions" WHERE "room_agent_session_id" IS NOT NULL
	UNION
	SELECT "room_agent_session_id" FROM "agent_asks" WHERE "room_agent_session_id" IS NOT NULL
), proof AS (
	SELECT admin."project_id" AS room_id, admin."account_id"
	FROM "project_admins" AS admin
	INNER JOIN member_rooms ON member_rooms."id" = admin."project_id"
	UNION
	SELECT scope.access_room_id, message."publisher_account_id"
	FROM "messages" AS message
	INNER JOIN scope ON scope.room_id = message."room_id"
	WHERE message."publisher_account_id" IS NOT NULL AND message."publisher_agent_session_id" IS NULL
	UNION
	SELECT scope.access_room_id, session."owner_account_id"
	FROM "room_agent_sessions" AS session
	INNER JOIN scope ON scope.room_id = session."room_id"
	WHERE NOT EXISTS (SELECT 1 FROM lent_sessions WHERE lent_sessions."session_id" = session."session_id")
)
INSERT INTO "room_members" ("room_id", "account_id", "added_via", "created_at")
SELECT proof.room_id, proof."account_id", 'seed', now()
FROM proof
INNER JOIN "accounts" AS account ON account."id" = proof."account_id"
WHERE NOT EXISTS (
	SELECT 1 FROM "room_member_removals" AS removal
	WHERE removal."room_id" = proof.room_id AND removal."account_id" = proof."account_id"
)
ON CONFLICT ("room_id", "account_id") DO NOTHING;
