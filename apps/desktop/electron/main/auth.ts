import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Agent } from "undici";

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

/**
 * Shared keep-alive dispatcher for all {@link apiFetch} traffic.
 *
 * The electron main process makes ~10+ HTTPS requests/second to the LetAgents
 * API at peak. With the default undici dispatcher (keepAliveTimeout ~4s, no
 * per-origin connection cap) bursts open ~10 sockets that idle-reap into
 * TIME_WAIT (measured: 54 ESTABLISHED + 246 TIME_WAIT). A longer keep-alive
 * window plus a per-origin connection cap lets the burst reuse a bounded pool
 * of warm sockets instead of churning fresh connections.
 *
 * This is passed per-request via `RequestInit.dispatcher` rather than through
 * `setGlobalDispatcher` on purpose: room-stream.ts drives its own long-lived
 * SSE/long-poll fetches on the default global dispatcher, and we must not
 * retune those from under it.
 *
 * Compatibility note: passing an external undici `Agent` into Electron's
 * internal-undici global `fetch` was runtime-verified on Electron 42.4.0
 * (Node 22.20); re-verify socket reuse when upgrading Electron.
 */
const API_KEEP_ALIVE_DISPATCHER = new Agent({
  keepAliveTimeout: 45_000,
  keepAliveMaxTimeout: 60_000,
  connections: 16,
});

/** Default per-request timeout for {@link apiFetch} when the caller passes no signal. */
const DEFAULT_API_TIMEOUT_MS = 30_000;

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
  // Test/CI override so suites can point the auth store at a temp dir instead
  // of the real per-user location (mirrors LETAGENTS_STATE_PATH in paths.ts).
  const overridePath = process.env.LETAGENTS_DESKTOP_USER_DATA_DIR?.trim();
  if (overridePath) {
    return overridePath;
  }

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
  current_delivery_signal_sequence?: number;
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

function emptyStoredAuth(): StoredDesktopAuth {
  return {
    token: null,
    ownerTokenId: null,
    oauthTokenExpiresAt: null,
    account: null,
    pendingDeviceAuth: null,
    savedAt: new Date(0).toISOString(),
  };
}

/**
 * In-memory cache of the parsed auth store.
 *
 * `apiFetch` calls `readStoredAuth` on EVERY request; at the measured request
 * rate (~10/s) an uncached read is ~10 disk reads + OS-keychain decrypts per
 * second for a token that changes ~never, which pinned the main process near
 * 90% CPU. This module is the ONLY writer of the auth store file (see
 * `writeStoredAuth` / `clearStoredAuth`), so no external process can mutate it
 * behind our back — the cache can therefore be treated as authoritative and is
 * only ever invalidated from our own mutation paths. Every mutation
 * (`writeStoredAuth`, `updateStoredAuth`, device-auth completion, the
 * auth-status token refresh, sign-out via `clearStoredAuth`) funnels through
 * those two functions, so refreshing the cache there keeps it correct.
 *
 * Security note: the cache holds exactly what each request already held
 * transiently (a decrypted bearer token in main-process memory); it does not
 * widen exposure or persist the token anywhere new.
 */
let cachedAuth: StoredDesktopAuth | null = null;

export async function readStoredAuth(): Promise<StoredDesktopAuth> {
  if (cachedAuth) {
    return cachedAuth;
  }
  try {
    const raw = await readFile(getAuthStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedDesktopAuth>;
    cachedAuth = {
      token: decryptTokenFromStorage(parsed),
      ownerTokenId: parsed.ownerTokenId || null,
      oauthTokenExpiresAt: parsed.oauthTokenExpiresAt || null,
      account: parsed.account || null,
      pendingDeviceAuth: parsed.pendingDeviceAuth || null,
      savedAt: parsed.savedAt || new Date(0).toISOString(),
    };
    return cachedAuth;
  } catch (error) {
    // Only a missing file (= signed out) is a cacheable outcome. A transient
    // read failure (EPERM/EIO disk hiccup at startup, etc.) must NOT latch the
    // app signed-out until restart — leave the cache cold so the next call
    // retries the disk read and self-heals, like the old uncached code did.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      cachedAuth = emptyStoredAuth();
      return cachedAuth;
    }
    return emptyStoredAuth();
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
  // Refresh the cache from the value we just persisted so the next
  // readStoredAuth (e.g. the Authorization header on the next apiFetch) reflects
  // this mutation without another disk read + keychain decrypt.
  cachedAuth = { ...nextAuth };
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
  // Sign-out path: drop the token from the cache too, otherwise the next
  // apiFetch would keep sending the just-cleared bearer token.
  cachedAuth = emptyStoredAuth();
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

/**
 * Options controlling {@link apiFetch}'s default per-request timeout.
 *
 * `apiFetch` attaches `AbortSignal.timeout(DEFAULT_API_TIMEOUT_MS)` when the
 * caller passes no `signal`, so a stuck request can't hang the main process
 * forever. Callers with a legitimately-slow operation (or that manage their own
 * cancellation) opt out or extend:
 *   - passing an explicit `init.signal` disables the default timeout entirely
 *     (the caller owns cancellation);
 *   - `{ timeoutMs: N }` overrides the default with N ms;
 *   - `{ timeoutMs: null }` disables the default timeout with no replacement.
 */
export type ApiFetchOptions = {
  timeoutMs?: number | null;
};

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  options?: ApiFetchOptions,
): Promise<T> {
  const storedAuth = await readStoredAuth();
  const requestHeaders = new Headers(init?.headers);
  requestHeaders.set("Accept", "application/json");
  if (
    typeof init?.body === "string"
    && init.body.length > 0
    && !requestHeaders.has("Content-Type")
  ) {
    requestHeaders.set("Content-Type", "application/json");
  }
  if (storedAuth.token && !requestHeaders.has("Authorization")) {
    requestHeaders.set("Authorization", `Bearer ${storedAuth.token}`);
  }

  // A caller-provided signal always wins: we never override it with a default
  // timeout, since the caller owns that request's cancellation policy.
  const callerSignal = init?.signal ?? null;
  const timeoutMs =
    options?.timeoutMs === null
      ? null
      : options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const timeoutSignal =
    callerSignal || timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);

  // `dispatcher` is an undici extension to RequestInit that Node/Electron's
  // global fetch honors at runtime; it is absent from the DOM RequestInit type,
  // hence the cast.
  const fetchInit = {
    ...init,
    headers: requestHeaders,
    signal: callerSignal ?? timeoutSignal ?? undefined,
    dispatcher: API_KEEP_ALIVE_DISPATCHER,
  } as RequestInit;

  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, fetchInit);
  } catch (error) {
    // Surface our own timeout as a clear Error (not an opaque AbortError) so
    // callers like snapshot loadSource degrade gracefully on `error.message`.
    if (timeoutSignal?.aborted && !callerSignal) {
      throw new Error(
        `LetAgents API request to ${path} timed out after ${timeoutMs} ms.`,
      );
    }
    throw error;
  }

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
