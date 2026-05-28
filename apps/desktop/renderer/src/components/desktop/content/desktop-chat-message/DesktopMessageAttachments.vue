<template>
  <div class="room-message-attachments">
    <template v-for="attachment in attachments" :key="attachmentKey(attachment)">
      <button
        v-if="isImageAttachment(attachment)"
        class="room-message-attachment is-image"
        type="button"
        @click="$emit('open-image', imageAttachmentId(messageId, attachment))"
      >
        <img :src="attachmentHref(attachment)" :alt="attachmentName(attachment)">
        <span>
          <strong>{{ attachmentName(attachment) }}</strong>
          <small>{{ attachmentDisplayMeta(attachment) }}</small>
        </span>
      </button>
      <a
        v-else
        class="room-message-attachment"
        :href="attachmentHref(attachment)"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span>
          <strong>{{ attachmentName(attachment) }}</strong>
          <small>{{ attachmentDisplayMeta(attachment) }}</small>
        </span>
      </a>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { DesktopRoomMessageAttachment } from "../../../../../../electron/ipc-types";
import {
  attachmentHref,
  attachmentDisplayMeta,
  attachmentKey,
  attachmentName,
  imageAttachmentId,
  isImageAttachment,
} from "./attachments";

defineProps<{
  messageId: string;
  attachments: DesktopRoomMessageAttachment[];
}>();

defineEmits<{
  "open-image": [imageId: string];
}>();
</script>
