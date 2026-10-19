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
      :aria-describedby="detailsEmoji === reaction.emoji ? detailsId : undefined"
      :tabindex="canReact ? undefined : 0"
      @pointerenter="showDetails(reaction.emoji, $event)"
      @pointerleave="scheduleHide"
      @focus="showDetails(reaction.emoji, $event)"
      @blur="scheduleHide"
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
  <Teleport to="body">
    <div v-if="detailsReaction" :id="detailsId" ref="detailsPanel" role="tooltip"
      class="message-reaction-details" :style="detailsPosition"
      @pointerenter="keepDetails" @pointerleave="scheduleHide">
      {{ label(detailsReaction) }}
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { describeMessageReaction, type MessageReaction } from "../message-reactions.mjs";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

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

const detailsId = useId();
const detailsEmoji = ref<string | null>(null);
const detailsReaction = computed(() => props.reactions.find(reaction => reaction.emoji === detailsEmoji.value));
const detailsPanel = ref<HTMLElement | null>(null);
const detailsPosition = ref({ left: "0px", top: "0px", visibility: "hidden" as "hidden" | "visible" });
let detailsAnchor: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
function keepDetails(): void { clearTimeout(hideTimer); }
function hideDetails(): void {
  keepDetails(); detailsEmoji.value = null; detailsAnchor = null;
  window.removeEventListener("scroll", dismissOnScroll, true);
  window.removeEventListener("resize", hideDetails);
  window.removeEventListener("blur", hideDetails);
  window.removeEventListener("keydown", dismissOnEscape);
}
function scheduleHide(): void { keepDetails(); hideTimer = setTimeout(hideDetails, 120); }
function dismissOnScroll(event: Event): void {
  if (!detailsPanel.value?.contains(event.target as Node)) hideDetails();
}
function dismissOnEscape(event: KeyboardEvent): void { if (event.key === "Escape") hideDetails(); }
async function showDetails(emoji: string, event: Event): Promise<void> {
  keepDetails();
  detailsAnchor = event.currentTarget as HTMLElement;
  detailsEmoji.value = emoji;
  detailsPosition.value.visibility = "hidden";
  await nextTick();
  if (!detailsAnchor?.isConnected || !detailsPanel.value || detailsEmoji.value !== emoji) return;
  const anchor = detailsAnchor.getBoundingClientRect(), panel = detailsPanel.value.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - panel.width - 8));
  const above = anchor.top - panel.height - 6;
  const top = above >= 8 ? above : Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - panel.height - 8));
  detailsPosition.value = { left: `${left}px`, top: `${top}px`, visibility: "visible" };
  window.addEventListener("scroll", dismissOnScroll, true);
  window.addEventListener("resize", hideDetails);
  window.addEventListener("blur", hideDetails);
  window.addEventListener("keydown", dismissOnEscape);
}
watch(detailsReaction, reaction => { if (!reaction && detailsEmoji.value) hideDetails(); });
onBeforeUnmount(() => { if (typeof window !== "undefined") hideDetails(); });

function label(reaction: MessageReaction): string {
  // Preserve the listed names even when the viewer falls beyond the server's list.
  return describeMessageReaction(reaction, props.viewerLogin, props.viewerReacted(reaction.emoji));
}
</script>

<style src="./message-reactions.css"></style>
