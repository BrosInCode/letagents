<template>
  <Teleport to="body">
    <Transition name="room-panel">
      <div
        v-if="open && session"
        class="desktop-rules-backdrop"
        data-testid="rent-session-detail-modal"
        @click.self="$emit('close')"
      >
        <section
          ref="dialogElement"
          class="desktop-rules-dialog rent-detail-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rent-detail-title"
          tabindex="-1"
          @keydown.esc.prevent="$emit('close')"
          @keydown.tab="handleDialogTab"
        >
          <header class="desktop-rules-header">
            <div>
              <p>Rental session</p>
              <h2 id="rent-detail-title">{{ session.taskTitle }}</h2>
            </div>
            <button type="button" aria-label="Close" @click="$emit('close')">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
          </header>

          <RentSessionSummary :session="session" :usage="usage" />

          <button
            v-if="pendingContextRequestCount > 0 && activeTab !== 'access'"
            type="button"
            class="rent-detail-pending-banner"
            data-testid="rent-detail-pending-access-banner"
            @click="activeTab = 'access'"
          >
            {{ pendingContextRequestCount }} pending access
            {{ pendingContextRequestCount === 1 ? "request" : "requests" }} — review now
          </button>

          <RentSessionTabs v-model="activeTab" />

          <div class="rent-detail-body">
            <p v-if="errorMessage" class="rent-detail-error" role="alert" data-testid="rent-detail-error">
              {{ errorMessage }}
            </p>

            <RentUsagePanel
              v-if="activeTab === 'usage'"
              :usage="usage"
              data-testid="rent-detail-usage"
            />
            <RentActivityPanel
              v-if="activeTab === 'activity'"
              :activity="activity"
              :loading="loadingActivity"
              data-testid="rent-detail-activity"
            />
            <RentPatchesPanel
              v-if="activeTab === 'patches'"
              :patches="patches"
              :loading="loadingPatches"
              :patch-action-busy-for="patchActionBusyFor"
              :patch-action-kind="patchActionKind"
              data-testid="rent-detail-patches"
              @approve="approvePatch"
              @request-changes="requestPatchChanges"
            />
            <p
              v-if="contextNotice && activeTab === 'access'"
              class="rent-detail-notice"
              role="status"
              data-testid="rent-detail-context-notice"
            >
              {{ contextNotice }}
            </p>
            <RentContextRequestsPanel
              v-if="activeTab === 'access'"
              :requests="contextRequests"
              :loading="loadingContextRequests"
              :busy-for="contextActionBusyFor"
              data-testid="rent-detail-access"
              @approve="approveContextRequest"
              @deny="denyContextRequest"
            />
            <RentExposuresPanel
              v-if="activeTab === 'exposures'"
              :exposures="exposures"
              :loading="loadingExposures"
              data-testid="rent-detail-exposures"
            />
          </div>

          <footer class="rent-detail-footer">
            <button
              v-if="canCancel"
              type="button"
              class="rent-create-secondary rent-detail-cancel"
              data-testid="rent-detail-cancel-session"
              :disabled="cancelBusy"
              @click="cancelSession"
            >
              {{ cancelBusy ? "Cancelling..." : "Cancel session" }}
            </button>
            <button type="button" class="rent-create-secondary" @click="refresh" :disabled="anyLoading">
              {{ anyLoading ? "Refreshing..." : "Refresh" }}
            </button>
            <button type="button" class="rent-create-secondary" @click="$emit('close')">Close</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref, toRef, watch } from "vue";
import type { DesktopRentalSession } from "../../../../../electron/ipc-types";
import RentActivityPanel from "./rent-session-detail/RentActivityPanel.vue";
import RentContextRequestsPanel from "./rent-session-detail/RentContextRequestsPanel.vue";
import RentExposuresPanel from "./rent-session-detail/RentExposuresPanel.vue";
import RentPatchesPanel from "./rent-session-detail/RentPatchesPanel.vue";
import RentSessionSummary from "./rent-session-detail/RentSessionSummary.vue";
import RentSessionTabs from "./rent-session-detail/RentSessionTabs.vue";
import RentUsagePanel from "./rent-session-detail/RentUsagePanel.vue";
import { useRentSessionDetail } from "./rent-session-detail/useRentSessionDetail";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";

const props = defineProps<{
  open: boolean;
  session: DesktopRentalSession | null;
}>();

const emit = defineEmits<{
  close: [];
  "session-updated": [session: DesktopRentalSession];
}>();

const dialogElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;

const {
  activeTab,
  activity,
  anyLoading,
  approveContextRequest,
  approvePatch,
  canCancel,
  cancelBusy,
  cancelSession,
  contextActionBusyFor,
  contextNotice,
  contextRequests,
  denyContextRequest,
  errorMessage,
  exposures,
  loadingActivity,
  loadingContextRequests,
  loadingExposures,
  loadingPatches,
  patchActionBusyFor,
  patchActionKind,
  patches,
  pendingContextRequestCount,
  refresh,
  requestPatchChanges,
  usage,
} = useRentSessionDetail({
  open: toRef(props, "open"),
  session: toRef(props, "session"),
  onClose: () => emit("close"),
  onSessionUpdated: (session) => emit("session-updated", session),
});

watch(
  () => props.open && Boolean(props.session),
  (open) => {
    if (open) {
      previousFocusElement = currentFocusableElement();
      void nextTick(() => dialogElement.value?.focus({ preventScroll: true }));
    } else {
      restoreFocus(previousFocusElement);
      previousFocusElement = null;
    }
  },
  { immediate: true },
);

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}
</script>

<style scoped>
.rent-detail-dialog {
  max-width: 40rem;
}
.rent-detail-body {
  padding: 0 1.25rem 1rem;
  max-height: 60vh;
  overflow-y: auto;
}
.rent-detail-error {
  color: var(--color-danger, #ff8a80);
  font-size: 0.85rem;
}
.rent-detail-notice {
  font-size: 0.85rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  border: 1px solid color-mix(in srgb, var(--color-warning, #ffd54f) 45%, transparent);
  background: color-mix(in srgb, var(--color-warning, #ffd54f) 10%, transparent);
}
.rent-detail-pending-banner {
  appearance: none;
  margin: 0 1.25rem 0.5rem;
  padding: 0.5rem 0.85rem;
  border-radius: 0.5rem;
  font: inherit;
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--color-warning, #ffd54f) 55%, transparent);
  background: color-mix(in srgb, var(--color-warning, #ffd54f) 12%, transparent);
  color: inherit;
}
.rent-detail-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  padding: 0 1.25rem 1.25rem;
}
.rent-create-secondary {
  appearance: none;
  padding: 0.5rem 1rem;
  border-radius: 999px;
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  background: transparent;
  color: inherit;
}
.rent-create-secondary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.rent-detail-cancel {
  margin-right: auto;
  border-color: color-mix(in srgb, var(--color-danger, #ff8a80) 50%, transparent);
  color: var(--color-danger, #ff8a80);
}
</style>
