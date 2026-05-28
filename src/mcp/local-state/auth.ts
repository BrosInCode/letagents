import { readLocalState, updateLocalState } from "./storage.js";
import type { PendingDeviceAuthState, StoredAuthState } from "./types.js";

function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

export function getStoredAuth(): StoredAuthState | null {
  const state = readLocalState();
  if (!state.auth) {
    return null;
  }

  if (isExpired(state.auth.expires_at)) {
    clearStoredAuth();
    return null;
  }

  return state.auth;
}

export function setStoredAuth(auth: StoredAuthState): StoredAuthState {
  updateLocalState((state) => {
    state.auth = auth;
    delete state.pending_device_auth;
    return state;
  });
  return auth;
}

export function clearStoredAuth(): void {
  updateLocalState((state) => {
    delete state.auth;
    return state;
  });
}

export function getPendingDeviceAuth(): PendingDeviceAuthState | null {
  const state = readLocalState();
  if (!state.pending_device_auth) {
    return null;
  }

  if (isExpired(state.pending_device_auth.expires_at)) {
    clearPendingDeviceAuth();
    return null;
  }

  return state.pending_device_auth;
}

export function setPendingDeviceAuth(
  pendingDeviceAuth: PendingDeviceAuthState
): PendingDeviceAuthState {
  updateLocalState((state) => {
    state.pending_device_auth = pendingDeviceAuth;
    return state;
  });
  return pendingDeviceAuth;
}

export function clearPendingDeviceAuth(): void {
  updateLocalState((state) => {
    delete state.pending_device_auth;
    return state;
  });
}
