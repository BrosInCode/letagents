import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * A remote MCP session's saved state holds agent session tokens, so it is
 * stored encrypted with a key derived from the owner token that opened the
 * session. The database keeps only the token's SHA-256, so a reader of
 * `remote_mcp_sessions` cannot use the state; every request that may use it
 * carries the token anyway.
 */

/** Sessions store the SHA-256 hex of their token, as owner_tokens does. */
export function hashRemoteMcpToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function deriveRemoteMcpStateKey(token: string, sessionId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), Buffer.from(sessionId, "utf8"),
    Buffer.from("letagents remote mcp session state v1", "utf8"), 32));
}

export interface SealedRemoteMcpState {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function sealRemoteMcpState(state: unknown, key: Buffer, sessionId: string): SealedRemoteMcpState {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(sessionId, "utf8"));
  const data = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** The saved state, or null when it does not open with this key and session. */
export function openRemoteMcpState(sealed: unknown, key: Buffer, sessionId: string): unknown | null {
  const value = sealed as Partial<SealedRemoteMcpState> | null;
  if (!value || value.v !== 1 || typeof value.iv !== "string" || typeof value.tag !== "string"
    || typeof value.data !== "string") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(sessionId, "utf8"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}
