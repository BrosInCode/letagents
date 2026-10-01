import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// A Codex app-server that LetAgents launches works for a room, not as the
// owner, yet it shares the owner's CODEX_HOME so Codex sign-in keeps working.
// These launch overrides turn the owner's extensions off for that launch only.
// The owner's config, auth and session history are not modified, and the
// project's own skills and AGENTS.md still load. Codex has no launch switch
// for its global AGENTS.md or its saved command rules, so those still reach
// the agent. Shared by the desktop and the published MCP package, so it uses
// nothing but Node.

/** Plugins (with their MCP servers and skills), app connectors, computer and browser use, hooks, memories, notifier. */
export const CODEX_OWNER_FEATURE_OVERRIDES = Object.freeze([
  "features.plugins=false",
  "features.apps=false",
  "features.computer_use=false",
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.hooks=false",
  "features.memories=false",
  "notify=[]",
]);

/** The room's own MCP server, the one server a LetAgents-launched Codex keeps. */
export const LETAGENTS_MCP_SERVER_NAME = "letagents";

// `codex mcp list` checks OAuth for HTTP servers, which can take seconds when
// one is unreachable. A launch waits this long at most, then fails.
const MCP_LIST_TIMEOUT_MS = 10_000;
// Codex finds a SKILL.md at most six directories below a skill root.
const MAX_SKILL_DEPTH = 6;
const MAX_SKILL_FILES = 1_000;
const MAX_SKILL_DIRECTORIES = 10_000;

export function codexHomeDirectory(env) {
  return env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".codex");
}

/**
 * SKILL.md files in Codex's user skill roots: CODEX_HOME/skills, apart from
 * Codex's own bundled `.system` skills, and ~/.agents/skills. Both are
 * searched to the same depth as Codex, including inside other skills.
 */
export async function codexPersonalSkillFiles(env) {
  const files = [];
  const visited = new Set();
  const walk = async (directory, depth) => {
    if (depth > MAX_SKILL_DEPTH || files.length >= MAX_SKILL_FILES || visited.size >= MAX_SKILL_DIRECTORIES) return;
    let entries;
    try {
      const canonical = await realpath(directory);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (files.length >= MAX_SKILL_FILES) return;
      // Hidden entries include Codex's bundled `.system` skills.
      if (name.startsWith(".")) continue;
      const path = join(directory, name);
      let entry;
      try {
        entry = await stat(path);
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (name === "SKILL.md" && entry.isFile()) {
        files.push(path);
        try {
          const real = await realpath(path);
          if (real !== path) files.push(real);
        } catch {
          // The listed path is enough when it cannot be resolved.
        }
      }
    }
  };
  await walk(join(codexHomeDirectory(env), "skills"), 0);
  await walk(join(env.HOME?.trim() || homedir(), ".agents", "skills"), 0);
  return [...new Set(files)];
}

export function codexSkillDisableOverride(skillFiles) {
  if (!skillFiles.length) return null;
  const entries = skillFiles.map((path) => `{ path = ${JSON.stringify(path)}, enabled = false }`);
  return `skills.config=[${entries.join(", ")}]`;
}

/**
 * Codex's dotted -c paths split on every dot, even inside quotes, so a server
 * name with a dot cannot be addressed that way. A parent-table override is
 * merged into the configured servers and names each one exactly.
 */
export function codexMcpServerDisableOverride(serverNames) {
  const names = [...new Set(serverNames)].filter((name) => name !== LETAGENTS_MCP_SERVER_NAME).sort();
  if (!names.length) return null;
  return `mcp_servers={ ${names.map((name) => `${JSON.stringify(name)} = { enabled = false }`).join(", ")} }`;
}

export function runCodexMcpList(codexBin, args, options) {
  return new Promise((resolve, reject) => {
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
}

/**
 * Every MCP server a launch would configure, as Codex itself resolves them
 * from the owner's config and any trusted project config. Pass the launch's
 * own overrides so the list matches what the app-server will see.
 */
export async function listCodexMcpServerNames(codexBin, options, run = runCodexMcpList) {
  let output;
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
  let parsed = null;
  try {
    parsed = JSON.parse(output);
  } catch {
    // Rejected below.
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => entry && typeof entry === "object" && typeof entry.name === "string")) {
    throw new Error("Codex returned an unreadable MCP server list, so LetAgents will not start it.");
  }
  return parsed.map((entry) => entry.name);
}

/**
 * Every override a LetAgents launch adds: the features, each personal skill,
 * and every MCP server but LetAgents. `configOverrides` are the launch's own
 * (for example project trust), used only to list servers. A launch that
 * cannot list its servers fails here instead of starting with them.
 */
export async function codexOwnerIsolationOverrides(codexBin, options, run = runCodexMcpList) {
  const [serverNames, skillFiles] = await Promise.all([
    listCodexMcpServerNames(codexBin, {
      cwd: options.cwd,
      env: options.env,
      configOverrides: [...(options.configOverrides ?? []), ...CODEX_OWNER_FEATURE_OVERRIDES],
    }, run),
    codexPersonalSkillFiles(options.env),
  ]);
  const skills = codexSkillDisableOverride(skillFiles);
  const servers = codexMcpServerDisableOverride(serverNames);
  return [...CODEX_OWNER_FEATURE_OVERRIDES, ...(skills ? [skills] : []), ...(servers ? [servers] : [])];
}
