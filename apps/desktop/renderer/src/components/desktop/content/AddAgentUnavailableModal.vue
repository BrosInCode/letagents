<template>
  <Teleport to="body">
    <Transition name="desktop-add-agent-dialog" @after-leave="handleAfterLeave">
      <div
        v-if="open"
        class="desktop-add-agent-backdrop"
        data-testid="desktop-add-agent-unavailable-modal"
        @click.self="emit('close')"
      >
        <section
          ref="dialogElement"
          class="desktop-add-agent-modal desktop-add-agent-unavailable"
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-add-agent-unavailable-title"
          tabindex="-1"
          @keydown.esc.prevent="emit('close')"
          @keydown.tab="handleDialogTab"
        >
          <header class="desktop-add-agent-header">
            <div>
              <h3 id="desktop-add-agent-unavailable-title">Add agent</h3>
            </div>
            <button
              class="desktop-modal-close"
              type="button"
              aria-label="Close add agent dialog"
              @click="emit('close')"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div class="desktop-add-agent-unavailable-body">
            <SupervisedAgentsUnavailableNotice />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { X } from "@lucide/vue";
import { nextTick, ref, watch } from "vue";
import SupervisedAgentsUnavailableNotice from "./SupervisedAgentsUnavailableNotice.vue";
import { currentFocusableElement, restoreFocus, trapFocusInDialog } from "./modal-focus";

/** "Add agent" where this app cannot run agents: the same window, with one calm notice. */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialogElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;

watch(() => props.open, (open) => {
  if (!open) return;
  previousFocusElement = currentFocusableElement();
  void nextTick(() => dialogElement.value?.focus());
}, { immediate: true });

function handleAfterLeave(): void {
  if (props.open) return;
  restoreFocus(previousFocusElement);
  previousFocusElement = null;
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}
</script>

<style scoped>
.desktop-add-agent-unavailable {
  grid-template-rows: auto auto;
  width: min(520px, calc(100vw - 48px));
}

.desktop-add-agent-unavailable-body {
  padding: 20px var(--add-agent-padding) var(--add-agent-padding);
}
</style>
