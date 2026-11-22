<template>
  <div class="color-palette">
    <button ref="trigger" class="palette-trigger" type="button" :aria-label="`${label}: ${currentLabel}`"
      aria-haspopup="dialog" :aria-expanded="open" :aria-controls="id" @click="toggle">
      <span class="palette-current" :style="{ background: followsTheme ? (themePreview || modelValue) : modelValue }" aria-hidden="true" />
      <span>{{ currentLabel }}</span><span class="palette-chevron" aria-hidden="true">⌄</span>
    </button>
    <div :id="id" ref="panel" class="palette-panel" popover="auto" role="dialog" :aria-label="`${label} color`"
      :style="position" @toggle="onToggle" @keydown.esc.stop.prevent="close">
      <header><strong>{{ label }}</strong><button type="button" aria-label="Close color palette" @click="close">×</button></header>
      <div class="palette-grid" role="radiogroup" :aria-label="`${label} preset colors`" @keydown="moveFocus">
        <button v-for="(color, index) in chatColorPresets" :key="color.value" type="button" role="radio"
          :aria-checked="!followsTheme && color.value === modelValue" :aria-label="color.name" :title="color.name"
          :tabindex="index === focusIndex ? 0 : -1" :data-index="index" :style="{ background: color.value, color: readableChatSurface(color.value).foreground }"
          @focus="focusIndex = index" @click="choose(color.value)">
          <svg v-if="!followsTheme && color.value === modelValue" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>
        </button>
      </div>
      <form class="palette-custom" @submit.prevent="applyCustom">
        <label :for="`${id}-hex`">Custom color</label>
        <div><input :id="`${id}-hex`" v-model="draft" type="text" maxlength="7" spellcheck="false" autocapitalize="characters"
          placeholder="#AABBCC" :aria-invalid="invalid || undefined" :aria-describedby="invalid ? `${id}-error` : undefined" @input="invalid = false" />
          <button type="submit">Apply</button></div>
        <p v-if="invalid" :id="`${id}-error`" role="alert">Use a six-digit hex color, such as #AABBCC.</p>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { chatColorName, chatColorPresets, normalizeChatColor, readableChatSurface } from '../chat-colors';
const props = defineProps<{ modelValue: string; label: string; followsTheme?: boolean; themePreview?: string }>();
const currentLabel = computed(() => props.followsTheme ? 'Theme' : chatColorName(props.modelValue));
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = `color-palette-${useId()}`;
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const open = ref(false), invalid = ref(false), draft = ref(props.modelValue), focusIndex = ref(0);
const position = ref<Record<string, string>>({});
watch(() => props.modelValue, value => { draft.value = value; });
function positionPanel() {
  const bounds = trigger.value?.getBoundingClientRect();
  if (!bounds || !panel.value) return;
  const width = Math.min(332, window.innerWidth - 24);
  const height = panel.value.offsetHeight;
  const left = Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12));
  const top = Math.max(12, bounds.bottom + height + 8 <= window.innerHeight - 12 ? bounds.bottom + 8 : bounds.top - height - 8);
  position.value = { width: `${width}px`, left: `${left}px`, top: `${top}px` };
}
async function toggle() {
  if (open.value) { close(); return; }
  draft.value = props.followsTheme ? '' : props.modelValue; invalid.value = false;
  focusIndex.value = Math.max(0, chatColorPresets.findIndex(color => color.value === props.modelValue));
  panel.value?.showPopover();
  await nextTick(); positionPanel();
  panel.value?.querySelector<HTMLButtonElement>(`[data-index="${focusIndex.value}"]`)?.focus({ preventScroll: true });
}
function close() { panel.value?.hidePopover(); trigger.value?.focus({ preventScroll: true }); }
function onToggle(event: Event) {
  open.value = (event as ToggleEvent).newState === 'open';
  if (open.value) {
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, true);
  } else {
    window.removeEventListener('resize', positionPanel);
    window.removeEventListener('scroll', positionPanel, true);
  }
}
function choose(value: string) { emit('update:modelValue', value); }
function applyCustom() {
  const color = normalizeChatColor(draft.value);
  invalid.value = !color;
  if (color) { choose(color); close(); }
}
function moveFocus(event: KeyboardEvent) {
  const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -10, ArrowDown: 10 };
  let index = focusIndex.value;
  if (event.key in offsets) index = (index + offsets[event.key]! + chatColorPresets.length) % chatColorPresets.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = chatColorPresets.length - 1;
  else return;
  event.preventDefault();
  focusIndex.value = index;
  choose(chatColorPresets[index]!.value);
  panel.value?.querySelector<HTMLButtonElement>(`[data-index="${index}"]`)?.focus();
}
onBeforeUnmount(() => {
  window.removeEventListener('resize', positionPanel);
  window.removeEventListener('scroll', positionPanel, true);
  panel.value?.hidePopover();
});
</script>

<style scoped>
.color-palette { min-width: 0; }
.palette-trigger { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 8px 12px; border: 1px solid light-dark(#d6d6d6, #333); border-radius: 10px; background: light-dark(#fff, #151515); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.palette-current { width: 20px; height: 20px; border-radius: 50%; border: 1px solid light-dark(#aaa, #666); flex: none; }
.palette-chevron { color: light-dark(#666, #999); margin-left: auto; }
.palette-panel { box-sizing: border-box; position: fixed; inset: auto; margin: 0; width: 332px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); overflow: auto; padding: 16px; background: light-dark(#fafafa, #111); color: light-dark(#202020, #eee); border: 1px solid light-dark(#d4d4d4, #333); border-radius: 16px; box-shadow: 0 16px 48px rgb(0 0 0 / .26); }
.palette-panel:popover-open { animation: palette-in 140ms cubic-bezier(.23,1,.32,1); }
.palette-panel header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; font-size: 14px; }
.palette-panel header button { width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; color: inherit; background: transparent; font-size: 24px; cursor: pointer; }
.palette-grid { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 4px; }
.palette-grid button { display: grid; place-items: center; aspect-ratio: 1; min-width: 0; border: 1px solid rgb(128 128 128 / .24); border-radius: 6px; padding: 3px; cursor: pointer; }
.palette-grid svg { width: 100%; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.palette-custom { margin-top: 18px; }
.palette-custom label { display: block; margin-bottom: 8px; font-size: 12px; color: light-dark(#666, #aaa); }
.palette-custom > div { display: flex; gap: 8px; }
.palette-custom input { width: 0; flex: 1; min-height: 36px; padding: 6px 10px; background: light-dark(#fff, #090909); color: inherit; border: 1px solid light-dark(#ccc, #3d3d3d); border-radius: 8px; font: 13px ui-monospace, monospace; }
.palette-custom button { padding: 6px 12px; background: light-dark(#222, #eee); color: light-dark(#fff, #171717); border: 0; border-radius: 8px; font: inherit; font-size: 12px; cursor: pointer; }
.palette-custom p { font-size: 12px; margin: 8px 0 0; color: light-dark(#aa2929, #f4a09c); }
button:focus-visible, input:focus-visible { outline: 2px solid light-dark(#315b8c, #a9c7ec); outline-offset: 3px; }
@keyframes palette-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .palette-panel:popover-open { animation: none; } }
</style>
