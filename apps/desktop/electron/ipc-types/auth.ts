export interface DesktopAuthAccount {
  id: string;
  provider: string;
  providerUserId: string;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface DesktopPendingDeviceAuth {
  requestId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
  roomIdentifier: string | null;
  startedAt: string;
}

export interface DesktopAuthStatus {
  authenticated: boolean;
  account: DesktopAuthAccount | null;
  pendingDeviceAuth: DesktopPendingDeviceAuth | null;
  apiUrl: string | null;
  tokenStored: boolean;
  error: string | null;
}

export interface DesktopAuthStartResult {
  pendingDeviceAuth: DesktopPendingDeviceAuth;
  authStatus: DesktopAuthStatus;
}

export interface DesktopAuthPollResult {
  status: "pending" | "slow_down" | "authorized" | "denied" | "expired" | "unknown";
  intervalSeconds: number | null;
  expiresInSeconds: number | null;
  authStatus: DesktopAuthStatus;
  error: string | null;
}
