import { and, eq, inArray, or } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  account_room_recents,
  project_admins,
  room_agent_sessions,
  room_participants,
  rooms,
} from "../db/schema.js";

export async function accountHasRoomAssociation(input: {
  accountId: string;
  roomId: string;
  login?: string | null;
}): Promise<boolean> {
  const focusRoomRows = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.kind, "focus"), eq(rooms.parent_room_id, input.roomId)));
  const associatedRoomIds = [input.roomId, ...focusRoomRows.map((row) => row.id)];

  const [adminRow] = await db
    .select({ account_id: project_admins.account_id })
    .from(project_admins)
    .where(
      and(
        inArray(project_admins.project_id, associatedRoomIds),
        eq(project_admins.account_id, input.accountId)
      )
    )
    .limit(1);
  if (adminRow) return true;

  const [agentSessionRow] = await db
    .select({ room_id: room_agent_sessions.room_id })
    .from(room_agent_sessions)
    .where(
      and(
        inArray(room_agent_sessions.room_id, associatedRoomIds),
        eq(room_agent_sessions.owner_account_id, input.accountId)
      )
    )
    .limit(1);
  if (agentSessionRow) return true;

  const [recentRow] = await db
    .select({ room_id: account_room_recents.room_id })
    .from(account_room_recents)
    .where(
      and(
        eq(account_room_recents.account_id, input.accountId),
        inArray(account_room_recents.room_id, associatedRoomIds)
      )
    )
    .limit(1);
  if (recentRow) return true;

  const normalizedLogin = input.login?.trim().toLowerCase() || null;
  if (!normalizedLogin) return false;
  const loginValue = input.login?.trim() || normalizedLogin;
  const [participantRow] = await db
    .select({ room_id: room_participants.room_id })
    .from(room_participants)
    .where(
      and(
        inArray(room_participants.room_id, associatedRoomIds),
        eq(room_participants.kind, "human"),
        or(
          eq(room_participants.github_login, loginValue),
          eq(room_participants.participant_key, `human:login:${normalizedLogin}`)
        )
      )
    )
    .limit(1);

  return Boolean(participantRow);
}
