import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import type { AuthenticatedHostApprovalRequest, HostApprovalChallenge } from "../shared/host-approval-auth.js";

/** Immutable enrollment comes only from Electron's private child bootstrap. */
export class HostApprovalVerifier {
  private readonly key: KeyObject | null;
  private readonly boot: HostApprovalChallenge;
  constructor(daemonGeneration: number, publicKey: string | null) {
    let key: KeyObject | null = null;
    let keyFingerprint = "";
    try {
      if (!Number.isSafeInteger(daemonGeneration) || daemonGeneration < 1 || typeof publicKey !== "string") throw new Error();
      const bytes = Buffer.from(publicKey, "base64");
      if (bytes.length !== 44 || bytes.toString("base64") !== publicKey) throw new Error();
      key = createPublicKey({ key: bytes, format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") throw new Error();
      keyFingerprint = createHash("sha256").update(bytes).digest("hex");
    } catch { key = null; }
    this.key = key;
    this.boot = Object.freeze({ daemonGeneration, bootNonce: randomBytes(32).toString("base64url"), keyFingerprint });
  }

  challenge(): HostApprovalChallenge | null { return this.key ? { ...this.boot } : null; }

  /** Authentication is not pending-request, risk, or decision authority. */
  verify(envelope: unknown, nowMs = Date.now()): AuthenticatedHostApprovalRequest | null {
    try {
      if (!this.key || !envelope || typeof envelope !== "object" || Array.isArray(envelope)
        || !Number.isSafeInteger(nowMs) || nowMs < 0) return null;
      const signed = envelope as Record<string, unknown>;
      if (Object.keys(signed).length !== 2 || typeof signed.payload !== "string" || typeof signed.signature !== "string"
        || Buffer.byteLength(signed.payload) > 65_536 || !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature)) return null;
      if (!verify(null, Buffer.from(signed.payload), this.key, Buffer.from(signed.signature, "base64"))) return null;
      const payload = JSON.parse(signed.payload) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 9
        || payload.domain !== "letagents.host-approval" || payload.version !== 1
        || payload.daemonGeneration !== this.boot.daemonGeneration || payload.bootNonce !== this.boot.bootNonce
        || payload.keyFingerprint !== this.boot.keyFingerprint || !Object.hasOwn(payload, "input")
        || (payload.operation !== "list" && payload.operation !== "decide")
        || !Number.isSafeInteger(payload.issuedAt) || (payload.issuedAt as number) < 0 || !Number.isSafeInteger(payload.expiresAt)
        || (payload.issuedAt as number) > nowMs || (payload.expiresAt as number) <= nowMs
        || (payload.expiresAt as number) - (payload.issuedAt as number) > 30_000
        || (payload.expiresAt as number) <= (payload.issuedAt as number)) return null;
      return { operation: payload.operation, input: payload.input };
    } catch { return null; }
  }
}
