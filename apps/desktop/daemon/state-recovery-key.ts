import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DAEMON_STATE_USER_VERSION,
  DaemonStateDatabase,
  DaemonStateSchema,
  moveAsideLegacyDaemonStateDatabase,
  recordLegacyStateResetNotice,
  type LegacyMoveAsideResult,
} from "./daemon-state-database.js";
import { prepareStateRecoveryBackup, markStateRecoveryBackupValidated, cleanupStateRecoveryBackup, recordStateRecoveryBackupWarning, stateRecoveryBackupAwaitsValidation, StateRecoveryError } from "./state-recovery-backup.js";
import { compactDaemonStateDatabase } from "./daemon-state-maintenance.js";

export type StateRecoveryBootstrap = {
  getBackupKey?: typeof requestStateRecoveryKey;
  /** Trusted parent/bootstrap injection, never a socket enrollment operation. */
  getHostApprovalPublicKey?: typeof requestHostApprovalVerifier;
  onPrepared?: (failed?: boolean) => Promise<void>;
};

/** Every daemon birth requests its public verifier before readiness disconnects IPC. */
export function requestHostApprovalVerifier(): Promise<string | null> {
  if (!process.send || !process.connected) return Promise.resolve(null);
  const id = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (publicKey: string | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("message", receive);
      process.off("disconnect", disconnected);
      resolve(publicKey);
    };
    const disconnected = () => finish();
    const receive = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const value = message as Record<string, unknown>;
      if (value.type !== "host_approval_verifier" || value.id !== id) return;
      finish(typeof value.publicKey === "string" && value.publicKey.length <= 128 ? value.publicKey : null);
    };
    // Enrollment precedes readiness. An IPC spawner that never answers pays
    // this bounded second; missing/locked custody then disables only approvals.
    const timer = setTimeout(disconnected, 1_000);
    process.on("message", receive);
    process.once("disconnect", disconnected);
    try { process.send!({ type: "host_approval_verifier_request", id }, (error) => { if (error) disconnected(); }); }
    catch { disconnected(); }
  });
}

export type ProtectedStateUpgradeContext = {
  /**
   * True when every stored entry and payload must parse before validation
   * completes: this start upgraded the schema or rewrote the database, or a
   * recovery backup still waits for its validation receipt.
   */
  validateFullState: boolean;
};

/**
 * Caller holds the daemon singleton. Opens the process's single SQLite
 * connection after retiring any legacy database and taking any required
 * encrypted backup for future modern schema upgrades. When `keepOpen` is true,
 * the caller takes ownership of the returned DaemonStateDatabase handle.
 */
export async function withProtectedStateUpgrade<T>(
  path: string,
  initialize: (database: DaemonStateDatabase, context: ProtectedStateUpgradeContext) => Promise<T>,
  bootstrap: StateRecoveryBootstrap,
  assertCurrent?: () => Promise<void>,
  options: { keepOpen?: boolean; workspaceRoot?: string } = {},
): Promise<T> {
  let stateDatabase: DaemonStateDatabase | null = null;
  try {
    const legacyReset: { moved: LegacyMoveAsideResult | null } = { moved: null };
    await moveAsideLegacyDaemonStateDatabase(path, {
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      onMovedAside: (moved) => { legacyReset.moved = moved; },
    });
    const freshBackup = await prepareStateRecoveryBackup(path, DAEMON_STATE_USER_VERSION, bootstrap.getBackupKey ?? requestStateRecoveryKey);
    stateDatabase = await DaemonStateDatabase.open(
      path,
      (opened) => new DaemonStateSchema().createSchema(opened),
      options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : undefined,
    );
    const database = stateDatabase.connection;
    if (legacyReset.moved) {
      recordLegacyStateResetNotice(database, legacyReset.moved);
    }
    let rewritten = false;
    if (assertCurrent) {
      const maintenance = await compactDaemonStateDatabase(path, database, assertCurrent);
      // A checkpoint result also follows a completed copy: the content is new even when the WAL is not reclaimed yet.
      rewritten = maintenance === "compacted" || maintenance === "checkpoint_busy" || maintenance === "checkpoint_failed";
      if (maintenance !== "not_needed" && maintenance !== "compacted") {
        const now = new Date().toISOString();
        database.prepare(`INSERT INTO daemon_maintenance_state(key,value_json,updated_at)
          VALUES ('state-space-maintenance',?,?) ON CONFLICT(key)
          DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
          .run(JSON.stringify({ reason: maintenance }), now);
      } else {
        database.exec("DELETE FROM daemon_maintenance_state WHERE key='state-space-maintenance'");
      }
    }
    const validateFullState = freshBackup !== null || rewritten
      || await stateRecoveryBackupAwaitsValidation(path, database);
    const result = await initialize(stateDatabase, { validateFullState });
    new DaemonStateSchema().validateCurrentShape(database);
    const validation = await markStateRecoveryBackupValidated(path, database, { freshBackup });
    if (validation.status !== "unverified") {
      try { await cleanupStateRecoveryBackup(path, database); }
      catch { recordStateRecoveryBackupWarning(database, "recovery_snapshot_cleanup_failed"); }
    }
    if (!options.keepOpen) {
      stateDatabase.close();
      stateDatabase = null;
    }
    await bootstrap.onPrepared?.();
    return result;
  } catch (error) {
    try { stateDatabase?.close(); } catch { /* preserve the triggering error */ }
    await bootstrap.onPrepared?.(true);
    throw error;
  }
}

/** Bootstrap-only private parent channel. Never a renderer/control-socket API. */
export function requestStateRecoveryKey(): Promise<{ key: Buffer; sealedKey: string }> {
  if (!process.send || !process.connected) {
    return Promise.reject(new StateRecoveryError("desktop_channel_missing"));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: { key: Buffer; sealedKey: string }) => {
      clearTimeout(timer);
      process.off("message", receive);
      process.off("disconnect", disconnected);
      if (error) reject(error); else resolve(result!);
    };
    const disconnected = () => finish(new StateRecoveryError("key_unavailable"));
    const receive = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const value = message as Record<string, unknown>;
      if (value.type !== "state_recovery_key" || value.id !== id) return;
      if (value.error) {
        finish(new StateRecoveryError("key_unavailable"));
        return;
      }
      const key = typeof value.key === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value.key)
        ? Buffer.from(value.key, "base64") : Buffer.alloc(0);
      if (key.length !== 32 || typeof value.sealedKey !== "string" || !value.sealedKey.length || value.sealedKey.length > 16384) {
        key.fill(0);
        finish(new StateRecoveryError("key_unavailable"));
        return;
      }
      finish(undefined, { key, sealedKey: value.sealedKey });
    };
    // This bounds key handoff before schema mutation, not provider work.
    const timer = setTimeout(() => finish(new StateRecoveryError("key_unavailable")), 30_000);
    process.on("message", receive);
    process.once("disconnect", disconnected);
    process.send!({ type: "state_recovery_key_request", id }, (error) => {
      if (error) disconnected();
    });
  });
}

/** Close the bootstrap channel so a detached daemon outlives Electron. */
export async function reportStateRecoveryReady(error = false): Promise<void> {
  if (!process.send || !process.connected) return;
  await new Promise<void>((resolve) => {
    process.send!({ type: error ? "state_recovery_failed" : "state_recovery_ready" }, () => resolve());
  });
  if (process.connected) process.disconnect();
}
