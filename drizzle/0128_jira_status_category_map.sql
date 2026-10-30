-- Connectors: Jira connections map a status their map does not name by its
-- Jira status category (type:new, type:indeterminate, type:done), as Linear
-- connections map by state type. New Jira connections get these entries from
-- the default map; this adds them to existing Jira maps. An entry the map
-- already has (in any letter case) is kept, and a map near the 100-entry limit
-- is left alone. The learned unmapped statuses are cleared: most now map by
-- category, and the next sync records again any status that still does not.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
UPDATE "tracker_connections" AS tc
   SET "status_map" = COALESCE((
         SELECT jsonb_object_agg(d.key, d.value)
           FROM jsonb_each('{"type:new": "todo", "type:indeterminate": "in_progress", "type:done": "done"}'::jsonb) AS d
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_object_keys(tc."status_map") AS k WHERE lower(trim(k)) = d.key
          )
       ), '{}'::jsonb) || tc."status_map",
       "unmapped_statuses" = '[]'::jsonb
 WHERE tc."provider" = 'jira'
   AND CASE WHEN jsonb_typeof(tc."status_map") = 'object'
            THEN (SELECT count(*) FROM jsonb_object_keys(tc."status_map")) <= 97
            ELSE false
       END;
