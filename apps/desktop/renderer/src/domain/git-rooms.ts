import type { DesktopRoomInfo } from "../../../electron/ipc-types";

export function isLocalGitRoom(room: Pick<DesktopRoomInfo, "gitRoom">): boolean {
  return room.gitRoom?.accessMode === "local";
}

export function roomSupportsGitHubIntegration(
  room: Pick<DesktopRoomInfo, "identifier" | "name" | "displayName" | "gitRoom">,
): boolean {
  if (room.gitRoom) {
    return room.gitRoom.accessMode !== "local" &&
      (room.gitRoom.provider === "github" || room.gitRoom.host === "github.com");
  }

  return [
    room.identifier,
    room.name,
    room.displayName,
  ].some((value) => githubRoomIdentifier(value));
}

function githubRoomIdentifier(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return /^github\.com\/[^/]+\/[^/]+$/.test(normalized) ||
    /^git-room:github\.com:[^/:\s]+\/[^/:\s]+:/.test(normalized);
}
