CREATE TABLE room_agent_work_review_pages (
  attempt_id text NOT NULL REFERENCES room_agent_work(attempt_id) ON DELETE CASCADE,
  page_index integer NOT NULL,
  page_total integer NOT NULL,
  digest text NOT NULL,
  data text NOT NULL,
  CONSTRAINT room_agent_work_review_page_check CHECK (page_total BETWEEN 1 AND 2048 AND page_index >= 0 AND page_index < page_total AND octet_length(data) BETWEEN 1 AND 65536 AND digest ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX room_agent_work_review_page_uq ON room_agent_work_review_pages(attempt_id,page_index);
