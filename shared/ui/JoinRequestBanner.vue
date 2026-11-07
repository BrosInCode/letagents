<template>
  <Transition name="join-request-reveal" appear>
    <div v-if="shown" class="join-request-reveal">
      <section
        class="join-request-banner"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="join-request-banner"
        :data-count="requests.length"
        :data-settled="settled?.outcome"
      >
        <span class="join-request-banner-faces" aria-hidden="true">
          <span v-for="request in faces" :key="request.id" class="join-request-banner-face">
            <ChatAvatar :name="label(request)" :avatar-url="request.avatar_url" />
          </span>
        </span>
        <p class="join-request-banner-copy">
          <span data-testid="join-request-banner-text">
            <template v-if="settled"><b>{{ label(settled.request) }}</b> {{ settled.outcome === "approve" ? "is in" : "was declined" }}</template>
            <template v-else-if="single"><b>{{ label(single) }}</b> wants to join</template>
            <template v-else-if="requests.length === 2"><b>{{ label(requests[0]) }}</b> and <b>{{ label(requests[1]) }}</b> want to join</template>
            <template v-else><b>{{ requests.length }} people</b> want to join</template>
          </span>
          <span v-if="single && !settled" class="join-request-banner-meta">@{{ single.login }} · {{ askedLabel(single) }}</span>
          <span v-if="error && !settled" class="join-request-banner-error" role="alert" data-testid="join-request-banner-error">{{ error }}</span>
        </p>
        <span class="join-request-banner-actions">
          <svg v-if="settled" class="join-request-banner-mark" :data-outcome="settled.outcome" viewBox="0 0 16 16" aria-hidden="true" data-testid="join-request-banner-mark">
            <path v-if="settled.outcome === 'approve'" d="M3.5 8.5l3 3 6-7" />
            <path v-else d="M4 4l8 8M12 4l-8 8" />
          </svg>
          <template v-else-if="single">
            <button
              type="button"
              class="join-request-banner-button"
              data-testid="join-request-banner-decline"
              :disabled="Boolean(busy)"
              :aria-label="`Decline ${label(single)}`"
              @click="decide('decline', single)"
            >{{ busy === `decline:${single.id}` ? "Declining…" : "Decline" }}</button>
            <button
              type="button"
              class="join-request-banner-button"
              data-variant="primary"
              data-testid="join-request-banner-approve"
              :disabled="Boolean(busy)"
              :aria-label="`Approve ${label(single)}`"
              @click="decide('approve', single)"
            >{{ busy === `approve:${single.id}` ? "Approving…" : "Approve" }}</button>
          </template>
          <button
            v-else
            type="button"
            class="join-request-banner-button"
            data-variant="primary"
            data-testid="join-request-banner-review"
            @click="emit('open-requests')"
          >Review</button>
          <button
            v-if="!settled"
            type="button"
            class="join-request-banner-close"
            aria-label="Close"
            title="Close"
            data-testid="join-request-banner-close"
            @click="emit('dismiss')"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </span>
      </section>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  joinRequestAskedLabel,
  joinRequesterLabel,
  type RoomJoinRequestAlert,
} from "../room-join-requests.mjs";
import ChatAvatar from "./ChatAvatar.vue";

/**
 * One quiet strip under the room header: who wants to join, and Approve and
 * Decline in place. Two people are named; more become a count, and one
 * Review button opens the Requests list. A decision made here answers in
 * place ("Ada is in") for a moment before the strip folds away. Shown to
 * room admins only: the host decides that, this strip only renders.
 */
const props = withDefaults(defineProps<{
  requests: readonly RoomJoinRequestAlert[];
  /** `approve:<id>` or `decline:<id>` while that decision is being saved. */
  busy?: string | null;
  error?: string | null;
  /** The clock for "5 min ago"; tests pin it. */
  now?: number | null;
  /** How long the answer stays before the strip folds away; tests shorten it. */
  settledMs?: number;
}>(), { busy: null, error: null, now: null, settledMs: 1400 });

const emit = defineEmits<{
  approve: [request: RoomJoinRequestAlert];
  decline: [request: RoomJoinRequestAlert];
  dismiss: [];
  "open-requests": [];
}>();

type Outcome = "approve" | "decline";
/** The decision the person made here; its request leaves `requests` once it is saved. */
const deciding = ref<{ outcome: Outcome; request: RoomJoinRequestAlert } | null>(null);
const settled = ref<{ outcome: Outcome; request: RoomJoinRequestAlert } | null>(null);
let settledTimer: ReturnType<typeof setTimeout> | null = null;

function decide(outcome: Outcome, request: RoomJoinRequestAlert): void {
  deciding.value = { outcome, request };
  if (outcome === "approve") emit("approve", request);
  else emit("decline", request);
}

function clearSettled(): void {
  if (settledTimer) clearTimeout(settledTimer);
  settledTimer = null;
  settled.value = null;
}

// The decided request has left the list: say what happened, briefly. A new
// request in the meantime takes the strip back at once.
watch(() => props.requests.map((request) => request.id).join("\n"), (ids, previousIds) => {
  const current = new Set(ids ? ids.split("\n") : []);
  const decision = deciding.value;
  if (decision && previousIds?.split("\n").includes(decision.request.id) && !current.has(decision.request.id)) {
    deciding.value = null;
    clearSettled();
    settled.value = decision;
    settledTimer = setTimeout(clearSettled, props.settledMs);
    return;
  }
  if (settled.value && current.size) clearSettled();
});
watch(() => props.error, (error) => { if (error) deciding.value = null; });
onBeforeUnmount(() => { if (settledTimer) clearTimeout(settledTimer); });

const shown = computed(() => props.requests.length > 0 || settled.value !== null);
const single = computed(() => (props.requests.length === 1 ? props.requests[0] : null));
/** The first three faces; more than that is the count in the text. */
const faces = computed(() => (settled.value ? [settled.value.request] : props.requests.slice(0, 3)));
const label = (request: RoomJoinRequestAlert) => joinRequesterLabel(request);
const askedLabel = (request: RoomJoinRequestAlert) => joinRequestAskedLabel(request.created_at, props.now ?? Date.now());
</script>

<style src="./join-request-banner.css"></style>
