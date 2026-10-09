import { eq, inArray, sql } from "drizzle-orm";
import {
  GITHUB_ROOM_CHAT_EVENT_KINDS,
  normalizeGitHubRoomChatEventKinds,
  normalizeRoomAgentReplyOrder,
  type GitHubRoomChatEventKind,
  type RoomAgentReplyOrder,
} from "../../../shared/room-settings.mjs";
import { db } from "./client.js";
import { room_settings } from "./schema.js";

export interface ResolvedGitHubRoomChatEventKinds {
  enabled_kinds: GitHubRoomChatEventKind[];
  /** The room whose choice applies, or null when no candidate has chosen. */
  source_room_id: string | null;
}

export interface StoredRoomAgentGuidelines {
  guidelines: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** The kinds each of these rooms has chosen. A room that has not chosen is absent. */
export async function loadGitHubRoomChatEventKinds(
  roomIds: readonly string[],
): Promise<Map<string, GitHubRoomChatEventKind[]>> {
  const chosen = new Map<string, GitHubRoomChatEventKind[]>();
  const ids = [...new Set(roomIds.filter(Boolean))];
  if (!ids.length) return chosen;
  const rows = await db
    .select({ room_id: room_settings.room_id, kinds: room_settings.github_chat_event_kinds })
    .from(room_settings)
    .where(inArray(room_settings.room_id, ids));
  for (const row of rows) {
    const kinds = normalizeGitHubRoomChatEventKinds(row.kinds);
    if (kinds) chosen.set(row.room_id, kinds);
  }
  return chosen;
}

/**
 * The first candidate that has chosen its kinds decides. Callers list the room
 * itself first, then the rooms it inherits from. With no choice anywhere every
 * kind is posted, which is how rooms behaved before this setting existed.
 */
export async function resolveGitHubRoomChatEventKinds(
  candidateRoomIds: readonly string[],
): Promise<ResolvedGitHubRoomChatEventKinds> {
  const ids = [...new Set(candidateRoomIds.filter(Boolean))];
  const chosen = await loadGitHubRoomChatEventKinds(ids);
  for (const id of ids) {
    const kinds = chosen.get(id);
    if (kinds) return { enabled_kinds: kinds, source_room_id: id };
  }
  return { enabled_kinds: [...GITHUB_ROOM_CHAT_EVENT_KINDS], source_room_id: null };
}

export async function setGitHubRoomChatEventKinds(
  roomId: string,
  kinds: readonly GitHubRoomChatEventKind[],
): Promise<void> {
  const value = [...kinds];
  await db
    .insert(room_settings)
    .values({ room_id: roomId, github_chat_event_kinds: value })
    .onConflictDoUpdate({
      target: room_settings.room_id,
      set: { github_chat_event_kinds: value, updated_at: sql`now()` },
    });
}

export async function getRoomAgentGuidelines(roomId: string): Promise<StoredRoomAgentGuidelines> {
  const [row] = await db
    .select({
      guidelines: room_settings.agent_guidelines,
      updated_by: room_settings.agent_guidelines_updated_by,
      updated_at: room_settings.agent_guidelines_updated_at,
    })
    .from(room_settings)
    .where(eq(room_settings.room_id, roomId));
  return row ?? { guidelines: null, updated_by: null, updated_at: null };
}

/**
 * The first candidate that has guidelines decides, so work in a focus room or a
 * branch room follows the rules of the room it belongs to.
 */
export async function resolveRoomAgentGuidelines(
  candidateRoomIds: readonly string[],
): Promise<StoredRoomAgentGuidelines & { source_room_id: string | null }> {
  const ids = [...new Set(candidateRoomIds.filter(Boolean))];
  if (ids.length) {
    const rows = await db
      .select({
        room_id: room_settings.room_id,
        guidelines: room_settings.agent_guidelines,
        updated_by: room_settings.agent_guidelines_updated_by,
        updated_at: room_settings.agent_guidelines_updated_at,
      })
      .from(room_settings)
      .where(inArray(room_settings.room_id, ids));
    for (const id of ids) {
      const row = rows.find((candidate) => candidate.room_id === id);
      if (row?.guidelines) {
        return { guidelines: row.guidelines, updated_by: row.updated_by, updated_at: row.updated_at, source_room_id: id };
      }
    }
  }
  return { guidelines: null, updated_by: null, updated_at: null, source_room_id: null };
}

/** An empty string clears the guidelines. The caller has already enforced the limit. */
export async function setRoomAgentGuidelines(
  roomId: string,
  guidelines: string,
  updatedBy: string,
): Promise<StoredRoomAgentGuidelines> {
  const value = guidelines || null;
  const [row] = await db
    .insert(room_settings)
    .values({
      room_id: roomId,
      agent_guidelines: value,
      agent_guidelines_updated_by: updatedBy,
      agent_guidelines_updated_at: sql`now()`,
    })
    .onConflictDoUpdate({
      target: room_settings.room_id,
      set: {
        agent_guidelines: value,
        agent_guidelines_updated_by: updatedBy,
        agent_guidelines_updated_at: sql`now()`,
        updated_at: sql`now()`,
      },
    })
    .returning({
      guidelines: room_settings.agent_guidelines,
      updated_by: room_settings.agent_guidelines_updated_by,
      updated_at: room_settings.agent_guidelines_updated_at,
    });
  return row;
}

/** The order this room chose, or null when it has not chosen (parallel applies). */
export async function getRoomAgentReplyOrder(roomId: string): Promise<RoomAgentReplyOrder | null> {
  const [row] = await db
    .select({ order: room_settings.agent_reply_order })
    .from(room_settings)
    .where(eq(room_settings.room_id, roomId));
  return normalizeRoomAgentReplyOrder(row?.order);
}

/** null returns the room to the default (parallel) without choosing it. */
export async function setRoomAgentReplyOrder(roomId: string, order: RoomAgentReplyOrder | null): Promise<void> {
  await db
    .insert(room_settings)
    .values({ room_id: roomId, agent_reply_order: order })
    .onConflictDoUpdate({
      target: room_settings.room_id,
      set: { agent_reply_order: order, updated_at: sql`now()` },
    });
}
