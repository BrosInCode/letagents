<template>
  <section class="settings-shell" data-testid="settings-view">
    <SettingsSidebar
      :active-pane="activePane"
      @back="$emit('back-to-app')"
      @select="selectPane"
    />

    <main class="settings-content" data-testid="settings-content">
      <header v-if="!isConnectorsPane" class="settings-content-header">
        <div>
          <p class="sidebar-label">{{ activePaneBreadcrumb }}</p>
          <h1>{{ activePaneTitle }}</h1>
          <p>{{ activePaneDescription }}</p>
        </div>
        <button
          class="ghost-button settings-header-button"
          type="button"
          :disabled="busy || diagnosticsPane?.busy"
          data-testid="settings-refresh"
          @click="refresh"
        >
          <RefreshCw aria-hidden="true" />
          <span>{{
            busy || diagnosticsPane?.busy ? "Refreshing" : "Refresh"
          }}</span>
        </button>
      </header>

      <nav
        v-if="subsections.length && !isConnectorsPane"
        class="settings-subsections"
        aria-label="Settings pages"
      >
        <button
          v-for="item in subsections"
          :key="item.id"
          type="button"
          :data-active="activeSubsection === item.id"
          :aria-current="activeSubsection === item.id ? 'page' : undefined"
          :data-testid="`settings-subsection-${item.id}`"
          @click="selectPane(item.id)"
        >
          {{ item.title }}
        </button>
      </nav>

      <SettingsProfilePane
        v-if="activePane === 'account:profile'"
        :auth-status="authStatus"
        :busy="busy"
        @sign-out="$emit('sign-out')"
        @start-auth="$emit('start-auth')"
      />

      <section
        v-else-if="!supervisedAgentsSupported && agentOnlySettingsPanes.has(activePane)"
        class="settings-panel"
        data-testid="settings-agents-unavailable"
      >
        <SupervisedAgentsUnavailableNotice />
      </section>

      <SettingsRentingPane
        v-else-if="activePane === 'account:renting'"
        :auth-status="authStatus"
      />

      <template v-else-if="isConnectorsPane">
        <ConnectorsPage
          v-if="activePane !== 'account:connectors-setup'"
          :key="authStatus?.account?.id ?? 'signed-out'"
          ref="connectorsPage"
          :api="connectorsApi"
          :agent-targets="mcpInstallState.targets"
          desktop
          :remote-url="remoteConnectorUrl(appInfo?.apiUrl)"
          :initial-tab="
            activePane === 'account:connectors-agents'
              ? 'agent'
              : activePane === 'account:connectors-remote'
                ? 'remote'
                : 'all'
          "
          @setup-agent="openAgentSetup"
          @refresh-agents="$emit('refresh')"
        />
        <button
          v-else
          class="ghost-button"
          type="button"
          @click="selectPane('account:connectors-agents')"
        >
          ← Connectors
        </button>
        <SettingsSetupPane
          v-if="activePane === 'account:connectors-setup'"
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
          @finish-mcp="
            $emit('finish-mcp');
            selectPane('account:connectors-agents');
          "
        />
      </template>
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

      <SettingsAppAgentPane
        v-else-if="activePane === 'system:app-agent'"
        :app-agent-actions="appAgentActions"
        :app-agent-busy="appAgentBusy"
        :app-agent-feedback="appAgentFeedback"
        :app-agent-settings="appAgentSettings"
        @save-app-agent-settings="$emit('save-app-agent-settings', $event)"
      />
      <SettingsSupervisorGrantPane
        v-else-if="activePane === 'system:supervisor'"
      />

      <SettingsRuntimePane
        v-else-if="activePane === 'system:runtime'"
        :app-info="appInfo"
        :auth-status="authStatus"
        :repo-status="repoStatus"
      />

      <SettingsUpdatesPane
        v-else-if="activePane === 'system:updates'"
        :app-info="appInfo"
        :update-status="updateStatus"
        @check="$emit('check-update')"
        @install="$emit('install-update')"
      />

      <SettingsAgentsPane
        v-else-if="activePane === 'system:agents'"
        :workers="workers"
        :rooms="accountRooms"
      />

      <SettingsDiagnosticsPane
        v-else
        ref="diagnosticsPane"
        :rooms="accountRooms"
        @open-agent="$emit('open-agent', $event)"
      />
    </main>
  </section>
</template>

<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";
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
  DesktopUpdateStatus,
  RepoStatus,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import SettingsAgentsPane from "../settings/panes/SettingsAgentsPane.vue";
import SettingsAppAgentPane from "../settings/panes/SettingsAppAgentPane.vue";
import SettingsDiagnosticsPane from "../settings/panes/SettingsDiagnosticsPane.vue";
import SettingsProfilePane from "../settings/panes/SettingsProfilePane.vue";
import SettingsRentingPane from "../settings/panes/SettingsRentingPane.vue";
import SettingsRoomsPane from "../settings/panes/SettingsRoomsPane.vue";
import SettingsRuntimePane from "../settings/panes/SettingsRuntimePane.vue";
import SettingsUpdatesPane from "../settings/panes/SettingsUpdatesPane.vue";
import SettingsSetupPane from "../settings/panes/SettingsSetupPane.vue";
import SettingsStoragePane from "../settings/panes/SettingsStoragePane.vue";
import SettingsSupervisorGrantPane from "../settings/panes/SettingsSupervisorGrantPane.vue";
import SupervisedAgentsUnavailableNotice from "./SupervisedAgentsUnavailableNotice.vue";
import { supervisedAgentsSupported } from "../../../domain/supervised-agents-support";
import SettingsSidebar from "../settings/SettingsSidebar.vue";
import ConnectorsPage from "../../../../../../../shared/ui/connectors/ConnectorsPage.vue";
import { remoteConnectorUrl } from "../settings/connectors";
import type {
  LegacySettingsPaneId,
  SettingsFeedback,
  SettingsPaneId,
} from "../settings/types";
import {
  lastSettingsPane,
  resolveSettingsPane,
  settingsNavGroups,
  settingsSectionFor,
  settingsSubsectionFor,
  settingsSubsections,
  visibleSettingsSubsections,
} from "../settings/navigation";
import type { DesktopMcpWizardStep } from "../setup/types";
import type { AttentionNavigationIntent } from "./room-shell/types";

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
  feedback: SettingsFeedback | null;
  /** An old pane id opens the page that replaced it. */
  initialPane: SettingsPaneId | LegacySettingsPaneId;
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
  updateStatus: DesktopUpdateStatus | null;
}>();

const emit = defineEmits<{
  "back-mcp": [];
  "back-to-app": [];
  "clear-mcp-target-selection": [];
  "continue-mcp": [];
  "delete-room": [room: DesktopAccountRoomEntry];
  "finish-mcp": [];
  "install-mcp-targets": [];
  "check-update": [];
  "install-update": [];
  "leave-room": [room: DesktopAccountRoomEntry];
  "open-room": [room: DesktopAccountRoomEntry];
  "open-agent": [intent: AttentionNavigationIntent];
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

const activePane = ref<SettingsPaneId>(resolveSettingsPane(props.initialPane));
/** Panes that only manage agents run by this app; where agents cannot run they show the one notice. */
const agentOnlySettingsPanes = new Set<SettingsPaneId>(["account:renting", "system:supervisor", "system:diagnostics"]);
const diagnosticsPane = ref<{
  refresh: () => Promise<void>;
  busy: boolean;
} | null>(null);

const activeSection = computed(() => settingsSectionFor(activePane.value));
const subsections = computed(() =>
  visibleSettingsSubsections(activeSection.value),
);
const activeSubsection = computed(() =>
  settingsSubsectionFor(activePane.value),
);
const isConnectorsPane = computed(
  () => activeSection.value === "account:connectors",
);

const isRoomPane = computed(() => activePane.value.startsWith("rooms:"));
const isStoragePane = computed(() => activePane.value.startsWith("storage:"));

const activePaneItem = computed(
  () =>
    settingsNavGroups
      .flatMap((group) => group.items)
      .find((item) => item.id === activeSection.value) ||
    settingsNavGroups[0].items[0],
);

const activePaneBreadcrumb = computed(() => {
  const group = settingsNavGroups.find((navGroup) =>
    navGroup.items.some((item) => item.id === activeSection.value),
  );
  return `Settings / ${group?.label || "Storage"}`;
});

const activePaneTitle = computed(() => activePaneItem.value.title);
const activePaneDescription = computed(() => {
  if (activePane.value === "rooms:defaults")
    return "Manage active, pinned, and joined rooms.";
  if (activePane.value === "rooms:left")
    return "Restore rooms you previously left.";
  if (activePane.value === "storage:chat")
    return "Choose where room messages are stored.";
  if (activePane.value === "rooms:danger")
    return "Review actions that remove access or delete rooms you created.";
  if (activePane.value === "system:app-agent")
    return "Configure the app assistant and see what it can do in the app.";
  return (
    (settingsSubsections[activeSection.value] ?? []).find(
      (item) => item.id === activePane.value,
    )?.description ?? activePaneItem.value.description
  );
});

watch(
  () => props.initialPane,
  (nextPane) => {
    activePane.value = resolveSettingsPane(nextPane);
  },
);
// Plain "Settings" reopens here next time.
watch(activePane, (pane) => { lastSettingsPane.value = pane; }, { immediate: true });

const connectorsPage = ref<InstanceType<typeof ConnectorsPage>>();
const connectorsApi = {
  trackers: window.letagentsDesktop.connectors,
  remote: window.letagentsDesktop.mcpConnections,
};
function openAgentSetup(id: DesktopMcpInstallTargetId) {
  emit("back-mcp");
  emit("clear-mcp-target-selection");
  emit("select-mcp-target", id);
  selectPane("account:connectors-setup");
}

function refresh(): void {
  if (activePane.value === "system:diagnostics" && diagnosticsPane.value) {
    void diagnosticsPane.value.refresh();
    return;
  }
  if (isConnectorsPane.value) {
    void connectorsPage.value?.refresh();
  }
  emit("refresh");
}

function selectPane(paneId: SettingsPaneId): void {
  activePane.value = paneId;
}
</script>
