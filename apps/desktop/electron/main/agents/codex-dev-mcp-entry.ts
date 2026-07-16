import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/**
 * Build development-only per-launch MCP entry overrides for supervised Codex smoke tests.
 *
 * Preserves the user's installed auth/env and adds no bearer credential. The caller is
 * responsible for gating invocation: the daemon only supplies entryPath when BOTH
 * LETAGENTS_DESKTOP_DEV_SERVER_URL and LETAGENTS_DEV_MCP_SERVER_ENTRY are set AND the
 * provider is Codex. This function itself validates the path but does not re-check those
 * gates. When entryPath is provided, the Codex MCP server entry is replaced with the
 * local built artefact without touching the global ~/.codex config or publishing npm.
 *
 * The returned overrides set only `command` and `args`; `cwd` is always added by the
 * existing codexMcpWorkplaceConfigOverrides path and is never duplicated here.
 */
export async function buildCodexDevMcpEntryOverrides(
  entryPath: string,
): Promise<string[]> {
  if (!isAbsolute(entryPath)) {
    throw new Error("Codex dev MCP entry path must be absolute.");
  }
  let info;
  try {
    info = await lstat(entryPath);
  } catch {
    throw new Error(`Codex dev MCP entry path does not exist: ${entryPath}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Codex dev MCP entry path must be a regular built file.");
  }
  return [
    `mcp_servers.letagents.command=${JSON.stringify("node")}`,
    `mcp_servers.letagents.args=${JSON.stringify([entryPath])}`,
  ];
}
