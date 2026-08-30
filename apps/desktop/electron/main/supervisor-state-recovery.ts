import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";

type SecretStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
};

function electronStorage(): SecretStorage {
  const electron = createRequire(import.meta.url)("electron") as { safeStorage?: SecretStorage };
  if (!electron.safeStorage) throw new Error("Desktop secure storage is unavailable.");
  return electron.safeStorage;
}

/** One-time AES key; only its OS-sealed envelope may be written to disk. */
export function createStateRecoveryKey(storage: SecretStorage = electronStorage()): { key: Buffer; sealedKey: string } {
  if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === "basic_text") {
    throw new Error("Database upgrades require OS-backed secure storage.");
  }
  const key = randomBytes(32);
  try {
    const encoded = key.toString("base64");
    const sealed = storage.encryptString(encoded);
    if (!sealed.length || storage.decryptString(sealed) !== encoded) {
      throw new Error("Secure storage verification failed.");
    }
    return { key, sealedKey: sealed.toString("base64") };
  } catch {
    key.fill(0);
    throw new Error("Secure storage could not protect the database recovery key.");
  }
}

/**
 * Serve the exact child launched by Electron, before its control socket opens.
 * No key in argv, environment, lifecycle logs, renderer IPC, or room events.
 * Existing/up-to-date databases never request a key (or touch the Keychain).
 */
export function prepareSupervisorState(
  child: ChildProcess,
  createKey: () => { key: Buffer; sealedKey: string } = createStateRecoveryKey,
  callerWaitMs = 30_000,
): Promise<void> {
  // Injected legacy test/process ports without IPC do not own secure bootstrap.
  if (typeof child.send !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let requested = false;
    let settled = false;
    let keyUnavailable = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", receive);
      child.off("error", exited);
      child.off("exit", exited);
      child.off("disconnect", exited);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish(new Error(keyUnavailable
      ? "Secure storage is unavailable. Unlock it and retry the Desktop database upgrade."
      : "The supervisor could not prepare its database. Existing state has not been replaced; check the local service diagnostics."));
    const receive = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const value = message as Record<string, unknown>;
      if (value.type === "state_recovery_ready") { finish(); return; }
      if (value.type === "state_recovery_failed") { exited(); return; }
      if (value.type !== "state_recovery_key_request" || requested
        || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)) return;
      requested = true;
      let material: ReturnType<typeof createStateRecoveryKey> | undefined;
      try {
        material = createKey();
        child.send!({ type: "state_recovery_key", id: value.id,
          key: material.key.toString("base64"), sealedKey: material.sealedKey }, (error) => {
          if (error) exited();
        });
      } catch {
        keyUnavailable = true;
        try {
          if (child.connected) child.send!({ type: "state_recovery_key", id: value.id, error: "secure_storage_unavailable" }, () => undefined);
        } catch { /* a closed child channel cannot receive the generic denial */
        } finally { exited(); }
      } finally {
        material?.key.fill(0);
      }
    };
    // Bound the caller's wait, not the work. A slow snapshot keeps its singleton
    // and may finish normally; a later request can attach once the socket opens.
    // Never kill the child or cancel its SQLite transaction on this deadline.
    const timer = setTimeout(() => finish(new Error(
      "The supervisor has not confirmed database preparation yet. It may still be preparing; retry shortly or check the local service diagnostics. The upgrade has not been cancelled.",
    )), callerWaitMs);
    child.on("message", receive);
    child.once("error", exited);
    child.once("exit", exited);
    child.once("disconnect", exited);
  });
}
