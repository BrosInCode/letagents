import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
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
  roomIdentifier: Ref<string>
  submitComposerMessage: SubmitComposerMessage
}) {
  const menuEl = ref<HTMLDivElement | null>(null)
  const menuOpen = ref(false)
  const autoKeepPolling = ref(false)
  const injectPrompt = ref(false)

  let keepPollingTimer: ReturnType<typeof setInterval> | null = null
  let keepPollingInFlight = false

  const promptMode = computed(() => {
    if (autoKeepPolling.value && injectPrompt.value) return 'auto+inject'
    if (autoKeepPolling.value) return 'auto'
    if (injectPrompt.value) return 'inject'
    return 'off'
  })

  const promptLabel = computed(() => {
    const labels: Record<string, string> = {
      off: 'Inject',
      auto: 'Auto poll',
      inject: 'Inject on',
      'auto+inject': 'Auto + inject',
    }
    return labels[promptMode.value] || 'Inject'
  })

  function prefsKey(): string {
    const room = input.roomIdentifier.value
    return room ? `lac-prompt-prefs:${room}` : PREFS_KEY
  }

  function persistPrefs() {
    try {
      localStorage.setItem(prefsKey(), JSON.stringify({
        autoKeepPolling: autoKeepPolling.value,
        injectPrompt: injectPrompt.value,
      }))
    } catch { /* silent */ }
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(prefsKey())
      if (!raw) return
      const saved = JSON.parse(raw)
      autoKeepPolling.value = Boolean(saved.autoKeepPolling)
      injectPrompt.value = Boolean(saved.injectPrompt)
    } catch {
      autoKeepPolling.value = false
      injectPrompt.value = false
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
    if (!autoKeepPolling.value || !input.roomIdentifier.value) return

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

  function toggleInjectPrompt() {
    injectPrompt.value = !injectPrompt.value
    persistPrefs()
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
    injectPrompt,
    promptMode,
    promptLabel,
    toggleAutoKeepPolling,
    toggleInjectPrompt,
    stopKeepPollingLoop,
  }
}
