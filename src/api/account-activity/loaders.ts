import { and, asc, gt, inArray } from "drizzle-orm";

import { latestMessagesForRooms } from "../account-room-membership/list.js";
import { db } from "../db/client.js";
import { room_agent_presence } from "../db/schema.js";
import type { AccountActivityLoaders, WorkingPresence } from "./hub.js";

/** Statuses that mean an agent is doing something in the room right now. */
const WORKING_STATUSES = ["working", "reviewing"] as const;

export const databaseAccountActivityLoaders: AccountActivityLoaders = {
  async loadWorking(roomIds, sinceMs) {
    const result = new Map<string, WorkingPresence>();
    if (!roomIds.length) return result;
    const rows = await db
      .select({
        room_id: room_agent_presence.room_id,
        agent_key: room_agent_presence.agent_key,
        display_name: room_agent_presence.display_name,
        last_heartbeat_at: room_agent_presence.last_heartbeat_at,
      })
      .from(room_agent_presence)
      .where(and(
        inArray(room_agent_presence.room_id, [...roomIds]),
        inArray(room_agent_presence.status, [...WORKING_STATUSES]),
        gt(room_agent_presence.last_heartbeat_at, new Date(sinceMs).toISOString()),
      ))
      .orderBy(asc(room_agent_presence.room_id), asc(room_agent_presence.display_name), asc(room_agent_presence.actor_label));
    for (const row of rows) {
      const entry = result.get(row.room_id) ?? { agents: [], oldestHeartbeatMs: null };
      entry.agents.push({ agent_key: row.agent_key, display_name: row.display_name });
      const heartbeat = Date.parse(row.last_heartbeat_at);
      if (Number.isFinite(heartbeat)) {
        entry.oldestHeartbeatMs = entry.oldestHeartbeatMs === null ? heartbeat : Math.min(entry.oldestHeartbeatMs, heartbeat);
      }
      result.set(row.room_id, entry);
    }
    return result;
  },
  loadLatest: (roomIds) => latestMessagesForRooms([...roomIds]),
};
