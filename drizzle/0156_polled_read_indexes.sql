-- Additive for old servers: they never name these indexes, and the dropped one
-- served no query they run.
-- `room_shared_artifacts_room_kind_key_idx` matches the artifact list's
-- ORDER BY kind, identity_key, so the list reads one page of the index
-- instead of every artifact of the room. It replaces
-- `room_shared_artifacts_room_kind_idx` (room_id, kind, updated_at): no query
-- filters or sorts by updated_at, and every upsert sets it, which made each
-- update write a new entry in that index (no HOT update). The new index also
-- serves any (room_id, kind) lookup.
-- `agents_avatar_canonical_key_idx` holds only the agents that have an avatar,
-- so a lookup of up to a few hundred keys reads that small index instead of
-- scanning the table.
-- Locks: Drizzle runs pending migrations in one transaction, so the builds are
-- not CONCURRENTLY. CREATE INDEX blocks writes to its table. DROP INDEX takes
-- an ACCESS EXCLUSIVE lock on room_shared_artifacts, which blocks reads too,
-- until the transaction commits; readers that arrive while it waits queue
-- behind it. If the lock is not free within lock_timeout (3 s) the whole
-- migration rolls back and the deploy stops with the old version still
-- serving; a rerun of the deploy is the remedy. Normally it commits in
-- about 100 ms. SET LOCAL lock_timeout stays in force for any later migration
-- applied in the same run.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_shared_artifacts_room_kind_key_idx" ON "room_shared_artifacts" USING btree ("room_id", "kind", "identity_key");
--> statement-breakpoint
DROP INDEX IF EXISTS "room_shared_artifacts_room_kind_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_avatar_canonical_key_idx" ON "agents" USING btree ("canonical_key") WHERE "avatar" IS NOT NULL;
