import type { Project } from "./db.js";
import type { AuthenticatedRequest } from "./http-helpers.js";

import { normalizeFocusRoomSettings } from "./focus-room-settings.js";
import { LETAGENTS_ORIGIN_ROOM_ID_HEADER } from "../shared/request-headers.js";

type FocusRoomWriteIsolationRoom = Pick<
  Project,
  | "id"
  | "kind"
  | "parent_room_id"
  | "focus_parent_visibility"
  | "focus_activity_scope"
  | "focus_github_event_routing"
>;

export type FocusParentBoardWriteIsolationDecision =
  | { kind: "allow" }
  | {
      kind: "deny";
      code: "focus_parent_board_read_only";
      error: string;
    };

export interface FocusParentBoardWriteIsolationDeps {
  getProjectById(id: string): Promise<FocusRoomWriteIsolationRoom | undefined>;
}

export const FOCUS_PARENT_BOARD_WRITE_ISOLATION_ERROR =
  "This Focus Room is configured to keep task work inside the room. Parent board writes are read-only from here; continue inside the Focus Room or change the Focus Room activity scope.";

function normalizeOriginRoomId(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || null;
}

export function getOriginRoomIdFromRequest(
  req: Pick<AuthenticatedRequest, "headers">
): string | null {
  return normalizeOriginRoomId(
    req.headers[LETAGENTS_ORIGIN_ROOM_ID_HEADER.toLowerCase()]
  );
}

export function shouldIsolateFocusRoomParentBoardWrites(input: {
  originRoom: FocusRoomWriteIsolationRoom | null | undefined;
  targetProjectId: string;
}): boolean {
  const { originRoom, targetProjectId } = input;
  if (!originRoom || originRoom.kind !== "focus") {
    return false;
  }

  if (!originRoom.parent_room_id || originRoom.parent_room_id !== targetProjectId) {
    return false;
  }

  const settings = normalizeFocusRoomSettings({
    parent_visibility: originRoom.focus_parent_visibility,
    activity_scope: originRoom.focus_activity_scope,
    github_event_routing: originRoom.focus_github_event_routing,
  });

  return settings.activity_scope === "room";
}

export function createFocusParentBoardWriteIsolationEnforcer(
  deps: FocusParentBoardWriteIsolationDeps
) {
  return async function enforceFocusParentBoardWriteIsolation(input: {
    req: Pick<AuthenticatedRequest, "authKind" | "headers">;
    targetProjectId: string;
  }): Promise<FocusParentBoardWriteIsolationDecision> {
    if (input.req.authKind !== "owner_token") {
      return { kind: "allow" };
    }

    const originRoomId = getOriginRoomIdFromRequest(input.req);
    if (!originRoomId || originRoomId === input.targetProjectId) {
      return { kind: "allow" };
    }

    const originRoom = await deps.getProjectById(originRoomId);
    if (
      !shouldIsolateFocusRoomParentBoardWrites({
        originRoom,
        targetProjectId: input.targetProjectId,
      })
    ) {
      return { kind: "allow" };
    }

    return {
      kind: "deny",
      code: "focus_parent_board_read_only",
      error: FOCUS_PARENT_BOARD_WRITE_ISOLATION_ERROR,
    };
  };
}
