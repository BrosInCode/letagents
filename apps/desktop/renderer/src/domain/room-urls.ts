export const LETAGENTS_ROOM_ORIGIN = "https://letagents.chat";

export function encodeRoomPathIdentifier(identifier: string): string {
  return String(identifier)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function isLocalRoomIdentifier(identifier: string | null | undefined): boolean {
  const value = identifier?.trim() || "";
  return /^local[_-]/i.test(value) || /^git-room:local:/i.test(value);
}

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

export function buildLetAgentsRoomLikeCopyValue(
  input: {
    identifier?: string | null;
    roomIdentifier?: string | null;
    kind?: "main" | "focus" | string | null;
    parentRoomId?: string | null;
    focusKey?: string | null;
    sourceTaskId?: string | null;
    localOnly?: boolean;
  },
  origin = LETAGENTS_ROOM_ORIGIN,
): string {
  const roomIdentifier = input.roomIdentifier ?? input.identifier;
  if (input.kind === "focus") {
    if (!input.parentRoomId?.trim() || !(input.focusKey?.trim() || input.sourceTaskId?.trim())) {
      return roomIdentifier?.trim() || "";
    }
    return buildLetAgentsFocusRoomUrl({
      roomIdentifier,
      parentRoomId: input.parentRoomId,
      focusKey: input.focusKey,
      sourceTaskId: input.sourceTaskId,
    }, origin);
  }
  return buildLetAgentsRoomCopyValue(roomIdentifier, { localOnly: input.localOnly }, origin);
}
