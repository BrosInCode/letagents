import {
  isRoomInvitePlatform,
  parseRoomInvite,
  type RoomInvite,
  type RoomInvitePlatform,
} from "../../../../../shared/room-invites.mjs";
import type {
  DesktopBotInviteRoom,
  DesktopBotInviteCreation,
  DesktopBotInviteResult,
} from "../../ipc-types.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

/**
 * "Invite a bot": one-use invite codes for members-only rooms. The server
 * makes the code and keeps only its hash, so the code reaches this app once,
 * in the answer to create; the renderer keeps it to copy the message again.
 */

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

function failure(code: string | null, message: string): DesktopBotInviteResult<never> {
  return { ok: false, code, message };
}

async function call<T extends object>(run: () => Promise<T>): Promise<DesktopBotInviteResult<T>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    if (error instanceof DesktopApiError) {
      return failure(error.payload?.code ?? null, error.payload?.error || error.message);
    }
    return failure(null, error instanceof Error && error.message ? error.message : "LetAgents could not reach the server.");
  }
}

async function roomPath(identifier: string, suffix: string): Promise<string | DesktopBotInviteResult<never>> {
  if (typeof identifier !== "string" || !identifier.trim()) return failure("invalid_room", "Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") {
    return failure("local_room", "A room kept on this computer takes no bots from outside.");
  }
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}${suffix}`;
}

function invites(value: unknown): RoomInvite[] {
  return Array.isArray(value) ? value.map(parseRoomInvite).filter((invite): invite is RoomInvite => invite !== null) : [];
}

export async function createDesktopRoomInvite(
  identifier: string,
  platform: unknown,
  originRoomIdentifier?: string | null,
): Promise<DesktopBotInviteResult<DesktopBotInviteCreation>> {
  if (!isRoomInvitePlatform(platform)) return failure("invalid_request", "Pick the bot the invite is for.");
  const path = await roomPath(identifier, "/invites");
  if (typeof path !== "string") return path;
  const origin = typeof originRoomIdentifier === "string" && originRoomIdentifier.trim() ? originRoomIdentifier.trim() : null;
  return call(async () => {
    const response = await apiFetch<{ invite?: unknown; code?: unknown }>(path, postJson({
      platform: platform as RoomInvitePlatform,
      ...(origin ? { origin_room_id: origin } : {}),
    }));
    const invite = parseRoomInvite(response.invite);
    if (!invite || typeof response.code !== "string" || !response.code) {
      throw new Error("The server answered the invite in a form this app does not know.");
    }
    return { invite, code: response.code };
  });
}

export async function listDesktopRoomInvites(identifier: string): Promise<DesktopBotInviteResult<{ invites: RoomInvite[] }>> {
  const path = await roomPath(identifier, "/invites");
  if (typeof path !== "string") return path;
  return call(async () => ({ invites: invites((await apiFetch<{ invites?: unknown }>(path)).invites) }));
}

export async function cancelDesktopRoomInvite(
  identifier: string,
  inviteId: string,
): Promise<DesktopBotInviteResult<{ invite: RoomInvite }>> {
  const id = typeof inviteId === "string" ? inviteId.trim() : "";
  if (!id || id.length > 200) return failure("invalid_request", "Unknown invite.");
  const path = await roomPath(identifier, `/invites/${encodeURIComponent(id)}/cancel`);
  if (typeof path !== "string") return path;
  return call(async () => {
    const invite = parseRoomInvite((await apiFetch<{ invite?: unknown }>(path, postJson({}))).invite);
    if (!invite) throw new Error("The server answered the invite in a form this app does not know.");
    return { invite };
  });
}

/** The members-only rooms this account may invite a bot into (a Git Room's room picker). */
export async function listDesktopBotInviteRooms(): Promise<DesktopBotInviteResult<{ rooms: DesktopBotInviteRoom[] }>> {
  return call(async () => {
    const response = await apiFetch<{ rooms?: unknown }>("/account/invite-rooms");
    const rooms = Array.isArray(response.rooms) ? response.rooms : [];
    return {
      rooms: rooms.flatMap((value): DesktopBotInviteRoom[] => {
        if (!value || typeof value !== "object") return [];
        const room = value as Record<string, unknown>;
        if (typeof room.id !== "string" || !room.id) return [];
        return [{
          id: room.id,
          displayName: typeof room.display_name === "string" && room.display_name ? room.display_name : room.id,
          role: room.role === "admin" ? "admin" : "member",
          memberCount: typeof room.member_count === "number" ? room.member_count : null,
        }];
      }),
    };
  });
}
