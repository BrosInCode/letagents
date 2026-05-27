import type { RoomInfo } from './types'

const SESSION_KEY = 'lac-vue-session'

export function persistRoomSession(room: RoomInfo | null) {
  if (!room) return
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      identifier: room.identifier,
      projectId: room.projectId,
      name: room.name,
      displayName: room.displayName,
      code: room.code,
    }),
  )
}

export function clearPersistedSession() {
  localStorage.removeItem(SESSION_KEY)
}

export function loadPersistedSession(): { identifier: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    return data?.identifier ? data : null
  } catch {
    return null
  }
}
