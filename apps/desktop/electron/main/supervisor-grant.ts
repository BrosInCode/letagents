import { Buffer } from "node:buffer";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  encryptedToken: string;
};
type LegacyStoredGrant = DesktopSupervisorGrantMetadata & { encryptedToken: string };
type StoredGrantRegistry = { version: 2; grants: Record<string, StoredGrant> };
const MANUAL_GRANT_KEY = "__manual__";

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
  const { agentKey: _agentKey, encryptedToken: _secret, ...metadata } = stored;
  return metadata;
}

function isRegistry(value: unknown): value is StoredGrantRegistry {
  return Boolean(value && typeof value === "object" && (value as { version?: unknown }).version === 2
    && typeof (value as { grants?: unknown }).grants === "object");
}

function registryFrom(value: unknown): StoredGrantRegistry | null {
  if (isRegistry(value)) return value;
  if (!value || typeof value !== "object" || !("encryptedToken" in value)) return null;
  // Version 1 had one desktop-wide grant. Treat it as manual unless it was
  // already narrowed to a single exact agent identity.
  const legacy = value as LegacyStoredGrant;
  if (!legacy.grantId || !legacy.encryptedToken) return null;
  const candidate = legacy.allowedAgentKeys.length === 1 ? legacy.allowedAgentKeys[0] : MANUAL_GRANT_KEY;
  const agentKey = candidate === MANUAL_GRANT_KEY ? candidate : canonicalSupervisorGrantAgentKey(candidate);
  return { version: 2, grants: { [agentKey]: { ...legacy, agentKey } } };
}

async function readRegistry(): Promise<StoredGrantRegistry | null> {
  try { return registryFrom(JSON.parse(await readFile(storePath(), "utf8"))); } catch { return null; }
}

async function writeRegistry(registry: StoredGrantRegistry): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(registry)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
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
    const assignedAgentKeys = metadata.allowedAgentKeys.length > 0 ? metadata.allowedAgentKeys : [MANUAL_GRANT_KEY];
    const encryptedToken = encryptSupervisorGrantForStorage(response.supervisor_grant);
    const grants = Object.fromEntries(assignedAgentKeys.map((rawKey) => {
      const agentKey = rawKey === MANUAL_GRANT_KEY ? rawKey : canonicalSupervisorGrantAgentKey(rawKey);
      return [agentKey, { ...metadata, agentKey, encryptedToken }];
    }));
    await writeRegistry({ version: 2, grants });
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
  const first = registry && Object.values(registry.grants)[0];
  return first ? decryptSupervisorGrantFromStorage(first.encryptedToken) : null;
}

/** Main-process only. Renderer IPC intentionally exposes metadata, never this value. */
export async function readDesktopSupervisorGrantForAgent(agentKey: string): Promise<{
  metadata: DesktopSupervisorGrantMetadata;
  token: string;
} | null> {
  const registry = await readRegistry();
  const stored = registry?.grants[canonicalSupervisorGrantAgentKey(agentKey)];
  const token = stored && decryptSupervisorGrantFromStorage(stored.encryptedToken);
  return stored && token ? { metadata: metadataOf(stored), token } : null;
}

/**
 * Main-process handoff helper. It stores the replacement encrypted at rest;
 * callers deliver its plaintext directly to the successor daemon socket.
 */
export async function storeDesktopSupervisorGrantForAgent(input: {
  agentKey: string;
  metadata: DesktopSupervisorGrantMetadata;
  token: string;
}): Promise<void> {
  const agentKey = canonicalSupervisorGrantAgentKey(input.agentKey);
  if (!input.token.trim()) throw new Error("A supervisor grant is required.");
  const registry = (await readRegistry()) ?? { version: 2, grants: {} };
  registry.grants[agentKey] = { ...input.metadata, agentKey, encryptedToken: encryptSupervisorGrantForStorage(input.token) };
  await writeRegistry(registry);
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
