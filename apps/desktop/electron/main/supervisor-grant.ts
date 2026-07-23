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
  version: 5;
  grants: Record<string, StoredGrant>;
  entryAgentKeys: Record<string, string>;
  /**
   * Exact two-step remote revocation journal. Session termination is recorded
   * before host-grant DELETE, so a crash after either acknowledgement can
   * resume without inferring success from missing process memory or a 404.
   */
  credentialRevocations: Record<string, {
    agentKey: string;
    grantId: string;
    agentSessionId: string;
    sessionEndedAt: string | null;
    grantRevokedAt: string | null;
  }>;
  /**
   * A DELETE acknowledgement must survive an Electron restart until the
   * daemon consumes it. Without this receipt, a missing registry or mapping
   * is an ambiguity, not proof that the remote grant was revoked.
   */
  purgeRevocationReceipts: Record<string, {
    agentKey: string;
    grantId: string;
    agentSessionId: string;
    sessionEndedAt: string;
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
  return Boolean(value && typeof value === "object" && ([2, 3, 4, 5].includes(Number((value as { version?: unknown }).version)))
    && typeof (value as { grants?: unknown }).grants === "object");
}

function registryFrom(value: unknown): StoredGrantRegistry | null {
  if (isRegistry(value)) {
    const legacy = value as {
      grants: Record<string, StoredGrant>;
      entryAgentKeys?: Record<string, unknown>;
      credentialRevocations?: Record<string, unknown>;
      purgeRevocationReceipts?: Record<string, unknown>;
    };
    const entryAgentKeys: Record<string, string> = {};
    const credentialRevocations: StoredGrantRegistry["credentialRevocations"] = {};
    const purgeRevocationReceipts: StoredGrantRegistry["purgeRevocationReceipts"] = {};
    for (const [entryId, agentKey] of Object.entries(legacy.entryAgentKeys ?? {})) {
      if (typeof agentKey === "string" && entryId.trim() && agentKey.trim()) entryAgentKeys[entryId] = canonicalSupervisorGrantAgentKey(agentKey);
    }
    for (const [entryId, receipt] of Object.entries(legacy.purgeRevocationReceipts ?? {})) {
      if (!entryId.trim() || !receipt || typeof receipt !== "object") continue;
      const candidate = receipt as { agentKey?: unknown; grantId?: unknown; agentSessionId?: unknown; sessionEndedAt?: unknown; acknowledgedAt?: unknown };
      if (typeof candidate.agentKey !== "string" || !candidate.agentKey.trim()
        || typeof candidate.grantId !== "string" || !candidate.grantId.trim()
        || typeof candidate.agentSessionId !== "string" || !candidate.agentSessionId.trim()
        || typeof candidate.sessionEndedAt !== "string" || !candidate.sessionEndedAt.trim()
        || typeof candidate.acknowledgedAt !== "string" || !candidate.acknowledgedAt.trim()) continue;
      purgeRevocationReceipts[entryId] = {
        agentKey: canonicalSupervisorGrantAgentKey(candidate.agentKey),
        grantId: candidate.grantId.trim(),
        agentSessionId: candidate.agentSessionId.trim(),
        sessionEndedAt: candidate.sessionEndedAt,
        acknowledgedAt: candidate.acknowledgedAt,
      };
    }
    for (const [entryId, progress] of Object.entries(legacy.credentialRevocations ?? {})) {
      if (!entryId.trim() || !progress || typeof progress !== "object") continue;
      const candidate = progress as {
        agentKey?: unknown; grantId?: unknown; agentSessionId?: unknown;
        sessionEndedAt?: unknown; grantRevokedAt?: unknown;
      };
      if (typeof candidate.agentKey !== "string" || !candidate.agentKey.trim()
        || typeof candidate.grantId !== "string" || !candidate.grantId.trim()
        || typeof candidate.agentSessionId !== "string" || !candidate.agentSessionId.trim()
        || !(candidate.sessionEndedAt === null || typeof candidate.sessionEndedAt === "string")
        || !(candidate.grantRevokedAt === null || typeof candidate.grantRevokedAt === "string")) continue;
      credentialRevocations[entryId] = {
        agentKey: canonicalSupervisorGrantAgentKey(candidate.agentKey),
        grantId: candidate.grantId.trim(),
        agentSessionId: candidate.agentSessionId.trim(),
        sessionEndedAt: candidate.sessionEndedAt,
        grantRevokedAt: candidate.grantRevokedAt,
      };
    }
    // v3 recorded the durable entry beside each grant.  Preserve that mapping
    // when upgrading, rather than guessing from a display name.
    for (const grant of Object.values(legacy.grants)) {
      if (grant.entryId?.trim() && grant.agentKey?.trim()) entryAgentKeys[grant.entryId] = canonicalSupervisorGrantAgentKey(grant.agentKey);
    }
    return { version: 5, grants: legacy.grants, entryAgentKeys, credentialRevocations, purgeRevocationReceipts };
  }
  if (!value || typeof value !== "object" || !("encryptedToken" in value)) return null;
  // Version 1 had one desktop-wide grant. Treat it as manual unless it was
  // already narrowed to a single exact agent identity.
  const legacy = value as LegacyStoredGrant;
  if (!legacy.grantId || !legacy.encryptedToken) return null;
  const candidate = legacy.allowedAgentKeys.length === 1 ? legacy.allowedAgentKeys[0] : MANUAL_GRANT_KEY;
  const agentKey = candidate === MANUAL_GRANT_KEY ? candidate : canonicalSupervisorGrantAgentKey(candidate);
  return { version: 5, grants: { [agentKey]: { ...legacy, agentKey } }, entryAgentKeys: {}, credentialRevocations: {}, purgeRevocationReceipts: {} };
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
        version: 5,
        grants: { [agentKey]: { ...metadata, agentKey, encryptedToken } },
        entryAgentKeys: registry?.entryAgentKeys ?? {},
        credentialRevocations: registry?.credentialRevocations ?? {},
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
    const registry = (await readRegistry()) ?? { version: 5, grants: {}, entryAgentKeys: {}, credentialRevocations: {}, purgeRevocationReceipts: {} };
    if (input.entryId?.trim()) {
      registry.entryAgentKeys[input.entryId.trim()] = agentKey;
      // A newly provisioned exact grant supersedes any receipt belonging to a
      // previous lifecycle that happened to use the same durable entry id.
      delete registry.credentialRevocations[input.entryId.trim()];
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

async function ensureExactWorkerSessionAndGrantRevoked(input: {
  entryId: string;
  agentKey: string;
  grant: NonNullable<Awaited<ReturnType<typeof readDesktopSupervisorGrantForAgent>>>;
  agentSessionId: string;
}, options: GrantStorageOptions): Promise<{
  agentKey: string;
  grantId: string;
  agentSessionId: string;
  sessionEndedAt: string;
  grantRevokedAt: string;
}> {
  const entryId = input.entryId.trim();
  const agentSessionId = input.agentSessionId.trim();
  if (!entryId || !agentSessionId || input.grant.entryId !== entryId) {
    throw new Error("Exact worker-session revocation requires one durable entry, grant, and agent session.");
  }
  const request = options.apiFetch ?? apiFetch;
  await withRegistryMutation(async () => {
    const registry = await readRegistry();
    const stored = registry?.grants[input.agentKey];
    if (!registry || registry.entryAgentKeys[entryId] !== input.agentKey
      || !stored || stored.grantId !== input.grant.metadata.grantId
      || (stored.entryId?.trim() && stored.entryId.trim() !== entryId)) {
      throw new Error(`Cannot revoke ${entryId}: its exact local grant recovery mapping is missing or inconsistent.`);
    }
    const progress = registry.credentialRevocations[entryId];
    if (progress && (progress.agentKey !== input.agentKey
      || progress.grantId !== stored.grantId
      || progress.agentSessionId !== agentSessionId)) {
      throw new Error(`Cannot revoke ${entryId}: another exact credential revocation is already journalled.`);
    }
    if (!progress) {
      registry.credentialRevocations[entryId] = {
        agentKey: input.agentKey,
        grantId: stored.grantId,
        agentSessionId,
        sessionEndedAt: null,
        grantRevokedAt: null,
      };
      await writeRegistry(registry);
    }
  });

  let progress = (await readRegistry())?.credentialRevocations[entryId];
  if (!progress) throw new Error(`Cannot revoke ${entryId}: its durable credential-revocation journal disappeared.`);
  if (!progress.sessionEndedAt) {
    const ended = await request<Record<string, unknown>>(
      `/supervisor-host-grants/${encodeURIComponent(progress.grantId)}/worker-sessions/${encodeURIComponent(agentSessionId)}/end`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${input.grant.token}` },
        body: JSON.stringify({ generation: input.grant.metadata.generation }),
      },
    );
    if (ended.session_id !== agentSessionId || typeof ended.ended_at !== "string" || !ended.ended_at.trim()) {
      throw new Error(`Worker-session termination for ${entryId} returned an invalid exact-session acknowledgement.`);
    }
    await withRegistryMutation(async () => {
      const registry = await readRegistry();
      const current = registry?.credentialRevocations[entryId];
      if (!registry || !current || current.agentKey !== progress!.agentKey
        || current.grantId !== progress!.grantId || current.agentSessionId !== agentSessionId) {
        throw new Error(`Worker-session termination for ${entryId} succeeded, but its durable acknowledgement journal changed.`);
      }
      current.sessionEndedAt = ended.ended_at as string;
      await writeRegistry(registry);
    });
    progress = (await readRegistry())?.credentialRevocations[entryId];
  }
  if (!progress?.sessionEndedAt) {
    throw new Error(`Worker-session termination for ${entryId} was not durably acknowledged.`);
  }
  if (!progress.grantRevokedAt) {
    try {
      await request(`/supervisor-host-grants/${encodeURIComponent(progress.grantId)}`, { method: "DELETE" });
    } catch (error) {
      // 404 is authoritative only after the exact session-end acknowledgement
      // is durable. It then proves the host credential cannot mint a successor.
      if (!(error instanceof DesktopApiError && error.status === 404)) throw error;
    }
    const acknowledgedAt = new Date().toISOString();
    await withRegistryMutation(async () => {
      const registry = await readRegistry();
      const current = registry?.credentialRevocations[entryId];
      if (!registry || !current || current.agentKey !== progress!.agentKey
        || current.grantId !== progress!.grantId || current.agentSessionId !== agentSessionId
        || !current.sessionEndedAt) {
        throw new Error(`Host-grant revocation for ${entryId} succeeded, but its exact session acknowledgement journal changed.`);
      }
      current.grantRevokedAt = acknowledgedAt;
      await writeRegistry(registry);
    });
    progress = (await readRegistry())?.credentialRevocations[entryId];
  }
  if (!progress?.sessionEndedAt || !progress.grantRevokedAt) {
    throw new Error(`Credential revocation for ${entryId} was not durably acknowledged.`);
  }
  return {
    agentKey: progress.agentKey,
    grantId: progress.grantId,
    agentSessionId: progress.agentSessionId,
    sessionEndedAt: progress.sessionEndedAt,
    grantRevokedAt: progress.grantRevokedAt,
  };
}

function authoritativeProvisionFailure(error: unknown): boolean {
  return error instanceof DesktopApiError && [400, 401, 403, 404, 409, 422].includes(error.status);
}

async function provisionWithLostResponseRecovery(
  request: typeof apiFetch,
  body: Record<string, unknown>,
): Promise<SupervisorGrantApiResponse> {
  try {
    return await request<SupervisorGrantApiResponse>("/supervisor-host-grants", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (authoritativeProvisionFailure(error)) throw error;
    // A matching-scope retry recovers the exact active grant id and rotates
    // away any bearer returned by the lost response.
    return request<SupervisorGrantApiResponse>("/supervisor-host-grants", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

/**
 * Main-process-only lifecycle helper for desktop-managed agents.  It performs
 * the Keychain availability check before any API call, scopes every grant to
 * exactly one canonical agent key, and retains plaintext only for the caller
 * to install directly into that agent's daemon process.
 */
export async function getOrProvisionDesktopSupervisorGrantForAgent(
  input: DesktopSupervisorGrantLifecycleInput & {
    forceReprovision?: boolean;
    /** Exact live worker session that must end before replacing its host grant. */
    sourceAgentSessionId?: string;
  },
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
  // Serialize by the immutable manifest entry, because purge uses the same
  // durable identity and may race a replacement whose canonical agent key is
  // being repaired.
  return withAgentGrantLifecycle(entryId, async () => {
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
      if (input.sourceAgentSessionId?.trim()) {
        await ensureExactWorkerSessionAndGrantRevoked({
          entryId, agentKey, grant: existing, agentSessionId: input.sourceAgentSessionId,
        }, { ...options, storage, apiFetch: request });
      } else {
        // Preserve the old encrypted mapping until a validated replacement is
        // durably written. A crash after DELETE therefore retries the exact
        // scope and recovers an upserted grant instead of wedging on 409.
        try {
          await request(`/supervisor-host-grants/${encodeURIComponent(existing.metadata.grantId)}`, { method: "DELETE" });
        } catch (error) {
          if (!(error instanceof DesktopApiError && error.status === 404)) throw error;
        }
      }
    }

    const response = await provisionWithLostResponseRecovery(request, {
      host_id: hostId,
      installation_id: installationId,
      allowed_room_ids: allowedRoomIds,
      allowed_agent_keys: [agentKey],
      ttl_ms: input.ttlMs,
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

/** Owner-authenticated purge fence: exact worker end, then grant revoke, then one durable receipt. */
export async function revokeDesktopSupervisorGrantForEntry(
  entryId: string,
  agentSessionId: string,
  options: GrantStorageOptions = {},
): Promise<void> {
  const normalizedEntryId = entryId.trim();
  const normalizedSessionId = agentSessionId.trim();
  if (!normalizedEntryId || !normalizedSessionId) {
    throw new Error("A durable supervised entry and exact worker session are required for grant revocation.");
  }
  await withAgentGrantLifecycle(normalizedEntryId, async () => {
    const registry = await readRegistry();
    if (!registry) {
      throw new Error(`Cannot attest credential revocation for ${normalizedEntryId}: the local supervisor-grant registry is missing. Restore its recovery data before retrying purge; local agent state was preserved.`);
    }
    const receipt = registry.purgeRevocationReceipts[normalizedEntryId];
    if (receipt) {
      if (receipt.agentSessionId !== normalizedSessionId) {
        throw new Error(`Cannot attest credential revocation for ${normalizedEntryId}: its durable receipt belongs to another worker session.`);
      }
      return;
    }
    const agentKey = registry.entryAgentKeys[normalizedEntryId];
    if (!agentKey) {
      throw new Error(`Cannot attest credential revocation for ${normalizedEntryId}: its local entry-to-agent mapping is missing. Restore that recovery mapping before retrying purge; local agent state was preserved.`);
    }
    const stored = registry.grants[agentKey];
    if (!stored?.grantId?.trim() || (stored.entryId?.trim() && stored.entryId.trim() !== normalizedEntryId)) {
      throw new Error(`Cannot attest credential revocation for ${normalizedEntryId}: its exact local grant mapping is missing or inconsistent. Restore that recovery mapping before retrying purge; local agent state was preserved.`);
    }
    const token = decryptSupervisorGrantFromStorage(stored.encryptedToken, options.storage);
    if (!token) throw new Error(`Cannot attest credential revocation for ${normalizedEntryId}: its encrypted host credential is unavailable.`);
    const revoked = await ensureExactWorkerSessionAndGrantRevoked({
      entryId: normalizedEntryId,
      agentKey,
      grant: {
        metadata: metadataOf(stored),
        token,
        entryId: normalizedEntryId,
        lastInstalledDaemonGeneration: stored.lastInstalledDaemonGeneration ?? null,
      },
      agentSessionId: normalizedSessionId,
    }, options);
    await withRegistryMutation(async () => {
      const current = await readRegistry();
      const progress = current?.credentialRevocations[normalizedEntryId];
      if (!current || current.entryAgentKeys[normalizedEntryId] !== agentKey
        || current.grants[agentKey]?.grantId !== stored.grantId
        || !progress?.sessionEndedAt || !progress.grantRevokedAt
        || progress.agentSessionId !== normalizedSessionId) {
        throw new Error(`Credential revocation for ${normalizedEntryId} was acknowledged, but its exact durable recovery state changed before purge receipt commit.`);
      }
      delete current.grants[agentKey];
      delete current.entryAgentKeys[normalizedEntryId];
      delete current.credentialRevocations[normalizedEntryId];
      current.purgeRevocationReceipts[normalizedEntryId] = {
        agentKey: revoked.agentKey,
        grantId: revoked.grantId,
        agentSessionId: revoked.agentSessionId,
        sessionEndedAt: revoked.sessionEndedAt,
        acknowledgedAt: revoked.grantRevokedAt,
      };
      // Never remove the last file here: this exact two-ack receipt is what
      // makes a restart retry safe without treating missing state as proof.
      await writeRegistry(current);
    });
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
    const registry = (await readRegistry()) ?? { version: 5, grants: {}, entryAgentKeys: {}, credentialRevocations: {}, purgeRevocationReceipts: {} };
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
        const revocation = current.credentialRevocations[entryId];
        if (!revocation?.sessionEndedAt || !revocation.grantRevokedAt
          || revocation.agentKey !== agentKey || revocation.grantId !== stored.grantId) continue;
        current.purgeRevocationReceipts[entryId] = {
          agentKey, grantId: stored.grantId, agentSessionId: revocation.agentSessionId,
          sessionEndedAt: revocation.sessionEndedAt, acknowledgedAt,
        };
        delete current.credentialRevocations[entryId];
      }
    }
    if (Object.keys(current.grants).length === 0
      && Object.keys(current.entryAgentKeys).length === 0
      && Object.keys(current.credentialRevocations).length === 0
      && Object.keys(current.purgeRevocationReceipts).length === 0) await rm(storePath(), { force: true });
    else await writeRegistry(current);
  });
}
