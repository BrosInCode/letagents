<template>
  <section class="room-tab-page desktop-board-panel" data-testid="room-board-view">
    <RoomBoardToolbar
      :search-query="searchQuery"
      :active-filter="activeFilter"
      :filter-options="filterOptions"
      :busy="busyAction !== null"
      :manager-mode="boardManagerMode"
      :manager-title="boardManagerTitle"
      :pending-intent-count="boardPendingIntentCount"
      :governance-open="governanceOpen"
      @update:search-query="searchQuery = $event"
      @update:active-filter="setActiveFilter"
      @open-governance="openGovernance"
      @add-task="openCreateTaskDialog"
    />

    <p v-if="errorMessage" class="desktop-board-error" role="alert">{{ errorMessage }}</p>

    <RoomBoardEmptyState
      v-if="visibleTaskCount === 0"
      :state="emptyState"
      :busy="busyAction !== null"
      @action="handleEmptyStateAction"
    />

    <RoomBoardKanban
      v-else
      :groups="visibleGroups"
      :active-filter="activeFilter"
      :selected-task-id="localSelectedTaskId"
      :busy-action="busyAction"
      :collapsed-groups="collapsedGroups"
      :actions-for="actionsFor"
      @select="selectTask"
      @drag-start="clearTaskSelection"
      @run-action="handleRunTaskAction"
      @toggle-group="toggleGroup"
    />

    <RoomBoardTaskDialog
      :task="modalTask"
      :actions="modalTaskActions"
      :busy-action="busyAction"
      :review-assignment-candidates="modalReviewAssignmentCandidates"
      :selected-reviewer="modalSelectedReviewer"
      @close="clearTaskSelection"
      @assign-review="assignModalReview"
      @run-action="runModalTaskAction"
      @update:selected-reviewer="setModalReviewer"
      @view-events="emit('view-events', $event)"
      @view-artifacts="emit('view-artifacts', $event)"
    />

    <RoomBoardCreateTaskDialog
      :open="isCreateTaskDialogOpen"
      :busy-action="busyAction"
      @close="closeCreateTaskDialog"
      @create="submitCreateTask"
    />

    <RoomBoardGovernancePanel
      :open="governanceOpen"
      :loading="governanceLoading"
      :busy="governanceBusy"
      :error="governanceError"
      :governance="governance"
      :sections="governanceSections"
      :active-section="activeGovernanceSection"
      :selected-candidate-id="selectedCandidateId"
      :live-agents="liveBoardManagerAgents"
      @close="closeGovernance"
      @update:active-section="activeGovernanceSection = $event"
      @update:selected-candidate-id="selectedCandidateId = $event"
      @assign-manager="handleAssignManager"
      @release-manager="handleReleaseManager"
      @set-manager-mode="handleSetManagerMode"
      @approve-intent="handleApproveIntent"
      @deny-intent="handleDenyIntent"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  DesktopAgentPresence,
  DesktopBoardSettingsSummary,
  DesktopTaskCreateInput,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import {
  type BoardEmptyStateAction,
} from "./room-board/board-presentation";
import { activeBoardManagerAgents } from "./room-board/governance-presentation";
import RoomBoardCreateTaskDialog from "./room-board/RoomBoardCreateTaskDialog.vue";
import RoomBoardEmptyState from "./room-board/RoomBoardEmptyState.vue";
import RoomBoardGovernancePanel from "./room-board/RoomBoardGovernancePanel.vue";
import RoomBoardKanban from "./room-board/RoomBoardKanban.vue";
import RoomBoardTaskDialog from "./room-board/RoomBoardTaskDialog.vue";
import RoomBoardToolbar from "./room-board/RoomBoardToolbar.vue";
import type { TaskAction } from "./room-board/types";
import { useBoardGovernance } from "./room-board/useBoardGovernance";
import { useRoomBoardController } from "./room-board/useRoomBoardController";
import { useRoomBoardPresentation } from "./room-board/useRoomBoardPresentation";

const props = defineProps<{
  roomIdentifier: string;
  tasks: DesktopTaskSummary[];
  boardSettings?: DesktopBoardSettingsSummary | null;
  presence: DesktopAgentPresence[];
  workers: WorkerSnapshot[];
  selectedTaskId?: string | null;
}>();

const emit = defineEmits<{
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [];
  "update:selected-task-id": [taskId: string | null];
  "view-events": [taskId: string];
  "view-artifacts": [taskId: string];
}>();

const {
  actionsFor,
  addTask,
  assignReview,
  busyAction,
  errorMessage,
  reviewAssignmentCandidates,
  runTaskAction,
  selectedReviewerByTask,
  setSelectedReviewer,
} = useRoomBoardController(props, emit);

const {
  activeFilter,
  clearTaskSelection,
  collapsedGroups,
  emptyState,
  filterOptions,
  localSelectedTaskId,
  modalTask,
  runEmptyStateAction,
  searchQuery,
  selectTask,
  setActiveFilter,
  toggleGroup,
  visibleGroups,
  visibleTaskCount,
} = useRoomBoardPresentation(props, emit);

const isCreateTaskDialogOpen = ref(false);
const modalTaskActions = computed(() => modalTask.value ? actionsFor(modalTask.value) : []);
const modalReviewAssignmentCandidates = computed(() =>
  modalTask.value ? reviewAssignmentCandidates(modalTask.value) : []
);
const modalSelectedReviewer = computed(() =>
  modalTask.value ? selectedReviewerByTask.value[modalTask.value.id] || "" : ""
);

const {
  governanceOpen,
  governanceLoading,
  governanceBusy,
  governanceError,
  governance,
  activeSection: activeGovernanceSection,
  selectedCandidateId,
  sections: governanceSections,
  openGovernance,
  closeGovernance,
  assignManager,
  releaseManager,
  setManagerMode,
  decideIntent,
} = useBoardGovernance(props.roomIdentifier);

const liveBoardManagerAgents = computed(() => activeBoardManagerAgents(props.presence));
const boardManagerMode = computed(() => props.boardSettings?.managerMode || "manager_optional");
const boardPendingIntentCount = computed(() =>
  Math.max(0, props.boardSettings?.pendingIntentCount || 0)
);
const boardManagerLabel = computed(() => {
  const settings = props.boardSettings;
  if (boardManagerMode.value === "off") return "Manager off";
  if (settings?.activeManager) {
    const source = settings.activeManager.runtimeSource;
    if (source === "open_model") return "Open model manager";
    if (source === "desktop_managed") return "Desktop manager";
    return "Board manager";
  }
  return boardManagerMode.value === "intent_required"
    ? "Approval required"
    : "Manager optional";
});
const boardManagerTitle = computed(() => {
  const settings = props.boardSettings;
  const pending = boardPendingIntentCount.value;
  const pendingText = pending === 1 ? "1 pending intent" : `${pending} pending intents`;
  if (!settings?.activeManager) return `${boardManagerLabel.value}. ${pendingText}.`;
  return `${boardManagerLabel.value}: ${settings.activeManager.actorLabel}. ${pendingText}.`;
});

function openCreateTaskDialog(): void {
  if (localSelectedTaskId.value) clearTaskSelection();
  isCreateTaskDialogOpen.value = true;
}

function closeCreateTaskDialog(): void {
  if (busyAction.value === null) isCreateTaskDialogOpen.value = false;
}

async function submitCreateTask(input: DesktopTaskCreateInput): Promise<void> {
  if (await addTask(input)) isCreateTaskDialogOpen.value = false;
}

function handleEmptyStateAction(action: BoardEmptyStateAction): void {
  if (runEmptyStateAction(action) === "add-task") openCreateTaskDialog();
}

function handleRunTaskAction(task: DesktopTaskSummary, action: TaskAction): void {
  void runTaskAction(task, action);
}

function assignModalReview(): void {
  if (modalTask.value) void assignReview(modalTask.value);
}

function runModalTaskAction(action: TaskAction): void {
  if (modalTask.value) void runTaskAction(modalTask.value, action);
}

function setModalReviewer(value: string): void {
  if (modalTask.value) setSelectedReviewer(modalTask.value.id, value);
}

async function handleAssignManager(agentSessionId: string): Promise<void> {
  await assignManager(agentSessionId);
  emit("refresh-room");
}

async function handleReleaseManager(): Promise<void> {
  await releaseManager();
  emit("refresh-room");
}

async function handleSetManagerMode(mode: "off" | "manager_optional" | "intent_required"): Promise<void> {
  await setManagerMode(mode);
  emit("refresh-room");
}

async function handleApproveIntent(intentId: string): Promise<void> {
  await decideIntent(intentId, "approve");
  emit("refresh-room");
}

async function handleDenyIntent(intentId: string): Promise<void> {
  await decideIntent(intentId, "deny");
  emit("refresh-room");
}
</script>
