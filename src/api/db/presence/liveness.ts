import { db } from "../client.js";
import { toRoomAgentLivenessObservation } from "../mappers.js";
import { room_agent_liveness_observations } from "../schema.js";
import type { RoomAgentLivenessObservation, RoomAgentLivenessObservationRow } from "../types.js";

export async function upsertRoomAgentLivenessObservation(input: {
  room_id: string;
  agent_session_id: string;
  source?: string | null;
  host_id?: string | null;
  host_kind?: string | null;
  host_label?: string | null;
  liveness_capability?: string | null;
  tool_bridge_id?: string | null;
  last_observed_at?: string | null;
  last_tool_call_at?: string | null;
  detail?: string | null;
}): Promise<RoomAgentLivenessObservation> {
  const now = new Date().toISOString();
  const lastObservedAt = input.last_observed_at ?? now;
  const source = input.source?.trim() || "agent_session";

  const [observation] = await db
    .insert(room_agent_liveness_observations)
    .values({
      room_id: input.room_id,
      agent_session_id: input.agent_session_id,
      source,
      host_id: input.host_id ?? null,
      host_kind: input.host_kind ?? null,
      host_label: input.host_label ?? null,
      liveness_capability: input.liveness_capability?.trim() || "session_activity",
      tool_bridge_id: input.tool_bridge_id ?? null,
      last_observed_at: lastObservedAt,
      last_tool_call_at: input.last_tool_call_at ?? lastObservedAt,
      detail: input.detail ?? null,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        room_agent_liveness_observations.room_id,
        room_agent_liveness_observations.agent_session_id,
        room_agent_liveness_observations.source,
      ],
      set: {
        host_id: input.host_id ?? null,
        host_kind: input.host_kind ?? null,
        host_label: input.host_label ?? null,
        liveness_capability: input.liveness_capability?.trim() || "session_activity",
        tool_bridge_id: input.tool_bridge_id ?? null,
        last_observed_at: lastObservedAt,
        last_tool_call_at: input.last_tool_call_at ?? lastObservedAt,
        detail: input.detail ?? null,
        updated_at: now,
      },
    })
    .returning();

  return toRoomAgentLivenessObservation(observation as RoomAgentLivenessObservationRow);
}
