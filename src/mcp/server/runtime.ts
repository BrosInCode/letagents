// Runtime state and helpers for the MCP server. Tool registration modules depend on
// this facade so src/mcp/server.ts can stay focused on process composition.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, randomUUID } from "crypto";
import { userInfo } from "os";
import { execSync } from "child_process";
import { SseClient, type Message } from "../sse-client.js";
import { getRoomFromConfig } from "../config-reader.js";
import { getGitRemoteIdentity } from "../git-remote.js";
import {
  clearPendingDeviceAuth,
  clearStoredAuth,
  endStoredAgentSession,
  getCurrentCodexLiveSession,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAgentSession,
  getStoredAgentIdentity,
  getStoredAuth,
  getStoredCurrentRoom,
  getStoredRoomSession,
  listStoredCodexLiveSessions,
  readLocalState,
  saveAgentSession,
  saveRoomSession,
  setStoredAgentIdentity,
  setPendingDeviceAuth,
  setStoredAuth,
  touchRoomSession,
  updateLocalState,
  type PendingDeviceAuthState,
  type RoomSessionState,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
  type StoredAccount,
} from "../local-state.js";
import {
  encodeRoomIdPath,
  getCanonicalRoomWebPath,
  looksLikeInviteCode,
  normalizeInviteCode,
  type JoinedVia,
} from "../room-id.js";
import {
  buildAgentActorLabel,
  formatOwnerAttribution,
  inferAgentIdeLabel,
  toTitleCaseCodename,
} from "../../shared/agent-identity.js";
import {
  buildRoomAgentPrompt,
  normalizeAgentPromptKind,
} from "../../shared/room-agent-prompts.js";
import {
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
  LETAGENTS_ORIGIN_ROOM_ID_HEADER,
} from "../../shared/request-headers.js";
import {
  startLocalCodexSession,
  toPublicCodexLiveSession,
} from "../codex-session.js";
import { getRoomIdentityPresenceCacheKey } from "../agent-presence.js";
import {
  normalizeAgentBaseName,
  normalizeSlugSegment,
  pickLocalCodename,
  AGENT_CODENAME_SPACE,
} from "../../shared/codenames.js";
import { type AgentPresenceStatus } from "../../shared/agent-presence.js";

let mcpServer: McpServer | null = null;
let sseClient: SseClient | null = null;

export function attachMcpServer(server: McpServer): void {
  mcpServer = server;
}

export function shutdownRuntime(): void {
  sseClient?.unsubscribeAll();
}

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

export function storeCurrentAgentIdentity(
  identity: StoredAgentIdentityState,
  identityKey = currentAgentIdentityKey
): StoredAgentIdentityState {
  currentAgentIdentity = setStoredAgentIdentity(identity, identityKey);
  return currentAgentIdentity;
}

// ---------------------------------------------------------------------------
// Room State
// ---------------------------------------------------------------------------

export interface RoomState {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  joined_via: JoinedVia;
}

export let currentRoom: RoomState | null = null;
export let currentAgentIdentityKey = "";
export let currentAgentIdentity: StoredAgentIdentityState | null = null;
let currentAuthenticatedAccount: StoredAccount | null | undefined = undefined;
const roomPresenceByIdentity = new Map<
  string,
  { status: AgentPresenceStatus; status_text: string | null }
>();

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

function getSessionLivenessRegistration(runtime = detectAgentRuntimeLabel()) {
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

// ---------------------------------------------------------------------------
// Conversation-scoped identity (Option C: per-conversation hints)
// ---------------------------------------------------------------------------
const MAX_CONVERSATION_IDENTITIES = 20;
const conversationIdentities = new Map<string, StoredAgentIdentityState>();

/**
 * Get or set a conversation-scoped identity override.
 * Falls back to the global `currentAgentIdentity` when conversationId is absent.
 */
function getConversationIdentity(
  conversationId?: string | null
): StoredAgentIdentityState | null {
  if (!conversationId) return currentAgentIdentity;
  return conversationIdentities.get(conversationId) ?? currentAgentIdentity;
}

function setConversationIdentity(
  conversationId: string,
  identity: StoredAgentIdentityState
): void {
  // LRU-style eviction: if at cap, remove oldest entry
  if (
    !conversationIdentities.has(conversationId) &&
    conversationIdentities.size >= MAX_CONVERSATION_IDENTITIES
  ) {
    const oldestKey = conversationIdentities.keys().next().value;
    if (oldestKey !== undefined) conversationIdentities.delete(oldestKey);
  }
  conversationIdentities.set(conversationId, identity);
}
let currentAuthenticatedAccountSource: "env" | "stored" | null = null;
let currentAuthenticatedEnvToken: string | null = null;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const API_URL = (process.env.LETAGENTS_API_URL || "http://localhost:3001").replace(/\/+$/, "");
function getSseClient(): SseClient {
  sseClient ??= new SseClient(API_URL, () => getLetagentsToken());
  return sseClient;
}

const AGENT_NAME = (process.env.LETAGENTS_AGENT_NAME || process.env.AGENT_NAME || "").trim();
const AGENT_DISPLAY_NAME = (process.env.LETAGENTS_AGENT_DISPLAY_NAME || "").trim();
const AGENT_IDE_LABEL = (process.env.LETAGENTS_AGENT_IDE || process.env.AGENT_IDE || "").trim();
const AGENT_OWNER_LABEL = (process.env.LETAGENTS_AGENT_OWNER_LABEL || "").trim();
const EXPLICIT_AGENT_IDENTITY_KEY = getExplicitAgentIdentityStorageKey();
export const AGENT_INSTANCE_UUID = randomUUID();

currentAgentIdentityKey =
  EXPLICIT_AGENT_IDENTITY_KEY ?? `instance:${AGENT_INSTANCE_UUID}`;
currentAgentIdentity = getStoredAgentIdentity(currentAgentIdentityKey);

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// normalizeSlugSegment, normalizeAgentBaseName, AGENT_CODENAMES,
// AGENT_CODENAME_SPACE, hashStringToIndex, codenameFromIndex,
// pickLocalCodename — all imported from ./codenames.js

function isCodexRuntime(): boolean {
  return Boolean(
    process.env.CODEX_THREAD_ID ||
      process.env.CODEX_SHELL ||
      process.env.CODEX_CI ||
      process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  );
}

const AGENT_IDENTITY_SLOT_SUFFIX = ":slot:";

function getExplicitAgentIdentityStorageKey(): string | null {
  const runtimeSignals = [
    process.env.LETAGENTS_AGENT_INSTANCE_ID,
    process.env.CODEX_THREAD_ID && `codex:${process.env.CODEX_THREAD_ID}`,
    process.env.ANTIGRAVITY_THREAD_ID && `antigravity:${process.env.ANTIGRAVITY_THREAD_ID}`,
    process.env.CLAUDECODE_SESSION_ID && `claude:${process.env.CLAUDECODE_SESSION_ID}`,
    process.env.MCP_SESSION_ID && `mcp:${process.env.MCP_SESSION_ID}`,
  ].filter((value): value is string => Boolean(value?.trim()));

  if (runtimeSignals.length) {
    return runtimeSignals[0];
  }

  return null;
}

function getFallbackAgentIdentityNamespaceKey(ideLabel: string): string {
  return `cwd:${process.cwd()}:ide:${normalizeAgentBaseName(ideLabel)}`;
}

function detectAgentIdeLabel(): string {
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

function detectAgentRuntimeLabel(): string {
  if (isCodexRuntime()) {
    return "codex";
  }

  return detectAgentIdeLabel().trim().toLowerCase() || "unknown";
}

function getFallbackSlotPrefix(namespaceKey: string): string {
  return `${namespaceKey}${AGENT_IDENTITY_SLOT_SUFFIX}`;
}

function getFallbackSlotKey(namespaceKey: string, slotIndex: number): string {
  return `${getFallbackSlotPrefix(namespaceKey)}${slotIndex}`;
}

function parseFallbackSlotIndex(identityKey: string, namespaceKey: string): number | null {
  const prefix = getFallbackSlotPrefix(namespaceKey);
  if (!identityKey.startsWith(prefix)) {
    return null;
  }

  const slotIndex = Number.parseInt(identityKey.slice(prefix.length), 10);
  return Number.isInteger(slotIndex) && slotIndex >= 0 ? slotIndex : null;
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

function claimFallbackIdentityKey(namespaceKey: string): {
  identityKey: string;
  identity: StoredAgentIdentityState | null;
} {
  let claimedKey = getFallbackSlotKey(namespaceKey, 0);
  let claimedIdentity: StoredAgentIdentityState | null = null;
  const now = new Date().toISOString();

  updateLocalState((state) => {
    const identities = state.agent_identities ?? {};
    const leases = state.agent_identity_leases ?? {};
    const namespacePrefix = getFallbackSlotPrefix(namespaceKey);

    for (const [identityKey, lease] of Object.entries(leases)) {
      if (!identityKey.startsWith(namespacePrefix) || lease.namespace_key !== namespaceKey) {
        continue;
      }

      if (!isProcessAlive(lease.pid)) {
        delete leases[identityKey];
      }
    }

    const activeLeaseForPid = Object.entries(leases).find(
      ([identityKey, lease]) =>
        identityKey.startsWith(namespacePrefix) &&
        lease.namespace_key === namespaceKey &&
        lease.pid === process.pid
    );

    if (activeLeaseForPid) {
      const [identityKey, lease] = activeLeaseForPid;
      lease.updated_at = now;
      claimedKey = identityKey;
      claimedIdentity = identities[identityKey] ?? null;
      state.agent_identity_leases = leases;
      return state;
    }

    const slotKeys = new Set<string>();
    for (const identityKey of Object.keys(identities)) {
      if (identityKey.startsWith(namespacePrefix)) {
        slotKeys.add(identityKey);
      }
    }
    for (const identityKey of Object.keys(leases)) {
      if (identityKey.startsWith(namespacePrefix)) {
        slotKeys.add(identityKey);
      }
    }

    const sortedSlotKeys = [...slotKeys].sort((left, right) => {
      const leftIndex = parseFallbackSlotIndex(left, namespaceKey) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = parseFallbackSlotIndex(right, namespaceKey) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });

    for (const identityKey of sortedSlotKeys) {
      if (leases[identityKey]) {
        continue;
      }

      leases[identityKey] = {
        namespace_key: namespaceKey,
        pid: process.pid,
        acquired_at: now,
        updated_at: now,
      };
      claimedKey = identityKey;
      claimedIdentity = identities[identityKey] ?? null;
      state.agent_identity_leases = leases;
      return state;
    }

    let nextSlotIndex = 0;
    while (slotKeys.has(getFallbackSlotKey(namespaceKey, nextSlotIndex))) {
      nextSlotIndex += 1;
    }

    claimedKey = getFallbackSlotKey(namespaceKey, nextSlotIndex);
    leases[claimedKey] = {
      namespace_key: namespaceKey,
      pid: process.pid,
      acquired_at: now,
      updated_at: now,
    };
    claimedIdentity = identities[claimedKey] ?? null;
    state.agent_identity_leases = leases;
    return state;
  });

  return {
    identityKey: claimedKey,
    identity: claimedIdentity,
  };
}

function ensureAgentIdentityKey(ideLabel: string): string {
  if (EXPLICIT_AGENT_IDENTITY_KEY) {
    currentAgentIdentityKey = EXPLICIT_AGENT_IDENTITY_KEY;
    currentAgentIdentity = getStoredAgentIdentity(currentAgentIdentityKey);
    return currentAgentIdentityKey;
  }

  // v1: Use per-instance UUID for guaranteed distinct identity.
  // Each MCP process gets a unique UUID — no slot/PID coordination needed.
  // Trade-off: process restart = new identity (accepted for v1).
  const uuidKey = `instance:${AGENT_INSTANCE_UUID}`;
  currentAgentIdentityKey = uuidKey;
  currentAgentIdentity = getStoredAgentIdentity(currentAgentIdentityKey);
  return currentAgentIdentityKey;
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

    currentAuthenticatedAccount = account;
    currentAuthenticatedAccountSource = process.env.LETAGENTS_TOKEN?.trim() ? "env" : "stored";
    currentAuthenticatedEnvToken = process.env.LETAGENTS_TOKEN?.trim() || null;

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

// pickLocalCodename — imported from ./codenames.js

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
  if (envToken) {
    if (
      currentAuthenticatedAccountSource === "env" &&
      currentAuthenticatedEnvToken === envToken &&
      currentAuthenticatedAccount?.login?.trim()
    ) {
      return currentAuthenticatedAccount;
    }

    const directory = await getAuthenticatedAgentDirectory();
    if (directory?.account?.login?.trim()) {
      return directory.account;
    }

    return null;
  }

  const storedAccount = getStoredAuth()?.account;
  if (storedAccount?.login?.trim()) {
    currentAuthenticatedAccount = storedAccount;
    currentAuthenticatedAccountSource = "stored";
    currentAuthenticatedEnvToken = null;
    return storedAccount;
  }

  if (!getLetagentsToken()) {
    currentAuthenticatedAccount = undefined;
    currentAuthenticatedAccountSource = null;
    currentAuthenticatedEnvToken = null;
    return null;
  }

  if (
    currentAuthenticatedAccountSource === "stored" &&
    currentAuthenticatedAccount?.login?.trim()
  ) {
    return currentAuthenticatedAccount;
  }

  const directory = await getAuthenticatedAgentDirectory();
  if (directory?.account?.login?.trim()) {
    return directory.account;
  }

  return null;
}

async function resolveOwnerContext(): Promise<ResolvedOwnerContext> {
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

function toPublicAgentIdentity(
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

async function ensureAgentIdentity(): Promise<StoredAgentIdentityState> {
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

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class RepoRoomAuthRequiredError extends Error {
  readonly roomId: string;
  readonly pendingAuth: PendingDeviceAuthState;

  constructor(roomId: string, pendingAuth: PendingDeviceAuthState) {
    super(
      `Repo room '${roomId}' requires authentication. Device flow started: open ${pendingAuth.verification_uri} and enter code ${pendingAuth.user_code}, then run poll_device_auth.`
    );
    this.name = "RepoRoomAuthRequiredError";
    this.roomId = roomId;
    this.pendingAuth = pendingAuth;
  }
}

function getLetagentsToken(): string {
  return process.env.LETAGENTS_TOKEN || getStoredAuth()?.token || "";
}

function getAuthorizationHeader(): string | null {
  const letagentsToken = getLetagentsToken();
  if (letagentsToken) {
    return `Bearer ${letagentsToken}`;
  }

  return null;
}

function isMissingRouteError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405) &&
    /Cannot (GET|POST|PATCH)|Not Found|Cannot GET \/rooms|Cannot POST \/rooms/i.test(error.body)
  );
}

function parseApiErrorPayload(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) {
    return null;
  }

  try {
    const parsed = JSON.parse(error.body) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function resolveApiPath(urlOrPath: string | undefined): string {
  if (!urlOrPath) {
    return "/auth/device/start";
  }

  try {
    const parsed = new URL(urlOrPath, `${API_URL}/`);
    const apiBase = new URL(`${API_URL}/`);
    if (parsed.origin !== apiBase.origin) {
      return "/auth/device/start";
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/auth/device/start";
  }
}

async function apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };

  const authorizationHeader = getAuthorizationHeader();
  if (authorizationHeader && !headers.Authorization) {
    headers.Authorization = authorizationHeader;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      // Only clear on 401 (invalid/expired credential), NOT on 403
      // (valid credential but insufficient permissions, e.g., private repo access)
      clearStoredAuth();
      currentAuthenticatedAccount = undefined;
      currentAuthenticatedAccountSource = null;
      currentAuthenticatedEnvToken = null;
    }
    throw new ApiError(res.status, body);
  }

  const body = await res.text();
  if (!body) {
    return null as T;
  }

  return JSON.parse(body) as T;
}

async function startPendingDeviceAuth(
  roomId: string,
  deviceFlowUrl?: string
): Promise<PendingDeviceAuthState> {
  const existing = getPendingDeviceAuth();
  if (existing?.suggested_room_id === roomId) {
    return existing;
  }

  const response = await apiCall<{
    request_id: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  }>(resolveApiPath(deviceFlowUrl), {
    method: "POST",
  });

  return setPendingDeviceAuth({
    request_id: response.request_id,
    user_code: response.user_code,
    verification_uri: response.verification_uri,
    interval_seconds: response.interval,
    expires_at: new Date(Date.now() + response.expires_in * 1000).toISOString(),
    started_at: new Date().toISOString(),
    suggested_room_id: roomId,
  });
}

async function maybeHandleRepoRoomAuthRequired(error: unknown, roomId: string): Promise<void> {
  const payload = parseApiErrorPayload(error);
  if (!(error instanceof ApiError) || error.status !== 401 || payload?.error !== "auth_required") {
    return;
  }

  const pendingAuth = await startPendingDeviceAuth(
    roomId,
    typeof payload.device_flow_url === "string" ? payload.device_flow_url : undefined
  );

  throw new RepoRoomAuthRequiredError(roomId, pendingAuth);
}

function toRepoRoomAuthRequiredResult(error: RepoRoomAuthRequiredError): Record<string, unknown> {
  return {
    success: false,
    error: "auth_required",
    room_id: error.roomId,
    next_step: "poll_device_auth",
    pending_device_auth: error.pendingAuth,
    message: error.message,
  };
}

function toRoomState(input: {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  joined_via: JoinedVia;
}): RoomState {
  return {
    room_id: input.room_id,
    project_id: input.project_id ?? null,
    code: input.code ?? null,
    display_name: input.display_name ?? null,
    joined_via: input.joined_via,
  };
}

function getCanonicalRoomWebUrl(roomId: string): string {
  return new URL(getCanonicalRoomWebPath(roomId), `${API_URL}/`).toString();
}

function withCanonicalRoomLink<T extends Record<string, unknown>>(
  roomId: string,
  payload: T
): T & { room_path: string; room_url: string } {
  return {
    ...payload,
    room_path: getCanonicalRoomWebPath(roomId),
    room_url: getCanonicalRoomWebUrl(roomId),
  };
}

function toPublicRoomState(state: RoomState | null): Record<string, unknown> | null {
  if (!state) {
    return null;
  }

  return withCanonicalRoomLink(state.room_id, {
    room_id: state.room_id,
    code: state.code ?? null,
    display_name: state.display_name ?? null,
    joined_via: state.joined_via,
  });
}

function toPublicStoredRoomSession(session: RoomSessionState | null): Record<string, unknown> | null {
  if (!session) {
    return null;
  }

  return withCanonicalRoomLink(session.room_id, {
    room_id: session.room_id,
    code: session.code ?? null,
    display_name: session.display_name ?? null,
    joined_via: session.joined_via,
    joined_at: session.joined_at,
    last_seen_at: session.last_seen_at,
    last_message_id: session.last_message_id ?? null,
  });
}

function toPublicRoomResponse(
  response: Record<string, unknown>,
  fallbackRoomId: string
): Record<string, unknown> {
  const {
    id: _legacyId,
    project_id: _legacyProjectId,
    ...rest
  } = response;

  return {
    ...withCanonicalRoomLink(
      typeof rest.room_id === "string" ? rest.room_id : fallbackRoomId,
      rest
    ),
    room_id: typeof rest.room_id === "string" ? rest.room_id : fallbackRoomId,
  };
}

async function withAgentIdentity(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return {
    ...payload,
    agent_identity: toPublicAgentIdentity(await ensureAgentIdentity()),
  };
}

function getCurrentStreamAgentIdentity():
  | {
    actorLabel: string;
    actorKey: string | null;
    actorInstanceId: string;
  }
  | null {
  const identity = currentAgentIdentity ?? getStoredAgentIdentity(currentAgentIdentityKey);
  if (!identity?.actor_label || !identity.canonical_key) {
    return null;
  }

  return {
    actorLabel: identity.actor_label,
    actorKey: identity.canonical_key,
    actorInstanceId: AGENT_INSTANCE_UUID,
  };
}

function rememberRoom(state: RoomState, lastMessageId?: string): RoomState {
  currentRoom = state;
  saveRoomSession({
    room_id: state.room_id,
    project_id: state.project_id ?? null,
    code: state.code ?? null,
    display_name: state.display_name ?? null,
    joined_via: state.joined_via,
    last_message_id: lastMessageId,
  });
  getSseClient().unsubscribeAll();
  getSseClient().subscribe(
    {
      roomId: state.room_id,
      projectId: state.project_id ?? null,
      agentIdentity: getCurrentStreamAgentIdentity(),
    },
    (_message: Message) => {
      touchRoomSession(state.room_id);
      mcpServer?.server.sendResourceListChanged();
    }
  );
  return state;
}

function touchCurrentRoom(lastMessageId?: string): void {
  if (!currentRoom) {
    return;
  }

  touchRoomSession(currentRoom.room_id, lastMessageId);
}

function getRememberedRoomPresence(
  roomId: string | null | undefined,
  identity: StoredAgentIdentityState | null | undefined
): { status: AgentPresenceStatus; status_text: string | null } {
  if (!roomId || !identity) {
    return { status: "idle", status_text: null };
  }

  return (
    roomPresenceByIdentity.get(
      getRoomIdentityPresenceCacheKey(roomId, identity.actor_label)
    ) ?? { status: "idle", status_text: null }
  );
}

async function syncRoomPresence(
  roomId: string | null | undefined,
  identity: StoredAgentIdentityState | null | undefined,
  presence: { status: AgentPresenceStatus; status_text: string | null },
  agentSession?: StoredAgentSessionState | null
): Promise<void> {
  const resolvedIdentity = agentSession ? identityFromAgentSession(agentSession) : identity;
  if (!roomId || !resolvedIdentity || !agentSession) {
    return;
  }

  roomPresenceByIdentity.set(
    getRoomIdentityPresenceCacheKey(roomId, resolvedIdentity.actor_label),
    presence
  );

  try {
    await apiCall(`/rooms/${encodeRoomIdPath(roomId)}/presence`, {
      method: "POST",
      body: JSON.stringify({
        actor_label: resolvedIdentity.actor_label,
        agent_key: resolvedIdentity.canonical_key,
        display_name: resolvedIdentity.display_name,
        owner_label: resolvedIdentity.owner_label,
        ide_label: resolvedIdentity.ide_label,
        status: presence.status,
        status_text: presence.status_text,
        liveness_observation: getSessionLivenessRegistration(),
        ...agentSessionCredentials(agentSession),
      }),
    });
    touchRoomSession(roomId);
  } catch (error) {
    if (isMissingRouteError(error)) {
      return;
    }
    throw error;
  }
}

async function heartbeatRoomPresence(
  roomId: string | null | undefined,
  identity: StoredAgentIdentityState | null | undefined
): Promise<void> {
  await syncRoomPresence(roomId, identity, getRememberedRoomPresence(roomId, identity));
}

function buildAgentDeliveryHeaders(
  agentSession?: StoredAgentSessionState | null
): Record<string, string> {
  if (!agentSession) {
    return {};
  }

  return {
    [LETAGENTS_AGENT_SESSION_ID_HEADER]: agentSession.session_id,
    [LETAGENTS_AGENT_SESSION_TOKEN_HEADER]: agentSession.session_token,
  };
}

function getTargetRoomId(roomId?: string): string | null {
  return roomId || currentRoom?.room_id || null;
}

function getFallbackProjectId(): string | null {
  return currentRoom?.project_id ?? null;
}

function getLastMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const messages = (payload as { messages?: Array<{ id?: string }> }).messages;
  const lastMessage = messages?.at(-1);
  return typeof lastMessage?.id === "string" ? lastMessage.id : undefined;
}

function withJoinRoomAgentPrompt(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    agent_prompt_kind: "join",
    agent_prompt: buildRoomAgentPrompt("join"),
  };
}

type JoinSessionMode = "live" | "current";

function normalizeJoinSessionMode(value: unknown): JoinSessionMode {
  return String(value || "").trim().toLowerCase() === "live" ? "live" : "current";
}

function getCurrentLiveSessionPayload(roomId?: string): Record<string, unknown> | null {
  const session = getCurrentCodexLiveSession(roomId);
  return session ? toPublicCodexLiveSession(session) : null;
}

function toPublicAgentSession(session: StoredAgentSessionState | null): Record<string, unknown> | null {
  if (!session) {
    return null;
  }

  return {
    session_id: session.session_id,
    room_id: session.room_id,
    session_kind: session.session_kind,
    runtime: session.runtime,
    host_id: session.host_id ?? null,
    host_kind: session.host_kind ?? null,
    host_label: session.host_label ?? null,
    liveness_capability: session.liveness_capability ?? null,
    tool_bridge_id: session.tool_bridge_id ?? null,
    actor_label: session.actor_label,
    agent_key: session.agent_key,
    agent_instance_id: session.agent_instance_id ?? null,
    display_name: session.display_name,
    owner_label: session.owner_label,
    ide_label: session.ide_label,
    created_at: session.created_at,
    updated_at: session.updated_at,
    last_seen_at: session.last_seen_at,
    ended_at: session.ended_at ?? null,
  };
}

function resolveAgentSession(
  roomId: string | null | undefined,
  sessionId?: string | null
): StoredAgentSessionState | null {
  if (!sessionId) {
    return null;
  }
  const session = getStoredAgentSession(sessionId);
  if (!session) {
    throw new Error(`Unknown agent_session_id: ${sessionId}`);
  }
  if (session.ended_at) {
    throw new Error(`agent_session_id ${sessionId} ended at ${session.ended_at}`);
  }
  if (roomId && session.room_id !== roomId) {
    throw new Error(`agent_session_id ${sessionId} is registered for ${session.room_id}, not ${roomId}`);
  }
  return session;
}

function identityFromAgentSession(session: StoredAgentSessionState): StoredAgentIdentityState {
  return {
    name: normalizeAgentBaseName(session.display_name),
    display_name: session.display_name,
    owner_label: session.owner_label,
    owner_attribution: formatOwnerAttribution(session.owner_label),
    ide_label: session.ide_label,
    actor_label: session.actor_label,
    canonical_key: session.agent_key,
    runtime_key: `agent_session:${session.session_id}`,
    source: "api",
    resolved_at: session.updated_at,
  };
}

function requireWorkerAgentSession(
  roomId: string | null | undefined,
  sessionId?: string | null
): StoredAgentSessionState {
  const session = resolveAgentSession(roomId, sessionId);
  if (!session) {
    throw new Error(
      "Registered worker agent_session_id is required for this write action. " +
        "Call register_agent_session for this room first, then pass the returned agent_session_id explicitly."
    );
  }
  if (session.session_kind !== "worker") {
    throw new Error("Worker agent_session_id is required for this write action.");
  }
  return session;
}

async function resolveWorkerToolIdentity(input: {
  roomId?: string | null;
  agentSessionId?: string | null;
}): Promise<{ identity: StoredAgentIdentityState; agentSession: StoredAgentSessionState }> {
  const agentSession = requireWorkerAgentSession(input.roomId, input.agentSessionId);
  return {
    identity: identityFromAgentSession(agentSession),
    agentSession,
  };
}

function agentSessionCredentials(agentSession: StoredAgentSessionState): {
  agent_session_id: string;
  agent_session_token: string;
} {
  return {
    agent_session_id: agentSession.session_id,
    agent_session_token: agentSession.session_token,
  };
}

function toAgentReadableMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }

  const record = message as Record<string, unknown>;
  const kind = normalizeAgentPromptKind(record.agent_prompt_kind);
  const text = typeof record.text === "string" ? record.text : null;

  if (!kind || text === null) {
    return record;
  }

  return {
    ...record,
    visible_text: text,
    agent_prompt: buildRoomAgentPrompt(kind),
    prompt_injected: kind === "inline",
  };
}

function toAgentReadableMessages(messages: unknown[] | undefined): unknown[] {
  return (messages ?? []).map((message) => toAgentReadableMessage(message));
}

function appendIncludePromptOnly(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}include_prompt_only=1`;
}

async function roomScopedApiCall<T>(input: {
  room_id?: string | null;
  project_id?: string | null;
  room_path: (roomId: string) => string;
  project_path: (projectId: string) => string;
  options?: RequestInit;
}): Promise<T> {
  const headers = {
    ...(input.options?.headers as Record<string, string> | undefined),
  };
  if (
    currentRoom?.room_id &&
    !Object.keys(headers).some((key) =>
      key.toLowerCase() === LETAGENTS_ORIGIN_ROOM_ID_HEADER.toLowerCase()
    )
  ) {
    headers[LETAGENTS_ORIGIN_ROOM_ID_HEADER] = currentRoom.room_id;
  }
  const options = {
    ...input.options,
    headers,
  };

  if (input.room_id) {
    try {
      const result = await apiCall<T>(input.room_path(input.room_id), options);
      touchRoomSession(input.room_id, getLastMessageId(result));
      return result;
    } catch (error) {
      await maybeHandleRepoRoomAuthRequired(error, input.room_id);
      if (!input.project_id || !isMissingRouteError(error)) {
        throw error;
      }
    }
  }

  if (!input.project_id) {
    throw new Error("No room is available for this request.");
  }

  const result = await apiCall<T>(input.project_path(input.project_id), options);
  if (input.room_id) {
    touchRoomSession(input.room_id, getLastMessageId(result));
  }
  return result;
}

function normalizeOptionalToolString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function joinRoomIdentifier(identifier: string, joinedVia: JoinedVia): Promise<{
  room: RoomState;
  response: Record<string, unknown>;
}> {
  const roomId = joinedVia === "join_code" ? normalizeInviteCode(identifier) : identifier.trim();

  try {
    const response = await apiCall<Record<string, unknown>>(
      `/rooms/${encodeRoomIdPath(roomId)}/join`,
      { method: "POST" }
    );
    const joinedRoomId =
      typeof response.room_id === "string"
        ? response.room_id
        : roomId;
    const agentIdentity = await ensureAgentIdentity();
    const room = rememberRoom(
      toRoomState({
        room_id: joinedRoomId,
        project_id: typeof response.project_id === "string" ? response.project_id : null,
        code:
          typeof response.code === "string"
            ? response.code
            : looksLikeInviteCode(joinedRoomId)
              ? joinedRoomId
              : null,
        display_name: typeof response.display_name === "string" ? response.display_name : null,
        joined_via: joinedVia,
      })
    );
    await syncRoomPresence(room.room_id, agentIdentity, {
      status: "idle",
      status_text: "available in room",
    });
    return {
      room,
      response: {
        ...response,
        room_id: joinedRoomId,
        agent_identity: toPublicAgentIdentity(agentIdentity),
      },
    };
  } catch (error) {
    await maybeHandleRepoRoomAuthRequired(error, roomId);
    if (!isMissingRouteError(error)) {
      throw error;
    }
  }

  if (joinedVia === "join_code") {
    const project = await apiCall<Record<string, unknown>>(
      `/projects/join/${encodeURIComponent(roomId)}`
    );
    const legacyRoomId =
      typeof project.code === "string"
        ? project.code
        : roomId;
    const agentIdentity = await ensureAgentIdentity();
    const room = rememberRoom(
      toRoomState({
        room_id: legacyRoomId,
        project_id: typeof project.id === "string" ? project.id : null,
        code: typeof project.code === "string" ? project.code : legacyRoomId,
        display_name: typeof project.display_name === "string" ? project.display_name : null,
        joined_via: joinedVia,
      })
    );
    await syncRoomPresence(room.room_id, agentIdentity, {
      status: "idle",
      status_text: "available in room",
    });
    return {
      room,
      response: {
        ...project,
        room_id: legacyRoomId,
        project_id: typeof project.id === "string" ? project.id : null,
        agent_identity: toPublicAgentIdentity(agentIdentity),
      },
    };
  }

  const project = await apiCall<Record<string, unknown>>(
    `/projects/room/${encodeURIComponent(roomId)}`,
    { method: "POST" }
  );
  const legacyRoomId =
    typeof project.name === "string" && project.name.trim()
      ? project.name
      : typeof project.code === "string" && project.code.trim()
        ? project.code
        : roomId;
  const agentIdentity = await ensureAgentIdentity();
  const room = rememberRoom(
    toRoomState({
      room_id: legacyRoomId,
      project_id: typeof project.id === "string" ? project.id : null,
      code:
        typeof project.code === "string"
          ? project.code
          : looksLikeInviteCode(legacyRoomId)
            ? legacyRoomId
            : null,
      display_name: typeof project.display_name === "string" ? project.display_name : null,
      joined_via: joinedVia,
    })
  );
  await syncRoomPresence(room.room_id, agentIdentity, {
    status: "idle",
    status_text: "available in room",
  });
  return {
    room,
    response: {
      ...project,
      room_id: legacyRoomId,
      project_id: typeof project.id === "string" ? project.id : null,
      agent_identity: toPublicAgentIdentity(agentIdentity),
    },
  };
}

async function createInviteRoom(): Promise<{
  room: RoomState;
  response: Record<string, unknown>;
}> {
  const project = await apiCall<Record<string, unknown>>("/projects", { method: "POST" });
  const roomId =
    typeof project.code === "string"
      ? project.code
      : typeof project.id === "string"
        ? project.id
        : "unknown-room";

  const room = rememberRoom(
    toRoomState({
      room_id: roomId,
      project_id: typeof project.id === "string" ? project.id : null,
      code: typeof project.code === "string" ? project.code : roomId,
      display_name: typeof project.display_name === "string" ? project.display_name : null,
      joined_via: "join_code",
    })
  );
  const agentIdentity = await ensureAgentIdentity();
  await syncRoomPresence(room.room_id, agentIdentity, {
    status: "idle",
    status_text: "available in room",
  });

  return {
    room,
    response: {
      ...toPublicRoomResponse(project, roomId),
      agent_identity: toPublicAgentIdentity(agentIdentity),
    },
  };
}

async function buildJoinResponse(input: {
  joined: { room: RoomState; response: Record<string, unknown> };
  room_identifier: string;
  joined_via: JoinedVia;
  session_mode: JoinSessionMode;
}): Promise<Record<string, unknown>> {
  const basePayload = await withAgentIdentity({
    ...toPublicRoomResponse(input.joined.response, input.joined.room.room_id),
    joined_via: input.joined_via,
    session_mode: input.session_mode,
  });

  if (input.session_mode === "current") {
    return withJoinRoomAgentPrompt(basePayload);
  }

  const liveSession = await startLocalCodexSession({
    room_id: input.joined.room.room_id,
    room_identifier: input.room_identifier,
    room_code: input.joined.room.code ?? null,
    room_display_name: input.joined.room.display_name ?? null,
    joined_via: input.joined_via,
    cwd: process.cwd(),
  });

  return withJoinRoomAgentPrompt({
    ...basePayload,
    local_codex_session: toPublicCodexLiveSession(liveSession.session),
    local_codex_session_started: !liveSession.reused,
    local_codex_session_reused: liveSession.reused,
  });
}

async function joinInviteCode(
  code: string,
  sessionMode: JoinSessionMode
): Promise<Record<string, unknown>> {
  const joined = await joinRoomIdentifier(code, "join_code");
  return buildJoinResponse({
    joined,
    room_identifier: normalizeInviteCode(code),
    joined_via: "join_code",
    session_mode: sessionMode,
  });
}

async function joinNamedRoom(
  name: string,
  sessionMode: JoinSessionMode
): Promise<Record<string, unknown>> {
  const joined = await joinRoomIdentifier(name, "join_room");
  return buildJoinResponse({
    joined,
    room_identifier: name.trim(),
    joined_via: "join_room",
    session_mode: sessionMode,
  });
}
export {
  appendIncludePromptOnly,
  agentSessionCredentials,
  buildAgentDeliveryHeaders,
  buildJoinResponse,
  createInviteRoom,
  detectAgentIdeLabel,
  detectAgentRuntimeLabel,
  ensureAgentIdentity,
  getConversationIdentity,
  getCurrentLiveSessionPayload,
  getFallbackProjectId,
  getLetagentsToken,
  getLastMessageId,
  getRememberedRoomPresence,
  getSessionLivenessRegistration,
  getTargetRoomId,
  heartbeatRoomPresence,
  identityFromAgentSession,
  joinInviteCode,
  joinNamedRoom,
  joinRoomIdentifier,
  normalizeJoinSessionMode,
  normalizeOptionalToolString,
  rememberRoom,
  requireWorkerAgentSession,
  resolveAgentSession,
  resolveOwnerContext,
  resolveWorkerToolIdentity,
  roomScopedApiCall,
  setConversationIdentity,
  syncRoomPresence,
  toAgentReadableMessages,
  toPublicAgentIdentity,
  toPublicAgentSession,
  toPublicRoomState,
  toPublicStoredRoomSession,
  toRepoRoomAuthRequiredResult,
  touchCurrentRoom,
  withAgentIdentity,
  withCanonicalRoomLink,
  withJoinRoomAgentPrompt,
  apiCall,
};

export {
  clearPendingDeviceAuth,
  clearStoredAuth,
  clearStoredAuth as clearStoredAuthorization,
  endStoredAgentSession,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAgentIdentity,
  getStoredAgentSession,
  getStoredAuth,
  getStoredCurrentRoom,
  getStoredRoomSession,
  listStoredCodexLiveSessions,
  saveAgentSession,
  setPendingDeviceAuth,
  setStoredAuth,
  setStoredAgentIdentity,
  touchRoomSession,
  type StoredAccount,
  type StoredAgentIdentityState,
  type StoredAgentSessionState,
};

export async function autoJoinFromContext(): Promise<void> {
  try {
    const configRoom = getRoomFromConfig();
    if (configRoom) {
      await joinRoomIdentifier(configRoom, "config");
      await ensureAgentIdentity();
      console.error(`🏠 Auto-joined room '${configRoom}' (from .letagents.json)`);
      return;
    }

    const gitRoom = getGitRemoteIdentity();
    if (gitRoom) {
      await joinRoomIdentifier(gitRoom, "git-remote");
      await ensureAgentIdentity();
      console.error(`🏠 Auto-joined room '${gitRoom}' (inferred from git remote — consider adding a .letagents.json)`);
      return;
    }

    const savedCurrentRoom = getStoredCurrentRoom();
    if (savedCurrentRoom) {
      await joinRoomIdentifier(savedCurrentRoom.room_id, savedCurrentRoom.joined_via);
      await ensureAgentIdentity();
      console.error(`🏠 Rejoined saved room '${savedCurrentRoom.room_id}' (from local state)`);
      return;
    }

    console.error("ℹ️ No .letagents.json, git remote, or saved room found — use create_room, join_code, or join_room to connect.");
  } catch (err) {
    if (err instanceof RepoRoomAuthRequiredError) {
      console.error(
        `🔐 Repo room auth required for '${err.roomId}'. Open ${err.pendingAuth.verification_uri} and enter code ${err.pendingAuth.user_code}, then run poll_device_auth.`
      );
      return;
    }

    console.error("⚠️ Auto-join failed (server still running):", err instanceof Error ? err.message : err);
  }
}
