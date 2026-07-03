<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAgentPresence,
  DesktopBoardManagerRuntimeSource,
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
  liveAgents: DesktopAgentPresence[];
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
  { id: "manager", label: "Manager" },
  {
    id: "pending",
    label: props.governance?.pendingIntentCount
      ? `Intents (${props.governance.pendingIntentCount})`
      : "Intents",
  },
  { id: "audit", label: "Audit" },
]);

const managerModeOptions = computed(() => [
  { id: "manager_optional", label: "Optional" },
  { id: "intent_required", label: "Required" },
  { id: "off", label: "Off" },
]);

const canAssign = computed(() => props.governance?.capabilities.canAssignManager ?? false);
const canRelease = computed(() => props.governance?.capabilities.canReleaseManager ?? false);
const canSetMode = computed(() => props.governance?.capabilities.canSetManagerMode ?? false);
const canDecideIntents = computed(() => props.governance?.capabilities.canDecideIntents ?? false);
const governanceCandidatesBySessionId = computed(() =>
  new Map((props.governance?.candidates || []).map((candidate) => [candidate.agentSessionId, candidate]))
);
const liveManagerCandidates = computed(() =>
  props.liveAgents
    .filter((agent) => Boolean(agent.agentSessionId))
    .map((agent) => {
      const agentSessionId = agent.agentSessionId as string;
      const governanceCandidate = governanceCandidatesBySessionId.value.get(agentSessionId);
      return {
        agentSessionId,
        actorLabel: governanceCandidate?.actorLabel || agent.actorLabel,
        displayName: governanceCandidate?.displayName || agent.displayName,
        runtime: governanceCandidate?.runtime || agent.runtime,
        runtimeSource: governanceCandidate?.runtimeSource || null,
        isActiveManager: governanceCandidate?.isActiveManager
          || props.governance?.activeManager?.agentSessionId === agentSessionId
          || false,
      };
    })
);
const liveManagerCandidateIds = computed(() =>
  new Set(liveManagerCandidates.value.map((candidate) => candidate.agentSessionId))
);
const canAssignSelectedCandidate = computed(() =>
  Boolean(props.selectedCandidateId && liveManagerCandidateIds.value.has(props.selectedCandidateId))
);

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

type LiveManagerCandidate = {
  agentSessionId: string;
  actorLabel: string;
  displayName: string;
  runtime: string;
  runtimeSource: DesktopBoardManagerRuntimeSource | null;
  isActiveManager: boolean;
};

function managerCandidateName(candidate: LiveManagerCandidate): string {
  const displayName = candidate.displayName.trim();
  const actorLabel = candidate.actorLabel.trim();
  const shortActorLabel = actorLabel.split("|")[0]?.trim() || actorLabel;
  if (displayName && displayName !== actorLabel) return displayName;
  return shortActorLabel || displayName || "Agent";
}

function managerCandidateRuntime(candidate: LiveManagerCandidate): string {
  const runtime = candidate.runtime.trim();
  if (!runtime) return readableManagerRuntime(candidate.runtimeSource);
  return runtime
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.length <= 2
      ? part.toUpperCase()
      : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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
          <h2 id="desktop-board-governance-title">Board manager</h2>
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
              <span>Live agents</span>
              <strong>{{ liveManagerCandidates.length }}</strong>
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
            <div class="desktop-board-governance-candidates-heading">
              <h3>Live agents</h3>
              <strong>{{ liveManagerCandidates.length }}</strong>
            </div>
            <p v-if="!liveManagerCandidates.length">
              No live agents are available.
            </p>
            <label
              v-for="candidate in liveManagerCandidates"
              :key="candidate.agentSessionId"
              class="desktop-board-governance-candidate"
              :data-current="candidate.isActiveManager"
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
                <strong>{{ managerCandidateName(candidate) }}</strong>
                <span>
                  {{ managerCandidateRuntime(candidate) }}
                  <template v-if="candidate.isActiveManager"> · current manager</template>
                </span>
              </span>
            </label>
          </div>

          <div v-if="canAssign || canRelease" class="desktop-board-governance-actions">
            <button
              v-if="canAssign"
              type="button"
              class="desktop-board-primary-action"
              :disabled="busy || !canAssignSelectedCandidate"
              data-testid="board-governance-promote"
              @click="selectedCandidateId && emit('assign-manager', selectedCandidateId)"
            >
              {{ governance.activeManager ? "Replace" : "Make manager" }}
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
