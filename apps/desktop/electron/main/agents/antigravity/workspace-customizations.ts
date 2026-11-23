/**
 * A workspace can carry Antigravity customizations that run commands: hooks,
 * plugins and MCP servers in `.agents/` (or `.agent/`, `_agents/`, `_agent/`).
 * agy loads them from the working folder up to the repository root, and from
 * the working folder alone outside a repository. It runs them with no
 * permission request at every access level, and `--include-default-customizations=false`
 * does not stop them (both verified on agy 1.5.15). Only Full access already
 * lets the agent run any command, so every other level refuses such a workspace.
 * Rules and skills are instructions, not commands, and stay allowed.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const CUSTOMIZATION_FOLDERS = [".agents", ".agent", "_agents", "_agent"] as const;
/** Files in a customization folder that start commands or servers, or name plugins elsewhere. */
const RUNNING_FILES = ["hooks.json", "mcp_config.json", "plugins.json"] as const;
const PLUGIN_RUNNING_FILES = ["hooks.json", join("hooks", "hooks.json"), "mcp_config.json"] as const;
const MAX_DEPTH = 64;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folders agy searches for workspace customizations, nearest first. */
function searchedFolders(cwd: string): string[] {
  const chain: string[] = [];
  for (let folder = resolve(cwd), depth = 0; depth < MAX_DEPTH; depth += 1) {
    chain.push(folder);
    // A repository's root holds `.git` (a folder, or a file in a linked worktree).
    if (existsSync(join(folder, ".git"))) return chain;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return [resolve(cwd)];
}

/**
 * The workspace files that make agy run commands without asking, relative to
 * the working folder. Empty when there are none.
 */
export function antigravityWorkspaceCommandCustomizations(cwd: string): string[] {
  const found: string[] = [];
  const root = resolve(cwd);
  for (const folder of searchedFolders(cwd)) {
    for (const name of CUSTOMIZATION_FOLDERS) {
      const customizations = join(folder, name);
      if (!isDirectory(customizations)) continue;
      for (const file of RUNNING_FILES) {
        if (existsSync(join(customizations, file))) found.push(join(customizations, file));
      }
      const plugins = join(customizations, "plugins");
      if (!isDirectory(plugins)) continue;
      let entries: string[] = [];
      try {
        entries = readdirSync(plugins);
      } catch {
        // An unreadable plugins folder may hold anything.
        found.push(plugins);
        continue;
      }
      for (const plugin of entries) {
        for (const file of PLUGIN_RUNNING_FILES) {
          if (existsSync(join(plugins, plugin, file))) found.push(join(plugins, plugin, file));
        }
      }
    }
  }
  return found.map((path) => relative(root, path) || path);
}

/** The owner-facing reason a non-Full-access agent does not run in this workspace, or null. */
export function antigravityWorkspaceRefusal(cwd: string): string | null {
  const found = antigravityWorkspaceCommandCustomizations(cwd);
  if (!found.length) return null;
  const named = `${found.slice(0, 4).join(", ")}${found.length > 4 ? ` and ${found.length - 4} more` : ""}`;
  return `This workspace has Antigravity hooks, plugins or MCP servers (${named}). Antigravity runs them without asking at every access level, so this agent does not run here. Remove them from the workspace, or give the agent Full access.`;
}
