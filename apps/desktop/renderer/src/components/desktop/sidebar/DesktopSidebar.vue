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
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M7 4.5 12.5 10 7 15.5"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.8"
          />
        </svg>
      </button>
    </div>

    <div v-if="sidebarMode === 'expanded'" class="sidebar-brand" data-testid="sidebar-brand">
      <h1>LetAgents</h1>
    </div>

    <button
      v-if="sidebarMode === 'expanded'"
      class="sidebar-cta"
      type="button"
      data-testid="sidebar-new-room"
      @click="$emit('new-room')"
    >
      <span class="cta-plus">+</span>
      <span>New room</span>
    </button>

    <section v-if="sidebarMode === 'expanded'" class="sidebar-section" data-testid="sidebar-section-pinned">
      <button
        class="section-toggle"
        type="button"
        data-testid="sidebar-toggle-pinned"
        @click="$emit('toggle-section', 'pinned')"
      >
        <span class="sidebar-heading">Pinned</span>
        <span class="toggle-glyph" :data-collapsed="collapsedSections.pinned">⌄</span>
      </button>
      <button
        v-if="!collapsedSections.pinned"
        class="pinned-room"
        :data-active="activeEntry.id === pinnedRoom.id"
        type="button"
        data-testid="sidebar-pinned-room"
        @click="$emit('select-entry', pinnedRoom)"
      >
        <div class="pin-mark">⌘</div>
        <span class="pinned-title">{{ pinnedRoom.title }}</span>
        <small class="pinned-meta">{{ pinnedRoom.meta }}</small>
      </button>
    </section>

    <section v-if="sidebarMode === 'expanded'" class="sidebar-section" data-testid="sidebar-section-rooms">
      <button
        class="section-toggle"
        type="button"
        data-testid="sidebar-toggle-rooms"
        @click="$emit('toggle-section', 'projects')"
      >
        <span class="sidebar-heading">Rooms</span>
        <span class="toggle-glyph" :data-collapsed="collapsedSections.projects">⌄</span>
      </button>
      <div v-if="!collapsedSections.projects" class="project-list">
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
          >
            <div class="project-row-main">
              <span class="project-icon">⌂</span>
              <span class="project-name">{{ project.roomName }}</span>
            </div>
            <span
              class="project-open"
              :data-collapsed="collapsedProjects[project.id]"
              :data-testid="`room-group-toggle-${project.id}`"
              @click.stop="$emit('toggle-project', project.id)"
            >
              ⌄
            </span>
          </button>

          <div v-if="!collapsedProjects[project.id]" class="project-room-list">
            <button
              v-for="focusRoom in project.focusRooms"
              :key="focusRoom.id"
              class="room-row room-focus"
              :data-active="activeEntry.id === focusRoom.id"
              type="button"
              :data-testid="`focus-room-${focusRoom.id}`"
              @click="$emit('select-entry', focusRoom)"
            >
              <span class="room-title">{{ focusRoom.title }}</span>
              <small class="room-meta">{{ focusRoom.meta }}</small>
            </button>

            <p v-if="!project.focusRooms.length" class="room-empty" data-testid="focus-room-empty">
              No focus rooms yet.
            </p>
          </div>
        </article>
      </div>
    </section>

    <section
      v-if="sidebarMode === 'expanded'"
      class="sidebar-section sidebar-system"
      data-testid="sidebar-section-system"
    >
      <button
        class="section-toggle"
        type="button"
        data-testid="sidebar-toggle-system"
        @click="$emit('toggle-section', 'system')"
      >
        <span class="sidebar-heading">System</span>
        <span class="toggle-glyph" :data-collapsed="collapsedSections.system">⌄</span>
      </button>
      <button
        v-for="item in !collapsedSections.system ? systemEntries : []"
        :key="item.id"
        class="sidebar-row"
        :data-active="activeEntry.id === item.id"
        type="button"
        :data-testid="`system-entry-${item.id}`"
        @click="$emit('select-entry', item)"
      >
        <span>{{ item.title }}</span>
        <small>{{ item.description }}</small>
      </button>
    </section>

    <div v-else class="sidebar-collapsed-actions" data-testid="sidebar-rail">
      <button class="sidebar-icon-button" type="button" data-testid="rail-new-room" @click="$emit('new-room')">
        +
      </button>
      <button
        class="sidebar-icon-button"
        :data-active="activeEntry.type === 'room'"
        type="button"
        data-testid="rail-rooms"
        @click="$emit('select-entry', pinnedRoom)"
      >
        ⌂
      </button>
      <button
        class="sidebar-icon-button"
        :data-active="activeEntry.id === workersEntry.id"
        type="button"
        data-testid="rail-agents"
        @click="$emit('select-entry', workersEntry)"
      >
        ◉
      </button>
      <button
        class="sidebar-icon-button"
        :data-active="activeEntry.id === diagnosticsEntry.id"
        type="button"
        data-testid="rail-system"
        @click="$emit('select-entry', diagnosticsEntry)"
      >
        ⚙
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { ProjectGroup, SidebarEntry, SidebarMode, SystemEntry, RoomEntry } from "../types";

defineProps<{
  sidebarMode: SidebarMode;
  activeEntry: SidebarEntry;
  pinnedRoom: RoomEntry;
  projectEntries: ProjectGroup[];
  systemEntries: SystemEntry[];
  workersEntry: SystemEntry;
  diagnosticsEntry: SystemEntry;
  collapsedSections: {
    pinned: boolean;
    projects: boolean;
    system: boolean;
  };
  collapsedProjects: Record<string, boolean>;
}>();

defineEmits<{
  "cycle-sidebar": [];
  "new-room": [];
  "select-entry": [entry: SidebarEntry];
  "toggle-section": [section: "pinned" | "projects" | "system"];
  "toggle-project": [projectId: string];
}>();
</script>
