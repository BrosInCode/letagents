import {
  parseRoomInvite,
  type RoomInvite,
  type RoomInvitePlatform,
} from '../../../../../shared/room-invites.mjs'
import { apiFetch, roomPath } from './api'

/**
 * "Invite a bot": one-use invite codes. The server returns the code once,
 * when the invite is made; the drawer copies it into the message and keeps it
 * only while the panel is open.
 */

// A refusal here is about the invite, not a reason to close the open room.
const INVITE_ROUTE = { reportRoomRefusal: false }

export async function createRoomInvite(room: string, platform: RoomInvitePlatform): Promise<{ invite: RoomInvite; code: string }> {
  const body = await apiFetch(`${roomPath(room)}/invites`, {
    method: 'POST',
    body: JSON.stringify({ platform }),
  }, INVITE_ROUTE)
  const invite = parseRoomInvite(body?.invite)
  if (!invite || typeof body?.code !== 'string') throw new Error('The invite could not be made. Try again.')
  return { invite, code: body.code }
}

export async function cancelRoomInvite(room: string, inviteId: string): Promise<RoomInvite | null> {
  const body = await apiFetch(`${roomPath(room)}/invites/${encodeURIComponent(inviteId)}/cancel`, { method: 'POST' }, INVITE_ROUTE)
  return parseRoomInvite(body?.invite)
}
