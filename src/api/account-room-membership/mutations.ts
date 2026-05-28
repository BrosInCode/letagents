import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  account_room_recents,
  project_admins,
  rooms,
} from "../db/schema.js";
import { isInviteCode } from "../room-routing.js";
import { accountHasRoomAssociation } from "./association.js";

export async function upsertAccountRoomRecent(input: {
  accountId: string;
  roomId: string;
  displayName?: string | null;
  source?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(account_room_recents)
    .values({
      account_id: input.accountId,
      room_id: input.roomId,
      display_name: input.displayName ?? null,
      source: input.source ?? null,
      pinned: false,
      archived: false,
      first_opened_at: now,
      last_opened_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [account_room_recents.account_id, account_room_recents.room_id],
      set: {
        display_name: input.displayName ?? null,
        source: sql`CASE WHEN ${account_room_recents.source} = 'create_invite' THEN ${account_room_recents.source} ELSE ${input.source ?? null} END`,
        archived: false,
        last_opened_at: now,
        updated_at: now,
      },
    });
}

export async function archiveAccountRoomForAccount(input: {
  accountId: string;
  roomId: string;
  login?: string | null;
}): Promise<{ room_id: string; archived: true; pinned: boolean } | null> {
  const [room] = await db
    .select({ id: rooms.id, display_name: rooms.display_name, created_at: rooms.created_at })
    .from(rooms)
    .where(eq(rooms.id, input.roomId))
    .limit(1);

  if (!room) {
    return null;
  }

  const hasAssociation = await accountHasRoomAssociation({
    accountId: input.accountId,
    roomId: room.id,
    login: input.login,
  });
  if (!hasAssociation) {
    return null;
  }

  const now = new Date().toISOString();
  const [updated] = await db
    .insert(account_room_recents)
    .values({
      account_id: input.accountId,
      room_id: room.id,
      display_name: room.display_name,
      source: "left_room",
      pinned: false,
      archived: true,
      first_opened_at: now,
      last_opened_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [account_room_recents.account_id, account_room_recents.room_id],
      set: {
        archived: true,
        updated_at: now,
      },
    })
    .returning({
      room_id: account_room_recents.room_id,
      archived: account_room_recents.archived,
      pinned: account_room_recents.pinned,
    });

  return updated ? { room_id: updated.room_id, archived: true, pinned: updated.pinned } : null;
}

export async function deleteAccountRoomForAccount(input: {
  accountId: string;
  roomId: string;
}): Promise<{
  room_id: string;
  deleted: boolean;
  error?: "not_found" | "forbidden";
  reason?: string;
}> {
  const [room] = await db
    .select({ id: rooms.id, kind: rooms.kind })
    .from(rooms)
    .where(eq(rooms.id, input.roomId))
    .limit(1);

  if (!room) {
    return {
      room_id: input.roomId,
      deleted: false,
      error: "not_found",
      reason: "Room not found.",
    };
  }

  if (room.kind !== "main" || !isInviteCode(room.id)) {
    return {
      room_id: room.id,
      deleted: false,
      error: "forbidden",
      reason: "Only invite rooms can be deleted from account settings.",
    };
  }

  const [adminRow] = await db
    .select({ account_id: project_admins.account_id })
    .from(project_admins)
    .where(
      and(
        eq(project_admins.project_id, room.id),
        eq(project_admins.account_id, input.accountId)
      )
    )
    .limit(1);

  if (!adminRow) {
    return {
      room_id: room.id,
      deleted: false,
      error: "forbidden",
      reason: "Only room admins can delete this room.",
    };
  }

  const [recentRow] = await db
    .select({ source: account_room_recents.source })
    .from(account_room_recents)
    .where(
      and(
        eq(account_room_recents.account_id, input.accountId),
        eq(account_room_recents.room_id, room.id)
      )
    )
    .limit(1);

  if (recentRow?.source !== "create_invite") {
    return {
      room_id: room.id,
      deleted: false,
      error: "forbidden",
      reason: "LetAgents can only delete invite rooms this account created.",
    };
  }

  await db.delete(rooms).where(eq(rooms.id, room.id));

  return {
    room_id: room.id,
    deleted: true,
  };
}

export async function updateAccountRoomPreferences(input: {
  accountId: string;
  roomId: string;
  login?: string | null;
  pinned?: boolean;
  archived?: boolean;
}): Promise<{ room_id: string; pinned: boolean; archived: boolean } | null> {
  if (typeof input.pinned !== "boolean" && typeof input.archived !== "boolean") {
    return null;
  }

  const [room] = await db
    .select({ id: rooms.id, display_name: rooms.display_name })
    .from(rooms)
    .where(eq(rooms.id, input.roomId))
    .limit(1);

  if (!room) {
    return null;
  }

  const hasAssociation = await accountHasRoomAssociation({
    accountId: input.accountId,
    roomId: room.id,
    login: input.login,
  });
  if (!hasAssociation) {
    return null;
  }

  const now = new Date().toISOString();
  const insertPinned = input.pinned ?? false;
  const insertArchived = input.archived ?? false;
  const [updated] = await db
    .insert(account_room_recents)
    .values({
      account_id: input.accountId,
      room_id: room.id,
      display_name: room.display_name,
      source: "settings",
      pinned: insertPinned,
      archived: insertArchived,
      first_opened_at: now,
      last_opened_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [account_room_recents.account_id, account_room_recents.room_id],
      set: {
        display_name: room.display_name,
        pinned: typeof input.pinned === "boolean" ? input.pinned : sql`${account_room_recents.pinned}`,
        archived: typeof input.archived === "boolean" ? input.archived : sql`${account_room_recents.archived}`,
        updated_at: now,
      },
    })
    .returning({
      room_id: account_room_recents.room_id,
      pinned: account_room_recents.pinned,
      archived: account_room_recents.archived,
    });

  return updated ?? null;
}
