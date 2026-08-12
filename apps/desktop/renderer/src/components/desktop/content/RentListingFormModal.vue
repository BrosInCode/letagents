<template>
  <Teleport to="body">
    <Transition name="room-panel">
      <div
        v-if="open"
        class="desktop-rules-backdrop"
        data-testid="rent-listing-form-modal"
        @click.self="cancel"
      >
        <section
          ref="dialogElement"
          class="desktop-rules-dialog rent-listing-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rent-listing-form-title"
          tabindex="-1"
          @keydown.esc.prevent="cancel"
          @keydown.tab="handleDialogTab"
        >
          <header class="desktop-rules-header">
            <div>
              <p>Rent an Agent</p>
              <h2 id="rent-listing-form-title">
                {{ listing ? `Edit ${listing.displayName}` : "New listing" }}
              </h2>
            </div>
            <button type="button" aria-label="Close" @click="cancel">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
          </header>

          <form class="rent-listing-body" @submit.prevent="submit">
            <label class="rent-listing-field">
              <span>Display name</span>
              <input
                v-model="displayName"
                type="text"
                required
                maxlength="120"
                placeholder="Claude Code — evenings and weekends"
                data-testid="rent-listing-display-name"
                :disabled="submitting"
              />
            </label>

            <div class="rent-listing-row">
              <label class="rent-listing-field">
                <span>Agent IDE</span>
                <select
                  v-model="ideKind"
                  data-testid="rent-listing-ide-kind"
                  :disabled="submitting || listing !== null"
                >
                  <option v-for="kind in IDE_KINDS" :key="kind" :value="kind">
                    {{ ideKindLabel(kind) }}
                  </option>
                </select>
                <small v-if="listing" class="rent-listing-helper">IDE cannot change after creation.</small>
              </label>

              <label class="rent-listing-field">
                <span>Model label <em>(optional)</em></span>
                <input
                  v-model="modelLabel"
                  type="text"
                  maxlength="80"
                  placeholder="sonnet-5"
                  data-testid="rent-listing-model-label"
                  :disabled="submitting"
                />
              </label>
            </div>

            <fieldset class="rent-listing-field rent-listing-modes" :disabled="submitting">
              <legend>Access levels renters can request</legend>
              <label>
                <input
                  v-model="supportsScoped"
                  type="checkbox"
                  data-testid="rent-listing-mode-scoped"
                />
                Limited access (scoped files only)
              </label>
              <label>
                <input
                  v-model="supportsTrustedOpen"
                  type="checkbox"
                  data-testid="rent-listing-mode-trusted"
                />
                Full workspace access
              </label>
              <small v-if="!supportsScoped && !supportsTrustedOpen" class="rent-listing-helper rent-listing-warning">
                Pick at least one access level.
              </small>
            </fieldset>

            <div class="rent-listing-row">
              <label class="rent-listing-field">
                <span>Default budget (rental credits)</span>
                <input
                  v-model.number="defaultLrtLimit"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="50000"
                  data-testid="rent-listing-lrt-limit"
                  :disabled="submitting"
                />
              </label>

              <label class="rent-listing-field">
                <span>Default time limit (minutes)</span>
                <input
                  v-model.number="defaultTimeLimitMinutes"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="60"
                  data-testid="rent-listing-time-limit"
                  :disabled="submitting"
                />
              </label>

              <label class="rent-listing-field">
                <span>Max concurrent rentals</span>
                <input
                  v-model.number="maxConcurrentSessions"
                  type="number"
                  min="1"
                  :max="MAX_CONCURRENT_SESSIONS_CAP"
                  step="1"
                  data-testid="rent-listing-max-concurrent"
                  :disabled="submitting"
                />
                <small class="rent-listing-helper">
                  Above 1 applies only when the agent reports exact token usage;
                  estimated meters run one rental at a time.
                </small>
              </label>
            </div>

            <label class="rent-listing-check">
              <input
                v-model="manualAcceptRequired"
                type="checkbox"
                data-testid="rent-listing-manual-accept"
                :disabled="submitting"
              />
              <span>
                Review each rental request before it starts
                <small class="rent-listing-helper">Recommended. Unchecked means requests are accepted automatically.</small>
              </span>
            </label>

            <p v-if="errorMessage" class="rent-listing-error" role="alert" data-testid="rent-listing-form-error">
              {{ errorMessage }}
            </p>

            <footer class="rent-listing-footer">
              <button
                type="button"
                class="rent-listing-secondary"
                data-testid="rent-listing-form-cancel"
                :disabled="submitting"
                @click="cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="rent-listing-primary"
                data-testid="rent-listing-form-submit"
                :disabled="submitting || !canSubmit"
              >
                {{ submitting ? "Saving..." : listing ? "Save changes" : "Create listing" }}
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
import { desktopIpc } from "../../../ipc/index.js";
import type {
  DesktopRentalIdeKind,
  DesktopRentalListing,
  DesktopRentalListingInput,
  DesktopRentalListingPatch,
  DesktopRentalMode,
} from "../../../../../electron/ipc-types";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";
import {
  buildListingFormInput,
  ideKindLabel,
  LISTING_IDE_KINDS as IDE_KINDS,
  MAX_CONCURRENT_SESSIONS_CAP,
} from "./rent-listing-form";

const props = defineProps<{
  open: boolean;
  /** Null = create mode; a listing = edit mode. */
  listing: DesktopRentalListing | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [listing: DesktopRentalListing];
}>();

const displayName = ref("");
const ideKind = ref<DesktopRentalIdeKind>("claude_code");
const modelLabel = ref("");
const supportsScoped = ref(true);
const supportsTrustedOpen = ref(false);
const defaultLrtLimit = ref<number | "">("");
const defaultTimeLimitMinutes = ref<number | "">("");
const maxConcurrentSessions = ref<number | "">(1);
const manualAcceptRequired = ref(true);
const submitting = ref(false);
const errorMessage = ref<string | null>(null);
const dialogElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;

const canSubmit = computed(
  () =>
    displayName.value.trim().length > 0
    && (supportsScoped.value || supportsTrustedOpen.value),
);

watch(
  () => [props.open, props.listing?.id] as const,
  ([nowOpen]) => {
    if (nowOpen) {
      previousFocusElement = currentFocusableElement();
      resetForm(props.listing);
      void nextTick(() => dialogElement.value?.focus({ preventScroll: true }));
    } else {
      restoreFocus(previousFocusElement);
      previousFocusElement = null;
    }
  },
);

function resetForm(listing: DesktopRentalListing | null): void {
  displayName.value = listing?.displayName ?? "";
  ideKind.value = listing?.ideKind ?? "claude_code";
  modelLabel.value = listing?.modelLabel ?? "";
  const modes: DesktopRentalMode[] = listing?.supportedModes ?? ["scoped"];
  supportsScoped.value = modes.includes("scoped");
  supportsTrustedOpen.value = modes.includes("trusted_open");
  defaultLrtLimit.value = listing?.defaultLrtLimit ?? "";
  defaultTimeLimitMinutes.value = listing?.defaultTimeLimitMinutes ?? "";
  maxConcurrentSessions.value = listing?.maxConcurrentSessions ?? 1;
  manualAcceptRequired.value = listing?.manualAcceptRequired ?? true;
  errorMessage.value = null;
  submitting.value = false;
}

function cancel(): void {
  if (submitting.value) return;
  emit("close");
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;

  const bridge = desktopIpc.rental;
  if (!bridge?.createListing || !bridge.updateListing) {
    errorMessage.value = "Rent an Agent is turned off in this desktop app.";
    return;
  }

  const built = buildListingFormInput({
    displayName: displayName.value,
    ideKind: ideKind.value,
    modelLabel: modelLabel.value,
    supportsScoped: supportsScoped.value,
    supportsTrustedOpen: supportsTrustedOpen.value,
    defaultLrtLimit: defaultLrtLimit.value,
    defaultTimeLimitMinutes: defaultTimeLimitMinutes.value,
    maxConcurrentSessions: maxConcurrentSessions.value,
    manualAcceptRequired: manualAcceptRequired.value,
  });
  if ("error" in built) {
    errorMessage.value = built.error;
    return;
  }

  submitting.value = true;
  errorMessage.value = null;
  try {
    const result = props.listing
      ? await bridge.updateListing(props.listing.id, built.input as DesktopRentalListingPatch)
      : await bridge.createListing(built.input as DesktopRentalListingInput);
    if (isDisabledResult(result)) {
      errorMessage.value = "Rent an Agent is turned off in this desktop app.";
      return;
    }
    emit("saved", result);
    emit("close");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "Could not save the listing.";
  } finally {
    submitting.value = false;
  }
}

function isDisabledResult(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { enabled?: unknown }).enabled === false
  );
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}
</script>

<style scoped>
.rent-listing-dialog {
  max-width: 34rem;
}
.rent-listing-body {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 0 1.25rem 1.25rem;
}
.rent-listing-row {
  display: flex;
  gap: 0.75rem;
}
.rent-listing-row .rent-listing-field {
  flex: 1;
}
.rent-listing-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.9rem;
}
.rent-listing-field input,
.rent-listing-field select {
  font: inherit;
  padding: 0.45rem 0.6rem;
  border-radius: 0.4rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: var(--color-surface-2, rgba(255, 255, 255, 0.04));
  color: inherit;
}
.rent-listing-modes {
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  border-radius: 0.5rem;
  padding: 0.6rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.rent-listing-modes legend {
  font-size: 0.85rem;
  padding: 0 0.25rem;
}
.rent-listing-modes label,
.rent-listing-check {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  font-size: 0.9rem;
}
.rent-listing-helper {
  display: block;
  font-size: 0.75rem;
  opacity: 0.65;
}
.rent-listing-warning {
  color: var(--color-warning, #ffd54f);
  opacity: 1;
}
.rent-listing-error {
  color: var(--color-danger, #ff8a80);
  font-size: 0.85rem;
  margin: 0;
}
.rent-listing-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
}
.rent-listing-secondary,
.rent-listing-primary {
  appearance: none;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: inherit;
}
.rent-listing-primary {
  background: var(--color-accent, #4f7cff);
  border-color: transparent;
  color: white;
}
.rent-listing-secondary:disabled,
.rent-listing-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
