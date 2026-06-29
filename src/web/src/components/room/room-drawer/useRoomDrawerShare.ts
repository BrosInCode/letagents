import { computed, ref, type Ref } from 'vue'
import type { RoomInfo } from '../../../composables/room/types'

type RoomShareInput =
  Partial<Pick<RoomInfo, 'identifier' | 'projectId' | 'parentRoomId' | 'focusKey' | 'sourceTaskId' | 'kind'>>

export function encodeRoomPathIdentifier(identifier: string): string {
  return String(identifier)
    .split('/')
    .map(s => encodeURIComponent(s))
    .join('/')
}

export function buildRoomSharePath(input: {
  identifier?: string | null
  projectId?: string | null
  kind?: string | null
  parentRoomId?: string | null
  focusKey?: string | null
  sourceTaskId?: string | null
}): string {
  const parentRoomId = input.kind === 'focus' ? input.parentRoomId?.trim() : ''
  const focusKey = input.kind === 'focus'
    ? input.focusKey?.trim() || input.sourceTaskId?.trim()
    : ''
  if (parentRoomId && focusKey) {
    return `/in/${encodeRoomPathIdentifier(parentRoomId)}/focus/${encodeURIComponent(focusKey)}`
  }

  const identifier = input.identifier?.trim() || input.projectId?.trim()
  return identifier ? `/in/${encodeRoomPathIdentifier(identifier)}` : ''
}

export function buildRoomShareUrl(
  input: RoomShareInput,
  origin: string,
): string {
  const path = buildRoomSharePath(input)
  return path ? `${origin.replace(/\/+$/, '')}${path}` : ''
}

export function useRoomDrawerShare(room: Readonly<Ref<RoomInfo | null>>) {
  const codeCopied = ref(false)

  const shareKind = computed(() => {
    if (!room.value) return 'code'
    return room.value.code ? 'code' : 'url'
  })

  const shareValue = computed(() => {
    if (!room.value) return ''
    if (room.value.code) return room.value.code
    return buildRoomShareUrl(room.value, window.location.origin)
  })

  const shareDisplayValue = computed(() => {
    const val = shareValue.value
    if (!val) return ''
    if (shareKind.value !== 'url') return val
    try {
      const shareUrl = new URL(val)
      const cleanPath = decodeURIComponent(shareUrl.pathname)
        .replace(/^\/in\//, '')
        .replace(/^\/+|\/+$/g, '')
      return cleanPath || shareUrl.host
    } catch {
      return val.replace(/^https?:\/\//, '').replace(/\/in\//, '')
    }
  })

  const parentRoomIdentifier = computed(() =>
    room.value?.kind === 'focus' && room.value.parentRoomId ? room.value.parentRoomId : ''
  )

  const parentRoomUrl = computed(() =>
    parentRoomIdentifier.value
      ? buildRoomSharePath({ identifier: parentRoomIdentifier.value })
      : ''
  )

  const parentRoomDisplay = computed(() => parentRoomIdentifier.value || 'Parent room')

  async function copyShareValue() {
    const val = shareValue.value
    if (!val) return
    try {
      await navigator.clipboard.writeText(val)
      codeCopied.value = true
      setTimeout(() => { codeCopied.value = false }, 1500)
    } catch {
      // Clipboard support is best-effort.
    }
  }

  return {
    codeCopied,
    copyShareValue,
    parentRoomDisplay,
    parentRoomUrl,
    shareDisplayValue,
    shareKind,
    shareValue,
  }
}
