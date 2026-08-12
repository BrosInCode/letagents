import { isAbsolute } from "node:path";

/**
 * Resolve the dev-only MCP server entry override from the environment.
 * Returns the absolute path only when BOTH gates are present:
 *   1. LETAGENTS_DESKTOP_DEV_SERVER_URL — the standard dev-runtime signal set
 *      by the desktop dev-server launcher.
 *   2. LETAGENTS_DEV_MCP_SERVER_ENTRY — an absolute path to a locally built MCP
 *      server entry (e.g. dist/mcp/server.js).
 * Absent either gate → returns null; the Codex spawn request carries no dev
 * override and the standard installed MCP server is used unchanged.
 */
export function devMcpServerEntryFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim()) return null;
  const entry = env.LETAGENTS_DEV_MCP_SERVER_ENTRY?.trim();
  if (!entry || !isAbsolute(entry)) return null;
  return entry;
}
