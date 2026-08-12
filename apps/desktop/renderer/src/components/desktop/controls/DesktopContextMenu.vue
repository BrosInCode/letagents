<template>
  <Teleport to="body">
    <div
      ref="menuElement"
      class="desktop-context-menu"
      role="menu"
      :style="menuStyle"
      :data-testid="testid"
      @click.stop
      @pointerdown.stop
      @contextmenu.prevent.stop
      @keydown.down.prevent="moveFocus(1)"
      @keydown.up.prevent="moveFocus(-1)"
    >
      <p v-if="title" class="desktop-context-menu-title">{{ title }}</p>
      <template v-for="(group, groupIndex) in itemGroups" :key="groupIndex">
        <div v-if="groupIndex > 0" class="desktop-context-menu-separator" role="separator"></div>
        <button
          v-for="item in group"
          :key="item.id"
          type="button"
          role="menuitem"
          :data-danger="item.danger || undefined"
          :data-testid="`${testid}-item-${item.id}`"
          :disabled="item.disabled"
          @click="selectItem(item)"
        >
          <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
          <span v-else class="desktop-context-menu-icon-spacer" aria-hidden="true"></span>
          <span>{{ item.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";

export type DesktopContextMenuItem = {
  id: string;
  label: string;
  icon?: Component;
  danger?: boolean;
  disabled?: boolean;
};

const props = defineProps<{
  itemGroups: DesktopContextMenuItem[][];
  position: { x: number; y: number };
  title?: string | null;
  testid?: string;
}>();

const emit = defineEmits<{
  select: [item: DesktopContextMenuItem];
  close: [];
}>();

const viewportMargin = 10;
const menuElement = ref<HTMLElement | null>(null);
const clampedPosition = ref<{ x: number; y: number } | null>(null);
let invokerElement: HTMLElement | null = null;

const menuStyle = computed(() => ({
  left: `${(clampedPosition.value || props.position).x}px`,
  top: `${(clampedPosition.value || props.position).y}px`,
  visibility: clampedPosition.value ? undefined : "hidden" as const,
}));

function selectItem(item: DesktopContextMenuItem): void {
  emit("select", item);
  emit("close");
}

function moveFocus(direction: 1 | -1): void {
  const buttons = [...(menuElement.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
  if (!buttons.length) return;
  const activeIndex = buttons.findIndex((button) => button === document.activeElement);
  const nextIndex = activeIndex < 0
    ? (direction === 1 ? 0 : buttons.length - 1)
    : (activeIndex + direction + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
}

function clampToViewport(): void {
  const menu = menuElement.value;
  if (!menu) return;
  const bounds = menu.getBoundingClientRect();
  clampedPosition.value = {
    x: Math.max(viewportMargin, Math.min(props.position.x, window.innerWidth - bounds.width - viewportMargin)),
    y: Math.max(viewportMargin, Math.min(props.position.y, window.innerHeight - bounds.height - viewportMargin)),
  };
}

function handleGlobalClose(): void {
  emit("close");
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

watch(
  () => props.position,
  async () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !menuElement.value?.contains(active)) {
      invokerElement = active;
    }
    clampedPosition.value = null;
    await nextTick();
    clampToViewport();
    await nextTick();
    menuElement.value?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener("pointerdown", handleGlobalClose);
  window.addEventListener("blur", handleGlobalClose);
  window.addEventListener("resize", handleGlobalClose);
  window.addEventListener("keydown", handleGlobalKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", handleGlobalClose);
  window.removeEventListener("blur", handleGlobalClose);
  window.removeEventListener("resize", handleGlobalClose);
  window.removeEventListener("keydown", handleGlobalKeydown);
  // Return focus to the invoking element on Escape/outside dismissal — but
  // not when the dismissing interaction already focused another control.
  const active = document.activeElement;
  const focusIsOrphaned = !active || active === document.body || menuElement.value?.contains(active);
  if (focusIsOrphaned && invokerElement?.isConnected) {
    invokerElement.focus();
  }
});
</script>
