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
  const governanceErrorRetryable = ref(false);
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
    governanceErrorRetryable.value = false;
    try {
      governance.value = await desktopIpc.room.getBoardGovernance(roomIdentifier);
      if (!selectedCandidateId.value && governance.value.activeManager) {
        selectedCandidateId.value = governance.value.activeManager.agentSessionId;
      }
    } catch (error) {
      const failure = governanceFailure(
        error,
        "Could not load board manager settings. Check the room connection and try again.",
        true,
      );
      governanceError.value = failure.message;
      governanceErrorRetryable.value = failure.retryable;
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
    governanceErrorRetryable.value = false;
  }

  async function runMutation(
    action: () => Promise<DesktopBoardGovernanceSnapshot | { governance: DesktopBoardGovernanceSnapshot }>,
  ): Promise<boolean> {
    governanceBusy.value = true;
    governanceError.value = null;
    governanceErrorRetryable.value = false;
    try {
      const result = await action();
      governance.value = "governance" in result ? result.governance : result;
      return true;
    } catch (error) {
      const failure = governanceFailure(
        error,
        "The board manager change did not finish. Review the settings and try the action again.",
        false,
      );
      governanceError.value = failure.message;
      governanceErrorRetryable.value = failure.retryable;
      return false;
    } finally {
      governanceBusy.value = false;
    }
  }

  async function assignManager(agentSessionId: string): Promise<boolean> {
    return runMutation(() =>
      desktopIpc.room.assignBoardManager(roomIdentifier, { agentSessionId })
    );
  }

  async function releaseManager(reason?: string | null): Promise<boolean> {
    return runMutation(() =>
      desktopIpc.room.releaseBoardManager(roomIdentifier, { reason })
    );
  }

  async function setManagerMode(managerMode: DesktopBoardManagerMode): Promise<boolean> {
    return runMutation(() =>
      desktopIpc.room.setBoardManagerMode(roomIdentifier, { managerMode })
    );
  }

  async function decideIntent(intentId: string, decision: "approve" | "deny", reason?: string | null): Promise<boolean> {
    return runMutation(() =>
      desktopIpc.room.decideBoardIntent(roomIdentifier, intentId, { decision, reason })
    );
  }

  return {
    governanceOpen,
    governanceLoading,
    governanceBusy,
    governanceError,
    governanceErrorRetryable,
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

function governanceFailure(
  error: unknown,
  fallback: string,
  fallbackRetryable: boolean,
): { message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/cloud-backed rooms?/i.test(message)) {
    return {
      message: "Board manager is available only in cloud-backed rooms.",
      retryable: false,
    };
  }
  if (/room not found/i.test(message)) {
    return {
      message: "This room is no longer available. Refresh the room to continue.",
      retryable: false,
    };
  }
  if (/auth|sign[ -]?in|unauthori[sz]ed/i.test(message)) {
    return { message: "Sign in again to manage this board.", retryable: false };
  }
  return { message: fallback, retryable: fallbackRetryable };
}
