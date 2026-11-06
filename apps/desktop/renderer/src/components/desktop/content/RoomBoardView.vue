<template>
  <section class="room-tab-page desktop-board-workspace-host" data-testid="room-board-view">
    <BoardWorkspace
      ref="workspace"
      :room-id="roomIdentifier"
      :tasks="workspaceTasks"
      :services="workspaceServices"
      :busy="busyAction !== null"
      :error="!modalTask && !isCreateTaskDialogOpen ? errorMessage : null"
      @select="handleSelectTask"
      @create="openCreateTaskDialog"
      @refresh="emit('refresh-room')"
    >
      <template #actions>
        <button type="button" class="board-host-manager" :title="boardManagerTitle" :aria-expanded="governanceOpen" @click="openGovernance">
          Manager<span v-if="pendingIntentCount" class="board-host-count">{{ pendingIntentCount }}</span>
        </button>
      </template>
    </BoardWorkspace>

    <RoomBoardTaskDialog
      :task="modalTask"
      :actions="modalTaskActions"
      :busy-action="busyAction"
      :error="errorMessage"
      :review-assignment-candidates="modalReviewAssignmentCandidates"
      :selected-reviewer="modalSelectedReviewer"
      :can-edit="canEditTasks"
      :room-identifier="roomIdentifier"
      :ticket-keys="ticketKeys"
      @save="saveModalTask"
      @close="clearTaskSelection"
      @assign-review="assignModalReview"
      @run-action="runModalTaskAction"
      @update:selected-reviewer="setModalReviewer"
      @view-events="emit('view-events', $event)"
      @view-artifacts="emit('view-artifacts', $event)"
      @open-thread="emit('open-thread', $event)"
    >
      <template #planning>
        <BoardTaskPlanning v-if="modalTask && workspace?.snapshot" :task-id="modalTask.id" :snapshot="workspace.snapshot" :save="workspace.savePlanning" />
      </template>
    </RoomBoardTaskDialog>

    <RoomBoardCreateTaskDialog
      :open="isCreateTaskDialogOpen"
      :planning-snapshot="workspace?.snapshot"
      :selected-sprint-id="workspace?.selectedSprintId"
      :busy-action="busyAction"
      :error="errorMessage"
      @close="closeCreateTaskDialog"
      @create="submitCreateTask"
    />

    <RoomBoardGovernancePanel
      :open="governanceOpen"
      :loading="governanceLoading"
      :busy="governanceBusy"
      :error="governanceError"
      :error-retryable="governanceErrorRetryable"
      :governance="governance"
      :sections="governanceSections"
      :active-section="activeGovernanceSection"
      :selected-candidate-id="selectedCandidateId"
      :live-agents="liveBoardManagerAgents"
      :show-ticket-settings="showTicketSettings"
      @close="closeGovernance"
      @open-ticket-settings="openTicketSettings"
      @update:active-section="activeGovernanceSection = $event"
      @update:selected-candidate-id="selectedCandidateId = $event"
      @assign-manager="handleAssignManager"
      @release-manager="handleReleaseManager"
      @set-manager-mode="handleSetManagerMode"
      @approve-intent="handleApproveIntent"
      @deny-intent="handleDenyIntent"
      @retry="loadGovernance"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import BoardWorkspace from "../../../../../../../shared/ui/board/BoardWorkspace.vue";
import BoardTaskPlanning from "../../../../../../../shared/ui/board/BoardTaskPlanning.vue";
import type { BoardPlanningDocument, BoardPlanningSnapshot, BoardTaskPlanning as BoardTaskPlanningFields } from "../../../../../../../shared/board-planning.mjs";
import type { BoardServices } from "../../../../../../../shared/ui/board/types";
import { desktopBridgeUpgradeMessage, desktopIpc } from "../../../ipc/index";
import { desktopBoardTask } from "./room-board/board-workspace-tasks";
import type { TaskEditPatch } from './room-board/ticket-ref';
import type {
  DesktopAgentPresence,
  DesktopBoardSettingsSummary,
  DesktopTaskCreateInput,
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import { activeBoardManagerAgents } from "./room-board/governance-presentation";
import { boardMayShowTicketSettings, roomShowsTicketSettings } from "./room-board/ticket-settings";
import RoomBoardCreateTaskDialog from "./room-board/RoomBoardCreateTaskDialog.vue";
import RoomBoardGovernancePanel from "./room-board/RoomBoardGovernancePanel.vue";
import RoomBoardTaskDialog from "./room-board/RoomBoardTaskDialog.vue";
import type { TaskAction } from "./room-board/types";
import { useBoardGovernance } from "./room-board/useBoardGovernance";
import { useRoomBoardController } from "./room-board/useRoomBoardController";

const props = defineProps<{
  /** Cloud rooms only: local rooms cannot store ticket keys. */
  ticketKeys?: boolean;
  roomIdentifier: string;
  tasks: DesktopTaskSummary[];
  boardSettings?: DesktopBoardSettingsSummary | null;
  presence: DesktopAgentPresence[];
  workers: WorkerSnapshot[];
  selectedTaskId?: string | null;
  /** Opens Manager at this section once, e.g. from an Inbox board request. */
  governanceSection?: "pending" | null;
  canEditTasks?: boolean;
}>();

const emit = defineEmits<{
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [];
  "update:selected-task-id": [taskId: string | null];
  "update:governance-section": [section: null];
  "view-events": [taskId: string];
  "view-artifacts": [taskId: string];
  "open-thread": [threadRootId: string];
  /** Opens Room settings at one section. */
  "open-room-settings": [section: "tickets"];
}>();

const {
  actionsFor,
  addTask,
  assignReview,
  busyAction,
  clearError,
  errorMessage,
  reviewAssignmentCandidates,
  runTaskAction,
  saveTaskContent,
  selectedReviewerByTask,
  setSelectedReviewer,
} = useRoomBoardController(props, emit);

const workspace = ref<{ snapshot: BoardPlanningSnapshot | null; selectedSprintId: string; applyCreatedPlanning: (id: string, planning: BoardTaskPlanningFields) => Promise<boolean>; savePlanning: (document: BoardPlanningDocument) => Promise<boolean>; revealTask?: (taskId: string) => Promise<void> } | null>(null);
const localSelectedTaskId = ref<string | null>(props.selectedTaskId || null);
const modalTask = computed(() => props.tasks.find(task => task.id === localSelectedTaskId.value) || null);
watch(() => props.selectedTaskId, value => { localSelectedTaskId.value = value || null; });
watch(() => props.roomIdentifier, () => { localSelectedTaskId.value = null; isCreateTaskDialogOpen.value = false; });
function selectTask(taskId: string): void {
  localSelectedTaskId.value = taskId;
  emit("update:selected-task-id", taskId);
}
function clearTaskSelection(): void {
  const taskId = localSelectedTaskId.value;
  localSelectedTaskId.value = null;
  emit("update:selected-task-id", null);
  if (taskId) void workspace.value?.revealTask?.(taskId);
}
const workspaceTasks = computed(() => props.tasks.map(task => desktopBoardTask(task, props.presence, actionsFor(task))));
const workspaceServices: BoardServices = {
  loadPlanning: () => {
    const read = desktopIpc.room?.getBoardPlanning;
    if (!read) return Promise.reject(new Error(desktopBridgeUpgradeMessage()));
    return read(props.roomIdentifier);
  },
  savePlanning: (expectedRevision, document) => {
    const save = desktopIpc.room?.updateBoardPlanning;
    if (!save) return Promise.reject(new Error(desktopBridgeUpgradeMessage()));
    return save(props.roomIdentifier, { expectedRevision, document });
  },
  moveTask: async (taskId, transitionId) => {
    const task = props.tasks.find(candidate => candidate.id === taskId);
    const action = task && actionsFor(task).find(candidate => candidate.id === transitionId && candidate.targetStatus);
    return Boolean(task && action && await runTaskAction(task, action));
  },
  openExternal: url => desktopIpc.app.openExternalUrl(url),
};

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
  governanceErrorRetryable,
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
  loadGovernance,
  pendingIntentCount,
} = useBoardGovernance(props.roomIdentifier, () => props.boardSettings);

watch(() => props.governanceSection, (section) => {
  if (!section) return;
  activeGovernanceSection.value = section;
  emit("update:governance-section", null);
  void openGovernance();
}, { immediate: true });

// Board manager links to the room's ticket filters only where Room settings shows them.
const showTicketSettings = ref(false);
let ticketSettingsCheck = 0;
watch(() => [governanceOpen.value, props.roomIdentifier, props.ticketKeys] as const, async ([open, roomIdentifier, ticketKeys]) => {
  // Hidden until this room's answer arrives; a later check makes an earlier one stale.
  const check = ++ticketSettingsCheck;
  showTicketSettings.value = false;
  if (!open || !ticketKeys || !boardMayShowTicketSettings(props.tasks)) return;
  const shows = await roomShowsTicketSettings(roomIdentifier);
  if (check === ticketSettingsCheck) showTicketSettings.value = shows;
}, { immediate: true });

function openTicketSettings(): void {
  closeGovernance();
  emit("open-room-settings", "tickets");
}

const liveBoardManagerAgents = computed(() => activeBoardManagerAgents(props.presence));
const boardManagerMode = computed(() => props.boardSettings?.managerMode || "manager_optional");
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
  const pending = pendingIntentCount.value;
  const pendingText = pending === 1 ? "1 pending intent" : `${pending} pending intents`;
  if (!settings?.activeManager) return `${boardManagerLabel.value}. ${pendingText}.`;
  return `${boardManagerLabel.value}: ${settings.activeManager.actorLabel}. ${pendingText}.`;
});

function openCreateTaskDialog(): void {
  if (localSelectedTaskId.value) clearTaskSelection();
  clearError();
  isCreateTaskDialogOpen.value = true;
}

function closeCreateTaskDialog(): void {
  if (busyAction.value === null) isCreateTaskDialogOpen.value = false;
}

async function submitCreateTask(input: DesktopTaskCreateInput & { planning?: BoardTaskPlanningFields }): Promise<void> {
  const room = props.roomIdentifier;
  const taskId = await addTask(input);
  if (!taskId || props.roomIdentifier !== room) return;
  isCreateTaskDialogOpen.value = false;
  await nextTick();
  selectTask(taskId);
  await nextTick();
  if (input.planning && !await workspace.value?.applyCreatedPlanning(taskId, input.planning)) {
    if (props.roomIdentifier !== room) return;
    errorMessage.value = "Task created, but its planning was not saved. Set it in this panel.";
  }
  if (props.roomIdentifier === room) await workspace.value?.revealTask?.(taskId);
}

function handleSelectTask(taskId: string): void {
  clearError();
  selectTask(taskId);
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

async function saveModalTask(input: TaskEditPatch, onSettled: (saved: boolean) => void): Promise<void> {
  const task = modalTask.value;
  onSettled(Boolean(task && await saveTaskContent(task, input)));
}

async function handleAssignManager(agentSessionId: string): Promise<void> {
  if (await assignManager(agentSessionId)) emit("refresh-room");
}

async function handleReleaseManager(): Promise<void> {
  if (await releaseManager()) emit("refresh-room");
}

async function handleSetManagerMode(mode: "off" | "manager_optional" | "intent_required"): Promise<void> {
  if (await setManagerMode(mode)) emit("refresh-room");
}

async function handleApproveIntent(intentId: string): Promise<void> {
  if (await decideIntent(intentId, "approve")) emit("refresh-room");
}

async function handleDenyIntent(intentId: string, reason: string | null): Promise<void> {
  if (await decideIntent(intentId, "deny", reason)) emit("refresh-room");
}
</script>

<style scoped>
.desktop-board-workspace-host { display: flex; min-height: 0; min-width: 0; overflow: hidden; padding: 0; }
.board-host-manager { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
.board-host-manager:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.board-host-count { min-width: 18px; padding: 1px 5px; border-radius: 5px; background: var(--bg-elevated); font-size: 11px; }
</style>
