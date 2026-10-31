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
          :role="item.role || 'menuitem'"
          :aria-checked="item.role === 'menuitemradio' ? item.checked : undefined"
          :aria-haspopup="item.children ? 'menu' : undefined"
          :aria-expanded="item.children ? submenu?.id === item.id : undefined"
          :data-menu-id="item.id"
          :data-danger="item.danger || undefined"
          :data-testid="`${testid}-item-${item.id}`"
          :disabled="item.disabled"
          @click="selectItem(item, $event.currentTarget as HTMLElement)"
          @keydown.right.prevent="openSubmenu(item, $event.currentTarget as HTMLElement)"
        >
          <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
          <span v-else class="desktop-context-menu-icon-spacer" aria-hidden="true"></span>
          <span>{{ item.label }}</span>
          <span v-if="item.children" aria-hidden="true">›</span>
        </button>
      </template>
    </div>
    <div
      v-if="submenu"
      ref="submenuElement"
      class="desktop-context-menu"
      role="menu"
      :aria-label="submenu.label"
      :style="submenuStyle"
      :data-testid="`${testid}-submenu`"
      @pointerdown.stop
      @click.stop
      @contextmenu.prevent.stop
      @keydown.down.prevent="moveSubmenuFocus(1)"
      @keydown.up.prevent="moveSubmenuFocus(-1)"
      @keydown.left.prevent="closeSubmenu"
    >
      <button
        v-for="item in submenu.children"
        :key="item.id"
        type="button"
        :role="item.role || 'menuitem'"
        :aria-checked="item.role === 'menuitemradio' ? item.checked : undefined"
        :disabled="item.disabled"
        :data-testid="`${testid}-item-${item.id}`"
        @click="selectItem(item)"
      >
        <component :is="item.icon" v-if="item.icon" aria-hidden="true" />
        <span v-else class="desktop-context-menu-icon-spacer" aria-hidden="true"></span>
        <span>{{ item.label }}</span>
      </button>
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
  role?: "menuitemradio";
  checked?: boolean;
  children?: Omit<DesktopContextMenuItem, "children">[];
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
const submenu = ref<DesktopContextMenuItem | null>(null);
const submenuElement = ref<HTMLElement | null>(null);
const submenuStyle = ref<{ left: string; top: string; visibility?: "hidden" }>({ left: "0px", top: "0px" });
let submenuInvoker: HTMLElement | null = null;

const menuStyle = computed(() => ({
  left: `${(clampedPosition.value || props.position).x}px`,
  top: `${(clampedPosition.value || props.position).y}px`,
  visibility: clampedPosition.value ? undefined : "hidden" as const,
}));

function selectItem(item: DesktopContextMenuItem, invoker?: HTMLElement): void {
  if (item.disabled) return;
  if (item.children) { void openSubmenu(item, invoker); return; }
  emit("select", item);
  emit("close");
}

async function openSubmenu(item: DesktopContextMenuItem, invoker?: HTMLElement): Promise<void> {
  if (!item.children?.length || item.disabled || !invoker) return;
  submenuInvoker = invoker;
  submenu.value = item;
  submenuStyle.value = { left: "0px", top: "0px", visibility: "hidden" };
  await nextTick();
  if (submenu.value?.id !== item.id || !submenuElement.value) return;
  const parent = invoker.getBoundingClientRect();
  const child = submenuElement.value.getBoundingClientRect();
  const x = parent.right + child.width + viewportMargin <= window.innerWidth ? parent.right : parent.left - child.width;
  submenuStyle.value = {
    left: `${Math.max(viewportMargin, x)}px`,
    top: `${Math.max(viewportMargin, Math.min(parent.top, window.innerHeight - child.height - viewportMargin))}px`,
  };
  submenuElement.value.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

function closeSubmenu(): void {
  submenu.value = null;
  submenuInvoker?.focus();
}

watch(() => props.itemGroups, (groups) => {
  if (submenu.value) submenu.value = groups.flat().find((item) => item.id === submenu.value?.id) ?? null;
});

function moveSubmenuFocus(direction: 1 | -1): void {
  const buttons = [...(submenuElement.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
  if (!buttons.length) return;
  const index = buttons.findIndex((button) => button === document.activeElement);
  buttons[(index + direction + buttons.length) % buttons.length]?.focus();
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
  if (event.key !== "Escape") return;
  if (submenu.value) { event.preventDefault(); closeSubmenu(); }
  else emit("close");
}

watch(
  () => props.position,
  async () => {
    submenu.value = null;
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
  const focusIsOrphaned = !active || active === document.body || menuElement.value?.contains(active) || submenuElement.value?.contains(active);
  if (focusIsOrphaned && invokerElement?.isConnected) {
    invokerElement.focus();
  }
});
</script>

<style scoped>
.desktop-context-menu button[aria-haspopup="menu"] {
  grid-template-columns: 17px minmax(0, 1fr) auto;
}
</style>
