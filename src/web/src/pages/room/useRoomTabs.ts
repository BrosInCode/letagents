import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'

import { ROOM_TABS, type RoomTab } from './types'

export function useRoomTabs(input: {
  route: RouteLocationNormalizedLoaded
  router: Router
  githubEventsSupported: ComputedRef<boolean>
  isConnected: Readonly<Ref<boolean>>
}) {
  const activeTab = ref<RoomTab>('chat')
  const tabTransitionDirection = ref<'forward' | 'back'>('forward')
  const visibleTabOrder = computed(() =>
    ROOM_TABS.filter(tab => tab !== 'events' || input.githubEventsSupported.value)
  )
  const tabTransitionName = computed(() =>
    tabTransitionDirection.value === 'forward' ? 'tab-slide-forward' : 'tab-slide-back'
  )

  function normalizeRoomTab(rawValue: unknown): RoomTab {
    const requested = typeof rawValue === 'string' ? rawValue : ''
    if (!ROOM_TABS.includes(requested as RoomTab)) {
      return 'chat'
    }

    if (requested === 'events' && !input.githubEventsSupported.value) {
      return 'chat'
    }

    return requested as RoomTab
  }

  function syncViewQuery(tab: RoomTab, mode: 'push' | 'replace' = 'replace') {
    const current = typeof input.route.query.view === 'string' ? input.route.query.view : ''
    if (current === tab) {
      return
    }

    const navigate = mode === 'push' ? input.router.push : input.router.replace
    void navigate({
      query: {
        ...input.route.query,
        view: tab,
      },
    })
  }

  function setActiveTab(nextTab: RoomTab) {
    if (activeTab.value === nextTab) return

    const order = visibleTabOrder.value
    const currentIndex = order.indexOf(activeTab.value)
    const nextIndex = order.indexOf(nextTab)
    if (currentIndex >= 0 && nextIndex >= 0) {
      tabTransitionDirection.value = nextIndex > currentIndex ? 'forward' : 'back'
    }
    activeTab.value = nextTab
  }

  function applyRouteTab(rawValue: unknown) {
    const nextTab = normalizeRoomTab(rawValue)
    setActiveTab(nextTab)
    syncViewQuery(nextTab, 'replace')
  }

  function handleActiveTabChange(rawValue: RoomTab) {
    const nextTab = normalizeRoomTab(rawValue)
    setActiveTab(nextTab)
    syncViewQuery(nextTab, 'push')
  }

  watch(() => input.route.query.view, (newView) => {
    applyRouteTab(newView)
  })

  watch(input.githubEventsSupported, (supported) => {
    if (!supported && activeTab.value === 'events' && input.isConnected.value) {
      activeTab.value = 'chat'
      syncViewQuery('chat', 'replace')
    }
  })

  return {
    activeTab,
    tabTransitionName,
    applyRouteTab,
    handleActiveTabChange,
    setActiveTab,
    syncViewQuery,
  }
}
