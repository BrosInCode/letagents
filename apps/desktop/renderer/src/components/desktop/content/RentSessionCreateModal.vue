<template>
  <Teleport to="body">
    <Transition name="room-panel">
      <div
        v-if="open && listing"
        class="desktop-rules-backdrop"
        data-testid="rent-session-create-modal"
        @click.self="cancel"
      >
        <section
          ref="dialogElement"
          class="desktop-rules-dialog rent-create-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rent-create-title"
          tabindex="-1"
          @keydown.esc.prevent="cancel"
          @keydown.tab="handleDialogTab"
        >
          <header class="desktop-rules-header">
            <div>
              <p>Rent an Agent</p>
              <h2 id="rent-create-title">Start a session with {{ listing.displayName }}</h2>
            </div>
            <button type="button" aria-label="Close" @click="cancel">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
          </header>

          <form class="rent-create-body" @submit.prevent="submit">
            <label class="rent-create-field">
              <span>Task title</span>
              <input
                v-model="taskTitle"
                type="text"
                required
                maxlength="200"
                placeholder="Refactor the auth middleware"
                data-testid="rent-create-task-title"
                :disabled="submitting"
              />
            </label>

            <label class="rent-create-field">
              <span>Task prompt</span>
              <textarea
                v-model="taskPrompt"
                required
                rows="6"
                maxlength="8000"
                placeholder="Describe what you want the agent to do. Be specific about acceptance criteria."
                data-testid="rent-create-task-prompt"
                :disabled="submitting"
              />
            </label>

            <div class="rent-create-row">
              <label class="rent-create-field">
                <span>Access level</span>
                <select
                  v-model="mode"
                  data-testid="rent-create-mode"
                  :disabled="submitting || availableModes.length <= 1"
                >
                  <option v-for="opt in availableModes" :key="opt" :value="opt">{{ modeLabel(opt) }}</option>
                </select>
              </label>

              <label class="rent-create-field">
                <span>Context to send</span>
                <select
                  v-model="continuityMode"
                  data-testid="rent-create-continuity"
                  :disabled="submitting"
                >
                  <option value="smart_handoff">Summary only</option>
                  <option value="full_transcript">Full room transcript</option>
                </select>
                <small class="rent-create-helper">Full room transcript may include sensitive room history.</small>
              </label>
            </div>

            <p v-if="errorMessage" class="rent-create-error" role="alert" data-testid="rent-create-error">
              {{ errorMessage }}
            </p>

            <footer class="rent-create-footer">
              <button
                type="button"
                class="rent-create-secondary"
                data-testid="rent-create-cancel"
                :disabled="submitting"
                @click="cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="rent-create-primary"
                data-testid="rent-create-submit"
                :disabled="submitting || !canSubmit"
              >
                {{ submitting ? "Starting..." : "Start session" }}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type {
  DesktopRentalContinuityMode,
  DesktopRentalListing,
  DesktopRentalMode,
  DesktopRentalSession,
  DesktopRentalStartInput,
} from "../../../../../electron/ipc-types";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";

const props = defineProps<{
  open: boolean;
  listing: DesktopRentalListing | null;
  roomIdentifier: string;
}>();

const emit = defineEmits<{
  close: [];
  created: [session: DesktopRentalSession];
}>();

const taskTitle = ref("");
const taskPrompt = ref("");
const mode = ref<DesktopRentalMode>("scoped");
const continuityMode = ref<DesktopRentalContinuityMode>("smart_handoff");
const submitting = ref(false);
const errorMessage = ref<string | null>(null);
const dialogElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;

const availableModes = computed<DesktopRentalMode[]>(() => {
  const supported = props.listing?.supportedModes ?? [];
  return supported.length ? supported : ["scoped"];
});

const canSubmit = computed(
  () => taskTitle.value.trim().length > 0 && taskPrompt.value.trim().length > 0,
);

watch(
  () => [props.open, props.listing?.id] as const,
  ([nowOpen]) => {
    if (nowOpen) {
      previousFocusElement = currentFocusableElement();
      taskTitle.value = "";
      taskPrompt.value = "";
      mode.value = availableModes.value[0] ?? "scoped";
      continuityMode.value = "smart_handoff";
      errorMessage.value = null;
      submitting.value = false;
      void nextTick(() => dialogElement.value?.focus({ preventScroll: true }));
    } else {
      restoreFocus(previousFocusElement);
      previousFocusElement = null;
    }
  },
);

function cancel(): void {
  if (submitting.value) return;
  emit("close");
}

async function submit(): Promise<void> {
  if (!canSubmit.value || !props.listing) return;

  const bridge = window.letagentsDesktop?.rental;
  if (!bridge?.createSession) {
    errorMessage.value = "Rent an Agent is turned off in this desktop app.";
    return;
  }

  submitting.value = true;
  errorMessage.value = null;
  try {
    const input: DesktopRentalStartInput = {
      listingId: props.listing.id,
      roomIdentifier: props.roomIdentifier,
      taskTitle: taskTitle.value.trim(),
      taskPrompt: taskPrompt.value.trim(),
      mode: mode.value,
      continuityMode: continuityMode.value,
      approvedScope: { includePaths: [], excludePaths: [], protectedPaths: [], notes: null },
      policy: {
        maxLrt: props.listing.defaultLrtLimit,
        maxDurationMinutes: props.listing.defaultTimeLimitMinutes,
        maxPatchBytes: null,
        allowCommands: false,
        allowNetwork: false,
        requirePatchGate: true,
      },
      startTrigger: "user_initiated",
      triggerConfidence: "manual",
    };
    const result = await bridge.createSession(input);
    if (isDisabledResult(result)) {
      errorMessage.value = "Rent an Agent is turned off in this desktop app.";
      return;
    }
    emit("created", result);
    emit("close");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Could not start the session.";
  } finally {
    submitting.value = false;
  }
}

function isDisabledResult(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && (value as { enabled?: unknown }).enabled === false
  );
}

function modeLabel(value: DesktopRentalMode): string {
  return value === "trusted_open" ? "Full workspace access (trusted)" : "Limited access";
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}
</script>

<style scoped>
.rent-create-dialog {
  max-width: 36rem;
}
.rent-create-body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 0 1.25rem 1.25rem;
}
.rent-create-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.9rem;
}
.rent-create-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.85rem;
}
.rent-create-field > span {
  font-weight: 600;
  opacity: 0.8;
}
.rent-create-helper {
  color: var(--color-text-muted, rgba(255, 255, 255, 0.58));
  font-size: 0.76rem;
  line-height: 1.35;
}
.rent-create-field input,
.rent-create-field textarea,
.rent-create-field select {
  appearance: none;
  background: var(--color-surface-2, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  border-radius: 0.5rem;
  color: inherit;
  padding: 0.55rem 0.7rem;
  font: inherit;
}
.rent-create-field textarea {
  resize: vertical;
  min-height: 6rem;
}
.rent-create-error {
  color: var(--color-danger, #ff8a80);
  font-size: 0.85rem;
  margin: 0;
}
.rent-create-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 0.5rem;
}
.rent-create-secondary,
.rent-create-primary {
  appearance: none;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
}
.rent-create-secondary {
  background: transparent;
  color: inherit;
}
.rent-create-primary {
  background: var(--color-accent, #4f7cff);
  color: white;
  border-color: transparent;
}
.rent-create-primary:disabled,
.rent-create-secondary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
