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

    <div
      v-if="sidebarMode === 'expanded'"
      class="sidebar-actions"
      @contextmenu.prevent="openBackgroundContextMenu"
    >
      <button
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

      <section v-if="pinnedProjectEntries.length" class="sidebar-pinned-section" data-testid="sidebar-section-pinned">
        <p class="pinned-section-label">Pinned</p>
        <div class="pinned-list">
          <article
            v-for="project in pinnedProjectEntries"
            :key="project.id"
            class="project-group pinned-project-group"
            :data-testid="`pinned-room-group-${project.id}`"
          >
            <button
              class="pinned-room"
              :data-active="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id"
              :data-unread="project.parent.hasUnread"
              type="button"
              :data-testid="`pinned-room-${project.parent.id}`"
              @click="selectOrToggleProject(project)"
              @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
            >
              <span class="pin-mark" aria-hidden="true">
                <Pin />
              </span>
              <span class="pinned-main">
                <span class="room-title-line">
                  <span class="pinned-title">{{ project.roomName }}</span>
                  <span
                    v-if="project.parent.hasUnread"
                    class="room-unread-dot"
                    aria-label="Unread messages"
                    title="Unread messages"
                  ></span>
                </span>
                <span class="pinned-meta">{{ projectSubtitle(project) }}</span>
              </span>
              <span
                v-if="projectChildRooms(project).length"
                class="project-open"
                :data-collapsed="collapsedProjects[project.id]"
                :data-testid="`pinned-room-group-toggle-${project.id}`"
                @click.stop="$emit('toggle-project', project.id)"
              >
                <ChevronRight aria-hidden="true" />
              </span>
            </button>

            <Transition name="sidebar-reveal">
              <div v-if="!collapsedProjects[project.id] && projectChildRooms(project).length" class="project-room-list">
                <button
                  v-for="childRoom in projectChildRooms(project)"
                  :key="childRoom.id"
                  class="room-row room-focus"
                  :data-kind="childRoom.kind"
                  :data-active="activeEntry.id === childRoom.id"
                  :data-unread="childRoom.hasUnread"
                  type="button"
                  :data-testid="`pinned-child-room-${childRoom.id}`"
                  @click="$emit('select-entry', childRoom)"
                  @contextmenu.prevent.stop="openRoomContextMenu($event, childRoom)"
                >
                  <span class="room-title-line">
                    <span class="room-title">{{ childRoom.title }}</span>
                    <span v-if="childRoom.currentWorkspace" class="room-workspace-pill">Current</span>
                    <span
                      v-if="childRoom.hasUnread"
                      class="room-unread-dot"
                      aria-label="Unread messages"
                      title="Unread messages"
                    ></span>
                  </span>
                  <small v-if="childRoom.meta" class="room-child-meta">{{ childRoom.meta }}</small>
                  <small
                    v-if="childRoom.suggestedAction && !childRoom.currentWorkspace"
                    class="room-suggested-action"
                  >
                    {{ childRoom.suggestedAction }}
                  </small>
                </button>
              </div>
            </Transition>
          </article>
        </div>
      </section>
    </div>

    <section
      v-if="sidebarMode === 'expanded'"
      class="sidebar-section"
      data-testid="sidebar-section-rooms"
      @contextmenu.prevent="openBackgroundContextMenu"
    >
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
        <div v-if="!roomsCollapsed" class="project-list">
          <article
            v-for="project in roomProjectEntries"
            :key="project.id"
            class="project-group"
            :data-testid="`room-group-${project.id}`"
          >
            <button
              class="project-row"
              :data-active="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id"
              :data-unread="project.parent.hasUnread"
              type="button"
              :data-testid="`room-parent-${project.parent.id}`"
              @click="selectOrToggleProject(project)"
              @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
            >
              <div class="project-row-main">
                <span class="project-icon" aria-hidden="true">
                  <House />
                </span>
                <span class="project-copy">
                  <span class="room-title-line">
                    <span class="project-name">{{ project.roomName }}</span>
                    <span
                      v-if="project.parent.hasUnread"
                      class="room-unread-dot"
                      aria-label="Unread messages"
                      title="Unread messages"
                    ></span>
                  </span>
                  <small>
                    {{ projectSubtitle(project) }}
                  </small>
                </span>
              </div>
              <span
                v-if="projectChildRooms(project).length"
                class="project-open"
                :data-collapsed="collapsedProjects[project.id]"
                :data-testid="`room-group-toggle-${project.id}`"
                @click.stop="$emit('toggle-project', project.id)"
              >
                <ChevronRight aria-hidden="true" />
              </span>
            </button>

            <Transition name="sidebar-reveal">
              <div v-if="!collapsedProjects[project.id] && projectChildRooms(project).length" class="project-room-list">
                <button
                  v-for="childRoom in projectChildRooms(project)"
                  :key="childRoom.id"
                  class="room-row room-focus"
                  :data-kind="childRoom.kind"
                  :data-active="activeEntry.id === childRoom.id"
                  :data-unread="childRoom.hasUnread"
                  type="button"
                  :data-testid="`child-room-${childRoom.id}`"
                  @click="$emit('select-entry', childRoom)"
                  @contextmenu.prevent.stop="openRoomContextMenu($event, childRoom)"
                >
                  <span class="room-title-line">
                    <span class="room-title">{{ childRoom.title }}</span>
                    <span v-if="childRoom.currentWorkspace" class="room-workspace-pill">Current</span>
                    <span
                      v-if="childRoom.hasUnread"
                      class="room-unread-dot"
                      aria-label="Unread messages"
                      title="Unread messages"
                    ></span>
                  </span>
                  <small v-if="childRoom.meta" class="room-child-meta">{{ childRoom.meta }}</small>
                  <small
                    v-if="childRoom.suggestedAction && !childRoom.currentWorkspace"
                    class="room-suggested-action"
                  >
                    {{ childRoom.suggestedAction }}
                  </small>
                </button>
              </div>
            </Transition>
          </article>
          <p v-if="!roomProjectEntries.length" class="room-empty">No other rooms</p>
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

    <DesktopContextMenu
      v-if="roomContextMenu"
      :item-groups="roomContextMenuItemGroups"
      :position="roomContextMenu"
      :title="roomContextMenu.entry.title"
      testid="sidebar-room-context-menu"
      @select="handleRoomContextMenuSelect"
      @close="closeRoomContextMenu"
    />
    <DesktopContextMenu
      v-if="backgroundContextMenu"
      :item-groups="backgroundContextMenuItemGroups"
      :position="backgroundContextMenu"
      testid="sidebar-background-context-menu"
      @select="handleBackgroundContextMenuSelect"
      @close="closeBackgroundContextMenu"
    />
  </aside>
</template>

<script setup lang="ts">
import {
  Archive,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  House,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
} from "@lucide/vue";
import { computed, ref, watch, type Component } from "vue";
import { copyTextToClipboard } from "../../../domain/clipboard";
import { buildLetAgentsRoomCopyValue } from "../../../domain/room-urls";
import {
  buildGitRoomWebUrl,
  buildSidebarBackgroundMenuItems,
  buildSidebarRoomContextMenuItems,
  type SidebarBackgroundMenuActionId,
  type SidebarRoomMenuActionId,
} from "../../../domain/sidebar-context-menu";
import DesktopContextMenu, { type DesktopContextMenuItem } from "../controls/DesktopContextMenu.vue";
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
  "context-menu-open": [open: boolean];
  "cycle-sidebar": [];
  "new-room": [];
  "archive-room": [entry: RoomEntry];
  "archive-focus-room": [entry: RoomEntry];
  "mark-room-read": [entry: RoomEntry];
  "pin-room": [entry: RoomEntry];
  "rename-room": [entry: RoomEntry];
  "select-entry": [entry: SidebarEntry];
  "set-projects-collapsed": [collapsed: boolean];
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
const backgroundContextMenu = ref<{ x: number; y: number } | null>(null);

// The sidebar peek panel closes on pointerleave; it needs to know a menu is
// active (teleported outside the panel) so it can stay open underneath it.
watch(
  () => Boolean(roomContextMenu.value || backgroundContextMenu.value),
  (open) => emit("context-menu-open", open),
);

const pinnedProjectEntries = computed(() => props.projectEntries.filter((project) => project.parent.pinned));
const roomProjectEntries = computed(() => props.projectEntries.filter((project) => !project.parent.pinned));

const totalRoomCount = computed(() =>
  roomProjectEntries.value.reduce((total, project) => total + 1 + projectChildRooms(project).length, 0)
);

const roomMenuIcons: Record<SidebarRoomMenuActionId, Component> = {
  "open-room": House,
  "mark-room-read": Check,
  "pin-room": Pin,
  "rename-room": Pencil,
  "copy-room-url": Copy,
  "copy-branch-name": GitBranch,
  "open-on-github": ExternalLink,
  "toggle-project": ChevronRight,
  "archive-focus-room": Archive,
  "archive-room": Archive,
};

function roomMenuGroupsFor(entry: RoomEntry, projectId: string | null): DesktopContextMenuItem[][] {
  const project = projectId
    ? props.projectEntries.find((candidate) => candidate.id === projectId && projectChildRooms(candidate).length)
    : null;
  return buildSidebarRoomContextMenuItems({
    entry,
    isPrimaryRoom: entry.id === props.primaryRoom.id,
    hasProjectChildren: Boolean(project),
    projectCollapsed: Boolean(project && props.collapsedProjects[project.id]),
  }).map((group) => group.map((item) => ({
    ...item,
    icon: item.id === "pin-room" && entry.pinned ? PinOff : roomMenuIcons[item.id],
  })));
}

const roomContextMenuItemGroups = computed<DesktopContextMenuItem[][]>(() => {
  const menu = roomContextMenu.value;
  return menu ? roomMenuGroupsFor(menu.entry, menu.projectId) : [];
});

const backgroundMenuIcons: Record<SidebarBackgroundMenuActionId, Component> = {
  "new-room": Plus,
  "set-projects-collapsed": ChevronRight,
};

const allProjectsCollapsed = computed(() =>
  props.projectEntries.every((project) =>
    !projectChildRooms(project).length || props.collapsedProjects[project.id]
  )
);

const backgroundContextMenuItemGroups = computed<DesktopContextMenuItem[][]>(() =>
  buildSidebarBackgroundMenuItems({
    hasProjects: props.projectEntries.some((project) => projectChildRooms(project).length > 0),
    allProjectsCollapsed: allProjectsCollapsed.value,
  }).map((group) => group.map((item) => ({ ...item, icon: backgroundMenuIcons[item.id] })))
);

function openRoomContextMenu(event: MouseEvent, entry: RoomEntry, projectId: string | null = null): void {
  backgroundContextMenu.value = null;
  roomContextMenu.value = roomMenuGroupsFor(entry, projectId).length
    ? { entry, projectId, x: event.clientX, y: event.clientY }
    : null;
}

function closeRoomContextMenu(): void {
  roomContextMenu.value = null;
}

function openBackgroundContextMenu(event: MouseEvent): void {
  roomContextMenu.value = null;
  backgroundContextMenu.value = { x: event.clientX, y: event.clientY };
}

function closeBackgroundContextMenu(): void {
  backgroundContextMenu.value = null;
}

function handleRoomContextMenuSelect(item: DesktopContextMenuItem): void {
  const menu = roomContextMenu.value;
  if (!menu) return;
  const actions: Record<SidebarRoomMenuActionId, () => void> = {
    "open-room": () => emit("select-entry", menu.entry),
    "mark-room-read": () => emit("mark-room-read", menu.entry),
    "pin-room": () => emit("pin-room", menu.entry),
    "rename-room": () => emit("rename-room", menu.entry),
    "copy-room-url": () =>
      void copyText(menu.entry.roomIdentifier ? buildLetAgentsRoomCopyValue(menu.entry.roomIdentifier) : null),
    "copy-branch-name": () => void copyText(menu.entry.gitRoom?.ref.name ?? null),
    "open-on-github": () => {
      const url = buildGitRoomWebUrl(menu.entry.gitRoom ?? null);
      if (url) void window.letagentsDesktop.app.openGitHubUrl(url);
    },
    "toggle-project": () => {
      if (menu.projectId) emit("toggle-project", menu.projectId);
    },
    "archive-focus-room": () => emit("archive-focus-room", menu.entry),
    "archive-room": () => emit("archive-room", menu.entry),
  };
  actions[item.id as SidebarRoomMenuActionId]?.();
}

function handleBackgroundContextMenuSelect(item: DesktopContextMenuItem): void {
  if (item.id === "new-room") {
    emit("new-room");
    return;
  }
  if (item.id === "set-projects-collapsed") {
    emit("set-projects-collapsed", !allProjectsCollapsed.value);
  }
}

async function copyText(value: string | null): Promise<void> {
  if (!value) return;
  await copyTextToClipboard(value);
}

function projectSubtitle(project: ProjectGroup): string {
  const branchCount = project.branchRooms.length;
  const focusCount = project.focusRooms.length;
  if (project.parent.gitRoom && branchCount) {
    const branchLabel = `${branchCount} ${branchCount === 1 ? "branch" : "branches"}`;
    const focusLabel = focusCount ? ` · ${focusCount} focus ${focusCount === 1 ? "room" : "rooms"}` : "";
    return `${project.parent.meta} · ${branchLabel}${focusLabel}`;
  }
  if (focusCount) {
    return `${focusCount} focus ${focusCount === 1 ? "room" : "rooms"}`;
  }
  return project.parent.meta;
}

function projectChildRooms(project: ProjectGroup | null | undefined): RoomEntry[] {
  if (!project) return [];
  return [...project.branchRooms, ...project.focusRooms];
}

function isSelectableRoom(entry: RoomEntry): boolean {
  return Boolean(entry.roomIdentifier);
}

function selectOrToggleProject(project: ProjectGroup): void {
  if (isSelectableRoom(project.parent)) {
    emit("select-entry", project.parent);
    return;
  }
  if (projectChildRooms(project).length) {
    emit("toggle-project", project.id);
  }
}

</script>
