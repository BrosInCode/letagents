import { and, eq, inArray } from "drizzle-orm";

import { db } from "../client.js";
import { room_live_agent_suppressions } from "../schema.js";
import { normalizeRoomActorLabel } from "./helpers.js";

export async function getRoomLiveAgentSuppressionActorLabels(roomId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      actor_label: room_live_agent_suppressions.actor_label,
    })
    .from(room_live_agent_suppressions)
    .where(eq(room_live_agent_suppressions.room_id, roomId));

  return new Set(
    rows
      .map((row) => normalizeRoomActorLabel(row.actor_label))
      .filter(Boolean)
  );
}

export async function setRoomLiveAgentSuppressed(input: {
  room_id: string;
  actor_labels: readonly string[];
  suppressed: boolean;
  suppressed_by?: string | null;
}): Promise<number> {
  const actorLabels = Array.from(
    new Set(input.actor_labels.map((value) => normalizeRoomActorLabel(value)).filter(Boolean))
  );
  if (actorLabels.length === 0) {
    return 0;
  }

  if (!input.suppressed) {
    const result = await db
      .delete(room_live_agent_suppressions)
      .where(
        and(
          eq(room_live_agent_suppressions.room_id, input.room_id),
          inArray(room_live_agent_suppressions.actor_label, actorLabels)
        )
      );

    return Number(result.rowCount ?? 0);
  }

  const now = new Date().toISOString();
  const rows = await db
    .insert(room_live_agent_suppressions)
    .values(actorLabels.map((actorLabel) => ({
      room_id: input.room_id,
      actor_label: actorLabel,
      suppressed_by: input.suppressed_by ?? null,
      created_at: now,
      updated_at: now,
    })))
    .onConflictDoUpdate({
      target: [room_live_agent_suppressions.room_id, room_live_agent_suppressions.actor_label],
      set: {
        suppressed_by: input.suppressed_by ?? null,
        updated_at: now,
      },
    })
    .returning({
      actor_label: room_live_agent_suppressions.actor_label,
    });

  return rows.length;
}
