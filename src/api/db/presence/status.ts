import type { AgentPresenceStatus, RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import { db } from "../client.js";
import { toRoomAgentPresence } from "../mappers.js";
import { room_agent_presence } from "../schema.js";
import type { RoomAgentPresence, RoomAgentPresenceRow } from "../types.js";

export async function upsertRoomAgentPresence(input: {
  room_id: string;
  actor_label: string;
  agent_key?: string | null;
  agent_session_id?: string | null;
  session_kind?: RoomAgentSessionKind;
  runtime?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  status: AgentPresenceStatus;
  status_text?: string | null;
}): Promise<RoomAgentPresence> {
  const now = new Date().toISOString();

  const [presence] = await db
    .insert(room_agent_presence)
    .values({
      room_id: input.room_id,
      actor_label: input.actor_label,
      agent_key: input.agent_key ?? null,
      agent_session_id: input.agent_session_id ?? null,
      session_kind: input.session_kind ?? "controller",
      runtime: input.runtime ?? "unknown",
      display_name: input.display_name,
      owner_label: input.owner_label ?? null,
      ide_label: input.ide_label ?? null,
      status: input.status,
      status_text: input.status_text ?? null,
      last_heartbeat_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [room_agent_presence.room_id, room_agent_presence.actor_label],
      set: {
        agent_key: input.agent_key ?? null,
        agent_session_id: input.agent_session_id ?? null,
        session_kind: input.session_kind ?? "controller",
        runtime: input.runtime ?? "unknown",
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        status: input.status,
        status_text: input.status_text ?? null,
        last_heartbeat_at: now,
        updated_at: now,
      },
    })
    .returning();

  return toRoomAgentPresence(presence as RoomAgentPresenceRow);
}
