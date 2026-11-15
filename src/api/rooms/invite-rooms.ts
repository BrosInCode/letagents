import { pool } from "../db/client.js";
import { getGitRoomBindingsForRooms } from "../db/git-room-bindings.js";
import { classifyTopLevelRooms } from "./access-decision.js";

/** A members-only room the account may invite a bot into. */
export interface InviteRoom {
  id: string;
  display_name: string;
  role: "admin" | "member";
  member_count: number;
}

interface StoredInviteRoom {
  id: string;
  kind: string;
  origin: string | null;
  display_name: string;
  role: "admin" | "member";
  member_count: number;
}

/**
 * The top-level rooms where the account is a member or an admin, without the
 * rooms a GitHub repository decides (a repo room, or a room bound to one).
 * Rooms the account opened last come first; archived rooms are left out.
 * An admin's invite lets a bot in; a member's asks the admins.
 */
export async function listInviteRooms(accountId: string): Promise<InviteRoom[]> {
  const result = await pool.query<StoredInviteRoom>(`SELECT room.id, room.kind, room.origin, room.display_name,
      CASE WHEN EXISTS (SELECT 1 FROM project_admins WHERE project_id = room.id AND account_id = $1)
        THEN 'admin' ELSE 'member' END AS role,
      (SELECT count(*)::int FROM (
        SELECT account_id FROM room_members WHERE room_id = room.id
        UNION
        SELECT account_id FROM project_admins WHERE project_id = room.id
      ) AS people) AS member_count
    FROM rooms AS room
    LEFT JOIN account_room_recents AS recent ON recent.account_id = $1 AND recent.room_id = room.id
    WHERE room.kind = 'main'
      AND room.origin IS DISTINCT FROM 'repo'
      AND COALESCE(recent.archived, false) = false
      AND (
        EXISTS (SELECT 1 FROM room_members WHERE room_id = room.id AND account_id = $1)
        OR EXISTS (SELECT 1 FROM project_admins WHERE project_id = room.id AND account_id = $1))
    ORDER BY recent.last_opened_at DESC NULLS LAST, lower(room.display_name), room.id
    LIMIT 200`, [accountId]);
  const rows = result.rows;
  const bindings = await getGitRoomBindingsForRooms(rows.map((row) => row.id));
  const kinds = classifyTopLevelRooms(rows, bindings);
  return rows
    .filter((row) => kinds.get(row.id) === "membership")
    .map((row) => ({ id: row.id, display_name: row.display_name, role: row.role, member_count: row.member_count }));
}
