import { onScopeDispose, shallowRef } from 'vue'
import {
  parseRoomInvite,
  parseRoomInviteEvent,
  ROOM_INVITE_EVENT,
  type RoomInvite,
  type RoomInvitePlatform,
} from '../../../../../shared/room-invites.mjs'
import { apiFetch, roomPath, type RoomApiFailure } from './api'

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

/** One of this account's own invites, in any state. */
export async function readRoomInvite(room: string, inviteId: string): Promise<RoomInvite | null> {
  const body = await apiFetch(`${roomPath(room)}/invites/${encodeURIComponent(inviteId)}`, undefined, INVITE_ROUTE)
  return parseRoomInvite(body?.invite)
}

/** The invite a refused cancel names ("This invite is already used."), if the server sent it. */
export function inviteFromRefusal(error: unknown): RoomInvite | null {
  return parseRoomInvite((error as RoomApiFailure | null)?.payload?.invite)
}

type InviteStream = Pick<EventSource, 'addEventListener' | 'close'>

export interface FollowRoomInviteOptions {
  openStream?: () => InviteStream
  read?: (room: string, inviteId: string) => Promise<RoomInvite | null>
  /** Where a returning window is heard (the window; tests pass their own). */
  focusTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
}

/**
 * Follows the invite this drawer made until it ends, so the section can say
 * that the bot came in. While the invite waits, the account stream (the one
 * the desktop app reads too) brings its changes; each time the stream opens,
 * and when the window comes back, the invite is read once, so a change made
 * while the stream was down is not missed. An ended invite stops the stream.
 */
export function useFollowedRoomInvite(room: () => string, options: FollowRoomInviteOptions = {}) {
  const invite = shallowRef<RoomInvite | null>(null)
  const openStream = options.openStream ?? (() => new EventSource('/account/activity/stream', { withCredentials: true }))
  const read = options.read ?? readRoomInvite
  const focusTarget = options.focusTarget === undefined ? (typeof window === 'undefined' ? null : window) : options.focusTarget
  let stream: InviteStream | null = null

  function update(next: RoomInvite | null): void {
    if (!next || next.id !== invite.value?.id) return
    invite.value = next
    if (next.state !== 'open') quiet()
  }

  async function refresh(): Promise<void> {
    const waiting = invite.value
    if (!waiting || waiting.state !== 'open') return
    try {
      update(await read(room(), waiting.id))
    } catch {
      // The stream or the next return of the window reads it again.
    }
  }

  function listen(): void {
    if (stream) return
    const current = openStream()
    stream = current
    current.addEventListener('open', () => {
      if (current === stream) void refresh()
    })
    current.addEventListener(ROOM_INVITE_EVENT, (event) => {
      if (current !== stream) return
      try {
        update(parseRoomInviteEvent(JSON.parse((event as MessageEvent).data))?.invite ?? null)
      } catch {
        // A malformed frame changes nothing.
      }
    })
    focusTarget?.addEventListener('focus', onFocus)
  }

  function onFocus(): void {
    void refresh()
  }

  function quiet(): void {
    stream?.close()
    stream = null
    focusTarget?.removeEventListener('focus', onFocus)
  }

  /** Follows an invite Copy just made; a later one replaces it. */
  function follow(next: RoomInvite): void {
    invite.value = next
    if (next.state === 'open') listen()
    else quiet()
  }

  function stop(): void {
    invite.value = null
    quiet()
  }

  onScopeDispose(stop)
  return { invite, follow, update, stop }
}
