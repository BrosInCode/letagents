#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "crypto";
import { writeFileSync, existsSync } from "fs";
import { userInfo } from "os";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { SseClient, type Message } from "./sse-client.js";
import { getRoomFromConfig } from "./config-reader.js";
import { getGitRemoteIdentity } from "./git-remote.js";
import {
  clearPendingDeviceAuth,
  clearStoredAuth,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAgentIdentity,
  getStoredAuth,
  getStoredCurrentRoom,
  getStoredRoomSession,
  readLocalState,
  saveRoomSession,
  setStoredAgentIdentity,
  setPendingDeviceAuth,
  setStoredAuth,
  touchRoomSession,
  type PendingDeviceAuthState,
  type RoomSessionState,
  type StoredAgentIdentityState,
  type StoredAccount,
} from "./local-state.js";
import {
  encodeRoomIdPath,
  getCanonicalRoomWebPath,
  looksLikeInviteCode,
  normalizeInviteCode,
  type JoinedVia,
} from "./room-id.js";
import {
  buildAgentActorLabel,
  formatOwnerAttribution,
  inferAgentIdeLabel,
  toTitleCaseCodename,
} from "../shared/agent-identity.js";

// ---------------------------------------------------------------------------
// Room State
// ---------------------------------------------------------------------------

interface RoomState {
  room_id: string;
  project_id?: string | null;
  code?: string | null;
  display_name?: string | null;
  joined_via: JoinedVia;
}

const CURRENT_AGENT_IDENTITY_KEY = getAgentIdentityStorageKey();

let currentRoom: RoomState | null = null;
let currentAgentIdentity: StoredAgentIdentityState | null = getStoredAgentIdentity(
  CURRENT_AGENT_IDENTITY_KEY
);
let currentAuthenticatedAccount: StoredAccount | null | undefined = undefined;
let currentAuthenticatedAccountSource: "env" | "stored" | null = null;
let currentAuthenticatedEnvToken: string | null = null;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = (process.env.LETAGENTS_API_URL || "http://localhost:3001").replace(/\/+$/, "");
const AGENT_NAME = (process.env.LETAGENTS_AGENT_NAME || process.env.AGENT_NAME || "").trim();
const AGENT_DISPLAY_NAME = (process.env.LETAGENTS_AGENT_DISPLAY_NAME || "").trim();
const AGENT_IDE_LABEL = (process.env.LETAGENTS_AGENT_IDE || process.env.AGENT_IDE || "").trim();
const AGENT_OWNER_LABEL = (process.env.LETAGENTS_AGENT_OWNER_LABEL || "").trim();

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

function normalizeSlugSegment(input: string, fallback: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return normalized || fallback;
}

function normalizeAgentBaseName(input: string): string {
  return normalizeSlugSegment(input, "agent").replace(/-agent$/, "") || "agent";
}

function isCodexRuntime(): boolean {
  return Boolean(
    process.env.CODEX_THREAD_ID ||
      process.env.CODEX_SHELL ||
      process.env.CODEX_CI ||
      process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  );
}

const AGENT_CODENAMES = [
  "amber",
  "anchor",
  "autumn",
  "badger",
  "bay",
  "bear",
  "brook",
  "calm",
  "canyon",
  "cedar",
  "clear",
  "cloud",
  "comet",
  "copper",
  "creek",
  "crisp",
  "crest",
  "dawn",
  "delta",
  "dune",
  "ember",
  "falcon",
  "fern",
  "field",
  "firefly",
  "fjord",
  "forest",
  "fox",
  "garden",
  "glade",
  "golden",
  "granite",
  "grove",
  "harbor",
  "hawk",
  "hollow",
  "indigo",
  "ivory",
  "jade",
  "juniper",
  "lagoon",
  "lake",
  "lantern",
  "leaf",
  "lively",
  "lunar",
  "lynx",
  "maple",
  "marsh",
  "meadow",
  "mesa",
  "misty",
  "moon",
  "morrow",
  "moss",
  "noble",
  "oak",
  "olive",
  "opal",
  "otter",
  "owl",
  "peak",
  "pearl",
  "pine",
  "quiet",
  "raven",
  "reef",
  "ridge",
  "river",
  "rook",
  "sage",
  "scarlet",
  "shore",
  "silver",
  "sky",
  "solar",
  "sparrow",
  "spring",
  "star",
  "stone",
  "storm",
  "summit",
  "sun",
  "sunlit",
  "swift",
  "thicket",
  "tidal",
  "timber",
  "trail",
  "valley",
  "verdant",
  "vista",
  "warm",
  "wave",
  "west",
  "wild",
  "willow",
  "wind",
  "winter",
  "wolf",
  "wood",
  "wren",
] as const;

function getAgentIdentityStorageKey(): string {
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

  return `cwd:${process.cwd()}`;
}

function hashStringToIndex(value: string, modulo: number): number {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt16BE(0) % modulo;
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

function shouldReuseStoredIdentity(identity: StoredAgentIdentityState | null): boolean {
  return Boolean(
    identity &&
      identity.runtime_key === CURRENT_AGENT_IDENTITY_KEY &&
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

function pickLocalCodename(runtimeKey: string, offset = 0): { name: string; display_name: string } {
  const index = (hashStringToIndex(runtimeKey, AGENT_CODENAMES.length) + offset) % AGENT_CODENAMES.length;
  const word = AGENT_CODENAMES[index];
  return {
    name: normalizeAgentBaseName(word),
    display_name: toTitleCaseCodename(word),
  };
}

async function resolveAgentName(
  authAvailable: boolean
): Promise<{ name: string; display_name: string }> {
  const explicit = resolveExplicitAgentIdentity();
  if (explicit) {
    return explicit;
  }

  if (shouldReuseStoredIdentity(currentAgentIdentity)) {
    return {
      name: currentAgentIdentity!.name,
      display_name: currentAgentIdentity!.display_name,
    };
  }

  if (!authAvailable) {
    return pickLocalCodename(CURRENT_AGENT_IDENTITY_KEY);
  }

  const directory = await getAuthenticatedAgentDirectory();
  const existingNames = new Set(
    (directory?.agents ?? [])
      .map((agent) => normalizeAgentBaseName(agent.name || ""))
      .filter(Boolean)
  );

  for (let offset = 0; offset < AGENT_CODENAMES.length; offset += 1) {
    const candidate = pickLocalCodename(CURRENT_AGENT_IDENTITY_KEY, offset);
    if (!existingNames.has(candidate.name)) {
      return candidate;
    }
  }

  const fallbackHash = createHash("sha256")
    .update(CURRENT_AGENT_IDENTITY_KEY)
    .digest("hex")
    .slice(0, 4);
  const fallback = pickLocalCodename(CURRENT_AGENT_IDENTITY_KEY);
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
    source: identity.source,
  };
}

async function ensureAgentIdentity(): Promise<StoredAgentIdentityState> {
  const owner = await resolveOwnerContext();
  const authAvailable = Boolean(getLetagentsToken());
  const ideLabel = detectAgentIdeLabel();
  const ownerAttribution = formatOwnerAttribution(owner.label);
  const { name, display_name: displayName } = await resolveAgentName(authAvailable);
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
    runtime_key: CURRENT_AGENT_IDENTITY_KEY,
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
      CURRENT_AGENT_IDENTITY_KEY
    );
  }

  return currentAgentIdentity ?? resolved;
}

/**
 * Resolve the root of the git repository containing `dir`.
 * Returns null if `dir` is not inside a git repo.
 */
function resolveGitRoot(dir: string): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Walk from `startDir` up to the filesystem root, returning the first
 * directory that contains `.letagents.json`, or null if none found.
 */
function findExistingConfig(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, ".letagents.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break; // reached fs root
    current = parent;
  }
  return null;
}

class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

class RepoRoomAuthRequiredError extends Error {
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
  sseClient.unsubscribeAll();
  sseClient.subscribe(
    {
      roomId: state.room_id,
      projectId: state.project_id ?? null,
    },
    (_message: Message) => {
      touchRoomSession(state.room_id);
      server.server.sendResourceListChanged();
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

async function roomScopedApiCall<T>(input: {
  room_id?: string | null;
  project_id?: string | null;
  room_path: (roomId: string) => string;
  project_path: (projectId: string) => string;
  options?: RequestInit;
}): Promise<T> {
  if (input.room_id) {
    try {
      const result = await apiCall<T>(input.room_path(input.room_id), input.options);
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

  const result = await apiCall<T>(input.project_path(input.project_id), input.options);
  if (input.room_id) {
    touchRoomSession(input.room_id, getLastMessageId(result));
  }
  return result;
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
    const agentIdentity = await ensureAgentIdentity();
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
    const room = rememberRoom(
      toRoomState({
        room_id: legacyRoomId,
        project_id: typeof project.id === "string" ? project.id : null,
        code: typeof project.code === "string" ? project.code : legacyRoomId,
        display_name: typeof project.display_name === "string" ? project.display_name : null,
        joined_via: joinedVia,
      })
    );
    const agentIdentity = await ensureAgentIdentity();
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
  const agentIdentity = await ensureAgentIdentity();
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

  return {
    room,
    response: {
      ...toPublicRoomResponse(project, roomId),
      agent_identity: toPublicAgentIdentity(agentIdentity),
    },
  };
}

async function joinInviteCode(code: string): Promise<Record<string, unknown>> {
  const joined = await joinRoomIdentifier(code, "join_code");
  return withAgentIdentity({
    ...toPublicRoomResponse(joined.response, joined.room.room_id),
    joined_via: "join_code",
  });
}

async function joinNamedRoom(name: string): Promise<Record<string, unknown>> {
  const joined = await joinRoomIdentifier(name, "join_room");
  return withAgentIdentity({
    ...toPublicRoomResponse(joined.response, joined.room.room_id),
    joined_via: "join_room",
  });
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "letagents",
  version: "0.2.0",
});

const sseClient = new SseClient(API_URL, () => getLetagentsToken());

// ---------------------------------------------------------------------------
// MCP Resources
// ---------------------------------------------------------------------------

server.resource(
  "room_messages",
  new ResourceTemplate("letagents://rooms/{room_id}/messages", {
    list: undefined,
  }),
  async (uri, { room_id }) => {
    const normalizedRoomId = String(room_id);
    const storedSession =
      getStoredRoomSession(normalizedRoomId) ??
      (currentRoom?.room_id === normalizedRoomId ? getStoredCurrentRoom() : null);
    const result = await roomScopedApiCall({
      room_id: normalizedRoomId,
      project_id: storedSession?.project_id ?? null,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (projectId) => `/projects/${encodeURIComponent(projectId)}/messages`,
    });
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// -- create_room ------------------------------------------------------------

server.tool(
  "create_room",
  "Create a new invite room on Let Agents Chat. Returns the room ID and join code.",
  {},
  async () => {
    const created = await createInviteRoom();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(created.response, null, 2),
        },
      ],
    };
  }
);

// -- create_project ---------------------------------------------------------

server.tool(
  "create_project",
  "Legacy alias for create_room. Creates a new invite room and returns its join code.",
  {},
  async () => {
    const created = await createInviteRoom();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(created.response, null, 2),
        },
      ],
    };
  }
);

// -- join_code --------------------------------------------------------------

server.tool(
  "join_code",
  "Join an existing room using an invite code.",
  {
    code: z.string().describe("The invite code shared for the room (e.g. 'ABCX-7291')"),
  },
  async ({ code }) => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await joinInviteCode(code), null, 2),
        },
      ],
    };
  }
);

// -- join_project -----------------------------------------------------------

server.tool(
  "join_project",
  "Legacy alias for join_code. Join an existing room using an invite code.",
  {
    code: z.string().describe("The invite code shared for the room (e.g. 'ABCX-7291')"),
  },
  async ({ code }) => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await joinInviteCode(code), null, 2),
        },
      ],
    };
  }
);

// -- join_room --------------------------------------------------------------

server.tool(
  "join_room",
  "Join a named room on Let Agents Chat. Creates the room if it doesn't exist. Use this for repo-based room joining.",
  {
    name: z.string().describe("The room name to join (e.g. 'github.com/owner/repo')"),
  },
  async ({ name }) => {
    try {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await joinNamedRoom(name), null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof RepoRoomAuthRequiredError) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(toRepoRoomAuthRequiredResult(error), null, 2),
            },
          ],
        };
      }

      throw error;
    }
  }
);

// -- get_current_room -------------------------------------------------------

server.tool(
  "get_current_room",
  "Get information about the currently joined room, including how it was joined.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            currentRoom
              ? {
                  connected: true,
                  ...toPublicRoomState(currentRoom),
                  agent_identity: toPublicAgentIdentity(
                    currentAgentIdentity ?? getStoredAgentIdentity(CURRENT_AGENT_IDENTITY_KEY)
                  ),
                  auth: getStoredAuth()
                    ? {
                        source: process.env.LETAGENTS_TOKEN ? "env" : "local_state",
                        expires_at: getStoredAuth()?.expires_at ?? null,
                        account: getStoredAuth()?.account ?? null,
                      }
                    : null,
                }
              : { connected: false, message: "Not currently in any room" },
            null,
            2
          ),
        },
      ],
    };
  }
);

// -- check_repo -------------------------------------------------------------

server.tool(
  "check_repo",
  "Inspect the current repository context for Let Agents Chat. " +
    "Shows the git repo root, detected .letagents.json path, auto-derived room name from git remote, " +
    "and current room state. Useful for troubleshooting auto-join issues.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Directory to inspect. Defaults to the current process directory."),
  },
  async ({ cwd: targetDir }) => {
    const startDir = targetDir || process.cwd();

    const repoRoot = resolveGitRoot(startDir);
    const configDir = repoRoot ? findExistingConfig(startDir) : null;
    const configPath = configDir ? join(configDir, ".letagents.json") : null;

    let configContents: unknown = null;
    if (configPath && existsSync(configPath)) {
      try {
        const { readFileSync } = await import("fs");
        configContents = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        configContents = "<parse error>";
      }
    }

    const derivedRoom = repoRoot ? getGitRemoteIdentity(repoRoot) : null;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              cwd: startDir,
              git_repo_root: repoRoot ?? null,
              config_file: configPath ?? null,
              config_contents: configContents,
              derived_room_from_git: derivedRoom ?? null,
              current_room: toPublicRoomState(currentRoom),
              join_hint: !currentRoom
                ? repoRoot
                  ? "Run initialize_repo to set up .letagents.json, or use join_room/join_code to connect."
                  : "Not inside a git repo. Use create_room, join_code, or join_room to connect manually."
                : null,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// -- post_status ------------------------------------------------------------

server.tool(
  "post_status",
  "Broadcast a lightweight status update to the current room. " +
    "Use this to let other agents and humans know what you are currently doing, " +
    "e.g. 'reviewing PR #2', 'waiting for tests', 'writing WISHLIST.md'. " +
    "Status updates are distinct from chat messages and can be filtered separately.",
  {
    sender: z
      .string()
      .optional()
      .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
    status: z.string().describe("Short status description (e.g. 'reviewing PR #2', 'idle', 'thinking...')"),
    room_id: z
      .string()
      .optional()
      .describe("Canonical room ID. Defaults to the current room."),
  },
  async ({ sender: _sender, status, room_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();

    if (!targetRoomId && !targetProjectId) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: "No room_id provided and not currently in a room.",
                hint: "Join or create a room first, or pass room_id explicitly.",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Status messages use a reserved prefix so the UI (and agents) can distinguish
    // them from normal chat messages without changing the data model.
    const identity = await ensureAgentIdentity();
    const sender = identity.actor_label;
    const statusText = `[status] ${status}`;

    const message = await roomScopedApiCall<Record<string, unknown>>({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
      options: {
        method: "POST",
        body: JSON.stringify({ sender, text: statusText }),
      },
    });
    touchCurrentRoom(typeof message.id === "string" ? message.id : undefined);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              status_posted: status,
              sender,
              agent_identity: toPublicAgentIdentity(identity),
              message_id: typeof message.id === "string" ? message.id : null,
              timestamp: typeof message.timestamp === "string" ? message.timestamp : null,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// -- Task Board Tools -------------------------------------------------------

const TASK_STATUSES = [
  "proposed", "accepted", "assigned", "in_progress",
  "blocked", "in_review", "merged", "done", "cancelled",
] as const;

server.tool(
  "add_task",
  "Add a new task to the room board. Tasks normally start as 'proposed' and must be " +
    "accepted before an agent can claim them, but tasks created by trusted agents already " +
    "active in the room may be auto-accepted. Use this when a human or agent identifies " +
    "work that needs to be done.",
  {
    title: z.string().describe("Short task title, e.g. 'Wire up Jest test runner'"),
    description: z.string().optional().describe("Longer description of what needs to be done"),
    created_by: z
      .string()
      .optional()
      .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
    source_message_id: z.string().optional().describe("Optional message ID where task was agreed, e.g. 'msg_42'"),
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
  },
  async ({ title, description, created_by: _createdBy, source_message_id, room_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
      };
    }

    const identity = await ensureAgentIdentity();
    const task = await roomScopedApiCall({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks`,
      options: {
        method: "POST",
        body: JSON.stringify({
          title,
          description,
          created_by: identity.actor_label,
          source_message_id,
        }),
      },
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: true, task, agent_identity: toPublicAgentIdentity(identity) },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_board",
  "Get the current task board for the room. By default shows only open tasks " +
    "(not done/cancelled). Agents should check this on startup and when idle to " +
    "see if there is unassigned work to claim.",
  {
    status: z.enum(TASK_STATUSES).optional().describe("Filter by specific status"),
    open_only: z.boolean().optional().describe("If true (default), only show tasks not done/cancelled"),
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
  },
  async ({ status, open_only, room_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room. Join one first." }) }],
      };
    }

    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (open_only !== false) params.set("open", "true");

    const qs = params.toString();
    const result = await roomScopedApiCall<Record<string, unknown>>({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks${qs ? `?${qs}` : ""}`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks${qs ? `?${qs}` : ""}`,
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...result }, null, 2) }],
    };
  }
);

server.tool(
  "claim_task",
  "Claim an accepted task. The task must be in 'accepted' " +
    "status. This sets the assignee to you and moves the status to 'assigned'. " +
    "Do NOT claim proposed tasks — they need to be accepted first.",
  {
    task_id: z.string().describe("The task ID to claim, e.g. 'task_1'"),
    assignee: z
      .string()
      .optional()
      .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
  },
  async ({ task_id, assignee: _assignee, room_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const identity = await ensureAgentIdentity();
      const updated = await roomScopedApiCall({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        options: {
          method: "PATCH",
          body: JSON.stringify({ status: "assigned", assignee: identity.actor_label }),
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { success: true, task: updated, agent_identity: toPublicAgentIdentity(identity) },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
      };
    }
  }
);

server.tool(
  "update_task",
  "Update a task's status or assignee. Status transitions are validated — " +
    "only valid transitions are allowed (e.g. in_progress → in_review, " +
    "but NOT proposed → in_progress).",
  {
    task_id: z.string().describe("The task ID to update"),
    status: z.enum(TASK_STATUSES).optional().describe("New status for the task"),
    assignee: z
      .string()
      .optional()
      .describe("New assignee for the task. Defaults to the current agent when status=assigned."),
    pr_url: z.string().optional().describe("PR URL to link to the task"),
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
  },
  async ({ task_id, status, assignee, pr_url, room_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const identity =
        status === "assigned" && !assignee
          ? await ensureAgentIdentity()
          : null;
      const updated = await roomScopedApiCall({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        options: {
          method: "PATCH",
          body: JSON.stringify({
            status,
            assignee: assignee ?? identity?.actor_label,
            pr_url,
          }),
        },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                task: updated,
                agent_identity: identity ? toPublicAgentIdentity(identity) : null,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
      };
    }
  }
);

server.tool(
  "complete_task",
  "Submit a task for review. Moves the task to 'in_review' status. " +
    "Optionally attach a PR URL. After this, a reviewer must confirm " +
    "the work is merged before it can be marked done.",
  {
    task_id: z.string().describe("The task ID to submit for review"),
    pr_url: z.string().optional().describe("GitHub PR URL for the work"),
    room_id: z.string().optional().describe("Canonical room ID. Defaults to current room."),
  },
  async ({ task_id, pr_url, room_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();
    if (!targetRoomId && !targetProjectId) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Not in a room." }) }],
      };
    }

    try {
      const updated = await roomScopedApiCall({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/tasks/${encodeURIComponent(task_id)}`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/tasks/${encodeURIComponent(task_id)}`,
        options: {
          method: "PATCH",
          body: JSON.stringify({ status: "in_review", pr_url }),
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, task: updated }, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }) }],
      };
    }
  }
);

server.tool(
  "initialize_repo",
  "Initialize the current repo for Let Agents Chat by creating a .letagents.json config file. " +
    "This explicitly sets up repo-based room auto-join. Reads git remote to derive the room name, " +
    "or accepts a custom room name. Will NOT overwrite an existing .letagents.json. " +
    "Always writes to the repo root, not the current working directory.",
  {
    room: z
      .string()
      .optional()
      .describe(
        "Custom room name. If omitted, auto-derived from git remote (e.g. 'github.com/owner/repo')"
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        "Working directory hint for repo detection. Defaults to the current process directory."
      ),
  },
  async ({ room, cwd: targetDir }) => {
    const startDir = targetDir || process.cwd();

    // Resolve true git repo root — never write to a subdirectory
    const repoRoot = resolveGitRoot(startDir);
    if (!repoRoot) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: "Not inside a git repository",
                hint: "Run this tool from inside a git repo, or pass a 'cwd' pointing to one.",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Walk parent dirs from startDir (not repoRoot) to catch configs in subtrees below caller
    const existingConfigDir = findExistingConfig(startDir);
    if (existingConfigDir) {
      const existingPath = join(existingConfigDir, ".letagents.json");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: ".letagents.json already exists",
                path: existingPath,
                hint: existingConfigDir === repoRoot
                  ? "Delete the existing file first if you want to reinitialize."
                  : `Found a config in a parent directory (${existingConfigDir}). Delete it or move it to ${repoRoot} to reinitialize.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const configPath = join(repoRoot, ".letagents.json");

    // Safety check (shouldn't be needed after findExistingConfig, but defensive)
    if (existsSync(configPath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: ".letagents.json already exists",
                path: configPath,
                hint: "Delete the existing file first if you want to reinitialize.",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Determine room name
    let roomName = room;
    if (!roomName) {
      const gitRoom = getGitRemoteIdentity(repoRoot);
      if (!gitRoom) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error:
                    "Cannot derive room name: no git remote found and no custom room name provided",
                  hint: "Pass a 'room' parameter or run from inside a git repo with a remote configured.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      roomName = gitRoom;
    }

    // Write the config file
    const config = { room: roomName };
    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: `Failed to write config: ${err instanceof Error ? err.message : err}`,
                path: configPath,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Auto-join the room after creating config
    try {
      const joined = await joinRoomIdentifier(roomName, "config");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                created: configPath,
                room_id: joined.room.room_id,
                code: joined.room.code ?? null,
                joined: true,
                hint: "Consider adding .letagents.json to git so other contributors auto-join the same room.",
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      // Config was created but auto-join failed
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                created: configPath,
                room_id: roomName,
                joined: false,
                error: `Config created but auto-join failed: ${err instanceof Error ? err.message : err}`,
                hint: "The .letagents.json was created. Use join_room to manually connect.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// -- send_message -----------------------------------------------------------

server.tool(
  "send_message",
  "Send a message to a Let Agents Chat room.",
  {
    room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
    sender: z
      .string()
      .optional()
      .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
    text: z.string().describe("The message text to send"),
  },
  async ({ room_id, sender: _sender, text }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();
    if (!targetRoomId && !targetProjectId) {
      throw new Error("No room is currently selected. Join a room first or pass room_id.");
    }

    const identity = await ensureAgentIdentity();
    const message = await roomScopedApiCall<Record<string, unknown>>({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
      options: {
        method: "POST",
        body: JSON.stringify({ sender: identity.actor_label, text }),
      },
    });
    touchCurrentRoom(typeof (message as { id?: string }).id === "string" ? (message as { id: string }).id : undefined);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ...message,
              agent_identity: toPublicAgentIdentity(identity),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// -- read_messages ----------------------------------------------------------

server.tool(
  "read_messages",
  "Read all messages from a Let Agents Chat room.",
  {
    room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
  },
  async ({ room_id }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();
    const result = await roomScopedApiCall({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// -- wait_for_messages ------------------------------------------------------

const MAX_POLL_TIMEOUT_MS = 180000; // 3 minutes
const DEFAULT_POLL_TIMEOUT_MS = 30000; // 30 seconds

server.tool(
  "wait_for_messages",
  "Wait for new messages in a Let Agents Chat room. Blocks until new messages arrive or 30 seconds elapse. Use the after_message_id parameter to only receive messages newer than a specific message.",
  {
    room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
    after_message_id: z
      .string()
      .optional()
      .describe("Only return messages after this message ID (e.g. 'msg_3'). If omitted, returns all existing messages immediately."),
    timeout: z
      .number()
      .optional()
      .describe("Maximum wait time in milliseconds. If set to 0, the default timeout will be used."),
  },
  async ({ room_id, after_message_id, timeout }) => {
    const targetRoomId = getTargetRoomId(room_id);
    const targetProjectId = getFallbackProjectId();
    const serverTimeout = Math.min(
      Math.max(timeout || DEFAULT_POLL_TIMEOUT_MS, 1000),
      MAX_POLL_TIMEOUT_MS
    );
    const clientTimeout = serverTimeout + 5000; // 5s buffer over server timeout

    const params = new URLSearchParams();
    if (after_message_id) params.set("after", after_message_id);
    params.set("timeout", String(serverTimeout));

    const queryString = params.toString();
    const result = await roomScopedApiCall({
      room_id: targetRoomId,
      project_id: targetProjectId,
      room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages/poll?${queryString}`,
      project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages/poll?${queryString}`,
      options: { signal: AbortSignal.timeout(clientTimeout) },
    });
    if (targetRoomId) {
      touchRoomSession(targetRoomId, getLastMessageId(result));
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// -- onboarding -------------------------------------------------------------

server.tool(
  "get_onboarding_status",
  "Inspect local Let Agents MCP auth and room-session state so a user can finish onboarding without guessing what is missing.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Working directory to inspect for repo context. Defaults to the current process directory."),
  },
  async ({ cwd }) => {
    const workingDir = cwd || process.cwd();
    const repoRoot = resolveGitRoot(workingDir);
    const configRoom = getRoomFromConfig(workingDir);
    const gitRoom = repoRoot ? getGitRemoteIdentity(repoRoot) : null;
    const storedAuth = getStoredAuth();
    const pendingAuth = getPendingDeviceAuth();
    const savedCurrentRoom = getStoredCurrentRoom();
    const detectedRoom = configRoom || gitRoom;

    let nextStep = "join_room";
    if (!storedAuth && pendingAuth) {
      nextStep = "poll_device_auth";
    } else if (savedCurrentRoom && !currentRoom) {
      nextStep = "resume_room_session";
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              api_url: API_URL,
              local_state_path: getLocalStatePath(),
              authenticated: Boolean(process.env.LETAGENTS_TOKEN || storedAuth),
              auth_source: process.env.LETAGENTS_TOKEN
                ? "env"
                : storedAuth
                  ? "local_state"
                  : "none",
              account: storedAuth?.account ?? null,
              token_expires_at: storedAuth?.expires_at ?? null,
              pending_device_auth: pendingAuth,
              agent_identity: toPublicAgentIdentity(
                currentAgentIdentity ?? getStoredAgentIdentity(CURRENT_AGENT_IDENTITY_KEY)
              ),
              current_room: toPublicRoomState(currentRoom),
              saved_current_room: toPublicStoredRoomSession(savedCurrentRoom),
              detected_room_from_context: detectedRoom,
              repo_root: repoRoot,
              next_step: nextStep,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "start_device_auth",
  "Start GitHub Device Flow for Let Agents Chat and persist the pending request locally. Use this when private repo access or explicit LetAgents auth is needed.",
  {
    room_id: z
      .string()
      .optional()
      .describe("Optional room to associate with this auth request for later auto-join."),
    force: z
      .boolean()
      .optional()
      .describe("If true, replaces any existing pending device auth request."),
  },
  async ({ room_id, force }) => {
    const existing = getPendingDeviceAuth();
    if (existing && !force) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                reused_existing_request: true,
                ...existing,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const response = await apiCall<{
      request_id: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    }>("/auth/device/start", {
      method: "POST",
    });

    const pendingAuth = setPendingDeviceAuth({
      request_id: response.request_id,
      user_code: response.user_code,
      verification_uri: response.verification_uri,
      interval_seconds: response.interval,
      expires_at: new Date(Date.now() + response.expires_in * 1000).toISOString(),
      started_at: new Date().toISOString(),
      suggested_room_id: room_id ?? currentRoom?.room_id ?? getRoomFromConfig() ?? undefined,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              ...pendingAuth,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "poll_device_auth",
  "Poll a pending GitHub Device Flow request. On success this stores the LetAgents token locally and can optionally join a room immediately.",
  {
    request_id: z
      .string()
      .optional()
      .describe("The device auth request to poll. Defaults to the locally saved pending request."),
    room_id: z
      .string()
      .optional()
      .describe("Optional room to auto-join after authorization succeeds."),
    auto_join: z
      .boolean()
      .optional()
      .describe("If true, tries to join the room immediately after the auth succeeds."),
  },
  async ({ request_id, room_id, auto_join }) => {
    const pendingAuth = request_id
      ? getPendingDeviceAuth()?.request_id === request_id
        ? getPendingDeviceAuth()
        : null
      : getPendingDeviceAuth();

    if (!pendingAuth && !request_id) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { success: false, error: "No pending device auth request found." },
              null,
              2
            ),
          },
        ],
      };
    }

    const requestId = request_id || pendingAuth?.request_id;
    if (!requestId) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { success: false, error: "A request_id is required when nothing is saved locally." },
              null,
              2
            ),
          },
        ],
      };
    }

    const result = await apiCall<{
      status: "pending" | "slow_down" | "authorized" | "denied" | "expired";
      interval?: number;
      expires_in?: number;
      letagents_token?: string;
      expires_at?: string;
      account?: StoredAccount;
    }>(`/auth/device/poll/${encodeURIComponent(requestId)}`);

    if (result.status === "pending" || result.status === "slow_down") {
      if (pendingAuth) {
        setPendingDeviceAuth({
          ...pendingAuth,
          interval_seconds: result.interval ?? pendingAuth.interval_seconds,
          expires_at:
            result.expires_in !== undefined
              ? new Date(Date.now() + result.expires_in * 1000).toISOString()
              : pendingAuth.expires_at,
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: true, ...result }, null, 2),
          },
        ],
      };
    }

    if (result.status === "denied" || result.status === "expired") {
      clearPendingDeviceAuth();
      clearStoredAuth();
      currentAuthenticatedAccount = undefined;
      currentAuthenticatedAccountSource = null;
      currentAuthenticatedEnvToken = null;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ success: false, ...result }, null, 2),
          },
        ],
      };
    }

    if (!result.letagents_token) {
      throw new Error("Device auth completed without a LetAgents token.");
    }

    clearPendingDeviceAuth();
    const storedAuth = setStoredAuth({
      token: result.letagents_token,
      expires_at: result.expires_at,
      account: result.account,
      stored_at: new Date().toISOString(),
      source: "device_flow",
    });
    currentAuthenticatedAccount = storedAuth.account ?? undefined;
    currentAuthenticatedAccountSource = storedAuth.account ? "stored" : null;
    currentAuthenticatedEnvToken = null;

    let joinedRoom: RoomState | null = null;
    const roomToJoin =
      room_id ||
      pendingAuth?.suggested_room_id ||
      currentRoom?.room_id ||
      getRoomFromConfig() ||
      undefined;

    if (auto_join && roomToJoin) {
      const joinedVia: JoinedVia = looksLikeInviteCode(roomToJoin) ? "join_code" : "join_room";
      const joined = await joinRoomIdentifier(roomToJoin, joinedVia);
      joinedRoom = joined.room;
    }

    const agentIdentity = await ensureAgentIdentity();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              status: "authorized",
              account: storedAuth.account ?? null,
              expires_at: storedAuth.expires_at ?? null,
              auto_joined_room: joinedRoom,
              agent_identity: toPublicAgentIdentity(agentIdentity),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "clear_saved_auth",
  "Clear any locally saved LetAgents auth token and pending device auth request.",
  {},
  async () => {
    clearPendingDeviceAuth();
    clearStoredAuth();
    currentAuthenticatedAccount = undefined;
    currentAuthenticatedAccountSource = null;
    currentAuthenticatedEnvToken = null;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              env_token_still_present: Boolean(process.env.LETAGENTS_TOKEN),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "resume_room_session",
  "Rejoin the last locally saved room context, or a specific saved room, after a restart. This recreates participation in the room; it does not preserve a prior server-side session ID.",
  {
    room_id: z
      .string()
      .optional()
      .describe("Optional saved room ID to resume. Defaults to the last current room."),
  },
  async ({ room_id }) => {
    const savedRoom =
      (room_id ? getStoredRoomSession(room_id) : null) ??
      getStoredCurrentRoom();

    if (!savedRoom) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { success: false, error: "No saved room session found." },
              null,
              2
            ),
          },
        ],
      };
    }

    try {
      const joined = await joinRoomIdentifier(savedRoom.room_id, savedRoom.joined_via);
      const agentIdentity = await ensureAgentIdentity();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                rejoined_from_local_state: true,
                server_session_resumed: false,
                last_message_id_before_restart: savedRoom.last_message_id ?? null,
                room: toPublicRoomState(joined.room),
                agent_identity: toPublicAgentIdentity(agentIdentity),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof RepoRoomAuthRequiredError) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(toRepoRoomAuthRequiredResult(error), null, 2),
            },
          ],
        };
      }

      throw error;
    }
  }
);

// -- check_repo_visibility --------------------------------------------------

server.tool(
  "check_repo_visibility",
  "Auto-detect the current repo's git remote and check if it's public or private. Returns the canonical key, provider, visibility, and suggested room type (discoverable for public, invite for private/unknown). Useful for deciding whether to auto-join a discoverable room or create an invite room.",
  {
    cwd: z
      .string()
      .optional()
      .describe("Working directory to detect git remote from. Defaults to the MCP server's working directory."),
  },
  async ({ cwd }) => {
    const { autoDetectRepo } = await import("./repo-visibility.js");

    const result = await autoDetectRepo(cwd);

    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not in a git repository or no remote configured",
              suggestion: "Use create_room to create an invite room instead",
            }, null, 2),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🔌 Let Agents Chat MCP server running on stdio (v0.6.0)");

  // --- Auto-join from repo context ---
  try {
    // 1. Try .letagents.json config
    const configRoom = getRoomFromConfig();
    if (configRoom) {
      await joinRoomIdentifier(configRoom, "config");
      await ensureAgentIdentity();
      console.error(`🏠 Auto-joined room '${configRoom}' (from .letagents.json)`);
      return;
    }

    // 2. Try git remote URL
    const gitRoom = getGitRemoteIdentity();
    if (gitRoom) {
      await joinRoomIdentifier(gitRoom, "git-remote");
      await ensureAgentIdentity();
      console.error(`🏠 Auto-joined room '${gitRoom}' (inferred from git remote — consider adding a .letagents.json)`);
      return;
    }

    // 3. Fall back to the most recent saved room session
    const savedCurrentRoom = getStoredCurrentRoom();
    if (savedCurrentRoom) {
      await joinRoomIdentifier(savedCurrentRoom.room_id, savedCurrentRoom.joined_via);
      await ensureAgentIdentity();
      console.error(`🏠 Rejoined saved room '${savedCurrentRoom.room_id}' (from local state)`);
      return;
    }

    // 4. No context found
    console.error("ℹ️ No .letagents.json, git remote, or saved room found — use create_room, join_code, or join_room to connect.");
  } catch (err) {
    if (err instanceof RepoRoomAuthRequiredError) {
      console.error(
        `🔐 Repo room auth required for '${err.roomId}'. Open ${err.pendingAuth.verification_uri} and enter code ${err.pendingAuth.user_code}, then run poll_device_auth.`
      );
      return;
    }

    // Auto-join failure should never block the MCP server
    console.error("⚠️ Auto-join failed (server still running):", err instanceof Error ? err.message : err);
  }
}

// Cleanup on exit
process.on("SIGINT", () => {
  sseClient.unsubscribeAll();
  process.exit(0);
});

process.on("SIGTERM", () => {
  sseClient.unsubscribeAll();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
