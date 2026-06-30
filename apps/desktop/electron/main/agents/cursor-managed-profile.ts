import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getLetAgentsLocalStatePath } from "../paths.js";

export interface CursorManagedProfile {
  homeDir: string;
  configDir: string;
  dataDir: string;
  cacheDir: string;
  env: Record<string, string>;
}

export interface CursorManagedProfileOptions {
  sourceHomeDir?: string | null;
  homeDir?: string | null;
  workspaceRoot?: string | null;
}

const EMPTY_MCP_CONFIG = '{"mcpServers":{}}\n';

export function prepareCursorManagedProfile(
  options: CursorManagedProfileOptions = {},
): CursorManagedProfile {
  const workspaceRoot = normalizePath(options.workspaceRoot);
  if (workspaceRoot) {
    assertWorkspaceDoesNotConfigureLetAgentsMcp(workspaceRoot);
  }

  const sourceHomeDir = normalizePath(options.sourceHomeDir) ||
    normalizePath(process.env.LETAGENTS_CURSOR_SOURCE_HOME) ||
    homedir();
  const homeDir = normalizePath(options.homeDir) ||
    normalizePath(process.env.LETAGENTS_CURSOR_MANAGED_HOME) ||
    join(dirname(getLetAgentsLocalStatePath()), "cursor-managed", "home");
  const profileRoot = dirname(homeDir);
  const configDir = join(profileRoot, "config");
  const dataDir = join(profileRoot, "data");
  const cacheDir = join(profileRoot, "cache");
  const cursorHomeDir = join(homeDir, ".cursor");

  mkdirSync(cursorHomeDir, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  copyOptionalFile(
    join(sourceHomeDir, ".cursor", "cli-config.json"),
    join(cursorHomeDir, "cli-config.json"),
  );
  copyOptionalFile(
    join(sourceHomeDir, ".cursor", "agent-cli-state.json"),
    join(cursorHomeDir, "agent-cli-state.json"),
  );
  writeFileSync(join(cursorHomeDir, "mcp.json"), EMPTY_MCP_CONFIG, {
    encoding: "utf-8",
    mode: 0o600,
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

export function assertWorkspaceDoesNotConfigureLetAgentsMcp(workspaceRoot: string): void {
  const mcpPath = join(resolve(workspaceRoot), ".cursor", "mcp.json");
  if (!existsSync(mcpPath)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor workspace MCP config is invalid at ${mcpPath}: ${detail}`);
  }

  if (mcpConfigMentionsLetAgents(parsed)) {
    throw new Error(
      "Cursor workspace MCP config exposes LetAgents. Remove .cursor/mcp.json LetAgents entries before starting a managed Cursor agent.",
    );
  }
}

function copyOptionalFile(source: string, destination: string): void {
  if (!existsSync(source)) {
    return;
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

function linkDarwinLoginKeychains(sourceHomeDir: string, homeDir: string): void {
  if (process.platform !== "darwin") {
    return;
  }
  const source = join(sourceHomeDir, "Library", "Keychains");
  if (!existsSync(source)) {
    return;
  }
  const link = join(homeDir, "Library", "Keychains");
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  if (existsSync(link)) {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink() || readlinkSync(link) !== source) {
      return;
    }
    return;
  }
  symlinkSync(source, link, "dir");
}

function mcpConfigMentionsLetAgents(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return false;
  }
  return Object.entries(servers).some(([name, config]) => {
    const normalizedName = name.trim().toLowerCase();
    if (normalizedName === "letagents" || normalizedName.includes("letagents")) {
      return true;
    }
    try {
      return JSON.stringify(config).toLowerCase().includes("letagents");
    } catch {
      return false;
    }
  });
}

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? resolve(trimmed) : null;
}
