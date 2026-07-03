import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopAuthAccount,
  DesktopAuthPollResult,
  DesktopAuthStartResult,
  DesktopAuthStatus,
  DesktopPendingDeviceAuth,
} from "../ipc-types.js";
import { apiUrl } from "./paths.js";
import { desktopSmokeAuthStatus, isDesktopSmokeCheck } from "./smoke.js";

const require = createRequire(import.meta.url);
let warnedAboutUserDataFallback = false;

interface DesktopSecretStorage {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}

function getElectronMain(): {
  app?: { getPath: (name: "userData") => string };
  safeStorage?: DesktopSecretStorage;
} {
  try {
    const electron = require("electron") as unknown;
    return typeof electron === "object" && electron !== null
      ? electron as {
          app?: { getPath: (name: "userData") => string };
          safeStorage?: DesktopSecretStorage;
        }
      : {};
  } catch {
    return {};
  }
}

function desktopUserDataPath(): string {
  const userDataPath = getElectronMain().app?.getPath("userData");
  if (userDataPath) {
    return userDataPath;
  }

  const fallbackPath = join(homedir(), ".letagents", "desktop");
  if (!warnedAboutUserDataFallback) {
    console.warn(
      "[desktop-auth] Electron userData path unavailable; storing auth state in ~/.letagents/desktop."
    );
    warnedAboutUserDataFallback = true;
  }
  return fallbackPath;
}

function desktopSecretStorage(): DesktopSecretStorage {
  return getElectronMain().safeStorage || {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8"),
  };
}

type ApiErrorPayload = {
  error?: string;
  code?: string;
  message?: string;
  room_id?: string;
  device_flow_url?: string;
  interval?: number;
  expires_in?: number;
  status?: string;
};

type StoredDesktopAuth = {
  token: string | null;
  ownerTokenId: string | null;
  oauthTokenExpiresAt: string | null;
  account: DesktopAuthAccount | null;
  pendingDeviceAuth: DesktopPendingDeviceAuth | null;
  savedAt: string;
};

type PersistedDesktopAuth = Omit<StoredDesktopAuth, "token"> & {
  encryptedToken?: string | null;
  token?: string | null;
};

type DeviceAuthStartResponse = {
  request_id: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type DeviceAuthPollResponse = {
  status: "pending" | "slow_down" | "authorized" | "denied" | "expired";
  interval?: number;
  expires_in?: number;
  letagents_token?: string;
  owner_token_id?: string;
  oauth_token_expires_at?: string | null;
  account?: {
    id: string;
    provider: string;
    provider_user_id: string;
    login: string;
    display_name?: string | null;
    avatar_url?: string | null;
  };
};

let authAuthorizedHandler: (() => void) | null = null;
let authInvalidatedHandler: (() => void) | null = null;

export function setAuthAuthorizedHandler(handler: () => void): void {
  authAuthorizedHandler = handler;
}

export function setAuthInvalidatedHandler(handler: () => void): void {
  authInvalidatedHandler = handler;
}

export class DesktopApiError extends Error {
  readonly status: number;
  readonly payload: ApiErrorPayload | null;

  constructor(status: number, payload: ApiErrorPayload | null) {
    super(
      payload?.message || payload?.error || `API request failed: ${status}`,
    );
    this.name = "DesktopApiError";
    this.status = status;
    this.payload = payload;
  }
}

function getAuthStorePath(): string {
  return join(desktopUserDataPath(), "letagents-desktop-auth.json");
}

function normalizeAuthAccount(
  account: DeviceAuthPollResponse["account"] | null | undefined,
): DesktopAuthAccount | null {
  if (!account) return null;

  return {
    id: String(account.id),
    provider: account.provider,
    providerUserId: account.provider_user_id,
    login: account.login,
    displayName: account.display_name || null,
    avatarUrl: account.avatar_url || null,
  };
}

function encryptTokenForStorage(token: string | null): string | null {
  if (!token) return null;
  const safeStorage = desktopSecretStorage();
  if (!safeStorage.isEncryptionAvailable()) {
    return `plain:${token}`;
  }
  return `safe:${safeStorage.encryptString(token).toString("base64")}`;
}

function decryptTokenFromStorage(
  parsed: Partial<PersistedDesktopAuth>,
): string | null {
  const encryptedToken = parsed.encryptedToken || null;
  if (!encryptedToken) return parsed.token || null;

  if (encryptedToken.startsWith("plain:")) {
    return encryptedToken.slice("plain:".length) || null;
  }

  if (
    !encryptedToken.startsWith("safe:") ||
    !desktopSecretStorage().isEncryptionAvailable()
  ) {
    return null;
  }

  try {
    return desktopSecretStorage().decryptString(
      Buffer.from(encryptedToken.slice("safe:".length), "base64"),
    );
  } catch {
    return null;
  }
}

export async function readStoredAuth(): Promise<StoredDesktopAuth> {
  try {
    const raw = await readFile(getAuthStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedDesktopAuth>;
    return {
      token: decryptTokenFromStorage(parsed),
      ownerTokenId: parsed.ownerTokenId || null,
      oauthTokenExpiresAt: parsed.oauthTokenExpiresAt || null,
      account: parsed.account || null,
      pendingDeviceAuth: parsed.pendingDeviceAuth || null,
      savedAt: parsed.savedAt || new Date(0).toISOString(),
    };
  } catch {
    return {
      token: null,
      ownerTokenId: null,
      oauthTokenExpiresAt: null,
      account: null,
      pendingDeviceAuth: null,
      savedAt: new Date(0).toISOString(),
    };
  }
}

async function writeStoredAuth(nextAuth: StoredDesktopAuth): Promise<void> {
  const persistedAuth: PersistedDesktopAuth = {
    ownerTokenId: nextAuth.ownerTokenId,
    oauthTokenExpiresAt: nextAuth.oauthTokenExpiresAt,
    account: nextAuth.account,
    pendingDeviceAuth: nextAuth.pendingDeviceAuth,
    savedAt: nextAuth.savedAt,
    encryptedToken: encryptTokenForStorage(nextAuth.token),
  };
  await mkdir(dirname(getAuthStorePath()), { recursive: true });
  await writeFile(
    getAuthStorePath(),
    `${JSON.stringify(persistedAuth, null, 2)}\n`,
    "utf8",
  );
}

async function updateStoredAuth(
  update: Partial<StoredDesktopAuth>,
): Promise<StoredDesktopAuth> {
  const current = await readStoredAuth();
  const nextAuth: StoredDesktopAuth = {
    ...current,
    ...update,
    savedAt: new Date().toISOString(),
  };
  await writeStoredAuth(nextAuth);
  return nextAuth;
}

export async function clearStoredAuth(): Promise<void> {
  await rm(getAuthStorePath(), { force: true });
}

function buildAuthStatus(input: {
  storedAuth: StoredDesktopAuth;
  account?: DesktopAuthAccount | null;
  error?: string | null;
}): DesktopAuthStatus {
  const account = input.account ?? input.storedAuth.account;
  return {
    authenticated: Boolean(input.storedAuth.token && account),
    account: account || null,
    pendingDeviceAuth: input.storedAuth.pendingDeviceAuth || null,
    apiUrl,
    tokenStored: Boolean(input.storedAuth.token),
    error: input.error || null,
  };
}

export async function getDesktopAuthStatus(): Promise<DesktopAuthStatus> {
  const storedAuth = await readStoredAuth();
  if (isDesktopSmokeCheck()) {
    return desktopSmokeAuthStatus();
  }
  if (!storedAuth.token) {
    return buildAuthStatus({ storedAuth });
  }

  try {
    const session = await apiFetch<{
      authenticated: boolean;
      account?: {
        id: string;
        provider: string;
        provider_user_id: string;
        login: string;
        display_name?: string | null;
        avatar_url?: string | null;
      };
    }>("/auth/session");
    const account = normalizeAuthAccount(session.account);
    if (session.authenticated && account) {
      const nextAuth = await updateStoredAuth({ account });
      return buildAuthStatus({ storedAuth: nextAuth, account });
    }

    const nextAuth = await updateStoredAuth({
      token: null,
      ownerTokenId: null,
      oauthTokenExpiresAt: null,
      account: null,
    });
    authInvalidatedHandler?.();
    return buildAuthStatus({
      storedAuth: nextAuth,
      error: "Your saved sign-in expired. Connect again to open private rooms.",
    });
  } catch (error) {
    return buildAuthStatus({
      storedAuth,
      error:
        error instanceof Error
          ? error.message
          : "Could not check sign-in right now.",
    });
  }
}

async function parseApiErrorPayload(
  response: Response,
): Promise<ApiErrorPayload | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as ApiErrorPayload;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const storedAuth = await readStoredAuth();
  const requestHeaders = new Headers(init?.headers);
  requestHeaders.set("Accept", "application/json");
  if (storedAuth.token && !requestHeaders.has("Authorization")) {
    requestHeaders.set("Authorization", `Bearer ${storedAuth.token}`);
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: requestHeaders,
  });

  if (!response.ok) {
    throw new DesktopApiError(
      response.status,
      await parseApiErrorPayload(response),
    );
  }

  return (await response.json()) as T;
}

export async function startDeviceAuthFlow(
  roomIdentifier?: string | null,
): Promise<DesktopAuthStartResult> {
  const trimmedRoomIdentifier = roomIdentifier?.trim() || null;
  const path = trimmedRoomIdentifier
    ? `/auth/device/start?room_id=${encodeURIComponent(trimmedRoomIdentifier)}`
    : "/auth/device/start";
  const response = await apiFetch<DeviceAuthStartResponse>(path, {
    method: "POST",
  });
  const now = Date.now();
  const pendingDeviceAuth: DesktopPendingDeviceAuth = {
    requestId: response.request_id,
    userCode: response.user_code,
    verificationUri: response.verification_uri,
    expiresAt: new Date(now + response.expires_in * 1000).toISOString(),
    intervalSeconds: response.interval,
    roomIdentifier: trimmedRoomIdentifier || null,
    startedAt: new Date(now).toISOString(),
  };
  const storedAuth = await updateStoredAuth({ pendingDeviceAuth });
  return {
    pendingDeviceAuth,
    authStatus: buildAuthStatus({ storedAuth }),
  };
}

export async function pollDeviceAuthFlow(
  requestId?: string | null,
): Promise<DesktopAuthPollResult> {
  const storedAuth = await readStoredAuth();
  const pending = requestId
    ? {
        ...(storedAuth.pendingDeviceAuth || {
          userCode: "",
          verificationUri: "",
          expiresAt: "",
          intervalSeconds: 5,
          roomIdentifier: null,
          startedAt: new Date().toISOString(),
        }),
        requestId,
      }
    : storedAuth.pendingDeviceAuth;

  if (!pending?.requestId) {
    return {
      status: "unknown",
      intervalSeconds: null,
      expiresInSeconds: null,
      authStatus: buildAuthStatus({ storedAuth }),
      error: "Start GitHub approval first.",
    };
  }

  try {
    const response = await apiFetch<DeviceAuthPollResponse>(
      `/auth/device/poll/${encodeURIComponent(pending.requestId)}`,
    );

    if (response.status === "authorized") {
      const account = normalizeAuthAccount(response.account);
      if (!response.letagents_token || !account) {
        return {
          status: "unknown",
          intervalSeconds: null,
          expiresInSeconds: null,
          authStatus: buildAuthStatus({ storedAuth }),
          error:
            "GitHub approved the request, but LetAgents did not return a usable session.",
        };
      }

      const nextAuth = await updateStoredAuth({
        token: response.letagents_token,
        ownerTokenId: response.owner_token_id || null,
        oauthTokenExpiresAt: response.oauth_token_expires_at || null,
        account,
        pendingDeviceAuth: null,
      });
      authAuthorizedHandler?.();
      return {
        status: "authorized",
        intervalSeconds: null,
        expiresInSeconds: null,
        authStatus: buildAuthStatus({ storedAuth: nextAuth, account }),
        error: null,
      };
    }

    const nextPending: DesktopPendingDeviceAuth = {
      ...pending,
      intervalSeconds: response.interval || pending.intervalSeconds,
    };
    const nextAuth = await updateStoredAuth({ pendingDeviceAuth: nextPending });
    return {
      status: response.status,
      intervalSeconds: nextPending.intervalSeconds,
      expiresInSeconds: response.expires_in ?? null,
      authStatus: buildAuthStatus({ storedAuth: nextAuth }),
      error: null,
    };
  } catch (error) {
    if (error instanceof DesktopApiError) {
      const status =
        error.payload?.status === "denied" || error.status === 403
          ? "denied"
          : error.payload?.status === "expired" ||
              error.status === 410 ||
              error.status === 404
            ? "expired"
            : error.status === 429
              ? "slow_down"
              : "unknown";
      const pendingDeviceAuth =
        status === "denied" || status === "expired"
          ? null
          : {
              ...pending,
              intervalSeconds:
                error.payload?.interval || pending.intervalSeconds,
            };
      const nextAuth = await updateStoredAuth({ pendingDeviceAuth });
      return {
        status,
        intervalSeconds:
          pendingDeviceAuth?.intervalSeconds || error.payload?.interval || null,
        expiresInSeconds: error.payload?.expires_in ?? null,
        authStatus: buildAuthStatus({ storedAuth: nextAuth }),
        error: error.message,
      };
    }

    return {
      status: "unknown",
      intervalSeconds: pending.intervalSeconds,
      expiresInSeconds: null,
      authStatus: buildAuthStatus({ storedAuth }),
      error:
        error instanceof Error
          ? error.message
          : "Could not check GitHub approval.",
    };
  }
}
