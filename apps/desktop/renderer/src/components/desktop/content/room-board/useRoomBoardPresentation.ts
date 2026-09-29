import { computed, ref, watch } from "vue";
import type {
  DesktopTaskSummary,
  WorkerSnapshot,
} from "../../../../../../electron/ipc-types";
import {
  BOARD_FILTERS,
  CLOSEOUT_BOARD_STATUSES,
  boardEmptyState,
  boardFilterCount,
  boardOwnerOptions,
  boardStatusOptions,
  isBoardFilter,
  visibleBoardGroups,
  type BoardEmptyStateAction,
  type BoardFilter,
  type BoardSort,
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
  const ownerFilter = ref("all");
  const statusFilter = ref("all");
  const sort = ref<BoardSort>("recent");
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
    ownerFilter: ownerFilter.value,
    statusFilter: statusFilter.value,
    sort: sort.value,
  }));
  const visibleTasks = computed(() =>
    visibleGroups.value.flatMap((group) => group.tasks)
  );
  const visibleTaskCount = computed(() => visibleTasks.value.length);
  const ownerOptions = computed(() => boardOwnerOptions(props.tasks));
  const statusOptions = computed(() => boardStatusOptions());
  const filterOptions = computed(() => BOARD_FILTERS.map((filter) => ({
    ...filter,
    count: boardFilterCount(props.tasks, filter.id, localWorker.value),
  })));
  const emptyState = computed(() => boardEmptyState({
    taskCount: props.tasks.length,
    hasSearchQuery: Boolean(searchQuery.value.trim()),
    filter: activeFilter.value,
    closeoutTaskCount: boardFilterCount(props.tasks, "closeout", localWorker.value),
    hasFilters: activeFilter.value !== "open" || ownerFilter.value !== "all" || statusFilter.value !== "all" || Boolean(searchQuery.value.trim()),
  }));
  const modalTask = computed(() =>
    visibleTasks.value.find((task) => task.id === localSelectedTaskId.value)
    || props.tasks.find((task) => task.id === localSelectedTaskId.value)
    || null
  );

  watch(() => props.selectedTaskId || null, (taskId) => {
    localSelectedTaskId.value = taskId;
  });

  watch(() => props.roomIdentifier, () => {
    searchQuery.value = "";
    activeFilter.value = "open";
    ownerFilter.value = "all";
    statusFilter.value = "all";
    sort.value = "recent";
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
    if (!isBoardFilter(filter)) return;
    activeFilter.value = filter;
    statusFilter.value = "all";
  }

  function setStatusFilter(value: string): void {
    if (!statusOptions.value.some((option) => option.id === value)) return;
    statusFilter.value = value;
    if (value !== "all") {
      activeFilter.value = CLOSEOUT_BOARD_STATUSES.some((status) => status === value) ? "closeout" : "open";
    }
  }

  function setSort(value: string): void {
    if (value === "recent" || value === "oldest" || value === "title") sort.value = value;
  }

  function toggleGroup(status: string): void {
    const next = new Set(collapsedGroups.value);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    collapsedGroups.value = next;
  }

  function clearFilters(): void {
    searchQuery.value = "";
    ownerFilter.value = "all";
    statusFilter.value = "all";
    activeFilter.value = props.tasks.length > 0 && boardFilterCount(props.tasks, "open", localWorker.value) === 0
      ? "closeout" : "open";
  }

  function runEmptyStateAction(action: BoardEmptyStateAction): "add-task" | null {
    if (action === "clear-filters") {
      clearFilters();
      return null;
    }
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
    clearFilters,
    clearTaskSelection,
    collapsedGroups,
    emptyState,
    filterOptions,
    localSelectedTaskId,
    modalTask,
    ownerFilter,
    ownerOptions,
    runEmptyStateAction,
    searchQuery,
    selectTask,
    setActiveFilter,
    setSort,
    setStatusFilter,
    sort,
    statusFilter,
    statusOptions,
    toggleGroup,
    visibleGroups,
    visibleTaskCount,
  };
}
