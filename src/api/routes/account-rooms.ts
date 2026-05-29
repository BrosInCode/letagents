import type { Express } from "express";

import {
  archiveAccountRoomForAccount,
  deleteAccountRoomForAccount,
  getAccountRoomsForAccount,
  updateAccountRoomPreferences,
  type AccountRoomListEntry,
  type AccountRoomListFocusRoom,
} from "../account-room-membership.js";
import type { AuthenticatedRequest } from "../http/helpers.js";

export interface AccountRoomRouteDeps {
  getAccountRoomsForAccount(
    accountId: string,
    options?: {
      login?: string | null;
      limit?: number;
      includeArchived?: boolean;
    }
  ): Promise<AccountRoomListEntry[]>;
  archiveAccountRoomForAccount(input: {
    accountId: string;
    roomId: string;
    login?: string | null;
  }): Promise<{ room_id: string; archived: true; pinned: boolean } | null>;
  deleteAccountRoomForAccount(input: {
    accountId: string;
    roomId: string;
  }): Promise<{
    room_id: string;
    deleted: boolean;
    error?: "not_found" | "forbidden";
    reason?: string;
  }>;
  updateAccountRoomPreferences(input: {
    accountId: string;
    roomId: string;
    login?: string | null;
    pinned?: boolean;
    archived?: boolean;
  }): Promise<{ room_id: string; pinned: boolean; archived: boolean } | null>;
}

const defaultDeps: AccountRoomRouteDeps = {
  archiveAccountRoomForAccount,
  deleteAccountRoomForAccount,
  getAccountRoomsForAccount,
  updateAccountRoomPreferences,
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
    can_leave: room.can_leave,
    can_delete: room.can_delete,
    delete_reason: room.delete_reason,
    first_opened_at: room.first_opened_at,
    last_opened_at: room.last_opened_at,
    focus_rooms: room.focus_rooms.map(toAccountFocusRoomResponse),
  };
}

function accountRoomIdParam(req: AuthenticatedRequest): string {
  return decodeURIComponent((req.params as Record<string, string>)[0] || "").trim();
}

function booleanBodyValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
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

  app.post(/^\/account\/rooms\/(.+)\/leave$/, async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const roomId = accountRoomIdParam(req);
    if (!roomId) {
      res.status(400).json({ error: "Room identifier is required" });
      return;
    }

    const result = await deps.archiveAccountRoomForAccount({
      accountId: req.sessionAccount.account_id,
      roomId,
      login: req.sessionAccount.login,
    });

    if (!result) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    res.json(result);
  });

  app.patch(/^\/account\/rooms\/(.+)$/, async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const roomId = accountRoomIdParam(req);
    if (!roomId) {
      res.status(400).json({ error: "Room identifier is required" });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const pinned = booleanBodyValue(body.pinned);
    const archived = booleanBodyValue(body.archived);
    if (typeof pinned !== "boolean" && typeof archived !== "boolean") {
      res.status(400).json({ error: "No account room preference updates provided" });
      return;
    }

    const result = await deps.updateAccountRoomPreferences({
      accountId: req.sessionAccount.account_id,
      roomId,
      login: req.sessionAccount.login,
      pinned,
      archived,
    });

    if (!result) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    res.json(result);
  });

  app.delete(/^\/account\/rooms\/(.+)$/, async (req: AuthenticatedRequest, res) => {
    if (!req.sessionAccount) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const roomId = accountRoomIdParam(req);
    if (!roomId) {
      res.status(400).json({ error: "Room identifier is required" });
      return;
    }

    const result = await deps.deleteAccountRoomForAccount({
      accountId: req.sessionAccount.account_id,
      roomId,
    });

    if (result.error === "not_found") {
      res.status(404).json({ error: result.reason || "Room not found" });
      return;
    }

    if (result.error === "forbidden") {
      res.status(403).json({ error: result.reason || "Room cannot be deleted" });
      return;
    }

    res.json(result);
  });
}
