// Private writable workspace generations of supervised Cursor turns and their settlement records.

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MAX_DURABLE_TURN_TERMINAL_BYTES } from "../cursor-provider-constants.js";
import { CursorRoomTurnRecoveryError, readBoundedCursorTurnFile } from "../cursor-turn-settlement.js";
import type { SupervisedWorkspaceGenerationHandle } from "../supervised-workspace-generation.js";
import {
  CursorProviderHandle,
  type CursorGenerationSettlement,
  type CursorTurnTerminal,
  type LiveTurn,
} from "./lane-state.js";
import { CURSOR_PENDING_CONTINUATION_PREFIX } from "./launch-arguments.js";
import type { CursorProviderAdapter } from "./provider-adapter.js";

/**
 * Filesystem authority ends only after the private generation is renamed out
 * of the provider's allowlisted path, sealed into an immutable Git tree, and
 * reconciled through its durable journal. Wrapper/process exit is necessary
 * remote authority evidence, but is deliberately not this receipt.
 */
export async function retireTurnWorkspaceGeneration(
  adapter: CursorProviderAdapter,
  handle: CursorProviderHandle,
  turn: LiveTurn,
  trustedRemoteAuthorityEvidence?: CursorTurnTerminal | true,
): Promise<void> {
  const generation = turn.workspaceGeneration;
  if (!generation) return;
  // A wrapper exit alone does not prove that its native process group and
  // one-turn remote capabilities are gone. Validate the exact durable
  // terminal before renaming, freezing, or applying any provider-authored
  // filesystem state. On failure, retain the ready generation receipt so a
  // successor can recover only after it obtains trusted containment proof.
  if (turn.child.requiresDurableTerminalEvidence && !trustedRemoteAuthorityEvidence) {
    adapter.readTrustedDurableTurnTerminal(handle, turn);
  }
  try {
    const receipt = await generation.retireAndReconcile();
    if (receipt.phase !== "cleaned") {
      throw new Error(`unexpected terminal phase ${receipt.phase}`);
    }
    adapter.restoreConversationNamespace(handle, generation);
    if (turn.child.requiresDurableTerminalEvidence && turn.roomTurnId) {
      turn.workspaceGenerationSettlement = adapter.recordGenerationSettlement(handle, turn.roomTurnId, generation.manifestPath, "cleaned");
    }
    turn.workspaceGeneration = null;
  } catch (error) {
    throw new CursorRoomTurnRecoveryError(
      `Cursor's private workspace generation could not be retired and reconciled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function restoreConversationNamespace(adapter: CursorProviderAdapter, handle: CursorProviderHandle, generation: SupervisedWorkspaceGenerationHandle): void {
  if (!handle.supervisedProfile || (generation.realWorkspace !== resolve(handle.cwd)
    && generation.realWorkspace !== realpathSync(handle.cwd))) {
    throw new CursorRoomTurnRecoveryError("Cursor conversation recovery does not match this attempt's workspace.");
  }
  const continuation = handle.providerContinuationId?.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX)
    ? null : handle.providerContinuationId;
  adapter.deps.relocateConversationNamespace(handle.supervisedProfile,
    generation.liveWorkspace, generation.realWorkspace, continuation);
}

export function verifyRestingConversation(adapter: CursorProviderAdapter, handle: CursorProviderHandle, settlement: CursorGenerationSettlement): void {
  if (!handle.supervisedProfile || settlement.provider_continuation_id !== handle.providerContinuationId) {
    throw new CursorRoomTurnRecoveryError("Cursor conversation settlement belongs to another continuation.");
  }
  const workspace = realpathSync(handle.cwd);
  adapter.deps.relocateConversationNamespace(handle.supervisedProfile, workspace, workspace,
    handle.providerContinuationId.startsWith(CURSOR_PENDING_CONTINUATION_PREFIX) ? null : handle.providerContinuationId);
}

/** Extend the exited wrapper's existing journal before its generation receipt
 * can be deleted. Native evidence stays intact; a crash after cleanup can
 * verify this exact settlement without treating a missing file as proof. */
export function recordGenerationSettlement(adapter: CursorProviderAdapter, handle: CursorProviderHandle, turnId: string, manifestPath: string,
  phase: CursorGenerationSettlement["phase"]): CursorGenerationSettlement {
  if (!handle.supervisedProfile || !handle.providerContinuationId) throw new CursorRoomTurnRecoveryError("Cursor conversation settlement has no exact owner.");
  const path = join(handle.supervisedProfile.configDir,
    `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl.terminal.json`);
  const text = readBoundedCursorTurnFile(path, MAX_DURABLE_TURN_TERMINAL_BYTES, "Cursor generation settlement");
  if (text === null) throw new CursorRoomTurnRecoveryError("Cursor generation settlement has no terminal evidence.");
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw.workspace_generation_manifest_path !== manifestPath || raw.native_process_group_reaped !== true
    || raw.reap_scope !== "native_process_group" || raw.remote_authority_revoked !== true
    || (phase === "aborted" ? raw.type !== "not_started" : raw.type !== "exit" && raw.type !== "error")) {
    throw new CursorRoomTurnRecoveryError("Cursor generation settlement does not match the retired turn.");
  }
  const settlement: CursorGenerationSettlement = { version: 1, phase, provider_continuation_id: handle.providerContinuationId };
  if (raw.workspace_generation_settlement !== undefined) {
    const previous = raw.workspace_generation_settlement as CursorGenerationSettlement | null;
    if (!previous || previous.version !== settlement.version || previous.phase !== phase
      || previous.provider_continuation_id !== settlement.provider_continuation_id) {
      throw new CursorRoomTurnRecoveryError("Cursor conversation settlement conflicts with its existing journal.");
    }
  }
  const contents = JSON.stringify({ ...raw, workspace_generation_settlement: settlement });
  if (Buffer.byteLength(contents) > MAX_DURABLE_TURN_TERMINAL_BYTES) throw new CursorRoomTurnRecoveryError("Cursor generation settlement exceeds its journal limit.");
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const file = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { writeFileSync(file, contents); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    // Windows cannot fsync a folder handle (EPERM); NTFS journals the rename itself.
    if (process.platform !== "win32") {
      const parent = openSync(dirname(path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* preserve settlement failure */ }
    throw new CursorRoomTurnRecoveryError(`Cursor conversation settlement could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
  return settlement;
}

export async function abandonTurnWorkspaceGeneration(
  adapter: CursorProviderAdapter,
  generation: SupervisedWorkspaceGenerationHandle,
): Promise<void> {
  const receipt = await generation.abandon();
  if (receipt.phase !== "aborted") {
    throw new CursorRoomTurnRecoveryError(
      `Cursor's unreleased private workspace generation ended in ${receipt.phase}, not aborted.`,
    );
  }
  // Native work never crossed the release boundary, so no later result
  // checkpoint can need this receipt for crash recovery.
  await adapter.deps.removeWorkspaceGenerationReceipt(receipt.manifestPath);
}
