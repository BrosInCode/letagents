<template>
  <aside v-if="sidebarMode !== 'hidden'" class="app-sidebar" data-testid="desktop-sidebar">
    <div class="sidebar-topbar">
      <button
        class="sidebar-collapse-button"
        type="button"
        :aria-label="sidebarMode === 'expanded' ? 'Collapse sidebar' : 'Hide sidebar'"
        :title="sidebarMode === 'expanded' ? 'Collapse sidebar' : 'Hide sidebar'"
        data-testid="sidebar-cycle-button"
        @click="$emit('cycle-sidebar')"
      >
        <svg class="sidebar-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4.5 3.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
          <path d="M12.5 3.5v13" />
          <path d="m7.5 7.5 2.5 2.5-2.5 2.5" />
        </svg>
      </button>
      <button
        v-if="sidebarMode === 'expanded'"
        ref="searchButton"
        class="sidebar-search-button"
        type="button"
        :data-active="searchOpen"
        :aria-expanded="searchOpen"
        aria-controls="sidebar-room-search"
        :aria-label="searchOpen ? 'Close room search' : 'Search rooms'"
        :title="searchOpen ? 'Close room search' : 'Search rooms'"
        data-testid="sidebar-search-button"
        @click="toggleSearch"
      >
        <X v-if="searchOpen" aria-hidden="true" />
        <Search v-else aria-hidden="true" />
      </button>
    </div>

    <section
      v-if="sidebarMode === 'expanded' && searchOpen"
      id="sidebar-room-search"
      class="sidebar-room-search"
      data-testid="sidebar-room-search"
    >
        <label class="sidebar-search-field">
          <Search aria-hidden="true" />
          <input
            ref="searchInput"
            v-model="searchQuery"
            type="search"
            placeholder="Search rooms"
            autocomplete="off"
            spellcheck="false"
            role="combobox"
            aria-label="Search rooms"
            aria-autocomplete="list"
            :aria-controls="searchResults.length ? 'sidebar-room-search-results' : undefined"
            :aria-expanded="Boolean(searchResults.length)"
            :aria-activedescendant="activeSearchResultId"
            data-testid="sidebar-room-search-input"
            @keydown="handleSearchKeydown"
          />
        </label>

        <div class="sidebar-search-summary" aria-live="polite">
          <span>Rooms</span>
          <span v-if="searchQuery.trim()">{{ searchResults.length }}</span>
        </div>

        <div
          v-if="searchQuery.trim() && searchResults.length"
          id="sidebar-room-search-results"
          class="sidebar-search-results"
          role="listbox"
        >
          <button
            v-for="(result, index) in searchResults"
            :id="searchResultId(result.entry.id)"
            :key="result.entry.id"
            class="sidebar-search-result"
            type="button"
            role="option"
            tabindex="-1"
            :aria-selected="index === activeSearchIndex"
            :data-active="index === activeSearchIndex"
            :data-testid="`sidebar-search-result-${result.entry.id}`"
            @pointerenter="activeSearchIndex = index"
            @click="selectSearchResult(result.entry)"
          >
            <span class="sidebar-search-result-icon" aria-hidden="true">
              <GitBranch v-if="result.entry.kind === 'branch'" />
              <MessageSquare v-else-if="result.entry.kind === 'focus'" />
              <House v-else />
            </span>
            <span class="sidebar-search-result-copy">
              <strong>{{ result.entry.title }}</strong>
              <small>{{ result.context }}</small>
            </span>
            <span v-if="result.entry.hasUnread" class="room-unread-dot" aria-label="Unread messages"></span>
          </button>
        </div>
        <p v-else-if="searchQuery.trim()" class="sidebar-search-empty">
          No rooms match “{{ searchQuery.trim() }}”
        </p>
        <p v-else class="sidebar-search-empty">Search by room, branch, or task.</p>
    </section>

    <div v-else-if="sidebarMode === 'expanded'" class="sidebar-navigation" @contextmenu.prevent="openBackgroundContextMenu">
      <div class="sidebar-actions">
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
      </div>

      <div class="sidebar-room-sections">
      <section v-if="pinnedProjectEntries.length" class="sidebar-pinned-section" data-testid="sidebar-section-pinned">
        <button
          class="sidebar-section-header pinned-section-header"
          type="button"
          :aria-expanded="!pinnedCollapsed"
          aria-controls="sidebar-pinned-rooms"
          :data-collapsed="pinnedCollapsed"
          data-testid="sidebar-pinned-heading"
          @click="$emit('toggle-pinned-collapsed')"
        >
          <span class="sidebar-heading">Pinned</span>
          <span class="sidebar-section-meta">
            <span class="section-count">{{ pinnedProjectEntries.length }}</span>
            <span class="sidebar-section-arrow" :data-collapsed="pinnedCollapsed" aria-hidden="true">
              <ChevronRight />
            </span>
          </span>
        </button>
        <Transition name="sidebar-pinned-reveal">
          <div v-if="!pinnedCollapsed" id="sidebar-pinned-rooms" class="pinned-list">
          <article
            v-for="project in pinnedProjectEntries"
            :key="project.id"
            class="project-group pinned-project-group"
            :data-testid="`pinned-room-group-${project.id}`"
          >
            <div class="sidebar-project-row-shell">
              <button
                class="pinned-room"
                :aria-current="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id ? 'page' : undefined"
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
              </button>
              <button
                v-if="projectChildRooms(project).length"
                class="project-toggle"
                :data-collapsed="collapsedProjects[project.id]"
                type="button"
                :aria-label="`${collapsedProjects[project.id] ? 'Expand' : 'Collapse'} ${project.roomName}`"
                :aria-controls="projectChildListId(project.id)"
                :aria-expanded="!collapsedProjects[project.id]"
                :data-testid="`pinned-room-group-toggle-${project.id}`"
                @click="$emit('toggle-project', project.id)"
                @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>

            <Transition name="sidebar-reveal">
              <div
                v-if="!collapsedProjects[project.id] && projectChildRooms(project).length"
                :id="projectChildListId(project.id)"
                class="project-room-list"
              >
                <button
                  v-for="childRoom in projectChildRooms(project)"
                  :key="childRoom.id"
                  class="room-row room-focus"
                  :data-kind="childRoom.kind"
                  :data-active="activeEntry.id === childRoom.id"
                  :data-unread="childRoom.hasUnread"
                  :aria-current="activeEntry.id === childRoom.id ? 'page' : undefined"
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
        </Transition>
      </section>

        <section
          class="sidebar-section"
          :data-empty="!roomProjectEntries.length"
          data-testid="sidebar-section-rooms"
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
        <span class="sidebar-section-meta">
          <span class="section-count">{{ totalRoomCount }}</span>
          <span class="sidebar-section-arrow" :data-collapsed="roomsCollapsed" aria-hidden="true">
            <ChevronRight />
          </span>
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
            <div class="sidebar-project-row-shell">
              <button
                class="project-row"
                :aria-current="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id ? 'page' : undefined"
                :data-active="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id"
                :data-unread="project.parent.hasUnread"
                type="button"
                :data-testid="`room-parent-${project.parent.id}`"
                @click="selectOrToggleProject(project)"
                @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
              >
                <span class="project-row-main">
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
                </span>
              </button>
              <button
                v-if="projectChildRooms(project).length"
                class="project-toggle"
                :data-collapsed="collapsedProjects[project.id]"
                type="button"
                :aria-label="`${collapsedProjects[project.id] ? 'Expand' : 'Collapse'} ${project.roomName}`"
                :aria-controls="projectChildListId(project.id)"
                :aria-expanded="!collapsedProjects[project.id]"
                :data-testid="`room-group-toggle-${project.id}`"
                @click="$emit('toggle-project', project.id)"
                @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>

            <Transition name="sidebar-reveal">
              <div
                v-if="!collapsedProjects[project.id] && projectChildRooms(project).length"
                :id="projectChildListId(project.id)"
                class="project-room-list"
              >
                <button
                  v-for="childRoom in projectChildRooms(project)"
                  :key="childRoom.id"
                  class="room-row room-focus"
                  :data-kind="childRoom.kind"
                  :data-active="activeEntry.id === childRoom.id"
                  :data-unread="childRoom.hasUnread"
                  :aria-current="activeEntry.id === childRoom.id ? 'page' : undefined"
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
      </div>
    </div>

    <div v-if="sidebarMode === 'expanded'" class="sidebar-footer">
      <button
        class="sidebar-row sidebar-settings-row"
        :data-active="activeEntry.id === settingsEntry.id || activeEntry.type === 'system'"
        :aria-current="activeEntry.id === settingsEntry.id || activeEntry.type === 'system' ? 'page' : undefined"
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
        :aria-current="activeEntry.id === settingsEntry.id || activeEntry.type === 'system' ? 'page' : undefined"
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
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  X,
} from "@lucide/vue";
import { computed, nextTick, ref, watch, type Component } from "vue";
import { copyTextToClipboard } from "../../../domain/clipboard";
import { buildLetAgentsRoomCopyValue } from "../../../domain/room-urls";
import { searchSidebarRooms } from "../../../domain/sidebar-room-search";
import {
  buildGitRoomWebUrl,
  buildSidebarBackgroundMenuItems,
  buildSidebarRoomContextMenuItems,
  type SidebarBackgroundMenuActionId,
  type SidebarRoomMenuActionId,
} from "../../../domain/sidebar-context-menu";
import DesktopContextMenu, { type DesktopContextMenuItem } from "../controls/DesktopContextMenu.vue";
import type { ProjectGroup, SidebarEntry, SidebarMode, SystemEntry, RoomEntry } from "../types";
import { desktopIpc } from "../../../ipc/index.js";

const props = defineProps<{
  sidebarMode: SidebarMode;
  activeEntry: SidebarEntry;
  primaryRoom: RoomEntry;
  projectEntries: ProjectGroup[];
  settingsEntry: SystemEntry;
  pinnedCollapsed: boolean;
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
  "toggle-pinned-collapsed": [];
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
const searchButton = ref<HTMLButtonElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const searchOpen = ref(false);
const searchQuery = ref("");
const activeSearchIndex = ref(0);

// The sidebar peek panel closes on pointerleave; it needs to know a menu is
// active (teleported outside the panel) so it can stay open underneath it.
watch(
  () => Boolean(roomContextMenu.value || backgroundContextMenu.value),
  (open) => emit("context-menu-open", open),
);

const pinnedProjectEntries = computed(() => props.projectEntries.filter((project) => project.parent.pinned));
const roomProjectEntries = computed(() => props.projectEntries.filter((project) => !project.parent.pinned));
const searchResults = computed(() => searchSidebarRooms(props.projectEntries, searchQuery.value));
const activeSearchResultId = computed(() => {
  const entry = searchResults.value[activeSearchIndex.value]?.entry;
  return entry ? searchResultId(entry.id) : undefined;
});

watch(searchResults, (results) => {
  activeSearchIndex.value = Math.min(activeSearchIndex.value, Math.max(0, results.length - 1));
});

watch(searchQuery, () => {
  activeSearchIndex.value = 0;
});

watch(() => props.sidebarMode, (mode) => {
  if (mode !== "expanded") resetSearch();
});

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
      if (url) void desktopIpc.app.openGitHubUrl(url);
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

function projectChildListId(projectId: string): string {
  return `sidebar-project-children-${encodeURIComponent(projectId)}`;
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

function toggleSearch(): void {
  if (searchOpen.value) closeSearch();
  else openSearch();
}

function openSearch(): void {
  searchOpen.value = true;
  activeSearchIndex.value = 0;
  void nextTick(() => searchInput.value?.focus());
}

function closeSearch(): void {
  resetSearch();
  void nextTick(() => searchButton.value?.focus());
}

function resetSearch(): void {
  searchOpen.value = false;
  searchQuery.value = "";
  activeSearchIndex.value = 0;
}

function handleSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
    return;
  }
  if (!searchResults.value.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    activeSearchIndex.value = (
      activeSearchIndex.value + offset + searchResults.value.length
    ) % searchResults.value.length;
    void nextTick(() => {
      const resultId = activeSearchResultId.value;
      if (resultId) document.getElementById(resultId)?.scrollIntoView({ block: "nearest" });
    });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const result = searchResults.value[activeSearchIndex.value];
    if (result) selectSearchResult(result.entry);
  }
}

function selectSearchResult(entry: RoomEntry): void {
  emit("select-entry", entry);
  closeSearch();
}

function searchResultId(entryId: string): string {
  return `sidebar-room-search-result-${encodeURIComponent(entryId)}`;
}

</script>
