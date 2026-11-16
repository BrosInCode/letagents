<template>
  <div
    ref="root"
    class="invite-bot-picker-seg"
    role="radiogroup"
    aria-label="Which bot"
    data-testid="invite-bot-picker"
    @keydown="onKey"
  >
    <!-- The thumb slides under the picked bot; it is moved by its own transform. -->
    <span class="invite-bot-picker-thumb" aria-hidden="true" :style="{ transform: `translateX(${index * 100}%)` }"></span>
    <button
      v-for="(choice, at) in INVITE_BOT_PLATFORMS"
      :key="choice.id"
      type="button"
      role="radio"
      class="invite-bot-picker-option"
      :data-platform="choice.id"
      :aria-checked="modelValue === choice.id ? 'true' : 'false'"
      :tabindex="modelValue === choice.id ? 0 : -1"
      :data-invite-autofocus="at === index || undefined"
      @click="emit('update:modelValue', choice.id)"
    >{{ choice.label }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

import { INVITE_BOT_PLATFORMS, type InviteBotPlatform } from "./invite-bot";
import "./invite-bot-parts.css";

const props = defineProps<{ modelValue: InviteBotPlatform }>();
const emit = defineEmits<{ "update:modelValue": [platform: InviteBotPlatform] }>();
const root = ref<HTMLElement | null>(null);

const index = computed(() => Math.max(0, INVITE_BOT_PLATFORMS.findIndex((choice) => choice.id === props.modelValue)));

/** A radio group: Left/Right (and Up/Down) move the choice, Home/End jump; focus follows. */
function onKey(event: KeyboardEvent): void {
  // Alt+Left (back), Cmd+arrows and Shift+arrows belong to the system.
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const last = INVITE_BOT_PLATFORMS.length - 1;
  let next: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index.value === last ? 0 : index.value + 1;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index.value === 0 ? last : index.value - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  if (next === null) return;
  event.preventDefault();
  // Arrow keys stay inside the group; the "+" menu must not take them.
  event.stopPropagation();
  emit("update:modelValue", INVITE_BOT_PLATFORMS[next]!.id);
  void nextTick(() => root.value?.querySelectorAll<HTMLElement>('[role="radio"]')[next!]?.focus({ preventScroll: true }));
}
</script>
