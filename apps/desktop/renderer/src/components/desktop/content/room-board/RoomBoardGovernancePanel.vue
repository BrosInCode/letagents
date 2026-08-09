<template>
  <DesktopDialogShell
    :open="open"
    backdrop-class="desktop-board-governance-backdrop"
    panel-class="desktop-board-governance-panel"
    panel-id="desktop-board-governance-panel"
    panel-tag="section"
    aria-labelledby="desktop-board-governance-title"
    :show-close="false"
    test-id="room-board-governance-panel"
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
      tab-panel-id-prefix="desktop-board-governance-section"
      @update:model-value="emit('update:active-section', $event as DesktopBoardGovernanceSection)"
    />

    <div v-if="error" class="desktop-board-governance-error">
      <p role="alert">{{ error }}</p>
      <button
        v-if="errorRetryable"
        type="button"
        class="desktop-board-secondary-action"
        :disabled="loading"
        @click="emit('retry')"
      >
        Refresh state
      </button>
    </div>
    <p v-if="loading" class="desktop-board-governance-loading">Loading governance…</p>

    <div
      v-if="governance && !loading"
      class="desktop-board-governance-body"
    >
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
          <strong>{{ warningSeverityLabel(warning.severity) }}:</strong>
          {{ warning.message }}
        </p>
      </div>

      <div
        id="desktop-board-governance-section-panel-manager"
        v-show="activeSection === 'manager'"
        class="desktop-board-governance-section-panel"
        role="tabpanel"
        aria-labelledby="desktop-board-governance-section-tab-manager"
        tabindex="0"
      >
        <RoomBoardGovernanceManagerSection
          :governance="governance"
          :busy="busy"
          :selected-candidate-id="selectedCandidateId"
          :live-agents="liveAgents"
          @update:selected-candidate-id="emit('update:selected-candidate-id', $event)"
          @assign-manager="emit('assign-manager', $event)"
          @release-manager="emit('release-manager')"
          @set-manager-mode="emit('set-manager-mode', $event)"
        />
      </div>
      <div
        id="desktop-board-governance-section-panel-pending"
        v-show="activeSection === 'pending'"
        class="desktop-board-governance-section-panel"
        role="tabpanel"
        aria-labelledby="desktop-board-governance-section-tab-pending"
        tabindex="0"
      >
        <RoomBoardGovernanceIntentSection
          :governance="governance"
          :busy="busy"
          @approve-intent="emit('approve-intent', $event)"
          @deny-intent="emit('deny-intent', $event)"
        />
      </div>
      <div
        id="desktop-board-governance-section-panel-audit"
        v-show="activeSection === 'audit'"
        class="desktop-board-governance-section-panel"
        role="tabpanel"
        aria-labelledby="desktop-board-governance-section-tab-audit"
        tabindex="0"
      >
        <RoomBoardGovernanceAuditSection :governance="governance" />
      </div>
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
  errorRetryable: boolean;
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
  retry: [];
}>();

const managerLabel = computed(() => activeManagerLabel(props.governance));

function warningSeverityLabel(severity: string): string {
  if (severity === "error") return "Error";
  if (severity === "info") return "Info";
  return "Warning";
}
</script>
