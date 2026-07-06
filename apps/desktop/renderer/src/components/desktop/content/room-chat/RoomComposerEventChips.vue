<template>
  <TransitionGroup
    v-if="eventPreviews.length"
    name="desktop-composer-event"
    tag="div"
    class="desktop-composer-events"
    aria-live="polite"
    data-testid="desktop-composer-events"
  >
    <div
      v-for="event in eventPreviews"
      :key="event.id"
      class="desktop-composer-event"
      :data-tone="event.tone"
      :title="event.headline"
    >
      <button
        class="desktop-composer-event-main"
        type="button"
        @click="emit('open-event-preview', event)"
      >
        <span class="desktop-composer-event-icon" aria-hidden="true">
          <GitPullRequest v-if="event.kind === 'pull-request'" :size="13" />
          <CircleAlert v-else-if="event.kind === 'check'" :size="13" />
          <MessageSquare v-else-if="event.kind === 'review' || event.kind === 'comment'" :size="13" />
          <GitBranch v-else :size="13" />
        </span>
        <span class="desktop-composer-event-copy">
          <small>{{ event.statusLabel || event.kindLabel }}</small>
          <strong>{{ event.headline }}</strong>
        </span>
      </button>
      <button
        class="desktop-composer-event-view"
        type="button"
        @click="emit('open-event-preview', event)"
      >
        View
      </button>
      <button
        class="desktop-composer-event-dismiss"
        type="button"
        :aria-label="`Dismiss ${event.headline}`"
        @click="emit('dismiss-event-preview', event.id)"
      >
        <X :size="12" aria-hidden="true" />
      </button>
    </div>
  </TransitionGroup>
</template>

<script setup lang="ts">
import { CircleAlert, GitBranch, GitPullRequest, MessageSquare, X } from "@lucide/vue";

export interface ComposerEventPreview {
  id: string;
  kind: "pull-request" | "issue" | "review" | "comment" | "check" | "repository" | "generic";
  tone: "violet" | "amber" | "emerald" | "rose" | "sky" | "slate";
  kindLabel: string;
  statusLabel: string | null;
  headline: string;
  url: string | null;
}

defineProps<{
  eventPreviews: ComposerEventPreview[];
}>();

const emit = defineEmits<{
  "open-event-preview": [event: ComposerEventPreview];
  "dismiss-event-preview": [messageId: string];
}>();
</script>
