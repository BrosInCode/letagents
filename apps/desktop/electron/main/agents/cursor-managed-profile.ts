import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat as lstatAsync, opendir as opendirAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { getLetAgentsLocalStatePath } from "../paths.js";
import { LETAGENTS_NPX_ARGS } from "../mcp-config.js";
import type {
  DesktopCursorMcpPolicy,
  DesktopManagedAgentPermissionProfileId,
} from "../../ipc-types.js";
import type { LetAgentsMcpRuntime } from "./letagents-mcp-runtime.js";

export interface CursorManagedProfile {
  homeDir: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  env: Record<string, string>;
  mcpRuntimeEntryPath?: string;
  mcpRuntimeReadRoots?: string[];
  /** Credentialless base environment for a wrapper-hosted packaged MCP. */
  mcpRuntimeEnv?: Record<string, string>;
  /** Canonical credential-store roots needed only by live identity inspection. */
  authReadRoots?: string[];
  /** Unpredictable per-attempt alias that scopes Cursor's MCP allowlist. */
  mcpServerName?: string;
  /** Exact provider-authority files the native supervised process may not read. */
  nativeDeniedReadPaths?: string[];
  /** Provider-managed/plugin authority trees the native process may not traverse. */
  nativeDeniedReadSubpaths?: string[];
  /** Project authority roots whose metadata/traversal and replacement are denied. */
  nativeDeniedReadMetadataPaths?: string[];
  /** Generated authority paths denied for both native reads and writes. */
  nativeDeniedReadWriteRegexes?: string[];
  /** Git/provider authority patterns denied for native writes only. */
  nativeDeniedWriteRegexes?: string[];
  /** Private authority files Cursor must read but may never mutate. */
  nativeDeniedWritePaths?: string[];
  /** Stable directory entries that may contain writes but may not be unlinked/replaced. */
  nativeDeniedWriteStructuralPaths?: string[];
  /** Immutable packaged/runtime authority trees Cursor may read but not mutate. */
  nativeDeniedWriteSubpaths?: string[];
  /** Private/provider metadata trees that must never become executable launch roots. */
  nativeDeniedExecSubpaths?: string[];
  /** Attempt-private and attested workspace trees writable inside the global fence. */
  nativeAllowedWriteSubpaths?: string[];
  /** Repository/profile/runtime trees readable inside the global data-read fence. */
  nativeAllowedReadSubpaths?: string[];
}

export interface CursorManagedProfileOptions {
  sourceHomeDir?: string | null;
  homeDir?: string | null;
  workspaceRoot?: string | null;
  mcpPolicy?: DesktopCursorMcpPolicy | null;
}

export interface CursorSupervisedProfileOptions {
  workAttemptId: string;
  apiBaseUrl: string;
  workspaceRoot: string;
  /** Attested native authority; write profiles remain confined to this workspace. */
  permissionProfileId?: DesktopManagedAgentPermissionProfileId;
  sourceHomeDir?: string | null;
  /** Auth-only source refreshed by a just-completed live identity attestation. */
  authSourceHomeDir?: string | null;
  /** Disposable profile is awaiting a live identity proof; cached team metadata is non-authoritative. */
  identityAttestationOnly?: boolean;
  /** Exact personal identity returned by the fenced live GetMe attestation. */
  attestedPersonalIdentity?: CursorPersonalIdentity;
  /** Final inference profiles retain identity metadata but no login credentials. */
  exposeLoginCredentials?: boolean;
  /** Test-only/custom state root; production derives an owner-local stable path. */
  profileRoot?: string | null;
  /** Omit all provider login material for non-authoritative inspection profiles. */
  includeAuth?: boolean;
  /** Use a zero-tool local MCP probe only to enumerate Cursor's effective registry. */
  inspectionOnly?: boolean;
  /** Packaged absolute bridge used by every authority-bearing profile. */
  mcpRuntime?: LetAgentsMcpRuntime;
  /** Credentialless validation may use its empty disposable directory. */
  mcpWorkingDirectory?: string;
  /** Exact bounded-turn coordinates explicitly delivered to Cursor's MCP child. */
  supervisorMcpEnv?: Readonly<Record<string, string>>;
  /** Per-turn wrapper socket used instead of exposing supervisor coordinates to native Cursor. */
  mcpConnectorSocketPath?: string;
}

export interface CursorPersonalIdentity {
  userId: number;
  email: string | null;
  /** Held only in memory by the trusted proxy; never persisted to a profile. */
  providerAuthorization?: string;
}

const EMPTY_MCP_CONFIG = '{"mcpServers":{}}\n';
const MAX_CURSOR_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_WORKSPACE_MCP_BYTES = 256 * 1024;
const MAX_CURSOR_PROFILE_ENTRIES = 4_096;
const MAX_CURSOR_WRITABLE_TREE_ENTRIES = 1_000_000;
const RETAINED_CURSOR_TURN_JOURNALS = 8;
const SUPERVISED_CURSOR_PERMISSION_PROFILE_IDS = new Set<DesktopManagedAgentPermissionProfileId>([
  "read_only",
  "sandboxed_write",
  "full_access",
]);
const CURSOR_TURN_STREAM_PATTERN = /^letagents-cursor-turn-[a-f0-9]{64}\.jsonl$/;
const CURSOR_STATSIG_TEMP_PATTERN = /^statsig-cache\.json\.[1-9]\d{0,9}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
const CURSOR_CLI_AUTH_KEYS = new Set(["authInfo"]);
const CURSOR_AGENT_STATE_AUTH_KEYS = new Set([
  "accessToken",
  "authInfo",
  "expiresAt",
  "refreshToken",
  "token",
  "version",
]);
const CURSOR_AUTH_INFO_KEYS = new Set([
  "accessToken",
  "authId",
  "displayName",
  "email",
  "expiresAt",
  "organizationId",
  "refreshToken",
  "teamId",
  "teamName",
  "token",
  "userId",
  "version",
]);
const CURSOR_MCP_INSPECTION_PROBE_SOURCE = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") {
    result = {
      protocolVersion: message.params && message.params.protocolVersion || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "letagents-inspection", version: "1" },
    };
  } else if (message.method === "tools/list") {
    result = { tools: [] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
`;
const CURSOR_MCP_SOCKET_CONNECTOR_SOURCE = String.raw`
const net = require("node:net");
const socketPath = process.argv[1];
if (typeof socketPath !== "string" || !socketPath.startsWith("/") || socketPath.length > 1024) process.exit(64);
const socket = net.createConnection({ path: socketPath });
socket.setNoDelay(true);
socket.once("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.once("error", () => process.exit(1));
socket.once("close", () => process.exit(0));
process.stdin.once("error", () => socket.destroy());
process.stdout.once("error", () => socket.destroy());
`;
const SUPERVISED_CURSOR_PROJECT_AUTHORITY_FILES = [
  [".cursor", "cli.json"],
  [".cursor", "cli-config.json"],
  [".cursor", "mcp.json"],
  [".cursor", "permissions.json"],
  [".cursor", "settings.json"],
  [".cursor", "hooks.json"],
] as const;
const SUPERVISED_CURSOR_PROJECT_HIDDEN_AUTHORITY_FILES = [
  ...SUPERVISED_CURSOR_PROJECT_AUTHORITY_FILES,
  // Cursor recognizes Claude-compatible settings, but another provider's
  // checked-in/local configuration must not make a supervised workspace
  // unusable. Keep these files present for Claude while denying Cursor's
  // complete native process tree both read and write access below.
  [".claude", "settings.json"],
  [".claude", "settings.local.json"],
] as const;
const SUPERVISED_CURSOR_MCP_ENV_KEYS = new Set([
  "LETAGENTS_SUPERVISOR_ENTRY_ID",
  "LETAGENTS_SUPERVISOR_DAEMON_SOCKET",
  "LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID",
  "LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID",
  "LETAGENTS_SUPERVISOR_PROVIDER",
  "LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID",
  "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID",
  "LETAGENTS_SUPERVISOR_ROOM_ID",
  "LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME",
  "LETAGENTS_SUPERVISED_BOUNDED_TURNS",
  "LETAGENTS_EXECUTION_PROFILE",
  "LETAGENTS_PERMISSION_PROFILE_ID",
]);
const DARWIN_CURSOR_ENTERPRISE_HOOK_PATH = "/Library/Application Support/Cursor/hooks.json";
export const DEFAULT_CURSOR_MCP_POLICY: DesktopCursorMcpPolicy = "filter_letagents";

export function cursorSupervisedMcpServerName(workAttemptId: string): string {
  const normalized = workAttemptId.trim();
  if (!normalized) throw new Error("A supervised Cursor work attempt id is required.");
  return `letagents_supervised_${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function prepareCursorManagedProfile(
  options: CursorManagedProfileOptions = {},
): CursorManagedProfile {
  const mcpPolicy = normalizeCursorMcpPolicy(options.mcpPolicy);
  const workspaceRoot = normalizePath(options.workspaceRoot);
  if (mcpPolicy === "none" && workspaceRoot) {
    assertWorkspaceDoesNotConfigureAnyCursorMcp(workspaceRoot);
  } else if (mcpPolicy === "filter_letagents" && workspaceRoot) {
    assertWorkspaceDoesNotConfigureLetAgentsMcp(workspaceRoot);
  }

  const sourceHomeDir = normalizePath(options.sourceHomeDir) ||
    normalizePath(process.env.LETAGENTS_CURSOR_SOURCE_HOME) ||
    homedir();
  if (mcpPolicy === "normal") {
    return {
      homeDir: sourceHomeDir,
      configDir: "",
      dataDir: "",
      cacheDir: "",
      env: {},
    };
  }

  const homeDir = normalizePath(options.homeDir) ||
    normalizePath(process.env.LETAGENTS_CURSOR_MANAGED_HOME) ||
    join(dirname(getLetAgentsLocalStatePath()), "cursor-managed", "home");
  const profileRoot = dirname(homeDir);
  const configDir = join(profileRoot, "config");
  const dataDir = join(profileRoot, "data");
  const cacheDir = join(profileRoot, "cache");
  const cursorHomeDir = join(homeDir, ".cursor");

  ensurePrivateProfileTree(profileRoot, [homeDir, cursorHomeDir, configDir, dataDir, cacheDir]);

  copyOptionalFile(
    join(sourceHomeDir, ".cursor", "cli-config.json"),
    join(cursorHomeDir, "cli-config.json"),
  );
  copyOptionalFile(
    join(sourceHomeDir, ".cursor", "agent-cli-state.json"),
    join(cursorHomeDir, "agent-cli-state.json"),
  );
  writeManagedCursorMcpConfig({
    policy: mcpPolicy,
    sourcePath: join(sourceHomeDir, ".cursor", "mcp.json"),
    destinationPath: join(cursorHomeDir, "mcp.json"),
  });

  linkDarwinLoginKeychains(sourceHomeDir, homeDir);

  return {
    homeDir,
    configDir,
    dataDir,
    cacheDir,
    env: {
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      XDG_CACHE_HOME: cacheDir,
      CURSOR_CONFIG_DIR: join(configDir, "cursor"),
      CURSOR_DATA_DIR: join(dataDir, "cursor"),
      NODE_COMPILE_CACHE: join(cacheDir, "node-compile-cache"),
    },
  };
}

/**
 * Build the stable, per-attempt Cursor home used by daemon-owned room turns.
 *
 * Cursor has no strict per-launch MCP-config flag. Its documented global
 * `~/.cursor/mcp.json` is therefore the authority boundary: every supervised
 * attempt gets a distinct HOME containing only the LetAgents bridge, while the
 * user's Cursor auth files and macOS login keychain remain available. The
 * profile is stable across daemon restarts so `--resume <session_id>` resolves
 * the same native conversation, and separate attempts can run concurrently
 * without sharing mutable CLI state.
 */
export function prepareCursorSupervisedProfile(
  options: CursorSupervisedProfileOptions,
): CursorManagedProfile {
  const workAttemptId = options.workAttemptId.trim();
  const apiBaseUrl = options.apiBaseUrl.trim();
  const workspaceRoot = normalizePath(options.workspaceRoot);
  if (!workAttemptId) throw new Error("A supervised Cursor work attempt id is required.");
  if (!apiBaseUrl) throw new Error("Cursor's managed LetAgents endpoint is unavailable.");
  if (!workspaceRoot) throw new Error("A supervised Cursor workspace is required.");
  const permissionProfileId = options.permissionProfileId ?? "read_only";
  if (!SUPERVISED_CURSOR_PERMISSION_PROFILE_IDS.has(permissionProfileId)) {
    throw new Error(`Unsupported supervised Cursor permission profile: ${permissionProfileId}`);
  }
  const workspaceWriteAccess = permissionProfileId !== "read_only";
  const mcpServerName = cursorSupervisedMcpServerName(workAttemptId);
  // Cursor resolves the Git root and merges project authority from every
  // directory down to --workspace. Validate that complete effective chain,
  // not merely the selected subdirectory, before creating any private state.
  const projectDirectories = cursorEffectiveProjectDirectories(workspaceRoot);
  assertWorkspaceDoesNotConfigureSupervisedCursorAuthority(workspaceRoot, projectDirectories);
  assertCursorPlatformEnterpriseHooksAbsent();
  const supervisorMcpEnv = supervisedCursorMcpEnvironment(options.supervisorMcpEnv);
  const mcpConnectorSocketPath = normalizePath(options.mcpConnectorSocketPath);
  if (options.mcpConnectorSocketPath !== undefined
    && (!mcpConnectorSocketPath
      || !/^\/tmp\/letagents-cursor-mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/stdio[.]sock$/.test(mcpConnectorSocketPath))) {
    throw new Error("Supervised Cursor's MCP connector socket is outside its exact one-turn private namespace.");
  }

  const sourceHomeDir = normalizePath(options.sourceHomeDir)
    || normalizePath(process.env.LETAGENTS_CURSOR_SOURCE_HOME)
    || homedir();
  const explicitAuthSourceHomeDir = normalizePath(options.authSourceHomeDir);
  const authSourceHomeDir = explicitAuthSourceHomeDir || sourceHomeDir;
  const profileRoot = normalizePath(options.profileRoot)
    || join(
      dirname(getLetAgentsLocalStatePath()),
      "cursor-supervised",
      createHash("sha256").update(workAttemptId).digest("hex").slice(0, 32),
    );
  const homeDir = join(profileRoot, "home");
  const configDir = join(profileRoot, "config");
  const dataDir = join(profileRoot, "data");
  const cacheDir = join(profileRoot, "cache");
  const tempDir = join(profileRoot, "tmp");
  const cursorHomeDir = join(homeDir, ".cursor");
  const cursorRuntimeConfigDir = join(configDir, "cursor");
  const bridgeRoot = mcpConnectorSocketPath
    ? dirname(mcpConnectorSocketPath)
    : join(profileRoot, "bridge");
  const bridgeHomeDir = join(bridgeRoot, "home");
  const bridgeConfigDir = join(bridgeRoot, "config");
  const bridgeDataDir = join(bridgeRoot, "data");
  const bridgeCacheDir = join(bridgeRoot, "cache");

  ensurePrivateProfileTree(profileRoot, [
    homeDir,
    cursorHomeDir,
    configDir,
    cursorRuntimeConfigDir,
    dataDir,
    cacheDir,
    tempDir,
    ...(mcpConnectorSocketPath ? [] : [
      bridgeRoot,
      bridgeHomeDir,
      bridgeConfigDir,
      bridgeDataDir,
      bridgeCacheDir,
    ]),
  ]);
  // Cursor persists MCP approvals outside both mcp.json and cli-config.json.
  // An approval written by an older CLI launch would otherwise survive our
  // per-turn reseal and silently start a workspace server before any tool is
  // requested. Remove only those approval files; project transcripts are
  // required for --resume and must remain intact.
  purgeCursorMcpApprovalState(join(dataDir, "cursor", "projects"));
  purgeCursorMcpApprovalState(join(cursorHomeDir, "projects"));
  removePrivateProfileAuthorityEntry(join(cursorRuntimeConfigDir, "permissions.json"));
  removePrivateProfileAuthorityEntry(join(cursorRuntimeConfigDir, "hooks.json"));
  removePrivateProfileAuthorityEntry(join(cursorRuntimeConfigDir, "statsig-cache.json"));
  purgeCursorStatsigTemporaryFiles(cursorRuntimeConfigDir);
  removePrivateProfileTreeEntry(join(cursorRuntimeConfigDir, "managed"));
  removePrivateProfileTreeEntry(join(cursorRuntimeConfigDir, "plugins"));
  removePrivateProfileAuthorityEntry(join(cursorHomeDir, "permissions.json"));
  removePrivateProfileAuthorityEntry(join(cursorHomeDir, "settings.json"));
  removePrivateProfileAuthorityEntry(join(cursorHomeDir, "hooks.json"));
  removePrivateProfileTreeEntry(join(cursorHomeDir, "managed"));
  removePrivateProfileTreeEntry(join(cursorHomeDir, "plugins"));
  removePrivateProfileTreeEntry(join(cursorHomeDir, "computer-use"));
  removePrivateProfileTreeEntry(join(homeDir, ".claude"));
  if (options.includeAuth === false || options.exposeLoginCredentials === false) {
    // Cursor's file credential store persists the adapter-owned public
    // placeholder here. It is not authentication authority, but every final
    // turn starts from an empty credential file and receives no copied token.
    removePrivateProfileAuthorityEntry(join(cursorHomeDir, "auth.json"));
  }
  if (options.includeAuth !== false) {
    const exposeLoginCredentials = options.exposeLoginCredentials !== false;
    // `cursor-agent status` may have refreshed this disposable/stable profile
    // from live GetMe. Inspect that result before an external source file can
    // replace stale metadata during the auth-only rewrite below.
    if (!options.identityAttestationOnly && !options.attestedPersonalIdentity) {
      assertCursorAuthIsNotTeamManaged(cursorHomeDir);
    }
    sanitizeOptionalPrivateAuthFile(
      join(authSourceHomeDir, ".cursor", "cli-config.json"),
      join(cursorHomeDir, "cli-config.json"),
      CURSOR_CLI_AUTH_KEYS,
      Boolean(explicitAuthSourceHomeDir),
    );
    sanitizeOptionalPrivateAuthFile(
      join(authSourceHomeDir, ".cursor", "agent-cli-state.json"),
      join(cursorHomeDir, "agent-cli-state.json"),
      exposeLoginCredentials ? CURSOR_AGENT_STATE_AUTH_KEYS : CURSOR_CLI_AUTH_KEYS,
      Boolean(explicitAuthSourceHomeDir),
    );
    if (options.attestedPersonalIdentity) {
      applyAttestedCursorPersonalIdentity(cursorHomeDir, options.attestedPersonalIdentity);
    }
    if (!options.identityAttestationOnly) assertCursorAuthIsNotTeamManaged(cursorHomeDir);
  }
  if (!options.inspectionOnly && !options.mcpRuntime) {
    throw new Error("Supervised Cursor requires the packaged LetAgents MCP runtime.");
  }
  const mcpRuntimeBaseEnv = {
    ELECTRON_RUN_AS_NODE: "1",
    LETAGENTS_API_URL: apiBaseUrl,
    HOME: bridgeHomeDir,
    XDG_CONFIG_HOME: bridgeConfigDir,
    XDG_DATA_HOME: bridgeDataDir,
    XDG_CACHE_HOME: bridgeCacheDir,
    CURSOR_CONFIG_DIR: join(bridgeConfigDir, "cursor"),
    CURSOR_DATA_DIR: join(bridgeDataDir, "cursor"),
    NODE_COMPILE_CACHE: join(bridgeCacheDir, "node-compile-cache"),
    CURSOR_API_KEY: "",
    CURSOR_AUTH_TOKEN: "",
  };
  const letAgentsMcpServer = options.inspectionOnly
    ? {
      command: process.execPath,
      args: ["-e", CURSOR_MCP_INSPECTION_PROBE_SOURCE],
      // A packaged Electron executable becomes Node only for this inert probe;
      // the flag is harmless when process.execPath is already a Node binary.
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }
    : mcpConnectorSocketPath
      ? {
        command: process.execPath,
        args: ["-e", CURSOR_MCP_SOCKET_CONNECTOR_SOURCE, mcpConnectorSocketPath],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      }
    : {
      command: process.execPath,
      args: [options.mcpRuntime!.entryPath],
      // The packaged bridge cannot consult npm configuration, so retain the
      // real repository cwd expected by repo-aware LetAgents tools.
      cwd: normalizePath(options.mcpWorkingDirectory) || workspaceRoot,
      env: {
        ...mcpRuntimeBaseEnv,
        ...supervisorMcpEnv,
      },
    };
  writePrivateFileAtomic(join(cursorHomeDir, "mcp.json"), `${JSON.stringify({
    mcpServers: {
      [mcpServerName]: letAgentsMcpServer,
    },
  }, null, 2)}\n`);
  if (!options.inspectionOnly) {
    // Cursor keeps headless tool permissions under CURSOR_CONFIG_DIR, not in
    // the HOME auth file. Reseal this on every turn so only the daemon bridge
    // can execute without a prompt; project MCPs remain unapproved.
    writePrivateFileAtomic(join(cursorRuntimeConfigDir, "cli-config.json"), `${JSON.stringify({
      version: 1,
      permissions: {
        allow: [`Mcp(${mcpServerName}:*)`],
        deny: [],
      },
      approvalMode: "allowlist",
    }, null, 2)}\n`);
  }
  pruneCompletedCursorTurnJournals(configDir);
  if (options.includeAuth !== false && options.exposeLoginCredentials !== false) {
    linkDarwinLoginKeychains(sourceHomeDir, homeDir);
  } else {
    removePrivateProfileTreeEntry(join(homeDir, "Library", "Keychains"));
  }
  const authReadRoots = options.includeAuth === false || options.exposeLoginCredentials === false
    ? []
    : darwinLoginKeychainReadRoots(sourceHomeDir);

  const nativeDeniedReadPaths = [...new Set([
    DARWIN_CURSOR_ENTERPRISE_HOOK_PATH,
    ...projectDirectories.flatMap((directory) =>
      SUPERVISED_CURSOR_PROJECT_HIDDEN_AUTHORITY_FILES.map((components) => join(directory, ...components))),
    join(cursorRuntimeConfigDir, "hooks.json"),
    join(cursorRuntimeConfigDir, "settings.json"),
    join(cursorRuntimeConfigDir, "statsig-cache.json"),
    join(cursorRuntimeConfigDir, "managed", "active-team-hooks", "hooks.json"),
    join(cursorHomeDir, "hooks.json"),
    join(cursorHomeDir, "settings.json"),
    join(cursorHomeDir, "managed", "active-team-hooks", "hooks.json"),
    join(homeDir, ".claude", "settings.json"),
    join(homeDir, ".claude", "settings.local.json"),
    join(configDir, "letagents-cursor-identity.json"),
  ].flatMap(sandboxPathVariants))];
  const nativeDeniedReadSubpaths = [...new Set([
    ...projectDirectories.map((directory) => join(directory, ".cursor", "plugins")),
    join(cursorRuntimeConfigDir, "managed"),
    join(cursorRuntimeConfigDir, "plugins"),
    join(cursorHomeDir, "managed"),
    join(cursorHomeDir, "plugins"),
    join(cursorHomeDir, "computer-use"),
    join(homeDir, ".claude"),
  ].flatMap(sandboxPathVariants))];
  // A missing project authority directory can otherwise be created (or
  // concurrently replaced) as a symlink after leaf canonicalization. Denying
  // metadata at the exact root prevents traversal through that redirect while
  // preserving direct reads of benign files under a real .cursor/.claude
  // directory; exact-root write denial also prevents the native tree from
  // creating, deleting, or replacing the redirect itself.
  const nativeDeniedReadMetadataPaths = [...new Set(projectDirectories.flatMap((directory) => [
    join(directory, ".cursor"),
    join(directory, ".claude"),
  ]).flatMap(sandboxPathVariants))];
  const statsigCachePaths = [...new Set([
    resolve(cursorRuntimeConfigDir, "statsig-cache.json"),
    canonicalizeAuthorityPath(join(cursorRuntimeConfigDir, "statsig-cache.json")),
  ])];
  const nativeDeniedReadWriteRegexes = statsigCachePaths.map((statsigCachePath) =>
    `^${escapeSandboxRegex(statsigCachePath)}[.][0-9]+[.][0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}[.]tmp$`);
  const gitMetadataReadRoots = cursorGitMetadataReadRoots(workspaceRoot);
  const gitAuthorityRoots = [...new Set(gitMetadataReadRoots.flatMap(sandboxPathVariants))];
  const gitMarkerPath = cursorGitMarkerPath(workspaceRoot);
  const nativeDeniedWritePaths = [...new Set([
    join(cursorHomeDir, "mcp.json"),
    join(configDir, "letagents-cursor-identity.json"),
    ...(gitMarkerPath ? [gitMarkerPath] : []),
    ...gitAuthorityRoots.flatMap((gitRoot) => [
      join(gitRoot, "config"),
      join(gitRoot, "config.worktree"),
    ]),
  ].flatMap(sandboxPathVariants))];
  const nativeDeniedWriteStructuralPaths = [...new Set([
    profileRoot,
    homeDir,
    cursorHomeDir,
    configDir,
    cursorRuntimeConfigDir,
  ].flatMap(sandboxPathVariants))];
  const nativeDeniedWriteSubpaths = [...new Set([
    ...(workspaceWriteAccess ? projectDirectories.flatMap((directory) => [
      join(directory, ".cursor"),
      join(directory, ".claude"),
    ]) : []),
    ...(options.inspectionOnly || mcpConnectorSocketPath ? [] : options.mcpRuntime!.readRoots),
    ...gitAuthorityRoots.map((gitRoot) => join(gitRoot, "hooks")),
  ].flatMap(sandboxPathVariants))];
  const nativeDeniedWriteRegexes = [...new Set(gitAuthorityRoots.flatMap((gitRoot) => {
    const escapedRoot = escapeSandboxRegex(gitRoot);
    return [
      `^${escapedRoot}/modules/.*/config$`,
      `^${escapedRoot}/modules/.*/config[.]worktree$`,
      `^${escapedRoot}/modules/.*/hooks$`,
      `^${escapedRoot}/modules/.*/hooks/.*$`,
      `^${escapedRoot}/worktrees/[^/]+/config[.]worktree$`,
    ];
  }))];
  const nativeAllowedWriteSubpaths = [...new Set([
    profileRoot,
    ...(workspaceWriteAccess ? [workspaceRoot, ...gitMetadataReadRoots] : []),
  ].flatMap(sandboxPathVariants))];
  // Repo-local native build products (esbuild/swc and compiled Rust/Go/C
  // tests) are ordinary workspace effects and must remain executable. Keep
  // executable creation out of the private Cursor profile and Git metadata
  // instead of applying the old blanket deny to every writable tree.
  const nativeDeniedExecSubpaths = [...new Set([
    profileRoot,
    ...gitMetadataReadRoots,
  ].flatMap(sandboxPathVariants))];
  const nativeAllowedReadSubpaths = [...new Set([
    profileRoot,
    workspaceRoot,
    ...projectDirectories.map((directory) => join(directory, ".git")),
    ...gitMetadataReadRoots,
    ...authReadRoots,
    ...(options.inspectionOnly || mcpConnectorSocketPath ? [] : options.mcpRuntime!.readRoots),
  ].flatMap(sandboxPathVariants))];

  return {
    homeDir,
    configDir,
    dataDir,
    cacheDir,
    env: {
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      XDG_CACHE_HOME: cacheDir,
      CURSOR_CONFIG_DIR: cursorRuntimeConfigDir,
      CURSOR_DATA_DIR: join(dataDir, "cursor"),
      NODE_COMPILE_CACHE: join(cacheDir, "node-compile-cache"),
      TMPDIR: tempDir,
    },
    mcpServerName,
    authReadRoots,
    nativeDeniedReadPaths,
    nativeDeniedReadSubpaths,
    nativeDeniedReadMetadataPaths,
    nativeDeniedReadWriteRegexes,
    nativeDeniedWriteRegexes,
    nativeDeniedWritePaths,
    nativeDeniedWriteStructuralPaths,
    nativeDeniedWriteSubpaths,
    nativeDeniedExecSubpaths,
    nativeAllowedWriteSubpaths,
    nativeAllowedReadSubpaths,
    ...(options.inspectionOnly ? {} : {
      mcpRuntimeEntryPath: options.mcpRuntime!.entryPath,
      mcpRuntimeReadRoots: [...options.mcpRuntime!.readRoots],
      ...(mcpConnectorSocketPath ? { mcpRuntimeEnv: mcpRuntimeBaseEnv } : {}),
    }),
  };
}

/**
 * Reject every Cursor-owned project file that can widen its effective
 * execution or extension policy. Cursor's hidden --disable-project-configs
 * flag covers the cli.json chain, but not project MCP discovery, so this check
 * is independently required and re-run before every native turn. Compatible
 * settings owned by other providers remain in place and are hidden by the
 * native sandbox instead.
 */
function assertWorkspaceDoesNotConfigureSupervisedCursorAuthority(
  workspaceRoot: string,
  projectDirectories = cursorEffectiveProjectDirectories(workspaceRoot),
): void {
  for (const directory of projectDirectories) {
    for (const components of SUPERVISED_CURSOR_PROJECT_AUTHORITY_FILES) {
      const configPath = join(directory, ...components);
      if (!pathEntryExists(configPath)) continue;
      const relativeConfig = relative(resolve(workspaceRoot), configPath) || components.join("/");
      const kind = components.at(-1) === "mcp.json"
        ? "MCP"
        : components.at(-1)?.includes("cli") || components.at(-1) === "permissions.json"
          ? "permission"
          : "authority";
      throw new Error(
        `Cursor workspace ${kind} config is not allowed with supervised Cursor (${relativeConfig}). Remove it before starting the agent.`,
      );
    }
  }
}

/** Canonicalize the nearest existing parent without following the authority entry itself. */
function canonicalizeAuthorityPath(path: string): string {
  const suffix = [dirname(path) === path ? "" : path.slice(dirname(path).length + 1)].filter(Boolean);
  let parent = dirname(path);
  for (;;) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory()) {
        throw new Error(`Cursor authority parent is not a directory: ${parent}`);
      }
      return join(realpathSync(parent), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      suffix.push(parent.slice(next.length + 1));
      parent = next;
    }
  }
}

/** Seatbelt regex/literal matching can observe either lexical or vnode paths. */
function sandboxPathVariants(path: string): string[] {
  return [...new Set([resolve(path), canonicalizeAuthorityPath(path)])];
}

/** Cursor uses Git's resolved top-level, then walks root -> selected workspace. */
function cursorEffectiveProjectDirectories(workspaceRoot: string): string[] {
  const logicalWorkspace = resolve(workspaceRoot);
  const workspaceStat = lstatSync(logicalWorkspace);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error(`Cursor supervised workspace must be a real directory: ${logicalWorkspace}`);
  }
  const workspace = realpathSync(logicalWorkspace);
  let hasGitMarker = false;
  for (let cursor = workspace;; cursor = dirname(cursor)) {
    if (pathEntryExists(join(cursor, ".git"))) {
      hasGitMarker = true;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
  }
  let projectRoot = workspace;
  if (hasGitMarker) {
    let reportedRoot: string;
    try {
      reportedRoot = execFileSync(
        "git",
        ["-C", workspace, "rev-parse", "--show-toplevel"],
        {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 16 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.platform === "win32"
              ? process.env.PATH || ""
              : "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: workspace,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
        },
      ).trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cursor could not resolve the workspace Git root safely: ${detail}`);
    }
    if (!reportedRoot) {
      throw new Error("Cursor resolved an empty workspace Git root.");
    }
    const logicalProjectRoot = resolve(workspace, reportedRoot);
    const projectRootStat = lstatSync(logicalProjectRoot);
    if (!projectRootStat.isDirectory() || projectRootStat.isSymbolicLink()) {
      throw new Error(`Cursor resolved Git root is not a real directory: ${logicalProjectRoot}`);
    }
    projectRoot = realpathSync(logicalProjectRoot);
  }
  const suffix = relative(projectRoot, workspace);
  if (suffix.startsWith("..") || resolve(projectRoot, suffix) !== workspace) {
    throw new Error("Cursor workspace escaped its resolved Git project root.");
  }
  const directories = [projectRoot];
  let cursor = projectRoot;
  for (const component of suffix.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, component);
    directories.push(cursor);
  }
  return directories;
}

/** Resolve only Git's administrative directories, never the broader parent checkout. */
function cursorGitMarkerPath(workspaceRoot: string): string | null {
  const workspace = realpathSync(resolve(workspaceRoot));
  for (let cursor = workspace;; cursor = dirname(cursor)) {
    if (pathEntryExists(join(cursor, ".git"))) {
      return join(cursor, ".git");
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
  }
  return null;
}

/** Resolve only Git's administrative directories, never the broader parent checkout. */
function cursorGitMetadataReadRoots(workspaceRoot: string): string[] {
  const workspace = realpathSync(resolve(workspaceRoot));
  const gitMarker = cursorGitMarkerPath(workspace);
  if (!gitMarker) return [];
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["-C", workspace, "rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 32 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.platform === "win32"
            ? process.env.PATH || ""
            : "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: workspace,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor could not resolve Git metadata safely: ${detail}`);
  }
  const roots = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (roots.length !== 2) {
    throw new Error("Cursor resolved an ambiguous set of Git metadata roots.");
  }
  const canonicalRoots = roots.map((root) => {
    const logical = resolve(workspace, root);
    const stat = lstatSync(logical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Cursor Git metadata root is not a real directory: ${logical}`);
    }
    const canonical = realpathSync(logical);
    if (canonical === "/") throw new Error("Cursor refuses an unbounded Git metadata root.");
    return canonical;
  });
  const [gitDirectory, commonDirectory] = canonicalRoots;
  const markerStat = lstatSync(gitMarker);
  if (markerStat.isSymbolicLink()) {
    throw new Error("Cursor supervised Git marker may not be a symlink.");
  }
  if (markerStat.isDirectory()) {
    const markerDirectory = realpathSync(gitMarker);
    for (const root of canonicalRoots) {
      const suffix = relative(markerDirectory, root);
      if (suffix.startsWith("..") || resolve(markerDirectory, suffix) !== root) {
        throw new Error("Cursor Git metadata escaped the selected repository marker.");
      }
    }
  } else if (markerStat.isFile()) {
    const markerText = readRegularFileNoFollow(gitMarker, 16 * 1024).toString("utf8").trim();
    const markerMatch = /^gitdir:\s*(.+)$/i.exec(markerText);
    if (!markerMatch) throw new Error("Cursor linked-worktree Git marker is invalid.");
    const markerGitDirectory = realpathSync(resolve(dirname(gitMarker), markerMatch[1]!));
    if (markerGitDirectory !== gitDirectory) {
      throw new Error("Cursor linked-worktree Git metadata topology is invalid.");
    }
    if (dirname(dirname(gitDirectory)) === commonDirectory
      && dirname(gitDirectory) === join(commonDirectory, "worktrees")) {
      const backlinkPath = resolve(
        gitDirectory,
        readRegularFileNoFollow(join(gitDirectory, "gitdir"), 16 * 1024).toString("utf8").trim(),
      );
      if (realpathSync(backlinkPath) !== realpathSync(gitMarker)) {
        throw new Error("Cursor linked-worktree Git metadata does not point back to the selected worktree.");
      }
      const commondirPath = realpathSync(resolve(
        gitDirectory,
        readRegularFileNoFollow(join(gitDirectory, "commondir"), 16 * 1024).toString("utf8").trim(),
      ));
      if (commondirPath !== commonDirectory) {
        throw new Error("Cursor linked-worktree common Git metadata is inconsistent.");
      }
    } else if (gitDirectory === commonDirectory) {
      assertCursorSubmoduleGitMetadataTopology(workspace, gitDirectory);
    } else {
      throw new Error("Cursor linked-worktree Git metadata topology is invalid.");
    }
  } else {
    throw new Error("Cursor supervised Git marker must be a file or directory.");
  }
  return [...new Set(canonicalRoots)];
}

function assertCursorSubmoduleGitMetadataTopology(workspace: string, gitDirectory: string): void {
  let reportedSuperproject: string;
  let configuredWorktree: string;
  try {
    const safeGitEnv = {
      PATH: process.platform === "win32"
        ? process.env.PATH || ""
        : "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: workspace,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    };
    reportedSuperproject = execFileSync(
      "git",
      ["-C", workspace, "rev-parse", "--show-superproject-working-tree"],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"], env: safeGitEnv },
    ).trim();
    configuredWorktree = execFileSync(
      "git",
      ["config", "--file", join(gitDirectory, "config"), "--no-includes", "--type=path", "--get", "core.worktree"],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"], env: safeGitEnv },
    ).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor could not validate submodule Git metadata safely: ${detail}`);
  }
  if (!reportedSuperproject || !configuredWorktree) {
    throw new Error("Cursor submodule Git metadata omitted its superproject or worktree binding.");
  }
  const superprojectStat = lstatSync(resolve(reportedSuperproject));
  if (!superprojectStat.isDirectory() || superprojectStat.isSymbolicLink()) {
    throw new Error("Cursor submodule superproject is not a real directory.");
  }
  const superproject = realpathSync(resolve(reportedSuperproject));
  if (superproject === workspace || !pathIsWithin(superproject, workspace)) {
    throw new Error("Cursor submodule escaped its reported superproject.");
  }
  const resolvedWorktree = realpathSync(resolve(gitDirectory, configuredWorktree));
  if (resolvedWorktree !== workspace) {
    throw new Error("Cursor submodule Git metadata does not point back to the selected workspace.");
  }
  const superprojectMetadataRoots = cursorGitMetadataReadRoots(superproject);
  if (!superprojectMetadataRoots.some((root) => pathIsWithin(join(root, "modules"), gitDirectory))) {
    throw new Error("Cursor submodule Git metadata is outside its superproject modules namespace.");
  }
}

/**
 * Seatbelt authorizes writes by path, while a hard link gives one inode more
 * than one path. Before granting repo writes, prove every multiply-linked
 * regular file has all of its links inside the writable roots and none cross
 * a protected provider-authority tree. The native sandbox separately denies
 * file-link so the supervised process cannot create a new alias afterward.
 */
export async function assertCursorSupervisedWritableRootsHaveNoExternalHardLinks(
  profile: CursorManagedProfile,
  signal?: AbortSignal,
): Promise<void> {
  return assertCursorWritableRootsHaveNoExternalHardLinks(
    profile.nativeAllowedWriteSubpaths ?? [],
    [
      ...(profile.nativeDeniedWritePaths ?? []),
      ...(profile.nativeDeniedWriteSubpaths ?? []),
      ...(profile.nativeDeniedReadPaths ?? []),
      ...(profile.nativeDeniedReadSubpaths ?? []),
      ...(profile.nativeDeniedReadMetadataPaths ?? []),
    ],
    [
      ...(profile.nativeDeniedReadWriteRegexes ?? []),
      ...(profile.nativeDeniedWriteRegexes ?? []),
    ],
    signal,
  );
}

async function assertCursorWritableRootsHaveNoExternalHardLinks(
  writableRoots: readonly string[],
  protectedRoots: readonly string[],
  protectedPatterns: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw new Error("Cursor writable-root hard-link inspection was cancelled.");
    }
  };
  throwIfAborted();
  const canonicalRoots = [...new Set(writableRoots.map((root) => realpathSync(resolve(root))))]
    .filter((candidate, _index, roots) => !roots.some((root) =>
      root !== candidate && pathIsWithin(root, candidate)));
  const canonicalProtectedRoots = [...new Set(protectedRoots.map((root) =>
    canonicalizeAuthorityPath(root)))];
  const protectedRegexes = protectedPatterns.map((pattern) => new RegExp(pattern));
  const touchesProtectedAuthority = (entryPath: string): boolean =>
    canonicalProtectedRoots.some((root) => pathIsWithin(root, entryPath))
      || protectedRegexes.some((pattern) => pattern.test(entryPath));
  const links = new Map<string, {
    expected: bigint;
    observed: bigint;
    firstPath: string;
    touchesProtectedAuthority: boolean;
  }>();
  const pending = [...canonicalRoots];
  let entries = 0;

  const inspectEntries = async (entryPaths: readonly string[]): Promise<void> => {
    throwIfAborted();
    const inspected = await Promise.all(entryPaths.map(async (entryPath) => ({
      entryPath,
      stat: await lstatAsync(entryPath, { bigint: true }),
    })));
    throwIfAborted();
    for (const { entryPath, stat } of inspected) {
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!stat.isFile() || stat.nlink <= 1n) continue;
      const key = `${stat.dev}:${stat.ino}`;
      const existing = links.get(key);
      if (existing) {
        existing.observed += 1n;
        existing.touchesProtectedAuthority ||= touchesProtectedAuthority(entryPath);
      } else {
        links.set(key, {
          expected: stat.nlink,
          observed: 1n,
          firstPath: entryPath,
          touchesProtectedAuthority: touchesProtectedAuthority(entryPath),
        });
      }
    }
  };

  while (pending.length) {
    throwIfAborted();
    const directoryPath = pending.pop()!;
    const directory = await opendirAsync(directoryPath);
    let batch: string[] = [];
    try {
      for await (const entry of directory) {
        entries += 1;
        if (entries > MAX_CURSOR_WRITABLE_TREE_ENTRIES) {
          throw new Error("Cursor supervised writable-root hard-link inspection exceeded its bounded entry limit.");
        }
        batch.push(join(directoryPath, entry.name));
        if (batch.length >= 128) {
          await inspectEntries(batch);
          batch = [];
        }
      }
      if (batch.length) await inspectEntries(batch);
    } finally {
      try { await directory.close(); } catch {}
    }
  }

  for (const link of links.values()) {
    if (link.observed !== link.expected) {
      throw new Error(
        `Cursor supervised writes refuse a file hard-linked outside the selected workspace: ${link.firstPath}`,
      );
    }
    if (link.touchesProtectedAuthority) {
      throw new Error(
        `Cursor supervised writes refuse a hard link that aliases protected provider authority: ${link.firstPath}`,
      );
    }
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function supervisedCursorMcpEnvironment(
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!input) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SUPERVISED_CURSOR_MCP_ENV_KEYS.has(key)) {
      throw new Error(`Unsupported supervised Cursor MCP environment key: ${key}`);
    }
    if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 16 * 1024) {
      throw new Error(`Invalid supervised Cursor MCP environment value for ${key}.`);
    }
    result[key] = value;
  }
  return result;
}

function assertCursorPlatformEnterpriseHooksAbsent(): void {
  if (process.platform === "darwin" && pathEntryExists(DARWIN_CURSOR_ENTERPRISE_HOOK_PATH)) {
    throw new Error(
      `Cursor enterprise hooks are not supported for supervised agents (${DARWIN_CURSOR_ENTERPRISE_HOOK_PATH}). Remove the hook policy before starting the agent.`,
    );
  }
}

function removePrivateProfileAuthorityEntry(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error(`Cursor private authority state is not a file: ${path}`);
  }
  unlinkSync(path);
}

/** Remove a private provider-managed authority subtree without following it. */
function removePrivateProfileTreeEntry(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: false });
    return;
  }
  unlinkSync(path);
}

/**
 * Cursor writes Statsig atomically through sibling
 * `statsig-cache.json.<pid>.<uuid>.tmp` files. The final authority file is
 * sandbox-denied, so interrupted/denied renames can otherwise leave megabytes
 * of remote feature configuration in the stable attempt profile. Inspect only
 * the exact private directory shape and unlink entries without following them.
 */
function purgeCursorStatsigTemporaryFiles(cursorRuntimeConfigDir: string): void {
  const directory = opendirSync(cursorRuntimeConfigDir);
  let entries = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > MAX_CURSOR_PROFILE_ENTRIES) {
        throw new Error("Cursor runtime config contains too many entries to inspect safely.");
      }
      if (!CURSOR_STATSIG_TEMP_PATTERN.test(entry.name)) continue;
      removePrivateProfileAuthorityEntry(join(cursorRuntimeConfigDir, entry.name));
    }
  } finally {
    directory.closeSync();
  }
}

/** Escape an absolute filesystem path for a literal Seatbelt regex prefix. */
function escapeSandboxRegex(path: string): string {
  if (/[\x00-\x1f\x7f[\]\\^]/.test(path)) {
    throw new Error("Cursor sandbox regex paths contain unsupported characters.");
  }
  return [...path].map((character) => /[A-Za-z0-9/_-]/.test(character)
    ? character
    : `[${character}]`).join("");
}

/**
 * Remove Cursor's persisted project-MCP grants without deleting conversation
 * state stored beside them. Cursor currently stores each grant at
 * `projects/<workspace>/mcp-approvals.json`. We deliberately inspect exactly
 * that bounded shape and never follow a redirected projects/workspace entry.
 */
function purgeCursorMcpApprovalState(projectsRoot: string): void {
  let rootStat;
  try {
    rootStat = lstatSync(projectsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    // This entry belongs entirely to the private profile. Removing the entry
    // cannot affect a symlink target and prevents Cursor from following it.
    if (rootStat.isDirectory()) {
      throw new Error(`Cursor MCP approval root is not a real directory: ${projectsRoot}`);
    }
    unlinkSync(projectsRoot);
    return;
  }

  const projects = opendirSync(projectsRoot);
  let entries = 0;
  try {
    for (;;) {
      const project = projects.readSync();
      if (!project) break;
      entries += 1;
      if (entries > MAX_CURSOR_PROFILE_ENTRIES) {
        throw new Error("Cursor project state contains too many entries to inspect safely.");
      }
      const projectPath = join(projectsRoot, project.name);
      const projectStat = lstatSync(projectPath);
      if (projectStat.isSymbolicLink()) {
        // A redirected project directory could conceal an approval file. Drop
        // only the link; its target and any transcript there are untouched.
        unlinkSync(projectPath);
        continue;
      }
      if (!projectStat.isDirectory()) continue;

      const approvalPath = join(projectPath, "mcp-approvals.json");
      let approvalStat;
      try {
        approvalStat = lstatSync(approvalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (approvalStat.isDirectory() && !approvalStat.isSymbolicLink()) {
        throw new Error(`Cursor MCP approval state is not a file: ${approvalPath}`);
      }
      // unlink removes a regular/special file or the symlink itself without
      // following it. Cursor will recreate a clean approval record if needed.
      unlinkSync(approvalPath);
    }
  } finally {
    projects.closeSync();
  }
}

/** Remove only the deterministic owner-private profile for an exact purged attempt. */
export function removeCursorSupervisedProfile(workAttemptId: string): void {
  const normalized = workAttemptId.trim();
  if (!normalized) return;
  const profileRoot = join(
    dirname(getLetAgentsLocalStatePath()),
    "cursor-supervised",
    createHash("sha256").update(normalized).digest("hex").slice(0, 32),
  );
  const profileParent = dirname(profileRoot);
  if (!existsSync(profileParent)) return;
  assertRealDirectory(profileParent, "Cursor supervised profile parent");
  if (!existsSync(profileRoot)) return;
  const stat = lstatSync(profileRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing to purge a redirected Cursor supervised profile.");
  }
  rmSync(profileRoot, { recursive: true, force: true });
}

export function normalizeCursorMcpPolicy(
  value: DesktopCursorMcpPolicy | string | null | undefined,
): DesktopCursorMcpPolicy {
  return value === "normal" || value === "none" || value === "filter_letagents"
    ? value
    : DEFAULT_CURSOR_MCP_POLICY;
}

export function assertWorkspaceDoesNotConfigureLetAgentsMcp(workspaceRoot: string): void {
  const config = readWorkspaceCursorMcpConfig(workspaceRoot);
  if (!config) return;

  if (mcpConfigMentionsLetAgents(config)) {
    throw new Error(
      "Cursor workspace MCP config exposes LetAgents. Remove .cursor/mcp.json LetAgents entries before starting a managed Cursor agent.",
    );
  }
}

export function assertWorkspaceDoesNotConfigureAnyCursorMcp(
  workspaceRoot: string,
  policyLabel = "the No MCPs policy",
): void {
  const config = readWorkspaceCursorMcpConfig(workspaceRoot);
  if (!config) return;

  if (mcpConfigHasServers(config)) {
    throw new Error(
      `Cursor workspace MCP config is not allowed with ${policyLabel}. Remove .cursor/mcp.json MCP entries before starting a managed Cursor agent.`,
    );
  }
}

export function filterLetAgentsCursorMcpConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { mcpServers: {} };
  }
  const source = config as Record<string, unknown>;
  const servers = source.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return {
      ...source,
      mcpServers: {},
    };
  }

  const filteredServers = Object.fromEntries(
    Object.entries(servers).filter(([name, serverConfig]) => !mcpServerMentionsLetAgents(name, serverConfig)),
  );
  return {
    ...source,
    mcpServers: filteredServers,
  };
}

function writeManagedCursorMcpConfig(input: {
  policy: DesktopCursorMcpPolicy;
  sourcePath: string;
  destinationPath: string;
}): void {
  if (input.policy === "none") {
    writeFileSync(input.destinationPath, EMPTY_MCP_CONFIG, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return;
  }

  let sourceConfig: unknown = { mcpServers: {} };
  if (existsSync(input.sourcePath)) {
    try {
      sourceConfig = JSON.parse(readFileSync(input.sourcePath, "utf-8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cursor source MCP config is invalid at ${input.sourcePath}: ${detail}`);
    }
  }
  const filteredConfig = filterLetAgentsCursorMcpConfig(sourceConfig);
  writeFileSync(input.destinationPath, `${JSON.stringify(filteredConfig, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function copyOptionalFile(source: string, destination: string): void {
  if (!existsSync(source)) {
    return;
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

function sanitizeOptionalPrivateAuthFile(
  source: string,
  destination: string,
  allowedKeys: ReadonlySet<string>,
  preferSource: boolean,
): void {
  // A just-attested explicit source is authoritative over stale per-attempt
  // metadata. Ordinary stable profiles remain destination-first so provider
  // token refreshes survive when no live identity source was supplied.
  const selectedPath = preferSource
    ? pathEntryExists(source)
      ? source
      : pathEntryExists(destination)
        ? destination
        : null
    : pathEntryExists(destination)
      ? destination
      : pathEntryExists(source)
        ? source
        : null;
  if (!selectedPath) return;
  const raw = readRegularFileNoFollow(selectedPath, MAX_CURSOR_CONFIG_BYTES).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cursor auth config is invalid at ${selectedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cursor auth config must be an object at ${selectedPath}.`);
  }
  const authOnly: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowedKeys.has(key)) continue;
    authOnly[key] = key === "authInfo"
      ? sanitizeCursorAuthInfo(value, selectedPath)
      : sanitizeCursorAuthScalar(value, `${selectedPath}:${key}`);
  }
  // Rewrite on every turn. Cursor may persist runtime state inside the private
  // profile, but authority-affecting keys never survive into the next launch.
  writePrivateFileAtomic(destination, `${JSON.stringify(authOnly, null, 2)}\n`);
}

function sanitizeCursorAuthInfo(value: unknown, sourcePath: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cursor authInfo must be an object at ${sourcePath}.`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!CURSOR_AUTH_INFO_KEYS.has(key)) continue;
    result[key] = sanitizeCursorAuthScalar(entry, `${sourcePath}:authInfo.${key}`);
  }
  return result;
}

function sanitizeCursorAuthScalar(value: unknown, label: string): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 256 * 1024 || value.includes("\0")) {
      throw new Error(`Cursor auth value is invalid at ${label}.`);
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)) {
    return value;
  }
  throw new Error(`Cursor auth value must be a bounded scalar at ${label}.`);
}

/**
 * Cursor's team policy RPC mixes restrictions with settings that can widen
 * autorun, MCP, and sandbox authority. Blocking it makes the native CLI fail
 * open; forwarding it raw would import remote authority. Until the desktop can
 * protobuf-decode and intersect that policy, fail closed for team identities.
 */
function assertCursorAuthIsNotTeamManaged(cursorHomeDir: string): void {
  for (const name of ["cli-config.json", "agent-cli-state.json"]) {
    const path = join(cursorHomeDir, name);
    if (!pathEntryExists(path)) continue;
    const parsed = JSON.parse(readRegularFileNoFollow(path, MAX_CURSOR_CONFIG_BYTES).toString("utf8")) as {
      authInfo?: unknown;
    };
    const authInfo = parsed.authInfo;
    if (authInfo
      && typeof authInfo === "object"
      && !Array.isArray(authInfo)
      && Object.prototype.hasOwnProperty.call(authInfo, "teamId")
      && (authInfo as Record<string, unknown>).teamId !== null
      && (authInfo as Record<string, unknown>).teamId !== undefined) {
      throw new Error(
        "Team-managed Cursor accounts are not supported for supervised agents because Cursor team policy cannot be safely mediated yet. Use a non-team Cursor account.",
      );
    }
  }
}

function applyAttestedCursorPersonalIdentity(
  cursorHomeDir: string,
  identity: CursorPersonalIdentity,
): void {
  if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0) {
    throw new Error("Cursor live identity attestation returned an invalid user id.");
  }
  for (const name of ["cli-config.json", "agent-cli-state.json"]) {
    const path = join(cursorHomeDir, name);
    if (!pathEntryExists(path)) continue;
    const parsed = JSON.parse(readRegularFileNoFollow(path, MAX_CURSOR_CONFIG_BYTES).toString("utf8")) as Record<string, unknown>;
    const authInfo: Record<string, unknown> = {};
    authInfo.userId = identity.userId;
    if (identity.email) authInfo.email = identity.email;
    else delete authInfo.email;
    parsed.authInfo = authInfo;
    writePrivateFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
  }
}

/** Bind a native continuation to the personal account that first created it. */
export function bindCursorSupervisedIdentity(
  profile: CursorManagedProfile,
  identity: CursorPersonalIdentity,
): void {
  if (!Number.isSafeInteger(identity.userId) || identity.userId <= 0) {
    throw new Error("Cursor live identity attestation returned an invalid user id.");
  }
  const path = join(profile.configDir, "letagents-cursor-identity.json");
  if (pathEntryExists(path)) {
    const parsed = JSON.parse(readRegularFileNoFollow(path, 16 * 1024).toString("utf8")) as Record<string, unknown>;
    if (parsed.userId !== identity.userId) {
      throw new Error(
        "Cursor account changed during this supervised attempt; start a new agent instead of resuming another account's session.",
      );
    }
    return;
  }
  writePrivateFileAtomic(path, `${JSON.stringify({ userId: identity.userId }, null, 2)}\n`);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pruneCompletedCursorTurnJournals(configDir: string): void {
  const directory = opendirSync(configDir);
  const completed: Array<{ streamPath: string; terminalPath: string; mtimeMs: number }> = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > MAX_CURSOR_PROFILE_ENTRIES) {
        throw new Error("Cursor supervised profile contains too many entries to inspect safely.");
      }
      if (!entry.name.endsWith(".terminal.json")) continue;
      const streamName = entry.name.slice(0, -".terminal.json".length);
      if (!CURSOR_TURN_STREAM_PATTERN.test(streamName)) continue;
      const terminalPath = join(configDir, entry.name);
      const streamPath = join(configDir, streamName);
      const terminalStat = lstatSync(terminalPath);
      if (!terminalStat.isFile() || terminalStat.isSymbolicLink()) {
        throw new Error("Cursor supervised terminal journal is not a regular file.");
      }
      let streamStat;
      try {
        streamStat = lstatSync(streamPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!streamStat.isFile() || streamStat.isSymbolicLink()) {
        throw new Error("Cursor supervised stream journal is not a regular file.");
      }
      completed.push({ streamPath, terminalPath, mtimeMs: terminalStat.mtimeMs });
    }
  } finally {
    directory.closeSync();
  }
  completed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const journal of completed.slice(RETAINED_CURSOR_TURN_JOURNALS)) {
    // Retire authority first. A crash can leave only an inert stream prefix.
    unlinkSync(journal.terminalPath);
    try {
      unlinkSync(journal.streamPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Replace a private profile file without following a destination symlink left
 * by a prior provider turn. The temporary file is created beside the target
 * with owner-only permissions, then renamed over the directory entry.
 */
function writePrivateFileAtomic(destination: string, data: string | Buffer): void {
  const parent = dirname(destination);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Cursor private profile parent is not a real directory: ${parent}`);
  }
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, destination);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the original failure; a same-profile retry may clean up the
      // owner-only temporary file after the filesystem becomes writable.
    }
    throw error;
  }
}

function linkDarwinLoginKeychains(sourceHomeDir: string, homeDir: string): void {
  if (process.platform !== "darwin") {
    return;
  }
  const source = join(sourceHomeDir, "Library", "Keychains");
  if (!existsSync(source)) {
    return;
  }
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Cursor login keychain source must be a real directory.");
  }
  const link = join(homeDir, "Library", "Keychains");
  ensurePrivateDirectory(dirname(link));
  if (existsSync(link)) {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink() || readlinkSync(link) !== source) {
      throw new Error("Cursor private profile contains an unexpected login keychain entry.");
    }
    return;
  }
  symlinkSync(source, link, "dir");
}

function darwinLoginKeychainReadRoots(sourceHomeDir: string): string[] {
  if (process.platform !== "darwin") return [];
  const source = join(sourceHomeDir, "Library", "Keychains");
  if (!existsSync(source)) return [];
  const stat = lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Cursor login keychain source must be a real directory.");
  }
  return [realpathSync(source)];
}

function mcpConfigMentionsLetAgents(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return false;
  }
  return Object.entries(servers).some(([name, config]) => mcpServerMentionsLetAgents(name, config));
}

function mcpConfigHasServers(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  return Boolean(servers && typeof servers === "object" && !Array.isArray(servers) && Object.keys(servers).length);
}

function mcpServerMentionsLetAgents(name: string, config: unknown): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (normalizedName === "letagents" || normalizedName.includes("letagents")) {
    return true;
  }
  try {
    return JSON.stringify(config).toLowerCase().includes("letagents");
  } catch {
    return false;
  }
}

function readWorkspaceCursorMcpConfig(workspaceRoot: string): unknown | null {
  const mcpPath = join(resolve(workspaceRoot), ".cursor", "mcp.json");
  if (!existsSync(mcpPath)) {
    return null;
  }

  try {
    return JSON.parse(readRegularFileNoFollow(mcpPath, MAX_WORKSPACE_MCP_BYTES).toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor workspace MCP config is invalid at ${mcpPath}: ${detail}`);
  }
}

function ensurePrivateProfileTree(profileRoot: string, directories: string[]): void {
  ensureRealDirectoryChain(dirname(profileRoot));
  if (!existsSync(profileRoot)) mkdirSync(profileRoot, { recursive: false, mode: 0o700 });
  ensurePrivateDirectory(profileRoot);
  const canonicalRoot = realpathSync(profileRoot);
  const logicalRoot = resolve(profileRoot);
  for (const directory of directories) {
    const logicalDirectory = resolve(directory);
    const suffix = relative(logicalRoot, logicalDirectory);
    if (suffix.startsWith("..") || resolve(logicalRoot, suffix) !== logicalDirectory) {
      throw new Error(`Cursor private profile directory escapes its root: ${directory}`);
    }
    ensurePrivateDirectory(directory);
    const canonical = realpathSync(directory);
    const expectedCanonical = resolve(canonicalRoot, suffix);
    if (canonical !== expectedCanonical) {
      throw new Error(`Cursor private profile directory is redirected outside its root: ${directory}`);
    }
  }
}

/** Create only missing descendants below the nearest existing real directory. */
function ensureRealDirectoryChain(directory: string): void {
  const missing: string[] = [];
  let cursor = resolve(directory);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Cursor private profile has no real parent: ${directory}`);
    missing.push(cursor);
    cursor = parent;
  }
  assertRealDirectory(cursor, "Cursor private profile ancestor");
  for (const component of missing.reverse()) {
    mkdirSync(component, { recursive: false, mode: 0o700 });
    assertRealDirectory(component, "Cursor private profile parent");
  }
}

function assertRealDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
}

function ensurePrivateDirectory(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: false, mode: 0o700 });
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Cursor private profile path is not a real directory: ${directory}`);
  }
  chmodSync(directory, 0o700);
}

function readRegularFileNoFollow(path: string, maxBytes: number): Buffer {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw new Error(`exceeds the ${maxBytes}-byte limit`);
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(fd);
    if (offset !== data.length || after.size !== stat.size
      || after.dev !== stat.dev || after.ino !== stat.ino
      || after.mtimeMs !== stat.mtimeMs) {
      throw new Error("changed while it was being read");
    }
    return data;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor config must be a bounded regular file at ${path}: ${detail}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? resolve(trimmed) : null;
}
