import type {
  RoomJoinRequest,
  RoomJoinRequestSummary,
  RoomMember,
  RoomMemberRole,
  RoomMembershipState,
} from '../../../../../shared/room-membership.mjs'
import { apiFetch, roomPath, type RoomApiFailure } from './api'

export type {
  RoomJoinRequest,
  RoomJoinRequestSummary,
  RoomMember,
  RoomMemberRole,
  RoomMembershipState,
} from '../../../../../shared/room-membership.mjs'

export interface RoomMemberList {
  room_id: string
  access_room_id: string
  managed_by: RoomMembershipState['managed_by']
  can_manage: boolean
  members: RoomMember[]
}

export type RoomApiError = RoomApiFailure

// The server sends these two codes; shared/room-membership.mjs does not export them yet.
/** 503: GitHub gave no answer to a repository role check. Not a refusal: retry later. */
export const REPO_ACCESS_UNAVAILABLE = 'REPO_ACCESS_UNAVAILABLE'
/** 400: a person asks to join the main room, never one of its focus rooms. */
export const ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY = 'ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY'

/**
 * A focus room's id (focus_1, focus_2, ...). For a person who is not a member,
 * the server names neither a focus room nor its parent, and takes requests
 * only for the main room.
 */
export function isFocusRoomId(roomId: string): boolean {
  return /^focus_\d+$/.test(roomId)
}

// A refusal here is about membership itself, not a reason to close the open room.
const MEMBER_ROUTE = { reportRoomRefusal: false }

export function asRoomApiError(error: unknown): RoomApiError {
  return (error instanceof Error ? error : new Error(String(error))) as RoomApiError
}

/** The caller's latest request from a refusal or cooldown body, if it has one. */
export function joinRequestFromPayload(payload: unknown): RoomJoinRequestSummary | null {
  if (!payload || typeof payload !== 'object') return null
  const request = (payload as { join_request?: unknown }).join_request
  if (!request || typeof request !== 'object') return null
  const { id, state } = request as Partial<RoomJoinRequestSummary>
  if (typeof id !== 'string' || typeof state !== 'string') return null
  const summary = request as RoomJoinRequestSummary
  // A cooldown answer can carry retry_after next to the request instead of in it.
  const retryAfter = summary.retry_after ?? (payload as { retry_after?: unknown }).retry_after
  return {
    id,
    state: summary.state,
    created_at: summary.created_at,
    decided_at: summary.decided_at ?? null,
    retry_after: typeof retryAfter === 'string' ? retryAfter : null,
  }
}

const membersPath = (room: string) => `${roomPath(room)}/members`
const joinRequestsPath = (room: string) => `${roomPath(room)}/join-requests`

export function fetchRoomMembership(room: string): Promise<RoomMembershipState> {
  return apiFetch(`${roomPath(room)}/membership`, undefined, MEMBER_ROUTE)
}

export async function requestRoomAccess(room: string): Promise<RoomJoinRequestSummary | null> {
  const body = await apiFetch(joinRequestsPath(room), { method: 'POST' }, MEMBER_ROUTE)
  return joinRequestFromPayload(body)
}

export async function cancelRoomJoinRequest(room: string, requestId: string): Promise<RoomJoinRequestSummary | null> {
  const body = await apiFetch(`${joinRequestsPath(room)}/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' }, MEMBER_ROUTE)
  return joinRequestFromPayload(body)
}

export function fetchRoomMembers(room: string): Promise<RoomMemberList> {
  return apiFetch(membersPath(room), undefined, MEMBER_ROUTE)
}

export function removeRoomMember(room: string, accountId: string): Promise<{ removed: boolean; account_id: string }> {
  return apiFetch(`${membersPath(room)}/${encodeURIComponent(accountId)}`, { method: 'DELETE' }, MEMBER_ROUTE)
}

export async function setRoomMemberRole(room: string, accountId: string, role: RoomMemberRole): Promise<RoomMember> {
  const body = await apiFetch(`${membersPath(room)}/${encodeURIComponent(accountId)}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  }, MEMBER_ROUTE)
  return body.member
}

export async function fetchPendingRoomJoinRequests(room: string): Promise<RoomJoinRequest[]> {
  const body = await apiFetch(`${joinRequestsPath(room)}?state=pending`, undefined, MEMBER_ROUTE)
  return Array.isArray(body?.join_requests) ? body.join_requests : []
}

export async function decideRoomJoinRequest(
  room: string,
  requestId: string,
  decision: 'approve' | 'decline',
): Promise<{ join_request: RoomJoinRequest; member?: RoomMember }> {
  return apiFetch(`${joinRequestsPath(room)}/${encodeURIComponent(requestId)}/${decision}`, { method: 'POST' }, MEMBER_ROUTE)
}
