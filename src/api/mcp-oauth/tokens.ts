import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets of the MCP authorization server. Each is 32 random bytes as hex,
 * and the database keeps only its SHA-256 hex (as owner_tokens does).
 *
 * Access and refresh tokens carry the grant secret in front of their own
 * random part: `lmcp_at.<grant secret>.<random>`. A remote MCP session binds to
 * the grant secret, not to one access token, so a session survives the hourly
 * access token refresh. The grant secret alone opens nothing: a request also
 * needs the stored hash of the whole token to match an unexpired token row.
 */
export const ACCESS_TOKEN_PREFIX = "lmcp_at";
export const REFRESH_TOKEN_PREFIX = "lmcp_rt";

const HEX_64 = "[0-9a-f]{64}";
const ACCESS_TOKEN = new RegExp(`^${ACCESS_TOKEN_PREFIX}\\.(${HEX_64})\\.${HEX_64}$`);
const REFRESH_TOKEN = new RegExp(`^${REFRESH_TOKEN_PREFIX}\\.(${HEX_64})\\.${HEX_64}$`);

export function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

export function mintToken(kind: "access" | "refresh", grantSecret: string): string {
  return `${kind === "access" ? ACCESS_TOKEN_PREFIX : REFRESH_TOKEN_PREFIX}.${grantSecret}.${randomSecret()}`;
}

/** True when a bearer has the access token shape; such bearers are only ever OAuth tokens. */
export function looksLikeMcpAccessToken(token: string): boolean {
  return token.startsWith(`${ACCESS_TOKEN_PREFIX}.`);
}

/** The grant secret inside a well-formed token of this kind, or null. */
export function grantSecretOf(kind: "access" | "refresh", token: string): string | null {
  const match = (kind === "access" ? ACCESS_TOKEN : REFRESH_TOKEN).exec(token);
  return match ? match[1]! : null;
}

/** RFC 7636: verifier is 43-128 unreserved characters; S256 is the only method accepted. */
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeChallenge(value: string): boolean {
  return CODE_CHALLENGE.test(value);
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return safeEqual(computed, challenge);
}
