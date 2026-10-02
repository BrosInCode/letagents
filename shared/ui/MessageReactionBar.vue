<template>
  <div v-if="reactions.length" class="message-reactions" role="group" aria-label="Reactions">
    <component
      :is="canReact ? 'button' : 'span'"
      v-for="reaction in reactions"
      :key="reaction.emoji"
      class="message-reaction"
      :type="canReact ? 'button' : undefined"
      :role="canReact ? undefined : 'img'"
      :aria-pressed="canReact ? viewerReacted(reaction.emoji) : undefined"
      :aria-label="label(reaction)"
      :title="label(reaction)"
      @click="canReact && emit('toggle', reaction.emoji)"
    >
      <span class="message-reaction-emoji" aria-hidden="true">{{ reaction.emoji }}</span>
      <span class="message-reaction-count" aria-hidden="true">{{ reaction.count }}</span>
    </component>
    <button
      v-if="canReact"
      class="message-reaction message-reaction-add"
      type="button"
      aria-label="Add reaction"
      title="Add reaction"
      aria-haspopup="dialog"
      :aria-expanded="pickerOpen ?? false"
      @click="emit('add', $event)"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M22 11v1a10 10 0 1 1-9-10" />
        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
        <path d="M9 9h.01M15 9h.01" />
        <path d="M16 5h6M19 2v6" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { describeMessageReaction, type MessageReaction } from "../message-reactions.mjs";

const props = defineProps<{
  reactions: readonly MessageReaction[];
  viewerLogin: string | null;
  /** Whether the viewer reacted with this emoji, including when they are past the listed reactors. */
  viewerReacted: (emoji: string) => boolean;
  canReact: boolean;
  pickerOpen?: boolean;
}>();

const emit = defineEmits<{
  toggle: [emoji: string];
  /** The click that asked for the picker; its target is the anchor. */
  add: [event: MouseEvent];
}>();

function label(reaction: MessageReaction): string {
  const description = describeMessageReaction(reaction, props.viewerLogin);
  // The list may not name the viewer when many people reacted.
  return props.viewerReacted(reaction.emoji) && !description.startsWith("You")
    ? `You and others reacted with ${reaction.emoji}`
    : description;
}
</script>

<style src="./message-reactions.css"></style>
