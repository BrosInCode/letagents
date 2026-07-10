<template>
  <section class="settings-shell" data-testid="settings-view">
    <SettingsSidebar
      :groups="settingsNavGroups"
      :active-pane="activePane"
      @back="$emit('back-to-app')"
      @select="selectPane"
    />

    <main class="settings-content" data-testid="settings-content">
      <header class="settings-content-header">
        <div>
          <p class="sidebar-label">{{ activePaneBreadcrumb }}</p>
          <h1>{{ activePaneTitle }}</h1>
          <p>{{ activePaneDescription }}</p>
        </div>
        <button
          class="ghost-button settings-header-button"
          type="button"
          :disabled="busy"
          data-testid="settings-refresh"
          @click="$emit('refresh')"
        >
          <RefreshCw aria-hidden="true" />
          <span>{{ busy ? "Refreshing" : "Refresh" }}</span>
        </button>
      </header>

      <SettingsProfilePane
        v-if="activePane === 'account:profile'"
        :auth-status="authStatus"
        :busy="busy"
        @sign-out="$emit('sign-out')"
        @start-auth="$emit('start-auth')"
      />

      <SettingsStoragePane
        v-else-if="isStoragePane"
        :account-rooms="accountRooms"
        :active-pane="activePane"
        :chat-storage-available="chatStorageAvailable"
        :chat-storage-busy="chatStorageBusy"
        :chat-storage-feedback="chatStorageFeedback"
        :chat-storage-settings="chatStorageSettings"
        :selected-room-identifier="selectedRoomIdentifier"
        @set-chat-storage-mode="$emit('set-chat-storage-mode', $event)"
        @sync-local-chat="$emit('sync-local-chat')"
      />

      <SettingsRoomsPane
        v-else-if="isRoomPane"
        :account-rooms="accountRooms"
        :active-pane="activePane"
        :busy="busy"
        :feedback="feedback"
        :room-action-busy-key="roomActionBusyKey"
        @delete-room="$emit('delete-room', $event)"
        @leave-room="$emit('leave-room', $event)"
        @open-room="$emit('open-room', $event)"
        @restore-room="$emit('restore-room', $event)"
        @toggle-pin-room="$emit('toggle-pin-room', $event)"
      />

      <SettingsSetupPane
        v-else-if="activePane === 'system:setup'"
        :mcp-install-state="mcpInstallState"
        :selected-mcp-target-ids="selectedMcpTargetIds"
        :mcp-wizard-step="mcpWizardStep"
        :mcp-install-busy="mcpInstallBusy"
        :mcp-install-feedback="mcpInstallFeedback"
        :setup-api-available="setupApiAvailable"
        @select-mcp-target="$emit('select-mcp-target', $event)"
        @select-all-mcp-targets="$emit('select-all-mcp-targets')"
        @clear-mcp-target-selection="$emit('clear-mcp-target-selection')"
        @continue-mcp="$emit('continue-mcp')"
        @back-mcp="$emit('back-mcp')"
        @install-mcp-targets="$emit('install-mcp-targets')"
        @finish-mcp="$emit('finish-mcp')"
      />

      <SettingsAppAgentPane
        v-else-if="activePane === 'system:app-agent'"
        :app-agent-actions="appAgentActions"
        :app-agent-busy="appAgentBusy"
        :app-agent-feedback="appAgentFeedback"
        :app-agent-settings="appAgentSettings"
        @save-app-agent-settings="$emit('save-app-agent-settings', $event)"
      />

      <SettingsRuntimePane
        v-else-if="activePane === 'system:runtime'"
        :app-info="appInfo"
        :auth-status="authStatus"
        :repo-status="repoStatus"
      />

      <SettingsMcpPane
        v-else-if="activePane === 'system:mcp'"
        :mcp-install-state="mcpInstallState"
      />

      <SettingsAgentsPane
        v-else-if="activePane === 'system:agents'"
        :workers="workers"
      />

      <SettingsDiagnosticsPane
        v-else
        :diagnostics-notes="diagnosticsNotes"
      />
    </main>
  </section>
</template>

<script setup lang="ts">
import {
  Activity,
  ArchiveRestore,
  Bot,
  CircleUser,
  Cloud,
  CloudUpload,
  Database,
  GitBranch,
  KeyRound,
  RefreshCw,
  ServerCog,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAppAgentActionMetadata,
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
  DesktopAuthStatus,
  DesktopAppInfo,
  DesktopChatStorageSettings,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  RepoStatus,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import SettingsAgentsPane from "../settings/panes/SettingsAgentsPane.vue";
import SettingsAppAgentPane from "../settings/panes/SettingsAppAgentPane.vue";
import SettingsDiagnosticsPane from "../settings/panes/SettingsDiagnosticsPane.vue";
import SettingsMcpPane from "../settings/panes/SettingsMcpPane.vue";
import SettingsProfilePane from "../settings/panes/SettingsProfilePane.vue";
import SettingsRoomsPane from "../settings/panes/SettingsRoomsPane.vue";
import SettingsRuntimePane from "../settings/panes/SettingsRuntimePane.vue";
import SettingsSetupPane from "../settings/panes/SettingsSetupPane.vue";
import SettingsSidebar from "../settings/SettingsSidebar.vue";
import type { SettingsFeedback, SettingsNavGroup, SettingsPaneId } from "../settings/types";
import type { DesktopMcpWizardStep } from "../setup/types";

const props = defineProps<{
  accountRooms: DesktopAccountRoomEntry[];
  appInfo: DesktopAppInfo | null;
  appAgentActions: DesktopAppAgentActionMetadata[];
  appAgentBusy: boolean;
  appAgentFeedback: SettingsFeedback | null;
  appAgentSettings: DesktopAppAgentSettingsStatus | null;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  chatStorageAvailable: boolean;
  diagnosticsNotes: string[];
  feedback: SettingsFeedback | null;
  initialPane: SettingsPaneId;
  chatStorageBusy: boolean;
  chatStorageFeedback: SettingsFeedback | null;
  chatStorageSettings: DesktopChatStorageSettings | null;
  mcpInstallBusy: boolean;
  mcpInstallFeedback: string | null;
  mcpInstallState: DesktopMcpInstallState;
  mcpWizardStep: DesktopMcpWizardStep;
  repoStatus: RepoStatus | null;
  roomActionBusyKey: string | null;
  selectedMcpTargetIds: DesktopMcpInstallTargetId[];
  selectedRoomIdentifier: string | null;
  setupApiAvailable: boolean;
  workers: WorkerSnapshot[];
}>();

defineEmits<{
  "back-mcp": [];
  "back-to-app": [];
  "clear-mcp-target-selection": [];
  "continue-mcp": [];
  "delete-room": [room: DesktopAccountRoomEntry];
  "finish-mcp": [];
  "install-mcp-targets": [];
  "leave-room": [room: DesktopAccountRoomEntry];
  "open-room": [room: DesktopAccountRoomEntry];
  "restore-room": [room: DesktopAccountRoomEntry];
  "select-all-mcp-targets": [];
  "select-mcp-target": [targetId: DesktopMcpInstallTargetId];
  "save-app-agent-settings": [input: DesktopAppAgentSaveSettingsInput];
  "set-chat-storage-mode": [mode: DesktopChatStorageSettings["mode"]];
  "sync-local-chat": [];
  "toggle-pin-room": [room: DesktopAccountRoomEntry];
  refresh: [];
  "sign-out": [];
  "start-auth": [];
}>();

const activePane = ref<SettingsPaneId>(props.initialPane);

const settingsNavGroups: SettingsNavGroup[] = [
  {
    label: "Account",
    items: [
      { id: "account:profile", title: "Profile", description: "Identity and sign-in", icon: CircleUser },
    ],
  },
  {
    label: "Rooms",
    items: [
      { id: "rooms:defaults", title: "Rooms", description: "Active, pinned, and joined", icon: SlidersHorizontal },
      { id: "rooms:left", title: "Left rooms", description: "Restore rooms you left", icon: ArchiveRestore },
      { id: "rooms:danger", title: "Room removal", description: "Leave and delete rooms", icon: Trash2 },
    ],
  },
  {
    label: "Storage",
    items: [
      { id: "storage:chat", title: "Chat storage", description: "Cloud or local messages", icon: Cloud },
      { id: "storage:sync", title: "Publishing", description: "Manual cloud upload", icon: CloudUpload },
      { id: "storage:database", title: "Local database", description: "Local database files", icon: Database },
    ],
  },
  {
    label: "System",
    items: [
      { id: "system:setup", title: "Setup", description: "Install LetAgents", icon: Wrench },
      { id: "system:app-agent", title: "App Agent", description: "App control", icon: KeyRound },
      { id: "system:runtime", title: "Runtime", description: "Repo and desktop state", icon: GitBranch },
      { id: "system:mcp", title: "Agent app connections", description: "Connected apps", icon: ServerCog },
      { id: "system:agents", title: "Agents", description: "Status and availability", icon: Bot },
      { id: "system:diagnostics", title: "Troubleshooting", description: "Local truth and recovery", icon: Activity },
    ],
  },
];

const isRoomPane = computed(() => activePane.value.startsWith("rooms:"));
const isStoragePane = computed(() => activePane.value.startsWith("storage:"));

const activePaneItem = computed(() =>
  settingsNavGroups.flatMap((group) => group.items).find((item) => item.id === activePane.value) || settingsNavGroups[2].items[0],
);

const activePaneBreadcrumb = computed(() => {
  const group = settingsNavGroups.find((navGroup) => navGroup.items.some((item) => item.id === activePane.value));
  return `Settings / ${group?.label || "Storage"}`;
});

const activePaneTitle = computed(() => activePaneItem.value.title);
const activePaneDescription = computed(() => {
  if (activePane.value === "rooms:defaults") return "Manage active, pinned, and joined rooms.";
  if (activePane.value === "rooms:left") return "Restore rooms you previously left.";
  if (activePane.value === "storage:chat") return "Choose where room messages are stored before upload.";
  if (activePane.value === "rooms:danger") return "Review actions that remove access or delete rooms you created.";
  if (activePane.value === "system:app-agent") return "Configure the app assistant and see what it can do in the app.";
  return activePaneItem.value.description;
});

watch(
  () => props.initialPane,
  (nextPane) => {
    activePane.value = nextPane;
  }
);

function selectPane(paneId: SettingsPaneId): void {
  activePane.value = paneId;
}
</script>
