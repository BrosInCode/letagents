<template>
  <aside
    ref="surfaceElement"
    class="agent-inspector-surface"
    :data-compact="compact"
    :data-state="projection.overallState"
    :role="compact ? 'dialog' : 'complementary'"
    :aria-modal="compact ? 'true' : undefined"
    aria-labelledby="agent-inspector-title"
    @keydown="handleKeydown"
  >
    <header class="agent-inspector-header">
      <div class="agent-inspector-identity">
        <ProviderBadge :label="projection.provider" :agent-key="projection.entry.agentKey" />
        <div>
          <div class="agent-inspector-name-line">
            <h2 id="agent-inspector-title">{{ projection.displayName }}</h2>
            <span class="agent-inspector-state-label" :data-state="projection.overallState">
              <span aria-hidden="true"></span>{{ projection.overallLabel }}
            </span>
          </div>
          <p>
            <span v-if="projection.ownerAttribution">{{ projection.ownerAttribution }} · </span>
            {{ providerModelLabel }}
          </p>
        </div>
      </div>
      <button ref="closeButton" type="button" class="agent-inspector-close" aria-label="Close agent inspector" @click="emit('close')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </header>

    <div class="agent-inspector-status-copy">
      <strong>{{ projection.overallLabel }}</strong>
      <p>{{ projection.overallDetail }}</p>
    </div>

    <p v-if="projection.resourceFreshness === 'stale'" class="agent-inspector-stale-banner" role="status">
      Showing the last known agent state. Controls that depend on live state are unavailable until the supervisor reconnects.
    </p>

    <AgentInspectorLifecycleActions
      :entry-id="projection.entryId"
      :room-id="projection.roomId"
      :actions="projection.actions"
      :busy="actionState?.status === 'running'"
      :compact="compact"
      @action="emit('action', $event)"
    />

    <p
      v-if="actionState?.message"
      class="agent-inspector-action-message"
      :data-state="actionState.status"
      aria-live="polite"
    >
      {{ actionState.message }}
    </p>

    <div class="agent-inspector-scroll-region">
      <AgentInspectorOverview :projection="projection" />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  AgentInspectorActionIntent,
  AgentInspectorActionState,
  AgentInspectorProjection,
} from "../../../../domain/agent-inspector";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";
import AgentInspectorLifecycleActions from "./AgentInspectorLifecycleActions.vue";
import AgentInspectorOverview from "./AgentInspectorOverview.vue";

const props = defineProps<{
  projection: AgentInspectorProjection;
  actionState: AgentInspectorActionState | null;
  compact: boolean;
}>();
const emit = defineEmits<{
  close: [];
  action: [intent: AgentInspectorActionIntent];
}>();

const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const providerModelLabel = computed(() => [props.projection.provider, props.projection.model].filter(Boolean).join(" · "));

function focusInitial(): void {
  closeButton.value?.focus({ preventScroll: true });
}

function containsFocus(): boolean {
  return Boolean(surfaceElement.value?.contains(document.activeElement));
}

defineExpose({ focusInitial, containsFocus });

function handleKeydown(event: KeyboardEvent): void {
  if (!props.compact && event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (!props.compact || event.key !== "Tab" || !surfaceElement.value) return;
  const focusable = [...surfaceElement.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>
