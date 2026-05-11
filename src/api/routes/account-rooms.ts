import type { Express } from "express";

import {
  getAccountRoomsForAccount,
  type AccountRoomListEntry,
  type AccountRoomListFocusRoom,
} from "../account-room-membership.js";
import type { AuthenticatedRequest } from "../http-helpers.js";

export interface AccountRoomRouteDeps {
  getAccountRoomsForAccount(
    accountId: string,
    options?: {
      login?: string | null;
      limit?: number;
      includeArchived?: boolean;
    }
  ): Promise<AccountRoomListEntry[]>;
}

const defaultDeps: AccountRoomRouteDeps = {
  getAccountRoomsForAccount,
};

function toAccountFocusRoomResponse(room: AccountRoomListFocusRoom): Record<string, unknown> {
  return {
    room_id: room.room_id,
    id: room.room_id,
    display_name: room.display_name,
    name: room.room_id,
    kind: room.kind,
    parent_room_id: room.parent_room_id,
    focus_key: room.focus_key,
    source_task_id: room.source_task_id,
    focus_status: room.focus_status,
    role: room.role,
    source: room.source,
    first_opened_at: room.first_opened_at,
    last_opened_at: room.last_opened_at,
  };
}

function toAccountRoomResponse(room: AccountRoomListEntry): Record<string, unknown> {
  return {
    room_id: room.room_id,
    id: room.room_id,
    display_name: room.display_name,
    name: room.room_id,
    kind: room.kind,
    parent_room_id: null,
    focus_key: null,
    source_task_id: null,
    focus_status: null,
    role: room.role,
    source: room.source,
    pinned: room.pinned,
    archived: room.archived,
    first_opened_at: room.first_opened_at,
    last_opened_at: room.last_opened_at,
    focus_rooms: room.focus_rooms.map(toAccountFocusRoomResponse),
  };
}

export function registerAccountRoomRoutes(
  app: Express,
  deps: AccountRoomRouteDeps = defaultDeps
): void {
  app.get("/account/rooms", async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const limit = Number.parseInt(String(req.query.limit || "50"), 10);
    const rooms = await deps.getAccountRoomsForAccount(req.sessionAccount.account_id, {
      login: req.sessionAccount.login,
      limit: Number.isFinite(limit) ? limit : 50,
      includeArchived: String(req.query.include_archived || "").toLowerCase() === "true",
    });

    res.json({ rooms: rooms.map(toAccountRoomResponse) });
  });
}
