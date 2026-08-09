import { computed, ref } from "vue";
import { desktopIpc } from "../../../../ipc/index.js";
import type {
  DesktopBoardGovernanceSection,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardManagerMode,
} from "../../../../../../electron/ipc-types";

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
    {
      id: "pending" as const,
      label: "Intents",
      count: governance.value?.pendingIntentCount || undefined,
    },
    { id: "audit" as const, label: "Audit" },
  ]);

  async function loadGovernance(): Promise<void> {
    governanceLoading.value = true;
    governanceError.value = null;
    try {
      governance.value = await desktopIpc.room.getBoardGovernance(roomIdentifier);
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
      desktopIpc.room.assignBoardManager(roomIdentifier, { agentSessionId })
    );
  }

  async function releaseManager(reason?: string | null): Promise<void> {
    await runMutation(() =>
      desktopIpc.room.releaseBoardManager(roomIdentifier, { reason })
    );
  }

  async function setManagerMode(managerMode: DesktopBoardManagerMode): Promise<void> {
    await runMutation(() =>
      desktopIpc.room.setBoardManagerMode(roomIdentifier, { managerMode })
    );
  }

  async function decideIntent(intentId: string, decision: "approve" | "deny", reason?: string | null): Promise<void> {
    await runMutation(() =>
      desktopIpc.room.decideBoardIntent(roomIdentifier, intentId, { decision, reason })
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
