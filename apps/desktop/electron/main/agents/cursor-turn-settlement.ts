import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";

import type {
  ProviderRoomTurnCheckpointDisposition,
  ProviderRoomTurnResult,
  ProviderTerminalPayload,
} from "./provider-adapter.js";
import { redactCredentialText } from "./provider-evidence.js";

export class CursorRoomTurnTerminalError extends Error {
  readonly roomTurnRecoveryOutcome = "terminal_failure" as const;
}

export class CursorRoomTurnRecoveryError extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
}

/** Read one exact inode with O_NOFOLLOW and a preallocated size bound. */
export function readBoundedCursorTurnFile(path: string, maxBytes: number, label: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CursorRoomTurnRecoveryError(`${label} could not be opened safely.`);
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) {
      throw new CursorRoomTurnRecoveryError(`${label} is not a bounded regular file.`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(fd);
    if (offset !== before.size || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs) {
      throw new CursorRoomTurnRecoveryError(`${label} changed while it was being read.`);
    }
    return bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Plain reason on a message whose turn finished but could not be trusted to
 * publish. It says what was lost, never what happens next: the daemon adds the
 * next step, because only it knows whether the agent will restart.
 */
export function cursorAuthorityUnprovenDetail(fileChangesLost: boolean): string {
  return "Cursor finished this turn, but LetAgents could not confirm that the turn's helper processes had stopped. "
    + `The turn's reply was not posted${fileChangesLost ? " and its file changes were not kept." : "."}`;
}

/**
 * A wrapper terminal that is sound in every way except one: the wrapper
 * reaped the native process group but could not prove that it revoked the
 * turn's remote authority (its proxies, MCP runtime and private data root)
 * within its bounded checks. The parsed terminal is carried so the caller can
 * still run its exact-turn cross-checks before it trusts that much.
 */
export class CursorTerminalAuthorityUnprovenError<T> extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
  constructor(message: string, readonly terminal: T) { super(message); }
}

export const CURSOR_TERMINAL_AUTHORITY_MESSAGE = "Cursor terminal evidence does not prove native process-group retirement and remote-authority revocation.";

/** Clean-up checks the wrapper can report as unproven; anything else is ignored. */
const CURSOR_AUTHORITY_CHECKS: readonly string[] = ["proxy_sockets", "mcp_socket", "mcp_runtime", "mcp_runtime_group", "runtime_data"];

/** The authority message plus which wrapper clean-up checks failed, for diagnosis. */
export function cursorAuthorityMessage(raw: Record<string, unknown>): string {
  const failed = Array.isArray(raw.remote_authority_failed_checks)
    ? raw.remote_authority_failed_checks.filter((check): check is string => typeof check === "string" && CURSOR_AUTHORITY_CHECKS.includes(check))
    : [];
  return failed.length ? `${CURSOR_TERMINAL_AUTHORITY_MESSAGE} Wrapper checks that failed: ${[...new Set(failed)].join(", ")}.` : CURSOR_TERMINAL_AUTHORITY_MESSAGE;
}

/** How a wrapper terminal record proves that its turn's authority ended. */
export function cursorTerminalAuthorityProof(raw: Record<string, unknown>): "proven" | "unproven" | "missing" {
  if (raw.native_process_group_reaped !== true || raw.reap_scope !== "native_process_group") return "missing";
  return raw.remote_authority_revoked === true ? "proven" : raw.remote_authority_revoked === false ? "unproven" : "missing";
}

/**
 * Settle a Cursor turn that ended at attempt level without a result. An
 * unrequested exit is a trusted ending: the wrapper already proved its native
 * process group retired, so the turn cannot still be running. It settles as
 * interrupted instead of blocking the FIFO behind a turn that can be neither
 * skipped nor re-read. Quota, stop, and protocol endings keep throwing. The one
 * protocol exception is a finished turn whose wrapper only failed to prove it
 * revoked its remote authority: it settles as lost and withholds its reply.
 */
export function cursorAttemptEndingResult(input: {
  turnId: string;
  providerContinuationId: string;
  cause: ProviderTerminalPayload["terminalCause"] | undefined;
  terminalError: string | undefined;
  protocolError: boolean;
  authorityUnproven?: boolean;
  /** The turn's private file changes stay unreconciled, so they are not kept. */
  fileChangesLost?: boolean;
}): ProviderRoomTurnResult {
  if (input.authorityUnproven) {
    // The turn ended and its native process group is gone, so it cannot still
    // be running and must never be rerun. Its reply is withheld: settle it as
    // lost with a plain reason and let the lane restart instead of blocking
    // every queued message until the owner presses Recover.
    return { turnId: input.turnId, providerContinuationId: input.providerContinuationId, outcome: "interrupted",
      text: null, evidence: "stream", authorityUnproven: true,
      error: cursorAuthorityUnprovenDetail(input.fileChangesLost === true) };
  }
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
