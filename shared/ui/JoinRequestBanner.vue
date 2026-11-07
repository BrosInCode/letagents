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
      <ChatAvatar v-if="single" :name="label(single)" :avatar-url="single.avatar_url" />
      <span v-else class="join-request-banner-count" aria-hidden="true">{{ requests.length }}</span>
      <div class="join-request-banner-copy">
        <strong data-testid="join-request-banner-text">{{ text }}</strong>
        <small v-if="single">@{{ single.login }} · asked {{ askedLabel(single) }}</small>
        <small v-else>{{ names }}</small>
        <small v-if="error" class="join-request-banner-error" role="alert" data-testid="join-request-banner-error">{{ error }}</small>
      </div>
      <div class="join-request-banner-actions">
        <template v-if="single">
          <button
            type="button"
            class="join-request-banner-button"
            data-variant="primary"
            data-testid="join-request-banner-approve"
            :disabled="Boolean(busy)"
            :aria-label="`Approve ${label(single)}`"
            @click="emit('approve', single)"
          >{{ busy === `approve:${single.id}` ? "Approving…" : "Approve" }}</button>
          <button
            type="button"
            class="join-request-banner-button"
            data-testid="join-request-banner-decline"
            :disabled="Boolean(busy)"
            :aria-label="`Decline ${label(single)}`"
            @click="emit('decline', single)"
          >{{ busy === `decline:${single.id}` ? "Declining…" : "Decline" }}</button>
        </template>
        <button
          v-else
          type="button"
          class="join-request-banner-button"
          data-variant="primary"
          data-testid="join-request-banner-review"
          @click="emit('open-requests')"
        >Review requests</button>
        <button
          type="button"
          class="join-request-banner-close"
          aria-label="Close"
          title="Close"
          data-testid="join-request-banner-close"
          @click="emit('dismiss')"
        >×</button>
      </div>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  joinRequestAskedLabel,
  joinRequestBannerText,
  joinRequesterLabel,
  type RoomJoinRequestAlert,
} from "../room-join-requests.mjs";
import ChatAvatar from "./ChatAvatar.vue";

/**
 * "<Name> wants to join this room", with Approve and Decline in place, or
 * "N people want to join this room" with one button to the Requests list.
 * Shown to room admins only: the host decides that, this card only renders.
 */
const props = withDefaults(defineProps<{
  requests: readonly RoomJoinRequestAlert[];
  /** `approve:<id>` or `decline:<id>` while that decision is being saved. */
  busy?: string | null;
  error?: string | null;
  /** The clock for "asked 5 min ago"; tests pin it. */
  now?: number | null;
}>(), { busy: null, error: null, now: null });

const emit = defineEmits<{
  approve: [request: RoomJoinRequestAlert];
  decline: [request: RoomJoinRequestAlert];
  dismiss: [];
  "open-requests": [];
}>();

const single = computed(() => (props.requests.length === 1 ? props.requests[0] : null));
const text = computed(() => joinRequestBannerText(props.requests));
const names = computed(() => props.requests.map(joinRequesterLabel).join(", "));
const label = (request: RoomJoinRequestAlert) => joinRequesterLabel(request);
const askedLabel = (request: RoomJoinRequestAlert) => joinRequestAskedLabel(request.created_at, props.now ?? Date.now());
</script>

<style src="./join-request-banner.css"></style>
