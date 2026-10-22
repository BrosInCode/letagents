<template>
  <div class="work-filter-picker">
    <button
      ref="trigger"
      type="button"
      class="work-filter-trigger"
      :popovertarget="id"
      :disabled="disabled"
      :aria-label="`${label}: ${selected?.label || modelValue}`"
      aria-haspopup="listbox"
      :aria-expanded="opened"
      :aria-controls="`${id}-options`"
      @keydown.down.prevent="show"
      @keydown.up.prevent="show"
    >
      <slot name="trigger" :option="selected"><slot name="icon" /><span>{{ selected?.label || modelValue }}</span></slot><svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m4 6 4 4 4-4" />
      </svg>
    </button>
    <div
      :id="id"
      ref="menu"
      class="work-filter-menu"
      popover="auto"
      @toggle="toggled"
      @keydown="keydown"
      @focusout="focusout"
    >
      <label v-if="searchable" class="work-menu-search"
        ><svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" /></svg
        ><input
          ref="input"
          v-model="query"
          type="search"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
          autocomplete="off"
      /></label>
      <div :id="`${id}-options`" role="listbox" :aria-label="label">
        <button
          v-for="(option, index) in visible"
          :key="option.id"
          type="button"
          role="option"
          class="work-menu-option"
          :aria-selected="option.id === modelValue"
          :disabled="option.disabled"
          :tabindex="index === focusIndex ? 0 : -1"
          @click="choose(option.id)"
        >
          <slot name="option" :option="option"><span class="work-option-mark" aria-hidden="true">{{
            option.mark || (option.id ? option.label.slice(0, 2) : "≡")
          }}</span
          ><span class="work-option-label">{{ option.label }}</span
          ><span
            v-if="option.count !== undefined"
            class="work-option-count"
            aria-hidden="true"
            >{{ option.count }}</span></slot
          ><svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path v-if="option.id === modelValue" d="m3 8 3 3 7-7" />
          </svg>
        </button>
      </div>
      <p v-if="!visible.length" role="status" class="work-menu-empty">
        No matches found.
      </p>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    options: readonly {
      id: string;
      label: string;
      mark?: string;
      count?: number;
      disabled?: boolean;
    }[];
    disabled?: boolean;
    matchTriggerWidth?: boolean;
    searchable?: boolean;
    searchPlaceholder?: string;
  }>(),
  { searchPlaceholder: "Find a room…" },
);
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const id = `work-filter-${useId()}`;
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
const opened = ref(false);
const query = ref("");
const focusIndex = ref(0);
const selected = computed(() =>
  props.options.find((option) => option.id === props.modelValue),
);
const visible = computed(() =>
  props.options.filter((option) =>
    option.label
      .toLocaleLowerCase()
      .includes(query.value.trim().toLocaleLowerCase()),
  ),
);
function position() {
  if (!opened.value || !menu.value || !trigger.value) return;
  const box = trigger.value.getBoundingClientRect(),
    popup = menu.value,
    edge = 12,
    gap = 7;
  if (props.matchTriggerWidth) popup.style.width = `${box.width}px`;
  popup.style.maxHeight = `${Math.max(0, window.innerHeight - 2 * edge)}px`;
  const below = window.innerHeight - box.bottom - gap - edge,
    above = box.top - gap - edge;
  const flip = below < popup.offsetHeight && above > below;
  popup.style.maxHeight = `${Math.max(0, flip ? above : below)}px`;
  popup.style.left = `${Math.max(edge, Math.min(box.left, window.innerWidth - popup.offsetWidth - edge))}px`;
  popup.style.top = `${Math.max(edge, flip ? box.top - gap - popup.offsetHeight : box.bottom + gap)}px`;
}
function reposition(event: Event) {
  if (!(event.target instanceof Node) || !menu.value?.contains(event.target))
    position();
}
function show() {
  if (!props.disabled) menu.value?.showPopover();
}
function close(restore = false) {
  menu.value?.hidePopover();
  if (restore) trigger.value?.focus({ preventScroll: true });
}
function choose(value: string) {
  if (props.disabled || props.options.find(option => option.id === value)?.disabled) return;
  emit("update:modelValue", value);
  close(true);
}
async function toggled(event: Event) {
  opened.value = (event as ToggleEvent).newState === "open";
  window.removeEventListener("resize", position);
  window.removeEventListener("scroll", reposition, true);
  if (!opened.value) return;
  query.value = "";
  focusIndex.value = Math.max(
    0,
    props.options.findIndex((option) => option.id === props.modelValue && !option.disabled),
  );
  await nextTick();
  position();
  (
    input.value || menu.value?.querySelector<HTMLElement>('[role="option"]:not(:disabled)[tabindex="0"]') || menu.value?.querySelector<HTMLElement>('[role="option"]:not(:disabled)') || trigger.value
  )?.focus({ preventScroll: true });
  window.addEventListener("resize", position);
  window.addEventListener("scroll", reposition, true);
}
function focusout(event: FocusEvent) {
  if (
    event.relatedTarget instanceof Node &&
    !menu.value?.contains(event.relatedTarget) &&
    event.relatedTarget !== trigger.value
  )
    close();
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
    return;
  }
  if (event.key === "Enter" && event.target === input.value) {
    event.preventDefault();
    const first = visible.value.find(option => !option.disabled);
    if (first) choose(first.id);
    return;
  }
  if (
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
    (!["ArrowDown", "ArrowUp"].includes(event.key) &&
      event.target === input.value)
  )
    return;
  event.preventDefault();
  const options = [
    ...(menu.value?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') || []),
  ];
  if (!options.length) return;
  const current = options.indexOf(document.activeElement as HTMLElement);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : current < 0
          ? event.key === "ArrowUp"
            ? options.length - 1
            : 0
          : (current + (event.key === "ArrowUp" ? -1 : 1) + options.length) %
            options.length;
  const target = options[nextIndex];
  focusIndex.value = [...(menu.value?.querySelectorAll<HTMLElement>('[role="option"]') || [])].indexOf(target);
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "nearest" });
}
watch(() => props.disabled, disabled => { if (disabled) close(); });
watch(visible, async () => {
  focusIndex.value = Math.max(
    0,
    visible.value.findIndex((option) => option.id === props.modelValue),
  );
  await nextTick();
  position();
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", position);
  window.removeEventListener("scroll", reposition, true);
});
</script>
<style scoped>
.work-filter-picker {
  min-width: 0;
}
.work-filter-trigger {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 34px;
  max-width: 240px;
  padding: 0 11px;
  border: 1px solid var(--border-strong, #303033);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #98979f);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.work-filter-trigger > span {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.work-filter-trigger svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  stroke: currentColor;
  stroke-width: 1.5;
}
.work-filter-trigger:disabled,.work-menu-option:disabled { opacity: .5; cursor: default; }
.work-filter-trigger:hover,
.work-filter-trigger[aria-expanded="true"] {
  color: var(--text, #eee);
  background: light-dark(#eeedf0, #1c1c1f);
}
.work-filter-trigger:focus-visible,
.work-menu-option:focus-visible {
  outline: 2px solid var(--text-secondary, #98979f);
  outline-offset: 2px;
}
.work-filter-menu {
  position: fixed;
  inset: auto;
  box-sizing: border-box;
  margin: 0;
  width: 252px;
  max-width: calc(100vw - 24px);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 6px;
  border: 1px solid light-dark(#d9d8dd, #333236);
  border-radius: 10px;
  background: light-dark(#fff, #161617);
  color: var(--text, #eae9ec);
  box-shadow: 0 12px 36px #0004;
  font: 12px/1.4 var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
}
.work-menu-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 12px;
  margin-bottom: 5px;
  border-bottom: 1px solid light-dark(#e5e4e9, #2b2b2e);
  color: var(--text-secondary, #98979f);
}
.work-menu-search svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  stroke: currentColor;
  stroke-width: 1.5;
}
.work-menu-search:focus-within {
  color: var(--text, #eee);
  background: light-dark(#f6f5f8, #1d1c20);
  border-radius: 4px;
}
.work-menu-search input:focus-visible {
  outline: none;
}
.work-menu-search input {
  min-width: 0;
  width: 100%;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
}
.work-menu-option {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 39px;
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.work-menu-option:hover,
.work-menu-option:focus-visible,
.work-menu-option[aria-selected="true"] {
  background: light-dark(#f0eff3, #252429);
}
.work-option-mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 4px;
  background: light-dark(#e6e5ea, #2a292e);
  color: var(--text-secondary, #98979f);
  font-size: 10px;
  text-transform: lowercase;
}
.work-option-label {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.work-option-count {
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary, #717078);
}
.work-menu-option svg {
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  stroke: currentColor;
  stroke-width: 1.5;
}
.work-menu-empty {
  padding: 8px 10px;
  color: var(--text-secondary, #98979f);
}
</style>
