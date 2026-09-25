import { redactCredentialText, type ProviderProcessCustody } from "./provider-evidence.js";
import { MAX_CURSOR_TERMINAL_ERROR_DETAIL_LENGTH } from "./cursor-provider-constants.js";

export function safeCursorTerminalErrorDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = redactCredentialText(value).value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_CURSOR_TERMINAL_ERROR_DETAIL_LENGTH);
}

/** A Cursor lane can be processless while native preparation or settlement is still owned. */
export function createCursorRuntimeCustodyReader(
  custody: ProviderProcessCustody,
  handles: ReadonlyMap<string, {
    providerContinuationId: string | null;
    liveTurn: {
      roomTurnId: string | null;
      workspaceGeneration: unknown;
      workspaceGenerationSettlement?: { version: 1; phase: "aborted" | "cleaned"; provider_continuation_id: string };
    } | null;
    activeRoomTurnId: unknown;
    roomTurnOperationId: unknown;
    roomTurnAbortController: unknown;
    roomTurnOperationSettled: unknown;
  }>,
): (workAttemptId: string) => ReturnType<ProviderProcessCustody["state"]> {
  return (workAttemptId) => {
    const handle = handles.get(workAttemptId);
    if (handle && (handle.activeRoomTurnId || handle.roomTurnOperationId
      || handle.roomTurnAbortController || handle.roomTurnOperationSettled)) return "unknown";
    const turn = handle?.liveTurn;
    if (turn) {
      const settlement = turn.workspaceGenerationSettlement;
      // Only the exact trusted wrapper's group/capability retirement plus a
      // durably cleaned workspace can separate retained evidence from custody.
      if (!turn.roomTurnId || turn.workspaceGeneration !== null || settlement?.version !== 1
        || settlement.phase !== "cleaned" || !handle.providerContinuationId
        || settlement.provider_continuation_id !== handle.providerContinuationId) return "unknown";
    }
    return custody.state(workAttemptId);
  };
}
