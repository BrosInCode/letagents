import { and, eq, sql } from "drizzle-orm";

import { db } from "../../client.js";
import { messages } from "../../schema.js";
import type { RoomActivityActorCount } from "../../types.js";
import { visibleMessageCondition } from "../visibility.js";

export async function getRoomMessageCountsBySender(roomId: string): Promise<RoomActivityActorCount[]> {
  const rows = await db
    .select({
      actor_label: messages.sender,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(messages)
    .where(and(
      eq(messages.room_id, roomId),
      visibleMessageCondition(false),
    ))
    .groupBy(messages.sender);

  return rows.map((row) => ({
    actor_label: row.actor_label,
    count: Number(row.count) || 0,
  }));
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
