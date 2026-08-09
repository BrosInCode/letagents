<template>
  <DesktopDialogShell
    :open="open"
    backdrop-class="desktop-board-governance-backdrop"
    panel-class="desktop-board-governance-panel"
    panel-id="desktop-board-governance-panel"
    panel-tag="section"
    aria-labelledby="desktop-board-governance-title"
    :show-close="false"
    data-testid="room-board-governance-panel"
    @close="emit('close')"
    v-slot="{ requestClose }"
  >
    <header class="desktop-board-governance-header">
      <div>
        <h2 id="desktop-board-governance-title">Board manager</h2>
        <span>{{ managerLabel ? `Managed by ${managerLabel}` : "No manager assigned" }}</span>
      </div>
      <button
        type="button"
        class="desktop-board-governance-close"
        aria-label="Close board manager"
        @click="requestClose"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      </button>
    </header>

    <DesktopSegmentedControl
      class="desktop-board-governance-sections"
      :model-value="activeSection"
      :options="sections"
      label="Board governance sections"
      mode="tabs"
      @update:model-value="emit('update:active-section', $event as DesktopBoardGovernanceSection)"
    />

    <p v-if="error" class="desktop-board-governance-error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="desktop-board-governance-loading">Loading governance…</p>

    <div v-else-if="governance" class="desktop-board-governance-body">
      <div
        v-if="governance.warnings.length"
        class="desktop-board-governance-warnings"
        data-testid="board-governance-warnings"
      >
        <p
          v-for="warning in governance.warnings"
          :key="warning.code"
          :data-severity="warning.severity"
        >
          {{ warning.message }}
        </p>
      </div>

      <RoomBoardGovernanceManagerSection
        v-if="activeSection === 'manager'"
        :governance="governance"
        :busy="busy"
        :selected-candidate-id="selectedCandidateId"
        :live-agents="liveAgents"
        @update:selected-candidate-id="emit('update:selected-candidate-id', $event)"
        @assign-manager="emit('assign-manager', $event)"
        @release-manager="emit('release-manager')"
        @set-manager-mode="emit('set-manager-mode', $event)"
      />
      <RoomBoardGovernanceIntentSection
        v-else-if="activeSection === 'pending'"
        :governance="governance"
        :busy="busy"
        @approve-intent="emit('approve-intent', $event)"
        @deny-intent="emit('deny-intent', $event)"
      />
      <RoomBoardGovernanceAuditSection
        v-else
        :governance="governance"
      />
    </div>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAgentPresence,
  DesktopBoardGovernanceSection,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardManagerMode,
} from "../../../../../../electron/ipc-types";
import DesktopSegmentedControl from "../../controls/DesktopSegmentedControl.vue";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import { activeManagerLabel } from "./governance-presentation";
import RoomBoardGovernanceAuditSection from "./RoomBoardGovernanceAuditSection.vue";
import RoomBoardGovernanceIntentSection from "./RoomBoardGovernanceIntentSection.vue";
import RoomBoardGovernanceManagerSection from "./RoomBoardGovernanceManagerSection.vue";

const props = defineProps<{
  open: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  governance: DesktopBoardGovernanceSnapshot | null;
  sections: Array<{ id: DesktopBoardGovernanceSection; label: string; count?: number }>;
  activeSection: DesktopBoardGovernanceSection;
  selectedCandidateId: string | null;
  liveAgents: DesktopAgentPresence[];
}>();

const emit = defineEmits<{
  close: [];
  "update:active-section": [section: DesktopBoardGovernanceSection];
  "update:selected-candidate-id": [agentSessionId: string | null];
  "assign-manager": [agentSessionId: string];
  "release-manager": [];
  "set-manager-mode": [mode: DesktopBoardManagerMode];
  "approve-intent": [intentId: string];
  "deny-intent": [intentId: string];
}>();

const managerLabel = computed(() => activeManagerLabel(props.governance));
</script>
