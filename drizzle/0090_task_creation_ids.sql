ALTER TABLE tasks ADD COLUMN client_task_id text;
--> statement-breakpoint
CREATE UNIQUE INDEX tasks_room_client_task_id_unique_idx ON tasks (room_id, client_task_id) WHERE client_task_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS tasks_room_source_message_id_unique_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX tasks_room_source_message_id_unique_idx ON tasks (room_id, source_message_id) WHERE source_message_id IS NOT NULL AND client_task_id IS NULL;
