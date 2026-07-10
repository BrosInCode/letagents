<template>
  <section class="settings-panel settings-storage-panel" data-testid="settings-storage-panel">
    <div class="settings-content-grid">
      <div class="settings-control-list">
        <SettingsRow
          v-if="activePane === 'storage:chat'"
          title="Default storage for new rooms"
          :description="chatStorageSubtitle"
          :badge="chatStorageModeLabel"
          :badge-state="chatStorageSettings?.mode === 'local' ? 'installed' : 'connected'"
        >
          <template #action>
            <div class="settings-storage-toggle" role="group" aria-label="Chat storage mode">
              <button
                class="settings-filter"
                type="button"
                :data-active="chatStorageSettings?.mode !== 'local'"
                :disabled="chatStorageBusy || !chatStorageAvailable"
                @click="$emit('set-chat-storage-mode', 'cloud')"
              >
                Cloud
              </button>
              <button
                class="settings-filter"
                type="button"
                :data-active="chatStorageSettings?.mode === 'local'"
                :disabled="chatStorageBusy || !chatStorageAvailable"
                @click="$emit('set-chat-storage-mode', 'local')"
              >
                Local
              </button>
            </div>
          </template>
        </SettingsRow>

        <SettingsRow
          v-if="activePane !== 'storage:sync'"
          title="Local database"
          description="Local room messages and tasks are stored on this computer."
        >
          <code>{{ chatStorageSettings?.databasePath || "Local database path unavailable" }}</code>
          <template #action>
            <button
              class="ghost-button settings-action-button"
              type="button"
              :disabled="!chatStorageSettings?.databasePath"
              @click="copyText(chatStorageSettings?.databasePath || '')"
            >
              <Database aria-hidden="true" />
              <span>{{ copiedText === chatStorageSettings?.databasePath ? "Copied" : "Copy path" }}</span>
            </button>
          </template>
        </SettingsRow>

        <SettingsRow
          v-if="activePane !== 'storage:sync'"
          title="Local files"
          description="Files attached in local rooms are copied here."
        >
          <code>{{ chatStorageSettings?.localFilesPath || "Local files path unavailable" }}</code>
          <template #action>
            <button
              class="ghost-button settings-action-button"
              type="button"
              :disabled="!chatStorageSettings?.localFilesPath"
              @click="copyText(chatStorageSettings?.localFilesPath || '')"
            >
              <Copy aria-hidden="true" />
              <span>{{ copiedText === chatStorageSettings?.localFilesPath ? "Copied" : "Copy path" }}</span>
            </button>
          </template>
        </SettingsRow>

        <SettingsRow
          v-if="activePane !== 'storage:database' && !selectedRoomIsLocalGitRoom"
          title="Publish this local room"
          description="Upload this room's local messages and tasks to LetAgents cloud. Nothing uploads until you click Publish."
          badge="manual"
          badge-state="away"
        >
          <template #action>
            <button
              class="primary-button settings-action-button"
              type="button"
              :disabled="chatStorageBusy || !chatStorageAvailable || !selectedRoomIdentifier"
              data-testid="settings-sync-local-chat"
              @click="$emit('sync-local-chat')"
            >
              <CloudUpload aria-hidden="true" />
              <span>Publish to cloud</span>
            </button>
          </template>
        </SettingsRow>

        <SettingsRow
          v-if="activePane !== 'storage:database' && selectedRoomIsLocalGitRoom"
          title="Local Git Room"
          description="This room stays local until you attach a provider-backed repository."
          badge="local"
          badge-state="away"
        />

        <SettingsRow
          v-if="activePane === 'storage:sync'"
          title="Publish behavior"
          description="Local rooms never upload automatically. Publishing is always a manual room action."
          badge="manual"
          badge-state="connected"
        />

        <SettingsRow
          v-if="activePane === 'storage:database'"
          title="Storage settings file"
          description="This file records the app default and per-room storage overrides."
        >
          <code>{{ chatStorageSettings?.settingsPath || "Settings path unavailable" }}</code>
        </SettingsRow>

        <SettingsRow
          title="Attachments in local mode"
          description="Local room files are copied into the local files directory."
          :badge="chatStorageSettings?.mode === 'local' ? 'cloud disabled' : 'cloud enabled'"
          :badge-state="chatStorageSettings?.mode === 'local' ? 'starting' : 'connected'"
          :emphasis="chatStorageSettings?.mode === 'local' ? 'warning' : 'normal'"
        />
      </div>

      <aside class="settings-status-panel" data-testid="settings-storage-status">
        <div class="settings-status-header">
          <HardDrive aria-hidden="true" />
          <div>
            <p>Storage status</p>
            <strong>{{ chatStorageModeLabel }}</strong>
          </div>
        </div>
        <dl class="settings-status-list">
          <div>
            <dt>Active rooms</dt>
            <dd>{{ activeRoomCount }}</dd>
          </div>
          <div>
            <dt>Focus rooms</dt>
            <dd>{{ focusRoomCount }}</dd>
          </div>
          <div>
            <dt>Left</dt>
            <dd>{{ archivedRoomCount }}</dd>
          </div>
          <div>
            <dt>Last saved</dt>
            <dd>{{ chatStorageSavedLabel }}</dd>
          </div>
        </dl>
        <p class="settings-privacy-note">Rooms can override this default from room settings.</p>
      </aside>
    </div>

    <p
      v-if="chatStorageFeedback"
      class="settings-feedback"
      :data-state="chatStorageFeedback.state"
      data-testid="settings-chat-storage-feedback"
    >
      {{ chatStorageFeedback.message }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { CloudUpload, Copy, Database, HardDrive } from "@lucide/vue";
import { computed } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopChatStorageSettings,
} from "../../../../../../electron/ipc-types";
import { useCopyValueIndicator } from "../../../../composables/useCopyIndicator";
import { isLocalGitRoom } from "../../../../domain/git-rooms";
import SettingsRow from "../SettingsRow.vue";
import type { SettingsFeedback, SettingsPaneId } from "../types";

const props = defineProps<{
  accountRooms: DesktopAccountRoomEntry[];
  activePane: SettingsPaneId;
  chatStorageAvailable: boolean;
  chatStorageBusy: boolean;
  chatStorageFeedback: SettingsFeedback | null;
  chatStorageSettings: DesktopChatStorageSettings | null;
  selectedRoomIdentifier: string | null;
}>();

defineEmits<{
  "set-chat-storage-mode": [mode: DesktopChatStorageSettings["mode"]];
  "sync-local-chat": [];
}>();

const { copiedValue: copiedText, copy: copyTextValueToClipboard } = useCopyValueIndicator(1400);

async function copyText(value: string): Promise<void> {
  if (!value) return;
  await copyTextValueToClipboard(value);
}

const activeRoomCount = computed(() => props.accountRooms.filter((room) => !room.archived).length);
const archivedRoomCount = computed(() => props.accountRooms.filter((room) => room.archived).length);
const focusRoomCount = computed(() => props.accountRooms.reduce((total, room) => total + room.focusRooms.length, 0));

const selectedAccountRoom = computed(() => {
  const selectedIdentifier = props.selectedRoomIdentifier?.trim().toLowerCase();
  if (!selectedIdentifier) return null;
  return props.accountRooms.find(
    (room) => room.roomIdentifier.trim().toLowerCase() === selectedIdentifier
  ) || null;
});

const selectedRoomIsLocalGitRoom = computed(() =>
  /^git-room:local:/i.test(props.selectedRoomIdentifier || "") ||
    Boolean(selectedAccountRoom.value && isLocalGitRoom(selectedAccountRoom.value))
);

const chatStorageModeLabel = computed(() =>
  props.chatStorageSettings?.mode === "local" ? "local" : "cloud",
);

const chatStorageSubtitle = computed(() => {
  if (props.chatStorageSettings?.mode === "local") {
    return "New rooms default to local storage on this computer.";
  }
  return "New rooms default to LetAgents cloud storage.";
});

const chatStorageSavedLabel = computed(() => {
  if (!props.chatStorageSettings?.savedAt) return "Never";
  const timestamp = new Date(props.chatStorageSettings.savedAt);
  if (Number.isNaN(timestamp.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
});
</script>
