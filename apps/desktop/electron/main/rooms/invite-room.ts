import type { DesktopInviteRoomCreation, DesktopInviteRoomOptions } from "../../ipc-types.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { fetchRoomSnapshot } from "./snapshot.js";

/** Plain words for the refusals of a room created inside a company. */
const COMPANY_ROOM_REFUSALS: Record<string, string> = {
  organization_membership_required: "Your GitHub account isn’t a member of this company anymore, so the room wasn’t created.",
  organization_join_required: "Join this company in LetAgents first, then create the room again.",
  github_scope_required: "Allow LetAgents to see your GitHub organizations from the Rooms list, then try again.",
  github_signin_required: "Reconnect GitHub from the Rooms list, then try again.",
  organization_verification_unavailable: "GitHub didn’t answer, so LetAgents couldn’t check the company. Try again.",
};

function companyRoomBody(options: DesktopInviteRoomOptions | undefined): string | undefined {
  const organizationId = options?.organizationId;
  if (organizationId === undefined || organizationId === null) return undefined;
  if (typeof organizationId !== "string" || !/^[1-9][0-9]*$/.test(organizationId)) {
    throw new Error("Choose a valid company for this room.");
  }
  return JSON.stringify({ organization_id: organizationId });
}

export async function createDesktopInviteRoom(options?: DesktopInviteRoomOptions): Promise<DesktopInviteRoomCreation> {
  const body = companyRoomBody(options);
  let room: { id: string; code?: string | null };
  try {
    room = await apiFetch<{ id: string; code?: string | null }>(
      "/projects",
      body ? { method: "POST", body } : { method: "POST" },
    );
  } catch (error) {
    const code = error instanceof DesktopApiError ? error.payload?.error : null;
    if (body && code && COMPANY_ROOM_REFUSALS[code]) throw new Error(COMPANY_ROOM_REFUSALS[code]);
    throw error;
  }
  const roomIdentifier = room.id;
  const code = room.code || room.id;
  const snapshot = await fetchRoomSnapshot(code);
  return {
    roomIdentifier,
    code,
    snapshot,
  };
}
