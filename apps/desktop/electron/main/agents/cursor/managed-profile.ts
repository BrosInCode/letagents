import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  opendirSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getLetAgentsLocalStatePath } from "../../paths.js";
import { renameSyncWithRetry } from "../../../../../../shared/rename-retry.mjs";
import { everyOwnedByCurrentUserSync, isOwnedByCurrentUserSync, ownerPrivatePlatform } from "../../../../../../shared/owner-private-fs.mjs";
import { CURSOR_MCP_CONNECTOR_PARENT, CURSOR_SESSION_ID_PATTERN, MAX_CURSOR_SESSION_ID_LENGTH } from "../cursor-provider-constants.js";
import { cursorOsSandbox } from "../cursor-sandbox-policy.js";
import { cursorMcpConnectorRootPattern } from "./turn-wrapper-setup.js";
import { cursorMcpPipeConnectorArgs } from "./windows-turn.js";
import {
  applyAttestedCursorPersonalIdentity,
  assertCursorAuthIsNotTeamManaged,
  sanitizeOptionalPrivateAuthFile,
} from "./profile-auth.js";
import {
  assertCursorPlatformEnterpriseHooksAbsent,
  copyOptionalFile,
  darwinLoginKeychainReadRoots,
  ensurePrivateProfileTree,
  escapeSandboxRegex,
  linkDarwinLoginKeychains,
  linkWindowsCursorLogin,
  removeWindowsCursorLogin,
  normalizePath,
  pruneCompletedCursorTurnJournals,
  purgeCursorMcpApprovalState,
  purgeCursorStatsigTemporaryFiles,
  removePrivateProfileAuthorityEntry,
  removePrivateProfileTreeEntry,
  writePrivateFileAtomic,
} from "./profile-filesystem.js";
import {
  assertWorkspaceDoesNotConfigureAnyCursorMcp,
  assertWorkspaceDoesNotConfigureLetAgentsMcp,
  cursorSupervisedMcpServerName,
  normalizeCursorMcpPolicy,
  supervisedCursorMcpEnvironment,
  writeManagedCursorMcpConfig,
} from "./profile-mcp-config.js";
import {
  CURSOR_AGENT_STATE_AUTH_KEYS,
  CURSOR_CLI_AUTH_KEYS,
  CURSOR_MCP_INSPECTION_PROBE_SOURCE,
  CURSOR_MCP_SOCKET_CONNECTOR_SOURCE,
  DARWIN_CURSOR_ENTERPRISE_HOOK_PATH,
  MAX_CURSOR_PROFILE_ENTRIES,
  SUPERVISED_CURSOR_PERMISSION_PROFILE_IDS,
  SUPERVISED_CURSOR_PROJECT_HIDDEN_AUTHORITY_FILES,
  type CursorManagedProfile,
  type CursorManagedProfileOptions,
  type CursorSupervisedProfileOptions,
} from "./profile-types.js";
import {
  assertWorkspaceDoesNotConfigureSupervisedCursorAuthority,
  canonicalizeAuthorityPath,
  cursorEffectiveProjectDirectories,
  cursorExactWorkspaceDirectory,
  cursorGitMarkerPath,
  cursorGitMetadataReadRoots,
  sandboxPathVariants,
} from "./profile-workspace-authority.js";

export { bindCursorSupervisedIdentity } from "./profile-auth.js";
export { removeCursorSupervisedProfile } from "./profile-filesystem.js";
export { assertWorkspaceDoesNotConfigureAnyCursorMcp, assertWorkspaceDoesNotConfigureLetAgentsMcp, cursorSupervisedMcpServerName, filterLetAgentsCursorMcpConfig, normalizeCursorMcpPolicy } from "./profile-mcp-config.js";
export { DEFAULT_CURSOR_MCP_POLICY } from "./profile-types.js";
export type { CursorManagedProfile, CursorManagedProfileOptions, CursorPersonalIdentity, CursorSupervisedProfileOptions } from "./profile-types.js";

/** Move the complete native conversation namespace only while its turn is
 * fenced. The caller owns the prepared/retired wrapper and generation journal.
 * Cursor indexes chat stores by md5(resolve(cwd)); stable HOME alone is not
 * sufficient when every writable turn gets a new physical workspace. */
export function relocateCursorConversationNamespace(
  profile: Pick<CursorManagedProfile, "configDir">,
  fromWorkspace: string,
  toWorkspace: string,
  expectedSessionId: string | null,
): void {
  if (expectedSessionId && (expectedSessionId.length > MAX_CURSOR_SESSION_ID_LENGTH || !CURSOR_SESSION_ID_PATTERN.test(expectedSessionId))) {
    throw new Error("Cursor conversation has an invalid session identity.");
  }
  const configRoot = join(profile.configDir, "cursor");
  const chatsRoot = join(configRoot, "chats");
  ensurePrivateProfileTree(dirname(profile.configDir), [profile.configDir, configRoot, chatsRoot]);
  const namespace = (workspace: string) => join(chatsRoot, createHash("md5").update(resolve(workspace)).digest("hex"));
  const source = namespace(fromWorkspace);
  const target = namespace(toWorkspace);
  const exists = (path: string) => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const sourceExists = exists(source);
  const targetExists = exists(target);
  if (source !== target && sourceExists && targetExists) throw new Error("Cursor conversation namespaces collide; continuation was not moved.");
  if (!sourceExists && !targetExists) {
    if (expectedSessionId) throw new Error("Cursor conversation store is missing; continuation was not moved.");
    return;
  }
  const present = sourceExists ? source : target;
  const pending = [present];
  let inspected = 0;
  // POSIX reads each entry's uid from its stat. Windows reads every owner in one call after the walk.
  const windows = ownerPrivatePlatform() === "win32";
  const owned: { path: string; info: Stats }[] = [];
  while (pending.length) {
    const path = pending.pop()!;
    const stat = lstatSync(path);
    if (++inspected > MAX_CURSOR_PROFILE_ENTRIES || stat.isSymbolicLink()
      || (!windows && !isOwnedByCurrentUserSync(path, stat)) || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error("Cursor conversation store contains unsupported or redirected entries.");
    }
    if (windows) owned.push({ path, info: stat });
    if (stat.isDirectory()) {
      const directory = opendirSync(path);
      try {
        for (;;) {
          const entry = directory.readSync();
          if (!entry) break;
          if (pending.length + inspected >= MAX_CURSOR_PROFILE_ENTRIES) throw new Error("Cursor conversation store is too large to validate safely.");
          pending.push(join(path, entry.name));
        }
      } finally { directory.closeSync(); }
    }
  }
  if (windows && !everyOwnedByCurrentUserSync(owned)) {
    throw new Error("Cursor conversation store contains unsupported or redirected entries.");
  }
  const sessionStore = expectedSessionId ? join(present, expectedSessionId, "store.db") : null;
  if (!lstatSync(present).isDirectory() || (sessionStore && (!exists(sessionStore) || !lstatSync(sessionStore).isFile()))) {
    throw new Error("Cursor conversation namespace does not contain the exact session store.");
  }
  if (sourceExists && source !== target) renameSyncWithRetry(source, target);
  // Windows cannot fsync a folder handle; NTFS journals the rename itself.
  if (windows) return;
  // Also sync an already-moved target: a crash can follow rename before fsync.
  const parent = openSync(chatsRoot, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
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

  ensurePrivateProfileTree(profileRoot, [homeDir, cursorHomeDir, configDir, dataDir, cacheDir, ...windowsProfileHomeFolders(homeDir)]);

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
  linkWindowsCursorLogin(sourceHomeDir, homeDir);

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
      ...windowsProfileHomeEnv(homeDir),
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
 * profile is stable across daemon restarts; the adapter moves its cwd-indexed
 * conversation namespace between isolated turns. Separate attempts run concurrently
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
  const projectDirectories = options.exactWorkspaceOnly
    ? [cursorExactWorkspaceDirectory(workspaceRoot)]
    : cursorEffectiveProjectDirectories(workspaceRoot);
  assertWorkspaceDoesNotConfigureSupervisedCursorAuthority(workspaceRoot, projectDirectories);
  assertCursorPlatformEnterpriseHooksAbsent();
  const supervisorMcpEnv = supervisedCursorMcpEnvironment(options.supervisorMcpEnv);
  const mcpConnectorSocketPath = normalizePath(options.mcpConnectorSocketPath);
  if (options.mcpConnectorSocketPath !== undefined
    && (!mcpConnectorSocketPath || !isCursorMcpConnectorSocketPath(mcpConnectorSocketPath))) {
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
    ...windowsProfileHomeFolders(homeDir),
    ...(mcpConnectorSocketPath ? [] : [
      bridgeRoot,
      bridgeHomeDir,
      bridgeConfigDir,
      bridgeDataDir,
      bridgeCacheDir,
    ]),
  ]);
  // Full access keeps Cursor's private HOME, but ordinary Git commands must
  // still discover the owner's identity, signing and credential helpers. Use
  // includes rather than copying credentials, in Git's normal precedence order.
  const gitConfigPath = join(homeDir, ".gitconfig");
  const sourceConfigDir = process.env.XDG_CONFIG_HOME || join(sourceHomeDir, ".config");
  if (permissionProfileId === "full_access") {
    writePrivateFileAtomic(gitConfigPath, [
      join(sourceConfigDir, "git", "config"),
      join(sourceHomeDir, ".gitconfig"),
    ].map(path => `[include]\n\tpath = ${JSON.stringify(path)}\n`).join(""));
  } else {
    removePrivateProfileAuthorityEntry(gitConfigPath);
  }
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
        // Windows: the wrapper listens on a named pipe for this socket path.
        args: process.platform === "win32"
          ? cursorMcpPipeConnectorArgs(mcpConnectorSocketPath)
          : ["-e", CURSOR_MCP_SOCKET_CONNECTOR_SOURCE, mcpConnectorSocketPath],
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
    linkWindowsCursorLogin(sourceHomeDir, homeDir);
  } else {
    removePrivateProfileTreeEntry(join(homeDir, "Library", "Keychains"));
    removeWindowsCursorLogin(homeDir);
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
  // Seatbelt regexes exist only for sandbox-exec; Windows has no sandbox to
  // give them to, and its backslash paths cannot be written as one.
  const seatbeltRegexes = cursorOsSandbox() !== "windows-unsandboxed";
  const nativeDeniedReadWriteRegexes = !seatbeltRegexes ? [] : [
    ...statsigCachePaths.map((statsigCachePath) =>
      `^${escapeSandboxRegex(statsigCachePath)}[.][0-9]+[.][0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}[.]tmp$`),
    // Defense in depth for --approve-mcps (which auto-approves every MCP
    // cursor-agent can read): projectDirectories only spans git-root..workspace,
    // so the per-directory literal deny above does NOT cover a .cursor/mcp.json
    // nested strictly BELOW --workspace, and the workspace tree is read-allowed.
    // Deny reading any such nested MCP config so a repo-planted server can never
    // be discovered, let alone approved -- independent of the CLI's (version-
    // specific) MCP discovery scope. Verified: cursor-agent 2026.07.09 does not
    // descend below --workspace, but this keeps the guarantee if that changes.
    ...[...new Set(sandboxPathVariants(workspaceRoot))].map((root) =>
      `^${escapeSandboxRegex(root)}/.*/[.]cursor/mcp[.]json$`),
  ];
  const gitMetadataReadRoots = options.exactWorkspaceOnly
    ? []
    : cursorGitMetadataReadRoots(workspaceRoot);
  const gitAuthorityRoots = [...new Set(gitMetadataReadRoots.flatMap(sandboxPathVariants))];
  const gitMarkerPath = options.exactWorkspaceOnly
    ? null
    : cursorGitMarkerPath(workspaceRoot);
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
  const nativeDeniedWriteRegexes = !seatbeltRegexes ? [] : [...new Set(gitAuthorityRoots.flatMap((gitRoot) => {
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
      ...windowsProfileHomeEnv(homeDir, tempDir),
      ...(permissionProfileId === "full_access" ? {
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || join(sourceConfigDir, "gh"),
      } : {}),
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

/** The exact one-turn connector path supervised-turn-preparation makes: `<parent>/letagents-cursor-mcp-<uuid>/stdio.sock`. */
function isCursorMcpConnectorSocketPath(path: string): boolean {
  if (process.platform !== "win32") {
    return /^\/tmp\/letagents-cursor-mcp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/stdio[.]sock$/.test(path);
  }
  return basename(path) === "stdio.sock"
    && new RegExp(cursorMcpConnectorRootPattern(CURSOR_MCP_CONNECTOR_PARENT, "win32")).test(dirname(path));
}

/**
 * Windows programs find the home folder through USERPROFILE (os.homedir())
 * and their settings through APPDATA and LOCALAPPDATA, not HOME. Point them
 * into the private profile too, so Cursor reads the sealed ~/.cursor there,
 * never the owner's own MCP servers and permissions.
 */
function windowsProfileHomeEnv(homeDir: string, tempDir?: string): Record<string, string> {
  if (process.platform !== "win32") return {};
  return {
    USERPROFILE: homeDir,
    APPDATA: join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(homeDir, "AppData", "Local"),
    ...(tempDir ? { TEMP: tempDir, TMP: tempDir } : {}),
  };
}

function windowsProfileHomeFolders(homeDir: string): string[] {
  if (process.platform !== "win32") return [];
  return [join(homeDir, "AppData"), join(homeDir, "AppData", "Roaming"), join(homeDir, "AppData", "Local")];
}
