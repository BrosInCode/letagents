<template>
  <div class="agent-inspector-actions" aria-label="Agent actions">
    <button
      v-for="action in primaryActions"
      :key="action.kind"
      type="button"
      :disabled="busy"
      :data-action="action.kind"
      @click="emitIntent(action)"
    >
      {{ action.label }}
    </button>

    <div v-if="hasOverflow" class="agent-inspector-overflow">
      <button
        ref="overflowTrigger"
        type="button"
        class="agent-inspector-overflow-trigger"
        aria-label="More agent actions"
        aria-haspopup="menu"
        :aria-expanded="overflowOpen"
        @click="toggleOverflow"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" />
        </svg>
      </button>
      <div v-if="overflowOpen" ref="overflowMenu" class="agent-inspector-overflow-menu" role="menu" aria-label="More agent actions" @keydown="handleMenuKeydown">
        <button
          v-for="action in secondaryActions"
          :key="action.kind"
          type="button"
          :disabled="busy"
          role="menuitem"
          :data-action="action.kind"
          @click="emitOverflowIntent(action)"
        >
          {{ action.label }}
        </button>
        <p v-if="confirmDanger">This retires the saved agent. Its history and worktree stay available.</p>
        <button
          v-if="dangerAction"
          type="button"
          class="danger"
          :disabled="busy"
          role="menuitem"
          @click="handleDanger"
        >
          {{ confirmDanger ? "Confirm retire agent" : dangerAction.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type {
  AgentInspectorActionAvailability,
  AgentInspectorActionIntent,
} from "../../../../domain/agent-inspector";

const props = defineProps<{
  entryId: string;
  roomId: string;
  actions: readonly AgentInspectorActionAvailability[];
  busy: boolean;
  compact: boolean;
}>();
const emit = defineEmits<{ action: [intent: AgentInspectorActionIntent] }>();

const overflowOpen = ref(false);
const overflowMenu = ref<HTMLElement | null>(null);
const overflowTrigger = ref<HTMLButtonElement | null>(null);
const confirmDanger = ref(false);
const availableActions = computed(() => props.actions.filter((action) => action.available && !action.danger));
const compactPriority: Record<AgentInspectorActionAvailability["kind"], number> = {
  retry_delivery: 0,
  stop_turn: 1,
  mention: 2,
  reconnect: 3,
  recover: 3,
  resume: 3,
  pause: 4,
  retire_agent: 5,
  save_settings: 6,
  move_room: 6,
  purge_agent: 7,
};
const orderedCompactActions = computed(() => availableActions.value
  .map((action, index) => ({ action, index }))
  .sort((left, right) => compactPriority[left.action.kind] - compactPriority[right.action.kind] || left.index - right.index)
  .map(({ action }) => action));
const primaryActions = computed(() => props.compact ? orderedCompactActions.value.slice(0, 2) : availableActions.value);
const secondaryActions = computed(() => props.compact ? orderedCompactActions.value.slice(2) : []);
const dangerAction = computed(() => props.actions.find((action) => action.available && action.danger) ?? null);
const hasOverflow = computed(() => Boolean(secondaryActions.value.length || dangerAction.value));

watch(() => [props.entryId, props.compact, props.actions] as const, () => {
  overflowOpen.value = false;
  confirmDanger.value = false;
});

function emitIntent(action: AgentInspectorActionAvailability): void {
  emit("action", {
    entryId: props.entryId,
    roomId: props.roomId,
    kind: action.kind,
    ...(action.sourceMessageId ? { sourceMessageId: action.sourceMessageId } : {}),
  });
}

function emitOverflowIntent(action: AgentInspectorActionAvailability): void {
  emitIntent(action);
  overflowOpen.value = false;
  confirmDanger.value = false;
}

function closeOverflow(): void { overflowOpen.value = false; void nextTick(() => overflowTrigger.value?.focus()); }
function toggleOverflow(): void {
  overflowOpen.value = !overflowOpen.value;
  if (overflowOpen.value) void nextTick(() => overflowMenu.value?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
}

function handleMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") { event.preventDefault(); closeOverflow(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...(overflowMenu.value?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
  if (!items.length) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

function handleDanger(): void {
  if (!dangerAction.value) return;
  if (!confirmDanger.value) {
    confirmDanger.value = true;
    return;
  }
  emitIntent(dangerAction.value);
  overflowOpen.value = false;
  confirmDanger.value = false;
}
</script>
