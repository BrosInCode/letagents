<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopBoardGovernanceSection,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardManagerMode,
} from "../../../../../../electron/ipc-types";
import DesktopSegmentedControl from "../../controls/DesktopSegmentedControl.vue";
import {
  readableIntentAction,
  readableManagerMode,
  readableManagerRuntime,
} from "./useBoardGovernance";

const props = defineProps<{
  open: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  governance: DesktopBoardGovernanceSnapshot | null;
  activeSection: DesktopBoardGovernanceSection;
  selectedCandidateId: string | null;
}>();

const emit = defineEmits<{
  close: [];
  "update:active-section": [section: DesktopBoardGovernanceSection];
  "update:selected-candidate-id": [agentSessionId: string | null];
  refresh: [];
  "assign-manager": [agentSessionId: string];
  "release-manager": [];
  "set-manager-mode": [mode: DesktopBoardManagerMode];
  "approve-intent": [intentId: string];
  "deny-intent": [intentId: string];
}>();

const sectionOptions = computed(() => [
  { id: "overview", label: "Overview" },
  { id: "manager", label: "Manager" },
  {
    id: "pending",
    label: props.governance?.pendingIntentCount
      ? `Pending (${props.governance.pendingIntentCount})`
      : "Pending",
  },
  { id: "audit", label: "Audit" },
]);

const managerModeOptions = computed(() => [
  { id: "manager_optional", label: "Manager optional" },
  { id: "intent_required", label: "Approval required" },
  { id: "off", label: "Off" },
]);

const canAssign = computed(() => props.governance?.capabilities.canAssignManager ?? false);
const canRelease = computed(() => props.governance?.capabilities.canReleaseManager ?? false);
const canSetMode = computed(() => props.governance?.capabilities.canSetManagerMode ?? false);
const canDecideIntents = computed(() => props.governance?.capabilities.canDecideIntents ?? false);

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}
</script>

<template>
  <div
    v-if="open"
    class="desktop-board-governance-backdrop"
    data-testid="room-board-governance-panel"
    @click.self="emit('close')"
  >
    <section
      class="desktop-board-governance-panel"
      role="dialog"
      aria-labelledby="desktop-board-governance-title"
      @keydown.esc.stop.prevent="emit('close')"
    >
      <header class="desktop-board-governance-header">
        <div>
          <span>Board governance</span>
          <h2 id="desktop-board-governance-title">Manager, intents, and audit</h2>
        </div>
        <button type="button" class="desktop-board-governance-close" @click="emit('close')">
          Close
        </button>
      </header>

      <DesktopSegmentedControl
        class="desktop-board-governance-sections"
        :model-value="activeSection"
        :options="sectionOptions"
        label="Board governance sections"
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

        <section v-if="activeSection === 'overview'" class="desktop-board-governance-section">
          <div class="desktop-board-governance-grid">
            <div>
              <span>Mode</span>
              <strong>{{ readableManagerMode(governance.managerMode) }}</strong>
            </div>
            <div>
              <span>Active manager</span>
              <strong>
                {{
                  governance.activeManager
                    ? `${governance.activeManager.actorLabel} (${readableManagerRuntime(governance.activeManager.runtimeSource)})`
                    : "None"
                }}
              </strong>
            </div>
            <div>
              <span>Pending intents</span>
              <strong>{{ governance.pendingIntentCount }}</strong>
            </div>
            <div>
              <span>Worker candidates</span>
              <strong>{{ governance.candidates.length }}</strong>
            </div>
          </div>
        </section>

        <section v-else-if="activeSection === 'manager'" class="desktop-board-governance-section">
          <div v-if="canSetMode" class="desktop-board-governance-mode">
            <span>Manager mode</span>
            <DesktopSegmentedControl
              :model-value="governance.managerMode"
              :options="managerModeOptions"
              label="Board manager mode"
              @update:model-value="emit('set-manager-mode', $event as DesktopBoardManagerMode)"
            />
          </div>

          <div class="desktop-board-governance-candidates">
            <h3>Active worker sessions</h3>
            <p v-if="!governance.candidates.length">No active worker sessions are registered in this room.</p>
            <label
              v-for="candidate in governance.candidates"
              :key="candidate.agentSessionId"
              class="desktop-board-governance-candidate"
            >
              <input
                type="radio"
                name="board-manager-candidate"
                :value="candidate.agentSessionId"
                :checked="selectedCandidateId === candidate.agentSessionId"
                :disabled="!canAssign || busy"
                @change="emit('update:selected-candidate-id', candidate.agentSessionId)"
              />
              <span>
                <strong>{{ candidate.actorLabel }}</strong>
                <span>{{ candidate.displayName }} · {{ readableManagerRuntime(candidate.runtimeSource) }}</span>
                <span>Last seen {{ formatTimestamp(candidate.lastSeenAt) }}</span>
              </span>
            </label>
          </div>

          <div v-if="canAssign || canRelease" class="desktop-board-governance-actions">
            <button
              v-if="canAssign"
              type="button"
              class="desktop-board-primary-action"
              :disabled="busy || !selectedCandidateId"
              data-testid="board-governance-promote"
              @click="selectedCandidateId && emit('assign-manager', selectedCandidateId)"
            >
              {{ governance.activeManager ? "Replace manager" : "Promote to manager" }}
            </button>
            <button
              v-if="canRelease && governance.activeManager"
              type="button"
              class="desktop-board-secondary-action"
              :disabled="busy"
              data-testid="board-governance-release"
              @click="emit('release-manager')"
            >
              Release manager
            </button>
          </div>
        </section>

        <section v-else-if="activeSection === 'pending'" class="desktop-board-governance-section">
          <p v-if="!governance.pendingIntents.length">No pending board intents.</p>
          <article
            v-for="intent in governance.pendingIntents"
            :key="intent.id"
            class="desktop-board-governance-intent"
          >
            <header>
              <strong>{{ readableIntentAction(intent.actionType) }}</strong>
              <span>{{ intent.proposerActorLabel || "Unknown proposer" }}</span>
            </header>
            <p>{{ JSON.stringify(intent.payload) }}</p>
            <footer v-if="canDecideIntents">
              <button
                type="button"
                class="desktop-board-primary-action"
                :disabled="busy"
                @click="emit('approve-intent', intent.id)"
              >
                Approve
              </button>
              <button
                type="button"
                class="desktop-board-secondary-action"
                :disabled="busy"
                @click="emit('deny-intent', intent.id)"
              >
                Deny
              </button>
            </footer>
          </article>
        </section>

        <section v-else class="desktop-board-governance-section">
          <p v-if="!governance.audit.length">No governance audit entries yet.</p>
          <article
            v-for="entry in governance.audit"
            :key="`${entry.kind}:${entry.id}:${entry.createdAt}`"
            class="desktop-board-governance-audit-entry"
          >
            <header>
              <strong>{{ entry.eventType.replaceAll("_", " ") }}</strong>
              <span>{{ formatTimestamp(entry.createdAt) }}</span>
            </header>
            <p v-if="entry.actorLabel">By {{ entry.actorLabel }}</p>
            <p v-if="entry.reason">{{ entry.reason }}</p>
          </article>
        </section>
      </div>
    </section>
  </div>
</template>
