import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { OutgoingMessageAttachment } from '@/composables/useRoom'

const KEEP_POLLING_INTERVAL_MS = 20_000
const PREFS_KEY = 'lac-prompt-prefs'

type SubmitComposerMessage = (
  bodyText: string,
  agentPromptKind: string | null,
  replyTo: string | null,
  attachments: OutgoingMessageAttachment[]
) => Promise<boolean>

export function useComposerPrompts(input: {
  enabled?: Ref<boolean>
  roomIdentifier: Ref<string>
  submitComposerMessage: SubmitComposerMessage
}) {
  const menuEl = ref<HTMLDivElement | null>(null)
  const menuOpen = ref(false)
  const autoKeepPolling = ref(false)

  let keepPollingTimer: ReturnType<typeof setInterval> | null = null
  let keepPollingInFlight = false

  function prefsKey(): string {
    const room = input.roomIdentifier.value
    return room ? `lac-prompt-prefs:${room}` : PREFS_KEY
  }

  function persistPrefs() {
    try {
      localStorage.setItem(prefsKey(), JSON.stringify({
        autoKeepPolling: autoKeepPolling.value,
      }))
    } catch { /* silent */ }
  }

  function loadPrefs() {
    if (input.enabled?.value === false) return
    try {
      const raw = localStorage.getItem(prefsKey())
      if (!raw) return
      const saved = JSON.parse(raw)
      autoKeepPolling.value = Boolean(saved.autoKeepPolling)
    } catch {
      autoKeepPolling.value = false
    }
  }

  async function sendAutoPollingPrompt() {
    if (!input.roomIdentifier.value || keepPollingInFlight) return
    keepPollingInFlight = true
    try {
      await input.submitComposerMessage('', 'auto', null, [])
    } finally {
      keepPollingInFlight = false
    }
  }

  function stopKeepPollingLoop() {
    if (keepPollingTimer) {
      clearInterval(keepPollingTimer)
      keepPollingTimer = null
    }
  }

  function startKeepPollingLoop(sendImmediately = true) {
    stopKeepPollingLoop()
    if (input.enabled?.value === false || !autoKeepPolling.value || !input.roomIdentifier.value) return

    if (sendImmediately) {
      void sendAutoPollingPrompt()
    }

    keepPollingTimer = setInterval(() => {
      void sendAutoPollingPrompt()
    }, KEEP_POLLING_INTERVAL_MS)
  }

  function toggleAutoKeepPolling() {
    autoKeepPolling.value = !autoKeepPolling.value
    persistPrefs()

    if (autoKeepPolling.value) {
      startKeepPollingLoop()
    } else {
      stopKeepPollingLoop()
    }
  }

  function handleDocClick(e: MouseEvent) {
    if (menuOpen.value && menuEl.value && !menuEl.value.contains(e.target as Node)) {
      menuOpen.value = false
    }
  }

  onMounted(() => {
    loadPrefs()
    document.addEventListener('click', handleDocClick)
    if (autoKeepPolling.value && input.roomIdentifier.value) {
      startKeepPollingLoop(false)
    }
  })

  onUnmounted(() => {
    stopKeepPollingLoop()
    document.removeEventListener('click', handleDocClick)
  })

  watch(input.roomIdentifier, (newId) => {
    stopKeepPollingLoop()
    loadPrefs()
    if (newId && autoKeepPolling.value) {
      startKeepPollingLoop(false)
    }
  })

  return {
    menuEl,
    menuOpen,
    autoKeepPolling,
    toggleAutoKeepPolling,
    stopKeepPollingLoop,
  }
}
