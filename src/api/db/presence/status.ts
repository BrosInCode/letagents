import type { AgentPresenceStatus, RoomAgentSessionKind } from "../../../shared/agent-presence.js";
import { db } from "../client.js";
import { toRoomAgentPresence } from "../mappers.js";
import { room_agent_presence } from "../schema.js";
import type { RoomAgentPresence, RoomAgentPresenceRow } from "../types.js";

export interface UpsertRoomAgentPresenceInput {
  room_id: string;
  actor_label: string;
  agent_key?: string | null;
  agent_session_id?: string | null;
  session_kind?: RoomAgentSessionKind;
  runtime?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  repo_branch?: string | null;
  status: AgentPresenceStatus;
  status_text?: string | null;
}

export async function upsertRoomAgentPresenceTx(
  tx: any,
  input: UpsertRoomAgentPresenceInput,
  now = new Date().toISOString(),
): Promise<RoomAgentPresence> {
  const [presence] = await tx
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
      repo_branch: input.repo_branch ?? null,
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
        repo_branch: input.repo_branch ?? null,
        status: input.status,
        status_text: input.status_text ?? null,
        last_heartbeat_at: now,
        updated_at: now,
      },
    })
    .returning();

  return toRoomAgentPresence(presence as RoomAgentPresenceRow);
}

export async function upsertRoomAgentPresence(
  input: UpsertRoomAgentPresenceInput,
): Promise<RoomAgentPresence> {
  return upsertRoomAgentPresenceTx(db, input);
}
