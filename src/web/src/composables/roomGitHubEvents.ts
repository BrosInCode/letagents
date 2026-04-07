export interface RoomGitHubEventsError {
  status: number | null
  message: string
}

export interface RoomGitHubEventsFetchResult<TEvent = unknown> {
  events: TEvent[]
  available: boolean
  hasMore: boolean
  error: RoomGitHubEventsError | null
}

const REPO_BACKED_ROOM_RE = /^github\.com\/[^/]+\/[^/]+$/i

export function isRepoBackedRoomId(identifier: string | null | undefined): boolean {
  const normalized = String(identifier || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return REPO_BACKED_ROOM_RE.test(normalized)
}

export function toAvailableGitHubEventsResult<TEvent>(payload: {
  events?: TEvent[]
  has_more?: boolean
}): RoomGitHubEventsFetchResult<TEvent> {
  return {
    events: Array.isArray(payload.events) ? payload.events : [],
    available: Array.isArray(payload.events),
    hasMore: payload.has_more === true,
    error: null,
  }
}

export function toUnavailableGitHubEventsResult<TEvent>(): RoomGitHubEventsFetchResult<TEvent> {
  return {
    events: [],
    available: false,
    hasMore: false,
    error: null,
  }
}

export function mapGitHubEventsFetchError<TEvent>(error: {
  status?: number
  message?: string
}): RoomGitHubEventsFetchResult<TEvent> {
  if (error.status === 404) {
    return toUnavailableGitHubEventsResult<TEvent>()
  }

  return {
    events: [],
    available: true,
    hasMore: false,
    error: {
      status: error.status ?? null,
      message: error.message || 'Could not load GitHub events.',
    },
  }
}
