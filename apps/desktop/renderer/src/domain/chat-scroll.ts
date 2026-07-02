import { normalizeRoomIdentifier } from "./sidebar-rooms";

export function chatScrollPositionKey(roomIdentifier: string | null | undefined): string | null {
  return normalizeRoomIdentifier(roomIdentifier);
}

export function shouldRememberChatScrollPosition(input: {
  roomIdentifier: string;
  selectedRoomIdentifier: string | null | undefined;
  selectedSnapshotLoading: boolean;
  suppressedRoomIdentifiers?: ReadonlySet<string>;
}): boolean {
  const normalizedRoomIdentifier = normalizeRoomIdentifier(input.roomIdentifier);
  const normalizedSelectedRoomIdentifier = normalizeRoomIdentifier(input.selectedRoomIdentifier);
  if (normalizedRoomIdentifier && input.suppressedRoomIdentifiers?.has(normalizedRoomIdentifier)) {
    return false;
  }
  return !(
    input.selectedSnapshotLoading
    && normalizedRoomIdentifier
    && normalizedRoomIdentifier === normalizedSelectedRoomIdentifier
  );
}
