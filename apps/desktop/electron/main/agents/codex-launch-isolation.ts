import { execFile } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CODEX_OWNER_FEATURE_OVERRIDES } from "../../../../../shared/codex-owner-isolation.mjs";

/**
 * A managed Codex agent works for a room, not as the owner, yet the launch
 * shares the owner's CODEX_HOME so Codex sign-in keeps working. The shared
 * feature overrides turn off the owner's plugins, app connectors, computer and
 * browser use, hooks, memories and notifier. This module adds what needs the
 * owner's files: their personal skills, and every MCP server but LetAgents.
 * The owner's config, auth, and session history are not modified, and the
 * project's own skills and AGENTS.md still load.
 *
 * Codex has no launch switch for its global AGENTS.md or its saved command
 * rules, so those still reach a managed agent from CODEX_HOME.
 */
export { CODEX_OWNER_FEATURE_OVERRIDES };

const LETAGENTS_MCP_SERVER_NAME = "letagents";
// `codex mcp list` checks OAuth for HTTP servers, which can take seconds when
// one is unreachable. A launch waits this long at most, then fails.
const MCP_LIST_TIMEOUT_MS = 10_000;
// Codex finds a SKILL.md at most six directories below a skill root.
const MAX_SKILL_DEPTH = 6;
const MAX_SKILL_FILES = 1_000;
// The walk runs synchronously at launch; bound it like the file count.
const MAX_SKILL_DIRECTORIES = 10_000;

export function codexHomeDirectory(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".codex");
}

/**
 * SKILL.md files in Codex's user skill roots: CODEX_HOME/skills, apart from
 * Codex's own bundled `.system` skills, and ~/.agents/skills. Both are
 * searched to the same depth as Codex, including inside other skills.
 */
export function codexPersonalSkillFiles(env: NodeJS.ProcessEnv): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const walk = (directory: string, depth: number) => {
    if (depth > MAX_SKILL_DEPTH || files.length >= MAX_SKILL_FILES || visited.size >= MAX_SKILL_DIRECTORIES) return;
    let canonical: string;
    let entries: string[];
    try {
      canonical = realpathSync(directory);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (files.length >= MAX_SKILL_FILES) return;
      // Hidden entries include Codex's bundled `.system` skills.
      if (name.startsWith(".")) continue;
      const path = join(directory, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path, depth + 1);
      } else if (name === "SKILL.md" && stat.isFile()) {
        files.push(path);
        try {
          const real = realpathSync(path);
          if (real !== path) files.push(real);
        } catch {
          // The listed path is enough when it cannot be resolved.
        }
      }
    }
  };
  walk(join(codexHomeDirectory(env), "skills"), 0);
  walk(join(env.HOME?.trim() || homedir(), ".agents", "skills"), 0);
  return [...new Set(files)];
}

export function codexSkillDisableOverride(skillFiles: readonly string[]): string | null {
  if (!skillFiles.length) return null;
  const entries = skillFiles.map((path) => `{ path = ${JSON.stringify(path)}, enabled = false }`);
  return `skills.config=[${entries.join(", ")}]`;
}

/**
 * Codex's dotted -c paths split on every dot, even inside quotes, so a server
 * name with a dot cannot be addressed that way. A parent-table override is
 * merged into the configured servers and names each one exactly.
 */
export function codexMcpServerDisableOverride(serverNames: readonly string[]): string | null {
  const names = [...new Set(serverNames)].filter((name) => name !== LETAGENTS_MCP_SERVER_NAME).sort();
  if (!names.length) return null;
  return `mcp_servers={ ${names.map((name) => `${JSON.stringify(name)} = { enabled = false }`).join(", ")} }`;
}

/** Overrides that need no Codex process: the fixed features and personal skills. */
export function codexOwnerExtensionOverrides(env: NodeJS.ProcessEnv): string[] {
  const skills = codexSkillDisableOverride(codexPersonalSkillFiles(env));
  return [...CODEX_OWNER_FEATURE_OVERRIDES, ...(skills ? [skills] : [])];
}

export type CodexMcpServerListRunner = (
  codexBin: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => Promise<string>;

const runCodexMcpList: CodexMcpServerListRunner = (codexBin, args, options) => new Promise((resolve, reject) => {
  const child = execFile(codexBin, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    encoding: "utf8",
    timeout: MCP_LIST_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve(String(stdout));
  });
  child.stdin?.end();
});

/**
 * Every MCP server this launch would configure, as Codex itself resolves them
 * from the owner's config and any trusted project config. The same overrides
 * are applied so the list matches what the app-server will see.
 */
export async function listCodexMcpServerNames(
  codexBin: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv; configOverrides: readonly string[] },
  run: CodexMcpServerListRunner = runCodexMcpList,
): Promise<string[]> {
  let output: string;
  try {
    output = await run(codexBin, [
      "mcp", "list", "--json",
      ...options.configOverrides.flatMap((override) => ["-c", override]),
    ], { cwd: options.cwd, env: options.env });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      `Codex could not list its MCP servers, so LetAgents will not start it with the owner's own tools: ${detail}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) =>
    entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string")) {
    throw new Error("Codex returned an unreadable MCP server list, so LetAgents will not start it.");
  }
  return (parsed as Array<{ name: string }>).map((entry) => entry.name);
}
