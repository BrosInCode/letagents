/**
 * "Use your own setup" for an Antigravity agent. The agent keeps its own data
 * folder (its conversations stay apart from the owner's), and at each start
 * that folder is given the owner's own Antigravity setup:
 *
 * - `GEMINI.md` and `AGENTS.md` (the owner's global rules),
 * - `config/mcp_config.json` (the owner's MCP servers),
 * - `config/plugins` (one link per plugin) and the skill folders.
 *
 * Every LetAgents server is left out, the owner's own and any a plugin brings:
 * agy prefers a configured server over the session's own of the same name
 * (verified on agy 1.5.15), and such a server would act as the owner. The
 * room's server given to the session stays the agent's only LetAgents
 * connection. With the setup off, everything placed here is removed again.
 * The owner's permission rules (`settings.json`) are not used.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MARKER = ".letagents-owner-setup.json";
/** Entries this module may place in an agent's folder, relative to it. */
const MANAGED = ["GEMINI.md", "AGENTS.md", "config/mcp_config.json", "config/plugins", "config/skills", "config/skills.json", "antigravity-cli/skills"] as const;

type McpServers = Record<string, Record<string, unknown>>;

export function defaultOwnerGeminiDir(): string {
  return join(homedir(), ".gemini");
}

/** A server that runs LetAgents: by its name, or by the package or entry it starts. */
export function isLetAgentsServer(name: string, server: Record<string, unknown>): boolean {
  if (/letagents/i.test(name)) return true;
  const parts = [server.command, ...(Array.isArray(server.args) ? server.args : []), server.serverUrl, server.url, server.httpUrl]
    .filter((part): part is string => typeof part === "string");
  return parts.some((part) => /letagents/i.test(part));
}

function readServers(path: string): McpServers | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? servers as McpServers : {};
  } catch {
    return null;
  }
}

function removeManaged(agentDir: string): void {
  for (const entry of MANAGED) {
    const path = join(agentDir, entry);
    try {
      const stat = lstatSync(path);
      rmSync(path, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
    } catch { /* not there */ }
  }
  rmSync(join(agentDir, MARKER), { force: true });
}

function link(target: string, path: string): boolean {
  if (!existsSync(target)) return false;
  symlinkSync(target, path);
  return true;
}

/**
 * Give the agent's folder the owner's setup, or take it away. Returns the
 * notices the owner reads: which LetAgents servers were left out.
 */
export function prepareAntigravityOwnerSetup(agentDir: string, enabled: boolean, ownerDir = defaultOwnerGeminiDir()): { notices: string[] } {
  const hadSetup = existsSync(join(agentDir, MARKER));
  if (hadSetup || enabled) removeManaged(agentDir);
  if (!enabled) return { notices: [] };
  mkdirSync(join(agentDir, "config"), { recursive: true, mode: 0o700 });
  mkdirSync(join(agentDir, "antigravity-cli"), { recursive: true, mode: 0o700 });
  const placed: string[] = [];
  const leftOut: string[] = [];
  for (const rules of ["GEMINI.md", "AGENTS.md"]) {
    if (link(join(ownerDir, rules), join(agentDir, rules))) placed.push(rules);
  }
  const servers = readServers(join(ownerDir, "config", "mcp_config.json"));
  if (servers) {
    const kept: McpServers = {};
    for (const [name, server] of Object.entries(servers)) {
      if (server && typeof server === "object" && isLetAgentsServer(name, server)) leftOut.push(name);
      else kept[name] = server;
    }
    // Server settings can hold the owner's tokens: owner-only, like the owner's own file should be.
    writeFileSync(join(agentDir, "config", "mcp_config.json"), JSON.stringify({ mcpServers: kept }, null, 2), { mode: 0o600 });
    placed.push("config/mcp_config.json");
  }
  const pluginsDir = join(ownerDir, "config", "plugins");
  if (existsSync(pluginsDir)) {
    mkdirSync(join(agentDir, "config", "plugins"), { mode: 0o700 });
    for (const plugin of readdirSync(pluginsDir)) {
      const pluginServers = readServers(join(pluginsDir, plugin, "mcp_config.json"));
      const letagents = Object.entries(pluginServers ?? {}).filter(([name, server]) => server && typeof server === "object" && isLetAgentsServer(name, server));
      if (letagents.length) {
        leftOut.push(`the ${plugin} plugin`);
        continue;
      }
      link(join(pluginsDir, plugin), join(agentDir, "config", "plugins", plugin));
    }
    placed.push("config/plugins");
  }
  for (const skills of ["config/skills", "config/skills.json", "antigravity-cli/skills"]) {
    if (link(join(ownerDir, skills), join(agentDir, skills))) placed.push(skills);
  }
  writeFileSync(join(agentDir, MARKER), JSON.stringify({ placed }), { mode: 0o600 });
  return {
    notices: leftOut.length
      ? [`With your own setup on, this agent's only LetAgents connection is its room's own. These parts of your Antigravity setup were left out because they run LetAgents: ${leftOut.slice(0, 6).join(", ")}${leftOut.length > 6 ? ` and ${leftOut.length - 6} more` : ""}.`]
      : [],
  };
}
