import { computed, readonly, ref } from 'vue'
import { buildDesktopRoomLink } from '../../../../shared/room-app-links.mjs'
import { MAC_DESKTOP_BETA, detectDesktopVisitorPlatform, type DesktopVisitorPlatform } from '../domain/desktopRelease'

/** localStorage: 'always' once the person chose to open rooms in the app on load. */
export const OPEN_IN_DESKTOP_PREFERENCE_KEY = 'lac-open-in-desktop'
/** sessionStorage: the rooms whose pill was closed in this tab session. */
export const OPEN_IN_DESKTOP_DISMISSED_KEY = 'lac-open-in-desktop-dismissed'

export type OpenInDesktopState = 'offer' | 'opening'

export interface OpenInDesktopDeps {
  platform(): DesktopVisitorPlatform
  /** Hands the `letagents://in/<room>` link to the browser, which asks the OS to open the app. */
  navigate(link: string): void
  readPreference(): 'always' | null
  writePreference(value: 'always' | null): void
  readDismissed(): string[]
  writeDismissed(roomIds: string[]): void
}

/**
 * "Open this room in LetAgents Desktop": one pill above the composer, on a
 * Mac or Windows browser, once per room per tab session. Open hands the room
 * to the app; Always remembers that and opens the app on every later load; ×
 * closes the pill for this session. While the app is opening, the pill says
 * so and offers to open again or to download the app, because a missing app
 * makes the link do nothing at all.
 */
export function createOpenInDesktop(deps: OpenInDesktopDeps) {
  const roomId = ref<string | null>(null)
  const always = ref(deps.readPreference() === 'always')
  const dismissed = ref<ReadonlySet<string>>(new Set(deps.readDismissed()))
  const opened = ref(false)
  const supported = computed(() => deps.platform() !== 'other')
  const visible = computed(() => Boolean(roomId.value) && supported.value && !dismissed.value.has(roomId.value!))
  const state = computed<OpenInDesktopState>(() => (opened.value ? 'opening' : 'offer'))
  const link = computed(() => (roomId.value ? buildDesktopRoomLink(roomId.value) : ''))
  const downloadHref = computed(() => deps.platform() === 'windows'
    ? MAC_DESKTOP_BETA.downloads.windows ?? '/#download-mac'
    : MAC_DESKTOP_BETA.downloads.arm64)

  /** The room the page shows. With Always on, the app opens as soon as the room is known. */
  function setRoom(id: string | null) {
    if (roomId.value === id) return
    roomId.value = id
    opened.value = false
    if (id && always.value && visible.value) open()
  }

  function open() {
    if (!link.value) return
    opened.value = true
    deps.navigate(link.value)
  }

  function openAlways() {
    always.value = true
    deps.writePreference('always')
    open()
  }

  /** Turns Always off and closes the pill for this session. */
  function stopAlways() {
    always.value = false
    deps.writePreference(null)
    dismiss()
  }

  function dismiss() {
    if (!roomId.value) return
    const next = new Set(dismissed.value)
    next.add(roomId.value)
    dismissed.value = next
    deps.writeDismissed([...next].slice(-100))
  }

  return {
    roomId: readonly(roomId),
    always: readonly(always),
    supported,
    visible,
    state,
    link,
    downloadHref,
    setRoom,
    open,
    openAlways,
    stopAlways,
    dismiss,
  }
}

function readJsonList(storage: Storage | undefined, key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function storage(name: 'localStorage' | 'sessionStorage'): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window[name] : undefined
  } catch {
    return undefined
  }
}

export const openInDesktop = createOpenInDesktop({
  platform: () => detectDesktopVisitorPlatform(typeof navigator !== 'undefined' ? navigator : undefined),
  navigate: (href) => { window.location.assign(href) },
  readPreference: () => (storage('localStorage')?.getItem(OPEN_IN_DESKTOP_PREFERENCE_KEY) === 'always' ? 'always' : null),
  writePreference: (value) => {
    try {
      if (value) storage('localStorage')?.setItem(OPEN_IN_DESKTOP_PREFERENCE_KEY, value)
      else storage('localStorage')?.removeItem(OPEN_IN_DESKTOP_PREFERENCE_KEY)
    } catch { /* The choice lasts for this page only. */ }
  },
  readDismissed: () => readJsonList(storage('sessionStorage'), OPEN_IN_DESKTOP_DISMISSED_KEY),
  writeDismissed: (ids) => {
    try { storage('sessionStorage')?.setItem(OPEN_IN_DESKTOP_DISMISSED_KEY, JSON.stringify(ids)) } catch { /* Same. */ }
  },
})
