import { computed } from "vue";
import type { DesktopFocusRoomInfo } from "../../../../electron/ipc-types";
import type { RoomEntry } from "../../components/desktop/types";
import type {
  FocusRoomConcludedEvent,
  FocusRoomConclusionInput,
} from "../../domain/focus-room-conclusion";
import { normalizeRoomIdentifier, findSidebarRoomEntryByIdentifier } from "../../domain/sidebar-rooms";
import type { AppContextOf } from "./context";

/** Concluding a Focus Room from the sidebar or the room details. */
export function useAppFocusRoomConclusion(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppRoomContext"
    | "useAppRoomData"
    | "useAppRoomManagement"
    | "useAppSidebarSelection"
    | "useAppState"
  >;
  const {
    authStatus, sidebarFocusRoomConclusionError, sidebarFocusRoomConclusionParent,
    sidebarFocusRoomConclusionPendingToast, sidebarFocusRoomConclusionReturnFocusId,
    sidebarFocusRoomConclusionTarget,
  } = app;
  async function handleRoomDetailsFocusRoomConcluded(event: FocusRoomConcludedEvent): Promise<void> {
    const focusRoomIdentifier = normalizeRoomIdentifier(event.focusRoomIdentifier);
    const parentRoomIdentifier = normalizeRoomIdentifier(event.parentRoomIdentifier);
    const targetWasActive = app.activeEntry.value.type === "room"
      && normalizeRoomIdentifier(app.activeEntry.value.roomIdentifier) === focusRoomIdentifier;
    const parentBeforeRefresh = findSidebarRoomEntryByIdentifier(
      app.projectEntries.value,
      parentRoomIdentifier,
    );

    let refreshError: unknown = null;
    try {
      await app.refresh();
    } catch (error) {
      refreshError = error;
    }

    if (targetWasActive) {
      const parentAfterRefresh = findSidebarRoomEntryByIdentifier(
        app.projectEntries.value,
        parentRoomIdentifier,
      ) || parentBeforeRefresh;
      if (parentAfterRefresh) app.handleSidebarEntrySelected(parentAfterRefresh);
    }

    if (refreshError) {
      app.pushActionToast(
        `${event.displayName} concluded, but the room list could not be refreshed.`,
        "error",
      );
      return;
    }
    app.pushActionToast(`${event.displayName} concluded.`, "success");
  }

  const sidebarFocusRoomConclusionBusy = computed(() => {
    const target = sidebarFocusRoomConclusionTarget.value;
    if (!target) return false;
    return app.settingsRoomActionBusyKey.value
      === `conclude-focus:${target.roomIdentifier || target.focusKey}`;
  });

  function openSidebarFocusRoomConclusion(entry: RoomEntry): void {
    if (!authStatus.value?.authenticated) {
      app.pushActionToast("Connect GitHub from the account menu to conclude this Focus Room.", "info");
      return;
    }
    if (
      entry.kind !== "focus"
      || entry.focusStatus === "concluded"
      || !entry.focusKey
      || !entry.parentRoomIdentifier
    ) return;

    sidebarFocusRoomConclusionTarget.value = entry;
    sidebarFocusRoomConclusionParent.value = findSidebarRoomEntryByIdentifier(
      app.projectEntries.value,
      entry.parentRoomIdentifier,
    );
    sidebarFocusRoomConclusionReturnFocusId.value = entry.id;
    sidebarFocusRoomConclusionError.value = null;
    sidebarFocusRoomConclusionPendingToast.value = null;
  }

  function openRoomDetailsFocusRoomConclusion(focusRoom: DesktopFocusRoomInfo): void {
    const focusRoomIdentifier = normalizeRoomIdentifier(focusRoom.identifier || focusRoom.roomId);
    const parentRoomIdentifier = normalizeRoomIdentifier(focusRoom.parentRoomId);
    const entry = app.projectEntries.value
      .flatMap((project) => project.focusRooms)
      .find((candidate) => {
        if (
          focusRoomIdentifier
          && normalizeRoomIdentifier(candidate.roomIdentifier) === focusRoomIdentifier
        ) return true;
        return Boolean(
          focusRoom.focusKey
          && candidate.focusKey === focusRoom.focusKey
          && normalizeRoomIdentifier(candidate.parentRoomIdentifier) === parentRoomIdentifier
        );
      });
    if (!entry) {
      app.pushActionToast("This focus room is no longer available to conclude.", "error");
      return;
    }
    openSidebarFocusRoomConclusion(entry);
  }

  function closeSidebarFocusRoomConclusion(): void {
    if (sidebarFocusRoomConclusionBusy.value) return;
    sidebarFocusRoomConclusionTarget.value = null;
    sidebarFocusRoomConclusionError.value = null;
    sidebarFocusRoomConclusionPendingToast.value = null;
  }

  async function submitSidebarFocusRoomConclusion(input: FocusRoomConclusionInput): Promise<void> {
    const target = sidebarFocusRoomConclusionTarget.value;
    if (!target || sidebarFocusRoomConclusionBusy.value) return;

    const parent = sidebarFocusRoomConclusionParent.value;
    const targetWasActive = app.activeEntry.value.id === target.id;
    sidebarFocusRoomConclusionError.value = null;
    const result = await app.concludeSidebarFocusRoom(target, input);
    if (!result.ok) {
      sidebarFocusRoomConclusionError.value = result.error;
      return;
    }

    sidebarFocusRoomConclusionReturnFocusId.value = parent?.id || null;
    const displayName = target.title || "Focus room";
    sidebarFocusRoomConclusionPendingToast.value = result.refreshError
      ? {
          message: `${displayName} concluded, but the room list could not be refreshed: ${result.refreshError}`,
          state: "error",
        }
      : { message: `${displayName} concluded.`, state: "success" };
    sidebarFocusRoomConclusionTarget.value = null;
    if (targetWasActive && parent) {
      app.handleSidebarEntrySelected(parent);
    }
  }

  function handleSidebarFocusRoomConclusionAfterLeave(): void {
    const toast = sidebarFocusRoomConclusionPendingToast.value;
    sidebarFocusRoomConclusionPendingToast.value = null;
    if (toast) app.pushActionToast(toast.message, toast.state);
  }
  return {
    handleRoomDetailsFocusRoomConcluded, sidebarFocusRoomConclusionBusy,
    openSidebarFocusRoomConclusion, openRoomDetailsFocusRoomConclusion,
    closeSidebarFocusRoomConclusion, submitSidebarFocusRoomConclusion,
    handleSidebarFocusRoomConclusionAfterLeave,
  };
}
