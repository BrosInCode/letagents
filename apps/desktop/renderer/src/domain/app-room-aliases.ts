// Pure room identity helpers used by App.vue's composables.

import type { DesktopAccountRoomEntry, DesktopRoomSnapshot } from "../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "./sidebar-rooms";

export function gitRoomsShareRepo(
  left: NonNullable<DesktopRoomSnapshot["room"]>["gitRoom"],
  right: NonNullable<DesktopRoomSnapshot["room"]>["gitRoom"],
): boolean {
  if (!left || !right) return false;
  const leftRepo = left.repository.id || `${left.host}:${left.repository.fullName}`.toLowerCase();
  const rightRepo = right.repository.id || `${right.host}:${right.repository.fullName}`.toLowerCase();
  return left.provider === right.provider && left.host === right.host && leftRepo === rightRepo;
}

export function roomAliasSet(values: readonly (string | null | undefined)[]): Set<string> {
  return new Set(
    values
      .map(normalizeRoomIdentifier)
      .filter((value): value is string => Boolean(value)),
  );
}

export function roomMatchesAliases(room: DesktopAccountRoomEntry, aliases: Set<string>): boolean {
  return [
    room.roomIdentifier,
    room.displayName,
    room.name,
  ].some((value) => aliases.has(normalizeRoomIdentifier(value) || ""));
}
