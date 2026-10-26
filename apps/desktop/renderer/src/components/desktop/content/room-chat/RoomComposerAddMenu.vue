<template>
  <span ref="root" class="desktop-composer-add-wrap" data-testid="desktop-composer-add-agent">
    <button
      ref="trigger"
      class="desktop-composer-add-agent"
      type="button"
      :disabled="disabled"
      :title="disabled ? 'Choose a room before adding to a message' : 'Add to message'"
      :aria-label="disabled ? 'Choose a room before adding to a message' : 'Add to message'"
      :aria-expanded="open"
      :aria-controls="open ? menuId : undefined"
      aria-haspopup="menu"
      data-testid="desktop-composer-add-agent-button"
      @click="toggle($event)"
      @keydown="handleTriggerKey"
    >
      <Plus :size="18" aria-hidden="true" />
    </button>
    <div
      v-if="open"
      :id="menuId"
      ref="menu"
      class="desktop-composer-add-menu"
      :class="{ 'has-flyout': flyout && flyoutNarrow }"
      role="menu"
      aria-label="Add to message"
      :data-animate="animate || undefined"
      data-testid="desktop-composer-add-menu"
      @keydown="handleMenuKey"
    >
      <template v-for="item in items" :key="item.id">
        <div v-if="item.separatorBefore" class="desktop-composer-add-menu-separator" role="separator"></div>
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="desktop-composer-add-menu-item"
          :disabled="item.disabled"
          :aria-haspopup="item.opensDialog ? 'dialog' : undefined"
          :aria-expanded="item.id === flyout ? true : item.id === 'gif' ? false : undefined"
          :data-open="item.id === flyout || undefined"
          :aria-keyshortcuts="item.keyShortcuts"
          :data-item="item.id"
          :data-testid="item.testid"
          @click="choose(item, $event.detail !== 0)"
          @pointermove="focusItem($event.currentTarget as HTMLElement)"
        >
          <component :is="item.icon" class="desktop-composer-add-menu-icon" :size="16" aria-hidden="true" />
          <span class="desktop-composer-add-menu-label">{{ item.label }}</span>
          <ChevronRight v-if="item.opensDialog" class="desktop-composer-add-menu-end" :size="14" aria-hidden="true" />
          <kbd v-else-if="item.hint" class="desktop-composer-add-menu-end">{{ item.hint }}</kbd>
        </button>
      </template>
    </div>
    <!-- GIFs open beside the menu; where there is no room beside it, over it with a Back row. -->
    <div
      v-if="open && flyout === 'gif'"
      ref="flyoutElement"
      class="desktop-composer-add-flyout"
      :class="{ 'is-narrow': flyoutNarrow }"
      :data-animate="flyoutAnimate || undefined"
    >
      <button v-if="flyoutNarrow" type="button" class="desktop-composer-add-menu-item desktop-composer-add-back" @click="backToMenu">
        <ChevronLeft class="desktop-composer-add-menu-icon" :size="16" aria-hidden="true" />
        <span class="desktop-composer-add-menu-label">Back</span>
      </button>
      <slot name="gif" :initial-query="flyoutQuery" :back="backToMenu" />
    </div>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type Component } from "vue";
import { Bot, ChevronLeft, ChevronRight, ImagePlay, ListTodo, Paperclip, Plus } from "@lucide/vue";
import { isMacPlatform } from "../../../../domain/room-switcher-shortcut";

export type RoomComposerAddMenuItemId = "attach" | "gif" | "task" | "agent";

interface MenuItem {
  id: RoomComposerAddMenuItemId;
  label: string;
  icon: Component;
  testid: string;
  disabled?: boolean;
  opensDialog?: boolean;
  separatorBefore?: boolean;
  hint?: string;
  keyShortcuts?: string;
}

const props = defineProps<{
  disabled: boolean;
  attachDisabled: boolean;
  gifAvailable: boolean;
  gifDisabled: boolean;
}>();

const emit = defineEmits<{
  select: [item: RoomComposerAddMenuItemId];
  /** The menu closed from inside (Escape); the composer takes focus back. */
  dismiss: [];
}>();

const mac = isMacPlatform();
const menuId = `desktop-composer-add-menu-${Math.random().toString(36).slice(2, 10)}`;
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const flyoutElement = ref<HTMLElement | null>(null);
/** The surface open beside the menu. Only GIF has one here. */
const flyout = ref<"gif" | null>(null);
const flyoutQuery = ref("");
const flyoutNarrow = ref(false);
const flyoutAnimate = ref(false);
// The menu is 268px wide; the GIF panel, 340px, sits 6px to its right.
const FLYOUT_SPAN_PX = 268 + 6 + 340 + 8;
// Only a pointer-opened menu grows out of "+"; a keyboard-opened one appears at once.
const animate = ref(false);

const items = computed<MenuItem[]>(() => [
  { id: "attach", label: "Attach files…", icon: Paperclip, testid: "desktop-composer-attach", disabled: props.attachDisabled,
    hint: mac ? "⌘U" : "Ctrl+U", keyShortcuts: mac ? "Meta+U" : "Control+U" },
  ...(props.gifAvailable
    ? [{ id: "gif", label: "GIF", icon: ImagePlay, testid: "desktop-composer-menu-gif", disabled: props.gifDisabled, opensDialog: true } satisfies MenuItem]
    : []),
  { id: "task", label: "Create task…", icon: ListTodo, testid: "desktop-composer-menu-task", separatorBefore: true, hint: "/task" },
  { id: "agent", label: "Add agent", icon: Bot, testid: "desktop-composer-menu-add-agent", opensDialog: true },
]);

/** A click with detail 0 came from the keyboard (Enter or Space on the button). */
function toggle(event: MouseEvent): void {
  if (open.value) closeMenu();
  else openMenu(event.detail !== 0);
}

function openMenu(byPointer: boolean, focusLast = false): void {
  if (props.disabled) return;
  animate.value = byPointer && !prefersReducedMotion();
  open.value = true;
  void nextTick(() => {
    const enabled = enabledItems();
    (focusLast ? enabled.at(-1) : enabled[0])?.focus({ preventScroll: true });
  });
}

function closeMenu(): void {
  open.value = false;
  animate.value = false;
  flyout.value = null;
}

/** Open GIFs beside the menu, opening the menu first when needed (for `/gif <query>`). */
function openGif(query = "", byPointer = false): void {
  if (props.disabled || props.gifDisabled || !props.gifAvailable) return;
  if (!open.value) animate.value = false;
  open.value = true;
  flyoutQuery.value = query;
  flyoutAnimate.value = byPointer && !prefersReducedMotion();
  const left = root.value?.getBoundingClientRect?.().left ?? 0;
  flyoutNarrow.value = typeof window !== "undefined" && left + FLYOUT_SPAN_PX > window.innerWidth;
  if (flyout.value === "gif") {
    // Already open: a new query starts a fresh panel; otherwise just return to its search box.
    if (query) flyout.value = null;
    else return focusFlyout();
  }
  void nextTick(() => {
    flyout.value = "gif";
    focusFlyout();
  });
}

function focusFlyout(): void {
  void nextTick(() => flyoutElement.value?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true }));
}

function backToMenu(): void {
  flyout.value = null;
  void nextTick(() => menu.value?.querySelector<HTMLElement>('[data-item="gif"]')?.focus({ preventScroll: true }));
}

function choose(item: MenuItem, byPointer = false): void {
  if (item.disabled) return;
  if (item.id === "gif") {
    openGif("", byPointer);
    return;
  }
  closeMenu();
  emit("select", item.id);
}

function enabledItems(): HTMLElement[] {
  return Array.from(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
}

function focusItem(element: HTMLElement): void {
  if (!(element as HTMLButtonElement).disabled && typeof document !== "undefined" && document.activeElement !== element) {
    element.focus({ preventScroll: true });
  }
}

function handleTriggerKey(event: KeyboardEvent): void {
  if (open.value || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
  event.preventDefault();
  openMenu(false, event.key === "ArrowUp");
}

function handleMenuKey(event: KeyboardEvent): void {
  const enabled = enabledItems();
  const index = enabled.indexOf(event.target as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!enabled.length) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    enabled[(index + step + enabled.length) % enabled.length]?.focus({ preventScroll: true });
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    (event.key === "Home" ? enabled[0] : enabled.at(-1))?.focus({ preventScroll: true });
  } else if (event.key === "ArrowRight") {
    // The rows with "›" open their own surface; Right opens it like Enter does.
    const item = items.value.find(candidate => candidate.id === (event.target as HTMLElement).dataset?.item);
    if (item?.opensDialog) {
      event.preventDefault();
      choose(item);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    emit("dismiss");
  }
  // Tab moves focus as usual; the menu stays open until a click outside or Escape.
}

// Outside the menu, only a click elsewhere or Escape closes it. Hover never opens or closes it.
function closeOnOutsidePointer(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) closeMenu();
}
// Escape spent on closing the menu does nothing else, such as dismissing a suggestion.
function closeOnEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || menu.value?.contains(event.target as Node) || flyoutElement.value?.contains(event.target as Node)) return;
  event.preventDefault();
  closeMenu();
}
function setDocumentListeners(listening: boolean): void {
  if (typeof document === "undefined") return;
  const method = listening ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", closeOnOutsidePointer as EventListener, true);
  document[method]("keydown", closeOnEscape as EventListener, true);
}
watch(open, setDocumentListeners);
watch(() => props.disabled, (disabled) => { if (disabled) closeMenu(); });
watch(() => props.gifDisabled || !props.gifAvailable, (off) => { if (off && flyout.value === "gif") flyout.value = null; });
onBeforeUnmount(() => setDocumentListeners(false));

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

defineExpose({ close: closeMenu, isOpen: () => open.value, openGif });
</script>
