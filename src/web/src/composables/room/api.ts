import { roomAccessRefusal } from '../../../../../shared/room-membership.mjs'

export type RoomApiFailure = Error & {
  status?: number
  code?: string | null
  payload?: any
}

type RoomAccessRefusedListener = (path: string, error: RoomApiFailure) => void
const roomAccessRefusedListeners = new Set<RoomAccessRefusedListener>()

/**
 * Hears every 403 that says the person is not let into a room, so the open room
 * can stop its stream and timers instead of retrying a refusal forever.
 */
export function onRoomAccessRefused(listener: RoomAccessRefusedListener): () => void {
  roomAccessRefusedListeners.add(listener)
  return () => roomAccessRefusedListeners.delete(listener)
}

export async function apiFetch(
  path: string,
  options?: RequestInit,
  // Member routes answer a refusal to a person who may still read the room, so they opt out.
  { reportRoomRefusal = true }: { reportRoomRefusal?: boolean } = {},
): Promise<any> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const rawBody = await res.text().catch(() => '')
    let payload: any = null
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody)
      } catch {
        payload = null
      }
    }
    const error = new Error(
      payload?.message || payload?.error || rawBody || `HTTP ${res.status}`,
    ) as RoomApiFailure
    error.status = res.status
    error.code = payload?.code || payload?.error || null
    error.payload = payload
    if (reportRoomRefusal && res.status === 403 && roomAccessRefusal(payload)) {
      for (const listener of roomAccessRefusedListeners) {
        try {
          listener(path, error)
        } catch (listenerError) {
          // The caller still gets the HTTP error below.
          console.error('[room] access refusal listener failed:', listenerError)
        }
      }
    }
    throw error
  }
  return res.json()
}

export function roomPath(identifier: string): string {
  return `/rooms/${encodeURIComponent(identifier)}`
}
