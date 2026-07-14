import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

type StoredGrant = DesktopSupervisorGrantMetadata & { encryptedToken: string };

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
  const stored: StoredGrant = { ...metadata, encryptedToken: encryptSupervisorGrantForStorage(response.supervisor_grant) };
  await mkdir(dirname(storePath()), { recursive: true });
  await writeFile(storePath(), `${JSON.stringify(stored)}\n`, "utf8");
  return metadata;
}

export async function getDesktopSupervisorGrantMetadata(): Promise<DesktopSupervisorGrantMetadata | null> {
  try {
    const { encryptedToken: _secret, ...metadata } = JSON.parse(await readFile(storePath(), "utf8")) as StoredGrant;
    return metadata.grantId ? metadata : null;
  } catch { return null; }
}

/** Main-process only: daemon launchers may read this; renderer IPC must not. */
export async function readDesktopSupervisorGrantToken(): Promise<string | null> {
  try {
    const stored = JSON.parse(await readFile(storePath(), "utf8")) as StoredGrant;
    return decryptSupervisorGrantFromStorage(stored.encryptedToken);
  } catch { return null; }
}

export async function clearDesktopSupervisorGrant(): Promise<void> {
  await rm(storePath(), { force: true });
}
