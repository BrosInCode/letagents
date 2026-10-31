<template>
  <section class="settings-panel" data-testid="settings-agents-panel">
    <SupervisedAgentsUnavailableNotice v-if="!supervisedAgentsSupported" />
    <div v-else class="settings-control-list">
      <SettingsRow
        title="Commit as your GitHub account"
        :description="commitIdentityDescription"
        description-id="settings-agent-commit-identity-description"
      >
        <template #action>
          <DesktopSwitch
            label="Commit as your GitHub account"
            describedby="settings-agent-commit-identity-description"
            test-id="settings-agent-commit-identity"
            :checked="commitIdentity ? !commitIdentity.useHostGitIdentity : false"
            :busy="commitIdentityBusy"
            :disabled="!commitIdentity"
            @toggle="toggleCommitIdentity"
          />
        </template>
      </SettingsRow>
    </div>

    <p
      v-if="supervisedAgentsSupported && commitIdentityError"
      class="settings-feedback"
      data-state="error"
      data-testid="settings-agent-commit-identity-feedback"
    >
      {{ commitIdentityError }}
    </p>

    <div class="surface-list settings-system-list" data-testid="worker-status-list">
      <article
        v-for="worker in workers"
        :key="worker.id"
        class="surface-row"
        :data-testid="`worker-row-${worker.id}`"
      >
        <div>
          <p class="surface-title">{{ worker.runtime }}</p>
          <p class="surface-subtitle">{{ worker.detail }}</p>
        </div>
        <div class="surface-meta">
          <span class="state-pill" :data-state="worker.state">{{ worker.state.replace(/_/g, " ") }}</span>
          <span>{{ roomName(worker.roomId) }}</span>
        </div>
      </article>

      <article v-if="!workers.length" class="surface-row single-line" data-testid="worker-status-empty">
        <p class="surface-title">No agents yet.</p>
        <p v-if="supervisedAgentsSupported" class="surface-subtitle">Add an agent to a room to get started.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { friendlyRoomLabel } from "../../../../domain/git-rooms";
import { desktopIpc } from "../../../../ipc/index.js";
import type {
  DesktopAccountRoomEntry,
  DesktopAgentCommitIdentitySettings,
  WorkerSnapshot,
} from "../../../../../../electron/ipc-types";
import DesktopSwitch from "../../controls/DesktopSwitch.vue";
import { agentCommitIdentityDescription } from "../presentation";
import SettingsRow from "../SettingsRow.vue";
import SupervisedAgentsUnavailableNotice from "../../content/SupervisedAgentsUnavailableNotice.vue";
import { supervisedAgentsSupported } from "../../../../domain/supervised-agents-support";

const props = defineProps<{
  workers: WorkerSnapshot[];
  rooms?: DesktopAccountRoomEntry[];
}>();

const commitIdentity = ref<DesktopAgentCommitIdentitySettings | null>(null);
const commitIdentityBusy = ref(false);
const commitIdentityError = ref<string | null>(null);

const commitIdentityDescription = computed(() => agentCommitIdentityDescription(commitIdentity.value));

// How agents commit matters only where this app runs agents.
onMounted(() => { if (supervisedAgentsSupported.value) void loadCommitIdentity(); });

async function loadCommitIdentity(): Promise<void> {
  try {
    const bridge = desktopIpc.agentCommitIdentity;
    if (!bridge?.getSettings) throw new Error("Restart LetAgents Desktop to change how agents commit.");
    commitIdentity.value = await bridge.getSettings();
    commitIdentityError.value = null;
  } catch (cause) {
    commitIdentityError.value = cause instanceof Error ? cause.message : "Could not load how agents commit.";
  }
}

async function toggleCommitIdentity(): Promise<void> {
  const current = commitIdentity.value;
  const bridge = desktopIpc.agentCommitIdentity;
  if (!current || !bridge?.setUseHostGitIdentity || commitIdentityBusy.value) return;
  commitIdentityBusy.value = true;
  commitIdentityError.value = null;
  try {
    commitIdentity.value = await bridge.setUseHostGitIdentity(!current.useHostGitIdentity);
  } catch (cause) {
    commitIdentityError.value = cause instanceof Error ? cause.message : "Could not save how agents commit.";
  } finally {
    commitIdentityBusy.value = false;
  }
}

function roomName(identifier: string | null): string {
  if (!identifier) return "No room yet";
  const rooms = (props.rooms || []).flatMap(room => [room, ...room.focusRooms]);
  return rooms.find(room => room.roomIdentifier === identifier)?.displayName || friendlyRoomLabel(identifier);
}
</script>
