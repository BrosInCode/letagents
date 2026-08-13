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
    /^github\.com\/[^/]+\/[^/]+\/focus\/git:(?:branch|tag):[a-z0-9_-]+$/.test(normalized);
}

const GIT_ROOM_REF_PATTERN =
  /^github\.com\/[^/\s]+\/([^/\s]+)\/focus\/git:(?:branch|tag):([A-Za-z0-9_-]+)$/;

/**
 * People recognize "repo · branch", not canonical git-room identifiers with a
 * base64url-encoded ref. Non-git-room labels pass through untouched.
 */
export function friendlyRoomLabel(label: string): string {
  const match = GIT_ROOM_REF_PATTERN.exec(label.trim());
  if (!match) return label;
  const repo = match[1] || label;
  const encodedRef = match[2] || "";
  const ref = decodeRoomRef(encodedRef);
  return ref ? `${repo} · ${ref}` : repo;
}

function decodeRoomRef(encoded: string): string | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const ref = new TextDecoder().decode(bytes);
    return /^[\x20-\x7e]+$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}
