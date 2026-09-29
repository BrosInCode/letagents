import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "./client.js";
import { messages, room_participants } from "./schema.js";
import { clampLimit } from "./utils.js";
import { toRoomParticipant } from "./mappers.js";
import type { RoomParticipant, RoomParticipantRow } from "./types.js";

export async function upsertRoomParticipant(input: {
  room_id: string;
  participant_key: string;
  kind: "human" | "agent";
  actor_label?: string | null;
  agent_key?: string | null;
  github_login?: string | null;
  display_name: string;
  owner_label?: string | null;
  ide_label?: string | null;
  last_seen_at?: string | null;
  preserve_last_seen_at_on_conflict?: boolean;
}): Promise<RoomParticipant> {
  const now = new Date().toISOString();
  const lastSeenAt = input.last_seen_at ?? now;

  const [participant] = await db
    .insert(room_participants)
    .values({
      room_id: input.room_id,
      participant_key: input.participant_key,
      kind: input.kind,
      actor_label: input.actor_label ?? null,
      agent_key: input.agent_key ?? null,
      github_login: input.github_login ?? null,
      display_name: input.display_name,
      owner_label: input.owner_label ?? null,
      ide_label: input.ide_label ?? null,
      hidden_at: null,
      hidden_by: null,
      last_seen_at: lastSeenAt,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [room_participants.room_id, room_participants.participant_key],
      set: {
        kind: input.kind,
        actor_label: input.actor_label ?? null,
        // A caller that does not know the owner must not erase one that is
        // already recorded: registration reads it to tell an agent's own
        // history from another agent's.
        agent_key: input.kind === "human"
          ? null
          : (input.agent_key || sql`${room_participants.agent_key}`),
        github_login: input.github_login ?? null,
        display_name: input.display_name,
        owner_label: input.owner_label ?? null,
        ide_label: input.ide_label ?? null,
        hidden_at: null,
        hidden_by: null,
        last_seen_at: input.preserve_last_seen_at_on_conflict
          ? sql`${room_participants.last_seen_at}`
          : lastSeenAt,
        updated_at: now,
      },
    })
    .returning();

  return toRoomParticipant(participant as RoomParticipantRow);
}

/**
 * Owners of participant rows that were recorded without one, proven by the
 * room's own messages. A label is proven only when every authenticated
 * message sent under it came from one agent key; a label two agents have
 * spoken under proves nothing and is left out.
 *
 * This reads the room's messages, so call it only for the few labels a
 * decision depends on.
 */
export async function getParticipantOwnersProvenByMessages(input: {
  room_id: string;
  actor_labels: readonly string[];
}): Promise<Map<string, string>> {
  const labels = [...new Set(input.actor_labels.filter(Boolean))].slice(0, 32);
  if (labels.length === 0) return new Map();
  const rows = await db
    .selectDistinct({ sender: messages.sender, agent_key: messages.publisher_agent_key })
    .from(messages)
    .where(and(
      eq(messages.room_id, input.room_id),
      inArray(messages.sender, labels),
      isNotNull(messages.publisher_agent_key),
    ));
  const keysByLabel = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.agent_key) continue;
    const keys = keysByLabel.get(row.sender) ?? new Set<string>();
    keys.add(row.agent_key);
    keysByLabel.set(row.sender, keys);
  }
  const proven = new Map<string, string>();
  for (const [label, keys] of keysByLabel) {
    if (keys.size === 1) proven.set(label, keys.values().next().value!);
  }
  return proven;
}

/** Record a proven owner on a participant row that has none. Never replaces one. */
export async function claimRoomParticipantOwner(input: {
  room_id: string;
  participant_key: string;
  agent_key: string;
}): Promise<void> {
  await db.update(room_participants)
    .set({ agent_key: input.agent_key })
    .where(and(
      eq(room_participants.room_id, input.room_id),
      eq(room_participants.participant_key, input.participant_key),
      eq(room_participants.kind, "agent"),
      isNull(room_participants.agent_key),
    ));
}

export async function getRoomParticipants(
  roomId: string,
  options?: { limit?: number; includeHidden?: boolean }
): Promise<RoomParticipant[]> {
  const limit = clampLimit(options?.limit, 50, 200);
  const conditions = [eq(room_participants.room_id, roomId)];
  if (!options?.includeHidden) {
    conditions.push(sql`${room_participants.hidden_at} IS NULL`);
  }

  const rows = await db
    .select()
    .from(room_participants)
    .where(and(...conditions))
    .orderBy(desc(room_participants.last_seen_at), asc(room_participants.display_name))
    .limit(limit);

  return (rows as RoomParticipantRow[]).map(toRoomParticipant);
}

export async function getRoomParticipantsForRooms(
  roomIds: readonly string[],
  options?: { includeHidden?: boolean }
): Promise<RoomParticipant[]> {
  if (roomIds.length === 0) {
    return [];
  }

  const conditions = [inArray(room_participants.room_id, [...roomIds])];
  if (!options?.includeHidden) {
    conditions.push(sql`${room_participants.hidden_at} IS NULL`);
  }

  const rows = await db
    .select()
    .from(room_participants)
    .where(and(...conditions))
    .orderBy(desc(room_participants.last_seen_at), asc(room_participants.display_name));

  return (rows as RoomParticipantRow[]).map(toRoomParticipant);
}

export async function setRoomParticipantsHidden(input: {
  room_id: string;
  participant_keys: readonly string[];
  hidden: boolean;
  hidden_by?: string | null;
}): Promise<number> {
  if (input.participant_keys.length === 0) {
    return 0;
  }

  const now = new Date().toISOString();
  const result = await db
    .update(room_participants)
    .set({
      hidden_at: input.hidden ? now : null,
      hidden_by: input.hidden ? input.hidden_by ?? null : null,
      updated_at: now,
    })
    .where(
      and(
        eq(room_participants.room_id, input.room_id),
        inArray(room_participants.participant_key, [...input.participant_keys])
      )
    );

  return Number(result.rowCount ?? 0);
}
