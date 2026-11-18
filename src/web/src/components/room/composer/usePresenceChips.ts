import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { RoomAgentPresence } from '../../../composables/room/types/presence'
import {
  createPresenceChipController,
  type PresenceChip,
  type PresenceChipSource,
} from '../../../../../../shared/ui/presence-chips'

/** Map web (API) presence into the shared chip input. */
export function presenceChipSource(entry: RoomAgentPresence): PresenceChipSource {
  return {
    sessionKind: entry.session_kind,
    sourceFlags: entry.source_flags,
    freshness: entry.freshness,
    displayName: entry.display_name,
    actorLabel: entry.actor_label,
    ideLabel: entry.ide_label,
    agentKey: entry.agent_key,
  }
}

/**
 * Short-lived chips for agents connecting to or leaving the open room. The
 * shared controller holds the rules; this connects it to Vue.
 */
export function usePresenceChips(input: {
  presence: () => readonly RoomAgentPresence[]
  scope: () => string | null | undefined
  /** False until the room's presence has actually loaded. */
  ready: () => boolean
}): { chips: Ref<PresenceChip[]> } {
  const chips = ref<PresenceChip[]>([])
  const controller = createPresenceChipController({
    getChips: () => chips.value,
    setChips: (next) => { chips.value = next },
  })
  watch(
    () => [input.scope(), input.ready(), input.presence()] as const,
    ([scope, ready, presence]) => controller.update({ scope, ready, presence: presence.map(presenceChipSource) }),
    { immediate: true },
  )
  onScopeDispose(controller.dispose)
  return { chips }
}
