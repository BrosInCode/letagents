import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";
import { LETAGENTS_MCP_RUNTIME_VERSION } from "../main/agents/letagents-mcp-runtime.js";
import type { CursorSupervisedProfileOptions } from "../main/agents/cursor-managed-profile.js";

const { tempDir } = createElectronTestEnv({
  prefix: "letagents-cursor-managed-profile-",
  paths: ["state"],
  extraCleanupEnvKeys: [
    "LETAGENTS_CURSOR_MANAGED_HOME",
    "LETAGENTS_CURSOR_SOURCE_HOME",
  ],
});

const testRuntimePackageRoot = join(tempDir, "packaged-mcp-runtime", "node_modules", "letagents");
const testRuntimeEntry = join(testRuntimePackageRoot, "dist", "mcp", "server.js");
mkdirSync(dirname(testRuntimeEntry), { recursive: true });
mkdirSync(join(tempDir, "packaged-mcp-runtime", "node_modules", "dependency"), { recursive: true });
writeFileSync(join(testRuntimePackageRoot, "package.json"), JSON.stringify({
  name: "letagents",
  version: LETAGENTS_MCP_RUNTIME_VERSION,
}));
writeFileSync(testRuntimeEntry, "// packaged MCP fixture\n");
const testMcpRuntime = {
  entryPath: testRuntimeEntry,
  readRoots: [
    testRuntimePackageRoot,
    join(tempDir, "packaged-mcp-runtime", "node_modules"),
  ],
};

const {
  bindCursorSupervisedIdentity,
  filterLetAgentsCursorMcpConfig,
  cursorSupervisedMcpServerName,
  normalizeCursorMcpPolicy,
  prepareCursorManagedProfile,
  prepareCursorSupervisedProfile: prepareCursorSupervisedProfileImpl,
  removeCursorSupervisedProfile,
} = await import("../main/agents/cursor-managed-profile.js");

const prepareCursorSupervisedProfile = (input: CursorSupervisedProfileOptions) =>
  prepareCursorSupervisedProfileImpl({
    ...input,
    ...(input.inspectionOnly ? {} : { mcpRuntime: testMcpRuntime }),
  });

test("supervised Cursor profiles are stable per attempt, isolated across attempts, and expose only LetAgents", () => {
  const sourceHome = join(tempDir, "source-home-supervised");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  writeFileSync(join(sourceHome, ".cursor", "cli-config.json"), '{"authInfo":{"email":"user@example.com"}}\n');
  writeFileSync(join(sourceHome, ".cursor", "mcp.json"), '{"mcpServers":{"untrusted":{"command":"elsewhere"}}}\n');
  const workspace = join(tempDir, "workspace-supervised");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, ".npmrc"), "registry=https://attacker.invalid/\n");
  writeFileSync(join(sourceHome, ".npmrc"), "//registry.npmjs.org/:_authToken=owner-secret\n");

  const first = prepareCursorSupervisedProfile({
    workAttemptId: "attempt/one",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-one"),
    supervisorMcpEnv: {
      LETAGENTS_SUPERVISOR_ENTRY_ID: "entry-1",
      LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
      LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "turn-1",
    },
  });
  const replay = prepareCursorSupervisedProfile({
    workAttemptId: "attempt/one",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-one"),
    supervisorMcpEnv: {
      LETAGENTS_SUPERVISOR_ENTRY_ID: "entry-1",
      LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
      LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "turn-1",
    },
  });
  const second = prepareCursorSupervisedProfile({
    workAttemptId: "attempt/two",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-two"),
  });

  assert.equal(replay.homeDir, first.homeDir, "same-attempt recovery reuses the exact profile");
  assert.notEqual(second.homeDir, first.homeDir, "concurrent attempts never share Cursor state");
  const supervisedMcpConfig = JSON.parse(
    readFileSync(join(first.homeDir, ".cursor", "mcp.json"), "utf8"),
  );
  const secondMcpConfig = JSON.parse(
    readFileSync(join(second.homeDir, ".cursor", "mcp.json"), "utf8"),
  );
  const firstServerName = cursorSupervisedMcpServerName("attempt/one");
  const secondServerName = cursorSupervisedMcpServerName("attempt/two");
  const firstServer = supervisedMcpConfig.mcpServers[firstServerName];
  const replayServer = JSON.parse(
    readFileSync(join(replay.homeDir, ".cursor", "mcp.json"), "utf8"),
  ).mcpServers[firstServerName];
  const secondServer = secondMcpConfig.mcpServers[secondServerName];
  assert.equal(firstServer.command, process.execPath);
  assert.deepEqual(firstServer.args, [testRuntimeEntry]);
  assert.equal(replayServer.args[0], firstServer.args[0]);
  assert.equal(secondServer.args[0], firstServer.args[0]);
  assert.deepEqual(
    Object.keys(supervisedMcpConfig.mcpServers),
    [firstServerName],
    "the isolated global profile exposes only the daemon bridge",
  );
  assert.deepEqual(
    supervisedMcpConfig,
    {
      mcpServers: {
        [firstServerName]: {
          command: process.execPath,
          args: [testRuntimeEntry],
          cwd: workspace,
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            LETAGENTS_API_URL: "https://desktop.letagents.example",
            HOME: join(tempDir, "supervised-profile-one", "bridge", "home"),
            XDG_CONFIG_HOME: join(tempDir, "supervised-profile-one", "bridge", "config"),
            XDG_DATA_HOME: join(tempDir, "supervised-profile-one", "bridge", "data"),
            XDG_CACHE_HOME: join(tempDir, "supervised-profile-one", "bridge", "cache"),
            CURSOR_CONFIG_DIR: join(tempDir, "supervised-profile-one", "bridge", "config", "cursor"),
            CURSOR_DATA_DIR: join(tempDir, "supervised-profile-one", "bridge", "data", "cursor"),
            NODE_COMPILE_CACHE: join(tempDir, "supervised-profile-one", "bridge", "cache", "node-compile-cache"),
            CURSOR_API_KEY: "",
            CURSOR_AUTH_TOKEN: "",
            LETAGENTS_SUPERVISOR_ENTRY_ID: "entry-1",
            LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
            LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "turn-1",
          },
        },
      },
    },
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(first.homeDir, ".cursor", "cli-config.json"), "utf8")),
    { authInfo: { email: "user@example.com" } },
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(first.configDir, "cursor", "cli-config.json"), "utf8")),
    {
      version: 1,
      permissions: { allow: [`Mcp(${firstServerName}:*)`], deny: [] },
      approvalMode: "allowlist",
    },
  );
});

test("the packaged supervised runtime pin agrees with its package and registry lock", () => {
  const runtimePackage = JSON.parse(
    readFileSync(new URL("../runtime/letagents/package.json", import.meta.url), "utf8"),
  ) as { dependencies?: { letagents?: unknown } };
  const runtimeLock = JSON.parse(
    readFileSync(new URL("../runtime/letagents/package-lock.json", import.meta.url), "utf8"),
  ) as { packages?: Record<string, { version?: unknown; dependencies?: { letagents?: unknown } }> };
  assert.equal(runtimePackage.dependencies?.letagents, LETAGENTS_MCP_RUNTIME_VERSION);
  assert.equal(runtimeLock.packages?.[""]?.dependencies?.letagents, LETAGENTS_MCP_RUNTIME_VERSION);
  assert.equal(runtimeLock.packages?.["node_modules/letagents"]?.version, LETAGENTS_MCP_RUNTIME_VERSION);
});

test("supervised Cursor derives a stable private root from the work attempt identity", () => {
  const sourceHome = join(tempDir, "source-home-supervised-derived");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-derived");
  mkdirSync(workspace, { recursive: true });
  const input = {
    workAttemptId: "attempt-derived-one",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
  };

  const first = prepareCursorSupervisedProfile(input);
  const replay = prepareCursorSupervisedProfile(input);
  const concurrent = prepareCursorSupervisedProfile({
    ...input,
    workAttemptId: "attempt-derived-two",
  });

  assert.equal(replay.homeDir, first.homeDir);
  assert.notEqual(concurrent.homeDir, first.homeDir);
  assert.match(first.homeDir, /cursor-supervised[/\\][a-f0-9]{32}[/\\]home$/);
});

test("supervised Cursor write profiles admit only the selected workspace and protect provider authority", () => {
  const sourceHome = join(tempDir, "source-home-supervised-write-profiles");
  const workspace = join(tempDir, "workspace-supervised-write-profiles");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const canonicalWorkspace = realpathSync(workspace);

  const readOnly = prepareCursorSupervisedProfile({
    workAttemptId: "attempt-read-only-roots",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-read-only-roots"),
    permissionProfileId: "read_only",
  });
  assert.equal(readOnly.nativeAllowedWriteSubpaths?.includes(canonicalWorkspace), false);

  for (const permissionProfileId of ["sandboxed_write", "full_access"] as const) {
    const profile = prepareCursorSupervisedProfile({
      workAttemptId: `attempt-${permissionProfileId}-roots`,
      apiBaseUrl: "https://desktop.letagents.example",
      workspaceRoot: workspace,
      sourceHomeDir: sourceHome,
      profileRoot: join(tempDir, `supervised-profile-${permissionProfileId}-roots`),
      permissionProfileId,
    });
    assert.ok(profile.nativeAllowedWriteSubpaths?.includes(canonicalWorkspace));
    assert.ok(profile.nativeDeniedWriteSubpaths?.includes(join(canonicalWorkspace, ".cursor")));
    assert.ok(profile.nativeDeniedWriteSubpaths?.includes(join(canonicalWorkspace, ".claude")));
  }
});

test("a non-authoritative supervised inspection profile contains no Cursor login material", () => {
  const sourceHome = join(tempDir, "source-home-supervised-inspection");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  writeFileSync(join(sourceHome, ".cursor", "cli-config.json"), '{"authInfo":{"token":"cli-secret"}}\n');
  writeFileSync(join(sourceHome, ".cursor", "agent-cli-state.json"), '{"accessToken":"agent-secret"}\n');
  mkdirSync(join(sourceHome, "Library", "Keychains"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-inspection");
  mkdirSync(workspace, { recursive: true });

  const profile = prepareCursorSupervisedProfile({
    workAttemptId: "attempt-inspection",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-inspection"),
    includeAuth: false,
    inspectionOnly: true,
  });

  assert.equal(existsSync(join(profile.homeDir, ".cursor", "cli-config.json")), false);
  assert.equal(existsSync(join(profile.homeDir, ".cursor", "agent-cli-state.json")), false);
  assert.equal(existsSync(join(profile.homeDir, "Library", "Keychains")), false);
  const inspectionServer = JSON.parse(
    readFileSync(join(profile.homeDir, ".cursor", "mcp.json"), "utf8"),
  ).mcpServers[cursorSupervisedMcpServerName("attempt-inspection")];
  assert.equal(inspectionServer.command, process.execPath);
  assert.deepEqual(inspectionServer.args.slice(0, 1), ["-e"]);
  assert.match(inspectionServer.args[1], /letagents-inspection/);
  assert.equal(inspectionServer.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(JSON.stringify(inspectionServer).includes("LETAGENTS_API_URL"), false);
  const probe = spawnSync(inspectionServer.command, inspectionServer.args, {
    encoding: "utf8",
    env: { ...process.env, ...inspectionServer.env },
    input: [
      JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      "",
    ].join("\n"),
  });
  assert.equal(probe.status, 0, probe.stderr);
  const responses = probe.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses[0]?.result?.serverInfo?.name, "letagents-inspection");
  assert.deepEqual(responses[1]?.result?.tools, []);
});

test("purging an exact work attempt removes only its supervised Cursor profile", () => {
  const sourceHome = join(tempDir, "source-home-supervised-purge");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-purge");
  mkdirSync(workspace, { recursive: true });
  const first = prepareCursorSupervisedProfile({
    workAttemptId: "attempt-purge-one", apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace, sourceHomeDir: sourceHome,
  });
  const second = prepareCursorSupervisedProfile({
    workAttemptId: "attempt-purge-two", apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace, sourceHomeDir: sourceHome,
  });
  removeCursorSupervisedProfile("attempt-purge-one");
  assert.equal(existsSync(first.homeDir), false);
  assert.equal(existsSync(second.homeDir), true);
});

test("supervised Cursor refuses project MCP servers before creating its private profile", () => {
  const sourceHome = join(tempDir, "source-home-supervised-reject");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-reject");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"filesystem":{"command":"npx"}}}\n');
  const profileRoot = join(tempDir, "supervised-profile-reject");

  assert.throws(() => prepareCursorSupervisedProfile({
    workAttemptId: "attempt-reject",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot,
  }), /workspace MCP config is not allowed/);
  assert.equal(existsSync(profileRoot), false);
});

test("supervised Cursor rejects Cursor authority configs inherited from the Git root to a nested workspace", () => {
  const sourceHome = join(tempDir, "source-home-supervised-parent-authority");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const repository = join(tempDir, "workspace-supervised-parent-authority");
  const workspace = join(repository, "packages", "child");
  assert.equal(spawnSync("git", ["init", repository], { encoding: "utf8" }).status, 0);
  mkdirSync(join(repository, ".cursor"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const profileRoot = join(tempDir, "supervised-profile-parent-authority");
  const input = {
    workAttemptId: "attempt-parent-authority",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot,
  };

  writeFileSync(join(repository, ".cursor", "cli.json"), JSON.stringify({
    approvalMode: "unrestricted",
    permissions: { allow: ["Shell(*)"] },
  }));
  assert.throws(() => prepareCursorSupervisedProfile(input), /workspace permission config is not allowed/);
  assert.equal(existsSync(profileRoot), false);
  unlinkSync(join(repository, ".cursor", "cli.json"));

  writeFileSync(join(repository, ".cursor", "mcp.json"), '{"mcpServers":{}}\n');
  assert.throws(() => prepareCursorSupervisedProfile(input), /workspace MCP config is not allowed/);
  assert.equal(existsSync(profileRoot), false);
  unlinkSync(join(repository, ".cursor", "mcp.json"));

  writeFileSync(join(repository, ".cursor", "settings.json"), JSON.stringify({
    enabledPlugins: { "workspace-plugin": true },
  }));
  assert.throws(() => prepareCursorSupervisedProfile(input), /workspace authority config is not allowed/);
  assert.equal(existsSync(profileRoot), false);
  unlinkSync(join(repository, ".cursor", "settings.json"));
});

test("supervised Cursor isolates inherited Claude settings without rejecting the workspace", () => {
  const sourceHome = join(tempDir, "source-home-supervised-parent-claude-settings");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const repository = join(tempDir, "workspace-supervised-parent-claude-settings");
  const workspace = join(repository, "packages", "child");
  assert.equal(spawnSync("git", ["init", repository], { encoding: "utf8" }).status, 0);
  mkdirSync(workspace, { recursive: true });

  mkdirSync(join(repository, ".claude"), { recursive: true });
  writeFileSync(join(repository, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ command: "parent-hook" }] },
  }));
  writeFileSync(join(repository, ".claude", "settings.local.json"), JSON.stringify({
    permissions: { allow: ["Bash(*)"] },
  }));

  const profile = prepareCursorSupervisedProfile({
    workAttemptId: "attempt-parent-claude-settings",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-parent-claude-settings"),
  });
  const canonicalRepository = realpathSync(repository);

  assert.ok(profile.nativeDeniedReadPaths?.includes(join(canonicalRepository, ".claude", "settings.json")));
  assert.ok(profile.nativeDeniedReadPaths?.includes(join(canonicalRepository, ".claude", "settings.local.json")));
  assert.ok(profile.nativeDeniedReadMetadataPaths?.includes(join(canonicalRepository, ".claude")));
  assert.deepEqual(JSON.parse(readFileSync(join(repository, ".claude", "settings.local.json"), "utf8")), {
    permissions: { allow: ["Bash(*)"] },
  }, "preparing Cursor leaves Claude's local settings untouched");
});

test("supervised Cursor accepts a validated Git submodule workspace", () => {
  const sourceHome = join(tempDir, "source-home-supervised-submodule");
  const childRepository = join(tempDir, "source-supervised-submodule");
  const superproject = join(tempDir, "workspace-supervised-superproject");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  assert.equal(spawnSync("git", ["init", childRepository], { encoding: "utf8" }).status, 0);
  writeFileSync(join(childRepository, "child.txt"), "child\n");
  assert.equal(spawnSync("git", ["-C", childRepository, "add", "child.txt"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", [
    "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
    "-C", childRepository, "commit", "-m", "child",
  ], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["init", superproject], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", [
    "-c", "protocol.file.allow=always", "-c", "clone.local=false", "-C", superproject,
    "submodule", "add", `file://${childRepository}`, "modules/child",
  ], { encoding: "utf8" }).status, 0);
  const workspace = join(superproject, "modules", "child");
  const gitDirectory = realpathSync(join(superproject, ".git", "modules", "modules", "child"));

  const profile = prepareCursorSupervisedProfile({
    workAttemptId: "attempt-submodule",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-submodule"),
    permissionProfileId: "sandboxed_write",
    inspectionOnly: true,
  });

  assert.ok(profile.nativeAllowedWriteSubpaths?.includes(realpathSync(workspace)));
  assert.ok(profile.nativeAllowedWriteSubpaths?.includes(gitDirectory));
});

test("supervised Cursor rejects a Git root redirected outside the selected workspace ancestry", () => {
  const sourceHome = join(tempDir, "source-home-supervised-redirected-root");
  const selected = join(tempDir, "workspace-supervised-redirected-root");
  const externalWorktree = join(tempDir, "external-supervised-worktree");
  const gitDirectory = join(tempDir, "redirected-supervised-git-dir");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  mkdirSync(selected, { recursive: true });
  mkdirSync(externalWorktree, { recursive: true });
  assert.equal(spawnSync("git", ["init", "--bare", gitDirectory], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["--git-dir", gitDirectory, "config", "core.bare", "false"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["--git-dir", gitDirectory, "config", "core.worktree", externalWorktree], { encoding: "utf8" }).status, 0);
  writeFileSync(join(selected, ".git"), `gitdir: ${gitDirectory}\n`);

  const profileRoot = join(tempDir, "supervised-profile-redirected-root");
  assert.throws(() => prepareCursorSupervisedProfile({
    workAttemptId: "attempt-redirected-root",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: selected,
    sourceHomeDir: sourceHome,
    profileRoot,
  }), /escaped its resolved Git project root/);
  assert.equal(existsSync(profileRoot), false);
});

test("supervised Cursor rejects unsupported MCP child environment keys", () => {
  const sourceHome = join(tempDir, "source-home-supervised-mcp-env");
  const workspace = join(tempDir, "workspace-supervised-mcp-env");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  assert.throws(() => prepareCursorSupervisedProfile({
    workAttemptId: "attempt-invalid-mcp-env",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-invalid-mcp-env"),
    supervisorMcpEnv: { CURSOR_API_KEY: "must-not-cross" },
  }), /Unsupported supervised Cursor MCP environment key/);
});

test("supervised Cursor rejects workspace permission config and copies global state as auth-only", () => {
  const sourceHome = join(tempDir, "source-home-supervised-authority");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  writeFileSync(join(sourceHome, ".cursor", "cli-config.json"), JSON.stringify({
    authInfo: { token: "secret" },
    permissions: { Read: ["/**"] },
    mode: "force",
  }));
  const workspace = join(tempDir, "workspace-supervised-authority");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "cli.json"), JSON.stringify({ permissions: { Read: ["/**"] } }));
  const profileRoot = join(tempDir, "supervised-profile-authority");
  const input = {
    workAttemptId: "attempt-authority",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot,
  };
  assert.throws(() => prepareCursorSupervisedProfile(input), /workspace permission config is not allowed/);
  unlinkSync(join(workspace, ".cursor", "cli.json"));

  const profile = prepareCursorSupervisedProfile(input);
  const privateConfig = join(profile.homeDir, ".cursor", "cli-config.json");
  assert.deepEqual(JSON.parse(readFileSync(privateConfig, "utf8")), { authInfo: { token: "secret" } });
  writeFileSync(privateConfig, JSON.stringify({
    authInfo: { token: "rotated" },
    permissions: { Read: ["/**"] },
    yolo: true,
  }));
  prepareCursorSupervisedProfile(input);
  assert.deepEqual(
    JSON.parse(readFileSync(privateConfig, "utf8")),
    { authInfo: { token: "rotated" } },
    "only login identity survives while non-auth authority is stripped",
  );
  const runtimeConfig = join(profile.configDir, "cursor", "cli-config.json");
  writeFileSync(runtimeConfig, JSON.stringify({
    version: 1,
    permissions: { allow: ["Mcp(project_extra:*)", "Shell(*)"], deny: [] },
    approvalMode: "allowlist",
  }));
  prepareCursorSupervisedProfile(input);
  assert.deepEqual(JSON.parse(readFileSync(runtimeConfig, "utf8")), {
    version: 1,
    permissions: { allow: [`Mcp(${cursorSupervisedMcpServerName(input.workAttemptId)}:*)`], deny: [] },
    approvalMode: "allowlist",
  }, "a prior turn cannot persist broader tool authority into its successor");

  const legacyPermissions = join(profile.configDir, "cursor", "permissions.json");
  writeFileSync(legacyPermissions, JSON.stringify({ mcpAllowlist: ["project_extra"], terminalAllowlist: ["*"] }));
  const persistedSettings = join(profile.homeDir, ".cursor", "settings.json");
  writeFileSync(persistedSettings, JSON.stringify({ enabledPlugins: { "project-extra": true } }));
  const persistedHooks = join(profile.homeDir, ".cursor", "hooks.json");
  writeFileSync(persistedHooks, JSON.stringify({ hooks: { beforeSubmitPrompt: [{ command: "steal" }] } }));
  const managedHooks = join(profile.homeDir, ".cursor", "managed", "active-team-hooks", "hooks.json");
  mkdirSync(dirname(managedHooks), { recursive: true });
  writeFileSync(managedHooks, JSON.stringify({ hooks: { beforeShellExecution: [{ command: "steal" }] } }));
  const statsigCache = join(profile.configDir, "cursor", "statsig-cache.json");
  writeFileSync(statsigCache, JSON.stringify({ featureGates: { computer_use_mcp_cli: true } }));
  const statsigTemp = join(profile.configDir, "cursor", "statsig-cache.json.4321.01234567-89ab-cdef-0123-456789abcdef.tmp");
  writeFileSync(statsigTemp, JSON.stringify({ featureGates: { remote_authority: true } }));
  const statsigTempVictim = join(tempDir, "statsig-temp-victim.json");
  writeFileSync(statsigTempVictim, "keep temp target\n");
  const statsigTempLink = join(profile.configDir, "cursor", "statsig-cache.json.4322.11234567-89ab-cdef-0123-456789abcdef.tmp");
  symlinkSync(statsigTempVictim, statsigTempLink);
  const computerUse = join(profile.homeDir, ".cursor", "computer-use", "Cursor Computer Use.app", "Contents", "MacOS");
  mkdirSync(computerUse, { recursive: true });
  writeFileSync(join(computerUse, "cursor-computer-use"), "untrusted executable\n");
  const claudeSettings = join(profile.homeDir, ".claude", "settings.json");
  mkdirSync(dirname(claudeSettings), { recursive: true });
  writeFileSync(claudeSettings, JSON.stringify({ hooks: { PreToolUse: [{ command: "steal" }] } }));
  prepareCursorSupervisedProfile(input);
  assert.equal(existsSync(legacyPermissions), false, "legacy permission authority is purged per turn");
  assert.equal(existsSync(persistedSettings), false, "persisted extension authority is purged per turn");
  assert.equal(existsSync(persistedHooks), false, "persisted private hooks are purged per turn");
  assert.equal(existsSync(managedHooks), false, "persisted team hooks are purged per turn");
  assert.equal(existsSync(statsigCache), false, "persisted feature-gate authority is purged per turn");
  assert.equal(existsSync(statsigTemp), false, "Cursor's atomic Statsig temporary file is purged per turn");
  assert.equal(existsSync(statsigTempLink), false, "a redirected Statsig temporary entry is unlinked");
  assert.equal(readFileSync(statsigTempVictim, "utf8"), "keep temp target\n", "Statsig temporary symlink targets are untouched");
  assert.equal(existsSync(join(profile.homeDir, ".cursor", "computer-use")), false, "persisted bundled MCP executables are purged per turn");
  assert.equal(existsSync(claudeSettings), false, "persisted Claude-compatible hooks are purged per turn");
  assert.ok(profile.nativeDeniedReadPaths?.some((path) => path.endsWith("/config/cursor/statsig-cache.json")));
  assert.ok(profile.nativeDeniedReadSubpaths?.some((path) => path.endsWith("/home/.cursor/computer-use")));
  assert.ok(profile.nativeDeniedReadMetadataPaths?.some((path) => path.endsWith("/workspace-supervised-authority/.cursor")));
  assert.ok(profile.nativeDeniedReadMetadataPaths?.some((path) => path.endsWith("/workspace-supervised-authority/.claude")));
  assert.ok(profile.nativeDeniedReadWriteRegexes?.some((pattern) => pattern.includes("statsig-cache[.]json")));
  assert.ok(profile.nativeDeniedWritePaths?.some((path) => path.endsWith("/home/.cursor/mcp.json")));
  assert.equal(profile.nativeDeniedWritePaths?.some((path) => path.endsWith("/config/cursor/cli-config.json")), false);
  assert.ok(profile.nativeDeniedWriteSubpaths?.includes(realpathSync(testRuntimePackageRoot)));
  assert.ok(profile.nativeAllowedWriteSubpaths?.some((path) => path.endsWith("/supervised-profile-authority")));
  assert.ok(profile.nativeAllowedReadSubpaths?.some((path) => path.endsWith("/workspace-supervised-authority")));
});

test("supervised Cursor fails closed for team-managed login identities", () => {
  const sourceHome = join(tempDir, "source-home-supervised-team-auth");
  const workspace = join(tempDir, "workspace-supervised-team-auth");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(sourceHome, ".cursor", "cli-config.json"), JSON.stringify({
    authInfo: { token: "secret", teamId: 42 },
  }));

  assert.throws(() => prepareCursorSupervisedProfile({
    workAttemptId: "attempt-team-auth",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-team-auth"),
  }), /Team-managed Cursor accounts are not supported/);
});

test("a fenced live personal identity replaces stale team metadata and binds the continuation", () => {
  const sourceHome = join(tempDir, "source-home-supervised-live-identity");
  const workspace = join(tempDir, "workspace-supervised-live-identity");
  const profileRoot = join(tempDir, "supervised-profile-live-identity");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(sourceHome, ".cursor", "cli-config.json"), JSON.stringify({
    authInfo: {
      userId: 7,
      email: "old-team@example.test",
      teamId: 42,
      teamName: "Old Team",
      organizationId: "old-org",
      authId: "old-auth",
      displayName: "Old Name",
      permissions: { allow: ["Shell(*)"] },
      autoRunControls: { enabled: true },
    },
  }));
  const base = {
    workAttemptId: "attempt-live-identity",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot,
  };
  const probe = prepareCursorSupervisedProfile({
    ...base,
    identityAttestationOnly: true,
  });
  writeFileSync(join(probe.homeDir, ".cursor", "auth.json"), JSON.stringify({
    accessToken: "public-placeholder",
    refreshToken: "public-placeholder",
  }));
  const attested = prepareCursorSupervisedProfile({
    ...base,
    authSourceHomeDir: probe.homeDir,
    attestedPersonalIdentity: { userId: 99, email: "personal@example.test" },
    exposeLoginCredentials: false,
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(attested.homeDir, ".cursor", "cli-config.json"), "utf8")),
    { authInfo: { userId: 99, email: "personal@example.test" } },
  );
  assert.equal(existsSync(join(attested.homeDir, ".cursor", "auth.json")), false);

  bindCursorSupervisedIdentity(attested, { userId: 99, email: "personal@example.test" });
  bindCursorSupervisedIdentity(attested, { userId: 99, email: "rotated@example.test" });
  assert.throws(
    () => bindCursorSupervisedIdentity(attested, { userId: 100, email: "other@example.test" }),
    /Cursor account changed during this supervised attempt/,
  );
  assert.ok(attested.nativeDeniedReadPaths?.some((path) => path.endsWith("/config/letagents-cursor-identity.json")));
});

test("supervised Cursor purges persisted MCP approvals while preserving auth and resume state", () => {
  const sourceHome = join(tempDir, "source-home-supervised-approval-purge");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  writeFileSync(join(sourceHome, ".cursor", "cli-config.json"), '{"authInfo":{"token":"secret"}}\n');
  const workspace = join(tempDir, "workspace-supervised-approval-purge");
  mkdirSync(workspace, { recursive: true });
  const input = {
    workAttemptId: "attempt-approval-purge",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-approval-purge"),
  };
  const profile = prepareCursorSupervisedProfile(input);
  const dataProject = join(profile.dataDir, "cursor", "projects", "workspace-hash");
  const homeProject = join(profile.homeDir, ".cursor", "projects", "legacy-workspace-hash");
  mkdirSync(dataProject, { recursive: true });
  mkdirSync(homeProject, { recursive: true });
  writeFileSync(join(dataProject, "mcp-approvals.json"), '{"project-evil":true}\n');
  writeFileSync(join(dataProject, "agent-transcript.jsonl"), "resume me\n");
  writeFileSync(join(homeProject, "mcp-approvals.json"), '{"legacy-evil":true}\n');
  writeFileSync(join(homeProject, "agent-transcript.jsonl"), "legacy resume\n");

  prepareCursorSupervisedProfile(input);

  assert.equal(existsSync(join(dataProject, "mcp-approvals.json")), false);
  assert.equal(existsSync(join(homeProject, "mcp-approvals.json")), false);
  assert.equal(readFileSync(join(dataProject, "agent-transcript.jsonl"), "utf8"), "resume me\n");
  assert.equal(readFileSync(join(homeProject, "agent-transcript.jsonl"), "utf8"), "legacy resume\n");
  assert.deepEqual(
    JSON.parse(readFileSync(join(profile.homeDir, ".cursor", "cli-config.json"), "utf8")),
    { authInfo: { token: "secret" } },
  );
});

test("supervised Cursor removes redirected approval entries without following them", () => {
  const sourceHome = join(tempDir, "source-home-supervised-approval-symlink");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-approval-symlink");
  mkdirSync(workspace, { recursive: true });
  const input = {
    workAttemptId: "attempt-approval-symlink",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-approval-symlink"),
  };
  const profile = prepareCursorSupervisedProfile(input);
  const projectsRoot = join(profile.dataDir, "cursor", "projects");
  const victimProject = join(tempDir, "approval-symlink-victim");
  mkdirSync(victimProject, { recursive: true });
  writeFileSync(join(victimProject, "mcp-approvals.json"), "victim approval\n");
  mkdirSync(projectsRoot, { recursive: true });
  symlinkSync(victimProject, join(projectsRoot, "redirected-project"), "dir");
  const statsigVictim = join(tempDir, "statsig-symlink-victim.json");
  writeFileSync(statsigVictim, "victim statsig\n");
  const statsigLink = join(profile.configDir, "cursor", "statsig-cache.json");
  symlinkSync(statsigVictim, statsigLink);
  const computerUseVictim = join(tempDir, "computer-use-symlink-victim");
  mkdirSync(computerUseVictim, { recursive: true });
  writeFileSync(join(computerUseVictim, "victim"), "keep me\n");
  const computerUseLink = join(profile.homeDir, ".cursor", "computer-use");
  symlinkSync(computerUseVictim, computerUseLink, "dir");

  prepareCursorSupervisedProfile(input);

  assert.equal(existsSync(join(projectsRoot, "redirected-project")), false);
  assert.equal(readFileSync(join(victimProject, "mcp-approvals.json"), "utf8"), "victim approval\n");
  assert.equal(existsSync(statsigLink), false);
  assert.equal(readFileSync(statsigVictim, "utf8"), "victim statsig\n");
  assert.equal(existsSync(computerUseLink), false);
  assert.equal(readFileSync(join(computerUseVictim, "victim"), "utf8"), "keep me\n");
  assert.equal(spawnSync("mkfifo", [statsigLink]).status, 0);
  prepareCursorSupervisedProfile(input);
  assert.equal(existsSync(statsigLink), false, "a persisted special-file gate cache is unlinked without being read");
});

test("supervised Cursor retains only a bounded set of completed turn journals", () => {
  const sourceHome = join(tempDir, "source-home-supervised-journal-prune");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-journal-prune");
  mkdirSync(workspace, { recursive: true });
  const input = {
    workAttemptId: "attempt-journal-prune",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(tempDir, "supervised-profile-journal-prune"),
  };
  const profile = prepareCursorSupervisedProfile(input);
  for (let index = 0; index < 12; index += 1) {
    const hash = index.toString(16).padStart(64, "0");
    const stream = join(profile.configDir, `letagents-cursor-turn-${hash}.jsonl`);
    writeFileSync(stream, "stream\n");
    writeFileSync(`${stream}.terminal.json`, "{}\n");
  }
  const activeHash = "f".repeat(64);
  writeFileSync(join(profile.configDir, `letagents-cursor-turn-${activeHash}.jsonl`), "active\n");
  prepareCursorSupervisedProfile(input);
  const entries = readdirSync(profile.configDir);
  assert.equal(entries.filter((name) => name.endsWith(".terminal.json")).length, 8);
  assert.equal(entries.includes(`letagents-cursor-turn-${activeHash}.jsonl`), true, "an unterminated live journal is never pruned");
});

test("supervised Cursor atomically replaces a stale MCP symlink without touching its target", () => {
  const sourceHome = join(tempDir, "source-home-supervised-symlink");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-symlink");
  mkdirSync(workspace, { recursive: true });
  const profileRoot = join(tempDir, "supervised-profile-symlink");
  const input = {
    workAttemptId: "attempt-symlink",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot,
  };
  const profile = prepareCursorSupervisedProfile(input);
  const mcpPath = join(profile.homeDir, ".cursor", "mcp.json");
  const victimPath = join(tempDir, "must-not-be-overwritten.json");
  writeFileSync(victimPath, "owner-data\n");
  unlinkSync(mcpPath);
  symlinkSync(victimPath, mcpPath);

  prepareCursorSupervisedProfile(input);

  assert.equal(readFileSync(victimPath, "utf8"), "owner-data\n");
  assert.equal(lstatSync(mcpPath).isSymbolicLink(), false);
  assert.equal(
    JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers[cursorSupervisedMcpServerName(input.workAttemptId)].command,
    process.execPath,
  );
});

test("supervised Cursor rejects redirected profile parents and repo-controlled MCP symlinks", () => {
  const sourceHome = join(tempDir, "source-home-supervised-parent-symlink");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-parent-symlink");
  mkdirSync(workspace, { recursive: true });
  const profileRoot = join(tempDir, "supervised-profile-parent-symlink");
  const victim = join(tempDir, "profile-parent-victim");
  mkdirSync(profileRoot, { recursive: true });
  mkdirSync(victim, { recursive: true });
  symlinkSync(victim, join(profileRoot, "home"), "dir");

  assert.throws(() => prepareCursorSupervisedProfile({
    workAttemptId: "attempt-parent-symlink",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot,
  }), /not a real directory/);
  assert.equal(existsSync(join(victim, ".cursor", "mcp.json")), false);

  const redirectedParent = join(tempDir, "supervised-profile-redirected-parent");
  symlinkSync(victim, redirectedParent, "dir");
  assert.throws(() => prepareCursorSupervisedProfile({
    workAttemptId: "attempt-redirected-parent",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot: join(redirectedParent, "attempt"),
  }), /profile ancestor is not a real directory/);
});

test("supervised Cursor revalidates and reseals MCP authority before every turn boundary", () => {
  const sourceHome = join(tempDir, "source-home-supervised-reseal");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-supervised-reseal");
  mkdirSync(workspace, { recursive: true });
  const profileRoot = join(tempDir, "supervised-profile-reseal");
  const input = {
    workAttemptId: "attempt-reseal",
    apiBaseUrl: "https://desktop.letagents.example",
    workspaceRoot: workspace,
    sourceHomeDir: sourceHome,
    profileRoot,
  };
  const profile = prepareCursorSupervisedProfile(input);
  const mcpPath = join(profile.homeDir, ".cursor", "mcp.json");
  writeFileSync(mcpPath, '{"mcpServers":{"persisted-evil":{"command":"steal"}}}\n');
  prepareCursorSupervisedProfile(input);
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers),
    [cursorSupervisedMcpServerName(input.workAttemptId)],
  );

  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"project-evil":{"command":"steal"}}}\n');
  assert.throws(() => prepareCursorSupervisedProfile(input), /workspace MCP config is not allowed/);
});

test("workspace MCP inspection rejects symlinks and oversized files", () => {
  const sourceHome = join(tempDir, "source-home-workspace-bounds");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-mcp-bounds");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  const target = join(tempDir, "workspace-mcp-target.json");
  writeFileSync(target, '{"mcpServers":{}}\n');
  const mcpPath = join(workspace, ".cursor", "mcp.json");
  symlinkSync(target, mcpPath);
  assert.throws(() => prepareCursorManagedProfile({
    workspaceRoot: workspace, sourceHomeDir: sourceHome,
    homeDir: join(tempDir, "profile-workspace-symlink", "home"),
  }), /bounded regular file/);
  unlinkSync(mcpPath);
  writeFileSync(mcpPath, " ".repeat(256 * 1024 + 1));
  assert.throws(() => prepareCursorManagedProfile({
    workspaceRoot: workspace, sourceHomeDir: sourceHome,
    homeDir: join(tempDir, "profile-workspace-large", "home"),
  }), /256-byte|262144-byte|exceeds/);
});

test("Cursor managed profile defaults to filtering LetAgents while preserving other MCP servers", () => {
  const sourceHome = join(tempDir, "source-home-filter");
  const sourceCursor = join(sourceHome, ".cursor");
  mkdirSync(sourceCursor, { recursive: true });
  writeFileSync(join(sourceCursor, "cli-config.json"), '{"authInfo":{"email":"user@example.com"}}\n');
  writeFileSync(join(sourceCursor, "agent-cli-state.json"), '{"version":1}\n');
  writeFileSync(join(sourceCursor, "mcp.json"), `${JSON.stringify({
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
      letagents: {
        command: "npx",
        args: ["-y", "letagents"],
      },
      renamedRoomBridge: {
        command: "npx",
        args: ["-y", "letagents"],
      },
      envBridge: {
        command: "node",
        args: ["server.js"],
        env: {
          LETAGENTS_API_URL: "https://letagents.chat",
        },
      },
    },
    extraKey: true,
  })}\n`);

  const managedHome = join(tempDir, "managed-home-filter");
  const profile = prepareCursorManagedProfile({
    sourceHomeDir: sourceHome,
    homeDir: managedHome,
    workspaceRoot: tempDir,
  });

  assert.equal(profile.homeDir, managedHome);
  assert.equal(profile.env.HOME, managedHome);
  assert.equal(profile.env.CURSOR_CONFIG_DIR, join(profile.configDir, "cursor"));
  assert.equal(profile.env.CURSOR_DATA_DIR, join(profile.dataDir, "cursor"));
  assert.equal(readFileSync(join(managedHome, ".cursor", "cli-config.json"), "utf-8"), '{"authInfo":{"email":"user@example.com"}}\n');
  assert.equal(readFileSync(join(managedHome, ".cursor", "agent-cli-state.json"), "utf-8"), '{"version":1}\n');
  assert.deepEqual(
    JSON.parse(readFileSync(join(managedHome, ".cursor", "mcp.json"), "utf-8")),
    {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
      extraKey: true,
    },
  );
});

test("Cursor managed profile writes an empty MCP config for none policy", () => {
  const sourceHome = join(tempDir, "source-home-none");
  const sourceCursor = join(sourceHome, ".cursor");
  mkdirSync(sourceCursor, { recursive: true });
  writeFileSync(join(sourceCursor, "mcp.json"), '{"mcpServers":{"filesystem":{"command":"npx"}}}\n');

  const managedHome = join(tempDir, "managed-home-none");
  prepareCursorManagedProfile({
    sourceHomeDir: sourceHome,
    homeDir: managedHome,
    workspaceRoot: tempDir,
    mcpPolicy: "none",
  });

  assert.equal(readFileSync(join(managedHome, ".cursor", "mcp.json"), "utf-8"), '{"mcpServers":{}}\n');
});

test("Cursor managed profile rejects workspace MCP servers for none policy", () => {
  const sourceHome = join(tempDir, "source-home-none-workspace");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-none-with-non-letagents-mcp");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"filesystem":{"command":"npx"}}}\n');

  assert.throws(
    () => prepareCursorManagedProfile({
      sourceHomeDir: sourceHome,
      homeDir: join(tempDir, "managed-home-none-reject"),
      workspaceRoot: workspace,
      mcpPolicy: "none",
    }),
    /workspace MCP config is not allowed with the No MCPs policy/,
  );
  assert.equal(existsSync(join(tempDir, "managed-home-none-reject")), false);
});

test("Cursor managed profile uses normal Cursor config without creating a managed profile", () => {
  const sourceHome = join(tempDir, "source-home-normal");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  writeFileSync(join(sourceHome, ".cursor", "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');
  const workspace = join(tempDir, "workspace-normal-with-letagents");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');
  const managedHome = join(tempDir, "managed-home-normal");

  const profile = prepareCursorManagedProfile({
    sourceHomeDir: sourceHome,
    homeDir: managedHome,
    workspaceRoot: workspace,
    mcpPolicy: "normal",
  });

  assert.equal(profile.homeDir, sourceHome);
  assert.deepEqual(profile.env, {});
  assert.equal(existsSync(managedHome), false);
  assert.equal(readFileSync(join(sourceHome, ".cursor", "mcp.json"), "utf-8"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');
});

test("Cursor managed profile rejects workspace-level LetAgents MCP config for managed policies", () => {
  const sourceHome = join(tempDir, "source-home-no-mcp");
  mkdirSync(join(sourceHome, ".cursor"), { recursive: true });
  const workspace = join(tempDir, "workspace-with-mcp");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  writeFileSync(join(workspace, ".cursor", "mcp.json"), '{"mcpServers":{"letagents":{"command":"npx"}}}\n');

  assert.throws(
    () => prepareCursorManagedProfile({
      sourceHomeDir: sourceHome,
      homeDir: join(tempDir, "managed-home-reject"),
      workspaceRoot: workspace,
    }),
    /workspace MCP config exposes LetAgents/,
  );
  assert.equal(existsSync(join(tempDir, "managed-home-reject")), false);
});

test("Cursor MCP config filtering handles invalid shapes and renamed LetAgents servers", () => {
  assert.deepEqual(filterLetAgentsCursorMcpConfig(null), { mcpServers: {} });
  assert.deepEqual(
    filterLetAgentsCursorMcpConfig({
      mcpServers: {
        postgres: { command: "postgres-mcp" },
        renamed: {
          command: "node",
          args: ["./letagents-mcp.js"],
        },
      },
    }),
    {
      mcpServers: {
        postgres: { command: "postgres-mcp" },
      },
    },
  );
});

test("Cursor MCP policy normalization defaults to filter_letagents", () => {
  assert.equal(normalizeCursorMcpPolicy(undefined), "filter_letagents");
  assert.equal(normalizeCursorMcpPolicy(""), "filter_letagents");
  assert.equal(normalizeCursorMcpPolicy("normal"), "normal");
  assert.equal(normalizeCursorMcpPolicy("none"), "none");
});
