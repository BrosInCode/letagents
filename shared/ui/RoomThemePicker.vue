<template>
  <div class="room-theme-picker">
    <div v-if="preview" class="room-theme-preview" :style="previewStyle" aria-hidden="true">
      <div class="preview-sidebar">
        <strong>{{ company || 'Your workspace' }}</strong>
        <span>Product</span>
        <span>Platform</span>
      </div>
      <div class="preview-room">
        <header><strong>Product</strong><span>Chat</span></header>
        <div class="preview-conversation">
          <div class="preview-reply" :style="humanStyle"><small>Ada</small><p>Ready for a second look?</p></div>
          <div class="preview-reply mine" :style="selfStyle"><p>Let’s take a look.</p></div>
        </div>
        <div class="preview-composer"><span>Message #Product</span><i>↑</i></div>
      </div>
    </div>
    <fieldset>
      <legend class="theme-picker-legend">{{ label }}</legend>
      <div class="theme-choice-grid">
        <label v-for="theme in roomThemePresets" :key="theme.id" class="theme-choice" :data-current="activeTheme === theme.id">
          <input type="radio" :name="group" :value="theme.id" :checked="modelValue === theme.id" @change="emit('update:modelValue', theme.id)">
          <span class="theme-swatch" :style="{ '--swatch': theme.accent }">
            <i v-if="activeTheme === theme.id" aria-hidden="true" />
          </span>
          <span>{{ theme.label }}</span>
        </label>
      </div>
    </fieldset>
    <button type="button" class="theme-inherit" :disabled="modelValue === null" @click="emit('update:modelValue', null)">
      {{ inheritLabel || (company ? (modelValue ? 'Use company theme' : 'Using company theme') : (modelValue ? 'Use default theme' : 'Using default theme')) }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, useId } from "vue";
import { chatBubbleStyle, defaultChatColors } from "../chat-colors";
import { roomThemePresets, type RoomThemeId } from "../room-themes.mjs";
import { roomThemeStyle, themeChatBubble } from "./room-theme";

const props = defineProps<{
  modelValue: RoomThemeId | null;
  inherited?: RoomThemeId | null;
  company?: string | null;
  inheritLabel?: string;
  label: string;
  preview?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [theme: RoomThemeId | null] }>();
const group = useId();
const activeTheme = computed(() => props.modelValue ?? props.inherited ?? null);
const previewStyle = computed(() => roomThemeStyle(activeTheme.value));
const humanStyle = computed(() => activeTheme.value ? themeChatBubble(activeTheme.value, "human") : chatBubbleStyle(defaultChatColors.human));
const selfStyle = computed(() => activeTheme.value ? themeChatBubble(activeTheme.value, "self") : chatBubbleStyle(defaultChatColors.self));
</script>

<style scoped>
.room-theme-picker { display: grid; gap: 18px; container-type: inline-size; color: inherit; }
.room-theme-picker fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.theme-picker-legend { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; white-space: nowrap; }
.theme-choice-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.theme-choice { position: relative; display: grid; gap: 5px; padding: 4px 4px 6px; border: 1px solid transparent; border-radius: 9px; font-size: 11px; line-height: 1.25; text-align: center; }
.theme-choice input { position: absolute; z-index: 1; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.theme-choice[data-current="true"] { border-color: color-mix(in srgb, var(--workspace-accent, currentColor) 55%, transparent); background: color-mix(in srgb, currentColor 8%, transparent); }
.theme-choice:has(input:focus-visible) { outline: 2px solid var(--workspace-accent, currentColor); outline-offset: 1px; }
.theme-swatch { display: grid; place-items: center; height: 32px; border-radius: 5px; color: #17171a; background: linear-gradient(90deg, color-mix(in srgb, var(--swatch) 58%, #101114) 27%, var(--swatch) 27%); }
.theme-swatch i { width: 9px; height: 5px; margin-inline-start: 25%; border-inline-start: 2px solid; border-bottom: 2px solid; transform: rotate(-45deg); }
.theme-inherit { border: 0; border-radius: 7px; background: transparent; color: var(--workspace-accent, currentColor); cursor: pointer; font: inherit; font-size: 12px; justify-self: start; min-height: 36px; padding: 5px 8px; margin-inline-start: -8px; }
.theme-inherit:disabled { opacity: .65; cursor: default; }
.theme-inherit:focus-visible { outline: 2px solid var(--workspace-accent, currentColor); }
@media (hover: hover) and (pointer: fine) {
  .theme-choice:hover, .theme-inherit:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
}
@container (min-width: 450px) { .theme-choice-grid { grid-template-columns: repeat(8, minmax(0, 1fr)); } }
.room-theme-preview { display: grid; grid-template-columns: clamp(90px, 25%, 158px) minmax(0, 1fr); min-height: 246px; border: 1px solid var(--workspace-border, var(--border)); border-radius: 14px; overflow: hidden; background: var(--workspace-canvas, var(--bg)); font-size: 12px; text-align: start; }
.preview-sidebar { display: flex; flex-direction: column; gap: 7px; padding: 17px 9px; background: var(--workspace-sidebar, var(--bg-subtle)); border-inline-end: 1px solid var(--workspace-border, var(--border)); }
.preview-sidebar strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-inline: 5px; margin-block-end: 3px; }
.preview-sidebar span { display: flex; gap: 6px; align-items: center; padding: 6px 5px; border-radius: 6px; }
.preview-sidebar span:first-of-type { background: color-mix(in srgb, var(--workspace-accent, currentColor) 17%, transparent); }
.preview-room { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
.preview-room header { display: flex; flex-direction: column; align-items: start; gap: 8px; padding: 13px 13px 0; border-bottom: 1px solid var(--workspace-border, var(--border)); }
.preview-room header span { display: flex; align-items: center; gap: 5px; padding-block-end: 7px; border-bottom: 2px solid var(--workspace-accent, currentColor); }
.preview-conversation { display: grid; align-content: end; gap: 7px; padding: 14px; }
.preview-reply { justify-self: start; }
.preview-reply.mine { justify-self: end; }
.preview-reply small { display: block; margin-block-end: 3px; }
.preview-reply p { margin: 0; padding: 7px 9px; border-radius: 9px; color: var(--chat-foreground); background: linear-gradient(125deg, var(--chat-bubble-start), var(--chat-bubble) 48%, var(--chat-bubble-end)); }
.preview-composer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 10px 10px; padding: 5px 7px 5px 9px; border: 1px solid var(--workspace-border, var(--border)); border-radius: 8px; background: var(--workspace-composer, var(--bg-card)); }
.preview-composer i { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: var(--workspace-accent, var(--text)); color: var(--workspace-canvas, var(--bg)); }
</style>
