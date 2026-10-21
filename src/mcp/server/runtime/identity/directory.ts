import { userInfo } from "os";

import type { StoredAccount } from "../../../local-state.js";
import { normalizeSlugSegment } from "../../../../shared/codenames.js";
import {
  apiCall,
  hasLetagentsCredential,
} from "../api.js";
import { requireValidWorkerBearerRuntime } from "../worker-bearer.js";
import { currentSessionScope } from "../session-scope.js";
import {
  getAuthenticatedAccountCache,
  setAuthenticatedAccountCache,
} from "../auth-cache.js";
import {
  AGENT_OWNER_LABEL,
  readCommandOutput,
} from "./config.js";

export interface ResolvedOwnerContext {
  slug: string;
  label: string;
  login: string | null;
}

export interface AuthenticatedAccountLookup {
  id?: string;
  login: string;
  display_name?: string | null;
}

export interface AuthenticatedAgentLookup {
  name?: string;
}

export async function getAuthenticatedAgentDirectory(): Promise<{
  account: AuthenticatedAccountLookup;
  agents: AuthenticatedAgentLookup[];
} | null> {
  if (requireValidWorkerBearerRuntime().mode !== "owner") {
    return null;
  }
  try {
    const result = await apiCall<{
      account?: AuthenticatedAccountLookup;
      agents?: AuthenticatedAgentLookup[];
    }>("/agents/me");
    const account = result?.account;
    if (!account?.login?.trim()) {
      return null;
    }

    const envToken = currentSessionScope() ? "" : process.env.LETAGENTS_TOKEN?.trim() ?? "";
    setAuthenticatedAccountCache(account, envToken ? "env" : "stored", envToken || null);

    return {
      account,
      agents: Array.isArray(result?.agents) ? result.agents : [],
    };
  } catch {
    return null;
  }
}

async function getAuthenticatedAccountProfile(): Promise<StoredAccount | null> {
  if (requireValidWorkerBearerRuntime().mode !== "owner") {
    return null;
  }
  const envToken = currentSessionScope() ? "" : (process.env.LETAGENTS_TOKEN || "").trim();
  const cache = getAuthenticatedAccountCache();
  if (envToken) {
    if (
      cache.source === "env" &&
      cache.envToken === envToken &&
      cache.account?.login?.trim()
    ) {
      return cache.account;
    }

    const directory = await getAuthenticatedAgentDirectory();
    return directory?.account?.login?.trim() ? directory.account : null;
  }

  const { getStoredAuth } = await import("../../../local-state.js");
  const storedAccount = getStoredAuth()?.account;
  if (storedAccount?.login?.trim()) {
    setAuthenticatedAccountCache(storedAccount, "stored", null);
    return storedAccount;
  }

  if (!await hasLetagentsCredential()) {
    setAuthenticatedAccountCache(undefined, null, null);
    return null;
  }

  if (cache.source === "stored" && cache.account?.login?.trim()) {
    return cache.account;
  }

  const directory = await getAuthenticatedAgentDirectory();
  return directory?.account?.login?.trim() ? directory.account : null;
}

export async function resolveOwnerContext(): Promise<ResolvedOwnerContext> {
  const account = await getAuthenticatedAccountProfile();
  const authLogin = account?.login?.trim() || null;
  const authLabel = account?.display_name?.trim() || authLogin;

  if (currentSessionScope() && !authLogin) {
    // Never fall back to the API server's git or OS user for a remote session.
    throw new Error("Could not load this session's LetAgents account. Retry the call.");
  }
  // The API process's env never labels a remote session's owner.
  const ownerLabel = currentSessionScope() ? "" : AGENT_OWNER_LABEL;
  if (authLogin || authLabel || ownerLabel) {
    const label = ownerLabel || authLabel || authLogin || "Owner";
    const slug = normalizeSlugSegment(authLogin || label, "owner");
    return { slug, label, login: authLogin };
  }

  const gitUserName = readCommandOutput("git config --get user.name");
  const gitUserEmail = readCommandOutput("git config --get user.email");
  const gitIdentity = gitUserName || gitUserEmail?.split("@")[0] || null;
  if (gitIdentity) {
    return {
      slug: normalizeSlugSegment(gitIdentity, "owner"),
      label: gitIdentity,
      login: null,
    };
  }

  const osIdentity =
    process.env.USER ||
    process.env.LOGNAME ||
    process.env.USERNAME ||
    (() => {
      try {
        return userInfo().username;
      } catch {
        return null;
      }
    })() ||
    "owner";

  return {
    slug: normalizeSlugSegment(osIdentity, "owner"),
    label: osIdentity,
    login: null,
  };
}
