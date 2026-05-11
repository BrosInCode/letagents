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
      <div class="sidebar-brand-mark" aria-hidden="true">LA</div>
      <div>
        <h1>LetAgents</h1>
        <p>{{ sidebarSummary }}</p>
      </div>
    </div>

    <button
      v-if="sidebarMode === 'expanded'"
      class="sidebar-cta"
      type="button"
      data-testid="sidebar-new-room"
      @click="$emit('new-room')"
    >
      <span class="cta-plus" aria-hidden="true">+</span>
      <span>New room</span>
    </button>

    <section v-if="sidebarMode === 'expanded'" class="sidebar-section" data-testid="sidebar-section-rooms">
      <button
        class="section-toggle"
        type="button"
        data-testid="sidebar-toggle-rooms"
        @click="$emit('toggle-section', 'projects')"
      >
        <span class="sidebar-heading">Rooms</span>
        <span class="section-count">{{ totalRoomCount }}</span>
        <span class="toggle-glyph" :data-collapsed="collapsedSections.projects">⌄</span>
      </button>
      <Transition name="sidebar-reveal">
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
              <span class="project-icon" aria-hidden="true">
                <svg viewBox="0 0 20 20">
                  <path :d="sidebarIconPath('room')" />
                </svg>
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
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path :d="sidebarIconPath('chevron')" />
              </svg>
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
      <TransitionGroup name="sidebar-list" tag="div" class="sidebar-list-motion">
        <button
          v-for="item in !collapsedSections.system ? systemEntries : []"
          :key="item.id"
          class="sidebar-row"
          :data-active="activeEntry.id === item.id"
          type="button"
          :data-testid="`system-entry-${item.id}`"
          @click="$emit('select-entry', item)"
        >
          <span class="system-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <path :d="systemIconPath(item)" />
            </svg>
          </span>
          <span class="system-copy">
            <span>{{ item.title }}</span>
            <small>{{ item.description }}</small>
          </span>
        </button>
      </TransitionGroup>
    </section>

    <div v-else class="sidebar-collapsed-actions" data-testid="sidebar-rail">
      <button
        class="sidebar-icon-button"
        type="button"
        data-testid="rail-new-room"
        aria-label="New room"
        title="New room"
        @click="$emit('new-room')"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path :d="sidebarIconPath('plus')" />
        </svg>
      </button>
      <button
        class="sidebar-icon-button"
        :data-active="activeEntry.type === 'room'"
        type="button"
        data-testid="rail-rooms"
        aria-label="Rooms"
        title="Rooms"
        @click="$emit('select-entry', primaryRoom)"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path :d="sidebarIconPath('room')" />
        </svg>
      </button>
      <button
        class="sidebar-icon-button"
        :data-active="activeEntry.id === workersEntry.id"
        type="button"
        data-testid="rail-agents"
        aria-label="Agents"
        title="Agents"
        @click="$emit('select-entry', workersEntry)"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path :d="sidebarIconPath('agents')" />
        </svg>
      </button>
      <button
        class="sidebar-icon-button"
        :data-active="activeEntry.id === diagnosticsEntry.id"
        type="button"
        data-testid="rail-system"
        aria-label="System"
        title="System"
        @click="$emit('select-entry', diagnosticsEntry)"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path :d="sidebarIconPath('system')" />
        </svg>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ProjectGroup, SidebarEntry, SidebarMode, SystemEntry, RoomEntry } from "../types";

const props = defineProps<{
  sidebarMode: SidebarMode;
  activeEntry: SidebarEntry;
  primaryRoom: RoomEntry;
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

const totalRoomCount = computed(() =>
  props.projectEntries.reduce((total, project) => total + 1 + project.focusRooms.length, 0)
);

const sidebarSummary = computed(() => {
  const focusCount = props.projectEntries.reduce((total, project) => total + project.focusRooms.length, 0);
  if (!focusCount) return "Room command center";
  return `${focusCount} focus ${focusCount === 1 ? "room" : "rooms"}`;
});

function sidebarIconPath(icon: "agents" | "chevron" | "pin" | "plus" | "room" | "system"): string {
  const paths = {
    agents: "M6.75 8.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Zm6.5 0a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM3.25 15.5c.45-2.28 1.82-3.42 4.1-3.42s3.65 1.14 4.1 3.42m-1.2-3.42c.55-.58 1.35-.87 2.4-.87 2.03 0 3.27 1.06 3.72 3.18",
    chevron: "M7.5 4.75 12.75 10 7.5 15.25",
    pin: "M10.75 2.75 15 7l-2.2 2.2.35 4.15-1.3 1.3-3.15-3.15-3.95 3.95-.2-.2 3.95-3.95-3.15-3.15 1.3-1.3 4.15.35 1.95-2.45Z",
    plus: "M10 4.5v11M4.5 10h11",
    room: "M3.5 9.25 10 4l6.5 5.25M5.25 8.75v6.75h9.5V8.75",
    system: "M10 3.5v2m0 9v2m6.5-6.5h-2m-9 0h-2m11.1-4.6-1.42 1.42M6.82 13.18 5.4 14.6m9.2 0-1.42-1.42M6.82 6.82 5.4 5.4M7.25 10a2.75 2.75 0 1 0 5.5 0 2.75 2.75 0 0 0-5.5 0Z",
  };
  return paths[icon];
}

function systemIconPath(item: SystemEntry): string {
  if (item.id === "system:workers") return sidebarIconPath("agents");
  if (item.id === "system:repos") return "M4 5.25h12v9.5H4zM6.5 7.75h7M6.5 10h5M6.5 12.25h3.5";
  if (item.id === "system:setup") return "M4.5 10.25 8 13.75 15.5 5.75";
  return sidebarIconPath("system");
}
</script>
