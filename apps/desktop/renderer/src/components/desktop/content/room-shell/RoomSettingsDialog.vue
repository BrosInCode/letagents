<template>
  <Teleport to="body">
    <Transition name="room-settings-dialog" @after-leave="handleAfterLeave">
      <div
        v-if="open"
        class="room-settings-backdrop"
        data-testid="desktop-room-settings-dialog"
        @pointerdown="pressStartedOnBackdrop = $event.target === $event.currentTarget"
        @click.self="closeFromBackdrop"
      >
        <section
          ref="dialogElement"
          class="room-settings-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-room-settings-title"
          tabindex="-1"
        >
          <slot />
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  currentFocusableElement,
  focusFirstElementInDialog,
  restoreFocus,
  trapFocusInDialog,
} from "../modal-focus";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const dialogElement = ref<HTMLElement | null>(null);
const pressStartedOnBackdrop = ref(false);
let previousFocusElement: HTMLElement | null = null;

// A press that starts inside the dialog and ends on the backdrop, as when
// selecting text and overshooting, is not a request to close.
function closeFromBackdrop(): void {
  if (pressStartedOnBackdrop.value) emit("close");
  pressStartedOnBackdrop.value = false;
}

// Keys are handled for the whole document: a control that becomes disabled
// while focused hands focus to the page, and the dialog must still answer.
function handleKeydown(event: KeyboardEvent): void {
  if (!props.open || event.defaultPrevented || event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key !== "Tab") return;
  const dialog = dialogElement.value;
  const focused = currentFocusableElement();
  if (dialog && (!focused || !dialog.contains(focused))) {
    event.preventDefault();
    focusFirstElementInDialog(dialog);
    return;
  }
  trapFocusInDialog(event, dialog);
}

watch(() => props.open, (open) => {
  if (typeof document === "undefined") return;
  document.removeEventListener("keydown", handleKeydown);
  if (!open) return;
  document.addEventListener("keydown", handleKeydown);
  previousFocusElement = currentFocusableElement();
  void nextTick(() => dialogElement.value?.focus());
}, { immediate: true });

onBeforeUnmount(() => {
  if (typeof document !== "undefined") document.removeEventListener("keydown", handleKeydown);
});

function handleAfterLeave(): void {
  if (props.open) return;
  restoreFocus(previousFocusElement);
  previousFocusElement = null;
}
</script>
