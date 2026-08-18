import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type {
  DesktopMcpInstallConfigPath,
  DesktopMcpInstallFailure,
  DesktopMcpInstallManyResult,
  DesktopMcpInstallResult,
  DesktopMcpInstallState,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
} from "../ipc-types.js";
import { readStoredAuth } from "./auth.js";
import {
  buildCodexTomlLetAgentsMcpConfig,
  createLetAgentsMcpServerConfig,
  getCodexTomlLetAgentsMcpServerFromRaw,
  getLetAgentsMcpServerIssue,
  getJsonLetAgentsMcpServerFromRaw,
  isLocalDevLetAgentsApiUrl,
  type LetAgentsMcpServerConfig,
  type McpServerJsonConfig,
} from "./mcp-config.js";
import { apiUrl } from "./paths.js";

const require = createRequire(import.meta.url);

function getElectronMain(): {
  app?: { getPath: (name: "userData") => string };
} {
  try {
    const electron = require("electron") as unknown;
    return typeof electron === "object" && electron !== null
      ? electron as { app?: { getPath: (name: "userData") => string } }
      : {};
  } catch {
    return {};
  }
}

function desktopUserDataPath(): string {
  const overridePath = process.env.LETAGENTS_DESKTOP_USER_DATA_DIR?.trim();
  if (overridePath) return overridePath;
  return getElectronMain().app?.getPath("userData") || homedir();
}

type StoredMcpInstallSetup = {
  completed: boolean;
  completedAt: string | null;
  selectedTargetId: DesktopMcpInstallTargetId | null;
  installs: Partial<
    Record<DesktopMcpInstallTargetId, { lastInstalledAt: string }>
  >;
};

const mcpInstallTargetIds: DesktopMcpInstallTargetId[] = [
  "claude-code",
  "antigravity",
  "cursor",
  "codex",
];

type McpInstallConfigFormat = "json" | "codex_toml";

type McpInstallConfigWritePolicy = "always" | "if_present";

type McpInstallConfigLocationDefinition = {
  path: string;
  label: string;
  configFormat: McpInstallConfigFormat;
  writePolicy: McpInstallConfigWritePolicy;
};

type McpInstallTargetDefinition = Omit<
  DesktopMcpInstallTarget,
  "configPaths" | "configIssue" | "status" | "lastInstalledAt"
> & {
  configLocations: McpInstallConfigLocationDefinition[];
};

function getSetupStorePath(): string {
  return join(desktopUserDataPath(), "letagents-desktop-setup.json");
}

function getMcpInstallTargetDefinitions(): McpInstallTargetDefinition[] {
  const home = process.env.LETAGENTS_DESKTOP_MCP_CONFIG_HOME?.trim() || homedir();
  const claudeSettingsPath = join(home, ".claude", "settings.json");
  const claudeJsonPath = join(home, ".claude.json");
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      description: "Add the LetAgents MCP so agents here can communicate in shared rooms.",
      configPath: claudeSettingsPath,
      configLocations: [
        {
          path: claudeSettingsPath,
          label: "Claude settings",
          configFormat: "json",
          writePolicy: "always",
        },
        {
          path: claudeJsonPath,
          label: "Claude user config",
          configFormat: "json",
          writePolicy: "if_present",
        },
      ],
      restartHint:
        "Restart Claude Code or reconnect its MCP servers after repair so it uses the updated API URL.",
    },
    {
      id: "antigravity",
      name: "Antigravity",
      description: "Add the LetAgents MCP so agents here can communicate in shared rooms.",
      configPath: join(home, ".gemini", "settings.json"),
      configLocations: [
        {
          path: join(home, ".gemini", "settings.json"),
          label: "Antigravity settings",
          configFormat: "json",
          writePolicy: "always",
        },
      ],
      restartHint:
        "Restart Antigravity so it picks up the LetAgents connection.",
    },
    {
      id: "cursor",
      name: "Cursor",
      description: "Add the LetAgents MCP so agents here can communicate in shared rooms.",
      configPath: join(home, ".cursor", "mcp.json"),
      configLocations: [
        {
          path: join(home, ".cursor", "mcp.json"),
          label: "Cursor MCP config",
          configFormat: "json",
          writePolicy: "always",
        },
      ],
      restartHint: "Reload Cursor or restart its MCP server after installing.",
    },
    {
      id: "codex",
      name: "Codex",
      description: "Add the LetAgents MCP so agents here can communicate in shared rooms. Install and sign in to Codex separately.",
      configPath: join(home, ".codex", "config.toml"),
      configLocations: [
        {
          path: join(home, ".codex", "config.toml"),
          label: "Codex config",
          configFormat: "codex_toml",
          writePolicy: "always",
        },
      ],
      restartHint: "Restart Codex so it discovers the LetAgents MCP server.",
    },
  ];
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

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

export function withRefreshedRuntimeAndAuth(
  current: LetAgentsMcpServerConfig,
  expected: LetAgentsMcpServerConfig,
): LetAgentsMcpServerConfig {
  const expectedEnv = expected.env || {};
  const expectedToken = expectedEnv.LETAGENTS_TOKEN?.trim() || null;
  const env: Record<string, string> = {
    ...stringRecord(current.env),
    LETAGENTS_API_URL: expectedEnv.LETAGENTS_API_URL || apiUrl,
  };
  if (expectedToken) {
    env.LETAGENTS_TOKEN = expectedToken;
  } else {
    delete env.LETAGENTS_TOKEN;
  }

  const { cwd: _legacyCwd, ...server } = current;
  return {
    ...server,
    command: expected.command || "npx",
    args: expected.args ? [...expected.args] : undefined,
    env,
  };
}

async function buildExpectedLetAgentsMcpServerConfig(): Promise<LetAgentsMcpServerConfig> {
  const storedAuth = await readStoredAuth();
  return createLetAgentsMcpServerConfig({
    apiUrl,
    authToken: storedAuth.token,
  });
}

async function writeStoredMcpSetup(
  nextSetup: StoredMcpInstallSetup,
): Promise<void> {
  await atomicWriteTextFile(
    getSetupStorePath(),
    `${JSON.stringify(nextSetup, null, 2)}\n`,
  );
}

/**
 * Replace a config without ever exposing a partially-written destination.
 * The temporary file lives beside the destination so the final rename is
 * atomic on the filesystems used by the desktop app.
 */
export async function atomicWriteTextFile(
  destinationPath: string,
  contents: string,
): Promise<void> {
  const parentDirectory = dirname(destinationPath);
  await mkdir(parentDirectory, { recursive: true });

  let mode = 0o600;
  try {
    mode = (await stat(destinationPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporaryPath = join(
    parentDirectory,
    `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readMcpJsonConfig(
  configPath: string,
): Promise<McpServerJsonConfig> {
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

function getLetAgentsMcpInstallStatus(
  configPath: DesktopMcpInstallConfigPath[],
): DesktopMcpInstallTarget["status"] {
  const staleConfig = configPath.find(
    (location) => location.hasLetAgents && location.status === "needs_attention",
  );
  if (staleConfig) return "needs_attention";
  if (configPath.some((location) => location.status === "installed")) {
    return "installed";
  }
  return "not_installed";
}

const localApiHealthChecks = new Map<string, Promise<boolean>>();

async function checkLocalApiHealth(configuredApiUrl: string): Promise<boolean> {
  const normalizedApiUrl = configuredApiUrl.replace(/\/+$/, "");
  let pending = localApiHealthChecks.get(normalizedApiUrl);
  if (!pending) {
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 900);
      try {
        const response = await fetch(`${normalizedApiUrl}/api/health`, {
          signal: controller.signal,
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
      }
    })();
    localApiHealthChecks.set(normalizedApiUrl, pending);
    void pending.finally(() => {
      if (localApiHealthChecks.get(normalizedApiUrl) === pending) {
        localApiHealthChecks.delete(normalizedApiUrl);
      }
    });
  }
  return pending;
}

function parseLetAgentsServerFromRaw(
  location: McpInstallConfigLocationDefinition,
  raw: string,
): LetAgentsMcpServerConfig | null {
  return location.configFormat === "codex_toml"
    ? getCodexTomlLetAgentsMcpServerFromRaw(raw)
    : getJsonLetAgentsMcpServerFromRaw(raw);
}

async function evaluateMcpConfigLocation(
  location: McpInstallConfigLocationDefinition,
  expected: LetAgentsMcpServerConfig,
): Promise<DesktopMcpInstallConfigPath> {
  try {
    const raw = await readFile(location.path, "utf8");
    const server = parseLetAgentsServerFromRaw(location, raw);
    if (!server) {
      return {
        path: location.path,
        label: location.label,
        status: "not_installed",
        hasLetAgents: false,
        issue: null,
      };
    }

    const configuredApiUrl = server.env?.LETAGENTS_API_URL?.trim() || null;
    const localDevApiHealthy = isLocalDevLetAgentsApiUrl(configuredApiUrl)
      ? await checkLocalApiHealth(configuredApiUrl || "")
      : null;
    const issue = getLetAgentsMcpServerIssue(server, expected, {
      localDevApiHealthy,
    });
    return {
      path: location.path,
      label: location.label,
      status: issue ? "needs_attention" : "installed",
      hasLetAgents: true,
      issue,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: location.path,
        label: location.label,
        status: "not_installed",
        hasLetAgents: false,
        issue: null,
      };
    }
    return {
      path: location.path,
      label: location.label,
      status: "needs_attention",
      hasLetAgents: true,
      issue: error instanceof Error
        ? `Could not read config: ${error.message}`
        : "Could not read config.",
    };
  }
}

async function writeMcpJsonConfig(
  configPath: string,
  config: McpServerJsonConfig,
): Promise<void> {
  await atomicWriteTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeCodexTomlMcpConfig(
  configPath: string,
  expected: LetAgentsMcpServerConfig,
): Promise<void> {
  let currentConfig = "";
  try {
    currentConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await atomicWriteTextFile(
    configPath,
    buildCodexTomlLetAgentsMcpConfig(currentConfig, expected),
  );
}

export async function buildMcpInstallState(): Promise<DesktopMcpInstallState> {
  const storedSetup = await readStoredMcpSetup();
  const expected = await buildExpectedLetAgentsMcpServerConfig();
  const targets = await Promise.all(
    getMcpInstallTargetDefinitions().map<Promise<DesktopMcpInstallTarget>>(
      async (target) => {
        const configPaths = await Promise.all(
          target.configLocations.map((location) =>
            evaluateMcpConfigLocation(location, expected)
          ),
        );
        const status = getLetAgentsMcpInstallStatus(configPaths);
        const firstIssue = configPaths.find(
          (location) => location.hasLetAgents && location.issue,
        );
        const { configLocations: _configLocations, ...publicTarget } = target;
        return {
          ...publicTarget,
          configPaths,
          configIssue: firstIssue
            ? `${firstIssue.label}: ${firstIssue.issue}`
            : null,
          status,
          lastInstalledAt:
            storedSetup.installs[target.id]?.lastInstalledAt || null,
        };
      },
    ),
  );
  const firstInstalledTarget = targets.find(
    (target) => target.status === "installed",
  );
  return {
    completed: storedSetup.completed,
    completedAt: storedSetup.completedAt,
    selectedTargetId:
      storedSetup.selectedTargetId || firstInstalledTarget?.id || null,
    targets,
  };
}

function assertMcpInstallTargetId(
  targetId: string,
): asserts targetId is DesktopMcpInstallTargetId {
  if (!mcpInstallTargetIds.includes(targetId as DesktopMcpInstallTargetId)) {
    throw new Error(`Unknown MCP install target: ${targetId}`);
  }
}

async function shouldWriteMcpLocation(
  location: McpInstallConfigLocationDefinition,
): Promise<boolean> {
  if (location.writePolicy === "always") return true;
  try {
    await readFile(location.path, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeLetAgentsMcpServerForLocation(
  location: McpInstallConfigLocationDefinition,
  expected: LetAgentsMcpServerConfig,
): Promise<void> {
  if (location.configFormat === "codex_toml") {
    await writeCodexTomlMcpConfig(location.path, expected);
    return;
  }

  const currentConfig = await readMcpJsonConfig(location.path);
  const nextConfig: McpServerJsonConfig = {
    ...currentConfig,
    mcpServers: {
      ...(currentConfig.mcpServers || {}),
      letagents: expected,
    },
  };
  await writeMcpJsonConfig(location.path, nextConfig);
}

async function writeLetAgentsMcpServerForTarget(
  targetDefinition: McpInstallTargetDefinition,
  expected: LetAgentsMcpServerConfig,
): Promise<DesktopMcpInstallFailure[]> {
  const failures: DesktopMcpInstallFailure[] = [];
  for (const location of targetDefinition.configLocations) {
    try {
      if (!(await shouldWriteMcpLocation(location))) continue;
      await writeLetAgentsMcpServerForLocation(location, expected);
    } catch (error) {
      failures.push({
        targetId: targetDefinition.id,
        targetName: targetDefinition.name,
        configPath: location.path,
        configLabel: location.label,
        message: error instanceof Error ? error.message : "The config could not be written.",
      });
    }
  }
  return failures;
}

async function refreshLetAgentsMcpServerAuthForLocation(
  location: McpInstallConfigLocationDefinition,
  expected: LetAgentsMcpServerConfig,
): Promise<void> {
  if (location.configFormat === "codex_toml") {
    let currentConfig = "";
    try {
      currentConfig = await readFile(location.path, "utf8");
    } catch {
      return;
    }
    const currentServer = getCodexTomlLetAgentsMcpServerFromRaw(currentConfig);
    if (!currentServer) return;
    await atomicWriteTextFile(
      location.path,
      buildCodexTomlLetAgentsMcpConfig(
        currentConfig,
        withRefreshedRuntimeAndAuth(currentServer, expected),
      ),
    );
    return;
  }

  let currentConfig: McpServerJsonConfig;
  try {
    currentConfig = await readMcpJsonConfig(location.path);
  } catch {
    return;
  }
  const currentServer = currentConfig.mcpServers?.letagents || null;
  if (!currentServer) return;
  const nextConfig: McpServerJsonConfig = {
    ...currentConfig,
    mcpServers: {
      ...(currentConfig.mcpServers || {}),
      letagents: withRefreshedRuntimeAndAuth(currentServer, expected),
    },
  };
  await writeMcpJsonConfig(location.path, nextConfig);
}

async function refreshLetAgentsMcpServerAuthForTarget(
  targetDefinition: McpInstallTargetDefinition,
  expected: LetAgentsMcpServerConfig,
): Promise<void> {
  for (const location of targetDefinition.configLocations) {
    await refreshLetAgentsMcpServerAuthForLocation(location, expected);
  }
}

export async function refreshInstalledLetAgentsMcpServerAuth(): Promise<void> {
  const storedSetup = await readStoredMcpSetup();
  const expected = await buildExpectedLetAgentsMcpServerConfig();

  for (const targetDefinition of getMcpInstallTargetDefinitions()) {
    if (!storedSetup.installs[targetDefinition.id]?.lastInstalledAt) continue;
    await refreshLetAgentsMcpServerAuthForTarget(targetDefinition, expected);
  }
}

export async function installLetAgentsMcpServers(
  targetIds: DesktopMcpInstallTargetId[],
): Promise<DesktopMcpInstallManyResult> {
  if (!targetIds.length) {
    throw new Error("Choose at least one app for LetAgents setup.");
  }

  const uniqueTargetIds = [...new Set(targetIds)];
  uniqueTargetIds.forEach(assertMcpInstallTargetId);
  const targetDefinitions = getMcpInstallTargetDefinitions().filter((target) =>
    uniqueTargetIds.includes(target.id),
  );
  const storedSetup = await readStoredMcpSetup();
  const expected = await buildExpectedLetAgentsMcpServerConfig();

  const failures = (await Promise.all(
    targetDefinitions.map((targetDefinition) =>
      writeLetAgentsMcpServerForTarget(targetDefinition, expected)
    ),
  )).flat();

  // Always reread the files after every attempted write. This is the source of
  // truth for success, including partial installs where another target failed.
  let installState = await buildMcpInstallState();
  const verifiedTargetIds = new Set(
    installState.targets
      .filter((target) =>
        uniqueTargetIds.includes(target.id) && target.status === "installed"
      )
      .map((target) => target.id),
  );

  const now = new Date().toISOString();
  const installs = { ...storedSetup.installs };
  for (const targetId of verifiedTargetIds) {
    installs[targetId] = { lastInstalledAt: now };
  }

  try {
    await writeStoredMcpSetup({
      completed: storedSetup.completed,
      completedAt: storedSetup.completedAt,
      selectedTargetId:
        uniqueTargetIds.find((targetId) => verifiedTargetIds.has(targetId))
        || storedSetup.selectedTargetId,
      installs,
    });
    installState = await buildMcpInstallState();
  } catch (error) {
    failures.push({
      targetId: null,
      targetName: "LetAgents",
      configPath: getSetupStorePath(),
      configLabel: "Setup state",
      message: error instanceof Error ? error.message : "Setup progress could not be saved.",
    });
  }

  const targets = installState.targets.filter((candidate) =>
    uniqueTargetIds.includes(candidate.id),
  );
  const targetNames = targets.map((target) => target.name).join(", ");
  const unverifiedTargets = targets.filter(
    (target) => target.status !== "installed",
  );
  const firstIssue = unverifiedTargets.find((target) => target.configIssue)
    ?.configIssue;
  const failedTargetIds = new Set(unverifiedTargets.map((target) => target.id));
  const blockingFailures = failures.filter((failure) =>
    failure.targetId === null || failedTargetIds.has(failure.targetId)
  );
  const firstWriteFailure = blockingFailures[0];
  const successfulTargets = targets.filter((target) => target.status === "installed");
  const successfulNames = successfulTargets.map((target) => target.name).join(", ");
  const failedNames = unverifiedTargets.map((target) => target.name).join(", ");

  return {
    success: unverifiedTargets.length === 0 && blockingFailures.length === 0,
    targets,
    installState,
    failures,
    message: unverifiedTargets.length || blockingFailures.length
      ? `${successfulNames ? `${successfulNames} installed. ` : ""}Couldn't install ${failedNames || "LetAgents setup"}. ${firstWriteFailure?.configLabel ? `${firstWriteFailure.configLabel}: ` : ""}${firstWriteFailure?.message || firstIssue || "Check the highlighted config and try again."}`
      : `LetAgents was added to ${targetNames}. Restart or reconnect those apps so the updated MCP settings are used.`,
  };
}

export async function installLetAgentsMcpServer(
  targetId: DesktopMcpInstallTargetId,
): Promise<DesktopMcpInstallResult> {
  const result = await installLetAgentsMcpServers([targetId]);
  const installState = result.installState;
  const target = installState.targets.find(
    (candidate) => candidate.id === targetId,
  );
  if (!target) {
    throw new Error(`Installed target disappeared: ${targetId}`);
  }

  return {
    success: result.success && target.status === "installed",
    target,
    installState,
    message: result.success && target.status === "installed"
      ? `LetAgents was added to ${target.name}. ${target.restartHint}`
      : result.message,
  };
}

export async function completeMcpOnboarding(): Promise<DesktopMcpInstallState> {
  const current = await readStoredMcpSetup();
  await writeStoredMcpSetup({
    ...current,
    completed: true,
    completedAt: current.completedAt || new Date().toISOString(),
  });
  return buildMcpInstallState();
}
