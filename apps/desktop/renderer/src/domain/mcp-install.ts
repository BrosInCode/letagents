import type { DesktopMcpInstallState, DesktopMcpInstallTargetId } from "../../../electron/ipc-types";

export const fallbackMcpInstallState: DesktopMcpInstallState = {
  completed: false,
  completedAt: null,
  selectedTargetId: null,
  targets: [
    {
      id: "claude-code",
      name: "Claude Code",
      description: "Add the MCP connection Claude Code needs to join rooms.",
      configPath: "~/.claude/settings.json",
      status: "needs_attention",
      lastInstalledAt: null,
      restartHint: "Restart Claude Code or reload its MCP servers after installing.",
    },
    {
      id: "antigravity",
      name: "Antigravity",
      description: "Add the MCP connection Antigravity needs to join rooms.",
      configPath: "~/.gemini/settings.json",
      status: "needs_attention",
      lastInstalledAt: null,
      restartHint: "Restart Antigravity so it picks up the updated MCP settings.",
    },
    {
      id: "cursor",
      name: "Cursor",
      description: "Add the MCP connection Cursor needs to join rooms.",
      configPath: "~/.cursor/mcp.json",
      status: "needs_attention",
      lastInstalledAt: null,
      restartHint: "Reload Cursor or restart its MCP server after installing.",
    },
    {
      id: "codex",
      name: "Codex",
      description: "Add the MCP connection Codex needs to join rooms.",
      configPath: "~/.codex/mcp.json",
      status: "needs_attention",
      lastInstalledAt: null,
      restartHint: "Restart Codex so it discovers the LetAgents MCP server.",
    },
  ],
};

export function defaultMcpTargetSelection(state: DesktopMcpInstallState): DesktopMcpInstallTargetId[] {
  const installedTargets = state.targets.filter((target) => target.status === "installed").map((target) => target.id);
  if (installedTargets.length) return installedTargets;
  if (state.selectedTargetId) return [state.selectedTargetId];
  return state.targets[0]?.id ? [state.targets[0].id] : [];
}
