import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { apiFetch, DesktopApiError } from "./auth.js";
import type { DesktopProvisionSupervisorGrantInput, DesktopSupervisorGrantMetadata } from "../ipc-types/supervisor-grant.js";

const require = createRequire(import.meta.url);

interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type StoredGrant = DesktopSupervisorGrantMetadata & {
  /** Canonical agent identity. This is deliberately not a display name. */
  agentKey: string;
  /** Durable desktop-managed agent entry identity; never a renderer secret. */
  entryId?: string;
  /** Last daemon generation that safely installed this grant, if any. */
  lastInstalledDaemonGeneration?: number | null;
  encryptedToken: string;
};
type LegacyStoredGrant = DesktopSupervisorGrantMetadata & { encryptedToken: string };
/**
 * The entry map is intentionally separate from the encrypted bearer records:
 * it is durable, non-secret identity metadata used to recover a daemon-inbox
 * worker after Electron restarts.  Never derive this from a mutable label.
 */
type StoredGrantRegistry = {
  version: 4;
  grants: Record<string, StoredGrant>;
  entryAgentKeys: Record<string, string>;
  /**
   * A DELETE acknowledgement must survive an Electron restart until the
   * daemon consumes it. Without this receipt, a missing registry or mapping
   * is an ambiguity, not proof that the remote grant was revoked.
   */
  purgeRevocationReceipts: Record<string, {
    agentKey: string;
    grantId: string;
    acknowledgedAt: string;
  }>;
};
const MANUAL_GRANT_KEY = "__manual__";
const registryMutationTails = new Map<string, Promise<void>>();
const agentLifecycleTails = new Map<string, Promise<void>>();

export type { DesktopProvisionSupervisorGrantInput, DesktopSupervisorGrantMetadata } from "../ipc-types/supervisor-grant.js";

function getStorage(): SecretStorage {
  try {
    const electron = require("electron") as { safeStorage?: SecretStorage };
    if (electron.safeStorage) return electron.safeStorage;
  } catch { /* Node/test runtime */ }
  return {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8"),
  };
}

function storePath(): string {
  const override = process.env.LETAGENTS_SUPERVISOR_GRANT_STORE_PATH?.trim();
  if (override) return override;
  try {
    const electron = require("electron") as { app?: { getPath(name: "userData"): string } };
    const userData = electron.app?.getPath("userData");
    if (userData) return join(userData, "letagents-supervisor-grant.json");
  } catch { /* Node/test runtime */ }
  return join(homedir(), ".letagents", "desktop", "letagents-supervisor-grant.json");
}

// Exported for a mockable Keychain-storage test. The raw token is only ever
// passed through main-process functions and is never put in IPC return values.
export function encryptSupervisorGrantForStorage(token: string, storage = getStorage()): string {
  if (!storage.isEncryptionAvailable()) {
    throw new Error("macOS Keychain encryption is unavailable; host grant was not stored.");
  }
  return `safe:${storage.encryptString(token).toString("base64")}`;
}

export function decryptSupervisorGrantFromStorage(value: string, storage = getStorage()): string | null {
  if (!value.startsWith("safe:") || !storage.isEncryptionAvailable()) return null;
  try { return storage.decryptString(Buffer.from(value.slice(5), "base64")); } catch { return null; }
}

function toMetadata(response: {
  grant_id: string; host_id: string; installation_id: string; allowed_room_ids: string[];
  allowed_agent_keys: string[]; current_generation: number; expires_at: string;
}): DesktopSupervisorGrantMetadata {
  return {
    grantId: response.grant_id, hostId: response.host_id, installationId: response.installation_id,
    allowedRoomIds: response.allowed_room_ids, allowedAgentKeys: response.allowed_agent_keys,
    generation: response.current_generation, expiresAt: response.expires_at,
  };
}

/** Stable local key for a provider agent identity; never use a display name. */
export function canonicalSupervisorGrantAgentKey(agentKey: string): string {
  // The API's canonical key embeds the owner's login and is stored/looked up
  // case-sensitively (for example, `EmmyMay/stone-ridge`). Lowercasing it here
  // creates a different, nonexistent principal and makes grant provisioning
  // fail ownership validation.
  const normalized = agentKey.trim();
  if (!normalized) throw new Error("A supervised agent identity is required.");
  return normalized;
}

function metadataOf(stored: StoredGrant): DesktopSupervisorGrantMetadata {
  const { agentKey: _agentKey, entryId: _entryId, lastInstalledDaemonGeneration: _daemonGeneration, encryptedToken: _secret, ...metadata } = stored;
  return metadata;
}

function isRegistry(value: unknown): value is StoredGrantRegistry {
  return Boolean(value && typeof value === "object" && ((value as { version?: unknown }).version === 2 || (value as { version?: unknown }).version === 3 || (value as { version?: unknown }).version === 4)
    && typeof (value as { grants?: unknown }).grants === "object");
}

function registryFrom(value: unknown): StoredGrantRegistry | null {
  if (isRegistry(value)) {
    const legacy = value as {
      grants: Record<string, StoredGrant>;
      entryAgentKeys?: Record<string, unknown>;
      purgeRevocationReceipts?: Record<string, unknown>;
    };
    const entryAgentKeys: Record<string, string> = {};
    const purgeRevocationReceipts: StoredGrantRegistry["purgeRevocationReceipts"] = {};
    for (const [entryId, agentKey] of Object.entries(legacy.entryAgentKeys ?? {})) {
      if (typeof agentKey === "string" && entryId.trim() && agentKey.trim()) entryAgentKeys[entryId] = canonicalSupervisorGrantAgentKey(agentKey);
    }
    for (const [entryId, receipt] of Object.entries(legacy.purgeRevocationReceipts ?? {})) {
      if (!entryId.trim() || !receipt || typeof receipt !== "object") continue;
      const candidate = receipt as { agentKey?: unknown; grantId?: unknown; acknowledgedAt?: unknown };
      if (typeof candidate.agentKey !== "string" || !candidate.agentKey.trim()
        || typeof candidate.grantId !== "string" || !candidate.grantId.trim()
        || typeof candidate.acknowledgedAt !== "string" || !candidate.acknowledgedAt.trim()) continue;
      purgeRevocationReceipts[entryId] = {
        agentKey: canonicalSupervisorGrantAgentKey(candidate.agentKey),
        grantId: candidate.grantId.trim(),
        acknowledgedAt: candidate.acknowledgedAt,
      };
    }
    // v3 recorded the durable entry beside each grant.  Preserve that mapping
    // when upgrading, rather than guessing from a display name.
    for (const grant of Object.values(legacy.grants)) {
      if (grant.entryId?.trim() && grant.agentKey?.trim()) entryAgentKeys[grant.entryId] = canonicalSupervisorGrantAgentKey(grant.agentKey);
    }
    return { version: 4, grants: legacy.grants, entryAgentKeys, purgeRevocationReceipts };
  }
  if (!value || typeof value !== "object" || !("encryptedToken" in value)) return null;
  // Version 1 had one desktop-wide grant. Treat it as manual unless it was
  // already narrowed to a single exact agent identity.
  const legacy = value as LegacyStoredGrant;
  if (!legacy.grantId || !legacy.encryptedToken) return null;
  const candidate = legacy.allowedAgentKeys.length === 1 ? legacy.allowedAgentKeys[0] : MANUAL_GRANT_KEY;
  const agentKey = candidate === MANUAL_GRANT_KEY ? candidate : canonicalSupervisorGrantAgentKey(candidate);
  return { version: 4, grants: { [agentKey]: { ...legacy, agentKey } }, entryAgentKeys: {}, purgeRevocationReceipts: {} };
}

async function readRegistry(): Promise<StoredGrantRegistry | null> {
  try { return registryFrom(JSON.parse(await readFile(storePath(), "utf8"))); } catch { return null; }
}

async function writeRegistry(registry: StoredGrantRegistry): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Never replace an encrypted registry in-place: a crash must leave either
  // the old complete registry or the new complete registry, never JSON that
  // drops a different agent's credential.
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(registry)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

/** Serialize every registry read-modify-write in this Electron main process. */
async function withRegistryMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const path = storePath();
  const previous = registryMutationTails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => {}).then(() => gate);
  registryMutationTails.set(path, current);
  await previous.catch(() => {});
  try {
    return await mutation();
  } finally {
    release();
    await current;
    if (registryMutationTails.get(path) === current) registryMutationTails.delete(path);
  }
}

/** Serialize cache validation and provisioning for one canonical agent entry. */
async function withAgentGrantLifecycle<T>(agentKey: string, lifecycle: () => Promise<T>): Promise<T> {
  const key = `${storePath()}\u0000${agentKey}`;
  const previous = agentLifecycleTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => {}).then(() => gate);
  agentLifecycleTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await lifecycle();
  } finally {
    release();
    await current;
    if (agentLifecycleTails.get(key) === current) agentLifecycleTails.delete(key);
  }
}

export interface DesktopSupervisorGrantLifecycleInput {
  hostId: string;
  /** Durable desktop-managed agent entry identity. */
  entryId: string;
  agentKey: string;
  /** Caller-resolved room scopes; only canonical ids cross the API/storage boundary. */
  roomScopes: Array<{ requestedRoomId: string; canonicalRoomId: string }>;
  ttlMs?: number;
  lastInstalledDaemonGeneration?: number | null;
}

type SupervisorGrantApiResponse = {
  grant_id: string; host_id: string; installation_id: string; allowed_room_ids: string[];
  allowed_agent_keys: string[]; current_generation: number; expires_at: string; supervisor_grant: string;
};

type GrantStorageOptions = { storage?: SecretStorage; apiFetch?: typeof apiFetch };

/**
 * Stable server installation fence for one desktop-managed agent entry.  It
 * is intentionally derived rather than user supplied, so two agents on the
 * same desktop cannot collide at the server's host/installation unique index.
 */
export function desktopSupervisorGrantInstallationId(hostId: string, entryId: string): string {
  const host = hostId.trim();
  const entry = entryId.trim();
  if (!host || !entry) throw new Error("A desktop host and durable agent entry identity are required.");
  return `desktop-agent-${createHash("sha256").update(`${host}\u0000${entry}`).digest("hex").slice(0, 40)}`;
}

export function canonicalDesktopSupervisorGrantRoomIds(
  scopes: DesktopSupervisorGrantLifecycleInput["roomScopes"],
): string[] {
  const canonicalIds = scopes.map((scope) => scope.canonicalRoomId.trim()).filter(Boolean);
  if (canonicalIds.length !== scopes.length || canonicalIds.length === 0) {
    throw new Error("Every supervisor grant room scope requires a canonical room id.");
  }
  return [...new Set(canonicalIds)];
}

export async function provisionDesktopSupervisorGrant(
  input: DesktopProvisionSupervisorGrantInput,
  options: GrantStorageOptions = {},
): Promise<DesktopSupervisorGrantMetadata> {
  const storage = options.storage ?? getStorage();
  if (!storage.isEncryptionAvailable()) {
    throw new Error("macOS Keychain encryption is unavailable; host grant was not provisioned.");
  }
  const request = options.apiFetch ?? apiFetch;
  return withRegistryMutation(async () => {
    // Refuse replacement while any local grant exists. Keeping the check,
    // server POST, and write under one registry lock prevents a concurrent
    // managed save from being overwritten by this legacy one-entry format.
    const registry = await readRegistry();
    if (registry && Object.keys(registry.grants).length > 0) {
      throw new Error("A host grant is already stored on this desktop. Revoke it before provisioning a replacement.");
    }
    const response = await request<SupervisorGrantApiResponse>("/supervisor-host-grants", {
      method: "POST",
      body: JSON.stringify({ host_id: input.hostId, installation_id: input.installationId, allowed_room_ids: input.allowedRoomIds, allowed_agent_keys: input.allowedAgentKeys, ttl_ms: input.ttlMs }),
    });
    const metadata = toMetadata(response);
    try {
      if (metadata.allowedAgentKeys.length !== 1) {
        throw new Error("A per-agent desktop grant must be scoped to exactly one agent identity.");
      }
      const agentKey = canonicalSupervisorGrantAgentKey(metadata.allowedAgentKeys[0]!);
      const encryptedToken = encryptSupervisorGrantForStorage(response.supervisor_grant, storage);
      await writeRegistry({
        version: 4,
        grants: { [agentKey]: { ...metadata, agentKey, encryptedToken } },
        entryAgentKeys: registry?.entryAgentKeys ?? {},
        purgeRevocationReceipts: registry?.purgeRevocationReceipts ?? {},
      });
      return metadata;
    } catch (error) {
      await request(`/supervisor-host-grants/${encodeURIComponent(response.grant_id)}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  });
}

export async function getDesktopSupervisorGrantMetadata(): Promise<DesktopSupervisorGrantMetadata | null> {
  const registry = await readRegistry();
  const first = registry && Object.values(registry.grants)[0];
  return first?.grantId ? metadataOf(first) : null;
}

/** Main-process only: daemon launchers may read this; renderer IPC must not. */
export async function readDesktopSupervisorGrantToken(): Promise<string | null> {
  const registry = await readRegistry();
  if (!registry) return null;
  const manual = registry.grants[MANUAL_GRANT_KEY];
  const values = Object.values(registry.grants);
  const unambiguous = manual ?? (values.length === 1 ? values[0] : null);
  return unambiguous ? decryptSupervisorGrantFromStorage(unambiguous.encryptedToken) : null;
}

/** Main-process only. Renderer IPC intentionally exposes metadata, never this value. */
export async function readDesktopSupervisorGrantForAgent(agentKey: string, options: GrantStorageOptions = {}): Promise<{
  metadata: DesktopSupervisorGrantMetadata;
  token: string;
  entryId: string | null;
  lastInstalledDaemonGeneration: number | null;
} | null> {
  const registry = await readRegistry();
  const stored = registry?.grants[canonicalSupervisorGrantAgentKey(agentKey)];
  const token = stored && decryptSupervisorGrantFromStorage(stored.encryptedToken, options.storage);
  return stored && token ? {
    metadata: metadataOf(stored), token,
    entryId: stored.entryId?.trim() || null,
    lastInstalledDaemonGeneration: stored.lastInstalledDaemonGeneration ?? null,
  } : null;
}

/**
 * Main-process handoff helper. It stores the replacement encrypted at rest;
 * callers deliver its plaintext directly to the successor daemon socket.
 */
export async function replaceDesktopSupervisorGrantForAgent(input: {
  agentKey: string;
  metadata: DesktopSupervisorGrantMetadata;
  token: string;
  entryId?: string;
  lastInstalledDaemonGeneration?: number | null;
}, options: GrantStorageOptions = {}): Promise<void> {
  const agentKey = canonicalSupervisorGrantAgentKey(input.agentKey);
  if (!input.token.trim()) throw new Error("A supervisor grant is required.");
  if (input.metadata.allowedAgentKeys.length !== 1
    || canonicalSupervisorGrantAgentKey(input.metadata.allowedAgentKeys[0]!) !== agentKey) {
    throw new Error("A per-agent desktop grant must be scoped to that exact one agent identity.");
  }
  await withRegistryMutation(async () => {
    const registry = (await readRegistry()) ?? { version: 4, grants: {}, entryAgentKeys: {}, purgeRevocationReceipts: {} };
    if (input.entryId?.trim()) {
      registry.entryAgentKeys[input.entryId.trim()] = agentKey;
      // A newly provisioned exact grant supersedes any receipt belonging to a
      // previous lifecycle that happened to use the same durable entry id.
      delete registry.purgeRevocationReceipts[input.entryId.trim()];
    }
    registry.grants[agentKey] = {
      ...input.metadata,
      agentKey,
      entryId: input.entryId?.trim() || undefined,
      lastInstalledDaemonGeneration: input.lastInstalledDaemonGeneration ?? null,
      encryptedToken: encryptSupervisorGrantForStorage(input.token, options.storage),
    };
    await writeRegistry(registry);
  });
}

async function removeDesktopSupervisorGrantForAgentIfCurrent(agentKey: string, grantId: string): Promise<void> {
  await withRegistryMutation(async () => {
    const registry = await readRegistry();
    if (!registry || registry.grants[agentKey]?.grantId !== grantId) return;
    delete registry.grants[agentKey];
    await writeRegistry(registry);
  });
}

function reusableDesktopSupervisorGrant(input: {
  existing: Awaited<ReturnType<typeof readDesktopSupervisorGrantForAgent>>;
  agentKey: string;
  entryId: string;
  hostId: string;
  installationId: string;
  allowedRoomIds: string[];
}): boolean {
  const { existing } = input;
  if (!existing || existing.entryId !== input.entryId) return false;
  const metadata = existing.metadata;
  if (metadata.hostId !== input.hostId || metadata.installationId !== input.installationId) return false;
  if (!Number.isFinite(new Date(metadata.expiresAt).getTime())
    || new Date(metadata.expiresAt).getTime() <= Date.now()) return false;
  if (metadata.allowedAgentKeys.length !== 1) return false;
  try {
    if (canonicalSupervisorGrantAgentKey(metadata.allowedAgentKeys[0]!) !== input.agentKey) return false;
  } catch {
    return false;
  }
  const coveredRooms = new Set(metadata.allowedRoomIds);
  return coveredRooms.size === input.allowedRoomIds.length
    && input.allowedRoomIds.every((roomId) => coveredRooms.has(roomId));
}

/** Backward-compatible main-process storage name. */
export async function storeDesktopSupervisorGrantForAgent(input: {
  agentKey: string;
  metadata: DesktopSupervisorGrantMetadata;
  token: string;
  entryId?: string;
  lastInstalledDaemonGeneration?: number | null;
}, options: GrantStorageOptions = {}): Promise<void> {
  await replaceDesktopSupervisorGrantForAgent(input, options);
}

/**
 * Main-process-only lifecycle helper for desktop-managed agents.  It performs
 * the Keychain availability check before any API call, scopes every grant to
 * exactly one canonical agent key, and retains plaintext only for the caller
 * to install directly into that agent's daemon process.
 */
export async function getOrProvisionDesktopSupervisorGrantForAgent(
  input: DesktopSupervisorGrantLifecycleInput & { forceReprovision?: boolean },
  options: GrantStorageOptions = {},
): Promise<{
  metadata: DesktopSupervisorGrantMetadata;
  token: string;
  entryId: string;
  lastInstalledDaemonGeneration: number | null;
}> {
  const storage = options.storage ?? getStorage();
  if (!storage.isEncryptionAvailable()) {
    throw new Error("macOS Keychain encryption is unavailable; host grant was not provisioned.");
  }
  const agentKey = canonicalSupervisorGrantAgentKey(input.agentKey);
  const entryId = input.entryId.trim();
  const hostId = input.hostId.trim();
  const installationId = desktopSupervisorGrantInstallationId(hostId, entryId);
  const allowedRoomIds = canonicalDesktopSupervisorGrantRoomIds(input.roomScopes);
  const request = options.apiFetch ?? apiFetch;
  return withAgentGrantLifecycle(agentKey, async () => {
    const existing = await readDesktopSupervisorGrantForAgent(agentKey, { storage });
    if (!input.forceReprovision && existing && reusableDesktopSupervisorGrant({
      existing, agentKey, entryId, hostId, installationId, allowedRoomIds,
    })) {
      return {
        metadata: existing.metadata,
        token: existing.token,
        entryId,
        lastInstalledDaemonGeneration: existing.lastInstalledDaemonGeneration,
      };
    }
    if (existing) {
      // Only an acknowledged revoke (including an explicit already-revoked
      // 404) permits deleting the sole recoverable local credential. A
      // transport error is ambiguous: preserve it and make the next attempt
      // repeat DELETE rather than proceeding into an unrecoverable 409.
      try {
        await request(`/supervisor-host-grants/${encodeURIComponent(existing.metadata.grantId)}`, { method: "DELETE" });
      } catch (error) {
        if (!(error instanceof DesktopApiError && error.status === 404)) throw error;
      }
      await removeDesktopSupervisorGrantForAgentIfCurrent(agentKey, existing.metadata.grantId);
    }

    const response = await request<SupervisorGrantApiResponse>("/supervisor-host-grants", {
      method: "POST",
      body: JSON.stringify({
        host_id: hostId,
        installation_id: installationId,
        allowed_room_ids: allowedRoomIds,
        allowed_agent_keys: [agentKey],
        ttl_ms: input.ttlMs,
      }),
    });
    const metadata = toMetadata(response);
    try {
      if (metadata.installationId !== installationId || metadata.allowedAgentKeys.length !== 1
        || canonicalSupervisorGrantAgentKey(metadata.allowedAgentKeys[0]!) !== agentKey) {
        throw new Error("The provisioned desktop grant was not scoped to the requested agent entry.");
      }
      await replaceDesktopSupervisorGrantForAgent({
        agentKey, metadata, token: response.supervisor_grant, entryId,
        lastInstalledDaemonGeneration: input.lastInstalledDaemonGeneration ?? null,
      }, { storage });
      return {
        metadata, token: response.supervisor_grant, entryId,
        lastInstalledDaemonGeneration: input.lastInstalledDaemonGeneration ?? null,
      };
    } catch (error) {
      await request(`/supervisor-host-grants/${encodeURIComponent(response.grant_id)}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  });
}

/** Return the stored canonical identity for one exact durable manifest entry. */
export async function readDesktopSupervisorGrantAgentKeyForEntry(entryId: string): Promise<string | null> {
  const registry = await readRegistry();
  const agentKey = registry?.entryAgentKeys[entryId.trim()];
  return agentKey?.trim() ? canonicalSupervisorGrantAgentKey(agentKey) : null;
}

/** Read the renderer-safe identity projection with one Keychain decrypt per manifest refresh. */
export async function readDesktopSupervisorGrantAgentKeysForEntries(
  entryIds: readonly string[],
): Promise<Map<string, string>> {
  const registry = await readRegistry();
  const result = new Map<string, string>();
  for (const rawEntryId of entryIds) {
    const entryId = rawEntryId.trim();
    const agentKey = registry?.entryAgentKeys[entryId];
    if (entryId && agentKey?.trim()) {
      result.set(entryId, canonicalSupervisorGrantAgentKey(agentKey));
    }
  }
  return result;
}

/** Owner-authenticated, per-entry purge fence. Local recovery data is removed only after DELETE is acknowledged. */
export async function revokeDesktopSupervisorGrantForEntry(entryId: string, options: GrantStorageOptions = {}): Promise<void> {
  const normalizedEntryId = entryId.trim();
  if (!normalizedEntryId) throw new Error("A durable supervised entry identity is required for grant revocation.");
  const request = options.apiFetch ?? apiFetch;
  await withRegistryMutation(async () => {
    const registry = await readRegistry();
    if (!registry) {
      throw new Error(`Cannot attest credential revocation for ${normalizedEntryId}: the local supervisor-grant registry is missing. Restore its recovery data before retrying purge; local agent state was preserved.`);
    }
    if (registry.purgeRevocationReceipts[normalizedEntryId]) return;
    const agentKey = registry.entryAgentKeys[normalizedEntryId];
    if (!agentKey) {
      throw new Error(`Cannot attest credential revocation for ${normalizedEntryId}: its local entry-to-agent mapping is missing. Restore that recovery mapping before retrying purge; local agent state was preserved.`);
    }
    const stored = registry.grants[agentKey];
    if (!stored?.grantId?.trim() || (stored.entryId?.trim() && stored.entryId.trim() !== normalizedEntryId)) {
      throw new Error(`Cannot attest credential revocation for ${normalizedEntryId}: its exact local grant mapping is missing or inconsistent. Restore that recovery mapping before retrying purge; local agent state was preserved.`);
    }
    try {
      await request(`/supervisor-host-grants/${encodeURIComponent(stored.grantId)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof DesktopApiError && error.status === 404)) {
        const detail = error instanceof Error && error.message.trim() ? ` ${error.message}` : "";
        throw new Error(`Credential revocation for ${normalizedEntryId} was not acknowledged; local recovery state was preserved.${detail}`, { cause: error });
      }
    }
    const current = await readRegistry();
    if (!current) {
      throw new Error(`Credential revocation for ${normalizedEntryId} was acknowledged, but its local recovery registry disappeared before the durable receipt could be recorded. Restore the registry and retry purge.`);
    }
    if (current.purgeRevocationReceipts[normalizedEntryId]) return;
    const currentKey = current.entryAgentKeys[normalizedEntryId];
    if (currentKey !== agentKey || current.grants[agentKey]?.grantId !== stored.grantId) {
      throw new Error(`Credential revocation for ${normalizedEntryId} was acknowledged, but its local grant identity changed before the durable receipt could be recorded. Retry purge after reconciling the saved grant.`);
    }
    delete current.grants[agentKey];
    delete current.entryAgentKeys[normalizedEntryId];
    current.purgeRevocationReceipts[normalizedEntryId] = {
      agentKey,
      grantId: stored.grantId,
      acknowledgedAt: new Date().toISOString(),
    };
    // Never remove the last file here: this receipt is what makes a restart
    // retry safe without pretending that arbitrary missing local state proves
    // a remote DELETE.
    await writeRegistry(current);
  });
}

/**
 * Resolve (or create once) the server-owned identity used by a daemon-inbox
 * Codex entry.  The stable name is derived from the immutable entry id, while
 * the returned canonical key remains the server's authority.  This must run
 * before grant provisioning because the API correctly rejects unknown agents.
 */
export async function getOrCreateDesktopCodexAgentIdentity(input: {
  entryId: string;
  displayName?: string | null;
}, options: { apiFetch?: typeof apiFetch } = {}): Promise<string> {
  const entryId = input.entryId.trim();
  if (!entryId) throw new Error("A durable supervised entry identity is required.");
  const name = `desktop-codex-${createHash("sha256").update(entryId).digest("hex").slice(0, 32)}`;
  const request = options.apiFetch ?? apiFetch;
  // Re-registering the deterministic name is intentionally idempotent. It
  // also repairs registries written by builds that lowercased the canonical
  // owner-login prefix and therefore cannot recover its original casing from
  // local data alone.
  const created = await request<{ canonical_key?: unknown }>("/agents", {
    method: "POST",
    body: JSON.stringify({ name, display_name: input.displayName?.trim() || "Codex agent" }),
  });
  if (typeof created.canonical_key !== "string" || !created.canonical_key.trim()) {
    throw new Error("LetAgents did not return a canonical Codex agent identity.");
  }
  const agentKey = canonicalSupervisorGrantAgentKey(created.canonical_key);
  await withRegistryMutation(async () => {
    const registry = (await readRegistry()) ?? { version: 4, grants: {}, entryAgentKeys: {}, purgeRevocationReceipts: {} };
    // The server response is the authority for canonical casing. Parallel
    // calls converge on the same deterministic identity.
    registry.entryAgentKeys[entryId] = agentKey;
    await writeRegistry(registry);
  });
  return await readDesktopSupervisorGrantAgentKeyForEntry(entryId) ?? agentKey;
}

export async function clearDesktopSupervisorGrant(): Promise<void> {
  await rm(storePath(), { force: true });
}

export async function revokeDesktopSupervisorGrant(options: GrantStorageOptions = {}): Promise<void> {
  const request = options.apiFetch ?? apiFetch;
  await withRegistryMutation(async () => {
    const snapshot = await readRegistry();
    if (!snapshot) return;
    const ids = [...new Set(Object.values(snapshot.grants).map((stored) => stored.grantId))];
    await Promise.all(ids.map(async (grantId) => {
      try {
        await request(`/supervisor-host-grants/${encodeURIComponent(grantId)}`, { method: "DELETE" });
      } catch (error) {
        if (!(error instanceof DesktopApiError && error.status === 404)) throw error;
      }
    }));
    const current = await readRegistry();
    if (!current) return;
    const acknowledgedAt = new Date().toISOString();
    for (const [agentKey, stored] of Object.entries(snapshot.grants)) {
      if (current.grants[agentKey]?.grantId !== stored.grantId) continue;
      delete current.grants[agentKey];
      for (const [entryId, mappedAgentKey] of Object.entries(current.entryAgentKeys)) {
        if (mappedAgentKey !== agentKey) continue;
        delete current.entryAgentKeys[entryId];
        current.purgeRevocationReceipts[entryId] = { agentKey, grantId: stored.grantId, acknowledgedAt };
      }
    }
    if (Object.keys(current.grants).length === 0
      && Object.keys(current.entryAgentKeys).length === 0
      && Object.keys(current.purgeRevocationReceipts).length === 0) await rm(storePath(), { force: true });
    else await writeRegistry(current);
  });
}
