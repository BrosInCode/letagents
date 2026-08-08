<template>
  <Teleport to="body">
    <Transition name="sidebar-batch-dialog" @after-leave="handleAfterLeave">
      <div
        v-if="open && action"
        class="desktop-modal-backdrop"
        data-testid="sidebar-room-batch-action-dialog"
        @click.self="requestClose"
      >
        <section
          ref="dialogElement"
          class="desktop-new-room-modal sidebar-batch-dialog-surface"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sidebar-batch-dialog-title"
          aria-describedby="sidebar-batch-dialog-description"
          :aria-busy="busy ? 'true' : 'false'"
          tabindex="-1"
          @keydown.esc.stop.prevent="requestClose"
          @keydown.tab="handleDialogTab"
        >
          <header class="desktop-new-room-header">
            <div class="desktop-new-room-heading">
              <p class="desktop-new-room-kicker">Selected rooms</p>
              <h2 id="sidebar-batch-dialog-title">{{ title }}</h2>
              <p id="sidebar-batch-dialog-description">{{ description }}</p>
            </div>
            <button
              class="desktop-modal-close"
              type="button"
              aria-label="Close batch action dialog"
              :disabled="busy"
              @click="requestClose"
            >
              <X aria-hidden="true" />
            </button>
          </header>

          <div class="sidebar-batch-dialog-room-list" aria-label="Rooms affected">
            <div v-for="entry in visibleEntries" :key="entry.id">
              <span aria-hidden="true">
                <MessageSquare v-if="entry.kind === 'focus'" />
                <House v-else />
              </span>
              <strong>{{ entry.title }}</strong>
            </div>
            <p v-if="hiddenEntryCount">and {{ hiddenEntryCount }} more</p>
          </div>

          <p v-if="error" ref="errorElement" class="desktop-new-room-feedback" data-state="error" role="alert" tabindex="-1">
            {{ error }}
          </p>

          <footer class="sidebar-batch-dialog-actions">
            <button
              ref="cancelButton"
              class="desktop-new-room-action-button"
              type="button"
              :disabled="busy"
              data-testid="sidebar-room-batch-cancel"
              @click="requestClose"
            >
              Cancel
            </button>
            <button
              class="desktop-new-room-action-button primary"
              type="button"
              :disabled="busy"
              data-testid="sidebar-room-batch-confirm"
              @click="$emit('confirm')"
            >
              {{ confirmLabel }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { House, MessageSquare, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { SidebarRoomBatchActionId } from "../../../domain/sidebar-room-selection";
import type { RoomEntry } from "../types";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "../content/modal-focus";

const props = withDefaults(defineProps<{
  open: boolean;
  action: SidebarRoomBatchActionId | null;
  entries: RoomEntry[];
  busy: boolean;
  error?: string | null;
}>(), { error: null });

const emit = defineEmits<{
  close: [];
  confirm: [];
  "after-leave": [];
}>();

const dialogElement = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
const errorElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;

const count = computed(() => props.entries.length);
const visibleEntries = computed(() => props.entries.slice(0, 5));
const hiddenEntryCount = computed(() => Math.max(0, props.entries.length - visibleEntries.value.length));
const roomLabel = computed(() => `${count.value} ${count.value === 1 ? "room" : "rooms"}`);
const title = computed(() => props.action === "conclude"
  ? `Conclude ${roomLabel.value}?`
  : `Hide ${roomLabel.value}?`
);
const description = computed(() => props.action === "conclude"
  ? "This uses Quick close. The rooms move to Closed, their history stays available, and linked tasks are not changed."
  : "These rooms leave your default sidebar. Their history is preserved."
);
const confirmLabel = computed(() => {
  if (props.busy) return props.action === "conclude" ? "Concluding..." : "Hiding...";
  return props.action === "conclude" ? `Conclude ${count.value}` : `Hide ${count.value}`;
});

watch(() => props.open, async (open) => {
  if (!open) return;
  previousFocusElement = currentFocusableElement();
  await nextTick();
  cancelButton.value?.focus({ preventScroll: true });
});

watch(() => props.error, async (error) => {
  if (!error) return;
  await nextTick();
  errorElement.value?.focus({ preventScroll: true });
});

onBeforeUnmount(() => restoreDialogFocus());

function requestClose(): void {
  if (!props.busy) emit("close");
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}

function restoreDialogFocus(): void {
  if (previousFocusElement?.isConnected) {
    restoreFocus(previousFocusElement);
    previousFocusElement = null;
    return;
  }
  previousFocusElement = null;
  document.querySelector<HTMLElement>("[data-testid='sidebar-select-rooms-button'], [data-testid='desktop-sidebar']")
    ?.focus({ preventScroll: true });
}

function handleAfterLeave(): void {
  restoreDialogFocus();
  emit("after-leave");
}
</script>

<style scoped>
.sidebar-batch-dialog-surface {
  width: min(480px, 100%);
  gap: 20px;
  padding: 26px;
}

.sidebar-batch-dialog-room-list {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.025);
}

.sidebar-batch-dialog-room-list > div {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 8px;
  border-radius: 8px;
}

.sidebar-batch-dialog-room-list > div + div {
  border-top: 1px solid rgba(255, 255, 255, 0.045);
}

.sidebar-batch-dialog-room-list span {
  display: inline-grid;
  place-items: center;
  color: var(--text-tertiary);
}

.sidebar-batch-dialog-room-list svg {
  width: 15px;
  height: 15px;
}

.sidebar-batch-dialog-room-list strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 0.82rem;
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-batch-dialog-room-list p {
  margin: 0;
  padding: 6px 8px 2px 34px;
  color: var(--text-tertiary);
  font-size: 0.72rem;
}

.sidebar-batch-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.sidebar-batch-dialog-enter-active,
.sidebar-batch-dialog-leave-active {
  transition: opacity 160ms var(--ease-out);
}

.sidebar-batch-dialog-enter-active .sidebar-batch-dialog-surface,
.sidebar-batch-dialog-leave-active .sidebar-batch-dialog-surface {
  transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out);
}

.sidebar-batch-dialog-enter-from,
.sidebar-batch-dialog-leave-to,
.sidebar-batch-dialog-enter-from .sidebar-batch-dialog-surface,
.sidebar-batch-dialog-leave-to .sidebar-batch-dialog-surface {
  opacity: 0;
}

.sidebar-batch-dialog-enter-from .sidebar-batch-dialog-surface,
.sidebar-batch-dialog-leave-to .sidebar-batch-dialog-surface {
  transform: scale(0.985);
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-batch-dialog-enter-active,
  .sidebar-batch-dialog-leave-active,
  .sidebar-batch-dialog-enter-active .sidebar-batch-dialog-surface,
  .sidebar-batch-dialog-leave-active .sidebar-batch-dialog-surface {
    transition: none;
  }
}
</style>
