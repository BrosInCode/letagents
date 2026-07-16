import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE = ".letagents-supervisor-context.json";

export interface CodexSupervisorBridgeContext {
  version: 1;
  provider: "codex";
  entry_id: string;
  room_id: string;
  work_attempt_id: string;
  execution_generation_id: string;
}

/**
 * Persist non-secret daemon coordinates in the exact daemon-owned worktree.
 *
 * Codex may execute an already-running MCP bridge outside the app-server's
 * process environment. The MCP server still receives this worktree as its
 * configured cwd, so this owner-only, atomic context gives it a stable route
 * back to the exact live supervisor generation. Worker credentials never
 * enter this file; they are minted later by register_agent_session and travel
 * directly from the MCP process to the daemon socket.
 */
export async function writeCodexSupervisorBridgeContext(
  cwd: string,
  context: Omit<CodexSupervisorBridgeContext, "version" | "provider">,
): Promise<void> {
  for (const [field, value] of Object.entries(context)) {
    if (!value.trim()) throw new Error(`Codex supervisor bridge ${field} is required.`);
  }
  const destination = join(cwd, CODEX_SUPERVISOR_BRIDGE_CONTEXT_FILE);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, provider: "codex", ...context })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
