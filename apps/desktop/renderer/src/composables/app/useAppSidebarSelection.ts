import { computed, watch } from "vue";
import type { DesktopRoomStorageState } from "../../../../electron/ipc-types";
import type { RoomEntry, SidebarEntry } from "../../components/desktop/types";
import type { SidebarRoomBatchMutationResult } from "../useDesktopAccountRoomSettings";
import { useDesktopUnreadCounts } from "../useDesktopUnreadCounts";
import { roomReadKey, roomReadMarkerKey } from "../../domain/desktop-room-read-state";
import { normalizeRoomIdentifier, findSidebarRoomEntryByIdentifier } from "../../domain/sidebar-rooms";
import {
  flattenSidebarRoomEntries,
  isSidebarRoomSelectable,
  resolveSidebarRoomBatchAction,
  type SidebarRoomBatchActionId,
} from "../../domain/sidebar-room-selection";
import { applySidebarRoomOrder } from "../../domain/sidebar-room-order";
import type { AppContextOf } from "./context";

/** Sidebar entry selection, multi-select, and batch room actions. */
export function useAppSidebarSelection(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppRoomContext"
    | "useAppSidebarEntries"
    | "useAppSidebarMessages"
    | "useAppState"
    | "appVuePending"
  >;
  const {
    authStatus, sidebarBatchActionBusy, sidebarBatchDialogAction, sidebarBatchDialogError,
    sidebarBatchDialogTargets, sidebarBatchPendingToast, sidebarSelectedEntryIds,
    sidebarSelectionActive,
  } = app;
  function handleSidebarEntrySelected(entry: SidebarEntry): void {
    if (sidebarSelectionActive.value) cancelSidebarRoomSelection();
    app.selectSidebarEntry(entry);
  }

  function startSidebarRoomSelection(entry?: RoomEntry): void {
    sidebarSelectionActive.value = true;
    sidebarBatchDialogError.value = null;
    if (!entry || !isSidebarRoomSelectable(entry)) return;
    if (!sidebarSelectedEntryIds.value.includes(entry.id)) {
      sidebarSelectedEntryIds.value = [...sidebarSelectedEntryIds.value, entry.id];
    }
  }

  function cancelSidebarRoomSelection(): void {
    if (sidebarBatchActionBusy.value) return;
    sidebarSelectionActive.value = false;
    sidebarSelectedEntryIds.value = [];
    closeSidebarBatchDialog();
  }

  function toggleSidebarRoomSelection(entryId: string): void {
    const selected = new Set(sidebarSelectedEntryIds.value);
    if (selected.has(entryId)) selected.delete(entryId);
    else selected.add(entryId);
    sidebarSelectedEntryIds.value = [...selected];
  }

  function setSidebarRoomSelection(entryIds: string[], selected: boolean): void {
    const next = new Set(sidebarSelectedEntryIds.value);
    for (const entryId of entryIds) {
      if (selected) next.add(entryId);
      else next.delete(entryId);
    }
    sidebarSelectedEntryIds.value = [...next];
  }

  function openFocusRoomFromRoomsTab(roomIdentifier: string): void {
    const normalizedIdentifier = normalizeRoomIdentifier(roomIdentifier);
    if (!normalizedIdentifier) return;
    const existingFocusRoom = app.projectEntries.value
      .flatMap(app.projectChildRooms)
      .find((entry) => normalizeRoomIdentifier(entry.roomIdentifier) === normalizedIdentifier);
    if (existingFocusRoom) {
      handleSidebarEntrySelected(existingFocusRoom);
      return;
    }

    const fallbackEntry: RoomEntry = {
      id: `room:focus:${normalizedIdentifier}`,
      type: "room",
      kind: "focus",
      roomIdentifier,
      title: roomIdentifier,
      meta: "Focus room",
      sectionLabel: "Focus room",
      headline: "Focused work",
      description: "Open this focus room.",
      latestMessageId: null,
      latestMessageAt: null,
      hasUnread: false,
      pinned: false,
      source: "account",
    };
    handleSidebarEntrySelected(fallbackEntry);
  }

  async function handleSidebarBatchAction(action: SidebarRoomBatchActionId): Promise<void> {
    if (sidebarBatchActionBusy.value) return;
    if (action !== "mark-read" && !authStatus.value?.authenticated) {
      app.pushActionToast("Connect GitHub from the account menu to manage rooms.", "info");
      return;
    }
    const resolution = resolveSidebarRoomBatchAction({
      action,
      entries: app.sidebarSelectedEntries.value,
      primaryRoomId: app.currentParentRoom.value.id,
    });
    if (!resolution.targets.length) return;

    if (action === "mark-read") {
      resolution.targets.forEach(entry => app.markRoomEntryRead(entry, true));
      app.pushActionToast(
        `${resolution.targets.length} ${resolution.targets.length === 1 ? "room" : "rooms"} marked as read.`,
        "success",
      );
      return;
    }

    if (action === "pin") {
      sidebarBatchActionBusy.value = action;
      const result = await app.batchSetSidebarRoomsPinned(
        resolution.targets,
        resolution.pinned === true,
      );
      sidebarBatchActionBusy.value = null;
      if (result.refreshError) {
        const succeededIds = new Set(result.succeededEntryIds);
        sidebarSelectedEntryIds.value = sidebarSelectedEntryIds.value.filter(
          (entryId) => !succeededIds.has(entryId),
        );
        if (!sidebarSelectedEntryIds.value.length) sidebarSelectionActive.value = false;
      }
      reportSidebarBatchMutation(
        result,
        resolution.targets.length,
        resolution.pinned ? "pinned" : "unpinned",
      );
      return;
    }

    sidebarBatchDialogAction.value = action;
    sidebarBatchDialogTargets.value = resolution.targets;
    sidebarBatchDialogError.value = null;
  }

  function closeSidebarBatchDialog(): void {
    if (sidebarBatchActionBusy.value) return;
    sidebarBatchDialogAction.value = null;
    sidebarBatchDialogTargets.value = [];
    sidebarBatchDialogError.value = null;
    sidebarBatchPendingToast.value = null;
  }

  async function confirmSidebarBatchAction(): Promise<void> {
    const action = sidebarBatchDialogAction.value;
    const targets = [...sidebarBatchDialogTargets.value];
    if (!action || sidebarBatchActionBusy.value || !targets.length) return;

    const activeTarget = targets.find((entry) =>
      app.activeEntry.value.id === entry.id
      || (
        app.activeEntry.value.type === "room"
        && normalizeRoomIdentifier(app.activeEntry.value.roomIdentifier)
          === normalizeRoomIdentifier(entry.roomIdentifier)
      )
    ) || null;
    const parentBeforeRefresh = activeTarget?.parentRoomIdentifier
      ? findSidebarRoomEntryByIdentifier(app.projectEntries.value, activeTarget.parentRoomIdentifier)
      : null;

    sidebarBatchActionBusy.value = action;
    sidebarBatchDialogError.value = null;
    let result: SidebarRoomBatchMutationResult;
    try {
      result = action === "conclude"
        ? await app.batchConcludeSidebarFocusRooms(targets)
        : await app.batchHideSidebarRooms(targets);
    } catch (caught) {
      sidebarBatchActionBusy.value = null;
      sidebarBatchDialogError.value = caught instanceof Error
        ? caught.message
        : `The selected rooms could not be ${action === "conclude" ? "concluded" : "hidden"}.`;
      return;
    }
    sidebarBatchActionBusy.value = null;
    sidebarBatchDialogAction.value = null;
    sidebarBatchDialogTargets.value = [];

    const succeededIds = new Set(result.succeededEntryIds);
    if (activeTarget && succeededIds.has(activeTarget.id)) {
      if (activeTarget.kind === "focus") {
        const parent = activeTarget.parentRoomIdentifier
          ? findSidebarRoomEntryByIdentifier(app.projectEntries.value, activeTarget.parentRoomIdentifier)
            || parentBeforeRefresh
          : parentBeforeRefresh;
        if (parent) {
          app.markRoomEntryRead(parent);
          app.selectSidebarEntry(parent);
        }
      } else if (action === "hide" && activeTarget.roomIdentifier) {
        await app.leaveArchivedRoomIfActive(activeTarget.roomIdentifier, activeTarget.title);
      }
    }

    sidebarSelectedEntryIds.value = sidebarSelectedEntryIds.value.filter(
      (entryId) => !succeededIds.has(entryId),
    );
    if (!sidebarSelectedEntryIds.value.length) sidebarSelectionActive.value = false;
    reportSidebarBatchMutation(
      result,
      targets.length,
      action === "conclude" ? "concluded" : "hidden",
      true,
    );
  }

  function reportSidebarBatchMutation(
    result: SidebarRoomBatchMutationResult,
    targetCount: number,
    completedVerb: string,
    deferUntilDialogLeaves = false,
  ): void {
    const completed = result.succeededEntryIds.length;
    const partiallyCompleted = result.partiallySucceededEntryIds.length;
    const roomNoun = targetCount === 1 ? "room" : "rooms";
    if (!result.failures.length && !result.refreshError) {
      deliverSidebarBatchToast(
        `${completed} ${completed === 1 ? "room" : "rooms"} ${completedVerb}.`,
        "success",
        deferUntilDialogLeaves,
      );
      return;
    }

    const parts = [`${completed} of ${targetCount} ${roomNoun} ${completedVerb}.`];
    if (partiallyCompleted) {
      parts.push(
        `${partiallyCompleted} ${partiallyCompleted === 1 ? "room was" : "rooms were"} partially updated.`,
      );
    }
    if (result.failures.length) {
      parts.push(`${result.failures.length} failed: ${result.failures[0]?.message || "Unknown error"}`);
    }
    if (result.refreshError) {
      parts.push(`The sidebar could not refresh: ${result.refreshError}`);
    }
    deliverSidebarBatchToast(parts.join(" "), "error", deferUntilDialogLeaves);
  }

  function deliverSidebarBatchToast(
    message: string,
    state: "error" | "success",
    deferUntilDialogLeaves: boolean,
  ): void {
    if (deferUntilDialogLeaves) {
      sidebarBatchPendingToast.value = { message, state };
      return;
    }
    app.pushActionToast(message, state);
  }

  function handleSidebarBatchDialogAfterLeave(): void {
    const toast = sidebarBatchPendingToast.value;
    sidebarBatchPendingToast.value = null;
    if (toast) app.pushActionToast(toast.message, toast.state);
  }
  return {
    handleSidebarEntrySelected, startSidebarRoomSelection, cancelSidebarRoomSelection,
    toggleSidebarRoomSelection, setSidebarRoomSelection, openFocusRoomFromRoomsTab,
    handleSidebarBatchAction, closeSidebarBatchDialog, confirmSidebarBatchAction,
    reportSidebarBatchMutation, deliverSidebarBatchToast, handleSidebarBatchDialogAfterLeave,
  };
}

/** Unread counts, the ordered sidebar projects, and the selected room's render key and storage. */
export function useAppSidebarEntries(context: unknown) {
  const app = context as AppContextOf<"useAppNavigation" | "useAppSidebarMessages" | "useAppState">;
  const {
    activeEntry, authStatus, chatStorageSettings, latestMessageAtForEntry, latestMessageIdForEntry,
    projectEntries, readRoomMessageIds, roomHistoryMode, selectedRoomIdentifier, selectedRoomInfo,
    selectedSnapshot, sidebarRoomIdentifiers, sidebarRoomOrder, sidebarSelectedEntryIds,
    sidebarSelectionActive, withRoomUnreadState,
  } = app;
  const { roomCounts: unreadRoomCounts, refresh: refreshUnreadCounts } = useDesktopUnreadCounts({
    account: computed(() => authStatus.value?.authenticated ? authStatus.value.account : null),
    rooms: computed(() => flattenSidebarRoomEntries(projectEntries.value).flatMap((entry) =>
      entry.roomIdentifier ? [{
        roomIdentifier: entry.roomIdentifier,
        latestMessageId: latestMessageIdForEntry(entry),
        latestMessageAt: latestMessageAtForEntry(entry),
      }] : [])),
    readMarkers: computed(() => Object.fromEntries(sidebarRoomIdentifiers().flatMap((identifier) => {
      const key = roomReadKey(identifier)!;
      const marker = readRoomMessageIds.value[roomReadMarkerKey(identifier, roomHistoryMode(identifier))!];
      return marker ? [[key, marker]] : [];
    }))),
    storageMode: computed(() => JSON.stringify([chatStorageSettings.value, sidebarRoomIdentifiers().map((id) => [id, roomHistoryMode(id)])])),
  });
  Object.assign(app, { unreadRoomCounts, refreshUnreadCounts });

  const sidebarProjectEntries = computed(() =>
    applySidebarRoomOrder(projectEntries.value.map((project) => ({
      ...project,
      parent: withRoomUnreadState(project.parent),
      branchRooms: project.branchRooms.map(withRoomUnreadState),
      focusRooms: project.focusRooms.map(withRoomUnreadState),
    })), sidebarRoomOrder.value)
  );
  Object.assign(app, { sidebarProjectEntries });
  const sidebarSelectedEntries = computed(() => {
    const selectedIds = new Set(sidebarSelectedEntryIds.value);
    return flattenSidebarRoomEntries(sidebarProjectEntries.value)
      .filter((entry, index, entries) =>
        selectedIds.has(entry.id)
        && entries.findIndex((candidate) => candidate.id === entry.id) === index
      );
  });
  Object.assign(app, { sidebarSelectedEntries });
  watch(sidebarProjectEntries, (projects) => {
    if (!sidebarSelectionActive.value || !sidebarSelectedEntryIds.value.length) return;
    const availableIds = new Set(flattenSidebarRoomEntries(projects).map((entry) => entry.id));
    const nextSelection = sidebarSelectedEntryIds.value.filter((entryId) => availableIds.has(entryId));
    if (nextSelection.length !== sidebarSelectedEntryIds.value.length) {
      sidebarSelectedEntryIds.value = nextSelection;
    }
  });
  const selectedRoomRenderKey = computed(() =>
    selectedRoomIdentifier.value
    || selectedSnapshot.value?.room?.identifier
    || selectedSnapshot.value?.roomIdentifier
    || selectedRoomInfo.value.identifier
    || activeEntry.value.id
  );
  const selectedRoomStorage = computed<DesktopRoomStorageState>(() =>
    selectedSnapshot.value?.storage || {
      roomIdentifier: selectedRoomInfo.value.identifier || null,
      defaultMode: chatStorageSettings.value?.defaultMode || chatStorageSettings.value?.mode || "cloud",
      overrideMode: "inherit",
      effectiveMode: chatStorageSettings.value?.mode || "cloud",
      isLocalRoom: false,
      localRoom: null,
      databasePath: chatStorageSettings.value?.databasePath || "",
      localFilesPath: chatStorageSettings.value?.localFilesPath || "",
    }
  );
  return {
    unreadRoomCounts, refreshUnreadCounts, sidebarProjectEntries, sidebarSelectedEntries,
    selectedRoomRenderKey, selectedRoomStorage,
  };
}
