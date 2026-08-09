<template>
  <section class="desktop-board-governance-section">
    <div v-if="canSetMode" class="desktop-board-governance-mode">
      <span>Manager mode</span>
      <DesktopSegmentedControl
        class="desktop-board-governance-mode-control"
        :model-value="governance.managerMode"
        :options="managerModeOptions"
        label="Board manager mode"
        size="compact"
        @update:model-value="emit('set-manager-mode', $event as DesktopBoardManagerMode)"
      />
    </div>

    <div class="desktop-board-governance-candidates">
      <div class="desktop-board-governance-candidates-heading">
        <h3>Live agents</h3>
        <strong>{{ candidates.length }}</strong>
      </div>
      <p v-if="!candidates.length">No live agents are available.</p>
      <label
        v-for="candidate in candidates"
        :key="candidate.agentSessionId"
        class="desktop-board-governance-candidate"
        :data-current="candidate.isActiveManager"
        :data-selected="selectedCandidateId === candidate.agentSessionId"
      >
        <input
          type="radio"
          name="board-manager-candidate"
          :value="candidate.agentSessionId"
          :checked="selectedCandidateId === candidate.agentSessionId"
          :disabled="!canAssign || busy"
          @change="emit('update:selected-candidate-id', candidate.agentSessionId)"
        />
        <span class="desktop-board-governance-candidate-avatar" aria-hidden="true">
          {{ managerCandidateInitial(candidate) }}
        </span>
        <span class="desktop-board-governance-candidate-copy">
          <span>
            <strong>{{ managerCandidateName(candidate) }}</strong>
            <em v-if="candidate.isActiveManager">Current</em>
          </span>
          <small>{{ managerCandidateRuntime(candidate) }}</small>
        </span>
      </label>
    </div>

    <div v-if="canAssign || canRelease" class="desktop-board-governance-actions">
      <button
        v-if="canAssign"
        type="button"
        class="desktop-board-primary-action"
        :disabled="busy || !canPromoteSelectedCandidate"
        data-testid="board-governance-promote"
        @click="selectedCandidateId && emit('assign-manager', selectedCandidateId)"
      >
        {{ managerActionLabel }}
      </button>
      <button
        v-if="canRelease && governance.activeManager"
        type="button"
        class="desktop-board-secondary-action"
        :disabled="busy"
        data-testid="board-governance-release"
        @click="emit('release-manager')"
      >
        Release
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAgentPresence,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardManagerMode,
} from "../../../../../../electron/ipc-types";
import DesktopSegmentedControl from "../../controls/DesktopSegmentedControl.vue";
import {
  liveManagerCandidates,
  managerCandidateInitial,
  managerCandidateName,
  managerCandidateRuntime,
} from "./governance-presentation";

const props = defineProps<{
  governance: DesktopBoardGovernanceSnapshot;
  busy: boolean;
  selectedCandidateId: string | null;
  liveAgents: DesktopAgentPresence[];
}>();

const emit = defineEmits<{
  "update:selected-candidate-id": [agentSessionId: string | null];
  "assign-manager": [agentSessionId: string];
  "release-manager": [];
  "set-manager-mode": [mode: DesktopBoardManagerMode];
}>();

const managerModeOptions = [
  { id: "manager_optional", label: "Optional" },
  { id: "intent_required", label: "Required" },
  { id: "off", label: "Off" },
];
const canAssign = computed(() => props.governance.capabilities.canAssignManager);
const canRelease = computed(() => props.governance.capabilities.canReleaseManager);
const canSetMode = computed(() => props.governance.capabilities.canSetManagerMode);
const candidates = computed(() => liveManagerCandidates(props.governance, props.liveAgents));
const selectedCandidate = computed(() =>
  candidates.value.find((candidate) => candidate.agentSessionId === props.selectedCandidateId) || null
);
const canPromoteSelectedCandidate = computed(() =>
  Boolean(selectedCandidate.value && !selectedCandidate.value.isActiveManager)
);
const managerActionLabel = computed(() => {
  if (!props.selectedCandidateId) return "Choose agent";
  if (selectedCandidate.value?.isActiveManager) return "Current manager";
  return props.governance.activeManager ? "Replace manager" : "Make manager";
});
</script>
