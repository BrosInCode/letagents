import type { RoomAgentPresence } from '../../../composables/room/types/presence'
import { isLivePresenceEntry } from '../reachability'

/** How long a connect/disconnect chip stays on screen. */
export const PRESENCE_CHIP_VISIBLE_MS = 4_000
/** Chips shown at once; older ones leave early when more arrive. */
export const PRESENCE_CHIP_LIMIT = 3
/**
 * After a room opens, presence can arrive in more than one piece (a cached
 * snapshot, then the fresh one). Changes in this window refine the starting
 * roster rather than announce anyone.
 */
export const PRESENCE_CHIP_SETTLE_MS = 8_000
/**
 * An agent must stay absent this long before it counts as disconnected. One
 * failed refresh, or a busy agent whose channel looks quiet for a moment,
 * is not a disconnect; returning in time cancels it without any chip.
 */
export const PRESENCE_DISCONNECT_CONFIRM_MS = 20_000

export interface PresenceChipAgent {
  key: string
  displayName: string
  ideLabel: string | null
}

export interface PresenceChip extends PresenceChipAgent {
  id: string
  kind: 'connected' | 'disconnected'
}

/**
 * The agents a person would call connected, keyed by the name the room knows
 * them by rather than a session or agent key: a reconnect mints a new session,
 * and the agent key is missing from some presence sources, and neither must
 * read as one agent leaving and another arriving.
 */
export function reachableAgents(presence: readonly RoomAgentPresence[]): Map<string, PresenceChipAgent> {
  const agents = new Map<string, PresenceChipAgent>()
  for (const entry of presence) {
    if (!isLivePresenceEntry(entry)) continue
    const displayName = entry.display_name?.trim() || entry.actor_label.split(' | ')[0]?.trim() || entry.actor_label
    const key = displayName.toLowerCase()
    if (!key || agents.has(key)) continue
    const ideLabel = entry.ide_label && entry.ide_label !== 'Agent' ? entry.ide_label : null
    agents.set(key, { key, displayName, ideLabel })
  }
  return agents
}

export interface PresenceTracker {
  /** Agents currently counted as connected, including ones briefly missing. */
  known: Map<string, PresenceChipAgent>
  /** When each missing agent was first seen missing. */
  missingSince: Map<string, number>
}

export function createPresenceTracker(initial: ReadonlyMap<string, PresenceChipAgent>): PresenceTracker {
  return { known: new Map(initial), missingSince: new Map() }
}

/**
 * Fold the next presence snapshot into the tracker and report what changed.
 * A new agent is a connect at once. A missing agent is a disconnect only once
 * it has stayed missing for PRESENCE_DISCONNECT_CONFIRM_MS.
 */
export function advancePresenceTracker(
  tracker: PresenceTracker,
  next: ReadonlyMap<string, PresenceChipAgent>,
  now: number,
): Array<{ kind: PresenceChip['kind']; agent: PresenceChipAgent }> {
  const changes: Array<{ kind: PresenceChip['kind']; agent: PresenceChipAgent }> = []
  for (const [key, agent] of next) {
    if (!tracker.known.has(key)) changes.push({ kind: 'connected', agent })
    tracker.known.set(key, agent)
    tracker.missingSince.delete(key)
  }
  for (const [key, agent] of tracker.known) {
    if (next.has(key)) continue
    const since = tracker.missingSince.get(key)
    if (since === undefined) {
      tracker.missingSince.set(key, now)
    } else if (now - since >= PRESENCE_DISCONNECT_CONFIRM_MS) {
      tracker.known.delete(key)
      tracker.missingSince.delete(key)
      changes.push({ kind: 'disconnected', agent })
    }
  }
  return changes
}

/**
 * Add new chips to the visible list. An agent has at most one chip, so a
 * quick drop-and-return shows the latest state instead of stacking two.
 */
export function mergePresenceChips(
  visible: readonly PresenceChip[],
  added: readonly PresenceChip[],
): PresenceChip[] {
  const addedKeys = new Set(added.map((chip) => chip.key))
  return [...visible.filter((chip) => !addedKeys.has(chip.key)), ...added].slice(-PRESENCE_CHIP_LIMIT)
}
