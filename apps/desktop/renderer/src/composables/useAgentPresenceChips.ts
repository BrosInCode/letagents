import { onScopeDispose, ref, watch, type Ref } from "vue";
import type { DesktopAgentPresence } from "../../../electron/ipc-types";
import {
  advancePresenceTracker,
  createPresenceTracker,
  mergePresenceChips,
  PRESENCE_CHIP_SETTLE_MS,
  PRESENCE_CHIP_VISIBLE_MS,
  PRESENCE_DISCONNECT_CONFIRM_MS,
  reachableAgents,
  type PresenceChip,
  type PresenceChipAgent,
  type PresenceTracker,
} from "../domain/presence-chips";

/**
 * Short-lived chips for agents connecting to or leaving the open room. The
 * roster a room opens with is the baseline: nobody is announced for already
 * being there, and switching rooms starts over.
 */
export function useAgentPresenceChips(input: {
  presence: () => readonly DesktopAgentPresence[];
  scope: () => string | null;
  ready: () => boolean;
}): { chips: Ref<PresenceChip[]> } {
  const chips = ref<PresenceChip[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let tracker: PresenceTracker | null = null;
  let baselineScope: string | null = null;
  let settledAt = 0;
  let sequence = 0;
  let lastNext: Map<string, PresenceChipAgent> = new Map();
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;

  function clearChips(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    chips.value = [];
  }

  function dismiss(id: string): void {
    timers.delete(id);
    chips.value = chips.value.filter((chip) => chip.id !== id);
  }

  /**
   * Apply the latest snapshot. A disconnect is confirmed by time, not by the
   * next refresh arriving, so a pending one re-runs this on a timer.
   */
  function advance(now: number): void {
    if (!tracker) return;
    const changes = advancePresenceTracker(tracker, lastNext, now);
    if (tracker.missingSince.size === 0) {
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = null;
    } else if (!confirmTimer) {
      confirmTimer = setTimeout(() => {
        confirmTimer = null;
        advance(Date.now());
      }, PRESENCE_DISCONNECT_CONFIRM_MS);
    }
    if (changes.length === 0) return;

    const added = changes.map(({ kind, agent }): PresenceChip => ({
      ...agent,
      kind,
      id: `${agent.key}:${kind}:${sequence += 1}`,
    }));
    const visible = mergePresenceChips(chips.value, added);
    const visibleIds = new Set(visible.map((chip) => chip.id));
    for (const [id, timer] of timers) {
      if (visibleIds.has(id)) continue;
      clearTimeout(timer);
      timers.delete(id);
    }
    chips.value = visible;
    for (const chip of added) {
      if (!visibleIds.has(chip.id)) continue;
      timers.set(chip.id, setTimeout(() => dismiss(chip.id), PRESENCE_CHIP_VISIBLE_MS));
    }
  }

  watch(
    () => [input.scope(), input.ready(), input.presence()] as const,
    ([scope, ready, presence]) => {
      if (!scope || !ready) {
        tracker = null;
        baselineScope = null;
        clearChips();
        return;
      }
      const next = reachableAgents(presence);
      const now = Date.now();
      if (!tracker || baselineScope !== scope) {
        clearChips();
        tracker = createPresenceTracker(next);
        baselineScope = scope;
        settledAt = now + PRESENCE_CHIP_SETTLE_MS;
        return;
      }
      if (now < settledAt) {
        tracker = createPresenceTracker(next);
        return;
      }
      lastNext = next;
      advance(now);
    },
    { immediate: true },
  );

  onScopeDispose(clearChips);
  return { chips };
}
