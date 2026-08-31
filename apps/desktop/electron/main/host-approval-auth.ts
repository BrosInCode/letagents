import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { HostApprovalChallenge, HostApprovalOperation, SignedHostApprovalRequest } from "../../shared/host-approval-auth.js";

type SecretStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
};
export type HostApprovalSigner = {
  readonly publicKey: string;
  sign(challenge: HostApprovalChallenge, operation: HostApprovalOperation, input: unknown, nowMs?: number): SignedHostApprovalRequest;
};
const unavailable = () => new Error("Host approval signing is unavailable. Unlock secure storage or restore its sealed identity; existing state was preserved.");

function defaults(): { path: string; storage: SecretStorage } {
  try {
    const electron = createRequire(import.meta.url)("electron") as {
      app?: { getPath(name: "userData"): string }; safeStorage?: SecretStorage;
    };
    if (!electron.app || !electron.safeStorage) throw unavailable();
    return { path: join(electron.app.getPath("userData"), "host-approval", "signing-key.sealed"), storage: electron.safeStorage };
  } catch { throw unavailable(); }
}

/** OS-sealed identity, durably published before its public verifier is enrolled. */
export async function loadHostApprovalSigner(path?: string, storage?: SecretStorage): Promise<HostApprovalSigner> {
  try {
    if (!path || !storage) {
      const configured = defaults(); path ??= configured.path; storage ??= configured.storage;
    }
    if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === "basic_text") throw unavailable();
    try { await mkdir(dirname(path), { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
      || (process.getuid && parent.uid !== process.getuid())) throw unavailable();
    const readSealed = async (): Promise<string | null> => {
      let file;
      try { file = await open(path!, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 16_384 || stat.size < 1
          || (process.getuid && stat.uid !== process.getuid())) throw unavailable();
        const stored = JSON.parse(await file.readFile("utf8")) as { version?: unknown; sealedKey?: unknown };
        if (stored.version !== 1 || typeof stored.sealedKey !== "string" || !stored.sealedKey
          || Object.keys(stored).length !== 2 || Buffer.from(stored.sealedKey, "base64").toString("base64") !== stored.sealedKey) throw unavailable();
        return stored.sealedKey;
      } finally { await file.close(); }
    };
    let sealed = await readSealed();
    if (sealed === null) {
      const { privateKey } = generateKeyPairSync("ed25519");
      const encoded = privateKey.export({ type: "pkcs8", format: "der" });
      let bytes: Buffer;
      try {
        const plaintext = encoded.toString("base64");
        const ciphertext = storage.encryptString(plaintext);
        if (!ciphertext.length || ciphertext.length > 8_192 || storage.decryptString(ciphertext) !== plaintext) throw unavailable();
        bytes = Buffer.from(JSON.stringify({ version: 1, sealedKey: ciphertext.toString("base64") }));
      } finally { encoded.fill(0); }
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(bytes); await file.sync(); await file.close();
        // link is exclusive: a racing creator cannot overwrite the stable key.
        try { await link(temporary, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally {
        await file.close().catch(() => undefined);
        await unlink(temporary);
      }
      sealed = await readSealed();
    }
    if (!sealed) throw unavailable();
    // Also sync for readers: another creator may have linked the complete key
    // but not yet synced its directory. No reader may enroll it prematurely.
    for (const directoryPath of [dirname(path), dirname(dirname(path))]) {
      const directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    }
    const encodedPrivate = storage.decryptString(Buffer.from(sealed, "base64"));
    const raw = Buffer.from(encodedPrivate, "base64");
    let privateKey;
    try {
      if (raw.length !== 48 || raw.toString("base64") !== encodedPrivate) throw unavailable();
      privateKey = createPrivateKey({ key: raw, type: "pkcs8", format: "der" });
    }
    finally { raw.fill(0); }
    if (privateKey.asymmetricKeyType !== "ed25519") throw unavailable();
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
    const keyFingerprint = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
    return Object.freeze({ publicKey, sign(challenge, operation, input, nowMs = Date.now()) {
      try {
        if (!challenge || !Number.isSafeInteger(challenge.daemonGeneration) || challenge.daemonGeneration < 1
          || !/^[A-Za-z0-9_-]{43}$/.test(challenge.bootNonce) || challenge.keyFingerprint !== keyFingerprint
          || !["list", "decide"].includes(operation) || !Number.isSafeInteger(nowMs) || nowMs < 0
          || !Number.isSafeInteger(nowMs + 30_000)) throw unavailable();
        const payload = JSON.stringify({ domain: "letagents.host-approval", version: 1,
          daemonGeneration: challenge.daemonGeneration, bootNonce: challenge.bootNonce, keyFingerprint,
          issuedAt: nowMs, expiresAt: nowMs + 30_000, operation, input });
        if (Buffer.byteLength(payload) > 65_536 || !Object.hasOwn(JSON.parse(payload), "input")) throw unavailable();
        return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString("base64") };
      } catch { throw unavailable(); }
    } } satisfies HostApprovalSigner);
  } catch { throw unavailable(); }
}
