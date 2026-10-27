import { computed, onMounted, onUnmounted, ref } from 'vue'

export function useRoomViewport() {
  const roomViewportStyle = ref<Record<string, string>>({})
  const compactViewport = ref(false)
  const keyboardOpen = ref(false)
  const editingThread = ref(false)
  const hideMainComposer = computed(() => keyboardOpen.value && editingThread.value)

  function syncRoomViewport() {
    const viewport = window.visualViewport
    if (!viewport) return
    // Normalize zoom before detecting keyboard space, so closing the keyboard
    // while zoomed still restores navigation and the main draft.
    keyboardOpen.value = window.innerHeight - viewport.height * viewport.scale > 120

    const active = document.activeElement
    const composer = active?.closest('.composer')
    if (!keyboardOpen.value) editingThread.value = false
    else if (composer) editingThread.value = composer.classList.contains('inline-thread-composer')
    else if (active && active !== document.body) editingThread.value = false
    // A touch on a send/menu control can briefly leave body focused. Retain
    // the current composer until another target gains focus or the keyboard closes.

    // Safari resizes the visual viewport for the keyboard. Pinch zoom keeps
    // the existing layout rather than reflowing the room at the zoomed size.
    if (viewport.scale !== 1) return
    compactViewport.value = viewport.height < 360
    roomViewportStyle.value = {
      '--room-viewport-height': `${viewport.height}px`,
      '--room-viewport-top': `${viewport.offsetTop}px`,
    }
  }

  onMounted(() => {
    syncRoomViewport()
    window.visualViewport?.addEventListener('resize', syncRoomViewport)
    window.visualViewport?.addEventListener('scroll', syncRoomViewport)
  })
  onUnmounted(() => {
    window.visualViewport?.removeEventListener('resize', syncRoomViewport)
    window.visualViewport?.removeEventListener('scroll', syncRoomViewport)
  })

  return { roomViewportStyle, compactViewport, keyboardOpen, editingThread, hideMainComposer, syncRoomViewport }
}
