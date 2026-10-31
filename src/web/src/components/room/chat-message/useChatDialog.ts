import { nextTick, onUnmounted, ref, watch } from 'vue'

/** Native dialogs keep keyboard and assistive focus inside chat inspectors. */
export function useChatDialog(isOpen: () => boolean) {
  const dialogRef = ref<HTMLDialogElement | null>(null)
  let opener: HTMLElement | null = null
  let bodyOverflow: string | null = null

  function release() {
    dialogRef.value?.close()
    if (bodyOverflow !== null) document.body.style.overflow = bodyOverflow
    bodyOverflow = null
    if (opener?.isConnected) opener.focus({ preventScroll: true })
    opener = null
  }

  watch(isOpen, async (open, _previous, onCleanup) => {
    let cancelled = false
    onCleanup(() => { cancelled = true })
    if (typeof document === 'undefined') return
    if (!open) {
      release()
      return
    }
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    if (cancelled || !isOpen() || !dialogRef.value) return
    bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.value.showModal()
    dialogRef.value.focus({ preventScroll: true })
  }, { immediate: true })

  function closeOnBackdrop(event: MouseEvent, close: () => void) {
    const dialog = dialogRef.value
    if (!dialog || event.target !== dialog) return
    const rect = dialog.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
  }

  onUnmounted(release)
  return { dialogRef, closeOnBackdrop }
}
