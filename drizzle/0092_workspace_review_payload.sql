ALTER TABLE room_agent_work DROP CONSTRAINT room_agent_work_summary_size_check;
--> statement-breakpoint
ALTER TABLE room_agent_work ADD CONSTRAINT room_agent_work_summary_size_check CHECK (octet_length(summary::text) <= 524288);
