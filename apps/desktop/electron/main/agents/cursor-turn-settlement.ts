import type {
  ProviderRoomTurnCheckpointDisposition,
  ProviderRoomTurnResult,
  ProviderTerminalPayload,
} from "./provider-adapter.js";
import { redactCredentialText } from "./provider-evidence.js";

export class CursorRoomTurnTerminalError extends Error {
  readonly roomTurnRecoveryOutcome = "terminal_failure" as const;
}

/**
 * Settle a Cursor turn that ended at attempt level without a result. An
 * unrequested exit is a trusted ending: the wrapper already proved its native
 * process group retired, so the turn cannot still be running. It settles as
 * interrupted instead of blocking the FIFO behind a turn that can be neither
 * skipped nor re-read. Quota, stop, and protocol endings keep throwing.
 */
export function cursorAttemptEndingResult(input: {
  turnId: string;
  providerContinuationId: string;
  cause: ProviderTerminalPayload["terminalCause"] | undefined;
  terminalError: string | undefined;
  protocolError: boolean;
}): ProviderRoomTurnResult {
  const detail = input.cause === "provider_quota"
    ? "Cursor could not complete this turn because the provider usage limit was reached."
    : input.terminalError
      ? `Cursor supervised turn failed: ${input.terminalError}`
    : "Cursor ended before the bounded room turn produced a terminal result.";
  if (input.protocolError || (input.cause !== "crashed" && input.cause !== "exited")) {
    throw new CursorRoomTurnTerminalError(detail);
  }
  return { turnId: input.turnId, providerContinuationId: input.providerContinuationId, outcome: "interrupted",
    text: null, evidence: "stream", error: redactCredentialText(detail).value.slice(0, 2000) };
}

/**
 * Record a turn's ending before its lane retires: the exit notification
 * retires the daemon's live handle, which authorizes that record. Attempt
 * death is still committed when classification or the checkpoint fails.
 */
export async function checkpointCursorTurnBeforeLaneRetires(input: {
  attemptDeath: ProviderTerminalPayload | null;
  result: () => ProviderRoomTurnResult;
  checkpoint?: (result: ProviderRoomTurnResult) => Promise<ProviderRoomTurnCheckpointDisposition | void>;
  retire: (attemptDeath: ProviderTerminalPayload) => ProviderTerminalPayload;
}): Promise<{
  result: ProviderRoomTurnResult;
  disposition: ProviderRoomTurnCheckpointDisposition | void;
  attemptTerminal: ProviderTerminalPayload | null;
}> {
  let settled!: { result: ProviderRoomTurnResult; disposition: ProviderRoomTurnCheckpointDisposition | void };
  let attemptTerminal: ProviderTerminalPayload | null = null;
  try {
    const result = input.result();
    settled = { result, disposition: await input.checkpoint?.(result) };
  } finally {
    if (input.attemptDeath) attemptTerminal = input.retire(input.attemptDeath);
  }
  return { ...settled, attemptTerminal };
}
