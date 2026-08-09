import { computed, ref, watch } from "vue";
import type {
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../../electron/ipc-types";
import {
  BOARD_FILTERS,
  boardEmptyState,
  boardFilterCount,
  isBoardFilter,
  visibleBoardGroups,
  type BoardEmptyStateAction,
  type BoardFilter,
} from "./board-presentation";
import { findLocalRoomWorker } from "./board-workers";

interface RoomBoardPresentationProps {
  roomIdentifier: string;
  tasks: DesktopTaskSummary[];
  workers: WorkerSnapshot[];
  selectedTaskId?: string | null;
}

type RoomBoardPresentationEmit = {
  (event: "update:selected-task-id", taskId: string | null): void;
};

export function useRoomBoardPresentation(
  props: RoomBoardPresentationProps,
  emit: RoomBoardPresentationEmit
) {
  const searchQuery = ref("");
  const activeFilter = ref<BoardFilter>("open");
  const localSelectedTaskId = ref<string | null>(props.selectedTaskId || null);
  const collapsedGroups = ref(new Set<string>());

  const localWorker = computed(() =>
    findLocalRoomWorker(props.workers, props.roomIdentifier)
  );
  const visibleGroups = computed(() => visibleBoardGroups({
    tasks: props.tasks,
    filter: activeFilter.value,
    searchQuery: searchQuery.value,
    localWorker: localWorker.value,
  }));
  const visibleTasks = computed(() =>
    visibleGroups.value.flatMap((group) => group.tasks)
  );
  const visibleTaskCount = computed(() => visibleTasks.value.length);
  const filterOptions = computed(() => BOARD_FILTERS.map((filter) => ({
    ...filter,
    count: boardFilterCount(props.tasks, filter.id, localWorker.value),
  })));
  const emptyState = computed(() => boardEmptyState({
    taskCount: props.tasks.length,
    hasSearchQuery: Boolean(searchQuery.value.trim()),
    filter: activeFilter.value,
    closeoutTaskCount: boardFilterCount(props.tasks, "closeout", localWorker.value),
  }));
  const modalTask = computed(() =>
    visibleTasks.value.find((task) => task.id === localSelectedTaskId.value)
    || props.tasks.find((task) => task.id === localSelectedTaskId.value)
    || null
  );

  watch(() => props.selectedTaskId || null, (taskId) => {
    localSelectedTaskId.value = taskId;
  });

  function selectTask(taskId: string): void {
    localSelectedTaskId.value = taskId;
    emit("update:selected-task-id", taskId);
  }

  function clearTaskSelection(): void {
    localSelectedTaskId.value = null;
    emit("update:selected-task-id", null);
  }

  function setActiveFilter(filter: string): void {
    if (isBoardFilter(filter)) activeFilter.value = filter;
  }

  function toggleGroup(status: string): void {
    const next = new Set(collapsedGroups.value);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    collapsedGroups.value = next;
  }

  function runEmptyStateAction(action: BoardEmptyStateAction): "add-task" | null {
    if (action === "clear-search") {
      searchQuery.value = "";
      return null;
    }
    if (action === "show-open") {
      activeFilter.value = "open";
      return null;
    }
    if (action === "show-closeout") {
      activeFilter.value = "closeout";
      return null;
    }
    return "add-task";
  }

  return {
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
  };
}
