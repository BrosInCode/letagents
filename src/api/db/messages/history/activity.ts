import { and, eq, sql } from "drizzle-orm";

import { db } from "../../client.js";
import { messages } from "../../schema.js";
import type { RoomActivityActorCount } from "../../types.js";
import { readRoomMessageCountsBySender } from "./activity-counts.js";

export async function getRoomMessageCountsBySender(roomId: string): Promise<RoomActivityActorCount[]> {
  // Incremental: a repeat request reads only messages added since the last one.
  return readRoomMessageCountsBySender(roomId);
}

export async function hasMessagesFromSender(roomId: string, sender: string): Promise<boolean> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)::int`,
    })
    .from(messages)
    .where(and(eq(messages.room_id, roomId), sql`LOWER(${messages.sender}) = LOWER(${sender})`));

  return (row?.count ?? 0) > 0;
}
