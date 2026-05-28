import type { StoredAccount } from "../../local-state.js";

let currentAuthenticatedAccount: StoredAccount | null | undefined = undefined;
let currentAuthenticatedAccountSource: "env" | "stored" | null = null;
let currentAuthenticatedEnvToken: string | null = null;

export function clearAuthenticatedAccountCache(): void {
  currentAuthenticatedAccount = undefined;
  currentAuthenticatedAccountSource = null;
  currentAuthenticatedEnvToken = null;
}

export function setAuthenticatedAccountCache(
  account: StoredAccount | null | undefined,
  source: "env" | "stored" | null,
  envToken: string | null
): void {
  currentAuthenticatedAccount = account;
  currentAuthenticatedAccountSource = source;
  currentAuthenticatedEnvToken = envToken;
}

export function getAuthenticatedAccountCache(): {
  account: StoredAccount | null | undefined;
  source: "env" | "stored" | null;
  envToken: string | null;
} {
  return {
    account: currentAuthenticatedAccount,
    source: currentAuthenticatedAccountSource,
    envToken: currentAuthenticatedEnvToken,
  };
}
