<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAgentPresence,
  DesktopBoardGovernanceAuditEntry,
  DesktopBoardManagerRuntimeSource,
  DesktopBoardIntentSummary,
  DesktopBoardGovernanceSection,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardManagerMode,
} from "../../../../../../electron/ipc-types";
import { formatFullTimestamp } from "../../../../domain/time";
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
    label: "Intents",
    count: props.governance?.pendingIntentCount || undefined,
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
const selectedCandidate = computed(() =>
  liveManagerCandidates.value.find((candidate) => candidate.agentSessionId === props.selectedCandidateId) || null
);
const selectedCandidateIsCurrent = computed(() => selectedCandidate.value?.isActiveManager ?? false);
const canPromoteSelectedCandidate = computed(() =>
  Boolean(
    props.selectedCandidateId
    && liveManagerCandidateIds.value.has(props.selectedCandidateId)
    && !selectedCandidateIsCurrent.value
  )
);
const managerActionLabel = computed(() => {
  if (!props.selectedCandidateId) return "Choose agent";
  if (selectedCandidateIsCurrent.value) return "Current manager";
  return props.governance?.activeManager ? "Replace manager" : "Make manager";
});
const activeManagerLabel = computed(() =>
  props.governance?.activeManager
    ? managerCandidateName({
        agentSessionId: props.governance.activeManager.agentSessionId,
        actorLabel: props.governance.activeManager.actorLabel,
        displayName: props.governance.activeManager.actorLabel,
        runtime: "",
        runtimeSource: props.governance.activeManager.runtimeSource,
        isActiveManager: true,
      })
    : null
);

function formatTimestamp(value: string | null | undefined): string {
  return formatFullTimestamp(value);
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
  const fallback = readableManagerRuntime(candidate.runtimeSource);
  const runtime = candidate.runtime
    .trim()
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ");
  if (!runtime) return fallback;
  const compactRuntime = runtime.replace(/\s+Room\s+[a-f0-9\s-]+$/i, "").trim();
  const primaryRuntime = compactRuntime.split(":")[0]?.trim() || compactRuntime;
  const lowerRuntime = primaryRuntime.toLowerCase();
  if (lowerRuntime.includes("claude")) return "Claude Code";
  if (lowerRuntime.includes("cursor")) return "Cursor";
  if (lowerRuntime.includes("codex")) return "Codex";
  if (lowerRuntime.includes("open model")) return "Open Model";
  if (lowerRuntime === "agent" || lowerRuntime === "worker") return fallback;
  return primaryRuntime
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.length <= 2
      ? part.toUpperCase()
      : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function managerCandidateInitial(candidate: LiveManagerCandidate): string {
  return managerCandidateName(candidate).trim().charAt(0).toUpperCase() || "A";
}

function payloadText(intent: DesktopBoardIntentSummary, key: string): string | null {
  const value = intent.payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readableIntentTitle(intent: DesktopBoardIntentSummary): string {
  if (intent.actionType === "task_create") return "Create task";
  return readableIntentAction(intent.actionType);
}

function readableIntentBody(intent: DesktopBoardIntentSummary): string {
  if (intent.actionType === "task_create") {
    const title = payloadText(intent, "title");
    const description = payloadText(intent, "description");
    return description ? `${title || "Untitled task"} — ${description}` : title || "Untitled task";
  }
  const taskId = payloadText(intent, "task_id") || intent.taskId || "task";
  const status = payloadText(intent, "status");
  const assignee = payloadText(intent, "assignee");
  const prUrl = payloadText(intent, "pr_url");
  if (intent.actionType === "task_claim") {
    return assignee ? `Assign ${taskId} to ${assignee}` : `Claim ${taskId}`;
  }
  if (intent.actionType === "task_close") {
    const statusText = status ? `Move ${taskId} to ${status}` : `Close ${taskId}`;
    return prUrl ? `${statusText} with ${prUrl}` : statusText;
  }
  if (intent.actionType === "task_update") {
    return status ? `Update ${taskId} to ${status}` : `Update ${taskId}`;
  }
  if (intent.actionType === "task_override") {
    const action = payloadText(intent, "action");
    const target = payloadText(intent, "target_actor_key");
    if (action === "handoff") return target ? `Hand off ${taskId} to ${target}` : `Hand off ${taskId}`;
    if (action === "release") return `Release work on ${taskId}`;
    return `Change work lease for ${taskId}`;
  }
  return "Review the requested board change.";
}

function approveIntentLabel(intent: DesktopBoardIntentSummary): string {
  return intent.actionType === "task_create" ? "Create task" : "Approve";
}

function readableAuditEvent(entry: DesktopBoardGovernanceAuditEntry): string {
  if (entry.eventType === "board_intent_task_created") return "Task created";
  return entry.eventType.replaceAll("_", " ");
}

function auditResultText(entry: DesktopBoardGovernanceAuditEntry): string | null {
  const taskId = entry.metadata?.task_id;
  if (entry.eventType === "board_intent_task_created" && typeof taskId === "string") {
    return `Created ${taskId}`;
  }
  return null;
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
          <h2 id="desktop-board-governance-title">Board manager</h2>
          <span>{{ activeManagerLabel ? `Managed by ${activeManagerLabel}` : "No manager assigned" }}</span>
        </div>
        <button
          type="button"
          class="desktop-board-governance-close"
          aria-label="Close board manager"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
        </button>
      </header>

      <DesktopSegmentedControl
        class="desktop-board-governance-sections"
        :model-value="activeSection"
        :options="sectionOptions"
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

        <section v-else-if="activeSection === 'pending'" class="desktop-board-governance-section">
          <p v-if="!governance.pendingIntents.length">No pending board intents.</p>
          <article
            v-for="intent in governance.pendingIntents"
            :key="intent.id"
            class="desktop-board-governance-intent"
          >
            <header>
              <strong>{{ readableIntentTitle(intent) }}</strong>
              <span>{{ intent.proposerActorLabel || "Unknown proposer" }}</span>
            </header>
            <p>{{ readableIntentBody(intent) }}</p>
            <footer v-if="canDecideIntents">
              <button
                type="button"
                class="desktop-board-primary-action"
                :disabled="busy"
                @click="emit('approve-intent', intent.id)"
              >
                {{ approveIntentLabel(intent) }}
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
              <strong>{{ readableAuditEvent(entry) }}</strong>
              <span>{{ formatTimestamp(entry.createdAt) }}</span>
            </header>
            <p v-if="entry.actorLabel">By {{ entry.actorLabel }}</p>
            <p v-if="auditResultText(entry)">{{ auditResultText(entry) }}</p>
            <p v-if="entry.reason">{{ entry.reason }}</p>
          </article>
        </section>
      </div>
    </section>
  </div>
</template>
