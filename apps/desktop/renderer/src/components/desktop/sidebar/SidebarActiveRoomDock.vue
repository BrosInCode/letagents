<template>
  <Transition name="sidebar-active-dock">
    <button
      v-if="edge"
      :key="edge"
      class="sidebar-active-dock"
      type="button"
      :data-edge="edge"
      :style="edge === 'top' ? { top: `${top}px` } : undefined"
      :aria-label="`Show ${parentTitle ? `${parentTitle}, ${title}` : title}, the open room, in the list`"
      data-testid="sidebar-active-room-dock"
      @click="$emit('reveal')"
    >
      <span class="sidebar-active-dock-row">
        <span class="sidebar-active-dock-icon" aria-hidden="true">
          <GitBranch v-if="kind === 'branch'" /><MessageSquare v-else-if="kind === 'focus'" /><FolderOpen v-else />
        </span>
        <span class="sidebar-active-dock-title">
          <template v-if="parentTitle">
            <span class="sidebar-active-dock-parent">{{ parentTitle }}</span>
            <ChevronRight class="sidebar-active-dock-separator" aria-hidden="true" />
          </template>
          <span class="sidebar-active-dock-name">{{ title }}</span>
        </span>
        <span class="sidebar-active-dock-arrow" aria-hidden="true"><ArrowUp v-if="edge === 'top'" /><ArrowDown v-else /></span>
      </span>
    </button>
  </Transition>
</template>

<script setup lang="ts">
import { ArrowDown, ArrowUp, ChevronRight, FolderOpen, GitBranch, MessageSquare } from "@lucide/vue";
import type { SidebarDockEdge } from "../../../domain/sidebar-active-dock";
import type { RoomEntry } from "../types";

defineProps<{
  edge: SidebarDockEdge | null;
  /** The room list's top inside the navigation, where a top dock sits. */
  top: number;
  title: string;
  /** The project name when the open room is a branch or focus room. */
  parentTitle: string | null;
  kind: RoomEntry["kind"];
}>();

defineEmits<{ reveal: [] }>();
</script>

<style scoped>
/* A copy of the open room's row that waits at the list edge the row left by. */
.sidebar-active-dock {
  position: absolute;
  z-index: 4;
  right: 0;
  left: 0;
  display: block;
  padding: 4px 0;
  border: 0;
  background: var(--workspace-sidebar, var(--bg));
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sidebar-active-dock[data-edge="top"] {
  box-shadow: 0 10px 12px -12px light-dark(rgb(0 0 0 / 0.25), rgb(0 0 0 / 0.9));
}

.sidebar-active-dock[data-edge="bottom"] {
  bottom: 0;
  box-shadow: 0 -10px 12px -12px light-dark(rgb(0 0 0 / 0.25), rgb(0 0 0 / 0.9));
}

/* The same raised surface and edge marker as the open row in the list. */
.sidebar-active-dock-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 0 10px 0 8px;
  border-radius: 7px;
  background: var(--sidebar-open-room-fill, color-mix(in srgb, var(--text) 12%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 9%, transparent);
  transition: background-color 120ms ease, transform 120ms var(--ease-out);
}

.sidebar-active-dock-row::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 0;
  width: 3px;
  height: 16px;
  border-radius: 0 3px 3px 0;
  background: var(--text);
  transform: translateY(-50%);
}

.sidebar-active-dock:active .sidebar-active-dock-row {
  transform: scale(0.985);
}

.sidebar-active-dock:focus-visible {
  outline: none;
}

.sidebar-active-dock:focus-visible .sidebar-active-dock-row {
  outline: 2px solid color-mix(in srgb, var(--text) 28%, transparent);
  outline-offset: -2px;
}

.sidebar-active-dock-icon {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--text);
}

.sidebar-active-dock-icon svg {
  width: 16px;
  height: 16px;
  stroke-width: 1.75;
}

.sidebar-active-dock-title {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 0.8125rem;
  line-height: 1.3;
  white-space: nowrap;
}

/* The open room's name keeps its width; the project name gives way first. */
.sidebar-active-dock-parent {
  flex: 0 1 auto;
  min-width: 1.6em;
  max-width: 45%;
  overflow: hidden;
  color: var(--text-secondary);
  font-weight: 500;
  text-overflow: ellipsis;
}

.sidebar-active-dock-separator {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

/* No shrinking here: a sub-pixel shrink alone showed "Modern Daem…". */
.sidebar-active-dock-name {
  flex: 0 0 auto;
  max-width: calc(100% - 1.6em - 20px);
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-weight: 600;
  text-overflow: ellipsis;
}

.sidebar-active-dock-title:not(:has(.sidebar-active-dock-parent)) .sidebar-active-dock-name {
  max-width: 100%;
}

.sidebar-active-dock-arrow {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.sidebar-active-dock-arrow svg {
  width: 14px;
  height: 14px;
  stroke-width: 2;
}

@media (hover: hover) and (pointer: fine) {
  .sidebar-active-dock:hover .sidebar-active-dock-row {
    background: color-mix(in srgb, var(--text) 15%, transparent);
  }
}

/* Enters from the edge the row left by; leaves faster. Reduced motion keeps the fade. */
.sidebar-active-dock-enter-active {
  transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out);
}

.sidebar-active-dock-leave-active {
  transition: opacity 110ms ease, transform 110ms ease;
}

.sidebar-active-dock[data-edge="top"].sidebar-active-dock-enter-from,
.sidebar-active-dock[data-edge="top"].sidebar-active-dock-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.sidebar-active-dock[data-edge="bottom"].sidebar-active-dock-enter-from,
.sidebar-active-dock[data-edge="bottom"].sidebar-active-dock-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-active-dock[data-edge].sidebar-active-dock-enter-from,
  .sidebar-active-dock[data-edge].sidebar-active-dock-leave-to {
    transform: none;
  }

  .sidebar-active-dock-row {
    transition: none;
  }
}
</style>
