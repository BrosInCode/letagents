import { computed, ref } from "vue";
import type {
  DesktopBoardGovernanceSection,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardManagerMode,
} from "../../../../../../electron/ipc-types";

export function readableManagerRuntime(
  runtimeSource: string | null | undefined,
): string {
  if (runtimeSource === "open_model") return "Open model";
  if (runtimeSource === "desktop_managed") return "Desktop managed";
  if (runtimeSource === "external") return "External";
  if (runtimeSource === "unknown") return "Unknown";
  return "Worker";
}

export function readableManagerMode(mode: DesktopBoardManagerMode): string {
  if (mode === "intent_required") return "Approval required";
  if (mode === "manager_optional") return "Manager optional";
  return "Off";
}

export function readableIntentAction(actionType: string): string {
  return actionType.replace(/^task_/, "").replaceAll("_", " ");
}

export function useBoardGovernance(roomIdentifier: string) {
  const governanceOpen = ref(false);
  const governanceLoading = ref(false);
  const governanceBusy = ref(false);
  const governanceError = ref<string | null>(null);
  const governance = ref<DesktopBoardGovernanceSnapshot | null>(null);
  const activeSection = ref<DesktopBoardGovernanceSection>("manager");
  const selectedCandidateId = ref<string | null>(null);

  const sections = computed(() => [
    { id: "manager" as const, label: "Manager" },
    { id: "pending" as const, label: "Intents", count: governance.value?.pendingIntentCount ?? 0 },
    { id: "audit" as const, label: "Audit" },
  ]);

  async function loadGovernance(): Promise<void> {
    governanceLoading.value = true;
    governanceError.value = null;
    try {
      governance.value = await window.letagentsDesktop.room.getBoardGovernance(roomIdentifier);
      if (!selectedCandidateId.value && governance.value.activeManager) {
        selectedCandidateId.value = governance.value.activeManager.agentSessionId;
      }
    } catch (error) {
      governanceError.value = error instanceof Error ? error.message : "Could not load board governance.";
    } finally {
      governanceLoading.value = false;
    }
  }

  async function openGovernance(): Promise<void> {
    governanceOpen.value = true;
    await loadGovernance();
  }

  function closeGovernance(): void {
    governanceOpen.value = false;
    governanceError.value = null;
  }

  async function runMutation(
    action: () => Promise<DesktopBoardGovernanceSnapshot | { governance: DesktopBoardGovernanceSnapshot }>,
  ): Promise<void> {
    governanceBusy.value = true;
    governanceError.value = null;
    try {
      const result = await action();
      governance.value = "governance" in result ? result.governance : result;
    } catch (error) {
      governanceError.value = error instanceof Error ? error.message : "Board governance action failed.";
    } finally {
      governanceBusy.value = false;
    }
  }

  async function assignManager(agentSessionId: string): Promise<void> {
    await runMutation(() =>
      window.letagentsDesktop.room.assignBoardManager(roomIdentifier, { agentSessionId })
    );
  }

  async function releaseManager(reason?: string | null): Promise<void> {
    await runMutation(() =>
      window.letagentsDesktop.room.releaseBoardManager(roomIdentifier, { reason })
    );
  }

  async function setManagerMode(managerMode: DesktopBoardManagerMode): Promise<void> {
    await runMutation(() =>
      window.letagentsDesktop.room.setBoardManagerMode(roomIdentifier, { managerMode })
    );
  }

  async function decideIntent(intentId: string, decision: "approve" | "deny", reason?: string | null): Promise<void> {
    await runMutation(() =>
      window.letagentsDesktop.room.decideBoardIntent(roomIdentifier, intentId, { decision, reason })
    );
  }

  return {
    governanceOpen,
    governanceLoading,
    governanceBusy,
    governanceError,
    governance,
    activeSection,
    selectedCandidateId,
    sections,
    openGovernance,
    closeGovernance,
    loadGovernance,
    assignManager,
    releaseManager,
    setManagerMode,
    decideIntent,
  };
}
