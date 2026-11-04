-- The members-only rule is on from this release: only members read a room
-- that is not tied to a repository, post in it and so wake its agents.
--
-- 1. Run the seed of 0130 again (same statement), so the people with proof
--    gained since then keep their rooms. It adds only what is missing and
--    never adds back a person in room_member_removals.
-- 2. A room with members but no admin gets one, so someone can let people
--    in: the member who posted first while signed in, else the member who
--    owns the earliest agent. The first person to join no longer becomes
--    admin, so without this such a room could never admit anyone.
SET LOCAL lock_timeout = '3s';
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
--> statement-breakpoint
WITH adminless AS (
	SELECT DISTINCT member."room_id"
	FROM "room_members" AS member
	WHERE NOT EXISTS (SELECT 1 FROM "project_admins" AS admin WHERE admin."project_id" = member."room_id")
), scope AS (
	SELECT "room_id", "room_id" AS access_room_id FROM adminless
	UNION ALL
	SELECT focus."id", focus."parent_room_id"
	FROM "rooms" AS focus
	INNER JOIN adminless ON adminless."room_id" = focus."parent_room_id"
	WHERE focus."kind" = 'focus'
)
INSERT INTO "project_admins" ("project_id", "account_id", "assigned_at")
SELECT DISTINCT ON (scope.access_room_id) scope.access_room_id, message."publisher_account_id", now()
FROM "messages" AS message
INNER JOIN scope ON scope."room_id" = message."room_id"
INNER JOIN "room_members" AS member
	ON member."room_id" = scope.access_room_id AND member."account_id" = message."publisher_account_id"
WHERE message."publisher_account_id" IS NOT NULL AND message."publisher_agent_session_id" IS NULL
ORDER BY scope.access_room_id, message."timestamp", message."number"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH adminless AS (
	SELECT DISTINCT member."room_id"
	FROM "room_members" AS member
	WHERE NOT EXISTS (SELECT 1 FROM "project_admins" AS admin WHERE admin."project_id" = member."room_id")
), scope AS (
	SELECT "room_id", "room_id" AS access_room_id FROM adminless
	UNION ALL
	SELECT focus."id", focus."parent_room_id"
	FROM "rooms" AS focus
	INNER JOIN adminless ON adminless."room_id" = focus."parent_room_id"
	WHERE focus."kind" = 'focus'
)
INSERT INTO "project_admins" ("project_id", "account_id", "assigned_at")
SELECT DISTINCT ON (scope.access_room_id) scope.access_room_id, session."owner_account_id", now()
FROM "room_agent_sessions" AS session
INNER JOIN scope ON scope."room_id" = session."room_id"
INNER JOIN "room_members" AS member
	ON member."room_id" = scope.access_room_id AND member."account_id" = session."owner_account_id"
ORDER BY scope.access_room_id, session."created_at", session."session_id"
ON CONFLICT DO NOTHING;
