import type { DesktopMcpInstallTarget } from "../ipc-types.js";

export type McpServerJsonConfig = {
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

export type LetAgentsMcpServerConfig = NonNullable<
  McpServerJsonConfig["mcpServers"]
>[string];

type McpInstallStatus = DesktopMcpInstallTarget["status"];

export function createLetAgentsMcpServerConfig(input: {
  apiUrl: string;
  workspaceRoot: string;
  authToken?: string | null;
  cwd?: string | null;
}): LetAgentsMcpServerConfig {
  const token = input.authToken?.trim() || null;
  const cwd = input.cwd?.trim() || input.workspaceRoot;
  const env: Record<string, string> = {
    LETAGENTS_API_URL: input.apiUrl,
  };
  if (token) {
    env.LETAGENTS_TOKEN = token;
  }

  return {
    command: "npx",
    args: ["-y", "letagents"],
    cwd,
    env,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

export function getJsonLetAgentsMcpServerFromRaw(
  raw: string,
): LetAgentsMcpServerConfig | null {
  if (!raw.trim()) return null;

  const parsed = JSON.parse(raw) as McpServerJsonConfig;
  return parsed.mcpServers?.letagents || null;
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

function getTomlStringValues(tableBody: string): Record<string, string> {
  const values: Record<string, string> = {};
  const entryPattern =
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(tableBody)) !== null) {
    try {
      values[match[1]] = JSON.parse(`"${match[2]}"`) as string;
    } catch {
      // Ignore malformed values and keep parsing the rest of the table.
    }
  }
  return values;
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

export function letAgentsMcpServerMatchesExpected(
  server: LetAgentsMcpServerConfig,
  expected: LetAgentsMcpServerConfig,
): boolean {
  const env = isStringRecord(server.env) ? server.env : {};
  const expectedEnv = isStringRecord(expected.env) ? expected.env : {};
  const expectedToken = expectedEnv.LETAGENTS_TOKEN?.trim() || null;
  const serverToken = env.LETAGENTS_TOKEN?.trim() || null;

  return (
    server.command === expected.command &&
    Array.isArray(server.args) &&
    JSON.stringify(server.args) === JSON.stringify(expected.args) &&
    server.cwd === expected.cwd &&
    env.LETAGENTS_API_URL === expectedEnv.LETAGENTS_API_URL &&
    (expectedToken ? serverToken === expectedToken : serverToken === null)
  );
}

export function getJsonLetAgentsMcpInstallStatusFromRaw(
  raw: string,
  expected: LetAgentsMcpServerConfig,
): McpInstallStatus {
  const server = getJsonLetAgentsMcpServerFromRaw(raw);
  if (!server) return "not_installed";

  return letAgentsMcpServerMatchesExpected(server, expected)
    ? "installed"
    : "needs_attention";
}

export function getCodexTomlLetAgentsMcpServerFromRaw(
  raw: string,
): LetAgentsMcpServerConfig | null {
  if (!raw.trim()) return null;

  const serverBody = getTomlTableBody(raw, "mcp_servers.letagents");
  if (!serverBody) return null;

  const envBody = getTomlTableBody(raw, "mcp_servers.letagents.env");
  const env = envBody ? getTomlStringValues(envBody) : {};

  return {
    command: getTomlStringValue(serverBody, "command") || undefined,
    args: getTomlStringArrayValue(serverBody, "args") || undefined,
    cwd: getTomlStringValue(serverBody, "cwd") || undefined,
    env,
  };
}

export function getCodexTomlLetAgentsMcpInstallStatusFromRaw(
  raw: string,
  expected: LetAgentsMcpServerConfig,
): McpInstallStatus {
  const serverBody = getTomlTableBody(raw, "mcp_servers.letagents");
  if (!serverBody) return "not_installed";

  const envBody = getTomlTableBody(raw, "mcp_servers.letagents.env");
  const expectedEnv = isStringRecord(expected.env) ? expected.env : {};
  const expectedToken = expectedEnv.LETAGENTS_TOKEN?.trim() || null;
  const serverToken = getTomlStringValue(envBody || "", "LETAGENTS_TOKEN")?.trim()
    || null;
  const matchesExpected =
    getTomlStringValue(serverBody, "command") === expected.command &&
    JSON.stringify(getTomlStringArrayValue(serverBody, "args")) ===
      JSON.stringify(expected.args) &&
    getTomlStringValue(serverBody, "cwd") === expected.cwd &&
    envBody !== null &&
    getTomlStringValue(envBody, "LETAGENTS_API_URL") ===
      expectedEnv.LETAGENTS_API_URL &&
    (expectedToken ? serverToken === expectedToken : serverToken === null);

  return matchesExpected ? "installed" : "needs_attention";
}

export function buildCodexTomlLetAgentsMcpConfig(
  currentConfig: string,
  expected: LetAgentsMcpServerConfig,
): string {
  const withoutLetAgentsTables = removeTomlTable(
    removeTomlTable(currentConfig, "mcp_servers.letagents.env"),
    "mcp_servers.letagents",
  ).trimEnd();
  const expectedEnv = isStringRecord(expected.env) ? expected.env : {};
  const envEntries = Object.entries(expectedEnv)
    .filter((entry) => entry[0] !== "LETAGENTS_API_URL" && entry[0] !== "LETAGENTS_TOKEN")
    .sort(([left], [right]) => left.localeCompare(right));
  const envLines = [
    ["LETAGENTS_API_URL", expectedEnv.LETAGENTS_API_URL || ""],
    ...envEntries,
  ];
  const expectedToken = expectedEnv.LETAGENTS_TOKEN?.trim() || null;
  if (expectedToken) envLines.push(["LETAGENTS_TOKEN", expectedToken]);

  const letAgentsTable = [
    "[mcp_servers.letagents]",
    `command = ${tomlString(expected.command || "npx")}`,
    `args = ${tomlStringArray(expected.args || ["-y", "letagents"])}`,
    `cwd = ${tomlString(expected.cwd || "")}`,
    "",
    "[mcp_servers.letagents.env]",
    ...envLines.map(([key, value]) => `${key} = ${tomlString(value)}`),
  ].join("\n");

  return `${withoutLetAgentsTables ? `${withoutLetAgentsTables}\n\n` : ""}${letAgentsTable}\n`;
}
