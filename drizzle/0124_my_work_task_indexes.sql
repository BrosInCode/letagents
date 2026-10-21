-- Additive: My work (ticket connectors PR4) reads a room's unfinished cards,
-- newest change first. Finished cards (done, merged, cancelled) are most of a
-- busy board and are left out of the first index; the second holds only the
-- finished cards whose ticket is still open, which My work also lists.
-- The tasks table is small (cards, not messages), so a plain build holds its
-- write lock briefly; lock_timeout keeps a busy table from queueing behind it.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_room_open_updated_idx" ON "tasks" USING btree ("room_id", "updated_at" DESC, "number" DESC) WHERE "status" NOT IN ('done', 'merged', 'cancelled');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_room_finished_open_ticket_idx" ON "tasks" USING btree ("room_id", "updated_at" DESC, "number" DESC) WHERE "status" IN ('done', 'merged', 'cancelled') AND "ticket_state" IN ('todo', 'in_progress', 'in_review');
