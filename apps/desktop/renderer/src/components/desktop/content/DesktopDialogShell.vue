<template>
  <div
    v-if="open"
    :class="backdropClass"
    :data-testid="testId"
    @click.self="requestClose"
  >
    <component
      :is="panelTag"
      ref="panelElement"
      :class="panelClass"
      :id="panelId"
      role="dialog"
      aria-modal="true"
      :aria-label="ariaLabel"
      :aria-labelledby="ariaLabelledby"
      tabindex="-1"
      @keydown.esc.stop.prevent="requestClose"
      @keydown.tab="handleTab"
      @submit="handleSubmit"
    >
      <button
        v-if="showClose"
        type="button"
        :class="closeClass"
        :aria-label="closeLabel"
        :disabled="closeDisabled"
        @click="requestClose"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
      </button>
      <slot :request-close="requestClose" />
    </component>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  currentFocusableElement,
  focusFirstElementInDialog,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";

const props = withDefaults(defineProps<{
  open: boolean;
  ariaLabel?: string;
  ariaLabelledby?: string;
  backdropClass?: string;
  panelClass?: string;
  panelId?: string;
  panelTag?: "div" | "section" | "form";
  closeClass?: string;
  closeLabel?: string;
  closeDisabled?: boolean;
  showClose?: boolean;
  initialFocus?: string;
  focusKey?: string | null;
  testId?: string;
}>(), {
  ariaLabel: undefined,
  ariaLabelledby: undefined,
  backdropClass: "desktop-task-modal-backdrop",
  panelClass: "desktop-task-modal",
  panelId: undefined,
  panelTag: "div",
  closeClass: "desktop-task-modal-close",
  closeLabel: "Close dialog",
  closeDisabled: false,
  showClose: true,
  initialFocus: undefined,
  focusKey: null,
  testId: undefined,
});

const emit = defineEmits<{
  close: [];
  submit: [event: Event];
}>();

const panelElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;

watch([() => props.open, () => props.focusKey], async ([open], previousValues) => {
  const wasOpen = previousValues?.[0] ?? false;
  if (open) {
    if (!wasOpen) previousFocusElement = currentFocusableElement();
    await nextTick();
    const initialElement = props.initialFocus
      ? panelElement.value?.querySelector<HTMLElement>(props.initialFocus)
      : null;
    if (initialElement) initialElement.focus({ preventScroll: true });
    else focusFirstElementInDialog(panelElement.value);
    return;
  }
  if (wasOpen) {
    await nextTick();
    restorePreviousFocus();
  }
}, { flush: "post", immediate: true });

onBeforeUnmount(restorePreviousFocus);

function requestClose(): void {
  if (!props.closeDisabled) emit("close");
}

function handleTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, panelElement.value);
}

function handleSubmit(event: Event): void {
  event.preventDefault();
  emit("submit", event);
}

function restorePreviousFocus(): void {
  restoreFocus(previousFocusElement);
  previousFocusElement = null;
}
</script>
