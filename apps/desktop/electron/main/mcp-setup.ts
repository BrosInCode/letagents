import { app } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopMcpInstallOptions,
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
  getCodexTomlLetAgentsMcpInstallStatusFromRaw,
  getJsonLetAgentsMcpInstallStatusFromRaw,
  type LetAgentsMcpServerConfig,
  type McpServerJsonConfig,
} from "./mcp-config.js";
import { apiUrl, workspaceRoot } from "./paths.js";

type StoredMcpInstallSetup = {
  completed: boolean;
  completedAt: string | null;
  cwd: string | null;
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

type McpInstallTargetDefinition = Omit<
  DesktopMcpInstallTarget,
  "status" | "lastInstalledAt"
> & {
  configFormat: McpInstallConfigFormat;
};

function getSetupStorePath(): string {
  return join(app.getPath("userData"), "letagents-desktop-setup.json");
}

function getMcpInstallTargetDefinitions(): McpInstallTargetDefinition[] {
  const home = homedir();
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      description: "Add the LetAgents connection Claude Code needs to join rooms.",
      configPath: join(home, ".claude", "settings.json"),
      configFormat: "json",
      restartHint:
        "Restart Claude Code or reload its LetAgents connection after installing.",
    },
    {
      id: "antigravity",
      name: "Antigravity",
      description: "Add the LetAgents connection Antigravity needs to join rooms.",
      configPath: join(home, ".gemini", "settings.json"),
      configFormat: "json",
      restartHint:
        "Restart Antigravity so it picks up the LetAgents connection.",
    },
    {
      id: "cursor",
      name: "Cursor",
      description: "Add the LetAgents connection Cursor needs to join rooms.",
      configPath: join(home, ".cursor", "mcp.json"),
      configFormat: "json",
      restartHint: "Reload Cursor or restart its LetAgents connection after installing.",
    },
    {
      id: "codex",
      name: "Codex",
      description: "Add the LetAgents connection Codex needs to join rooms.",
      configPath: join(home, ".codex", "config.toml"),
      configFormat: "codex_toml",
      restartHint: "Restart Codex so it discovers LetAgents.",
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
      cwd: typeof parsed.cwd === "string" && parsed.cwd.trim()
        ? parsed.cwd.trim()
        : null,
      selectedTargetId: parsed.selectedTargetId || null,
      installs: parsed.installs || {},
    };
  } catch {
    return {
      completed: false,
      completedAt: null,
      cwd: null,
      selectedTargetId: null,
      installs: {},
    };
  }
}

function normalizeInstallCwd(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

function withRefreshedAuthEnv(
  current: LetAgentsMcpServerConfig,
  expected: LetAgentsMcpServerConfig,
): LetAgentsMcpServerConfig {
  const expectedEnv = stringRecord(expected.env);
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

  return {
    ...current,
    env,
  };
}

async function buildExpectedLetAgentsMcpServerConfig(
  cwd?: string | null,
): Promise<LetAgentsMcpServerConfig> {
  const storedAuth = await readStoredAuth();
  return createLetAgentsMcpServerConfig({
    apiUrl,
    workspaceRoot,
    authToken: storedAuth.token,
    cwd,
  });
}

async function writeStoredMcpSetup(
  nextSetup: StoredMcpInstallSetup,
): Promise<void> {
  await mkdir(dirname(getSetupStorePath()), { recursive: true });
  await writeFile(
    getSetupStorePath(),
    `${JSON.stringify(nextSetup, null, 2)}\n`,
    "utf8",
  );
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

function getJsonLetAgentsMcpInstallStatus(
  configPath: string,
  expected: LetAgentsMcpServerConfig,
): DesktopMcpInstallTarget["status"] {
  try {
    const raw = readFileSync(configPath, "utf8");
    return getJsonLetAgentsMcpInstallStatusFromRaw(raw, expected);
  } catch {
    return "not_installed";
  }
}

function getCodexTomlLetAgentsMcpInstallStatus(
  configPath: string,
  expected: LetAgentsMcpServerConfig,
): DesktopMcpInstallTarget["status"] {
  try {
    const raw = readFileSync(configPath, "utf8");
    return getCodexTomlLetAgentsMcpInstallStatusFromRaw(raw, expected);
  } catch {
    return "not_installed";
  }
}

function getLetAgentsMcpInstallStatus(
  target: McpInstallTargetDefinition,
  expected: LetAgentsMcpServerConfig,
): DesktopMcpInstallTarget["status"] {
  if (target.configFormat === "codex_toml") {
    return getCodexTomlLetAgentsMcpInstallStatus(
      target.configPath,
      expected,
    );
  }
  return getJsonLetAgentsMcpInstallStatus(target.configPath, expected);
}

async function writeMcpJsonConfig(
  configPath: string,
  config: McpServerJsonConfig,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    buildCodexTomlLetAgentsMcpConfig(currentConfig, expected),
    "utf8",
  );
}

export async function buildMcpInstallState(
  options: DesktopMcpInstallOptions = {},
): Promise<DesktopMcpInstallState> {
  const storedSetup = await readStoredMcpSetup();
  const effectiveCwd = normalizeInstallCwd(options.cwd) || storedSetup.cwd;
  const expected = await buildExpectedLetAgentsMcpServerConfig(effectiveCwd);
  const targets = getMcpInstallTargetDefinitions().map<DesktopMcpInstallTarget>(
    (target) => {
      const status = getLetAgentsMcpInstallStatus(target, expected);
      const { configFormat: _configFormat, ...publicTarget } = target;
      return {
        ...publicTarget,
        status,
        lastInstalledAt:
          storedSetup.installs[target.id]?.lastInstalledAt || null,
      };
    },
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

async function writeLetAgentsMcpServerForTarget(
  targetDefinition: McpInstallTargetDefinition,
  expected: LetAgentsMcpServerConfig,
): Promise<void> {
  if (targetDefinition.configFormat === "codex_toml") {
    await writeCodexTomlMcpConfig(targetDefinition.configPath, expected);
    return;
  }

  const currentConfig = await readMcpJsonConfig(targetDefinition.configPath);
  const nextConfig: McpServerJsonConfig = {
    ...currentConfig,
    mcpServers: {
      ...(currentConfig.mcpServers || {}),
      letagents: expected,
    },
  };
  await writeMcpJsonConfig(targetDefinition.configPath, nextConfig);
}

async function refreshLetAgentsMcpServerAuthForTarget(
  targetDefinition: McpInstallTargetDefinition,
  expected: LetAgentsMcpServerConfig,
): Promise<void> {
  if (targetDefinition.configFormat === "codex_toml") {
    let currentConfig = "";
    try {
      currentConfig = await readFile(targetDefinition.configPath, "utf8");
    } catch {
      return;
    }
    const currentServer = getCodexTomlLetAgentsMcpServerFromRaw(currentConfig);
    if (!currentServer) return;
    await mkdir(dirname(targetDefinition.configPath), { recursive: true });
    await writeFile(
      targetDefinition.configPath,
      buildCodexTomlLetAgentsMcpConfig(
        currentConfig,
        withRefreshedAuthEnv(currentServer, expected),
      ),
      "utf8",
    );
    return;
  }

  let currentConfig: McpServerJsonConfig;
  try {
    currentConfig = await readMcpJsonConfig(targetDefinition.configPath);
  } catch {
    return;
  }
  const currentServer = currentConfig.mcpServers?.letagents || null;
  if (!currentServer) return;
  const nextConfig: McpServerJsonConfig = {
    ...currentConfig,
    mcpServers: {
      ...(currentConfig.mcpServers || {}),
      letagents: withRefreshedAuthEnv(currentServer, expected),
    },
  };
  await writeMcpJsonConfig(targetDefinition.configPath, nextConfig);
}

export async function refreshInstalledLetAgentsMcpServerAuth(): Promise<void> {
  const storedSetup = await readStoredMcpSetup();
  const expected = await buildExpectedLetAgentsMcpServerConfig(storedSetup.cwd);

  const installedTargetIds = new Set(
    Object.entries(storedSetup.installs)
      .filter(([, install]) => Boolean(install?.lastInstalledAt))
      .map(([targetId]) => targetId as DesktopMcpInstallTargetId),
  );
  if (!installedTargetIds.size) return;

  const targetDefinitions = getMcpInstallTargetDefinitions().filter((target) =>
    installedTargetIds.has(target.id),
  );
  for (const targetDefinition of targetDefinitions) {
    await refreshLetAgentsMcpServerAuthForTarget(targetDefinition, expected);
  }
}

export async function installLetAgentsMcpServers(
  targetIds: DesktopMcpInstallTargetId[],
  options: DesktopMcpInstallOptions = {},
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
  const effectiveCwd = normalizeInstallCwd(options.cwd)
    || storedSetup.cwd
    || workspaceRoot;
  const expected = await buildExpectedLetAgentsMcpServerConfig(effectiveCwd);

  for (const targetDefinition of targetDefinitions) {
    await writeLetAgentsMcpServerForTarget(targetDefinition, expected);
  }

  const now = new Date().toISOString();
  const installs = { ...storedSetup.installs };
  for (const targetId of uniqueTargetIds) {
    installs[targetId] = { lastInstalledAt: now };
  }

  await writeStoredMcpSetup({
    completed: storedSetup.completed,
    completedAt: storedSetup.completedAt,
    cwd: effectiveCwd,
    selectedTargetId: uniqueTargetIds[0] || storedSetup.selectedTargetId,
    installs,
  });

  const installState = await buildMcpInstallState({ cwd: effectiveCwd });
  const targets = installState.targets.filter((candidate) =>
    uniqueTargetIds.includes(candidate.id),
  );
  const targetNames = targets.map((target) => target.name).join(", ");

  return {
    success: true,
    targets,
    installState,
    message: `LetAgents was added to ${targetNames}. Restart or reload those apps so the LetAgents connection is available.`,
  };
}

export async function installLetAgentsMcpServer(
  targetId: DesktopMcpInstallTargetId,
  options: DesktopMcpInstallOptions = {},
): Promise<DesktopMcpInstallResult> {
  const targetDefinition = getMcpInstallTargetDefinitions().find(
    (target) => target.id === targetId,
  );
  if (!targetDefinition) {
    throw new Error(`Unknown MCP install target: ${targetId}`);
  }

  const result = await installLetAgentsMcpServers([targetId], options);
  const installState = result.installState;
  const target = installState.targets.find(
    (candidate) => candidate.id === targetId,
  );
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

export async function completeMcpOnboarding(): Promise<DesktopMcpInstallState> {
  const current = await readStoredMcpSetup();
  await writeStoredMcpSetup({
    ...current,
    completed: true,
    completedAt: current.completedAt || new Date().toISOString(),
  });
  return buildMcpInstallState();
}
