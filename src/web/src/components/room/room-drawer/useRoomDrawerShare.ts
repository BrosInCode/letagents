import { computed, ref, type Ref } from 'vue'
import type { RoomInfo } from '../../../composables/room/types'

export function encodeRoomPathIdentifier(identifier: string): string {
  return String(identifier)
    .split('/')
    .map(s => encodeURIComponent(s))
    .join('/')
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
    const identifier = room.value.identifier || room.value.projectId
    if (!identifier) return ''
    return `${window.location.origin}/in/${encodeRoomPathIdentifier(identifier)}`
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
    parentRoomIdentifier.value ? `/in/${encodeRoomPathIdentifier(parentRoomIdentifier.value)}` : ''
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
