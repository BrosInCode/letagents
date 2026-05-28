import { computed, ref, watch } from 'vue'
import type { RoomGitHubEvent } from '@/composables/useRoom'
import { labelForType } from './labels'
import { formatEventDay } from './time'
import type {
  GitHubEventFilter,
  GitHubEventFilterOption,
  GitHubEventGroup,
} from './types'

export function useGitHubEventFeed(getEvents: () => readonly RoomGitHubEvent[]) {
  const selectedFilter = ref<GitHubEventFilter>('all')

  const pullRequestCount = computed(() =>
    getEvents().filter((event) => event.event_type === 'pull_request').length
  )

  const checkRunCount = computed(() =>
    getEvents().filter((event) => event.event_type === 'check_run').length
  )

  const filterOptions = computed<GitHubEventFilterOption[]>(() => {
    const events = getEvents()
    const counts = new Map<string, number>()
    for (const event of events) {
      counts.set(event.event_type, (counts.get(event.event_type) || 0) + 1)
    }

    return [
      { value: 'all', label: 'All', count: events.length },
      ...Array.from(counts.entries()).map(([value, count]) => ({
        value: value as RoomGitHubEvent['event_type'],
        label: labelForType(value),
        count,
      })),
    ]
  })

  watch(filterOptions, (options) => {
    if (options.some((option) => option.value === selectedFilter.value)) return
    selectedFilter.value = 'all'
  })

  const filteredEvents = computed(() => {
    const events = getEvents()
    if (selectedFilter.value === 'all') return events
    return events.filter((event) => event.event_type === selectedFilter.value)
  })

  const groupedEvents = computed<GitHubEventGroup[]>(() => {
    const groups = new Map<string, GitHubEventGroup>()

    for (const event of filteredEvents.value) {
      const key = event.created_at.slice(0, 10)
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: formatEventDay(event.created_at),
          events: [],
        })
      }
      groups.get(key)!.events.push(event)
    }

    return Array.from(groups.values())
  })

  return {
    checkRunCount,
    filteredEvents,
    filterOptions,
    groupedEvents,
    pullRequestCount,
    selectedFilter,
  }
}
