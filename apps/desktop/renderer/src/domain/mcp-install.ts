import type { DesktopMcpInstallState, DesktopMcpInstallTargetId } from "../../../electron/ipc-types";

export const fallbackMcpInstallState: DesktopMcpInstallState = {
  completed: false,
  completedAt: null,
  selectedTargetId: null,
  targets: [
    {
      id: "claude-code",
      name: "Claude Code",
      description: "We'll add the MCP bridge for room access.",
      configPath: "~/.claude/settings.json",
      configPaths: [
        {
          path: "~/.claude/settings.json",
          label: "Claude settings",
          status: "not_installed",
          hasLetAgents: false,
          issue: null,
        },
        {
          path: "~/.claude.json",
          label: "Claude user config",
          status: "not_installed",
          hasLetAgents: false,
          issue: null,
        },
      ],
      configIssue: null,
      status: "not_installed",
      lastInstalledAt: null,
      restartHint: "Restart Claude Code or reload its MCP servers after installing.",
    },
    {
      id: "antigravity",
      name: "Antigravity",
      description: "We'll add the MCP bridge for room access.",
      configPath: "~/.gemini/settings.json",
      configPaths: [
        {
          path: "~/.gemini/settings.json",
          label: "Antigravity settings",
          status: "not_installed",
          hasLetAgents: false,
          issue: null,
        },
      ],
      configIssue: null,
      status: "not_installed",
      lastInstalledAt: null,
      restartHint: "Restart Antigravity so it picks up the updated MCP settings.",
    },
    {
      id: "cursor",
      name: "Cursor",
      description: "We'll add the MCP bridge for room access.",
      configPath: "~/.cursor/mcp.json",
      configPaths: [
        {
          path: "~/.cursor/mcp.json",
          label: "Cursor MCP config",
          status: "not_installed",
          hasLetAgents: false,
          issue: null,
        },
      ],
      configIssue: null,
      status: "not_installed",
      lastInstalledAt: null,
      restartHint: "Reload Cursor or restart its MCP server after installing.",
    },
    {
      id: "codex",
      name: "Codex",
      description: "We'll install Codex CLI if it is missing, then add the MCP bridge.",
      configPath: "~/.codex/config.toml",
      configPaths: [
        {
          path: "~/.codex/config.toml",
          label: "Codex config",
          status: "not_installed",
          hasLetAgents: false,
          issue: null,
        },
      ],
      configIssue: null,
      status: "not_installed",
      lastInstalledAt: null,
      restartHint: "Restart Codex so it discovers the LetAgents MCP server.",
    },
  ],
};

export function defaultMcpTargetSelection(state: DesktopMcpInstallState): DesktopMcpInstallTargetId[] {
  const installedTargets = state.targets.filter((target) => target.status === "installed").map((target) => target.id);
  if (installedTargets.length) return installedTargets;
  if (state.selectedTargetId) return [state.selectedTargetId];
  return state.targets[0] ? [state.targets[0].id] : [];
}
