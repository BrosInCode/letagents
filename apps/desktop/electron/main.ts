import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopAuthAccount,
  DesktopAuthPollResult,
  DesktopAuthStartResult,
  DesktopAuthStatus,
  DesktopAppInfo,
  DiagnosticsSnapshot,
  DesktopFocusRoomInfo,
  DesktopGitHubIntegrationActionResult,
  DesktopGitHubIntegrationStatus,
  DesktopMcpInstallManyResult,
  DesktopMcpInstallResult,
  DesktopMcpInstallState,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
  DesktopPendingDeviceAuth,
  DesktopReasoningSession,
  DesktopRoomAccess,
  DesktopRoomMessage,
  DesktopRepoRoomSelection,
  DesktopSendRoomMessageResult,
  DesktopParticipantSummary,
  DesktopDroppedAttachmentContent,
  DesktopRoomInfo,
  DesktopRoomMessagesPage,
  DesktopRoomSnapshot,
  DesktopRoomStreamEvent,
  DesktopStagedAttachment,
  DesktopTaskSummary,
  RepoStatus,
  RepoWorktreeEntry,
  WorkerSnapshot,
} from "./ipc-types.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(__dirname, "..");
const workspaceRoot = join(desktopRoot, "..", "..");
const rendererDistPath = join(desktopRoot, "dist-renderer", "index.html");
const devServerUrl = process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim() || null;
const apiUrl = process.env.LETAGENTS_API_URL?.trim() || "https://letagents.chat";
const attachmentProtocolScheme = "letagents-attachment";
const roomMessageHistoryPageSize = 150;

protocol.registerSchemesAsPrivileged([
  {
    scheme: attachmentProtocolScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let activeRoomStream: {
  roomIdentifier: string;
  abortController: AbortController;
  reconnectTimer: NodeJS.Timeout | null;
  pollAbortController: AbortController | null;
  retryMs: number;
  lastMessageId: string | null;
  stopped: boolean;
} | null = null;

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

type StoredMcpInstallSetup = {
  completed: boolean;
  completedAt: string | null;
  selectedTargetId: DesktopMcpInstallTargetId | null;
  installs: Partial<Record<DesktopMcpInstallTargetId, { lastInstalledAt: string }>>;
};

const mcpInstallTargetIds: DesktopMcpInstallTargetId[] = ["claude-code", "antigravity", "cursor", "codex"];

type McpServerJsonConfig = {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

type McpInstallConfigFormat = "json" | "codex_toml";

type McpInstallTargetDefinition = Omit<DesktopMcpInstallTarget, "status" | "lastInstalledAt"> & {
  configFormat: McpInstallConfigFormat;
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

type RoomInfoPayload = {
  room_id?: string;
  code?: string;
  name?: string | null;
  display_name?: string | null;
  role?: string;
  authenticated?: boolean;
  kind?: "main" | "focus";
  parent_room_id?: string | null;
  focus_key?: string | null;
  source_task_id?: string | null;
  focus_status?: "active" | "concluded" | null;
};

class DesktopApiError extends Error {
  readonly status: number;
  readonly payload: ApiErrorPayload | null;

  constructor(status: number, payload: ApiErrorPayload | null) {
    super(payload?.message || payload?.error || `API request failed: ${status}`);
    this.name = "DesktopApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspaceRoot,
  });
  return stdout;
}

async function runGitInPath(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function getCurrentBranch(): Promise<string | null> {
  try {
    const stdout = await runGit(["branch", "--show-current"]);
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

async function getWorktrees(): Promise<RepoWorktreeEntry[]> {
  try {
    const stdout = await runGit(["worktree", "list", "--porcelain"]);
    const lines = stdout.split(/\r?\n/);
    const entries: RepoWorktreeEntry[] = [];
    let current: Partial<RepoWorktreeEntry> | null = null;

    for (const line of lines) {
      if (!line.trim()) {
        if (current?.path && current.head) {
          entries.push({
            path: current.path,
            branch: current.branch ?? null,
            head: current.head,
            isCurrent: current.path === workspaceRoot,
          });
        }
        current = null;
        continue;
      }

      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ").trim();
      if (key === "worktree") {
        current = { path: value };
      } else if (current && key === "HEAD") {
        current.head = value;
      } else if (current && key === "branch") {
        current.branch = value.replace(/^refs\/heads\//, "");
      }
    }

    if (current?.path && current.head) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head,
        isCurrent: current.path === workspaceRoot,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

async function buildRepoStatus(): Promise<RepoStatus> {
  return {
    rootPath: workspaceRoot,
    branch: await getCurrentBranch(),
    worktrees: await getWorktrees(),
  };
}

function normalizeGitRemoteToRoomIdentifier(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;

  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`.replace(/\.git$/, "");
  }

  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return `${url.hostname}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readConfiguredRoomIdentifier(): string | null {
  try {
    const configPath = join(workspaceRoot, ".letagents.json");
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { room?: string };
    return parsed.room?.trim() || null;
  } catch {
    return null;
  }
}

function readConfiguredRoomIdentifierAt(repoRoot: string): string | null {
  try {
    const configPath = join(repoRoot, ".letagents.json");
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { room?: string };
    return parsed.room?.trim() || null;
  } catch {
    return null;
  }
}

async function resolveRoomIdentifier(): Promise<string | null> {
  const configured = readConfiguredRoomIdentifier();
  if (configured) return configured;

  try {
    const stdout = await runGit(["remote", "get-url", "origin"]);
    return normalizeGitRemoteToRoomIdentifier(stdout);
  } catch {
    return null;
  }
}

function slugifyLocalProjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
}

function createLocalRoomIdentifier(projectPath: string): string {
  const normalizedPath = resolve(projectPath);
  const folderName = slugifyLocalProjectName(basename(normalizedPath));
  const pathHash = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 10);
  return `local-${folderName}-${pathHash}`;
}

async function resolveRoomIdentifierFromPath(folderPath: string): Promise<{
  repoRoot: string | null;
  roomIdentifier: string;
  source: DesktopRepoRoomSelection["source"];
  warning: string | null;
}> {
  let repoRoot: string | null = null;
  try {
    const stdout = await runGitInPath(folderPath, ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim() || null;
  } catch {
    return {
      repoRoot: null,
      roomIdentifier: createLocalRoomIdentifier(folderPath),
      source: "local_fallback",
      warning: "This folder is not a Git repository yet. LetAgents opened a local room that you can attach to GitHub later.",
    };
  }

  if (!repoRoot) {
    return {
      repoRoot: null,
      roomIdentifier: createLocalRoomIdentifier(folderPath),
      source: "local_fallback",
      warning: "This folder is not a Git repository yet. LetAgents opened a local room that you can attach to GitHub later.",
    };
  }

  const configured = readConfiguredRoomIdentifierAt(repoRoot);
  if (configured) return { repoRoot, roomIdentifier: configured, source: "configured", warning: null };

  try {
    const stdout = await runGitInPath(repoRoot, ["remote", "get-url", "origin"]);
    const roomIdentifier = normalizeGitRemoteToRoomIdentifier(stdout);
    if (roomIdentifier) return { repoRoot, roomIdentifier, source: "git_remote", warning: null };
  } catch {
    // Fall through to the local room fallback below.
  }

  return {
    repoRoot,
    roomIdentifier: createLocalRoomIdentifier(repoRoot),
    source: "local_fallback",
    warning: "This repo is only on your Mac. LetAgents opened a local room; attach it to GitHub after you add a remote.",
  };
}

function getSetupStorePath(): string {
  return join(app.getPath("userData"), "letagents-desktop-setup.json");
}

function getMcpInstallTargetDefinitions(): McpInstallTargetDefinition[] {
  const home = homedir();
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      description: "Add the MCP connection Claude Code needs to join rooms.",
      configPath: join(home, ".claude", "settings.json"),
      configFormat: "json",
      restartHint: "Restart Claude Code or reload its MCP servers after installing.",
    },
    {
      id: "antigravity",
      name: "Antigravity",
      description: "Add the MCP connection Antigravity needs to join rooms.",
      configPath: join(home, ".gemini", "settings.json"),
      configFormat: "json",
      restartHint: "Restart Antigravity so it picks up the updated MCP settings.",
    },
    {
      id: "cursor",
      name: "Cursor",
      description: "Add the MCP connection Cursor needs to join rooms.",
      configPath: join(home, ".cursor", "mcp.json"),
      configFormat: "json",
      restartHint: "Reload Cursor or restart its MCP server after installing.",
    },
    {
      id: "codex",
      name: "Codex",
      description: "Add the MCP connection Codex needs to join rooms.",
      configPath: join(home, ".codex", "config.toml"),
      configFormat: "codex_toml",
      restartHint: "Restart Codex so it discovers the LetAgents MCP server.",
    },
  ];
}

function createLetAgentsMcpServerConfig(): NonNullable<McpServerJsonConfig["mcpServers"]>[string] {
  return {
    command: "npx",
    args: ["-y", "letagents"],
    cwd: workspaceRoot,
    env: {
      LETAGENTS_API_URL: apiUrl,
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function removeTomlTable(source: string, tableName: string): string {
  const tablePattern = new RegExp(
    `(?:^|\\n)\\[${escapeRegExp(tableName)}\\]\\n[\\s\\S]*?(?=\\n\\[[^\\]]+\\]|$)`,
    "g"
  );
  return source.replace(tablePattern, "\n");
}

function getTomlTableBody(source: string, tableName: string): string | null {
  const tablePattern = new RegExp(
    `(?:^|\\n)\\[${escapeRegExp(tableName)}\\]\\n([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`
  );
  return tablePattern.exec(source)?.[1] ?? null;
}

function getTomlStringValue(tableBody: string, key: string): string | null {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"\\s*$`, "m").exec(tableBody);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function getTomlStringArrayValue(tableBody: string, key: string): string[] | null {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`, "m").exec(tableBody);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function readStoredMcpSetup(): Promise<StoredMcpInstallSetup> {
  try {
    const raw = await readFile(getSetupStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredMcpInstallSetup>;
    return {
      completed: Boolean(parsed.completed),
      completedAt: parsed.completedAt || null,
      selectedTargetId: parsed.selectedTargetId || null,
      installs: parsed.installs || {},
    };
  } catch {
    return {
      completed: false,
      completedAt: null,
      selectedTargetId: null,
      installs: {},
    };
  }
}

async function writeStoredMcpSetup(nextSetup: StoredMcpInstallSetup): Promise<void> {
  await mkdir(dirname(getSetupStorePath()), { recursive: true });
  await writeFile(getSetupStorePath(), `${JSON.stringify(nextSetup, null, 2)}\n`, "utf8");
}

async function readMcpJsonConfig(configPath: string): Promise<McpServerJsonConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as McpServerJsonConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function getJsonLetAgentsMcpInstallStatus(configPath: string): DesktopMcpInstallTarget["status"] {
  try {
    const raw = readFileSync(configPath, "utf8");
    if (!raw.trim()) return "not_installed";
    const parsed = JSON.parse(raw) as McpServerJsonConfig;
    const server = parsed.mcpServers?.letagents;
    if (!server) return "not_installed";

    const expected = createLetAgentsMcpServerConfig();
    const env = isStringRecord(server.env) ? server.env : {};
    const matchesExpected =
      server.command === expected.command
      && Array.isArray(server.args)
      && JSON.stringify(server.args) === JSON.stringify(expected.args)
      && server.cwd === expected.cwd
      && env.LETAGENTS_API_URL === expected.env?.LETAGENTS_API_URL;

    return matchesExpected ? "installed" : "needs_attention";
  } catch {
    return "not_installed";
  }
}

function getCodexTomlLetAgentsMcpInstallStatus(configPath: string): DesktopMcpInstallTarget["status"] {
  try {
    const raw = readFileSync(configPath, "utf8");
    if (!raw.trim()) return "not_installed";

    const serverBody = getTomlTableBody(raw, "mcp_servers.letagents");
    if (!serverBody) return "not_installed";

    const envBody = getTomlTableBody(raw, "mcp_servers.letagents.env");
    const expected = createLetAgentsMcpServerConfig();
    const matchesExpected =
      getTomlStringValue(serverBody, "command") === expected.command
      && JSON.stringify(getTomlStringArrayValue(serverBody, "args")) === JSON.stringify(expected.args)
      && getTomlStringValue(serverBody, "cwd") === expected.cwd
      && envBody !== null
      && getTomlStringValue(envBody, "LETAGENTS_API_URL") === expected.env?.LETAGENTS_API_URL;

    return matchesExpected ? "installed" : "needs_attention";
  } catch {
    return "not_installed";
  }
}

function getLetAgentsMcpInstallStatus(target: McpInstallTargetDefinition): DesktopMcpInstallTarget["status"] {
  if (target.configFormat === "codex_toml") {
    return getCodexTomlLetAgentsMcpInstallStatus(target.configPath);
  }
  return getJsonLetAgentsMcpInstallStatus(target.configPath);
}

async function writeMcpJsonConfig(configPath: string, config: McpServerJsonConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function writeCodexTomlMcpConfig(configPath: string): Promise<void> {
  let currentConfig = "";
  try {
    currentConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const expected = createLetAgentsMcpServerConfig();
  const withoutLetAgentsTables = removeTomlTable(
    removeTomlTable(currentConfig, "mcp_servers.letagents.env"),
    "mcp_servers.letagents"
  ).trimEnd();
  const letAgentsTable = [
    "[mcp_servers.letagents]",
    `command = ${tomlString(expected.command || "npx")}`,
    `args = ${tomlStringArray(expected.args || ["-y", "letagents"])}`,
    `cwd = ${tomlString(expected.cwd || workspaceRoot)}`,
    "",
    "[mcp_servers.letagents.env]",
    `LETAGENTS_API_URL = ${tomlString(expected.env?.LETAGENTS_API_URL || apiUrl)}`,
  ].join("\n");

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${withoutLetAgentsTables ? `${withoutLetAgentsTables}\n\n` : ""}${letAgentsTable}\n`,
    "utf8"
  );
}

async function buildMcpInstallState(): Promise<DesktopMcpInstallState> {
  const storedSetup = await readStoredMcpSetup();
  const targets = getMcpInstallTargetDefinitions().map<DesktopMcpInstallTarget>((target) => {
    const status = getLetAgentsMcpInstallStatus(target);
    const { configFormat: _configFormat, ...publicTarget } = target;
    return {
      ...publicTarget,
      status,
      lastInstalledAt: storedSetup.installs[target.id]?.lastInstalledAt || null,
    };
  });
  const firstInstalledTarget = targets.find((target) => target.status === "installed");
  return {
    completed: storedSetup.completed,
    completedAt: storedSetup.completedAt,
    selectedTargetId: storedSetup.selectedTargetId || firstInstalledTarget?.id || null,
    targets,
  };
}

function assertMcpInstallTargetId(targetId: string): asserts targetId is DesktopMcpInstallTargetId {
  if (!mcpInstallTargetIds.includes(targetId as DesktopMcpInstallTargetId)) {
    throw new Error(`Unknown MCP install target: ${targetId}`);
  }
}

async function writeLetAgentsMcpServerForTarget(targetDefinition: McpInstallTargetDefinition): Promise<void> {
  if (targetDefinition.configFormat === "codex_toml") {
    await writeCodexTomlMcpConfig(targetDefinition.configPath);
    return;
  }

  const currentConfig = await readMcpJsonConfig(targetDefinition.configPath);
  const nextConfig: McpServerJsonConfig = {
    ...currentConfig,
    mcpServers: {
      ...(currentConfig.mcpServers || {}),
      letagents: createLetAgentsMcpServerConfig(),
    },
  };
  await writeMcpJsonConfig(targetDefinition.configPath, nextConfig);
}

async function installLetAgentsMcpServers(targetIds: DesktopMcpInstallTargetId[]): Promise<DesktopMcpInstallManyResult> {
  if (!targetIds.length) {
    throw new Error("Choose at least one app for MCP setup.");
  }

  const uniqueTargetIds = [...new Set(targetIds)];
  uniqueTargetIds.forEach(assertMcpInstallTargetId);
  const targetDefinitions = getMcpInstallTargetDefinitions().filter((target) => uniqueTargetIds.includes(target.id));

  for (const targetDefinition of targetDefinitions) {
    await writeLetAgentsMcpServerForTarget(targetDefinition);
  }

  const now = new Date().toISOString();
  const storedSetup = await readStoredMcpSetup();
  const installs = { ...storedSetup.installs };
  for (const targetId of uniqueTargetIds) {
    installs[targetId] = { lastInstalledAt: now };
  }

  await writeStoredMcpSetup({
    completed: storedSetup.completed,
    completedAt: storedSetup.completedAt,
    selectedTargetId: uniqueTargetIds[0] || storedSetup.selectedTargetId,
    installs,
  });

  const installState = await buildMcpInstallState();
  const targets = installState.targets.filter((candidate) => uniqueTargetIds.includes(candidate.id));
  const targetNames = targets.map((target) => target.name).join(", ");

  return {
    success: true,
    targets,
    installState,
    message: `LetAgents was added to ${targetNames}. Restart or reload those apps so the MCP connection is available.`,
  };
}

async function installLetAgentsMcpServer(targetId: DesktopMcpInstallTargetId): Promise<DesktopMcpInstallResult> {
  const targetDefinition = getMcpInstallTargetDefinitions().find((target) => target.id === targetId);
  if (!targetDefinition) {
    throw new Error(`Unknown MCP install target: ${targetId}`);
  }

  const result = await installLetAgentsMcpServers([targetId]);
  const installState = result.installState;
  const target = installState.targets.find((candidate) => candidate.id === targetId);
  if (!target) {
    throw new Error(`Installed target disappeared: ${targetId}`);
  }

  return {
    success: true,
    target,
    installState,
    message: `LetAgents was added to ${target.name}. ${target.restartHint}`,
  };
}

async function completeMcpOnboarding(): Promise<DesktopMcpInstallState> {
  const current = await readStoredMcpSetup();
  await writeStoredMcpSetup({
    ...current,
    completed: true,
    completedAt: current.completedAt || new Date().toISOString(),
  });
  return buildMcpInstallState();
}

function getAuthStorePath(): string {
  return join(app.getPath("userData"), "letagents-desktop-auth.json");
}

function normalizeAuthAccount(account: DeviceAuthPollResponse["account"] | null | undefined): DesktopAuthAccount | null {
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
  if (!safeStorage.isEncryptionAvailable()) {
    return `plain:${token}`;
  }
  return `safe:${safeStorage.encryptString(token).toString("base64")}`;
}

function decryptTokenFromStorage(parsed: Partial<PersistedDesktopAuth>): string | null {
  const encryptedToken = parsed.encryptedToken || null;
  if (!encryptedToken) return parsed.token || null;

  if (encryptedToken.startsWith("plain:")) {
    return encryptedToken.slice("plain:".length) || null;
  }

  if (!encryptedToken.startsWith("safe:") || !safeStorage.isEncryptionAvailable()) {
    return null;
  }

  try {
    return safeStorage.decryptString(Buffer.from(encryptedToken.slice("safe:".length), "base64"));
  } catch {
    return null;
  }
}

async function readStoredAuth(): Promise<StoredDesktopAuth> {
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
  await writeFile(getAuthStorePath(), `${JSON.stringify(persistedAuth, null, 2)}\n`, "utf8");
}

async function updateStoredAuth(update: Partial<StoredDesktopAuth>): Promise<StoredDesktopAuth> {
  const current = await readStoredAuth();
  const nextAuth: StoredDesktopAuth = {
    ...current,
    ...update,
    savedAt: new Date().toISOString(),
  };
  await writeStoredAuth(nextAuth);
  return nextAuth;
}

async function clearStoredAuth(): Promise<void> {
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

async function getDesktopAuthStatus(): Promise<DesktopAuthStatus> {
  const storedAuth = await readStoredAuth();
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
      await updateStoredAuth({ account });
      return buildAuthStatus({ storedAuth: await readStoredAuth(), account });
    }

    await updateStoredAuth({ token: null, ownerTokenId: null, oauthTokenExpiresAt: null, account: null });
    return buildAuthStatus({
      storedAuth: await readStoredAuth(),
      error: "Your saved sign-in expired. Connect again to open private rooms.",
    });
  } catch (error) {
    return buildAuthStatus({
      storedAuth,
      error: error instanceof Error ? error.message : "Could not check sign-in right now.",
    });
  }
}

function createRoomAccess(input: Partial<DesktopRoomAccess>): DesktopRoomAccess {
  return {
    status: input.status || "ready",
    title: input.title || "Room ready",
    message: input.message || "",
    roomIdentifier: input.roomIdentifier || null,
    deviceFlowUrl: input.deviceFlowUrl || null,
    code: input.code || null,
    httpStatus: input.httpStatus || null,
  };
}

function mapDesktopRoomInfoPayload(requestedRoomIdentifier: string, payload: RoomInfoPayload): DesktopRoomInfo {
  const canonicalIdentifier = payload.room_id || requestedRoomIdentifier;
  return {
    identifier: canonicalIdentifier,
    code: payload.code || "",
    name: payload.name || canonicalIdentifier,
    displayName: payload.display_name || payload.name || canonicalIdentifier,
    role: payload.role || "participant",
    authenticated: Boolean(payload.authenticated),
    kind: payload.kind || "main",
    parentRoomId: payload.parent_room_id || null,
    focusKey: payload.focus_key || null,
    sourceTaskId: payload.source_task_id || null,
    focusStatus: payload.focus_status || null,
  };
}

async function parseApiErrorPayload(response: Response): Promise<ApiErrorPayload | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as ApiErrorPayload;
  } catch {
    return null;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new DesktopApiError(response.status, await parseApiErrorPayload(response));
  }

  return (await response.json()) as T;
}

function emitRoomStreamEvent(event: DesktopRoomStreamEvent): void {
  if (mainWindow?.isDestroyed()) return;
  mainWindow?.webContents.send("desktop:room:stream-event", event);
}

async function fetchRoomSnapshot(requestedRoomIdentifier?: string | null): Promise<DesktopRoomSnapshot> {
  const roomIdentifier = requestedRoomIdentifier?.trim() || await resolveRoomIdentifier();
  if (!roomIdentifier) {
    return {
      roomIdentifier: null,
      access: createRoomAccess({
        status: "missing_room",
        title: "Choose a room to begin",
        message: "LetAgents could not find a room from this folder yet. Create or join a room to continue.",
      }),
      room: null,
      focusRooms: [],
      tasks: [],
      participants: [],
      presence: [],
      reasoningSessions: [],
      recentActivity: [],
      messages: [],
    };
  }

  try {
    const joined = await apiFetch<RoomInfoPayload>(`/rooms/${encodeURIComponent(roomIdentifier)}/join`, {
      method: "POST",
    });

    const [focusRoomsData, tasksData, participantsData, presenceData, reasoningData, activityHistoryData, messagesData] = await Promise.all([
      apiFetch<{ focus_rooms?: Array<{
        room_id: string;
        name: string | null;
        display_name: string;
        code: string | null;
        source_task_id: string | null;
        focus_status: "active" | "concluded" | null;
        created_at: string;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/focus-rooms`).catch(() => ({ focus_rooms: [] })),
      apiFetch<{ tasks?: Array<{
        id: string;
        title: string;
        status: string;
        assignee: string | null;
        created_by?: string | null;
        pr_url?: string | null;
        workflow_refs?: Array<{
          provider?: string;
          kind?: string;
          label?: string;
          url?: string;
        }> | null;
        active_leases?: Array<{
          id?: string;
          kind?: string;
          holder_label?: string | null;
          agent_label?: string | null;
          agent_key?: string | null;
          agent_session_id?: string | null;
          status?: string;
          updated_at?: string | null;
        }>;
        updated_at: string;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/tasks`).catch(() => ({ tasks: [] })),
      apiFetch<{ participants?: Array<{
        participant_key: string;
        kind: "human" | "agent";
        display_name: string;
        actor_label: string | null;
        agent_key?: string | null;
        github_login?: string | null;
        owner_label?: string | null;
        ide_label?: string | null;
        hidden_at?: string | null;
        activity_state: "active" | "away" | "offline" | null;
        last_seen_at: string;
        last_room_activity_at?: string | null;
        last_live_heartbeat_at?: string | null;
        source_flags?: Array<"delivery" | "presence" | "messages" | "tasks">;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/participants`).catch(() => ({ participants: [] })),
      apiFetch<{ presence?: Array<{
        room_id: string;
        actor_label: string;
        agent_key: string | null;
        agent_instance_id: string | null;
        agent_session_id: string | null;
        session_kind: "controller" | "worker";
        runtime: string;
        display_name: string;
        owner_label: string | null;
        ide_label: string | null;
        status: "idle" | "working" | "reviewing" | "blocked";
        status_text: string | null;
        last_heartbeat_at: string;
        freshness: "active" | "stale";
        activity_state: "active" | "away" | "offline";
        source_flags?: Array<"delivery" | "presence" | "messages" | "tasks">;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/presence?limit=100`).catch(() => ({ presence: [] })),
      apiFetch<{ sessions?: Array<{
        id: string;
        room_id?: string | null;
        actor_label?: string | null;
        agent_key?: string | null;
        task_id?: string | null;
        title?: string | null;
        status?: string | null;
        summary?: string | null;
        latest_payload?: DesktopReasoningSession["latestPayload"];
        goal?: string | null;
        checking?: string | null;
        hypothesis?: string | null;
        blocker?: string | null;
        next_action?: string | null;
        milestone?: string | null;
        confidence?: number | null;
        closed_at?: string | null;
        created_at?: string | null;
        updated_at?: string | null;
      }>; reasoning_sessions?: Array<{
        id: string;
        room_id?: string | null;
        actor_label?: string | null;
        agent_key?: string | null;
        task_id?: string | null;
        title?: string | null;
        status?: string | null;
        summary?: string | null;
        latest_payload?: DesktopReasoningSession["latestPayload"];
        goal?: string | null;
        checking?: string | null;
        hypothesis?: string | null;
        blocker?: string | null;
        next_action?: string | null;
        milestone?: string | null;
        confidence?: number | null;
        closed_at?: string | null;
        created_at?: string | null;
        updated_at?: string | null;
      }>;
      }>(`/rooms/${encodeURIComponent(roomIdentifier)}/reasoning-sessions`).catch(() => ({ sessions: [], reasoning_sessions: [] })),
      apiFetch<{ entries?: Array<{
        id: string;
        room?: {
          id: string;
          display_name: string;
          kind: "main" | "focus";
          focus_status: "active" | "concluded" | null;
          source_task_id: string | null;
        };
        participant: {
          display_name: string;
          kind: "human" | "agent";
          actor_label?: string | null;
          owner_label?: string | null;
          ide_label?: string | null;
          activity_state: "active" | "away" | "offline" | null;
        };
        first_seen_at?: string | null;
        last_seen_at?: string | null;
        last_room_activity_at: string;
        current_tasks: Array<{ id: string; title: string; status: string; updated_at?: string | null; workflow_refs?: Array<{ provider: string; kind: string; label: string; url: string }> }>;
        completed_tasks: Array<{ id: string; title: string; status: string; updated_at?: string | null; workflow_refs?: Array<{ provider: string; kind: string; label: string; url: string }> }>;
        created_tasks?: Array<{ id: string; title: string; status: string; updated_at?: string | null; workflow_refs?: Array<{ provider: string; kind: string; label: string; url: string }> }>;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/activity-history?page_size=20`).catch(() => ({ entries: [] })),
      apiFetch<{ messages?: Array<{
        id: string;
        sender: string;
        text: string;
        attachments?: Parameters<typeof mapRoomMessageAttachmentPayload>[0][] | null;
        agent_prompt_kind?: string | null;
        source: string | null;
        timestamp: string;
        reply_to?: {
          id: string;
          sender: string;
          text: string;
          source?: string | null;
          timestamp: string;
        } | null;
        agent_identity?: {
          name?: string | null;
          display_name?: string | null;
          owner_label?: string | null;
          owner_attribution?: string | null;
          ide_label?: string | null;
          actor_label?: string | null;
        } | null;
      }> }>(`/rooms/${encodeURIComponent(roomIdentifier)}/messages?limit=${roomMessageHistoryPageSize}&before=latest`).catch(() => ({ messages: [] })),
    ]);

    const room = mapDesktopRoomInfoPayload(roomIdentifier, joined);

    const focusRooms: DesktopFocusRoomInfo[] = (focusRoomsData.focus_rooms || []).map((focusRoom) => ({
      roomId: focusRoom.room_id,
      identifier: focusRoom.room_id,
      displayName: focusRoom.display_name,
      code: focusRoom.code || null,
      sourceTaskId: focusRoom.source_task_id || null,
      focusStatus: focusRoom.focus_status || null,
      createdAt: focusRoom.created_at,
    }));

    const tasks: DesktopTaskSummary[] = (tasksData.tasks || []).map(mapDesktopTaskSummaryPayload);

    const participants: DesktopParticipantSummary[] = (participantsData.participants || []).map((participant) => ({
      participantKey: participant.participant_key,
      kind: participant.kind,
      displayName: participant.display_name,
      actorLabel: participant.actor_label || null,
      agentKey: participant.agent_key || null,
      githubLogin: participant.github_login || null,
      ownerLabel: participant.owner_label || null,
      ideLabel: participant.ide_label || null,
      hiddenAt: participant.hidden_at || null,
      activityState: participant.activity_state || null,
      lastSeenAt: participant.last_seen_at,
      lastRoomActivityAt: participant.last_room_activity_at || null,
      lastLiveHeartbeatAt: participant.last_live_heartbeat_at || null,
      sourceFlags: participant.source_flags || [],
    }));

    const presence: DesktopAgentPresence[] = (presenceData.presence || []).map((entry) => ({
      roomId: entry.room_id,
      actorLabel: entry.actor_label,
      agentKey: entry.agent_key || null,
      agentInstanceId: entry.agent_instance_id || null,
      agentSessionId: entry.agent_session_id || null,
      sessionKind: entry.session_kind,
      runtime: entry.runtime,
      displayName: entry.display_name,
      ownerLabel: entry.owner_label || null,
      ideLabel: entry.ide_label || null,
      status: entry.status,
      statusText: entry.status_text || null,
      lastHeartbeatAt: entry.last_heartbeat_at,
      freshness: entry.freshness,
      activityState: entry.activity_state,
      sourceFlags: entry.source_flags || [],
    }));

    const reasoningSessions: DesktopReasoningSession[] = [
      ...(reasoningData.sessions || reasoningData.reasoning_sessions || []),
    ].map((session) => ({
      id: session.id,
      roomId: session.room_id || null,
      actorLabel: session.actor_label || null,
      agentKey: session.agent_key || null,
      taskId: session.task_id || null,
      title: session.title || null,
      status: session.status || null,
      summary: session.summary || null,
      latestPayload: session.latest_payload || null,
      goal: session.goal || null,
      checking: session.checking || null,
      hypothesis: session.hypothesis || null,
      blocker: session.blocker || null,
      nextAction: session.next_action || null,
      milestone: session.milestone || null,
      confidence: session.confidence ?? null,
      closedAt: session.closed_at || null,
      createdAt: session.created_at || null,
      updatedAt: session.updated_at || null,
    })).sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
      const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
      return (Number.isFinite(rightTime) ? rightTime : -1) - (Number.isFinite(leftTime) ? leftTime : -1);
    });

    const mapActivityTask = (task: {
      id: string;
      title: string;
      status: string;
      updated_at?: string | null;
      workflow_refs?: Array<{ provider: string; kind: string; label: string; url: string }>;
    }) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      updatedAt: task.updated_at || null,
      workflowRefs: (task.workflow_refs || []).map((ref) => ({
        provider: ref.provider,
        kind: ref.kind,
        label: ref.label,
        url: ref.url,
      })),
    });

    const recentActivity: DesktopActivityEntry[] = (activityHistoryData.entries || []).map((entry) => ({
      id: entry.id,
      room: entry.room
        ? {
            id: entry.room.id,
            displayName: entry.room.display_name,
            kind: entry.room.kind,
            focusStatus: entry.room.focus_status,
            sourceTaskId: entry.room.source_task_id,
          }
        : null,
      participantDisplayName: entry.participant.display_name,
      participantKind: entry.participant.kind,
      participantActorLabel: entry.participant.actor_label || null,
      participantOwnerLabel: entry.participant.owner_label || null,
      participantIdeLabel: entry.participant.ide_label || null,
      activityState: entry.participant.activity_state || null,
      firstSeenAt: entry.first_seen_at || null,
      lastSeenAt: entry.last_seen_at || null,
      lastRoomActivityAt: entry.last_room_activity_at,
      currentTasks: (entry.current_tasks || []).map(mapActivityTask),
      completedTasks: (entry.completed_tasks || []).map(mapActivityTask),
      createdTasks: (entry.created_tasks || []).map(mapActivityTask),
    }));

    const messages: DesktopRoomMessage[] = [...(messagesData.messages || [])]
      .sort((left, right) => {
        const leftTime = Date.parse(left.timestamp || "");
        const rightTime = Date.parse(right.timestamp || "");
        return leftTime - rightTime;
      })
      .map((message) => ({
        id: message.id,
        sender: message.sender,
        text: message.text,
        attachments: (message.attachments || []).map(mapRoomMessageAttachmentPayload),
        agentPromptKind: message.agent_prompt_kind || null,
        source: message.source || null,
        timestamp: message.timestamp,
        actorLabel: message.agent_identity?.actor_label || null,
        agentIdentity: mapRoomMessageAgentIdentity(message.agent_identity || null),
        replyTo: message.reply_to
          ? {
              id: message.reply_to.id,
              sender: message.reply_to.sender,
              text: message.reply_to.text,
              source: message.reply_to.source || null,
              timestamp: message.reply_to.timestamp,
            }
          : null,
      }));

    return {
      roomIdentifier,
      access: createRoomAccess({
        status: "ready",
        roomIdentifier,
      }),
      room,
      focusRooms,
      tasks,
      participants,
      presence,
      reasoningSessions,
      recentActivity,
      messages,
    };
  } catch (error) {
    if (error instanceof DesktopApiError) {
      const payload = error.payload;
      const accessStatus = payload?.error === "auth_required"
        ? "auth_required"
        : payload?.error === "private_repo_no_access"
          ? "forbidden"
          : "unavailable";

      return {
        roomIdentifier,
        access: createRoomAccess({
          status: accessStatus,
          title: accessStatus === "auth_required"
            ? "Connect GitHub to open this room"
            : accessStatus === "forbidden"
              ? "This account cannot open the room"
              : "Room unavailable",
          message: payload?.message || error.message,
          roomIdentifier: payload?.room_id || roomIdentifier,
          deviceFlowUrl: payload?.device_flow_url || null,
          code: payload?.code || null,
          httpStatus: error.status,
        }),
        room: null,
        focusRooms: [],
        tasks: [],
        participants: [],
        presence: [],
        reasoningSessions: [],
        recentActivity: [],
        messages: [],
      };
    }

    return {
      roomIdentifier,
      access: createRoomAccess({
        status: "unavailable",
        title: "Room unavailable",
        message: error instanceof Error ? error.message : "LetAgents could not load this room.",
        roomIdentifier,
      }),
      room: null,
      focusRooms: [],
      tasks: [],
      participants: [],
      presence: [],
      reasoningSessions: [],
      recentActivity: [],
      messages: [],
    };
  }
}

function mapRoomMessagePayload(message: {
  id: string;
  sender: string;
  text: string;
  attachments?: Array<{
    id?: string | null;
    name?: string | null;
    file_name?: string | null;
    filename?: string | null;
    mime_type?: string | null;
    content_type?: string | null;
    size_bytes?: number | null;
    byte_size?: number | null;
    url?: string | null;
    download_url?: string | null;
    data_url?: string | null;
    content_base64?: string | null;
  }> | null;
  agent_prompt_kind?: string | null;
  source?: string | null;
  timestamp: string;
  reply_to?: {
    id: string;
    sender: string;
    text: string;
    source?: string | null;
    timestamp: string;
  } | null;
  agent_identity?: {
    name?: string | null;
    display_name?: string | null;
    owner_label?: string | null;
    owner_attribution?: string | null;
    ide_label?: string | null;
    actor_label?: string | null;
  } | null;
}): DesktopRoomMessage {
  return {
    id: message.id,
    sender: message.sender,
    text: message.text,
    attachments: (message.attachments || []).map(mapRoomMessageAttachmentPayload),
    agentPromptKind: message.agent_prompt_kind || null,
    source: message.source || null,
    timestamp: message.timestamp,
    actorLabel: message.agent_identity?.actor_label || null,
    agentIdentity: mapRoomMessageAgentIdentity(message.agent_identity || null),
    replyTo: message.reply_to
      ? {
          id: message.reply_to.id,
          sender: message.reply_to.sender,
          text: message.reply_to.text,
          source: message.reply_to.source || null,
          timestamp: message.reply_to.timestamp,
        }
      : null,
  };
}

function mapRoomMessageAttachmentPayload(attachment: {
  id?: string | null;
  name?: string | null;
  file_name?: string | null;
  filename?: string | null;
  mime_type?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  byte_size?: number | null;
  url?: string | null;
  download_url?: string | null;
  data_url?: string | null;
  content_base64?: string | null;
}): DesktopRoomMessage["attachments"][number] {
  const rawUrl = attachment.url || null;
  const rawDownloadUrl = attachment.download_url || null;
  return {
    id: attachment.id || null,
    name: attachment.name || null,
    fileName: attachment.file_name || attachment.filename || null,
    mimeType: attachment.mime_type || attachment.content_type || null,
    sizeBytes: attachment.size_bytes ?? attachment.byte_size ?? null,
    url: rawUrl ? proxiedAttachmentUrl(rawUrl) : null,
    downloadUrl: rawDownloadUrl ? proxiedAttachmentUrl(rawDownloadUrl) : null,
    dataUrl: attachment.data_url || null,
    contentBase64: attachment.content_base64 || null,
  };
}

function proxiedAttachmentUrl(rawUrl: string): string {
  if (!shouldProxyAttachmentUrl(rawUrl)) return rawUrl;
  const encoded = Buffer.from(rawUrl, "utf8").toString("base64url");
  return `${attachmentProtocolScheme}://download/${encoded}`;
}

function shouldProxyAttachmentUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  try {
    const target = new URL(trimmed);
    return target.origin === new URL(apiUrl).origin;
  } catch {
    return false;
  }
}

function resolveAttachmentProxyTarget(rawUrl: string): URL {
  const apiOrigin = new URL(apiUrl).origin;
  const target = rawUrl.startsWith("/")
    ? new URL(rawUrl, apiOrigin)
    : new URL(rawUrl);
  if (target.origin !== apiOrigin) {
    throw new Error("Attachment proxy target is outside LetAgents API.");
  }
  return target;
}

async function handleAttachmentProtocolRequest(request: Request): Promise<Response> {
  try {
    const requestUrl = new URL(request.url);
    const encodedTarget = requestUrl.pathname.replace(/^\/+/, "");
    if (!encodedTarget) {
      return new Response("Missing attachment target.", { status: 400 });
    }

    const rawTarget = Buffer.from(encodedTarget, "base64url").toString("utf8");
    const target = resolveAttachmentProxyTarget(rawTarget);
    const storedAuth = await readStoredAuth();
    const headers = new Headers();
    if (storedAuth.token) {
      headers.set("Authorization", `Bearer ${storedAuth.token}`);
    }

    const response = await fetch(target, { headers });
    return response;
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Attachment unavailable.", { status: 502 });
  }
}

function mapRoomMessageAgentIdentity(identity: {
  name?: string | null;
  display_name?: string | null;
  owner_label?: string | null;
  owner_attribution?: string | null;
  ide_label?: string | null;
  actor_label?: string | null;
} | null): DesktopRoomMessage["agentIdentity"] {
  if (!identity) return null;
  return {
    name: identity.name || null,
    displayName: identity.display_name || null,
    ownerLabel: identity.owner_label || null,
    ownerAttribution: identity.owner_attribution || null,
    ideLabel: identity.ide_label || null,
    actorLabel: identity.actor_label || null,
  };
}

function mapDesktopTaskSummaryPayload(task: {
  id: string;
  title?: string;
  status?: string;
  assignee?: string | null;
  created_by?: string | null;
  pr_url?: string | null;
  workflow_refs?: Array<{
    provider?: string;
    kind?: string;
    label?: string;
    url?: string;
  }> | null;
  active_leases?: Array<{
    id?: string;
    kind?: string;
    holder_label?: string | null;
    agent_label?: string | null;
    agent_key?: string | null;
    agent_session_id?: string | null;
    status?: string;
    updated_at?: string | null;
  }> | null;
  updated_at?: string;
  updatedAt?: string;
}): DesktopTaskSummary {
  return {
    id: task.id,
    title: task.title || task.id,
    status: task.status || "proposed",
    assignee: task.assignee || null,
    createdBy: task.created_by || null,
    prUrl: task.pr_url || null,
    workflowRefs: (task.workflow_refs || [])
      .map((ref) => ({
        provider: ref.provider || "unknown",
        kind: ref.kind || "artifact",
        label: ref.label || ref.url || "Workflow",
        url: ref.url || "",
      }))
      .filter((ref) => Boolean(ref.url)),
    activeLeases: (task.active_leases || []).map((lease) => ({
      id: lease.id || "",
      kind: lease.kind || "work",
      holderLabel: lease.holder_label || lease.agent_label || null,
      agentKey: lease.agent_key || null,
      agentSessionId: lease.agent_session_id || null,
      status: lease.status || "active",
      updatedAt: lease.updated_at || null,
    })).filter((lease) => Boolean(lease.id)),
    updatedAt: task.updated_at || task.updatedAt || new Date().toISOString(),
  };
}

async function sendDesktopRoomMessage(
  roomIdentifier: string,
  text: string,
  replyTo?: string | null,
  attachments: Array<{ upload_id: string }> = []
): Promise<DesktopSendRoomMessageResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedText = text.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before sending a message.");
  }
  if (!trimmedText && attachments.length === 0) {
    throw new Error("Write a message before sending.");
  }

  const storedAuth = await readStoredAuth();
  const sender = storedAuth.account?.displayName || storedAuth.account?.login || "Desktop";
  const message = await apiFetch<{
    id: string;
    sender: string;
    text: string;
    attachments?: Parameters<typeof mapRoomMessageAttachmentPayload>[0][] | null;
    agent_prompt_kind?: string | null;
    source?: string | null;
    timestamp: string;
    reply_to?: {
      id: string;
      sender: string;
      text: string;
      source?: string | null;
      timestamp: string;
    } | null;
    agent_identity?: {
      name?: string | null;
      display_name?: string | null;
      owner_label?: string | null;
      owner_attribution?: string | null;
      ide_label?: string | null;
      actor_label?: string | null;
    } | null;
  }>(`/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LetAgents-Desktop-Client": "1",
    },
    body: JSON.stringify({
      sender,
      text: trimmedText,
      reply_to: replyTo || null,
      attachments,
    }),
  });

  return {
    message: mapRoomMessagePayload(message),
  };
}

async function pickAndStageDesktopAttachments(roomIdentifier: string): Promise<DesktopStagedAttachment[]> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before attaching files.");
  }

  mainWindow?.show();
  mainWindow?.focus();
  const result = await dialog.showOpenDialog({
    title: "Attach files",
    buttonLabel: "Attach",
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled || result.filePaths.length === 0) return [];

  const staged: DesktopStagedAttachment[] = [];
  for (const filePath of result.filePaths) {
    staged.push(await stageDesktopAttachmentFile(trimmedRoomIdentifier, filePath));
  }
  return staged;
}

async function stageDroppedDesktopAttachmentContents(
  roomIdentifier: string,
  files: DesktopDroppedAttachmentContent[]
): Promise<DesktopStagedAttachment[]> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before attaching files.");
  }

  const droppedFiles = files
    .map((file) => ({
      fileName: file.fileName?.trim() || "attachment",
      mimeType: file.mimeType?.trim() || guessMimeType(file.fileName || "attachment"),
      sizeBytes: file.sizeBytes,
      contentBase64: file.contentBase64,
    }))
    .filter((file) => file.contentBase64);
  if (droppedFiles.length === 0) return [];

  const staged: DesktopStagedAttachment[] = [];
  for (const file of droppedFiles) {
    const fileBuffer = Buffer.from(file.contentBase64, "base64");
    staged.push(await stageDesktopAttachmentBuffer(trimmedRoomIdentifier, fileBuffer, file.fileName, file.mimeType || guessMimeType(file.fileName)));
  }
  return staged;
}

async function stageDesktopAttachmentFile(
  roomIdentifier: string,
  filePath: string,
  displayFileName?: string
): Promise<DesktopStagedAttachment> {
  const fileBuffer = await readFile(filePath);
  const fileName = displayFileName || basename(filePath);
  const mimeType = guessMimeType(fileName);
  return stageDesktopAttachmentBuffer(roomIdentifier, fileBuffer, fileName, mimeType);
}

async function stageDesktopAttachmentBuffer(
  roomIdentifier: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<DesktopStagedAttachment> {
  const target = await apiFetch<{
    upload_id?: string;
    upload_url?: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    attachment?: { upload_id?: string };
  }>(`/rooms/${encodeURIComponent(roomIdentifier)}/attachments/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: fileBuffer.byteLength,
    }),
  });

  const uploadId = target.upload_id || target.attachment?.upload_id;
  const uploadUrl = target.upload_url || target.url;
  if (!uploadId || !uploadUrl) {
    throw new Error(`${fileName} could not be staged.`);
  }

  const uploadHeaders = new Headers(target.headers || {});
  if (![...uploadHeaders.keys()].some((key) => key.toLowerCase() === "content-type")) {
    uploadHeaders.set("Content-Type", mimeType);
  }
  const uploadBody = new Uint8Array(fileBuffer).buffer;
  const uploadResponse = await fetch(uploadUrl, {
    method: target.method || "PUT",
    headers: uploadHeaders,
    body: uploadBody,
  });
  if (!uploadResponse.ok) {
    await discardDesktopAttachment(roomIdentifier, uploadId).catch(() => undefined);
    throw new Error(`${fileName} upload failed with HTTP ${uploadResponse.status}.`);
  }

  return {
    uploadId,
    fileName,
    mimeType,
    sizeBytes: fileBuffer.byteLength,
    previewDataUrl: mimeType.startsWith("image/")
      ? `data:${mimeType};base64,${fileBuffer.toString("base64")}`
      : null,
  };
}

async function discardDesktopAttachment(roomIdentifier: string, uploadId: string): Promise<void> {
  if (!roomIdentifier.trim() || !uploadId.trim()) return;
  await apiFetch(`/rooms/${encodeURIComponent(roomIdentifier.trim())}/attachments/uploads/${encodeURIComponent(uploadId.trim())}`, {
    method: "DELETE",
  });
}

function guessMimeType(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    gif: "image/gif",
    heic: "image/heic",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    pdf: "application/pdf",
    png: "image/png",
    txt: "text/plain",
    webp: "image/webp",
  };
  return extension ? map[extension] || "application/octet-stream" : "application/octet-stream";
}

async function getDesktopRoomMessagesBefore(
  roomIdentifier: string,
  beforeMessageId: string,
  limit = roomMessageHistoryPageSize
): Promise<DesktopRoomMessagesPage> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedBeforeMessageId = beforeMessageId.trim();
  if (!trimmedRoomIdentifier || !trimmedBeforeMessageId) {
    return { messages: [], hasOlder: false };
  }

  const page = await apiFetch<{
    messages?: Parameters<typeof mapRoomMessagePayload>[0][];
    has_older?: boolean;
    has_more?: boolean;
  }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/messages?limit=${encodeURIComponent(String(limit))}&before=${encodeURIComponent(trimmedBeforeMessageId)}`
  );

  return {
    messages: [...(page.messages || [])]
      .sort((left, right) => Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""))
      .map(mapRoomMessagePayload),
    hasOlder: Boolean(page.has_older ?? page.has_more),
  };
}

function mapRoomStreamTaskPayload(task: {
  id?: string;
  title?: string;
  status?: string;
  assignee?: string | null;
  created_by?: string | null;
  pr_url?: string | null;
  workflow_refs?: Parameters<typeof mapDesktopTaskSummaryPayload>[0]["workflow_refs"];
  active_leases?: Parameters<typeof mapDesktopTaskSummaryPayload>[0]["active_leases"];
  updated_at?: string;
  updatedAt?: string;
}): DesktopTaskSummary | null {
  if (!task.id) return null;
  return mapDesktopTaskSummaryPayload({ ...task, id: task.id });
}

function handleRoomStreamFrame(roomIdentifier: string, eventName: string, data: string): void {
  if (!data.trim()) return;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }

  const eventRoomIdentifier = typeof payload.room_id === "string" ? payload.room_id : roomIdentifier;
  if (eventName === "task_update") {
    const task = mapRoomStreamTaskPayload(payload);
    if (task) {
      emitRoomStreamEvent({ type: "task_update", roomIdentifier: eventRoomIdentifier, task });
    }
    return;
  }

  if (eventName === "session_disconnect") {
    emitRoomStreamEvent({ type: "session_disconnect", roomIdentifier: eventRoomIdentifier, message: "Room stream disconnected." });
    return;
  }

  if (eventName === "message") {
    if (activeRoomStream?.roomIdentifier === roomIdentifier && typeof payload.id === "string") {
      activeRoomStream.lastMessageId = payload.id;
    }
    emitRoomStreamEvent({
      type: "message",
      roomIdentifier: eventRoomIdentifier,
      message: mapRoomMessagePayload(payload as Parameters<typeof mapRoomMessagePayload>[0]),
    });
  }
}

async function pollDesktopRoomMessages(stream: NonNullable<typeof activeRoomStream>): Promise<void> {
  while (!stream.stopped) {
    const after = stream.lastMessageId;
    if (!after) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }

    const pollAbortController = new AbortController();
    stream.pollAbortController = pollAbortController;
    try {
      const storedAuth = await readStoredAuth();
      const requestHeaders = new Headers({
        Accept: "application/json",
        "X-LetAgents-Desktop-Client": "1",
      });
      if (storedAuth.token) {
        requestHeaders.set("Authorization", `Bearer ${storedAuth.token}`);
      }
      const response = await fetch(
        `${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages/poll?limit=${roomMessageHistoryPageSize}&timeout=25000&after=${encodeURIComponent(after)}`,
        { headers: requestHeaders, signal: pollAbortController.signal },
      );
      if (!response.ok) {
        throw new Error(`Room poll failed with HTTP ${response.status}.`);
      }
      const page = await response.json() as { room_id?: string; messages?: Parameters<typeof mapRoomMessagePayload>[0][] };
      for (const rawMessage of page.messages || []) {
        if (typeof rawMessage.id === "string") {
          stream.lastMessageId = rawMessage.id;
        }
        emitRoomStreamEvent({
          type: "message",
          roomIdentifier: page.room_id || stream.roomIdentifier,
          message: mapRoomMessagePayload(rawMessage),
        });
      }
    } catch (error) {
      if (stream.stopped || pollAbortController.signal.aborted) return;
      emitRoomStreamEvent({
        type: "error",
        roomIdentifier: stream.roomIdentifier,
        message: error instanceof Error ? error.message : "Room polling disconnected.",
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
    } finally {
      if (stream.pollAbortController === pollAbortController) {
        stream.pollAbortController = null;
      }
    }
  }
}

function parseRoomStreamChunk(roomIdentifier: string, chunk: string): string {
  const frames = chunk.split(/\n\n/);
  const remainder = frames.pop() || "";

  for (const frame of frames) {
    const lines = frame.split(/\r?\n/);
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    handleRoomStreamFrame(roomIdentifier, eventName, dataLines.join("\n"));
  }

  return remainder;
}

async function openDesktopRoomStream(stream: NonNullable<typeof activeRoomStream>): Promise<void> {
  const storedAuth = await readStoredAuth();
  const requestHeaders = new Headers({
    Accept: "text/event-stream",
    "X-LetAgents-Desktop-Client": "1",
  });
  if (storedAuth.token) {
    requestHeaders.set("Authorization", `Bearer ${storedAuth.token}`);
  }

  try {
    const response = await fetch(`${apiUrl}/rooms/${encodeURIComponent(stream.roomIdentifier)}/messages/stream`, {
      headers: requestHeaders,
      signal: stream.abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Room stream failed with HTTP ${response.status}.`);
    }

    stream.retryMs = 1000;
    emitRoomStreamEvent({ type: "open", roomIdentifier: stream.roomIdentifier });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!stream.stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = parseRoomStreamChunk(stream.roomIdentifier, buffer + decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (stream.stopped || stream.abortController.signal.aborted) return;
    emitRoomStreamEvent({
      type: "error",
      roomIdentifier: stream.roomIdentifier,
      message: error instanceof Error ? error.message : "Room stream disconnected.",
    });
  }

  if (!stream.stopped) {
    const retryMs = Math.min(stream.retryMs, 30_000);
    stream.retryMs = Math.min(stream.retryMs * 2, 30_000);
    stream.reconnectTimer = setTimeout(() => {
      stream.reconnectTimer = null;
      void openDesktopRoomStream(stream);
    }, retryMs);
  }
}

async function startDesktopRoomStream(roomIdentifier: string, afterMessageId?: string | null): Promise<void> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before opening the live stream.");
  }

  if (activeRoomStream?.roomIdentifier === trimmedRoomIdentifier && !activeRoomStream.stopped) {
    if (afterMessageId) {
      activeRoomStream.lastMessageId = afterMessageId;
    }
    return;
  }

  await stopDesktopRoomStream();
  activeRoomStream = {
    roomIdentifier: trimmedRoomIdentifier,
    abortController: new AbortController(),
    reconnectTimer: null,
    pollAbortController: null,
    retryMs: 1000,
    lastMessageId: afterMessageId || null,
    stopped: false,
  };
  void openDesktopRoomStream(activeRoomStream);
  void pollDesktopRoomMessages(activeRoomStream);
}

async function stopDesktopRoomStream(roomIdentifier?: string | null): Promise<void> {
  if (!activeRoomStream) return;
  if (roomIdentifier && activeRoomStream.roomIdentifier !== roomIdentifier.trim()) return;

  activeRoomStream.stopped = true;
  activeRoomStream.abortController.abort();
  activeRoomStream.pollAbortController?.abort();
  if (activeRoomStream.reconnectTimer) {
    clearTimeout(activeRoomStream.reconnectTimer);
  }
  activeRoomStream = null;
}

async function pickRepoRoom(): Promise<DesktopRepoRoomSelection> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a repository",
    buttonLabel: "Open",
    properties: ["openDirectory"],
  };
  mainWindow?.show();
  mainWindow?.focus();
  const result = await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return {
      canceled: true,
      repoPath: null,
      roomIdentifier: null,
      source: null,
      snapshot: null,
      error: null,
      warning: null,
    };
  }

  const selectedPath = result.filePaths[0];
  const resolved = await resolveRoomIdentifierFromPath(selectedPath);
  return {
    canceled: false,
    repoPath: resolved.repoRoot || selectedPath,
    roomIdentifier: resolved.roomIdentifier,
    source: resolved.source,
    snapshot: await fetchRoomSnapshot(resolved.roomIdentifier),
    error: null,
    warning: resolved.warning,
  };
}

async function renameDesktopRoom(roomIdentifier: string, displayName: string): Promise<DesktopRoomInfo> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedDisplayName = displayName.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before renaming it.");
  }
  if (!trimmedDisplayName) {
    throw new Error("Enter a room name.");
  }

  const updated = await apiFetch<RoomInfoPayload>(`/rooms/${encodeURIComponent(trimmedRoomIdentifier)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: trimmedDisplayName }),
  });
  return mapDesktopRoomInfoPayload(trimmedRoomIdentifier, updated);
}

async function getDesktopGitHubIntegrationStatus(roomIdentifier: string): Promise<DesktopGitHubIntegrationStatus> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before checking GitHub.");
  }

  const status = await apiFetch<{
    room_id?: string;
    access_room_id?: string | null;
    configured?: boolean;
    setup_manifest_available?: boolean;
    connected?: boolean;
    install_url_available?: boolean;
    repository?: { full_name?: string } | null;
  }>(`/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/integrations/github`);

  return {
    roomId: status.room_id || trimmedRoomIdentifier,
    accessRoomId: status.access_room_id || null,
    configured: Boolean(status.configured),
    setupManifestAvailable: Boolean(status.setup_manifest_available),
    connected: Boolean(status.connected),
    installUrlAvailable: Boolean(status.install_url_available),
    repository: status.repository?.full_name ? { fullName: status.repository.full_name } : null,
  };
}

async function openDesktopGitHubInstall(roomIdentifier: string): Promise<DesktopGitHubIntegrationActionResult> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before opening GitHub.");
  }

  const payload = await apiFetch<{ install_url?: string }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/integrations/github/install-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }
  );
  if (!payload.install_url) {
    return { opened: false, message: "GitHub did not return an install URL." };
  }
  await shell.openExternal(payload.install_url);
  return { opened: true, message: "GitHub opened in your browser." };
}

async function startDeviceAuthFlow(roomIdentifier?: string | null): Promise<DesktopAuthStartResult> {
  const trimmedRoomIdentifier = roomIdentifier?.trim() || await resolveRoomIdentifier();
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

async function pollDeviceAuthFlow(requestId?: string | null): Promise<DesktopAuthPollResult> {
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
      `/auth/device/poll/${encodeURIComponent(pending.requestId)}`
    );

    if (response.status === "authorized") {
      const account = normalizeAuthAccount(response.account);
      if (!response.letagents_token || !account) {
        return {
          status: "unknown",
          intervalSeconds: null,
          expiresInSeconds: null,
          authStatus: buildAuthStatus({ storedAuth }),
          error: "GitHub approved the request, but LetAgents did not return a usable session.",
        };
      }

      const nextAuth = await updateStoredAuth({
        token: response.letagents_token,
        ownerTokenId: response.owner_token_id || null,
        oauthTokenExpiresAt: response.oauth_token_expires_at || null,
        account,
        pendingDeviceAuth: null,
      });
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
      const status = error.payload?.status === "denied" || error.status === 403
        ? "denied"
        : error.payload?.status === "expired" || error.status === 410 || error.status === 404
          ? "expired"
          : error.status === 429
            ? "slow_down"
            : "unknown";
      const pendingDeviceAuth = status === "denied" || status === "expired"
        ? null
        : {
            ...pending,
            intervalSeconds: error.payload?.interval || pending.intervalSeconds,
          };
      const nextAuth = await updateStoredAuth({ pendingDeviceAuth });
      return {
        status,
        intervalSeconds: pendingDeviceAuth?.intervalSeconds || error.payload?.interval || null,
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
      error: error instanceof Error ? error.message : "Could not check GitHub approval.",
    };
  }
}

function buildWorkerSnapshots(): WorkerSnapshot[] {
  return [];
}

function buildDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return {
    apiUrl,
    localMode: "disabled",
    notes: [
      "This desktop app is using the same LetAgents service as the web app.",
      "Local-only storage is not part of this first version yet.",
      "Starting and stopping agents from the app is still being wired up.",
    ],
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: "LetAgents Desktop",
    backgroundColor: "#0a0d14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload.js"),
    },
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  if (!existsSync(rendererDistPath)) {
    throw new Error(`Renderer build not found at ${rendererDistPath}`);
  }

  void mainWindow.loadFile(rendererDistPath);
}

ipcMain.handle("desktop:app:get-info", async (): Promise<DesktopAppInfo> => ({
  appName: "LetAgents Desktop",
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  workspaceRoot,
  apiUrl,
}));

ipcMain.handle(
  "desktop:room:get-snapshot",
  async (_event, roomIdentifier?: string | null): Promise<DesktopRoomSnapshot> => fetchRoomSnapshot(roomIdentifier)
);
ipcMain.handle(
  "desktop:room:get-messages-before",
  async (_event, roomIdentifier: string, beforeMessageId: string, limit?: number): Promise<DesktopRoomMessagesPage> =>
    getDesktopRoomMessagesBefore(roomIdentifier, beforeMessageId, limit)
);
ipcMain.handle(
  "desktop:room:pick-attachments",
  async (_event, roomIdentifier: string): Promise<DesktopStagedAttachment[]> => pickAndStageDesktopAttachments(roomIdentifier)
);
ipcMain.handle(
  "desktop:room:stage-dropped-attachment-contents",
  async (
    _event,
    roomIdentifier: string,
    files: DesktopDroppedAttachmentContent[]
  ): Promise<DesktopStagedAttachment[]> => stageDroppedDesktopAttachmentContents(roomIdentifier, files)
);
ipcMain.handle(
  "desktop:room:discard-attachment",
  async (_event, roomIdentifier: string, uploadId: string): Promise<void> => discardDesktopAttachment(roomIdentifier, uploadId)
);
ipcMain.handle(
  "desktop:room:start-stream",
  async (_event, roomIdentifier: string, afterMessageId?: string | null): Promise<void> =>
    startDesktopRoomStream(roomIdentifier, afterMessageId)
);
ipcMain.handle(
  "desktop:room:stop-stream",
  async (_event, roomIdentifier?: string | null): Promise<void> => stopDesktopRoomStream(roomIdentifier)
);
ipcMain.handle(
  "desktop:room:send-message",
  async (
    _event,
    roomIdentifier: string,
    text: string,
    replyTo?: string | null,
    attachments?: Array<{ upload_id: string }>
  ): Promise<DesktopSendRoomMessageResult> =>
    sendDesktopRoomMessage(roomIdentifier, text, replyTo, attachments ?? [])
);
ipcMain.handle(
  "desktop:room:rename",
  async (_event, roomIdentifier: string, displayName: string): Promise<DesktopRoomInfo> =>
    renameDesktopRoom(roomIdentifier, displayName)
);
ipcMain.handle(
  "desktop:room:get-github-integration-status",
  async (_event, roomIdentifier: string): Promise<DesktopGitHubIntegrationStatus> =>
    getDesktopGitHubIntegrationStatus(roomIdentifier)
);
ipcMain.handle(
  "desktop:room:open-github-install",
  async (_event, roomIdentifier: string): Promise<DesktopGitHubIntegrationActionResult> =>
    openDesktopGitHubInstall(roomIdentifier)
);
ipcMain.handle("desktop:auth:get-status", async (): Promise<DesktopAuthStatus> => getDesktopAuthStatus());
ipcMain.handle(
  "desktop:auth:start-device-flow",
  async (_event, roomIdentifier?: string | null): Promise<DesktopAuthStartResult> => startDeviceAuthFlow(roomIdentifier)
);
ipcMain.handle(
  "desktop:auth:poll-device-flow",
  async (_event, requestId?: string | null): Promise<DesktopAuthPollResult> => pollDeviceAuthFlow(requestId)
);
ipcMain.handle("desktop:auth:open-verification", async (_event, url: string): Promise<void> => {
  await shell.openExternal(url);
});
ipcMain.handle("desktop:auth:sign-out", async (): Promise<DesktopAuthStatus> => {
  await clearStoredAuth();
  return getDesktopAuthStatus();
});
ipcMain.handle("desktop:setup:get-mcp-install-state", async (): Promise<DesktopMcpInstallState> => {
  return buildMcpInstallState();
});
ipcMain.handle(
  "desktop:setup:install-mcp-server",
  async (_event, targetId: DesktopMcpInstallTargetId): Promise<DesktopMcpInstallResult> => {
    return installLetAgentsMcpServer(targetId);
  }
);
ipcMain.handle(
  "desktop:setup:install-mcp-servers",
  async (_event, targetIds: DesktopMcpInstallTargetId[]): Promise<DesktopMcpInstallManyResult> => {
    return installLetAgentsMcpServers(targetIds);
  }
);
ipcMain.handle("desktop:setup:complete-mcp-onboarding", async (): Promise<DesktopMcpInstallState> => {
  return completeMcpOnboarding();
});
ipcMain.handle("desktop:repos:get-status", async (): Promise<RepoStatus> => buildRepoStatus());
ipcMain.handle("desktop:repos:pick-room", async (): Promise<DesktopRepoRoomSelection> => pickRepoRoom());
ipcMain.handle("desktop:workers:list", async (): Promise<WorkerSnapshot[]> => buildWorkerSnapshots());
ipcMain.handle(
  "desktop:diagnostics:get-snapshot",
  async (): Promise<DiagnosticsSnapshot> => buildDiagnosticsSnapshot()
);

app.whenReady().then(() => {
  protocol.handle(attachmentProtocolScheme, handleAttachmentProtocolRequest);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  void stopDesktopRoomStream();
});

app.on("window-all-closed", () => {
  void stopDesktopRoomStream();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
