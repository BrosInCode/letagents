// Crash and restart recovery of exact Cursor room turns from the durable wrapper journal.

import { createHash } from "node:crypto";
import { realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ProviderConnectionRef,
  ProviderHandle,
  ProviderRoomTurnOptions,
  ProviderRoomTurnRecoveryRequest,
  ProviderRoomTurnResult,
} from "../provider-adapter.js";
import { MAX_DURABLE_TURN_TERMINAL_BYTES } from "../cursor-provider-constants.js";
import { safeCursorTerminalErrorDetail } from "../cursor-provider-evidence.js";
import {
  checkpointCursorTurnBeforeLaneRetires,
  CursorTerminalAuthorityUnprovenError,
  cursorTerminalAuthorityProof,
  cursorAuthorityMessage,
  CursorRoomTurnEndedBeforeInitError,
  CursorRoomTurnRecoveryError,
  readBoundedCursorTurnFile,
} from "../cursor-turn-settlement.js";
import { sameProcessBirthIdentity, type ProviderProcessExit } from "../provider-evidence.js";
import {
  CursorProviderHandle,
  CursorRecordedTurnInProgressError,
  CursorRoomTurnNotDispatchedError,
  type CursorGenerationSettlement,
  type CursorStreamMessage,
  type CursorTurnTerminal,
  type LiveTurn,
} from "./lane-state.js";
import { CURSOR_PENDING_CONTINUATION_PREFIX, requireCursorSessionId } from "./launch-arguments.js";
import type { CursorProviderAdapter } from "./provider-adapter.js";
import { sessionIdOf } from "./stream-events.js";

export async function recoverRoomTurn(
  adapter: CursorProviderAdapter,
  providerHandle: ProviderHandle,
  request: ProviderRoomTurnRecoveryRequest,
  options: {
    detachSignal?: AbortSignal;
    checkpointProviderState?: ProviderRoomTurnOptions["checkpointProviderState"];
    settleLifecycleBeforeIdle?: ProviderRoomTurnOptions["settleLifecycleBeforeIdle"];
    checkpointTerminalResult?: ProviderRoomTurnOptions["checkpointTerminalResult"];
  } = {},
): Promise<ProviderRoomTurnResult> {
  return adapter.processCustody.acquire(providerHandle.workAttemptId,
    () => adapter.recoverOwnedRoomTurn(providerHandle, request, options));
}

export async function recoverOwnedRoomTurn(adapter: CursorProviderAdapter, providerHandle: ProviderHandle, request: ProviderRoomTurnRecoveryRequest,
  options: Parameters<CursorProviderAdapter["recoverRoomTurn"]>[2] = {}): Promise<ProviderRoomTurnResult> {
  const handle = adapter.requireHandle(providerHandle);
  const turnId = request.providerTurnId.trim();
  if (!turnId) {
    throw new CursorRoomTurnRecoveryError("Cursor room-turn recovery requires an exact persisted turn id.");
  }
  const retainedTurn = handle.liveTurn?.roomTurnId === turnId ? handle.liveTurn : null;
  let terminal: CursorTurnTerminal | null;
  try {
    // Prefer the exact durable wrapper terminal, including late TERM output,
    // over the earlier in-memory teardown snapshot.
    terminal = readRecoverableTerminal(adapter, handle, turnId) ?? handle.roomTurnResults.get(turnId) ?? null;
  } catch (error) {
    if (error instanceof CursorRoomTurnNotDispatchedError && error.workspaceGenerationManifestPath) {
      if (error.workspaceGenerationSettlement) {
        adapter.verifyRestingConversation(handle, error.workspaceGenerationSettlement);
        adapter.recordGenerationSettlement(handle, turnId, error.workspaceGenerationManifestPath, "aborted");
      } else {
        const generation = await adapter.deps.openWorkspaceGeneration(error.workspaceGenerationManifestPath);
        adapter.restoreConversationNamespace(handle, generation);
        const receipt = await generation.abandon();
        if (receipt.phase !== "aborted") throw new CursorRoomTurnRecoveryError("Cursor preparation recovery did not abandon its generation.");
        adapter.recordGenerationSettlement(handle, turnId, generation.manifestPath, "aborted");
      }
      await adapter.deps.removeWorkspaceGenerationReceipt(error.workspaceGenerationManifestPath, { settlementVerified: true });
    }
    if (error instanceof CursorRoomTurnNotDispatchedError
      && retainedTurn?.lifecycleSettlementDeferred) {
      try {
        await adapter.settlePreparedTurnIdle(
          handle,
          retainedTurn,
          await retainedTurn.child.exited,
          options.settleLifecycleBeforeIdle,
          options.checkpointProviderState,
        );
      } catch (recoveryError) {
        throw new CursorRoomTurnRecoveryError(
          `Cursor prepared-wrapper recovery could not retire its exact child birth: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    }
    throw error;
  }
  if (!terminal && handle.liveTurn?.roomTurnId === turnId && handle.liveTurn.completion) {
    terminal = await adapter.awaitRoomTurnTerminal(handle.liveTurn.completion, options.detachSignal);
  }
  if (!terminal) {
    // With no exact-turn API, a missing stream never authorizes redispatch.
    throw new CursorRoomTurnRecoveryError(
      "Cursor room-turn recovery cannot prove the persisted exact turn reached a terminal boundary; refusing to rerun it.",
    );
  }
  if (terminal.workspaceGenerationSettlement) {
    adapter.verifyRestingConversation(handle, terminal.workspaceGenerationSettlement);
    // Recommit a possibly unsynced marker before receipt deletion.
    adapter.recordGenerationSettlement(handle, turnId, terminal.workspaceGenerationManifestPath!, "cleaned");
  } else if (terminal.workspaceGenerationManifestPath) {
    let receipt;
    try {
      const generation = await adapter.deps.openWorkspaceGeneration(terminal.workspaceGenerationManifestPath);
      if (generation.realWorkspace !== resolve(handle.cwd) && generation.realWorkspace !== realpathSync(handle.cwd)) {
        throw new CursorRoomTurnRecoveryError("Cursor generation recovery belongs to another workspace.");
      }
      receipt = await adapter.deps.recoverWorkspaceGeneration(
        terminal.workspaceGenerationManifestPath,
        // The trusted wrapper terminal above proves native process-group and
        // remote capability retirement. A stale detached process may still
        // hold old file descriptors, so recovery renames the generation out
        // of its allowlisted path before sealing its immutable Git tree.
        { retireReadyGeneration: true },
      );
      if (receipt.phase !== "cleaned") throw new CursorRoomTurnRecoveryError(`Cursor generation recovery ended in ${receipt.phase}.`);
      adapter.restoreConversationNamespace(handle, generation);
      terminal.workspaceGenerationSettlement = adapter.recordGenerationSettlement(handle, turnId, generation.manifestPath, "cleaned");
    } catch (error) {
      throw new CursorRoomTurnRecoveryError(
        `Cursor's exact workspace generation could not be recovered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (receipt.phase !== "cleaned") {
      throw new CursorRoomTurnRecoveryError(
        `Cursor's exact workspace generation recovery ended in ${receipt.phase}, not cleaned.`,
      );
    }
  }
  if (handle.providerContinuationId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX)
    && terminal.providerContinuationId) {
    handle.providerContinuationId = requireCursorSessionId(
      terminal.providerContinuationId,
      "Cursor recovered session",
    );
  }
  try {
    if (retainedTurn?.lifecycleSettlementDeferred) {
      // Commit the real continuation with its retained birth before typed settlement.
      await options.checkpointProviderState?.({
        providerContinuationId: handle.providerContinuationId!,
        providerConnection: handle.providerConnection,
      });
      adapter.observeValidatedTurnTerminal(handle, retainedTurn,
        terminal.state === "result" ? terminal.isError ? "failed" : "completed"
          : terminal.state === "interrupted" ? "interrupted" : "lost");
      adapter.observeNativeRuntimeExit(handle, retainedTurn, terminal.exit);
      await options.settleLifecycleBeforeIdle?.();
      if (handle.liveTurn === retainedTurn) handle.liveTurn = null;
      handle.state = "idle";
      try {
        await options.checkpointProviderState?.({
          providerContinuationId: handle.providerContinuationId!,
          providerConnection: handle.providerConnection,
        });
      } catch (error) {
        // The child is already exited, but retaining its immutable birth lets
        // an idempotent recovery retry the live->idle checkpoint safely.
        if (!handle.liveTurn) handle.liveTurn = retainedTurn;
        throw error;
      }
    } else {
      await options.checkpointProviderState?.({
        providerContinuationId: handle.providerContinuationId!,
        providerConnection: handle.providerConnection,
      });
    }
  } catch (error) {
    // The manifest write may already have committed before a later durable
    // checkpoint failed. Keep the continuation proven by the exact terminal
    // so an idempotent retry converges from either old or new durable state.
    throw new CursorRoomTurnRecoveryError(
      `Cursor terminal recovery could not checkpoint its exact continuation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Recovery has the same attempt-level semantics as live completion. A
  // trusted wrapper terminal with init but no result proves this native
  // lane ended. Commit attempt death only after continuation settlement
  // and the live->idle compensation both succeed; a failed recovery must
  // retain the immutable child birth for an idempotent retry. As in live
  // completion, the turn's own terminal is recorded before the lane retires.
  const attemptDeath = terminal.state === "attempt_terminal"
    ? handle.terminal ?? adapter.synthesizeAttemptTerminal(handle, terminal.exit, terminal.attemptTerminal?.terminalCause)
    : null;
  if (attemptDeath) terminal = { ...terminal, attemptTerminal: attemptDeath };
  const { result, disposition, attemptTerminal } = await checkpointCursorTurnBeforeLaneRetires({
    attemptDeath, checkpoint: options.checkpointTerminalResult,
    result: () => adapter.providerRoomTurnResult(turnId, terminal!, handle.providerContinuationId!, handle.protocolError),
    retire: (death) => adapter.commitAttemptTerminal(handle, death),
  });
  if (attemptTerminal) terminal = { ...terminal, attemptTerminal };
  const acceptedResult = disposition?.acceptedResult ?? result;
  const cleanupRecoveryEvidence = options.checkpointTerminalResult
    ? disposition === undefined
      ? result.outcome !== "unreadable"
      : disposition.cleanupRecoveryEvidence
    : false;
  if (cleanupRecoveryEvidence) {
    if (terminal.workspaceGenerationManifestPath) {
      await adapter.deps.removeWorkspaceGenerationReceipt(terminal.workspaceGenerationManifestPath,
        { settlementVerified: Boolean(terminal.workspaceGenerationSettlement) });
    }
    adapter.removeDurableTurnJournal(handle, turnId);
  }
  if (cleanupRecoveryEvidence || (!options.checkpointTerminalResult && result.outcome !== "unreadable")) {
    handle.roomTurnResults.delete(turnId);
  }
  return acceptedResult;
}

/** The durable terminal, or the ending of a turn stopped before Cursor's init: only recovery may settle that one. */
function readRecoverableTerminal(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turnId: string,
): CursorTurnTerminal | null {
  try {
    return adapter.readDurableTurnTerminal(handle, turnId);
  } catch (error) {
    if (error instanceof CursorRoomTurnEndedBeforeInitError) return error.terminal as CursorTurnTerminal;
    throw error;
  }
}

export function readDurableTurnTerminal(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turnId: string,
): CursorTurnTerminal | null {
  const profile = handle.supervisedProfile;
  if (!profile) return null;
  const statePath = join(
    profile.configDir,
    `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`,
  );
  const terminalPath = `${statePath}.terminal.json`;
  const terminalJson = readBoundedCursorTurnFile(
    terminalPath,
    MAX_DURABLE_TURN_TERMINAL_BYTES,
    "Cursor durable terminal evidence",
  );
  if (terminalJson === null) return null;
  let exit: ProviderProcessExit;
  let initMessage: CursorStreamMessage;
  let resultMessage: CursorStreamMessage | null;
  let workspaceGenerationManifestPath: string | undefined;
  let workspaceGenerationSettlement: CursorGenerationSettlement | undefined;
  let terminalError: string | undefined;
  let publicationContract: CursorTurnTerminal["publicationContract"] = "structured_room_turn_v1";
  let legacyUnversionedTerminal = false;
  let authorityProof: ReturnType<typeof cursorTerminalAuthorityProof> = "missing";
  let authorityMessage = "";
  try {
    const raw = JSON.parse(terminalJson) as Record<string, unknown>;
    authorityProof = cursorTerminalAuthorityProof(raw);
    authorityMessage = cursorAuthorityMessage(raw);
    // Only a finished turn (type exit) can carry unproven authority forward;
    // a not-started or errored wrapper with live authority stays untrusted.
    if (authorityProof === "missing" || (authorityProof === "unproven" && raw.type !== "exit")) {
      throw new CursorRoomTurnRecoveryError(authorityMessage);
    }
    if (raw.workspace_generation_manifest_path !== undefined && raw.workspace_generation_manifest_path !== null) {
      if (typeof raw.workspace_generation_manifest_path !== "string" || !isAbsolute(raw.workspace_generation_manifest_path)
        || raw.workspace_generation_manifest_path.length > 16_384
        || resolve(raw.workspace_generation_manifest_path) !== raw.workspace_generation_manifest_path) {
        throw new CursorRoomTurnRecoveryError("Cursor terminal evidence has an invalid workspace-generation journal path.");
      }
      workspaceGenerationManifestPath = raw.workspace_generation_manifest_path;
    }
    if (raw.workspace_generation_settlement !== undefined) {
      const settlement = raw.workspace_generation_settlement as CursorGenerationSettlement;
      const expected = raw.type === "not_started" ? handle.providerContinuationId
        : raw.init && typeof raw.init === "object" ? sessionIdOf(raw.init as CursorStreamMessage) : null;
      if (!workspaceGenerationManifestPath || !settlement || settlement.version !== 1
        || settlement.phase !== (raw.type === "not_started" ? "aborted" : "cleaned")
        || typeof expected !== "string" || settlement.provider_continuation_id !== expected) {
        throw new CursorRoomTurnRecoveryError("Cursor conversation settlement evidence is invalid.");
      }
      workspaceGenerationSettlement = settlement;
    }
    if (raw.type === "not_started") {
      throw new CursorRoomTurnNotDispatchedError(
        "Cursor's prepared wrapper exited before native dispatch; the exact inbox item is safe to retry.",
        turnId, workspaceGenerationManifestPath, workspaceGenerationSettlement,
      );
    }
    if (raw.type !== "exit" && raw.type !== "error") {
      throw new CursorRoomTurnRecoveryError("Cursor terminal evidence has an unknown type.");
    }
    if (raw.session_contract_valid !== true || raw.stream_contract_complete !== true) {
      throw new CursorRoomTurnRecoveryError("Cursor terminal evidence did not preserve a complete session contract.");
    }
    if (raw.turn_contract_version !== undefined) {
      if (raw.turn_contract_version !== 1) {
        throw new CursorRoomTurnRecoveryError("Cursor terminal evidence has an unsupported turn contract version.");
      }
      publicationContract = "structured_room_turn_v1";
    } else {
      legacyUnversionedTerminal = true;
    }
    if (!raw.init || typeof raw.init !== "object" || Array.isArray(raw.init)) {
      if (raw.init === null && raw.result === null && authorityProof === "proven") {
        throw new CursorRoomTurnEndedBeforeInitError<CursorTurnTerminal>("Cursor terminal evidence has no verified init snapshot.", {
          state: "attempt_terminal",
          exit: raw.type === "exit"
            ? { type: "exit", code: typeof raw.code === "number" ? raw.code : null, signal: typeof raw.signal === "string" ? raw.signal as NodeJS.Signals : null }
            : { type: "error", error: new Error(typeof raw.error === "string" ? raw.error : "Cursor wrapper launch failed.") },
          text: null,
          isError: true,
          providerRequestId: null,
          attemptTerminal: null,
          publicationContract,
          terminalError: safeCursorTerminalErrorDetail(raw.error) ?? "Cursor stopped before it reported that this turn had started.",
          ...(workspaceGenerationManifestPath ? { workspaceGenerationManifestPath } : {}),
          ...(workspaceGenerationSettlement ? { workspaceGenerationSettlement } : {}),
        });
      }
      throw new CursorRoomTurnRecoveryError("Cursor terminal evidence has no verified init snapshot.");
    }
    initMessage = raw.init as CursorStreamMessage;
    resultMessage = raw.result === null
      ? null
      : raw.result && typeof raw.result === "object" && !Array.isArray(raw.result)
        ? raw.result as CursorStreamMessage
        : (() => { throw new CursorRoomTurnRecoveryError("Cursor terminal result snapshot is malformed."); })();
    if (legacyUnversionedTerminal && resultMessage && !Object.hasOwn(resultMessage, "subtype")) {
      publicationContract = "legacy_cursor_aggregate_v0";
    }
    exit = raw.type === "exit"
      ? {
        type: "exit",
        code: typeof raw.code === "number" ? raw.code : null,
        signal: typeof raw.signal === "string" ? raw.signal as NodeJS.Signals : null,
      }
      : { type: "error", error: new Error(typeof raw.error === "string" ? raw.error : "Cursor wrapper launch failed.") };
    terminalError = raw.type === "error"
      ? safeCursorTerminalErrorDetail(raw.error) ?? "Cursor wrapper launch failed."
      : undefined;
  } catch (error) {
    if (error instanceof CursorRoomTurnNotDispatchedError) throw error;
    if (error instanceof CursorRoomTurnRecoveryError) throw error;
    throw new CursorRoomTurnRecoveryError(`Cursor durable terminal evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const initSessionId = sessionIdOf(initMessage);
  if (initMessage.type !== "system" || initMessage.subtype !== "init" || !initSessionId) {
    throw new CursorRoomTurnRecoveryError("Cursor terminal init snapshot has no valid provider session identity.");
  }
  const pendingContinuation = handle.providerContinuationId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX) === true;
  if (handle.providerContinuationId && !pendingContinuation
    && initSessionId !== handle.providerContinuationId) {
    throw new CursorRoomTurnRecoveryError("Cursor terminal snapshot belongs to a different provider continuation.");
  }
  // An unproven terminal never adopts state; the live init already did.
  if (pendingContinuation && authorityProof === "proven") handle.providerContinuationId = initSessionId;
  const resultSessionId = resultMessage ? sessionIdOf(resultMessage) : null;
  if (resultMessage && publicationContract === "structured_room_turn_v1" && !resultSessionId) {
    throw new CursorRoomTurnRecoveryError("Cursor terminal result has no exact provider session identity.");
  }
  if (resultSessionId && resultSessionId !== initSessionId) {
    throw new CursorRoomTurnRecoveryError("Cursor terminal result belongs to a different provider continuation.");
  }
  const sawResult = resultMessage?.type === "result";
  let isError = true;
  let text: string | null = null;
  let providerRequestId: string | null = null;
  if (sawResult && resultMessage) {
    // Durable snapshots written before subtype capture only persisted
    // `{type:"result",is_error:false}`. Accept exactly that absent-field
    // legacy shape during restart recovery; live observations and newer
    // snapshots (which persist subtype, including explicit null) retain the
    // strict success + false contract.
    const legacySuccess = !Object.hasOwn(resultMessage, "subtype")
      && resultMessage.is_error === false;
    isError = !legacySuccess
      && (resultMessage.subtype !== "success" || resultMessage.is_error !== false);
    text = typeof resultMessage.result === "string" ? resultMessage.result : null;
    providerRequestId = typeof resultMessage.request_id === "string" && resultMessage.request_id.trim()
      ? resultMessage.request_id.trim()
      : null;
  }
  const terminal: CursorTurnTerminal = sawResult
    ? {
      state: "result",
      exit,
      text,
      isError,
      nativeFailure: resultMessage?.is_error === true && typeof resultMessage.subtype === "string" && resultMessage.subtype !== "success",
      providerRequestId,
      attemptTerminal: null,
      publicationContract,
      ...(terminalError ? { terminalError } : {}),
      providerContinuationId: initSessionId,
      ...(workspaceGenerationManifestPath ? { workspaceGenerationManifestPath } : {}),
      ...(workspaceGenerationSettlement ? { workspaceGenerationSettlement } : {}),
    }
    : {
      state: "attempt_terminal",
      exit,
      text: null,
      isError: true,
      providerRequestId: null,
      attemptTerminal: null,
      publicationContract,
      ...(terminalError ? { terminalError } : {}),
      providerContinuationId: initSessionId,
      ...(workspaceGenerationManifestPath ? { workspaceGenerationManifestPath } : {}),
      ...(workspaceGenerationSettlement ? { workspaceGenerationSettlement } : {}),
    };
  // Every other check passed; only the revocation proof is absent.
  if (authorityProof === "unproven") {
    throw sawResult
      ? new CursorTerminalAuthorityUnprovenError(authorityMessage, terminal)
      : new CursorRoomTurnRecoveryError(authorityMessage);
  }
  return terminal;
}

/**
 * Read only the wrapper-authored containment proof needed when live MCP
 * startup fails before Cursor can emit a provider init. This deliberately
 * does not promote the record to a recoverable room-turn terminal: without
 * init there is no provider continuation identity.
 */
export function readTrustedPreInitTurnFailure(
  adapter: CursorProviderAdapter,
  turn: LiveTurn,
): { errorDetail: string } | null {
  if (!turn.statePath) return null;
  let raw: Record<string, unknown>;
  try {
    const terminalJson = readBoundedCursorTurnFile(
      `${turn.statePath}.terminal.json`,
      MAX_DURABLE_TURN_TERMINAL_BYTES,
      "Cursor pre-init terminal evidence",
    );
    if (terminalJson === null) return null;
    raw = JSON.parse(terminalJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const errorDetail = safeCursorTerminalErrorDetail(raw.error);
  if (raw.type !== "error"
    || raw.native_process_group_reaped !== true
    || raw.reap_scope !== "native_process_group"
    || raw.remote_authority_revoked !== true
    || raw.turn_contract_version !== 1
    || raw.session_contract_valid !== true
    || raw.stream_contract_complete !== true
    || raw.init !== null
    || raw.result !== null
    || raw.workspace_generation_manifest_path !== turn.workspaceGenerationManifestPath
    || !errorDetail) {
    return null;
  }
  return { errorDetail };
}

export function removeDurableTurnJournal(adapter: CursorProviderAdapter, handle: CursorProviderHandle, turnId: string): void {
  const profile = handle.supervisedProfile;
  if (!profile) return;
  const statePath = join(
    profile.configDir,
    `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`,
  );
  // unlink never follows a symlink. Delete terminal authority first so a
  // crash during cleanup can only leave inert stream bytes, never a terminal
  // record that points at missing evidence.
  for (const path of [`${statePath}.terminal.json`, statePath]) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CursorRoomTurnRecoveryError("Cursor durable turn journal could not be retired safely.");
      }
    }
  }
}

export function readTrustedDurableTurnTerminal(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
): CursorTurnTerminal {
  if (!turn.roomTurnId) {
    throw new CursorRoomTurnRecoveryError("The supervised result had no exact durable turn identity.");
  }
  let durable: CursorTurnTerminal | null;
  let unproven: CursorTerminalAuthorityUnprovenError<CursorTurnTerminal> | null = null;
  try {
    durable = adapter.readDurableTurnTerminal(handle, turn.roomTurnId);
  } catch (error) {
    // Cross-check an otherwise sound terminal before reporting it unproven.
    if (!(error instanceof CursorTerminalAuthorityUnprovenError)) throw error;
    unproven = error as CursorTerminalAuthorityUnprovenError<CursorTurnTerminal>;
    durable = unproven.terminal;
  }
  if (!durable) {
    throw new CursorRoomTurnRecoveryError("The supervised wrapper published no trusted terminal evidence.");
  }
  if ((durable.workspaceGenerationManifestPath ?? null) !== turn.workspaceGenerationManifestPath) {
    throw new CursorRoomTurnRecoveryError(
      "The supervised wrapper terminal belongs to a different workspace generation.",
    );
  }
  // A result written only after checkpoint failure can legitimately exist
  // only in the wrapper journal. When a live result was already observed,
  // however, accepting a different durable value would cross-wire terminal
  // evidence and must fail closed.
  if (turn.sawResult && (durable.state !== "result"
    || durable.text !== turn.resultText
    || durable.isError !== turn.resultWasError
    || durable.providerRequestId !== turn.providerRequestId)) {
    throw new CursorRoomTurnRecoveryError(
      durable.state !== "result"
        ? "The supervised wrapper terminal did not contain the observed result."
        : "The live result did not match the exact durable terminal snapshot.",
    );
  }
  if (unproven) throw unproven;
  return durable;
}

/** Inspect the exact checkpointed wrapper without waiting or signalling it. */
export async function observeRecordedTurnChild(
  adapter: CursorProviderAdapter,
  connection: Extract<ProviderConnectionRef, { kind: "cursor_cli" }>,
): Promise<null> {
  if (!connection.processIdentity) {
    throw new Error(
      "Cursor attach is ambiguous; the recorded turn child has no verified process identity.",
    );
  }
  const identity = adapter.deps.getProcessIdentity(connection.pid!);
  if (identity === undefined) {
    throw new Error("Cursor attach is ambiguous; the recorded process identity cannot be verified.");
  }
  if (identity === null || !sameProcessBirthIdentity(identity, connection.processIdentity)) return null;
  throw new CursorRecordedTurnInProgressError(
    "Cursor's exact recorded turn wrapper is still running; recovery will retry without starting a successor.",
  );
}
