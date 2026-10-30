-- Connectors: Jira connections map a status their map does not name by its
-- Jira status category (type:new, type:indeterminate, type:done), as Linear
-- connections map by state type. New Jira connections get these entries from
-- the default map; this adds them to existing Jira maps. An entry the map
-- already has is kept, and a map near the 100-entry limit is left alone.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
UPDATE "tracker_connections"
   SET "status_map" = '{"type:new": "todo", "type:indeterminate": "in_progress", "type:done": "done"}'::jsonb || "status_map"
 WHERE "provider" = 'jira'
   AND jsonb_typeof("status_map") = 'object'
   AND (SELECT count(*) FROM jsonb_object_keys("status_map")) <= 97;
