<template>
  <Transition name="join-request-banner" appear>
    <section
      v-if="requests.length"
      class="join-request-banner"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="join-request-banner"
      :data-count="requests.length"
    >
      <span class="join-request-banner-faces" aria-hidden="true">
        <ChatAvatar v-for="request in faces" :key="request.id" :name="label(request)" :avatar-url="request.avatar_url" />
      </span>
      <p class="join-request-banner-copy">
        <span data-testid="join-request-banner-text">
          <template v-if="single"><b>{{ label(single) }}</b> wants to join</template>
          <template v-else-if="requests.length === 2"><b>{{ label(requests[0]) }}</b> and <b>{{ label(requests[1]) }}</b> want to join</template>
          <template v-else><b>{{ requests.length }} people</b> want to join</template>
        </span>
        <span v-if="single" class="join-request-banner-meta">@{{ single.login }} · {{ askedLabel(single) }}</span>
        <span v-if="error" class="join-request-banner-error" role="alert" data-testid="join-request-banner-error">{{ error }}</span>
      </p>
      <span class="join-request-banner-actions">
        <template v-if="single">
          <button
            type="button"
            class="join-request-banner-button"
            data-testid="join-request-banner-decline"
            :disabled="Boolean(busy)"
            :aria-label="`Decline ${label(single)}`"
            @click="emit('decline', single)"
          >{{ busy === `decline:${single.id}` ? "Declining…" : "Decline" }}</button>
          <button
            type="button"
            class="join-request-banner-button"
            data-variant="primary"
            data-testid="join-request-banner-approve"
            :disabled="Boolean(busy)"
            :aria-label="`Approve ${label(single)}`"
            @click="emit('approve', single)"
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
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  joinRequestAskedLabel,
  joinRequesterLabel,
  type RoomJoinRequestAlert,
} from "../room-join-requests.mjs";
import ChatAvatar from "./ChatAvatar.vue";

/**
 * One quiet strip under the room header: who wants to join, and Approve and
 * Decline in place. Two people are named; more become a count, and one
 * Review button opens the Requests list. Shown to room admins only: the host
 * decides that, this strip only renders.
 */
const props = withDefaults(defineProps<{
  requests: readonly RoomJoinRequestAlert[];
  /** `approve:<id>` or `decline:<id>` while that decision is being saved. */
  busy?: string | null;
  error?: string | null;
  /** The clock for "5 min ago"; tests pin it. */
  now?: number | null;
}>(), { busy: null, error: null, now: null });

const emit = defineEmits<{
  approve: [request: RoomJoinRequestAlert];
  decline: [request: RoomJoinRequestAlert];
  dismiss: [];
  "open-requests": [];
}>();

const single = computed(() => (props.requests.length === 1 ? props.requests[0] : null));
/** The first three faces; more than that is the count in the text. */
const faces = computed(() => props.requests.slice(0, 3));
const label = (request: RoomJoinRequestAlert) => joinRequesterLabel(request);
const askedLabel = (request: RoomJoinRequestAlert) => joinRequestAskedLabel(request.created_at, props.now ?? Date.now());
</script>

<style src="./join-request-banner.css"></style>
