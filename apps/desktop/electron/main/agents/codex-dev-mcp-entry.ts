import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/**
 * Build development-only per-launch MCP entry overrides for supervised Codex smoke tests.
 *
 * Preserves the user's installed auth/env and adds no bearer credential. In packaged
 * (production) builds this always returns an empty array. When entryPath is provided in
 * a non-packaged build, the Codex MCP server entry is replaced with a local built artefact
 * without touching the global ~/.codex config or publishing npm.
 *
 * The returned overrides set only `command` and `args`; `cwd` is always added by the
 * existing codexMcpWorkplaceConfigOverrides path and is never duplicated here.
 */
export async function buildCodexDevMcpEntryOverrides(
  entryPath: string,
  isPackaged: boolean,
): Promise<string[]> {
  if (isPackaged) return [];
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
