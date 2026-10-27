import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'

export function useRoomViewport() {
  const roomViewportStyle = ref<Record<string, string>>({})
  const compactViewport = ref(false)
  const keyboardOpen = ref(false)
  const editingThread = ref(false)
  const editingComposer = ref(false)
  const hideMainComposer = computed(() => keyboardOpen.value && editingThread.value)
  const compactComposer = computed(() => keyboardOpen.value && compactViewport.value && editingComposer.value)
  let focusedComposer: HTMLElement | null = null
  let revealRevision = 0

  function resetComposerFocus() {
    editingThread.value = false
    editingComposer.value = false
    focusedComposer = null
    revealRevision++
  }

  function syncRoomViewport(event?: Event) {
    const viewport = window.visualViewport
    if (!viewport) return
    // iOS Safari can shrink innerHeight with the keyboard while the root layout
    // viewport stays stable. Normalize zoom so dismissal also works while zoomed.
    const layoutHeight = Math.max(document.documentElement.clientHeight, window.innerHeight)
    keyboardOpen.value = layoutHeight - viewport.height * viewport.scale > 120

    const active = document.activeElement
    const composer = active?.closest<HTMLElement>('.composer') ?? null
    const previousComposer = focusedComposer
    if (composer) focusedComposer = composer
    else if (active && active !== document.body) focusedComposer = null
    if (focusedComposer !== previousComposer) revealRevision++
    editingComposer.value = keyboardOpen.value && Boolean(focusedComposer)
    editingThread.value = keyboardOpen.value && Boolean(focusedComposer?.classList.contains('inline-thread-composer'))
    // A touch on a send/menu control can briefly leave body focused. Retain
    // the current composer until another target gains focus or the keyboard closes.

    // Safari resizes the visual viewport for the keyboard. Pinch zoom keeps
    // the existing layout rather than reflowing the room at the zoomed size.
    if (viewport.scale !== 1) {
      revealRevision++
      if (!keyboardOpen.value) focusedComposer = null
      return
    }
    compactViewport.value = viewport.height < 360
    roomViewportStyle.value = {
      '--room-viewport-height': `${viewport.height}px`,
      '--room-viewport-top': `${viewport.offsetTop}px`,
    }

    // Rotation changes the room's grid before Safari reveals the focused field.
    // Move only the thread's own message scrollport, never the page or user scrolls.
    const target = focusedComposer
    if (event?.type !== 'scroll') revealRevision++
    if (event?.type !== 'scroll' && target?.classList.contains('inline-thread-composer')) {
      const revision = revealRevision
      void nextTick(() => {
        if (revision !== revealRevision || !target.isConnected) return
        const scrollport = target.closest<HTMLElement>('.messages')
        if (!scrollport) return
        const bounds = scrollport.getBoundingClientRect()
        const draft = target.getBoundingClientRect()
        if (!bounds.height || !draft.height) return
        const delta = draft.top < bounds.top ? draft.top - bounds.top
          : draft.bottom > bounds.bottom ? draft.bottom - bounds.bottom : 0
        if (delta) scrollport.scrollTo({ top: scrollport.scrollTop + delta, behavior: 'instant' })
      })
    }
    if (!keyboardOpen.value) focusedComposer = null
  }

  onMounted(() => {
    syncRoomViewport()
    window.visualViewport?.addEventListener('resize', syncRoomViewport)
    window.visualViewport?.addEventListener('scroll', syncRoomViewport)
  })
  onUnmounted(() => {
    resetComposerFocus()
    window.visualViewport?.removeEventListener('resize', syncRoomViewport)
    window.visualViewport?.removeEventListener('scroll', syncRoomViewport)
  })

  return { roomViewportStyle, compactViewport, keyboardOpen, compactComposer, hideMainComposer, syncRoomViewport, resetComposerFocus }
}
