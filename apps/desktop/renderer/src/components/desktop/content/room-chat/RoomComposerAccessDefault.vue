<template>
  <span ref="root" class="desktop-composer-access-wrap" data-testid="desktop-composer-access-default">
    <button
      ref="trigger"
      class="desktop-composer-access"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="open ? menuId : undefined"
      :aria-label="`Access for agents you start in this room: ${current.label}. Change`"
      :data-high="current.high || undefined"
      :disabled="disabled"
      data-testid="desktop-composer-access-button"
      @click="toggle($event)"
    >
      <ShieldCheck :size="14" aria-hidden="true" />
      <b>{{ current.label }}</b>
      <ChevronUp class="desktop-composer-access-caret" :size="12" aria-hidden="true" />
    </button>
    <div
      v-if="open && confirming"
      :id="menuId"
      ref="menu"
      class="desktop-composer-agent-menu desktop-composer-access-menu"
      role="alertdialog"
      aria-modal="false"
      :aria-labelledby="`${menuId}-title`"
      :aria-describedby="`${menuId}-detail`"
      data-testid="desktop-composer-access-confirm"
      @keydown="handleMenuKey"
      @pointermove="focusUnderPointer"
    >
      <div class="desktop-composer-access-confirm">
        <h4 :id="`${menuId}-title`">Start your agents with {{ confirming.label }}?</h4>
        <div :id="`${menuId}-detail`">
          <p>{{ confirming.detail }}</p>
          <p>This applies to agents you start in {{ roomHandle }}. Other people's agents and agents already running keep their access.</p>
        </div>
        <div class="desktop-composer-access-confirm-actions">
          <button type="button" tabindex="-1" data-item="cancel" data-testid="desktop-composer-access-cancel" @click="cancelConfirm">Cancel</button>
          <button type="button" tabindex="-1" data-item="confirm" class="desktop-composer-access-danger" data-testid="desktop-composer-access-ok"
            @click="apply(confirming.id)">Use {{ confirming.label }}</button>
        </div>
      </div>
    </div>
    <div
      v-else-if="open"
      :id="menuId"
      ref="menu"
      class="desktop-composer-agent-menu desktop-composer-access-menu"
      role="menu"
      aria-label="Access for your agents"
      :data-animate="animate || undefined"
      data-testid="desktop-composer-access-menu"
      @keydown="handleMenuKey"
      @pointermove="focusUnderPointer"
    >
      <div class="desktop-composer-agent-menu-head" role="presentation">Your agents in this room start with</div>
      <button
        v-for="(level, index) in PERSONAL_ACCESS_LEVELS"
        :key="level.id"
        type="button"
        role="menuitemradio"
        tabindex="-1"
        class="desktop-composer-agent-menu-item desktop-composer-agent-pick"
        :aria-checked="level.id === modelValue"
        :data-item="level.id"
        @click="choose(level.id)"
      >
        <span class="desktop-composer-agent-menu-label">{{ level.label }}</span>
        <Check v-if="level.id === modelValue" class="desktop-composer-agent-tick" :size="15" aria-hidden="true" />
        <span class="desktop-composer-agent-menu-end">{{ index + 1 }}</span>
      </button>
      <div class="desktop-composer-add-menu-separator" role="separator"></div>
      <p class="desktop-composer-agent-menu-note" role="presentation">Only for agents you start. Other people's agents are not affected.</p>
    </div>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronUp, ShieldCheck } from "@lucide/vue";
import type { DesktopManagedAgentPermissionProfileId } from "../../../../../../electron/ipc-types";
import {
  PERSONAL_ACCESS_LEVELS,
  accessChangeNeedsConfirmation,
  personalAccessLevel,
  type PersonalAccessLevel,
} from "./composer-agent-access";

const props = defineProps<{
  modelValue: DesktopManagedAgentPermissionProfileId;
  roomHandle: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [access: DesktopManagedAgentPermissionProfileId];
  /** The menu closed from inside; the composer takes focus back. */
  dismiss: [];
}>();

const menuId = `desktop-composer-access-menu-${Math.random().toString(36).slice(2, 10)}`;
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const animate = ref(false);
const confirming = ref<PersonalAccessLevel | null>(null);
const current = computed(() => personalAccessLevel(props.modelValue));

function toggle(event: MouseEvent): void {
  if (open.value) {
    closeMenu();
    return;
  }
  confirming.value = null;
  animate.value = event.detail !== 0 && !prefersReducedMotion();
  open.value = true;
  void nextTick(() => focusItem(props.modelValue));
}

function closeMenu(): void {
  open.value = false;
  animate.value = false;
  confirming.value = null;
}

/** A higher level asks first; a lower one applies at once. */
function choose(id: DesktopManagedAgentPermissionProfileId): void {
  if (accessChangeNeedsConfirmation(props.modelValue, id)) {
    confirming.value = personalAccessLevel(id);
    void nextTick(() => focusItem("cancel"));
    return;
  }
  apply(id);
}

function apply(id: DesktopManagedAgentPermissionProfileId): void {
  if (id !== props.modelValue) emit("update:modelValue", id);
  closeMenu();
  emit("dismiss");
}

function cancelConfirm(): void {
  const id = confirming.value?.id;
  confirming.value = null;
  void nextTick(() => focusItem(id ?? props.modelValue));
}

function items(): HTMLElement[] {
  return Array.from(menu.value?.querySelectorAll<HTMLElement>("[data-item]") ?? []);
}

function focusItem(item: string): void {
  const element = items().find((candidate) => candidate.dataset.item === item) ?? items()[0];
  if (element && typeof document !== "undefined" && document.activeElement !== element) element.focus({ preventScroll: true });
}

function focusUnderPointer(event: PointerEvent): void {
  const item = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-item]");
  if (item?.dataset.item && document.activeElement !== item) item.focus({ preventScroll: true });
}

function handleMenuKey(event: KeyboardEvent): void {
  const list = items();
  const index = list.indexOf(event.target as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length];
    if (next?.dataset.item) focusItem(next.dataset.item);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (confirming.value) cancelConfirm();
    else {
      closeMenu();
      emit("dismiss");
    }
  } else if (!confirming.value && /^[1-9]$/.test(event.key)) {
    const level = PERSONAL_ACCESS_LEVELS[Number(event.key) - 1];
    if (!level) return;
    event.preventDefault();
    choose(level.id);
  }
}

function closeOnOutsidePointer(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) closeMenu();
}
function closeOnEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || menu.value?.contains(event.target as Node)) return;
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
onBeforeUnmount(() => setDocumentListeners(false));

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

defineExpose({ close: closeMenu, isOpen: () => open.value });
</script>
