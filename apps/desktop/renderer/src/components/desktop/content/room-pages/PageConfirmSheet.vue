<template>
  <DesktopDialogShell
    :open="Boolean(request)"
    aria-labelledby="room-page-confirm-title"
    backdrop-class="desktop-task-modal-backdrop"
    panel-class="desktop-task-modal room-page-confirm"
    :show-close="false"
    initial-focus="[data-page-confirm-cancel]"
    :focus-key="request?.id ?? null"
    test-id="room-page-confirm"
    @close="answer('declined')"
  >
    <template v-if="request">
      <p class="room-page-confirm-source"><bdi>{{ shown(request.pageTitle) }}</bdi> · version {{ request.pageVersion }}</p>
      <h3 id="room-page-confirm-title">{{ copy.title }}</h3>
      <!-- The page's own words, all of them, with hidden or reordering characters shown as tags; the app draws everything around them. -->
      <pre class="room-page-confirm-text" data-testid="room-page-confirm-text">{{ shown(request.text) }}</pre>
      <template v-if="request.details">
        <p class="room-page-confirm-label">Sent with it</p>
        <pre class="room-page-confirm-text room-page-confirm-details" data-testid="room-page-confirm-details">{{ shown(request.details) }}</pre>
      </template>
      <p class="room-page-confirm-target"><span>{{ copy.targetLabel }}</span> <strong data-testid="room-page-confirm-target">{{ shown(request.target) }}</strong></p>
      <label v-if="request.rememberable" class="room-page-confirm-remember">
        <input v-model="remember" type="checkbox" data-testid="room-page-confirm-remember" />
        Don't ask again for this page version
      </label>
      <div class="room-page-confirm-actions">
        <button class="ghost-button" type="button" data-page-confirm-cancel data-testid="room-page-confirm-decline" @click="answer('declined')">Cancel</button>
        <!-- Armed a moment after it shows, so a click aimed at the page cannot land on it. -->
        <button class="primary-button" type="button" :disabled="!armed" data-testid="room-page-confirm-accept" @click="answer('confirmed')">{{ copy.action }}</button>
      </div>
    </template>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopPageConfirmAnswer, DesktopPageConfirmRequest } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import { PAGE_CONFIRM_ARM_MS, pageConfirmCopy, revealHiddenCharacters as shown } from "./room-pages";

/**
 * The confirm sheet main asks for on a page's behalf: opening a link to a new
 * site now, and posts and agent jobs in later steps. One sheet at a time; the
 * rest wait their turn. Closing it any way but the action button is a no.
 */
const queue = ref<DesktopPageConfirmRequest[]>([]);
const remember = ref(false);
const request = computed(() => queue.value[0] ?? null);
const copy = computed(() => pageConfirmCopy(request.value?.kind ?? "open"));
const armed = ref(false);
let armTimer: ReturnType<typeof setTimeout> | undefined;
let stop: (() => void) | null = null;

watch(() => request.value?.id ?? null, (id) => {
  clearTimeout(armTimer);
  armed.value = false;
  if (id !== null) armTimer = setTimeout(() => { armed.value = true; }, PAGE_CONFIRM_ARM_MS);
}, { immediate: true });

function answer(value: DesktopPageConfirmAnswer): void {
  const current = request.value;
  if (!current || (value === "confirmed" && !armed.value)) return;
  const keep = value === "confirmed" && current.rememberable && remember.value;
  queue.value = queue.value.slice(1);
  remember.value = false;
  void desktopIpc.pages?.answerConfirm(current.id, value, keep).catch(() => undefined);
}

onMounted(() => {
  stop = desktopIpc.pages?.onConfirm((message) => {
    if (message.type === "ask") {
      queue.value = [...queue.value, message.request];
      return;
    }
    if (request.value?.id === message.id) remember.value = false;
    queue.value = queue.value.filter((entry) => entry.id !== message.id);
  }) ?? null;
});

onBeforeUnmount(() => {
  clearTimeout(armTimer);
  stop?.();
  stop = null;
  // A sheet nobody can answer any more is a no, so the page is not left waiting.
  for (const entry of queue.value) void desktopIpc.pages?.answerConfirm(entry.id, "declined", false).catch(() => undefined);
  queue.value = [];
});
</script>

<style>
/* The dialog shell draws the panel, so these rules are not scoped to this component; every class is this sheet's own. */
.room-page-confirm {
  display: grid;
  gap: 12px;
  width: min(460px, calc(100vw - 48px));
  padding: 24px;
}

.room-page-confirm h3 {
  margin: 0;
  font-size: 1.05rem;
}

.room-page-confirm-source,
.room-page-confirm-target {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.room-page-confirm-target strong {
  color: var(--text);
  font-weight: 600;
  overflow-wrap: anywhere;
  unicode-bidi: isolate;
}

.room-page-confirm-label {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.room-page-confirm-text {
  max-height: 200px;
  margin: 0;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  font-family: var(--font-mono);
  font-size: 0.8rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: isolate;
}

.room-page-confirm-remember {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.room-page-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.room-page-confirm-actions button {
  min-height: 36px;
}
</style>
