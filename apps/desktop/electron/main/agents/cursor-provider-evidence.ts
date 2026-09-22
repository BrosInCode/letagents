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
    liveTurn: unknown;
    activeRoomTurnId: unknown;
    roomTurnOperationId: unknown;
    roomTurnAbortController: unknown;
    roomTurnOperationSettled: unknown;
  }>,
): (workAttemptId: string) => ReturnType<ProviderProcessCustody["state"]> {
  return (workAttemptId) => {
    const handle = handles.get(workAttemptId);
    if (handle && (handle.liveTurn || handle.activeRoomTurnId || handle.roomTurnOperationId
      || handle.roomTurnAbortController || handle.roomTurnOperationSettled)) return "unknown";
    return custody.state(workAttemptId);
  };
}
