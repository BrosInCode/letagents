<template>
  <main class="desktop-shell" :data-sidebar-mode="sidebarMode" data-testid="desktop-shell">
    <DesktopSidebar
      :sidebar-mode="sidebarMode"
      :active-entry="activeEntry"
      :pinned-room="pinnedRoom"
      :project-entries="projectEntries"
      :system-entries="systemEntries"
      :workers-entry="workersEntry"
      :diagnostics-entry="diagnosticsEntry"
      :collapsed-sections="collapsedSections"
      :collapsed-projects="collapsedProjects"
      @cycle-sidebar="cycleSidebar"
      @new-room="selectNewRoomEntry"
      @select-entry="activeEntry = $event"
      @toggle-section="toggleSection"
      @toggle-project="toggleProject"
    />

    <section class="app-main" data-testid="desktop-main">
      <DesktopTopbar
        :active-entry="activeEntry"
        :sidebar-mode="sidebarMode"
        :loading="loading"
        @cycle-sidebar="cycleSidebar"
        @show-system="activeEntry = diagnosticsEntry"
        @refresh="refresh"
      />

      <DesktopRoomShell
        v-if="activeEntry.type === 'room'"
        :key="activeEntry.id"
        :room="selectedRoomInfo"
        :focus-rooms="selectedFocusRooms"
        :tasks="selectedSnapshot?.tasks || []"
        :participants="selectedSnapshot?.participants || []"
        :recent-activity="selectedSnapshot?.recentActivity || []"
        :messages="selectedSnapshot?.messages || []"
      />

      <RepoStatusView
        v-else-if="activeEntry.id === 'system:repos'"
        :repo-status="repoStatusValue"
      />

      <WorkerStatusView
        v-else-if="activeEntry.id === 'system:workers'"
        :workers="workers"
      />

      <DiagnosticsView
        v-else
        :notes="diagnostics?.notes || []"
      />
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type {
  DesktopAppInfo,
  DesktopRoomInfo,
  DesktopRoomSnapshot,
  DiagnosticsSnapshot,
  RepoStatus,
  WorkerSnapshot,
} from "../../electron/ipc-types";
import DesktopSidebar from "./components/desktop/sidebar/DesktopSidebar.vue";
import DesktopTopbar from "./components/desktop/content/DesktopTopbar.vue";
import DesktopRoomShell from "./components/desktop/content/DesktopRoomShell.vue";
import DiagnosticsView from "./components/desktop/content/DiagnosticsView.vue";
import RepoStatusView from "./components/desktop/content/RepoStatusView.vue";
import WorkerStatusView from "./components/desktop/content/WorkerStatusView.vue";
import type { ProjectGroup, RoomEntry, SidebarEntry, SidebarMode, SystemEntry } from "./components/desktop/types";

const loading = ref(false);
const sidebarMode = ref<SidebarMode>("expanded");
const appInfo = ref<DesktopAppInfo | null>(null);
const repoStatus = ref<RepoStatus | null>(null);
const workers = ref<WorkerSnapshot[]>([]);
const rootRoomSnapshot = ref<DesktopRoomSnapshot | null>(null);
const selectedSnapshot = ref<DesktopRoomSnapshot | null>(null);
const diagnostics = ref<DiagnosticsSnapshot | null>(null);

const repositoryEntry: SystemEntry = {
  id: "system:repos",
  type: "system",
  title: "Room details",
  description: "Branches and related rooms",
  sectionLabel: "System",
};

const workersEntry: SystemEntry = {
  id: "system:workers",
  type: "system",
  title: "Agents",
  description: "Status and availability",
  sectionLabel: "System",
};

const diagnosticsEntry: SystemEntry = {
  id: "system:diagnostics",
  type: "system",
  title: "Diagnostics",
  description: "Local truth and recovery",
  sectionLabel: "System",
};

const systemEntries: SystemEntry[] = [repositoryEntry, workersEntry, diagnosticsEntry];

const repoName = computed(() => {
  return rootRoomSnapshot.value?.room?.displayName
    || rootRoomSnapshot.value?.roomIdentifier
    || repoStatus.value?.rootPath?.split("/").filter(Boolean).pop()
    || appInfo.value?.workspaceRoot?.split("/").filter(Boolean).pop()
    || "Room";
});

const focusRooms = computed(() => {
  return rootRoomSnapshot.value?.focusRooms || [];
});

const selectedRoomInfo = computed<DesktopRoomInfo>(() => {
  if (!selectedSnapshot.value?.room) {
    return {
      identifier: selectedSnapshot.value?.roomIdentifier || repoName.value,
      code: "",
      name: repoName.value,
      displayName: repoName.value,
      role: "participant",
      authenticated: false,
      kind: activeEntry.value.type === "room" && activeEntry.value.kind === "focus" ? "focus" : "main",
      parentRoomId: null,
      focusKey: null,
      sourceTaskId: null,
      focusStatus: null,
    };
  }
  return selectedSnapshot.value.room;
});

const selectedFocusRooms = computed(() => {
  return activeEntry.value.type === "room" && activeEntry.value.kind === "focus"
    ? []
    : selectedSnapshot.value?.focusRooms || [];
});

const currentParentRoom = computed<RoomEntry>(() => ({
  id: "room:parent:main",
  type: "room",
  kind: "parent",
  title: repoName.value,
  meta: repoStatus.value?.branch || "Parent room",
  sectionLabel: "Parent room",
  headline: "Start here, then branch work into focused rooms when it needs space.",
  description:
    "The main room should feel like home base: familiar, recent, and connected to the focused work happening around it.",
}));

const projectEntries = computed<ProjectGroup[]>(() => {
  const parent = currentParentRoom.value;
  return [
    {
      id: `project:${repoName.value}`,
      roomName: repoName.value,
      parent,
      focusRooms: focusRooms.value.map(focusRoom => ({
        id: `room:focus:${focusRoom.roomId}`,
        type: "room",
        kind: "focus",
        title: focusRoom.displayName,
        meta: focusRoom.code || focusRoom.sourceTaskId || "Focus room",
        sectionLabel: "Focus room",
        headline: "Focused work should stay close to the room it came from.",
        description:
          "A focus room gives one thread of work more space, without losing the connection back to the main room.",
      })),
    },
  ];
});

const pinnedRoom = computed<RoomEntry>(() => ({
  id: "room:pinned:current",
  type: "room",
  kind: "parent",
  title: `${repoName.value} - current`,
  meta: "now",
  sectionLabel: "Pinned room",
  headline: "Come back to the room you were just in without thinking about it.",
  description:
    "Pinned rooms keep the places you return to most close by, so getting back into the flow feels instant.",
}));

const activeEntry = ref<SidebarEntry>(pinnedRoom.value);
const collapsedSections = ref({
  pinned: false,
  projects: false,
  system: false,
});
const collapsedProjects = ref<Record<string, boolean>>({});

function selectNewRoomEntry() {
  activeEntry.value = pinnedRoom.value;
}

function cycleSidebar() {
  sidebarMode.value =
    sidebarMode.value === "expanded"
      ? "rail"
      : sidebarMode.value === "rail"
        ? "hidden"
        : "expanded";
}

function toggleSection(section: "pinned" | "projects" | "system") {
  collapsedSections.value = {
    ...collapsedSections.value,
    [section]: !collapsedSections.value[section],
  };
}

function toggleProject(projectId: string) {
  collapsedProjects.value = {
    ...collapsedProjects.value,
    [projectId]: !collapsedProjects.value[projectId],
  };
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const [nextAppInfo, nextRepoStatus, nextWorkers, nextRootRoomSnapshot, nextDiagnostics] = await Promise.all([
      window.letagentsDesktop.app.getInfo(),
      window.letagentsDesktop.repos.getStatus(),
      window.letagentsDesktop.workers.list(),
      window.letagentsDesktop.room.getSnapshot(),
      window.letagentsDesktop.diagnostics.getSnapshot(),
    ]);
    appInfo.value = nextAppInfo;
    repoStatus.value = nextRepoStatus;
    workers.value = nextWorkers;
    rootRoomSnapshot.value = nextRootRoomSnapshot;
    diagnostics.value = nextDiagnostics;
    reconcileActiveEntry();
    await refreshSelectedSnapshot(nextRootRoomSnapshot);
  } finally {
    loading.value = false;
  }
}

async function refreshSelectedSnapshot(baseRootSnapshot: DesktopRoomSnapshot | null = rootRoomSnapshot.value): Promise<void> {
  if (!baseRootSnapshot) {
    selectedSnapshot.value = null;
    return;
  }

  if (activeEntry.value.type !== "room") {
    selectedSnapshot.value = baseRootSnapshot;
    return;
  }

  const roomIdentifier = resolveSelectedRoomIdentifier(baseRootSnapshot);
  if (!roomIdentifier || roomIdentifier === baseRootSnapshot.roomIdentifier) {
    selectedSnapshot.value = baseRootSnapshot;
    return;
  }

  selectedSnapshot.value = await window.letagentsDesktop.room.getSnapshot(roomIdentifier);
}

function resolveSelectedRoomIdentifier(baseRootSnapshot: DesktopRoomSnapshot | null): string | null {
  if (!baseRootSnapshot) return null;
  if (activeEntry.value.type !== "room") return baseRootSnapshot.roomIdentifier;
  if (activeEntry.value.kind !== "focus") return baseRootSnapshot.roomIdentifier;
  const focusRoom = baseRootSnapshot.focusRooms.find((room) => `room:focus:${room.roomId}` === activeEntry.value.id);
  return focusRoom?.identifier || null;
}

function reconcileActiveEntry(): void {
  if (activeEntry.value.type !== "room") return;

  if (activeEntry.value.kind === "focus") {
    const nextFocus = projectEntries.value[0]?.focusRooms.find((room) => room.id === activeEntry.value.id);
    activeEntry.value = nextFocus || currentParentRoom.value;
    return;
  }

  activeEntry.value = activeEntry.value.id === pinnedRoom.value.id ? pinnedRoom.value : currentParentRoom.value;
}

const repoStatusValue = computed<RepoStatus>(() => repoStatus.value || {
  rootPath: appInfo.value?.workspaceRoot || "",
  branch: null,
  worktrees: [],
});

watch(
  () => activeEntry.value,
  async (nextEntry, previousEntry) => {
    if (!rootRoomSnapshot.value) return;
    if (nextEntry.id === previousEntry?.id) return;
    await refreshSelectedSnapshot(rootRoomSnapshot.value);
  }
);

onMounted(() => {
  void refresh();
});
</script>
