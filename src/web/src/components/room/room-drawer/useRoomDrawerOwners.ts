import { computed, type Ref } from 'vue'
import {
  getSenderColor,
  parseAgentIdentity,
} from '../../../composables/room/identity'
import type { RoomMessage } from '../../../composables/room/types'
import type { DrawerOwnerChip } from './types'

const MAX_VISIBLE_CHIPS = 6

export function getOwnerFromSender(sender: string, source: string | null): string | null {
  const raw = (sender || '').trim()
  if (!raw) return null
  const normalized = raw.toLowerCase()
  if (normalized === 'letagents' || normalized === 'system') return null
  if (source === 'browser') return raw
  const parsed = parseAgentIdentity(sender)
  if (parsed.ownerAttribution) {
    const ownerMatch = parsed.ownerAttribution.match(/^(.+?)(?:'s?\s+agent)$/i)
    if (ownerMatch) return ownerMatch[1].trim()
    return parsed.ownerAttribution
  }
  return null
}

export function useRoomDrawerOwners(messages: Readonly<Ref<readonly RoomMessage[]>>) {
  const allOwners = computed(() => {
    const owners = new Map<string, DrawerOwnerChip>()
    for (const msg of messages.value) {
      const owner = getOwnerFromSender(msg.sender, msg.source)
      if (owner && !owners.has(owner.toLowerCase())) {
        owners.set(owner.toLowerCase(), {
          label: owner,
          color: getSenderColor(msg.sender, msg.source),
        })
      }
    }
    return Array.from(owners.values())
  })

  const visibleOwners = computed(() => allOwners.value.slice(0, MAX_VISIBLE_CHIPS))
  const overflowCount = computed(() => Math.max(0, allOwners.value.length - MAX_VISIBLE_CHIPS))
  const overflowNames = computed(() =>
    allOwners.value.slice(MAX_VISIBLE_CHIPS).map(o => o.label).join(', ')
  )

  return { overflowCount, overflowNames, visibleOwners }
}
