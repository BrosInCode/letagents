import { computed, ref, watch, type Ref } from "vue";
import type {
  DesktopRentalActivityEvent,
  DesktopRentalPatch,
  DesktopRentalSession,
  DesktopRentalUsageSnapshot,
} from "../../../../../../electron/ipc-types";
import type { RentSessionDetailTab } from "./tabs";
import { canCancelSessionStatus } from "./presentation";

type RentalBridge = NonNullable<typeof window.letagentsDesktop.rental>;

interface UseRentSessionDetailOptions {
  open: Readonly<Ref<boolean>>;
  session: Readonly<Ref<DesktopRentalSession | null>>;
  onClose: () => void;
  onSessionUpdated: (session: DesktopRentalSession) => void;
}

export function useRentSessionDetail(options: UseRentSessionDetailOptions) {
  const activeTab = ref<RentSessionDetailTab>("usage");
  const usage = ref<DesktopRentalUsageSnapshot | null>(null);
  const activity = ref<DesktopRentalActivityEvent[]>([]);
  const patches = ref<DesktopRentalPatch[]>([]);
  const loadingUsage = ref(false);
  const loadingActivity = ref(false);
  const loadingPatches = ref(false);
  const cancelBusy = ref(false);
  const patchActionBusyFor = ref<string | null>(null);
  const patchActionKind = ref<"approve" | "changes" | null>(null);
  const errorMessage = ref<string | null>(null);

  const anyLoading = computed(
    () => loadingUsage.value || loadingActivity.value || loadingPatches.value,
  );
  const canCancel = computed(() => {
    const status = options.session.value?.status;
    return status ? canCancelSessionStatus(status) : false;
  });

  watch(
    () => [options.open.value, options.session.value?.id] as const,
    ([nowOpen, sessionId]) => {
      if (!nowOpen || !sessionId) return;
      activeTab.value = "usage";
      usage.value = null;
      activity.value = [];
      patches.value = [];
      errorMessage.value = null;
      void refresh();
    },
  );

  async function refresh(): Promise<void> {
    const session = options.session.value;
    if (!session) return;

    const bridge = getRentalBridge();
    if (!bridge) return;

    errorMessage.value = null;
    await Promise.all([
      loadUsage(session.id, bridge),
      loadActivity(session.id, bridge),
      loadPatches(session.id, bridge),
    ]);
  }

  async function approvePatch(patchId: string): Promise<void> {
    const session = options.session.value;
    if (!session) return;

    const bridge = getRentalBridge();
    if (!bridge) return;

    patchActionBusyFor.value = patchId;
    patchActionKind.value = "approve";
    errorMessage.value = null;
    try {
      const result = await bridge.approvePatch(session.id, patchId);
      if (isDisabledResult(result)) {
        errorMessage.value = "Rent an Agent is disabled.";
        return;
      }
      await loadPatches(session.id, bridge);
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Could not approve the patch.";
    } finally {
      patchActionBusyFor.value = null;
      patchActionKind.value = null;
    }
  }

  async function requestPatchChanges(patchId: string): Promise<void> {
    const session = options.session.value;
    if (!session) return;

    const bridge = getRentalBridge();
    if (!bridge) return;

    const note = window.prompt("Why does this patch need changes?", "");
    if (note === null) return;

    patchActionBusyFor.value = patchId;
    patchActionKind.value = "changes";
    errorMessage.value = null;
    try {
      const result = await bridge.requestPatchChanges(
        session.id,
        patchId,
        note.trim() || "Changes requested.",
      );
      if (isDisabledResult(result)) {
        errorMessage.value = "Rent an Agent is disabled.";
        return;
      }
      await loadPatches(session.id, bridge);
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Could not request changes.";
    } finally {
      patchActionBusyFor.value = null;
      patchActionKind.value = null;
    }
  }

  async function cancelSession(): Promise<void> {
    const session = options.session.value;
    if (!session) return;

    const bridge = getRentalBridge();
    if (!bridge) return;

    const confirmed = window.confirm("Stop this rented agent session? The agent will stop working on this task and any unused rental budget will be released.");
    if (!confirmed) return;

    cancelBusy.value = true;
    errorMessage.value = null;
    try {
      const result = await bridge.cancelSession(session.id);
      if (isDisabledResult(result)) {
        errorMessage.value = "Rent an Agent is disabled.";
        return;
      }
      options.onSessionUpdated(result);
      options.onClose();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Could not cancel the session.";
    } finally {
      cancelBusy.value = false;
    }
  }

  async function loadUsage(sessionId: string, bridge: RentalBridge): Promise<void> {
    loadingUsage.value = true;
    try {
      const result = await bridge.getUsage(sessionId);
      if (!isDisabledResult(result)) usage.value = result;
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Could not load usage.";
    } finally {
      loadingUsage.value = false;
    }
  }

  async function loadActivity(sessionId: string, bridge: RentalBridge): Promise<void> {
    loadingActivity.value = true;
    try {
      const result = await bridge.getActivity(sessionId);
      if (isDisabledResult(result)) return;
      activity.value = Array.isArray(result) ? result : [];
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Could not load activity.";
    } finally {
      loadingActivity.value = false;
    }
  }

  async function loadPatches(sessionId: string, bridge: RentalBridge): Promise<void> {
    loadingPatches.value = true;
    try {
      const result = await bridge.getPatches(sessionId);
      if (isDisabledResult(result)) return;
      patches.value = Array.isArray(result) ? result : [];
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : "Could not load patches.";
    } finally {
      loadingPatches.value = false;
    }
  }

  function getRentalBridge(): RentalBridge | null {
    const bridge = window.letagentsDesktop?.rental;
    if (!bridge) {
      errorMessage.value = "Rent an Agent is not enabled.";
      return null;
    }
    return bridge;
  }

  return {
    activeTab,
    activity,
    anyLoading,
    approvePatch,
    canCancel,
    cancelBusy,
    cancelSession,
    errorMessage,
    loadingActivity,
    loadingPatches,
    patchActionBusyFor,
    patchActionKind,
    patches,
    refresh,
    requestPatchChanges,
    usage,
  };
}

function isDisabledResult(value: unknown): boolean {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { enabled?: unknown }).enabled === false
  );
}
