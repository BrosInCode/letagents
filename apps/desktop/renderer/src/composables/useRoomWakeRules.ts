import { computed, inject, provide, reactive, ref, watch, type ComputedRef, type InjectionKey, type Ref } from "vue";

import type { WakeRule, WakeRuleApi, WakeRulePage } from "../../../../../shared/wake-rules.mjs";
import { normalizeRoomIdentifier } from "../domain/sidebar-rooms";
import { desktopIpc } from "../ipc/index";

/**
 * Bumped when the room stream says a room's wake rules changed. Every open
 * view of that room re-reads them; the pointer itself carries no content.
 */
const revisions = reactive(new Map<string, number>());

export function invalidateRoomWakeRules(roomIdentifier: string): void {
  const key = normalizeRoomIdentifier(roomIdentifier);
  if (key) revisions.set(key, (revisions.get(key) ?? 0) + 1);
}

function groupByAgent(rules: readonly WakeRule[]): ReadonlyMap<string, WakeRule[]> {
  const grouped = new Map<string, WakeRule[]>();
  for (const rule of rules) grouped.set(rule.agent_key, [...(grouped.get(rule.agent_key) ?? []), rule]);
  return grouped;
}

export function useRoomWakeRules(roomIdentifier: Ref<string>, enabled: Ref<boolean>) {
  const page = ref<WakeRulePage | null>(null);
  let generation = 0;

  async function refresh(): Promise<void> {
    const version = ++generation;
    if (!enabled.value) {
      page.value = null;
      return;
    }
    try {
      const next = await desktopIpc.room.getWakeRules(roomIdentifier.value);
      if (version === generation) page.value = next;
    } catch {
      // Keep the last known rules: a failed refresh must not make an agent
      // look like it stopped waiting. The next invalidation retries.
    }
  }

  watch(
    () => [roomIdentifier.value, enabled.value, revisions.get(normalizeRoomIdentifier(roomIdentifier.value) ?? "") ?? 0] as const,
    (current, previous) => {
      // Another room's rules must never show under this room's agents.
      if (previous && previous[0] !== current[0]) page.value = null;
      void refresh();
    },
    { immediate: true },
  );

  const api: Pick<WakeRuleApi, "cancel" | "restore"> = {
    async cancel(roomId, ruleId) {
      const rule = await desktopIpc.room.cancelWakeRule(roomId, ruleId);
      invalidateRoomWakeRules(roomId);
      return rule;
    },
    async restore(roomId, ruleId) {
      const rule = await desktopIpc.room.restoreWakeRule(roomId, ruleId);
      invalidateRoomWakeRules(roomId);
      return rule;
    },
  };

  return {
    page,
    activeByAgentKey: computed(() => groupByAgent(page.value?.active ?? [])),
    recentByAgentKey: computed(() => groupByAgent(page.value?.recent ?? [])),
    api,
    refresh,
  };
}

/** What an agent inspector needs to show and change one room's wake rules. */
export interface RoomWakeRuleContext {
  roomIdentifier: Ref<string>;
  activeByAgentKey: ComputedRef<ReadonlyMap<string, WakeRule[]>>;
  recentByAgentKey: ComputedRef<ReadonlyMap<string, WakeRule[]>>;
  api: Pick<WakeRuleApi, "cancel" | "restore">;
  openMessage(messageId: string): void;
}

const ROOM_WAKE_RULES: InjectionKey<RoomWakeRuleContext> = Symbol("room-wake-rules");

export function provideRoomWakeRules(context: RoomWakeRuleContext): void {
  provide(ROOM_WAKE_RULES, context);
}

export function injectRoomWakeRules(): RoomWakeRuleContext | null {
  return inject(ROOM_WAKE_RULES, null);
}
