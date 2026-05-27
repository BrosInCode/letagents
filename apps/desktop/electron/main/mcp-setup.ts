import { app } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopMcpInstallManyResult,
  DesktopMcpInstallResult,
  DesktopMcpInstallState,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
} from "../ipc-types.js";
import { apiUrl, workspaceRoot } from "./paths.js";

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

type McpServerJsonConfig = {
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      [key: string]: unknown;
    }
  >;
  [key: string]: unknown;
};

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
      description: "Add the MCP connection Claude Code needs to join rooms.",
      configPath: join(home, ".claude", "settings.json"),
      configFormat: "json",
      restartHint:
        "Restart Claude Code or reload its MCP servers after installing.",
    },
    {
      id: "antigravity",
      name: "Antigravity",
      description: "Add the MCP connection Antigravity needs to join rooms.",
      configPath: join(home, ".gemini", "settings.json"),
      configFormat: "json",
      restartHint:
        "Restart Antigravity so it picks up the updated MCP settings.",
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

function createLetAgentsMcpServerConfig(): NonNullable<
  McpServerJsonConfig["mcpServers"]
>[string] {
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
    "g",
  );
  return source.replace(tablePattern, "\n");
}

function getTomlTableBody(source: string, tableName: string): string | null {
  const tablePattern = new RegExp(
    `(?:^|\\n)\\[${escapeRegExp(tableName)}\\]\\n([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|$)`,
  );
  return tablePattern.exec(source)?.[1] ?? null;
}

function getTomlStringValue(tableBody: string, key: string): string | null {
  const match = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"\\s*$`,
    "m",
  ).exec(tableBody);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

function getTomlStringArrayValue(
  tableBody: string,
  key: string,
): string[] | null {
  const match = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`,
    "m",
  ).exec(tableBody);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
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
): DesktopMcpInstallTarget["status"] {
  try {
    const raw = readFileSync(configPath, "utf8");
    if (!raw.trim()) return "not_installed";
    const parsed = JSON.parse(raw) as McpServerJsonConfig;
    const server = parsed.mcpServers?.letagents;
    if (!server) return "not_installed";

    const expected = createLetAgentsMcpServerConfig();
    const env = isStringRecord(server.env) ? server.env : {};
    const matchesExpected =
      server.command === expected.command &&
      Array.isArray(server.args) &&
      JSON.stringify(server.args) === JSON.stringify(expected.args) &&
      server.cwd === expected.cwd &&
      env.LETAGENTS_API_URL === expected.env?.LETAGENTS_API_URL;

    return matchesExpected ? "installed" : "needs_attention";
  } catch {
    return "not_installed";
  }
}

function getCodexTomlLetAgentsMcpInstallStatus(
  configPath: string,
): DesktopMcpInstallTarget["status"] {
  try {
    const raw = readFileSync(configPath, "utf8");
    if (!raw.trim()) return "not_installed";

    const serverBody = getTomlTableBody(raw, "mcp_servers.letagents");
    if (!serverBody) return "not_installed";

    const envBody = getTomlTableBody(raw, "mcp_servers.letagents.env");
    const expected = createLetAgentsMcpServerConfig();
    const matchesExpected =
      getTomlStringValue(serverBody, "command") === expected.command &&
      JSON.stringify(getTomlStringArrayValue(serverBody, "args")) ===
        JSON.stringify(expected.args) &&
      getTomlStringValue(serverBody, "cwd") === expected.cwd &&
      envBody !== null &&
      getTomlStringValue(envBody, "LETAGENTS_API_URL") ===
        expected.env?.LETAGENTS_API_URL;

    return matchesExpected ? "installed" : "needs_attention";
  } catch {
    return "not_installed";
  }
}

function getLetAgentsMcpInstallStatus(
  target: McpInstallTargetDefinition,
): DesktopMcpInstallTarget["status"] {
  if (target.configFormat === "codex_toml") {
    return getCodexTomlLetAgentsMcpInstallStatus(target.configPath);
  }
  return getJsonLetAgentsMcpInstallStatus(target.configPath);
}

async function writeMcpJsonConfig(
  configPath: string,
  config: McpServerJsonConfig,
): Promise<void> {
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
    "mcp_servers.letagents",
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
    "utf8",
  );
}

export async function buildMcpInstallState(): Promise<DesktopMcpInstallState> {
  const storedSetup = await readStoredMcpSetup();
  const targets = getMcpInstallTargetDefinitions().map<DesktopMcpInstallTarget>(
    (target) => {
      const status = getLetAgentsMcpInstallStatus(target);
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
): Promise<void> {
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

export async function installLetAgentsMcpServers(
  targetIds: DesktopMcpInstallTargetId[],
): Promise<DesktopMcpInstallManyResult> {
  if (!targetIds.length) {
    throw new Error("Choose at least one app for MCP setup.");
  }

  const uniqueTargetIds = [...new Set(targetIds)];
  uniqueTargetIds.forEach(assertMcpInstallTargetId);
  const targetDefinitions = getMcpInstallTargetDefinitions().filter((target) =>
    uniqueTargetIds.includes(target.id),
  );

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
  const targets = installState.targets.filter((candidate) =>
    uniqueTargetIds.includes(candidate.id),
  );
  const targetNames = targets.map((target) => target.name).join(", ");

  return {
    success: true,
    targets,
    installState,
    message: `LetAgents was added to ${targetNames}. Restart or reload those apps so the MCP connection is available.`,
  };
}

export async function installLetAgentsMcpServer(
  targetId: DesktopMcpInstallTargetId,
): Promise<DesktopMcpInstallResult> {
  const targetDefinition = getMcpInstallTargetDefinitions().find(
    (target) => target.id === targetId,
  );
  if (!targetDefinition) {
    throw new Error(`Unknown MCP install target: ${targetId}`);
  }

  const result = await installLetAgentsMcpServers([targetId]);
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
