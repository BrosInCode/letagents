<template>
  <div
    ref="rootElement"
    class="desktop-model-picker"
    :data-open="open"
    :data-placement="placement"
    :data-select-only="selectOnly"
    @focusout="handleFocusOut"
  >
    <label :id="labelId" :for="id" class="desktop-model-picker-label">{{ label }}</label>
    <div class="desktop-model-picker-control">
      <button
        v-if="selectOnly"
        :id="id"
        ref="triggerElement"
        type="button"
        class="desktop-model-picker-trigger"
        role="combobox"
        aria-haspopup="listbox"
        :aria-labelledby="labelId"
        :aria-expanded="open"
        :aria-controls="listboxId"
        :aria-activedescendant="activeOptionId"
        :aria-describedby="describedBy || undefined"
        :data-testid="testId || undefined"
        :disabled="disabled"
        @click="togglePicker"
        @keydown="handleKeydown"
      >
        <span>{{ selectedOption?.label || placeholder }}</span>
      </button>
      <input
        v-else
        :id="id"
        ref="triggerElement"
        v-model="query"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck="false"
        :disabled="disabled"
        :placeholder="placeholder"
        :aria-expanded="open"
        :aria-controls="listboxId"
        :aria-activedescendant="activeOptionId"
        :aria-describedby="describedBy || undefined"
        :data-testid="testId || undefined"
        @click="openPicker"
        @focus="openPicker"
        @input="handleInput"
        @keydown="handleKeydown"
      />
      <Search v-if="!selectOnly" class="desktop-model-picker-search" :size="16" aria-hidden="true" />
      <ChevronDown class="desktop-model-picker-caret" :size="16" aria-hidden="true" />
    </div>

    <Transition name="desktop-model-picker-options">
      <div v-if="open" class="desktop-model-picker-popover">
        <ul :id="listboxId" ref="listElement" class="desktop-model-picker-list" role="listbox" :aria-labelledby="labelId">
          <li
            v-for="(option, index) in filteredOptions"
            :id="optionId(index)"
            :key="option.value"
            role="option"
            :aria-selected="option.value === modelValue"
            :data-active="index === activeIndex"
            :data-selected="option.value === modelValue"
            @pointerdown.prevent
            @pointerenter="activeIndex = index"
            @click="selectOption(option)"
          >
            <span>{{ option.label }}</span>
            <Check v-if="option.value === modelValue" :size="15" aria-hidden="true" />
          </li>
        </ul>
        <p v-if="!filteredOptions.length" class="desktop-model-picker-empty" role="status">
          No matching models
        </p>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Check, ChevronDown, Search } from "@lucide/vue";
import { modelPickerFocusLeft } from "./model-picker-focus";

export interface DesktopModelPickerOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly DesktopModelPickerOption[];
    label?: string;
    disabled?: boolean;
    id?: string;
    describedBy?: string;
    testId?: string;
    placeholder?: string;
    selectOnly?: boolean;
  }>(),
  {
    label: "Model",
    disabled: false,
    id: "desktop-model-picker",
    describedBy: "",
    testId: "",
    placeholder: "Search models",
    selectOnly: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const rootElement = ref<HTMLElement | null>(null);
const triggerElement = ref<HTMLInputElement | HTMLButtonElement | null>(null);
const listElement = ref<HTMLUListElement | null>(null);
const open = ref(false);
const query = ref("");
const activeIndex = ref(0);
const placement = ref<"below" | "above">("below");

const listboxId = computed(() => `${props.id}-options`);
const labelId = computed(() => `${props.id}-label`);
const selectedOption = computed(() =>
  props.options.find((option) => option.value === props.modelValue) ?? null,
);
const filteredOptions = computed(() => {
  const normalized = query.value.trim().toLowerCase();
  if (!normalized || (!open.value && normalized === selectedOption.value?.label.toLowerCase())) {
    return [...props.options];
  }
  return props.options.filter((option) =>
    option.label.toLowerCase().includes(normalized) || option.value.toLowerCase().includes(normalized),
  );
});
const activeOptionId = computed(() =>
  open.value && filteredOptions.value[activeIndex.value]
    ? optionId(activeIndex.value)
    : undefined,
);

// The query only mirrors the selected label, so watch that label, not the whole option list.
watch(
  [() => props.modelValue, () => selectedOption.value?.label],
  () => {
    if (!open.value) syncQueryToSelection();
  },
  { immediate: true },
);

watch(filteredOptions, (options) => {
  if (!options.length) {
    activeIndex.value = 0;
    return;
  }
  if (activeIndex.value >= options.length) activeIndex.value = options.length - 1;
});

function optionId(index: number): string {
  return `${listboxId.value}-${index}`;
}

function syncQueryToSelection(): void {
  query.value = selectedOption.value?.label ?? "";
}

function openPicker(): void {
  if (props.disabled || open.value) return;
  open.value = true;
  query.value = "";
  const selectedIndex = props.options.findIndex((option) => option.value === props.modelValue);
  activeIndex.value = Math.max(0, selectedIndex);
  void positionPicker();
  void scrollActiveOptionIntoView();
}

function togglePicker(): void {
  if (open.value) closePicker();
  else openPicker();
}

async function positionPicker(): Promise<void> {
  await nextTick();
  const root = rootElement.value;
  const rect = root?.getBoundingClientRect();
  if (!root || !rect) return;
  const clippingAncestor = root.closest<HTMLElement>(".desktop-add-agent-status, .agent-inspector-scroll-region");
  const clippingRect = clippingAncestor?.getBoundingClientRect();
  const boundaryTop = Math.max(0, clippingRect?.top ?? 0);
  const boundaryBottom = Math.min(window.innerHeight, clippingRect?.bottom ?? window.innerHeight);
  const availableBelow = Math.max(0, boundaryBottom - rect.bottom - 12);
  const availableAbove = Math.max(0, rect.top - boundaryTop - 12);
  const desiredHeight = Math.min(260, listElement.value?.scrollHeight ?? 260) + 16;
  placement.value = availableBelow < desiredHeight && availableAbove > availableBelow ? "above" : "below";
  const available = placement.value === "above" ? availableAbove : availableBelow;
  root.style.setProperty(
    "--desktop-model-picker-list-max-height",
    `${Math.max(48, Math.min(260, available - 16))}px`,
  );
}

watch(() => props.disabled, (disabled) => {
  if (disabled) closePicker();
});

function closePicker(options: { restoreSelection?: boolean } = {}): void {
  open.value = false;
  if (options.restoreSelection !== false) syncQueryToSelection();
}

function handleInput(): void {
  if (!open.value) open.value = true;
  activeIndex.value = 0;
}

function handleFocusOut(event: FocusEvent): void {
  const root = rootElement.value;
  const left = modelPickerFocusLeft(
    event.relatedTarget,
    (target) => target instanceof Node && Boolean(root?.contains(target)),
    document.hasFocus(),
  );
  if (left) closePicker();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!open.value) {
      openPicker();
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const optionCount = filteredOptions.value.length;
    if (!optionCount) return;
    activeIndex.value = (activeIndex.value + direction + optionCount) % optionCount;
    void scrollActiveOptionIntoView();
    return;
  }
  if (props.selectOnly && open.value && (event.key === "Home" || event.key === "End")) {
    event.preventDefault();
    activeIndex.value = event.key === "Home" ? 0 : Math.max(0, filteredOptions.value.length - 1);
    void scrollActiveOptionIntoView();
    return;
  }
  if ((event.key === "Enter" || (props.selectOnly && event.key === " ")) && open.value) {
    event.preventDefault();
    const option = filteredOptions.value[activeIndex.value];
    if (option) selectOption(option);
    return;
  }
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    closePicker();
    return;
  }
  if (event.key === "Tab") closePicker();
  if (props.selectOnly && event.key.length === 1 && event.key !== " "
    && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const key = event.key.toLowerCase();
    const options = filteredOptions.value;
    const next = options.findIndex((option, index) => index > activeIndex.value && option.label.toLowerCase().startsWith(key));
    const index = next === -1 ? options.findIndex((option) => option.label.toLowerCase().startsWith(key)) : next;
    if (index !== -1) {
      event.preventDefault();
      openPicker();
      activeIndex.value = index;
      void scrollActiveOptionIntoView();
    }
  }
}

function selectOption(option: DesktopModelPickerOption): void {
  emit("update:modelValue", option.value);
  query.value = option.label;
  open.value = false;
  triggerElement.value?.focus();
}

async function scrollActiveOptionIntoView(): Promise<void> {
  await nextTick();
  const list = listElement.value;
  const option = list?.children[activeIndex.value];
  if (!list || !option) return;
  const listRect = list.getBoundingClientRect();
  const optionRect = option.getBoundingClientRect();
  if (optionRect.top < listRect.top) list.scrollTop += optionRect.top - listRect.top;
  else if (optionRect.bottom > listRect.bottom) list.scrollTop += optionRect.bottom - listRect.bottom;
}
</script>

<style scoped>
.desktop-model-picker {
  position: relative;
  display: grid;
  gap: 6px;
  min-width: 0;
}

.desktop-model-picker-label {
  color: var(--text-secondary);
  font-size: 0.76rem;
  font-weight: 750;
  line-height: 1.2;
}

.desktop-model-picker-control {
  position: relative;
  min-width: 0;
}

.desktop-model-picker-control input {
  width: 100%;
  min-width: 0;
  min-height: 42px;
  padding: 0 40px;
  border: 1px solid var(--border);
  border-radius: 12px;
  outline: none;
  background: rgba(255, 255, 255, 0.045);
  color: var(--text);
  font: inherit;
  text-overflow: ellipsis;
  transition:
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out);
}

.desktop-model-picker-control input::-webkit-search-cancel-button {
  display: none;
}

.desktop-model-picker-control input:not(:disabled) {
  cursor: text;
}

.desktop-model-picker-control input:focus-visible {
  border-color: color-mix(in srgb, var(--text) 26%, var(--border));
  background: rgba(255, 255, 255, 0.065);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--text) 9%, transparent);
}

.desktop-model-picker-trigger {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 0 40px 0 13px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--bg-elevated);
  color: var(--text);
  font: inherit;
  font-size: .77rem;
  font-weight: 560;
  text-align: start;
  cursor: pointer;
}

.desktop-model-picker-trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-model-picker-trigger:disabled {
  opacity: .55;
  cursor: default;
}

.desktop-model-picker-trigger[aria-expanded="true"] {
  border-color: var(--border-accent);
}

.desktop-model-picker-trigger:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

@media (hover: hover) and (pointer: fine) {
  .desktop-model-picker-trigger:not(:disabled):hover {
    border-color: var(--border-accent);
  }
}

.desktop-model-picker[data-select-only="true"] .desktop-model-picker-label {
  color: var(--text-secondary);
  font-size: .7rem;
  font-weight: 650;
}

.desktop-model-picker[data-select-only="true"] .desktop-model-picker-popover {
  border-radius: 10px;
}

.desktop-model-picker[data-select-only="true"] .desktop-model-picker-list li {
  border-radius: 6px;
}

.desktop-model-picker[data-select-only="true"] .desktop-model-picker-list li[data-selected="true"]:not([data-active="true"]) {
  background: transparent;
}

.desktop-model-picker-search,
.desktop-model-picker-caret {
  position: absolute;
  top: 50%;
  z-index: 1;
  color: var(--text-tertiary);
  pointer-events: none;
  transform: translateY(-50%);
}

.desktop-model-picker-search {
  left: 14px;
}

.desktop-model-picker-caret {
  right: 14px;
  transition: transform 150ms var(--ease-out), color 150ms var(--ease-out);
}

.desktop-model-picker:focus-within .desktop-model-picker-caret {
  color: var(--text-secondary);
}

.desktop-model-picker[data-open="true"] .desktop-model-picker-caret {
  transform: translateY(-50%) rotate(180deg);
}

.desktop-model-picker-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  left: 0;
  z-index: 12;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--text) 14%, transparent);
  border-radius: 14px;
  background: var(--bg-elevated);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.44);
  transform-origin: top center;
}

.desktop-model-picker[data-placement="above"] .desktop-model-picker-popover {
  top: auto;
  bottom: calc(100% + 8px);
  transform-origin: bottom center;
}

.desktop-model-picker-list {
  display: grid;
  gap: 2px;
  max-height: var(--desktop-model-picker-list-max-height, 260px);
  margin: 0;
  overflow-y: auto;
  padding: 6px;
  list-style: none;
  overscroll-behavior: contain;
}

.desktop-model-picker-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  padding: 8px 10px;
  border-radius: 9px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.8rem;
  line-height: 1.25;
}

.desktop-model-picker-list li[data-active="true"],
.desktop-model-picker-list li[data-selected="true"] {
  background: rgba(255, 255, 255, 0.075);
  color: var(--text);
}

.desktop-model-picker-list li span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-model-picker-empty {
  display: block;
  margin: 0;
  padding: 18px 12px;
  color: var(--text-tertiary);
  font-size: 0.8rem;
  text-align: center;
}

.desktop-model-picker-options-enter-active {
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}

.desktop-model-picker-options-leave-active {
  transition:
    opacity 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.desktop-model-picker-options-enter-from,
.desktop-model-picker-options-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.99);
}

.desktop-model-picker[data-placement="above"] .desktop-model-picker-options-enter-from,
.desktop-model-picker[data-placement="above"] .desktop-model-picker-options-leave-to {
  transform: translateY(4px) scale(0.99);
}

@media (prefers-reduced-motion: reduce) {
  .desktop-model-picker-caret {
    transition: color 120ms ease;
  }

  .desktop-model-picker[data-open="true"] .desktop-model-picker-caret {
    transform: translateY(-50%);
  }

  .desktop-model-picker-options-enter-active,
  .desktop-model-picker-options-leave-active {
    transition: opacity 120ms ease;
  }

  .desktop-model-picker-options-enter-from,
  .desktop-model-picker-options-leave-to {
    transform: none;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .desktop-model-picker-popover {
    background: #141414;
  }
}
</style>
