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

type InviteStream = Pick<EventSource, 'addEventListener' | 'close' | 'readyState'>

/** EventSource.CLOSED: the browser gave up on the stream and will not reconnect. */
const STREAM_CLOSED = 2
/** Waits before a stream the browser gave up on is opened again, while the invite waits. */
export const INVITE_STREAM_RETRY_MS = [2_000, 5_000, 15_000, 30_000] as const

export interface FollowRoomInviteOptions {
  openStream?: () => InviteStream
  read?: (room: string, inviteId: string) => Promise<RoomInvite | null>
  /** Where a returning window is heard (the window; tests pass their own). */
  focusTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/**
 * Follows the invite this drawer made until it ends, so the section can say
 * that the bot came in. While the invite waits, the account stream (the one
 * the desktop app reads too) brings its changes; each time the stream opens,
 * and when the window comes back, the invite is read once, so a change made
 * while the stream was down is not missed. A stream the browser gives up on
 * (an answer that is not 200) opens again after a growing wait. An ended
 * invite never opens again: a late read cannot undo "joined". An ended
 * invite, stop, and the end of the scope close the stream.
 */
export function useFollowedRoomInvite(room: () => string, options: FollowRoomInviteOptions = {}) {
  const invite = shallowRef<RoomInvite | null>(null)
  const openStream = options.openStream ?? (() => new EventSource('/account/activity/stream', { withCredentials: true }))
  const read = options.read ?? readRoomInvite
  const focusTarget = options.focusTarget === undefined ? (typeof window === 'undefined' ? null : window) : options.focusTarget
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let stream: InviteStream | null = null
  let retry: unknown = null
  let failures = 0
  let disposed = false

  const waiting = () => invite.value?.state === 'open'

  function update(next: RoomInvite | null): void {
    const current = invite.value
    if (!next || !current || next.id !== current.id) return
    if (current.state !== 'open' && next.state === 'open') return
    invite.value = next
    if (next.state !== 'open') quiet()
  }

  async function refresh(): Promise<void> {
    const current = invite.value
    if (!current || current.state !== 'open') return
    try {
      update(await read(room(), current.id))
    } catch {
      // The stream or the next return of the window reads it again.
    }
  }

  function listen(): void {
    if (stream || disposed || !waiting()) return
    if (retry !== null) {
      clearTimer(retry)
      retry = null
    }
    const current = openStream()
    stream = current
    current.addEventListener('open', () => {
      if (current !== stream) return
      failures = 0
      void refresh()
    })
    current.addEventListener(ROOM_INVITE_EVENT, (event) => {
      if (current !== stream) return
      try {
        update(parseRoomInviteEvent(JSON.parse((event as MessageEvent).data))?.invite ?? null)
      } catch {
        // A malformed frame changes nothing.
      }
    })
    current.addEventListener('error', () => {
      // While the browser reconnects by itself, the next "open" reads the invite.
      if (current !== stream || current.readyState !== STREAM_CLOSED) return
      current.close()
      stream = null
      const wait = INVITE_STREAM_RETRY_MS[Math.min(failures, INVITE_STREAM_RETRY_MS.length - 1)]!
      failures += 1
      retry = setTimer(() => {
        retry = null
        listen()
      }, wait)
    })
    focusTarget?.addEventListener('focus', onFocus)
  }

  function onFocus(): void {
    // Back at the window: a stream that gave up starts again now, and its "open" reads the invite.
    if (!stream && waiting()) listen()
    else void refresh()
  }

  function quiet(): void {
    stream?.close()
    stream = null
    if (retry !== null) {
      clearTimer(retry)
      retry = null
    }
    failures = 0
    focusTarget?.removeEventListener('focus', onFocus)
  }

  /** Follows an invite Copy just made; a later one replaces it. Nothing starts once the drawer is gone. */
  function follow(next: RoomInvite): void {
    if (disposed) return
    invite.value = next
    if (next.state === 'open') listen()
    else quiet()
  }

  function stop(): void {
    invite.value = null
    quiet()
  }

  onScopeDispose(() => {
    disposed = true
    stop()
  })
  return { invite, follow, update, stop }
}
