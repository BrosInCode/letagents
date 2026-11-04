import {
  ROOM_MEMBER_ROLES,
  type RoomJoinRequest,
  type RoomJoinRequestSummary,
  type RoomMember,
  type RoomMemberRole,
} from "../../../../../shared/room-membership.mjs";
import type {
  DesktopAccountRoomJoinRequest,
  DesktopRoomJoinRequestDecision,
  DesktopRoomMemberList,
  DesktopRoomMembershipFailure,
  DesktopRoomMembershipResult,
} from "../../ipc-types.js";
import { apiFetch, DesktopApiError, readStoredAuth } from "../auth.js";
import { readRoomJoinRequestSummary } from "./join-request-summary.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

/**
 * Members and join requests live on the server. A room kept only on this
 * computer has none, so every call names that instead of reaching the API.
 */
async function membersPath(identifier: string, suffix: string): Promise<string | DesktopRoomMembershipFailure> {
  if (!identifier?.trim()) return failure(null, "invalid_room", "Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") {
    return failure(null, "local_room", "A room kept on this computer has no members.");
  }
  const roomId = cloudRoomIdentifierForStorage(storage, identifier);
  return `/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

function pathSegment(value: string, label: string): string | DesktopRoomMembershipFailure {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 200) return failure(null, "invalid_request", `Unknown ${label}.`);
  return encodeURIComponent(trimmed);
}

function failure(status: number | null, code: string | null, message: string, joinRequest: RoomJoinRequestSummary | null = null): DesktopRoomMembershipFailure {
  return { ok: false, status, code, message, joinRequest };
}

function failureFromError(error: unknown): DesktopRoomMembershipFailure {
  if (error instanceof DesktopApiError) {
    const payload = error.payload;
    return failure(
      error.status,
      payload?.code ?? null,
      error.message,
      readRoomJoinRequestSummary(payload?.join_request, payload?.retry_after),
    );
  }
  return failure(null, null, error instanceof Error && error.message ? error.message : "LetAgents could not reach the server.");
}

async function call<T extends object>(
  path: string | DesktopRoomMembershipFailure,
  run: (path: string) => Promise<T>,
): Promise<DesktopRoomMembershipResult<T>> {
  if (typeof path !== "string") return path;
  try {
    return { ok: true, ...(await run(path)) };
  } catch (error) {
    return failureFromError(error);
  }
}

const postJson = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } as const;

export async function listDesktopRoomMembers(identifier: string): Promise<DesktopRoomMembershipResult<DesktopRoomMemberList>> {
  return call(await membersPath(identifier, "/members"), async (path) => {
    const [response, auth] = await Promise.all([
      apiFetch<{
        room_id: string;
        access_room_id: string;
        managed_by: "letagents" | "github";
        can_manage: boolean;
        members?: RoomMember[];
      }>(path),
      readStoredAuth(),
    ]);
    return {
      roomId: response.room_id,
      accessRoomId: response.access_room_id,
      managedBy: response.managed_by === "github" ? "github" : "letagents",
      canManage: response.managed_by !== "github" && response.can_manage === true,
      members: Array.isArray(response.members) ? response.members : [],
      viewerAccountId: auth.account?.id ?? null,
    };
  });
}

export async function removeDesktopRoomMember(identifier: string, accountId: string): Promise<DesktopRoomMembershipResult<{ accountId: string }>> {
  const account = pathSegment(accountId, "member");
  const path = typeof account === "string" ? await membersPath(identifier, `/members/${account}`) : account;
  return call(path, async (target) => {
    const response = await apiFetch<{ account_id?: string }>(target, { method: "DELETE" });
    return { accountId: response?.account_id ?? accountId };
  });
}

export async function setDesktopRoomMemberRole(
  identifier: string,
  accountId: string,
  role: RoomMemberRole,
): Promise<DesktopRoomMembershipResult<{ member: RoomMember }>> {
  if (!(ROOM_MEMBER_ROLES as readonly string[]).includes(role)) return failure(null, "invalid_request", "Unknown role.");
  const account = pathSegment(accountId, "member");
  const path = typeof account === "string" ? await membersPath(identifier, `/members/${account}/role`) : account;
  return call(path, async (target) => {
    const response = await apiFetch<{ member: RoomMember }>(target, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }),
    });
    return { member: response.member };
  });
}

export async function requestDesktopRoomJoin(identifier: string): Promise<DesktopRoomMembershipResult<{ joinRequest: RoomJoinRequestSummary }>> {
  return call(await membersPath(identifier, "/join-requests"), async (path) => {
    const response = await apiFetch<{ join_request: unknown }>(path, postJson);
    const joinRequest = readRoomJoinRequestSummary(response?.join_request);
    if (!joinRequest) throw new Error("LetAgents did not return the request.");
    return { joinRequest };
  });
}

export async function listDesktopRoomJoinRequests(identifier: string): Promise<DesktopRoomMembershipResult<{ joinRequests: RoomJoinRequest[] }>> {
  return call(await membersPath(identifier, "/join-requests?state=pending"), async (path) => {
    const response = await apiFetch<{ join_requests?: RoomJoinRequest[] }>(path);
    return { joinRequests: Array.isArray(response?.join_requests) ? response.join_requests : [] };
  });
}

export async function decideDesktopRoomJoinRequest(
  identifier: string,
  requestId: string,
  decision: DesktopRoomJoinRequestDecision,
): Promise<DesktopRoomMembershipResult<{ joinRequest: RoomJoinRequestSummary }>> {
  if (decision !== "approve" && decision !== "decline" && decision !== "cancel") {
    return failure(null, "invalid_request", "Unknown decision.");
  }
  const request = pathSegment(requestId, "request");
  const path = typeof request === "string" ? await membersPath(identifier, `/join-requests/${request}/${decision}`) : request;
  return call(path, async (target) => {
    const response = await apiFetch<{ join_request: unknown }>(target, postJson);
    const joinRequest = readRoomJoinRequestSummary(response?.join_request);
    if (!joinRequest) throw new Error("LetAgents did not return the request.");
    return { joinRequest };
  });
}

/** An older server has no such route: that reads as "no requests", not as a failure. */
export async function listDesktopAccountRoomJoinRequests(): Promise<DesktopRoomMembershipResult<{ joinRequests: DesktopAccountRoomJoinRequest[] }>> {
  try {
    const response = await apiFetch<{ join_requests?: DesktopAccountRoomJoinRequest[] }>("/account/room-join-requests");
    return { ok: true, joinRequests: Array.isArray(response?.join_requests) ? response.join_requests : [] };
  } catch (error) {
    if (error instanceof DesktopApiError && error.status === 404) return { ok: true, joinRequests: [] };
    return failureFromError(error);
  }
}
