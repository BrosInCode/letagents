<template>
  <aside v-if="sidebarMode !== 'hidden'" class="app-sidebar" data-testid="desktop-sidebar">
    <div class="sidebar-topbar">
      <button
        class="sidebar-collapse-button"
        type="button"
        :aria-label="sidebarMode === 'expanded' ? 'Collapse sidebar' : 'Hide sidebar'"
        data-testid="sidebar-cycle-button"
        @click="$emit('cycle-sidebar')"
      >
        <svg class="sidebar-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4.5 3.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
          <path d="M12.5 3.5v13" />
          <path d="m7.5 7.5 2.5 2.5-2.5 2.5" />
        </svg>
      </button>
    </div>

    <button
      v-if="sidebarMode === 'expanded'"
      class="sidebar-cta"
      type="button"
      data-testid="sidebar-new-room"
      @click="$emit('new-room')"
    >
      <span class="cta-plus" aria-hidden="true">
        <Plus />
      </span>
      <span>New room</span>
    </button>

    <section v-if="sidebarMode === 'expanded'" class="sidebar-section" data-testid="sidebar-section-rooms">
      <button
        class="sidebar-section-header"
        type="button"
        :aria-expanded="!roomsCollapsed"
        :data-collapsed="roomsCollapsed"
        data-testid="sidebar-rooms-heading"
        @click="$emit('toggle-rooms-collapsed')"
      >
        <span class="sidebar-heading">Rooms</span>
        <span class="section-count">{{ totalRoomCount }}</span>
        <span class="sidebar-section-arrow" :data-collapsed="roomsCollapsed" aria-hidden="true">
          <ChevronRight />
        </span>
      </button>
      <Transition name="sidebar-reveal">
        <div v-if="!roomsCollapsed" ref="projectListEl" class="project-list">
          <article
            v-for="project in projectEntries"
            :key="project.id"
            class="project-group"
            :data-testid="`room-group-${project.id}`"
          >
            <button
              class="project-row"
              :data-active="activeEntry.id === project.parent.id"
              type="button"
              :data-testid="`room-parent-${project.parent.id}`"
              @click="$emit('select-entry', project.parent)"
              @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
            >
              <div class="project-row-main">
                <span class="project-icon" aria-hidden="true">
                  <House />
                </span>
                <span class="project-copy">
                  <span class="project-name">{{ project.roomName }}</span>
                  <small>
                    {{ project.focusRooms.length ? `${project.focusRooms.length} focus ${project.focusRooms.length === 1 ? "room" : "rooms"}` : project.parent.meta }}
                  </small>
                </span>
              </div>
              <span
                v-if="project.focusRooms.length"
                class="project-open"
                :data-collapsed="collapsedProjects[project.id]"
                :data-testid="`room-group-toggle-${project.id}`"
                @click.stop="$emit('toggle-project', project.id)"
              >
                <ChevronRight aria-hidden="true" />
              </span>
            </button>

            <Transition name="sidebar-reveal">
              <div v-if="!collapsedProjects[project.id] && project.focusRooms.length" class="project-room-list">
                <button
                  v-for="focusRoom in project.focusRooms"
                  :key="focusRoom.id"
                  class="room-row room-focus"
                  :data-active="activeEntry.id === focusRoom.id"
                  type="button"
                  :data-testid="`focus-room-${focusRoom.id}`"
                  @click="$emit('select-entry', focusRoom)"
                  @contextmenu.prevent.stop="openRoomContextMenu($event, focusRoom)"
                >
                  <span class="room-status-dot" aria-hidden="true" />
                  <span class="room-title">{{ focusRoom.title }}</span>
                  <small class="room-meta">{{ focusRoom.meta }}</small>
                </button>
              </div>
            </Transition>
          </article>
        </div>
      </Transition>
    </section>

    <div v-if="sidebarMode === 'expanded'" class="sidebar-footer">
      <button
        class="sidebar-row sidebar-settings-row"
        :data-active="activeEntry.id === settingsEntry.id || activeEntry.type === 'system'"
        type="button"
        data-testid="sidebar-settings"
        @click="$emit('select-entry', settingsEntry)"
      >
        <span class="system-icon" aria-hidden="true">
          <Settings />
        </span>
        <span class="system-copy">
          <span>Settings</span>
          <small>Account, storage, setup</small>
        </span>
      </button>
    </div>

    <div v-else class="sidebar-collapsed-actions" data-testid="sidebar-rail">
      <button
        class="sidebar-icon-button"
        type="button"
        data-testid="rail-new-room"
        aria-label="New room"
        title="New room"
        @click="$emit('new-room')"
      >
        <Plus aria-hidden="true" />
      </button>
      <button
        class="sidebar-icon-button"
        :data-active="activeEntry.id === settingsEntry.id || activeEntry.type === 'system'"
        type="button"
        data-testid="rail-settings"
        aria-label="Settings"
        title="Settings"
        @click="$emit('select-entry', settingsEntry)"
      >
        <Settings aria-hidden="true" />
      </button>
    </div>

    <div
      v-if="roomContextMenu"
      class="sidebar-context-menu"
      role="menu"
      :style="{ left: `${roomContextMenu.x}px`, top: `${roomContextMenu.y}px` }"
      data-testid="sidebar-room-context-menu"
      @click.stop
      @contextmenu.prevent
    >
      <p class="sidebar-context-title">{{ roomContextMenu.entry.title }}</p>
      <button type="button" role="menuitem" @click="selectContextRoom">
        <House aria-hidden="true" />
        <span>Open room</span>
      </button>
      <button type="button" role="menuitem" :disabled="!roomContextMenu.entry.roomIdentifier" @click="copyContextRoomUrl">
        <Copy aria-hidden="true" />
        <span>Copy URL</span>
      </button>
      <button
        v-if="contextProject"
        type="button"
        role="menuitem"
        @click="toggleContextProject"
      >
        <ChevronRight aria-hidden="true" />
        <span>{{ collapsedProjects[contextProject.id] ? "Expand focus rooms" : "Collapse focus rooms" }}</span>
      </button>
      <button
        v-if="canArchiveContextRoom"
        type="button"
        role="menuitem"
        @click="archiveContextRoom"
      >
        <Archive aria-hidden="true" />
        <span>Archive room</span>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { Archive, ChevronRight, Copy, House, Plus, Settings } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ProjectGroup, SidebarEntry, SidebarMode, SystemEntry, RoomEntry } from "../types";

const props = defineProps<{
  sidebarMode: SidebarMode;
  activeEntry: SidebarEntry;
  primaryRoom: RoomEntry;
  projectEntries: ProjectGroup[];
  settingsEntry: SystemEntry;
  roomsCollapsed: boolean;
  collapsedProjects: Record<string, boolean>;
}>();

const emit = defineEmits<{
  "cycle-sidebar": [];
  "new-room": [];
  "archive-room": [entry: RoomEntry];
  "select-entry": [entry: SidebarEntry];
  "toggle-project": [projectId: string];
  "toggle-rooms-collapsed": [];
}>();

type RoomContextMenu = {
  entry: RoomEntry;
  projectId: string | null;
  x: number;
  y: number;
};

const roomContextMenu = ref<RoomContextMenu | null>(null);
const projectListEl = ref<HTMLElement | null>(null);

const totalRoomCount = computed(() =>
  props.projectEntries.reduce((total, project) => total + 1 + project.focusRooms.length, 0)
);

const firstProjectId = computed(() => props.projectEntries[0]?.id || null);

const contextProject = computed(() => {
  const projectId = roomContextMenu.value?.projectId;
  if (!projectId) return null;
  return props.projectEntries.find((project) => project.id === projectId && project.focusRooms.length) || null;
});

const canArchiveContextRoom = computed(() => {
  const entry = roomContextMenu.value?.entry;
  if (!entry || entry.kind !== "parent" || !entry.roomIdentifier) return false;
  return entry.id !== props.primaryRoom.id;
});

watch(
  firstProjectId,
  async (nextProjectId, previousProjectId) => {
    if (!nextProjectId || !previousProjectId || nextProjectId === previousProjectId) return;
    await nextTick();
    projectListEl.value?.scrollTo({ top: 0, behavior: "auto" });
  },
  { flush: "post" }
);

function openRoomContextMenu(event: MouseEvent, entry: RoomEntry, projectId: string | null = null): void {
  const menuWidth = 228;
  const hasProjectToggle = Boolean(projectId && props.projectEntries.find((project) => project.id === projectId)?.focusRooms.length);
  const menuHeight = hasProjectToggle ? 196 : entry.kind === "parent" ? 156 : 116;
  const sidebarRect = (event.currentTarget as HTMLElement | null)
    ?.closest(".app-sidebar")
    ?.getBoundingClientRect();
  const minX = sidebarRect ? sidebarRect.left + 10 : 10;
  const maxX = Math.max(minX, (sidebarRect?.right || window.innerWidth) - menuWidth - 10);
  roomContextMenu.value = {
    entry,
    projectId,
    x: Math.max(minX, Math.min(event.clientX, maxX)),
    y: Math.max(10, Math.min(event.clientY, window.innerHeight - menuHeight - 10)),
  };
}

function closeRoomContextMenu(): void {
  roomContextMenu.value = null;
}

function selectContextRoom(): void {
  if (!roomContextMenu.value) return;
  emit("select-entry", roomContextMenu.value.entry);
  closeRoomContextMenu();
}

function toggleContextProject(): void {
  const projectId = roomContextMenu.value?.projectId;
  if (!projectId) return;
  emit("toggle-project", projectId);
  closeRoomContextMenu();
}

function archiveContextRoom(): void {
  if (!roomContextMenu.value || !canArchiveContextRoom.value) return;
  emit("archive-room", roomContextMenu.value.entry);
  closeRoomContextMenu();
}

async function copyContextRoomUrl(): Promise<void> {
  const identifier = roomContextMenu.value?.entry.roomIdentifier;
  if (!identifier) return;
  try {
    await navigator.clipboard?.writeText(roomUrl(identifier));
  } finally {
    closeRoomContextMenu();
  }
}

function roomUrl(identifier: string): string {
  const value = identifier.trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
  return value;
}

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeRoomContextMenu();
}

onMounted(() => {
  window.addEventListener("click", closeRoomContextMenu);
  window.addEventListener("keydown", handleGlobalKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("click", closeRoomContextMenu);
  window.removeEventListener("keydown", handleGlobalKeydown);
});
</script>
