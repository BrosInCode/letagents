import { onScopeDispose, ref, watch, type Ref } from "vue";
import type { DesktopAgentPresence } from "../../../electron/ipc-types";
import { createPresenceChipController, type PresenceChip } from "../../../../../shared/ui/presence-chips";

/**
 * Short-lived chips for agents connecting to or leaving the open room. The
 * shared controller holds the rules; this connects it to Vue.
 */
export function useAgentPresenceChips(input: {
  presence: () => readonly DesktopAgentPresence[];
  scope: () => string | null;
  ready: () => boolean;
  /** Every change, before the visible list drops any: the room's activity line and timeline follow these. */
  onChanges?: (changes: PresenceChip[]) => void;
}): { chips: Ref<PresenceChip[]> } {
  const chips = ref<PresenceChip[]>([]);
  const controller = createPresenceChipController({
    getChips: () => chips.value,
    setChips: (next) => { chips.value = next; },
    onChanges: input.onChanges,
  });
  watch(
    () => [input.scope(), input.ready(), input.presence()] as const,
    ([scope, ready, presence]) => controller.update({ scope, ready, presence }),
    { immediate: true },
  );
  onScopeDispose(controller.dispose);
  return { chips };
}
