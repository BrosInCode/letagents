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

    <div v-if="hasOverflow" ref="overflowRoot" class="agent-inspector-overflow" @focusout="handleOverflowFocusOut">
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
        <p v-if="confirmDanger">{{ AGENT_INSPECTOR_RETIRE_CONFIRMATION }}</p>
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  AgentInspectorActionAvailability,
  AgentInspectorActionIntent,
} from "../../../../domain/agent-inspector";
import { AGENT_INSPECTOR_RETIRE_CONFIRMATION } from "../../../../domain/agent-inspector-settings";

const props = defineProps<{
  entryId: string;
  roomId: string;
  actions: readonly AgentInspectorActionAvailability[];
  busy: boolean;
  compact: boolean;
}>();
const emit = defineEmits<{ action: [intent: AgentInspectorActionIntent] }>();

const overflowOpen = ref(false);
const overflowRoot = ref<HTMLElement | null>(null);
const overflowMenu = ref<HTMLElement | null>(null);
const overflowTrigger = ref<HTMLButtonElement | null>(null);
const confirmDanger = ref(false);
// Turn control belongs beside the live "Now" state. Keeping it out of the
// generic lifecycle bar prevents a destructive-looking stop control from
// competing with routine agent actions.
const availableActions = computed(() => props.actions.filter((action) =>
  action.available
  && !action.danger
  && action.kind !== "stop_turn"
  && action.kind !== "restore_conversation"
  && action.kind !== "skip_message"));
const compactPriority: Record<AgentInspectorActionAvailability["kind"], number> = {
  retry_delivery: 0,
  restore_conversation: 0,
  skip_message: 1,
  stop_turn: 1,
  steer_turn: 1,
  resolve_turn_control: 1,
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

function closeOverflow(returnFocus = true): void {
  if (!overflowOpen.value) return;
  overflowOpen.value = false;
  confirmDanger.value = false;
  if (returnFocus) void nextTick(() => overflowTrigger.value?.focus());
}
function toggleOverflow(): void {
  if (overflowOpen.value) {
    closeOverflow(false);
    return;
  }
  overflowOpen.value = true;
  void nextTick(() => overflowMenu.value?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
}

function handleMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeOverflow();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...(overflowMenu.value?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
  if (!items.length) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!overflowOpen.value || overflowRoot.value?.contains(event.target as Node)) return;
  closeOverflow(false);
}

function handleOverflowFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && overflowRoot.value?.contains(next)) return;
  void nextTick(() => {
    if (!overflowRoot.value?.contains(document.activeElement)) closeOverflow(false);
  });
}

function handleDanger(): void {
  if (!dangerAction.value) return;
  if (!confirmDanger.value) {
    confirmDanger.value = true;
    return;
  }
  emitIntent(dangerAction.value);
  closeOverflow();
}

onMounted(() => document.addEventListener("pointerdown", handleDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", handleDocumentPointerDown));
</script>
