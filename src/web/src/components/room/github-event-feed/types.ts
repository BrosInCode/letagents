import type { RoomGitHubEvent } from '@/composables/useRoom'

export type GitHubEventFilter = 'all' | RoomGitHubEvent['event_type']

export interface GitHubEventFilterOption {
  value: GitHubEventFilter
  label: string
  count: number
}

export interface GitHubEventGroup {
  key: string
  label: string
  events: RoomGitHubEvent[]
}
