import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
  type Ref,
} from 'vue'
import type {
  WakeRule,
  WakeRuleApi,
  WakeRulePage,
} from '../../../../shared/wake-rules.mjs'
import { roomPath } from './room/api'
import {
  lastWakeRuleInvalidation,
  publishWakeRuleInvalidation,
} from './roomWakeRuleInvalidation'

export class RoomWakeRuleHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Without access (or on a server without wake rules) a room has none to show. */
const CONCEALED_STATUSES = new Set([401, 403, 404])
const RULE_ID = /^wake_[a-z0-9]{1,40}$/
const NO_RULES: readonly WakeRule[] = Object.freeze([])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isWakeRule(value: unknown): value is WakeRule {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.agent_key === 'string' && value.agent_key.length > 0
    && typeof value.event === 'string'
    && isRecord(value.arguments)
    && typeof value.status === 'string'
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string'
    && typeof value.expires_at === 'string'
}

export function parseWakeRulePage(value: unknown): WakeRulePage | null {
  if (!isRecord(value) || !Array.isArray(value.active) || !Array.isArray(value.recent)) return null
  return {
    room_id: typeof value.room_id === 'string' ? value.room_id : '',
    // A rule this app cannot read is left out instead of hiding every other rule.
    active: value.active.filter(isWakeRule),
    recent: value.recent.filter(isWakeRule),
  }
}

async function requestJson(path: string, init: RequestInit, fallback: string): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!response.ok) {
    let message = fallback
    try {
      const payload = await response.json()
      if (typeof payload?.error === 'string' && payload.error.trim()) message = payload.error
    } catch {
      // A status page is not a sentence people can act on; keep the fallback.
    }
    throw new RoomWakeRuleHttpError(message, response.status)
  }
  return response.json()
}

export async function fetchRoomWakeRules(roomIdentifier: string): Promise<WakeRulePage> {
  const page = parseWakeRulePage(await requestJson(
    `${roomPath(roomIdentifier)}/wake-rules`,
    {},
    'Wake rules could not be loaded.',
  ))
  if (!page) throw new Error('Wake rules could not be loaded.')
  return page
}

async function changeRoomWakeRule(
  roomIdentifier: string,
  ruleId: string,
  action: 'cancel' | 'restore',
): Promise<WakeRule> {
  const fallback = action === 'cancel'
    ? "Couldn't cancel this wake rule. Try again."
    : "Couldn't restore this wake rule."
  if (!RULE_ID.test(ruleId)) throw new Error(fallback)
  const body = await requestJson(
    `${roomPath(roomIdentifier)}/wake-rules/${encodeURIComponent(ruleId)}/${action}`,
    { method: 'POST', body: '{}' },
    fallback,
  )
  const rule = isRecord(body) ? body.rule : null
  if (!isWakeRule(rule)) throw new Error(fallback)
  return rule
}

export function cancelRoomWakeRule(roomIdentifier: string, ruleId: string): Promise<WakeRule> {
  return changeRoomWakeRule(roomIdentifier, ruleId, 'cancel')
}

export function restoreRoomWakeRule(roomIdentifier: string, ruleId: string): Promise<WakeRule> {
  return changeRoomWakeRule(roomIdentifier, ruleId, 'restore')
}

/** Rules keyed by the agent that set them, in the order the server sent them. */
export function groupWakeRulesByAgent(
  rules: readonly WakeRule[],
): ReadonlyMap<string, readonly WakeRule[]> {
  const grouped = new Map<string, WakeRule[]>()
  for (const rule of rules) {
    const agentRules = grouped.get(rule.agent_key)
    if (agentRules) agentRules.push(rule)
    else grouped.set(rule.agent_key, [rule])
  }
  return grouped
}

export function wakeRulesForAgent(
  grouped: ReadonlyMap<string, readonly WakeRule[]> | null | undefined,
  agentKey: string | null | undefined,
): readonly WakeRule[] {
  return (agentKey && grouped?.get(agentKey)) || NO_RULES
}

interface WakeRuleRefreshFlight {
  generation: number
  trailing: boolean
  promise: Promise<boolean>
}

/**
 * What each agent in a room is waiting for. Re-reads when the room stream
 * says the room's rules changed, and after a person cancels or restores one.
 */
export function useRoomWakeRules(roomIdentifier: Ref<string>) {
  const page = shallowRef<WakeRulePage | null>(null)
  let generation = 0
  let refreshFlight: WakeRuleRefreshFlight | null = null

  async function refreshOnce(): Promise<boolean> {
    const roomId = roomIdentifier.value
    const requestGeneration = generation
    if (!roomId) return false
    try {
      const next = await fetchRoomWakeRules(roomId)
      if (requestGeneration !== generation || roomIdentifier.value !== roomId) return false
      page.value = next
      return true
    } catch (cause) {
      if (requestGeneration !== generation || roomIdentifier.value !== roomId) return false
      if (cause instanceof RoomWakeRuleHttpError && CONCEALED_STATUSES.has(cause.status)) {
        page.value = null
        return true
      }
      // Keep the last known rules: a failed refresh must not make an agent
      // look like it stopped waiting. The next invalidation retries.
      return false
    }
  }

  /** One read at a time; a burst of invalidations becomes one trailing read. */
  function refresh(): Promise<boolean> {
    if (refreshFlight?.generation === generation) {
      refreshFlight.trailing = true
      return refreshFlight.promise
    }
    const flight: WakeRuleRefreshFlight = {
      generation,
      trailing: false,
      promise: Promise.resolve(false),
    }
    flight.promise = (async () => {
      let success = true
      do {
        flight.trailing = false
        success = await refreshOnce() && success
      } while (flight.trailing && flight.generation === generation)
      return success
    })().finally(() => {
      if (refreshFlight === flight) refreshFlight = null
    })
    refreshFlight = flight
    return flight.promise
  }

  watch(roomIdentifier, () => {
    generation += 1
    // Another room's rules must never show under this room's agents.
    page.value = null
    if (roomIdentifier.value) void refresh()
  }, { immediate: true })

  watch(lastWakeRuleInvalidation, (invalidation) => {
    if (invalidation && invalidation.roomId === roomIdentifier.value) void refresh()
  })

  onScopeDispose(() => {
    generation += 1
  })

  const api: Pick<WakeRuleApi, 'cancel' | 'restore'> = {
    async cancel(roomId, ruleId) {
      const rule = await cancelRoomWakeRule(roomId, ruleId)
      publishWakeRuleInvalidation(roomId)
      return rule
    },
    async restore(roomId, ruleId) {
      const rule = await restoreRoomWakeRule(roomId, ruleId)
      publishWakeRuleInvalidation(roomId)
      return rule
    },
  }

  return {
    page,
    activeByAgentKey: computed(() => groupWakeRulesByAgent(page.value?.active ?? NO_RULES)),
    recentByAgentKey: computed(() => groupWakeRulesByAgent(page.value?.recent ?? NO_RULES)),
    api,
    refresh,
  }
}
