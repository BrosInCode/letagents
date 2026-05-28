<template>
  <article
    class="room-chat-message"
    :class="{
      'is-system-message': isSystem,
      'is-github-message': Boolean(githubEvent),
      'has-reply': Boolean(message.replyTo),
      'is-search-active': searchActive,
    }"
    :data-owner-kind="ownerKind"
    :data-testid="`room-message-${message.id}`"
  >
    <div
      class="room-chat-avatar"
      :style="{ '--avatar-color': senderColor }"
      aria-hidden="true"
    />

    <div class="room-chat-message-content">
      <div class="room-message-meta">
        <div class="room-message-author-block">
          <button
            v-if="ownerKind === 'agent'"
            class="room-message-author-button"
            type="button"
            :title="`Show ${displayName} activity`"
            @click="$emit('open-agent', agentModalTarget)"
          >
            {{ displayName }}
          </button>
          <strong v-else>{{ displayName }}</strong>
          <span v-if="ownerAttribution" class="room-message-owner">{{ ownerAttribution }}</span>
          <span v-if="ideLabel" class="room-message-ide" :data-ide="ideLabel.toLowerCase()">
            {{ ideLabel }}
          </span>
        </div>
        <div class="room-message-meta-tail">
          <button class="room-message-reply-action" type="button" title="Reply" @click="$emit('reply', message)">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6.5 4.5 2.5 8l4 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M3 8h5.5A4.5 4.5 0 0 1 13 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <span class="room-message-provenance" :data-kind="ownerKind">
            {{ ownerKind }}
          </span>
          <time :datetime="message.timestamp">{{ formattedTime }}</time>
        </div>
      </div>

      <div class="room-message-bubble">
        <button
          v-if="message.replyTo"
          class="room-message-reply"
          type="button"
          :aria-label="`Reply preview from ${replyDisplayName}`"
          @click="$emit('scroll-to-message', message.replyTo.id)"
        >
          <span class="room-message-reply-label">Replying to {{ replyDisplayName }}</span>
          <span class="room-message-reply-text">{{ replyPreviewText }}</span>
        </button>

        <DesktopGitHubEventCard v-if="githubEvent" :event="githubEvent" />

        <DesktopLongMessageContent
          v-else
          :text="message.text || 'No message body.'"
          :html="renderedText"
          :message-id="message.id"
        />

        <DesktopMessageAttachments
          v-if="message.attachments.length"
          :message-id="message.id"
          :attachments="message.attachments"
          @open-image="$emit('open-image', $event)"
        />
      </div>

      <button
        v-if="threadCount > 0"
        class="room-thread-marker"
        type="button"
        @click="$emit('scroll-to-message', latestThreadMessageId)"
      >
        {{ threadCount === 1 ? "1 reply" : `${threadCount} replies` }}
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopRoomMessage } from "../../../../../electron/ipc-types";
import DesktopGitHubEventCard from "./desktop-chat-message/DesktopGitHubEventCard.vue";
import DesktopMessageAttachments from "./desktop-chat-message/DesktopMessageAttachments.vue";
import {
  getSenderColor,
  parseSenderIdentity,
} from "./desktop-chat-message/identity";
import { parseGitHubEvent } from "./desktop-chat-message/github-event";
import {
  formatTimestamp,
  renderMessageText,
  truncate,
} from "./desktop-chat-message/message-rendering";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import DesktopLongMessageContent from "./DesktopLongMessageContent.vue";

export type { AgentModalTarget } from "./desktop-chat-message/types";

const props = defineProps<{
  message: DesktopRoomMessage;
  threadCount: number;
  latestThreadMessageId: string | null;
  highlightQuery: string;
  searchActive: boolean;
}>();

defineEmits<{
  reply: [message: DesktopRoomMessage];
  "scroll-to-message": [messageId: string | null];
  "open-image": [imageId: string];
  "open-agent": [target: AgentModalTarget];
}>();

const identity = computed(() => parseSenderIdentity(props.message));
const displayName = computed(() => props.message.agentIdentity?.displayName || identity.value.displayName);
const ownerAttribution = computed(() => props.message.agentIdentity?.ownerAttribution || identity.value.ownerAttribution);
const ideLabel = computed(() => props.message.agentIdentity?.ideLabel || identity.value.ideLabel);
const isSystem = computed(() => ["system", "letagents"].includes(props.message.sender.toLowerCase()));
const githubEvent = computed(() => parseGitHubEvent(props.message));
const senderColor = computed(() => getSenderColor(props.message.sender, props.message.source));
const ownerKind = computed(() => {
  if (isSystem.value) return "system";
  if (props.message.source === "github") return "github";
  if (props.message.source === "agent" || ownerAttribution.value || ideLabel.value) return "agent";
  if (props.message.source === "browser") return "human";
  return "room";
});
const replyDisplayName = computed(() =>
  props.message.replyTo ? parseSenderIdentity(props.message.replyTo).displayName : "unknown"
);
const replyPreviewText = computed(() => truncate((props.message.replyTo?.text || "").replace(/\s+/g, " ").trim(), 160));
const formattedTime = computed(() => formatTimestamp(props.message.timestamp));
const renderedText = computed(() => renderMessageText(props.message.text || "No message body.", props.highlightQuery));
const agentModalTarget = computed<AgentModalTarget>(() => ({
  actorLabel: props.message.actorLabel || props.message.agentIdentity?.actorLabel || props.message.sender,
  displayName: displayName.value,
  ownerAttribution: ownerAttribution.value,
  ideLabel: ideLabel.value,
  sender: props.message.sender,
}));
</script>
