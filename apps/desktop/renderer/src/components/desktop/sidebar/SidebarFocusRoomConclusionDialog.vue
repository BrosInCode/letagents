<template>
  <Teleport to="body">
    <Transition name="focus-room-conclusion-dialog" @after-leave="handleAfterLeave">
      <div
        v-if="open && entry"
        class="desktop-modal-backdrop"
        data-testid="sidebar-focus-room-conclusion-dialog"
        @click.self="requestClose"
      >
        <section
          ref="dialogElement"
          class="desktop-new-room-modal focus-room-conclusion-surface"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sidebar-focus-room-conclusion-title"
          aria-describedby="sidebar-focus-room-conclusion-description"
          :aria-busy="busy ? 'true' : 'false'"
          tabindex="-1"
          @keydown.esc.stop.prevent="requestClose"
          @keydown.tab="handleDialogTab"
        >
          <header class="desktop-new-room-header">
            <div class="desktop-new-room-heading">
              <p class="desktop-new-room-kicker">Conclude focus room</p>
              <h2 id="sidebar-focus-room-conclusion-title">{{ entry.title }}</h2>
              <p id="sidebar-focus-room-conclusion-description">
                Record the outcome, move this room to Closed, and remove it from the default sidebar.
              </p>
            </div>
            <button
              class="desktop-modal-close"
              type="button"
              aria-label="Close conclusion dialog"
              :disabled="busy"
              @click="requestClose"
            >
              <X aria-hidden="true" />
            </button>
          </header>

          <form class="focus-room-conclusion-form" @submit.prevent="submit">
            <FocusRoomQuickCloseOption
              v-model="quickClose"
              :task-linked="taskLinked"
              :disabled="busy"
              test-id="sidebar-focus-room-quick-close"
            />

            <label v-if="!quickClose" class="focus-room-conclusion-field">
              <span>Outcome summary</span>
              <textarea
                ref="summaryElement"
                v-model="summary"
                rows="4"
                placeholder="What was completed or decided?"
                :disabled="busy"
                data-testid="sidebar-focus-room-conclusion-summary"
              ></textarea>
            </label>

            <fieldset v-if="taskLinked && !quickClose" class="focus-room-conclusion-details">
              <legend>Task closeout</legend>
              <p>Task-linked rooms need enough context to update the parent task safely.</p>

              <div class="focus-room-conclusion-grid">
                <label class="focus-room-conclusion-field">
                  <span>Artifact</span>
                  <input
                    v-model="details.artifact"
                    type="text"
                    maxlength="500"
                    placeholder="PR, branch, document, or decision"
                    :disabled="busy"
                    data-testid="sidebar-focus-room-conclusion-artifact"
                  />
                </label>
                <label class="focus-room-conclusion-field">
                  <span>Next owner</span>
                  <input
                    v-model="details.next_owner"
                    type="text"
                    maxlength="500"
                    placeholder="Person or agent responsible"
                    :disabled="busy"
                    data-testid="sidebar-focus-room-conclusion-owner"
                  />
                </label>
                <DesktopSelectField
                  v-model="details.review_state"
                  label="Review"
                  :options="focusRoomReviewStateOptions"
                  :disabled="busy"
                  test-id="sidebar-focus-room-conclusion-review"
                />
                <DesktopSelectField
                  v-model="details.blocker_state"
                  label="Blockers"
                  :options="focusRoomBlockerStateOptions"
                  :disabled="busy"
                  test-id="sidebar-focus-room-conclusion-blockers"
                />
                <DesktopSelectField
                  v-model="details.parent_task_next"
                  label="Parent task"
                  :options="focusRoomParentTaskNextOptions"
                  :disabled="busy"
                  test-id="sidebar-focus-room-conclusion-task-next"
                />
              </div>
            </fieldset>

            <p
              v-if="error"
              ref="errorElement"
              class="desktop-new-room-feedback"
              data-state="error"
              role="alert"
              tabindex="-1"
              data-testid="sidebar-focus-room-conclusion-error"
            >
              {{ error }}
            </p>

            <footer class="focus-room-conclusion-actions">
              <button
                class="desktop-new-room-action-button"
                type="button"
                :disabled="busy"
                data-testid="sidebar-focus-room-conclusion-cancel"
                @click="requestClose"
              >
                Cancel
              </button>
              <button
                class="desktop-new-room-action-button primary"
                type="submit"
                :disabled="busy || !canSubmit"
                data-testid="sidebar-focus-room-conclusion-submit"
              >
                {{ submitLabel }}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import {
  buildFocusRoomConclusionInput,
  canSubmitFocusRoomConclusion,
  createDefaultFocusRoomConclusionDetails,
  focusRoomBlockerStateOptions,
  focusRoomParentTaskNextOptions,
  focusRoomReviewStateOptions,
  type FocusRoomConclusionInput,
} from "../../../domain/focus-room-conclusion";
import FocusRoomQuickCloseOption from "../controls/FocusRoomQuickCloseOption.vue";
import DesktopSelectField from "../controls/DesktopSelectField.vue";
import type { RoomEntry } from "../types";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "../content/modal-focus";

const props = withDefaults(defineProps<{
  open: boolean;
  entry: RoomEntry | null;
  busy: boolean;
  error?: string | null;
  fallbackFocusEntryId?: string | null;
}>(), {
  error: null,
  fallbackFocusEntryId: null,
});

const emit = defineEmits<{
  close: [];
  submit: [input: FocusRoomConclusionInput];
  "after-leave": [];
}>();

const dialogElement = ref<HTMLElement | null>(null);
const summaryElement = ref<HTMLTextAreaElement | null>(null);
const errorElement = ref<HTMLElement | null>(null);
const summary = ref("");
const quickClose = ref(false);
const details = reactive(createDefaultFocusRoomConclusionDetails());
let previousFocusElement: HTMLElement | null = null;

const taskLinked = computed(() => Boolean(props.entry?.sourceTaskId));
const canSubmit = computed(() =>
  canSubmitFocusRoomConclusion(summary.value, props.entry?.sourceTaskId, details, quickClose.value)
);
const submitLabel = computed(() => {
  if (props.busy) return quickClose.value ? "Closing..." : "Concluding...";
  return quickClose.value ? "Close room" : "Conclude room";
});

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    resetForm();
    await nextTick();
    previousFocusElement = currentFocusableElement();
    summaryElement.value?.focus({ preventScroll: true });
  },
);

watch(
  () => props.entry?.id,
  async (entryId, previousEntryId) => {
    if (!props.open || !entryId || entryId === previousEntryId) return;
    resetForm();
    await nextTick();
    summaryElement.value?.focus({ preventScroll: true });
  },
);

watch(
  () => props.error,
  async (error) => {
    if (!error) return;
    await nextTick();
    errorElement.value?.focus({ preventScroll: true });
  },
);

onBeforeUnmount(() => restoreDialogFocus());

function resetForm(): void {
  summary.value = "";
  quickClose.value = false;
  Object.assign(details, createDefaultFocusRoomConclusionDetails());
}

function requestClose(): void {
  if (props.busy) return;
  emit("close");
}

function submit(): void {
  if (!canSubmit.value || !props.entry) return;
  emit(
    "submit",
    buildFocusRoomConclusionInput(
      summary.value,
      props.entry.sourceTaskId,
      details,
      quickClose.value,
    ),
  );
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
  const entryId = props.fallbackFocusEntryId;
  if (!entryId) return;
  const escapedEntryId = globalThis.CSS?.escape ? globalThis.CSS.escape(entryId) : entryId;
  document.querySelector<HTMLElement>(`[data-sidebar-entry-id="${escapedEntryId}"]`)
    ?.focus({ preventScroll: true });
}

function handleAfterLeave(): void {
  restoreDialogFocus();
  emit("after-leave");
}
</script>

<style scoped>
.focus-room-conclusion-surface {
  width: min(620px, 100%);
  max-height: min(820px, calc(100vh - 48px));
  gap: 22px;
  padding: 28px;
}

.focus-room-conclusion-form,
.focus-room-conclusion-details {
  display: grid;
  gap: 16px;
  min-width: 0;
}

.focus-room-conclusion-details {
  margin: 0;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.025);
}

.focus-room-conclusion-details legend,
.focus-room-conclusion-field > span {
  color: var(--text-tertiary);
  font-size: 0.72rem;
  font-weight: 850;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.focus-room-conclusion-details > p {
  margin: -8px 0 0;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.45;
}

.focus-room-conclusion-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.focus-room-conclusion-grid > :last-child {
  grid-column: 1 / -1;
}

.focus-room-conclusion-field {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.focus-room-conclusion-field input,
.focus-room-conclusion-field textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  outline: none;
  background: rgba(0, 0, 0, 0.68);
  color: var(--text);
  font: inherit;
  line-height: 1.45;
  resize: vertical;
  transition:
    border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out);
}

.focus-room-conclusion-field input {
  min-height: 44px;
  resize: none;
}

.focus-room-conclusion-field textarea {
  min-height: 108px;
}

.focus-room-conclusion-field input:focus-visible,
.focus-room-conclusion-field textarea:focus-visible {
  border-color: color-mix(in srgb, var(--text) 34%, var(--border));
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.11);
}

.focus-room-conclusion-field input:disabled,
.focus-room-conclusion-field textarea:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.focus-room-conclusion-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.focus-room-conclusion-dialog-enter-active {
  transition: opacity 180ms var(--ease-out);
}

.focus-room-conclusion-dialog-leave-active {
  transition: opacity 130ms var(--ease-out);
}

.focus-room-conclusion-dialog-enter-active .focus-room-conclusion-surface {
  transition:
    opacity 180ms var(--ease-out),
    transform 180ms var(--ease-out);
}

.focus-room-conclusion-dialog-leave-active .focus-room-conclusion-surface {
  transition:
    opacity 110ms var(--ease-out),
    transform 130ms var(--ease-out);
}

.focus-room-conclusion-dialog-enter-from,
.focus-room-conclusion-dialog-leave-to,
.focus-room-conclusion-dialog-enter-from .focus-room-conclusion-surface,
.focus-room-conclusion-dialog-leave-to .focus-room-conclusion-surface {
  opacity: 0;
}

.focus-room-conclusion-dialog-enter-from .focus-room-conclusion-surface,
.focus-room-conclusion-dialog-leave-to .focus-room-conclusion-surface {
  transform: scale(0.985);
}

@media (prefers-reduced-motion: reduce) {
  .focus-room-conclusion-dialog-enter-active,
  .focus-room-conclusion-dialog-leave-active,
  .focus-room-conclusion-dialog-enter-active .focus-room-conclusion-surface,
  .focus-room-conclusion-dialog-leave-active .focus-room-conclusion-surface {
    transition: opacity 100ms linear;
  }

  .focus-room-conclusion-dialog-enter-from .focus-room-conclusion-surface,
  .focus-room-conclusion-dialog-leave-to .focus-room-conclusion-surface {
    transform: none;
  }
}

@media (max-width: 620px) {
  .focus-room-conclusion-surface {
    padding: 22px;
  }

  .focus-room-conclusion-grid {
    grid-template-columns: 1fr;
  }

  .focus-room-conclusion-grid > :last-child {
    grid-column: auto;
  }
}
</style>
