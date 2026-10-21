import type { StoredAccount } from "../../local-state.js";
import { scopedValue } from "./session-scope.js";

type AuthenticatedAccountCache = {
  account: StoredAccount | null | undefined;
  source: "env" | "stored" | null;
  envToken: string | null;
};

const cache = scopedValue<AuthenticatedAccountCache>("auth-cache",
  () => ({ account: undefined, source: null, envToken: null }));

export function clearAuthenticatedAccountCache(): void {
  cache.set({ account: undefined, source: null, envToken: null });
}

export function setAuthenticatedAccountCache(
  account: StoredAccount | null | undefined,
  source: "env" | "stored" | null,
  envToken: string | null
): void {
  cache.set({ account, source, envToken });
}

export function getAuthenticatedAccountCache(): AuthenticatedAccountCache {
  return { ...cache.get() };
}
