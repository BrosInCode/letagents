-- What a room is, stored: join_code, repo, named or focus. Until now it was
-- read from the shape of the room id; rooms/room-nature.ts reads this column
-- and falls back to the id shape while it is NULL.
--
-- Nullable: an older server keeps inserting rooms without it during the
-- deploy, and the fallback covers those rows. A later migration backfills any
-- such rows and makes the column NOT NULL, after one full deploy.
--
-- rooms is read on almost every request (every message send reads it).
-- Give up rather than queue them all behind a long transaction.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS origin text;
--> statement-breakpoint
-- One statement, the id-shape rule of rooms/room-nature.ts originFromIdShape:
-- focus rooms by kind; then a join code (any letter case, as isInviteCode);
-- then a repository id (isRepoBackedRoomId); else a named room.
-- It writes only "origin": the triggers on rooms fire only for UPDATE OF id.
--
-- ASCII ids only. JavaScript upper-cases some other letters to ASCII ones
-- (the ligature "ﬀ" becomes "FF") and Postgres does not, so for those ids
-- this CASE could disagree with the server. After the migrations, the server
-- fills the rows left NULL with the same JavaScript rule
-- (db/room-origin-backfill.ts).
UPDATE rooms
   SET origin = CASE
     WHEN kind = 'focus' THEN 'focus'
     WHEN upper(id) ~ '^[A-Z0-9]{4}(-[A-Z0-9]{4}){1,2}$' THEN 'join_code'
     WHEN id ~ '^[A-Za-z0-9.-]+/[^/]+/[^/]+$' THEN 'repo'
     WHEN lower(split_part(id, '/', 1)) = 'gitlab.com'
       AND array_length(string_to_array(id, '/'), 1) >= 3 THEN 'repo'
     ELSE 'named'
   END
 WHERE origin IS NULL
   AND id ~ E'^[\\x01-\\x7f]*$';
--> statement-breakpoint
ALTER TABLE rooms ADD CONSTRAINT rooms_origin_check CHECK (
  origin IS NULL OR (
    origin IN ('join_code', 'repo', 'named', 'focus')
    AND (kind = 'focus') = (origin = 'focus')
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE rooms VALIDATE CONSTRAINT rooms_origin_check;
