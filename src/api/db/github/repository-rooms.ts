import { sql } from "drizzle-orm";

/**
 * Rooms whose GitHub events concern a room: itself, its parent, every room
 * bound to the same repository, and their focus rooms. Events land in a
 * branch room, a focus room or the repository room depending on routing; a
 * reader of one branch or pull request should not care which. A subquery,
 * not a list, so a repository with thousands of branch rooms is never
 * truncated.
 */
export function repositoryRoomIds(roomId: string) {
  return sql`(
    WITH anchor AS (
      SELECT ${roomId}::text AS room_id
      UNION SELECT room.parent_room_id FROM rooms AS room WHERE room.id = ${roomId} AND room.parent_room_id IS NOT NULL
    ), family AS (
      SELECT room_id FROM anchor
      UNION SELECT binding.room_id
        FROM room_git_bindings AS binding
        JOIN room_git_bindings AS bound
          ON bound.provider = binding.provider
         AND bound.host = binding.host
         AND bound.repository_full_name = binding.repository_full_name
       WHERE bound.room_id IN (SELECT room_id FROM anchor)
    )
    SELECT room_id FROM family
    UNION SELECT room.id FROM rooms AS room WHERE room.parent_room_id IN (SELECT room_id FROM family)
  )`;
}
