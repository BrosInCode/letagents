-- Fenced lease rebind (plan §4.5). A restarted supervised worker registers a
-- new agent session, so resuming ownership of an in-flight lease requires a
-- server-side rebind rather than a prompt. `epoch` is the monotonic fence: it
-- increments on every rebind, and every lease-guarded write must present the
-- epoch it last observed. A partitioned-but-live predecessor therefore fails
-- its writes after a rebind even if its credential still looks valid.
ALTER TABLE "task_leases" ADD COLUMN "epoch" integer NOT NULL DEFAULT 0;
