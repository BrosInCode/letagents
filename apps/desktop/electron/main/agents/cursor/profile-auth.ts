// Cursor login state in managed profiles: sanitized auth files and attested personal identity.

import { join } from "node:path";
import { pathEntryExists, readRegularFileNoFollow, writePrivateFileAtomic } from "./profile-filesystem.js";
import {
  CURSOR_AUTH_INFO_KEYS,
  MAX_CURSOR_CONFIG_BYTES,
  type CursorManagedProfile,
  type CursorPersonalIdentity,
} from "./profile-types.js";

export function sanitizeOptionalPrivateAuthFile(
  source: string,
  destination: string,
  allowedKeys: ReadonlySet<string>,
  preferSource: boolean,
): void {
  // A just-attested explicit source is authoritative over stale per-attempt
  // metadata. Ordinary stable profiles remain destination-first so provider
  // token refreshes survive when no live identity source was supplied.
  const selectedPath = preferSource
    ? pathEntryExists(source)
      ? source
      : pathEntryExists(destination)
        ? destination
        : null
    : pathEntryExists(destination)
      ? destination
      : pathEntryExists(source)
        ? source
        : null;
  if (!selectedPath) return;
  const raw = readRegularFileNoFollow(selectedPath, MAX_CURSOR_CONFIG_BYTES).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cursor auth config is invalid at ${selectedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cursor auth config must be an object at ${selectedPath}.`);
  }
  const authOnly: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowedKeys.has(key)) continue;
    authOnly[key] = key === "authInfo"
      ? sanitizeCursorAuthInfo(value, selectedPath)
      : sanitizeCursorAuthScalar(value, `${selectedPath}:${key}`);
  }
  // Rewrite on every turn. Cursor may persist runtime state inside the private
  // profile, but authority-affecting keys never survive into the next launch.
  writePrivateFileAtomic(destination, `${JSON.stringify(authOnly, null, 2)}\n`);
}

function sanitizeCursorAuthInfo(value: unknown, sourcePath: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cursor authInfo must be an object at ${sourcePath}.`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!CURSOR_AUTH_INFO_KEYS.has(key)) continue;
    result[key] = sanitizeCursorAuthScalar(entry, `${sourcePath}:authInfo.${key}`);
  }
  return result;
}

function sanitizeCursorAuthScalar(value: unknown, label: string): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 256 * 1024 || value.includes("\0")) {
      throw new Error(`Cursor auth value is invalid at ${label}.`);
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) {
    return value;
  }
  throw new Error(`Cursor auth value must be a bounded scalar at ${label}.`);
}

/**
 * Cursor's team policy RPC mixes restrictions with settings that can widen
 * autorun, MCP, and sandbox authority. Blocking it makes the native CLI fail
 * open; forwarding it raw would import remote authority. Until the desktop can
 * protobuf-decode and intersect that policy, fail closed for team identities.
 */
export function assertCursorAuthIsNotTeamManaged(cursorHomeDir: string): void {
  for (const name of ["cli-config.json", "agent-cli-state.json"]) {
    const path = join(cursorHomeDir, name);
    if (!pathEntryExists(path)) continue;
    const parsed = JSON.parse(readRegularFileNoFollow(path, MAX_CURSOR_CONFIG_BYTES).toString("utf8")) as {
      authInfo?: unknown;
    };
    const authInfo = parsed.authInfo;
    if (authInfo
      && typeof authInfo === "object"
      && !Array.isArray(authInfo)
      && Object.prototype.hasOwnProperty.call(authInfo, "teamId")
      && (authInfo as Record<string, unknown>).teamId !== null
      && (authInfo as Record<string, unknown>).teamId !== undefined) {
      throw new Error(
        "Team-managed Cursor accounts are not supported for supervised agents because Cursor team policy cannot be safely mediated yet. Use a non-team Cursor account.",
      );
    }
  }
}

export function applyAttestedCursorPersonalIdentity(
  cursorHomeDir: string,
  identity: CursorPersonalIdentity,
): void {
  if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0) {
    throw new Error("Cursor live identity attestation returned an invalid user id.");
  }
  for (const name of ["cli-config.json", "agent-cli-state.json"]) {
    const path = join(cursorHomeDir, name);
    if (!pathEntryExists(path)) continue;
    const parsed = JSON.parse(readRegularFileNoFollow(path, MAX_CURSOR_CONFIG_BYTES).toString("utf8")) as Record<string, unknown>;
    const authInfo: Record<string, unknown> = {};
    authInfo.userId = identity.userId;
    if (identity.email) authInfo.email = identity.email;
    else delete authInfo.email;
    parsed.authInfo = authInfo;
    writePrivateFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }
}

/** Bind a native continuation to the personal account that first created it. */
export function bindCursorSupervisedIdentity(
  profile: CursorManagedProfile,
  identity: CursorPersonalIdentity,
): void {
  if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0) {
    throw new Error("Cursor live identity attestation returned an invalid user id.");
  }
  const path = join(profile.configDir, "letagents-cursor-identity.json");
  if (pathEntryExists(path)) {
    const parsed = JSON.parse(readRegularFileNoFollow(path, 16 * 1024).toString("utf8")) as Record<string, unknown>;
    if (parsed.userId !== identity.userId) {
      throw new Error(
        "Cursor account changed during this supervised attempt; start a new agent instead of resuming another account's session.",
      );
    }
    return;
  }
  writePrivateFileAtomic(path, `${JSON.stringify({ userId: identity.userId }, null, 2)}\n`);
}
