ALTER TABLE room_agent_work ADD COLUMN publisher_kind text NOT NULL DEFAULT 'supervisor';
--> statement-breakpoint
ALTER TABLE room_agent_work ALTER COLUMN host_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE room_agent_work ALTER COLUMN installation_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE room_agent_work ADD CONSTRAINT room_agent_work_publisher_check CHECK (
  (publisher_kind = 'supervisor' AND host_id IS NOT NULL AND installation_id IS NOT NULL)
  OR (publisher_kind = 'independent_worker' AND host_id IS NULL AND installation_id IS NULL)
);
