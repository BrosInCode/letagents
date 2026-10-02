export {
  LETAGENTS_ROOM_ORIGIN,
  MESSAGE_ID_PATTERN,
  isValidMessageId,
  encodeRoomPathIdentifier,
  decodeRoomPath,
  isLocalRoomIdentifier,
  buildLetAgentsMessageUrl,
  parseLetAgentsMessageUrl,
  resolveSameRoomMessageReference,
} from "../../../../../shared/room-message-urls.mjs";

import {
  LETAGENTS_ROOM_ORIGIN,
  encodeRoomPathIdentifier,
  isLocalRoomIdentifier,
} from "../../../../../shared/room-message-urls.mjs";

export function buildLetAgentsRoomUrl(
  identifier: string | null | undefined,
  origin = LETAGENTS_ROOM_ORIGIN,
): string {
  const value = identifier?.trim();
  if (!value) return "";
  return `${origin.replace(/\/+$/, "")}/in/${encodeRoomPathIdentifier(value)}`;
}

export function buildLetAgentsRoomCopyValue(
  identifier: string | null | undefined,
  input: { localOnly?: boolean } = {},
  origin = LETAGENTS_ROOM_ORIGIN,
): string {
  const value = identifier?.trim();
  if (!value) return "";
  return input.localOnly || isLocalRoomIdentifier(value)
    ? value
    : buildLetAgentsRoomUrl(value, origin);
}

export function buildLetAgentsFocusRoomUrl(
  input: {
    roomIdentifier?: string | null;
    parentRoomId?: string | null;
    focusKey?: string | null;
    sourceTaskId?: string | null;
  },
  origin = LETAGENTS_ROOM_ORIGIN,
): string {
  const parentRoomId = input.parentRoomId?.trim();
  const focusKey = input.focusKey?.trim() || input.sourceTaskId?.trim();
  if (parentRoomId && isLocalRoomIdentifier(parentRoomId)) {
    return input.roomIdentifier?.trim() || parentRoomId;
  }
  if (parentRoomId && focusKey) {
    return `${origin.replace(/\/+$/, "")}/in/${encodeRoomPathIdentifier(parentRoomId)}/focus/${
      encodeURIComponent(focusKey)
    }`;
  }
  return buildLetAgentsRoomCopyValue(input.roomIdentifier, {}, origin);
}
