export type JoinedVia = "config" | "git-remote" | "join_code" | "join_room";

export function encodeRoomIdPath(roomId: string): string {
  return roomId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function looksLikeInviteCode(value: string): boolean {
  return /^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/.test(value.trim().toUpperCase());
}

export function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase();
}
