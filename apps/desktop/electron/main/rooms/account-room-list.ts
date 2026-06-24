import type {
  DesktopAccountRoomEntry,
  DesktopAccountRoomListOptions,
} from "../../ipc-types.js";

export function mergeDesktopAccountRoomEntries(
  cloudRooms: readonly DesktopAccountRoomEntry[],
  localRooms: readonly DesktopAccountRoomEntry[],
  options: DesktopAccountRoomListOptions = {},
): DesktopAccountRoomEntry[] {
  const cloudRoomIds = new Set(cloudRooms.map((room) => room.roomIdentifier));
  const visibleCloudRooms = options.includeArchived
    ? [...cloudRooms]
    : cloudRooms.filter((room) => !room.archived);
  const visibleLocalCandidates = options.includeArchived
    ? [...localRooms]
    : localRooms.filter((room) => !room.archived);
  const seen = new Set(cloudRoomIds);
  const visibleLocalRooms: DesktopAccountRoomEntry[] = [];

  for (const room of visibleLocalCandidates) {
    if (seen.has(room.roomIdentifier)) continue;
    seen.add(room.roomIdentifier);
    visibleLocalRooms.push(room);
  }

  return [
    ...visibleLocalRooms,
    ...visibleCloudRooms,
  ];
}
