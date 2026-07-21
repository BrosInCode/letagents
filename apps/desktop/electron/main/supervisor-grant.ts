import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { apiFetch } from "./auth.js";
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
type StoredGrantRegistry = { version: 3; grants: Record<string, StoredGrant> };
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
  const normalized = agentKey.trim().toLowerCase();
  if (!normalized) throw new Error("A supervised agent identity is required.");
  return normalized;
}

function metadataOf(stored: StoredGrant): DesktopSupervisorGrantMetadata {
  const { agentKey: _agentKey, entryId: _entryId, lastInstalledDaemonGeneration: _daemonGeneration, encryptedToken: _secret, ...metadata } = stored;
  return metadata;
}

function isRegistry(value: unknown): value is StoredGrantRegistry {
  return Boolean(value && typeof value === "object" && ((value as { version?: unknown }).version === 2 || (value as { version?: unknown }).version === 3)
    && typeof (value as { grants?: unknown }).grants === "object");
}

function registryFrom(value: unknown): StoredGrantRegistry | null {
  if (isRegistry(value)) return { version: 3, grants: (value as { grants: Record<string, StoredGrant> }).grants };
  if (!value || typeof value !== "object" || !("encryptedToken" in value)) return null;
  // Version 1 had one desktop-wide grant. Treat it as manual unless it was
  // already narrowed to a single exact agent identity.
  const legacy = value as LegacyStoredGrant;
  if (!legacy.grantId || !legacy.encryptedToken) return null;
  const candidate = legacy.allowedAgentKeys.length === 1 ? legacy.allowedAgentKeys[0] : MANUAL_GRANT_KEY;
  const agentKey = candidate === MANUAL_GRANT_KEY ? candidate : canonicalSupervisorGrantAgentKey(candidate);
  return { version: 3, grants: { [agentKey]: { ...legacy, agentKey } } };
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
  allowedRoomIds: string[];
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

export async function provisionDesktopSupervisorGrant(input: DesktopProvisionSupervisorGrantInput): Promise<DesktopSupervisorGrantMetadata> {
  if (!getStorage().isEncryptionAvailable()) {
    throw new Error("macOS Keychain encryption is unavailable; host grant was not provisioned.");
  }
  // Refuse replacement while a live local grant exists. The owner must revoke
  // it explicitly instead of silently orphaning a durable host credential.
  if (await getDesktopSupervisorGrantMetadata()) {
    throw new Error("A host grant is already stored on this desktop. Revoke it before provisioning a replacement.");
  }
  const response = await apiFetch<{
    grant_id: string; host_id: string; installation_id: string; allowed_room_ids: string[];
    allowed_agent_keys: string[]; current_generation: number; expires_at: string; supervisor_grant: string;
  }>("/supervisor-host-grants", {
    method: "POST",
    body: JSON.stringify({ host_id: input.hostId, installation_id: input.installationId, allowed_room_ids: input.allowedRoomIds, allowed_agent_keys: input.allowedAgentKeys, ttl_ms: input.ttlMs }),
  });
  const metadata = toMetadata(response);
  try {
    if (metadata.allowedAgentKeys.length !== 1) {
      throw new Error("A per-agent desktop grant must be scoped to exactly one agent identity.");
    }
    const agentKey = canonicalSupervisorGrantAgentKey(metadata.allowedAgentKeys[0]!);
    const encryptedToken = encryptSupervisorGrantForStorage(response.supervisor_grant);
    await writeRegistry({ version: 3, grants: { [agentKey]: { ...metadata, agentKey, encryptedToken } } });
    return metadata;
  } catch (error) {
    // Do not leave an unusable, owner-scoped server grant behind when the
    // desktop cannot durably protect its credential.
    await apiFetch(`/supervisor-host-grants/${encodeURIComponent(response.grant_id)}`, { method: "DELETE" }).catch(() => {});
    throw error;
  }
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
    const registry = (await readRegistry()) ?? { version: 3, grants: {} };
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
  return input.allowedRoomIds.every((roomId) => coveredRooms.has(roomId));
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
  input: DesktopSupervisorGrantLifecycleInput,
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
  const allowedRoomIds = [...new Set(input.allowedRoomIds.map((roomId) => roomId.trim()).filter(Boolean))];
  const request = options.apiFetch ?? apiFetch;
  return withAgentGrantLifecycle(agentKey, async () => {
    const existing = await readDesktopSupervisorGrantForAgent(agentKey, { storage });
    if (existing && reusableDesktopSupervisorGrant({
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
      await request(`/supervisor-host-grants/${encodeURIComponent(existing.metadata.grantId)}`, { method: "DELETE" });
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

export async function clearDesktopSupervisorGrant(): Promise<void> {
  await rm(storePath(), { force: true });
}

export async function revokeDesktopSupervisorGrant(): Promise<void> {
  const registry = await readRegistry();
  if (!registry) return;
  const ids = [...new Set(Object.values(registry.grants).map((stored) => stored.grantId))];
  await Promise.all(ids.map((grantId) => apiFetch(`/supervisor-host-grants/${encodeURIComponent(grantId)}`, { method: "DELETE" })));
  await clearDesktopSupervisorGrant();
}
