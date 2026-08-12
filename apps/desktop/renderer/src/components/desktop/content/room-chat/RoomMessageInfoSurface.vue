<template>
  <Teleport to="body">
    <Transition name="room-message-info" appear>
      <section
        v-if="open"
        ref="surfaceElement"
        class="room-message-info-surface"
        role="dialog"
        aria-label="Message info"
        data-testid="room-message-info-surface"
      >
        <header class="room-message-info-header">
          <div>
            <h3>Message info</h3>
            <span v-if="info?.message" class="room-message-info-sent">Sent {{ formatTime(info.message.timestamp) }}</span>
          </div>
          <button ref="closeButton" type="button" class="room-message-info-close" aria-label="Close message info" @click="close(true)">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div v-if="info?.message" class="room-message-info-preview">
          <strong>{{ info.message.sender }}</strong>
          <p>{{ info.message.textPreview }}</p>
        </div>

        <div v-if="loading" class="room-message-info-state" aria-busy="true">
          <div class="room-message-info-skeleton" />
          <div class="room-message-info-skeleton" />
          <div class="room-message-info-skeleton" />
        </div>

        <div v-else-if="error" class="room-message-info-state" role="alert">
          <p>{{ error }}</p>
          <button type="button" @click="refresh">Retry</button>
        </div>

        <p v-else-if="localOnly" class="room-message-info-state">
          Message info is available in shared rooms. Local-only rooms keep no
          read or receipt evidence.
        </p>

        <div v-else-if="info" class="room-message-info-body">
          <div v-if="info.agentsAsked.length === 0 && info.seenByPeople.length === 0 && info.alsoObserved.length === 0" class="room-message-info-quiet">
            <span class="room-message-info-quiet-mark" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none"><path d="M8 5v3.5l2.2 1.3M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <div>
              <strong>No activity yet</strong>
              <p>Nobody else has read this, and no agent was asked to respond. Evidence appears here as it happens.</p>
            </div>
          </div>

          <section v-if="info.agentsAsked.length > 0" class="room-message-info-section">
            <h4>Agents asked · {{ info.agentsAsked.length }}</h4>
            <ul>
              <li v-for="agent in info.agentsAsked" :key="agent.receiptId">
                <span class="room-message-info-avatar" data-kind="agent" aria-hidden="true">{{ initial(agent.actorLabel) }}</span>
                <div class="room-message-info-identity">
                  <span class="room-message-info-name">{{ agent.actorLabel }}</span>
                  <span class="room-message-info-detail">
                    <span class="room-message-info-dot" :data-tone="receiptTone(agent.receiptState, agent.observed)" aria-hidden="true" />
                    {{ receiptStatusLabel(agent.receiptState, agent.observed) }}
                    <template v-if="agent.activationReasonLabel"> · {{ agent.activationReasonLabel }}</template>
                  </span>
                </div>
                <button
                  v-if="agent.replyMessageId"
                  type="button"
                  class="room-message-info-view-reply"
                  @click="emit('scroll-to-message', agent.replyMessageId)"
                >
                  View reply
                </button>
              </li>
            </ul>
          </section>

          <section v-if="info.seenByPeople.length > 0" class="room-message-info-section">
            <h4>Read by people · {{ info.seenByPeople.length }}</h4>
            <ul>
              <li v-for="person in info.seenByPeople" :key="`${person.name}:${person.seenAt}`">
                <span class="room-message-info-avatar" data-kind="person" aria-hidden="true">{{ initial(person.name) }}</span>
                <div class="room-message-info-identity">
                  <span class="room-message-info-name">{{ person.name }}</span>
                </div>
                <span class="room-message-info-time">{{ formatTime(person.seenAt) }}</span>
              </li>
            </ul>
          </section>

          <details v-if="info.alsoObserved.length > 0" class="room-message-info-disclosure">
            <summary>Observed by {{ info.alsoObserved.length }} {{ info.alsoObserved.length === 1 ? 'agent' : 'agents' }} · no response requested</summary>
            <ul>
              <li v-for="agent in info.alsoObserved" :key="agent.agentKey">
                <span class="room-message-info-name">{{ agent.displayName }}</span>
                <span class="room-message-info-detail">Observed</span>
              </li>
            </ul>
          </details>

          <details class="room-message-info-disclosure">
            <summary>Details</summary>
            <ul>
              <li>
                <span class="room-message-info-detail">Message ID</span>
                <button type="button" class="room-message-info-copy" @click="copyMessageId">
                  {{ info.message.id }}{{ copiedId ? ' · Copied' : '' }}
                </button>
              </li>
              <li v-if="info.message.threadRootId !== info.message.id">
                <span class="room-message-info-detail">Thread</span>
                <span>Reply in {{ info.message.threadRootId }}</span>
              </li>
              <li v-else-if="info.message.replyToId">
                <span class="room-message-info-detail">Replies to</span>
                <span>{{ info.message.replyToId }}</span>
              </li>
            </ul>
          </details>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { DesktopMessageInfo } from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";

const props = defineProps<{
  open: boolean;
  roomIdentifier: string;
  messageId: string;
  /** Which rendering of the message invoked the surface: a thread root also
   * renders in the timeline, so the same data-message-id appears twice. */
  invokerContext?: "timeline" | "thread-root" | "thread-reply" | null;
}>();

const emit = defineEmits<{
  close: [];
  "scroll-to-message": [messageId: string];
}>();

const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLElement | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const localOnly = ref(false);
const info = ref<DesktopMessageInfo | null>(null);
const copiedId = ref(false);
let requestToken = 0;
let restoreFocusElement: HTMLElement | null = null;

/** Agents observe, humans read; a queued receipt only proves routing. */
function receiptStatusLabel(state: string, observed: boolean): string {
  switch (state) {
    case "queued": return observed ? "Observed · awaiting reply" : "Asked to respond · Not yet observed";
    case "responding": return "Responding";
    case "replied": return "Replied";
    case "no_reply": return "Chose not to reply";
    case "retrying": return "Retrying delivery";
    case "blocked": return "Needs attention";
    case "cancelled": return "Cancelled";
    case "unavailable": return "Unavailable";
    default: return state;
  }
}

function initial(label: string): string {
  return (label.trim()[0] ?? "?").toUpperCase();
}

/** Semantic tone for the status dot; text carries the exact state. */
function receiptTone(state: string, observed: boolean): string {
  switch (state) {
    case "replied": return "positive";
    case "responding": return "active";
    case "queued": return observed ? "active" : "waiting";
    case "retrying": return "waiting";
    case "blocked": return "attention";
    case "unavailable": return "attention";
    default: return "neutral";
  }
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function refresh(): Promise<void> {
  if (!props.open || !props.roomIdentifier || !props.messageId) return;
  const token = ++requestToken;
  loading.value = true;
  error.value = null;
  localOnly.value = false;
  try {
    const next = await desktopIpc.room.getMessageInfo(props.roomIdentifier, props.messageId);
    if (token !== requestToken) return;
    if (next) {
      info.value = next;
    } else {
      info.value = null;
      localOnly.value = true;
    }
  } catch {
    if (token !== requestToken) return;
    error.value = "Message info could not be loaded.";
  } finally {
    if (token === requestToken) loading.value = false;
  }
}

async function copyMessageId(): Promise<void> {
  const id = info.value?.message.id;
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    copiedId.value = true;
    window.setTimeout(() => { copiedId.value = false; }, 1500);
  } catch {
    // Clipboard may be unavailable; the ID remains selectable.
  }
}

/**
 * The invoking element is usually a context-menu item that unmounted the
 * moment the menu closed. Restoring focus to a disconnected node silently
 * drops focus to <body>, so fall back to the message row itself.
 */
function resolveRestoreFocusTarget(): HTMLElement | null {
  if (restoreFocusElement?.isConnected) return restoreFocusElement;
  // A thread root renders twice (timeline + thread panel) with the same
  // data-message-id; prefer the duplicate matching the invoking context so
  // focus returns to the row the user actually opened the surface from.
  const rows = [...document.querySelectorAll(`[data-message-id="${CSS.escape(props.messageId)}"]`)]
    .filter((element): element is HTMLElement => element instanceof HTMLElement);
  const preferThreadRow = props.invokerContext === "thread-root" || props.invokerContext === "thread-reply";
  return rows.find((row) => row.classList.contains("is-thread-context") === preferThreadRow) ?? rows[0] ?? null;
}

function close(restoreFocus: boolean): void {
  // An outside click's target is the user's new focus destination; only
  // Escape and the explicit close button restore invocation focus.
  if (restoreFocus) {
    const target = resolveRestoreFocusTarget();
    if (target) {
      if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
      }
      window.setTimeout(() => target.focus({ preventScroll: true }), 0);
    }
  }
  emit("close");
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.open) {
    event.stopPropagation();
    close(true);
  }
}

function handlePointerDown(event: PointerEvent): void {
  if (!props.open || event.button !== 0) return;
  const surface = surfaceElement.value;
  if (!surface || (event.target && surface.contains(event.target as Node))) return;
  close(false);
}

watch(() => [props.open, props.messageId] as const, ([open]) => {
  if (open) {
    restoreFocusElement = document.activeElement as HTMLElement | null;
    info.value = null;
    void refresh();
    // A dialog owns focus while open: move it to the close control so
    // Escape/keyboard users land inside the surface, not on the unmounting
    // context-menu item behind it.
    void nextTick(() => closeButton.value?.focus({ preventScroll: true }));
  } else {
    requestToken += 1;
    info.value = null;
    error.value = null;
    localOnly.value = false;
  }
}, { immediate: true });

onMounted(() => {
  document.addEventListener("keydown", handleKeydown, true);
  document.addEventListener("pointerdown", handlePointerDown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleKeydown, true);
  document.removeEventListener("pointerdown", handlePointerDown, true);
});
</script>
