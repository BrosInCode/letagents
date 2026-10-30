import { computed, nextTick, ref, watch } from "vue";
import { reopenedSettingsPane } from "../../components/desktop/settings/navigation";
import type { SettingsPaneId } from "../../components/desktop/settings/types";
import { settingsEntry } from "../../domain/desktop-navigation";
import { rememberStoredString } from "../../domain/desktop-storage";
import {
  rememberSidebarRoomOrder,
  reorderSidebarChildRooms,
  reorderSidebarParentRooms,
  type SidebarChildRoomReorder,
  type SidebarParentRoomReorder,
} from "../../domain/sidebar-room-order";
import type { AppContextOf } from "./context";

/** Sidebar layout: visibility, width and resizing, project collapse and room order, and the settings surface. */
export function useAppSidebarLayout(context: unknown) {
  const app = context as AppContextOf<
      "useAppNavigation"
    | "useAppSidebarEntries"
    | "useAppSidebarSelection"
    | "useAppState"
  >;
  const {
    clampSidebarWidth, isSidebarResizing, requestedSettingsPane, sidebarBatchActionBusy,
    sidebarMaxWidth, sidebarMinWidth, sidebarRoomOrder, sidebarRoomOrderStorageKey,
    sidebarSelectionActive, sidebarWidth, sidebarWidthStorageKey,
  } = app;
  const isSettingsSurface = computed(() => app.activeEntry.value.type === "system");
  const showSidebarResizeHandle = computed(() => !isSettingsSurface.value && app.sidebarMode.value === "expanded");
  const desktopShellStyle = computed(() => ({
    "--sidebar-width": `${sidebarWidth.value}px`,
    "--sidebar-min-width": `${sidebarMinWidth}px`,
    "--sidebar-max-width": `${sidebarMaxWidth}px`,
  }));

  async function cycleSidebar(): Promise<void> {
    const hidingSidebar = app.sidebarMode.value !== "hidden";
    if (hidingSidebar && sidebarBatchActionBusy.value) return;
    if (hidingSidebar && sidebarSelectionActive.value) app.cancelSidebarRoomSelection();
    app.toggleSidebarMode();
    if (!hidingSidebar) return;

    await nextTick();
    document.querySelector<HTMLElement>(
      '[data-testid="room-sidebar-reveal-button"], [data-testid="auth-sidebar-reveal-button"], [data-testid="sidebar-reveal-button"]',
    )?.focus({ preventScroll: true });
  }

  // The last pane is read once each time the active entry changes (see
  // useAppSettingsPaneWatcher), never while Settings stays open: Settings itself
  // writes it, and a live read would feed its own choice back as a new initial pane.
  const settingsReopenPane = ref<SettingsPaneId>(reopenedSettingsPane());

  const settingsPaneForActiveEntry = computed<SettingsPaneId>(() => {
    if (requestedSettingsPane.value) return requestedSettingsPane.value;
    // Plain "Settings" reopens the pane shown last; the first open shows Chat storage.
    if (app.activeEntry.value.type !== "system") return settingsReopenPane.value;
    if (app.activeEntry.value.id === "system:setup") return "account:connectors-setup";
    if (app.activeEntry.value.id === "system:app-agent") return "system:app-agent";
    if (app.activeEntry.value.id === "system:repos") return "system:runtime";
    if (app.activeEntry.value.id === "system:workers") return "system:agents";
    if (app.activeEntry.value.id === "system:diagnostics") return "system:diagnostics";
    return settingsReopenPane.value;
  });

  function openSettingsSurface(): void {
    requestedSettingsPane.value = null;
    app.activeEntry.value = settingsEntry;
  }

  function openTicketTrackersSurface(): void {
    requestedSettingsPane.value = "account:connectors";
    app.activeEntry.value = settingsEntry;
  }

  function openUpdatesSurface(): void {
    requestedSettingsPane.value = "system:updates";
    app.activeEntry.value = settingsEntry;
  }

  function startSidebarResize(event: PointerEvent): void {
    if (!showSidebarResizeHandle.value) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth.value;
    isSidebarResizing.value = true;
    document.documentElement.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function handlePointerMove(moveEvent: PointerEvent): void {
      sidebarWidth.value = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
    }

    function handlePointerUp(): void {
      isSidebarResizing.value = false;
      rememberStoredString(sidebarWidthStorageKey, String(sidebarWidth.value));
      document.documentElement.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  function handleSidebarResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 32 : 12;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth(sidebarWidth.value - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth(sidebarWidth.value + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(sidebarMinWidth);
    } else if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(sidebarMaxWidth);
    }
  }

  function setSidebarWidth(value: number): void {
    sidebarWidth.value = clampSidebarWidth(value);
    rememberStoredString(sidebarWidthStorageKey, String(sidebarWidth.value));
  }

  function setAllProjectsCollapsed(collapsed: boolean): void {
    app.collapsedProjects.value = Object.fromEntries(
      app.projectEntries.value.map((project) => [project.id, collapsed]),
    );
  }

  function handleSidebarParentRoomReorder(input: SidebarParentRoomReorder): void {
    const next = reorderSidebarParentRooms(app.sidebarProjectEntries.value, input);
    if (!next) return;
    sidebarRoomOrder.value = next;
    rememberSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey, next);
  }

  function handleSidebarChildRoomReorder(input: SidebarChildRoomReorder): void {
    const next = reorderSidebarChildRooms(app.sidebarProjectEntries.value, input);
    if (!next) return;
    sidebarRoomOrder.value = next;
    rememberSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey, next);
  }
  return {
    isSettingsSurface, showSidebarResizeHandle, desktopShellStyle, cycleSidebar,
    settingsReopenPane, settingsPaneForActiveEntry, openSettingsSurface, openTicketTrackersSurface, openUpdatesSurface, startSidebarResize,
    handleSidebarResizeKeydown, setSidebarWidth, setAllProjectsCollapsed,
    handleSidebarParentRoomReorder, handleSidebarChildRoomReorder,
  };
}

/** Takes the pane plain "Settings" reopens at each change of the active entry. Runs after navigation. */
export function useAppSettingsPaneWatcher(context: unknown) {
  const app = context as AppContextOf<"useAppNavigation" | "useAppSidebarLayout">;
  watch(() => app.activeEntry.value.id, () => {
    app.settingsReopenPane.value = reopenedSettingsPane();
  }, { flush: "sync" });
}
