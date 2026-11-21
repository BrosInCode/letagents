// Cursor MCP configuration policy: workspace MCP checks, LetAgents filtering, and the managed mcp.json.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DesktopCursorMcpPolicy } from "../../../ipc-types.js";
import { readRegularFileNoFollow } from "./profile-filesystem.js";
import {
  DEFAULT_CURSOR_MCP_POLICY,
  EMPTY_MCP_CONFIG,
  MAX_WORKSPACE_MCP_BYTES,
  SUPERVISED_CURSOR_MCP_ENV_KEYS,
} from "./profile-types.js";

export function cursorSupervisedMcpServerName(workAttemptId: string): string {
  const normalized = workAttemptId.trim();
  if (!normalized) throw new Error("A supervised Cursor work attempt id is required.");
  return `letagents_supervised_${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function supervisedCursorMcpEnvironment(
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

export function writeManagedCursorMcpConfig(input: {
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
