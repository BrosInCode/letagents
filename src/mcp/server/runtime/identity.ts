import { createHash, randomUUID } from "crypto";
import { execSync } from "child_process";
import { userInfo } from "os";
import {
  getStoredAgentIdentity,
  getStoredAuth,
  readLocalState,
  setStoredAgentIdentity,
  updateLocalState,
  type StoredAgentIdentityState,
  type StoredAccount,
} from "../../local-state.js";
import {
  buildAgentActorLabel,
  formatOwnerAttribution,
  inferAgentIdeLabel,
  toTitleCaseCodename,
} from "../../../shared/agent-identity.js";
import {
  AGENT_CODENAME_SPACE,
  normalizeAgentBaseName,
  normalizeSlugSegment,
  pickLocalCodename,
} from "../../../shared/codenames.js";
import { type AgentPresenceStatus } from "../../../shared/agent-presence.js";
import {
  apiCall,
  getLetagentsToken,
} from "./api.js";
import {
  getAuthenticatedAccountCache,
  setAuthenticatedAccountCache,
} from "./auth-cache.js";

const AGENT_NAME = (process.env.LETAGENTS_AGENT_NAME || process.env.AGENT_NAME || "").trim();
const AGENT_DISPLAY_NAME = (process.env.LETAGENTS_AGENT_DISPLAY_NAME || "").trim();
const AGENT_IDE_LABEL = (process.env.LETAGENTS_AGENT_IDE || process.env.AGENT_IDE || "").trim();
const AGENT_OWNER_LABEL = (process.env.LETAGENTS_AGENT_OWNER_LABEL || "").trim();
const EXPLICIT_AGENT_IDENTITY_KEY = getExplicitAgentIdentityStorageKey();

export const AGENT_INSTANCE_UUID = randomUUID();
export let currentAgentIdentityKey =
  EXPLICIT_AGENT_IDENTITY_KEY ?? `instance:${AGENT_INSTANCE_UUID}`;
export let currentAgentIdentity: StoredAgentIdentityState | null =
  getStoredAgentIdentity(currentAgentIdentityKey);

interface ResolvedOwnerContext {
  slug: string;
  label: string;
  login: string | null;
}

interface AuthenticatedAccountLookup {
  id?: string;
  login: string;
  display_name?: string | null;
}

interface AuthenticatedAgentLookup {
  name?: string;
}

const MAX_CONVERSATION_IDENTITIES = 20;
const conversationIdentities = new Map<string, StoredAgentIdentityState>();

export function storeCurrentAgentIdentity(
  identity: StoredAgentIdentityState,
  identityKey = currentAgentIdentityKey
): StoredAgentIdentityState {
  currentAgentIdentity = setStoredAgentIdentity(identity, identityKey);
  return currentAgentIdentity;
}

export function getConversationIdentity(
  conversationId?: string | null
): StoredAgentIdentityState | null {
  if (!conversationId) return currentAgentIdentity;
  return conversationIdentities.get(conversationId) ?? currentAgentIdentity;
}

export function setConversationIdentity(
  conversationId: string,
  identity: StoredAgentIdentityState
): void {
  if (
    !conversationIdentities.has(conversationId) &&
    conversationIdentities.size >= MAX_CONVERSATION_IDENTITIES
  ) {
    const oldestKey = conversationIdentities.keys().next().value;
    if (oldestKey !== undefined) conversationIdentities.delete(oldestKey);
  }
  conversationIdentities.set(conversationId, identity);
}

function readCommandOutput(command: string, cwd = process.cwd()): string | null {
  try {
    const output = execSync(command, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function isCodexRuntime(): boolean {
  return Boolean(
    process.env.CODEX_THREAD_ID ||
      process.env.CODEX_SHELL ||
      process.env.CODEX_CI ||
      process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  );
}

function getExplicitAgentIdentityStorageKey(): string | null {
  const runtimeSignals = [
    process.env.LETAGENTS_AGENT_INSTANCE_ID,
    process.env.CODEX_THREAD_ID && `codex:${process.env.CODEX_THREAD_ID}`,
    process.env.ANTIGRAVITY_THREAD_ID && `antigravity:${process.env.ANTIGRAVITY_THREAD_ID}`,
    process.env.CLAUDECODE_SESSION_ID && `claude:${process.env.CLAUDECODE_SESSION_ID}`,
    process.env.MCP_SESSION_ID && `mcp:${process.env.MCP_SESSION_ID}`,
  ].filter((value): value is string => Boolean(value?.trim()));

  return runtimeSignals[0] ?? null;
}

export function detectAgentIdeLabel(): string {
  if (AGENT_IDE_LABEL) {
    return toTitleCaseCodename(AGENT_IDE_LABEL);
  }

  if (isCodexRuntime()) {
    return "Codex";
  }

  const explicitName = normalizeAgentBaseName(AGENT_NAME || AGENT_DISPLAY_NAME);
  const inferred = inferAgentIdeLabel(explicitName);
  return inferred || "Agent";
}

export function detectAgentRuntimeLabel(): string {
  if (isCodexRuntime()) {
    return "codex";
  }

  return detectAgentIdeLabel().trim().toLowerCase() || "unknown";
}

function ensureAgentIdentityKey(_ideLabel: string): string {
  if (EXPLICIT_AGENT_IDENTITY_KEY) {
    currentAgentIdentityKey = EXPLICIT_AGENT_IDENTITY_KEY;
    currentAgentIdentity = getStoredAgentIdentity(currentAgentIdentityKey);
    return currentAgentIdentityKey;
  }

  currentAgentIdentityKey = `instance:${AGENT_INSTANCE_UUID}`;
  currentAgentIdentity = getStoredAgentIdentity(currentAgentIdentityKey);
  return currentAgentIdentityKey;
}

function getOrCreateLocalHostId(): string {
  const state = readLocalState();
  if (typeof state.local_host_id === "string" && state.local_host_id.trim()) {
    return state.local_host_id;
  }

  const hostId = `host_${randomUUID().replace(/-/g, "")}`;
  updateLocalState((nextState) => {
    nextState.local_host_id = typeof nextState.local_host_id === "string" && nextState.local_host_id.trim()
      ? nextState.local_host_id
      : hostId;
    return nextState;
  });
  return readLocalState().local_host_id || hostId;
}

export function getSessionLivenessRegistration(runtime = detectAgentRuntimeLabel()) {
  const hostId = getOrCreateLocalHostId();
  const ideLabel = detectAgentIdeLabel();
  const normalizedRuntime = runtime.trim().toLowerCase() || ideLabel.toLowerCase();
  return {
    host_id: hostId,
    host_kind: process.platform === "darwin" ? "macos" : process.platform,
    host_label: null,
    liveness_capability: normalizedRuntime === "codex"
      ? "codex_app_server_runtime_stream"
      : "session_activity",
    tool_bridge_id: `${hostId}:${normalizedRuntime}:${AGENT_INSTANCE_UUID}`,
  };
}

async function getAuthenticatedAgentDirectory(): Promise<{
  account: AuthenticatedAccountLookup;
  agents: AuthenticatedAgentLookup[];
} | null> {
  try {
    const result = await apiCall<{
      account?: AuthenticatedAccountLookup;
      agents?: AuthenticatedAgentLookup[];
    }>("/agents/me");
    const account = result?.account;
    if (!account?.login?.trim()) {
      return null;
    }

    setAuthenticatedAccountCache(
      account,
      process.env.LETAGENTS_TOKEN?.trim() ? "env" : "stored",
      process.env.LETAGENTS_TOKEN?.trim() || null
    );

    return {
      account,
      agents: Array.isArray(result?.agents) ? result.agents : [],
    };
  } catch {
    return null;
  }
}

function shouldReuseStoredIdentity(
  identity: StoredAgentIdentityState | null,
  identityKey: string
): boolean {
  return Boolean(
    identity &&
      identity.runtime_key === identityKey &&
      identity.display_name?.trim() &&
      identity.ide_label?.trim() &&
      identity.owner_attribution?.trim()
  );
}

function resolveExplicitAgentIdentity(): { name: string; display_name: string } | null {
  if (AGENT_NAME) {
    const name = normalizeAgentBaseName(AGENT_NAME);
    return {
      name,
      display_name: AGENT_DISPLAY_NAME || toTitleCaseCodename(AGENT_NAME),
    };
  }

  if (AGENT_DISPLAY_NAME) {
    return {
      name: normalizeAgentBaseName(AGENT_DISPLAY_NAME),
      display_name: AGENT_DISPLAY_NAME.trim(),
    };
  }

  return null;
}

async function resolveAgentName(
  authAvailable: boolean,
  identityKey: string
): Promise<{ name: string; display_name: string }> {
  const explicit = resolveExplicitAgentIdentity();
  if (explicit) {
    return explicit;
  }

  if (shouldReuseStoredIdentity(currentAgentIdentity, identityKey)) {
    return {
      name: currentAgentIdentity!.name,
      display_name: currentAgentIdentity!.display_name,
    };
  }

  if (!authAvailable) {
    return pickLocalCodename(identityKey);
  }

  const directory = await getAuthenticatedAgentDirectory();
  const existingNames = new Set(
    (directory?.agents ?? [])
      .map((agent) => normalizeAgentBaseName(agent.name || ""))
      .filter(Boolean)
  );

  for (let offset = 0; offset < AGENT_CODENAME_SPACE; offset += 1) {
    const candidate = pickLocalCodename(identityKey, offset);
    if (!existingNames.has(candidate.name)) {
      return candidate;
    }
  }

  const fallbackHash = createHash("sha256")
    .update(identityKey)
    .digest("hex")
    .slice(0, 4);
  const fallback = pickLocalCodename(identityKey);
  return {
    name: `${fallback.name}-${fallbackHash}`,
    display_name: `${fallback.display_name} ${fallbackHash.toUpperCase()}`,
  };
}

async function getAuthenticatedAccountProfile(): Promise<AuthenticatedAccountLookup | null> {
  const envToken = (process.env.LETAGENTS_TOKEN || "").trim();
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

  const storedAccount = getStoredAuth()?.account;
  if (storedAccount?.login?.trim()) {
    setAuthenticatedAccountCache(storedAccount, "stored", null);
    return storedAccount;
  }

  if (!getLetagentsToken()) {
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

  if (authLogin || authLabel || AGENT_OWNER_LABEL) {
    const label = AGENT_OWNER_LABEL || authLabel || authLogin || "Owner";
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

function sameAgentIdentity(
  left: StoredAgentIdentityState | null,
  right: StoredAgentIdentityState
): boolean {
  return Boolean(
    left &&
      left.name === right.name &&
      left.display_name === right.display_name &&
      left.owner_label === right.owner_label &&
      left.owner_attribution === right.owner_attribution &&
      left.ide_label === right.ide_label &&
      left.actor_label === right.actor_label &&
      left.canonical_key === right.canonical_key &&
      left.runtime_key === right.runtime_key &&
      left.source === right.source
  );
}

export function toPublicAgentIdentity(
  identity: StoredAgentIdentityState | null
): Record<string, unknown> | null {
  if (!identity) {
    return null;
  }

  return {
    name: identity.name,
    display_name: identity.display_name,
    owner_label: identity.owner_label,
    owner_attribution: identity.owner_attribution ?? formatOwnerAttribution(identity.owner_label),
    ide_label: identity.ide_label ?? inferAgentIdeLabel(identity.display_name) ?? "Agent",
    actor_label: identity.actor_label,
    canonical_key: identity.canonical_key ?? null,
    runtime_key: identity.runtime_key ?? null,
    agent_instance_id: AGENT_INSTANCE_UUID,
    source: identity.source,
  };
}

export async function ensureAgentIdentity(): Promise<StoredAgentIdentityState> {
  const owner = await resolveOwnerContext();
  const authAvailable = Boolean(getLetagentsToken());
  const ideLabel = detectAgentIdeLabel();
  const identityKey = ensureAgentIdentityKey(ideLabel);
  const ownerAttribution = formatOwnerAttribution(owner.label);
  const { name, display_name: displayName } = await resolveAgentName(authAvailable, identityKey);
  const actorLabel = buildAgentActorLabel({
    display_name: displayName,
    owner_label: owner.label,
    ide_label: ideLabel,
  });

  let resolved: StoredAgentIdentityState = {
    name,
    display_name: displayName,
    owner_label: owner.label,
    owner_attribution: ownerAttribution,
    ide_label: ideLabel,
    actor_label: actorLabel,
    canonical_key: owner.login ? `${owner.login}/${name}` : null,
    runtime_key: identityKey,
    source: "local",
    resolved_at: new Date().toISOString(),
  };

  if (
    currentAgentIdentity &&
    currentAgentIdentity.name === resolved.name &&
    currentAgentIdentity.display_name === resolved.display_name &&
    currentAgentIdentity.owner_label === resolved.owner_label &&
    currentAgentIdentity.owner_attribution === resolved.owner_attribution &&
    currentAgentIdentity.ide_label === resolved.ide_label &&
    currentAgentIdentity.actor_label === resolved.actor_label &&
    currentAgentIdentity.runtime_key === resolved.runtime_key &&
    (!authAvailable || currentAgentIdentity.source === "api")
  ) {
    return currentAgentIdentity;
  }

  if (authAvailable) {
    try {
      const registered = await apiCall<Record<string, unknown>>("/agents", {
        method: "POST",
        body: JSON.stringify({
          name: resolved.name,
          display_name: resolved.display_name,
          owner_label: resolved.owner_label,
        }),
      });

      resolved = {
        ...resolved,
        canonical_key:
          typeof registered.canonical_key === "string"
            ? registered.canonical_key
            : resolved.canonical_key,
        display_name:
          typeof registered.display_name === "string"
            ? registered.display_name
            : resolved.display_name,
        owner_label:
          typeof registered.owner_label === "string"
            ? registered.owner_label
            : resolved.owner_label,
        source: "api",
      };
      resolved.owner_attribution = formatOwnerAttribution(resolved.owner_label);
      resolved.actor_label = buildAgentActorLabel({
        display_name: resolved.display_name,
        owner_label: resolved.owner_label,
        ide_label: resolved.ide_label,
      });
    } catch (error) {
      console.error(
        "Agent identity registration failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  if (!sameAgentIdentity(currentAgentIdentity, resolved)) {
    currentAgentIdentity = setStoredAgentIdentity(
      {
        ...resolved,
        resolved_at: new Date().toISOString(),
      },
      identityKey
    );
  }

  return currentAgentIdentity ?? resolved;
}

export async function withAgentIdentity(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return {
    ...payload,
    agent_identity: toPublicAgentIdentity(await ensureAgentIdentity()),
  };
}

export type {
  AgentPresenceStatus,
  StoredAccount,
  StoredAgentIdentityState,
};
