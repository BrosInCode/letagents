import type { DesktopInviteRoomCreation } from "../../ipc-types.js";
import { apiFetch } from "../auth.js";
import { fetchRoomSnapshot } from "./snapshot.js";

export async function createDesktopInviteRoom(): Promise<DesktopInviteRoomCreation> {
  const room = await apiFetch<{ id: string; code?: string | null }>(
    "/projects",
    {
      method: "POST",
    },
  );
  const roomIdentifier = room.id;
  const code = room.code || room.id;
  const snapshot = await fetchRoomSnapshot(code);
  return {
    roomIdentifier,
    code,
    snapshot,
  };
}
