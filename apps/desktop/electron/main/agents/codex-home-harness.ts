import { spawn } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative } from "node:path";

import {
  CODEX_OWNER_FEATURE_OVERRIDES,
  LETAGENTS_MCP_SERVER_NAME,
  assertProjectKeepsLetAgentsServer,
  codexMcpServerDisableOverride,
  listCodexMcpServers,
  runCodexMcpList,
  type CodexMcpListRunner,
  type CodexMcpServerEntry,
} from "../../../../../shared/codex-owner-isolation.mjs";

// A launch that keeps the owner's own Codex setup leaves the owner's
// extensions on: plugins, app connectors, computer and browser use, hooks,
// memories, the notifier, skills and MCP servers. It is the owner's setup and
// never the project's. Codex also reads a trusted project's own .codex folder,
// and with the owner's extensions on that folder could add its own servers and
// hooks, change the owner's servers, or pre-approve commands. So before such a
// launch Codex itself is asked what the project would contribute, and each
// thing is turned off for the launch or the launch is refused. The project's
// AGENTS.md and skills still load, as they do for every agent.

const INSPECTION_TIMEOUT_MS = 15_000;
const DID_NOT_ANSWER_IN_TIME = "Codex did not answer in time";
/** Where Codex says a hook comes from when it is the owner's or the machine's, not the project's. */
const OWNER_HOOK_SOURCES = new Set([
  "user", "system", "mdm", "plugin", "sessionFlags",
  "cloudRequirements", "cloudManagedConfig", "legacyManagedConfigFile", "legacyManagedConfigMdm",
]);
/** What a project's config may contribute to a launch: servers and hooks, which are then turned off by name. */
const NEUTRALISED_PROJECT_KEYS = new Set(["mcp_servers", "hooks"]);
/**
 * Folders of a project layer that Codex acts on with no setting naming them,
 * and that cannot be turned off for a launch. Codex 0.153.4 reads command
 * rules from `rules` (every regular file whose extension is `rules`, hidden
 * ones included, through a `rules` that is itself a link) and agent roles
 * from `agents` (every `.toml` file, at any depth).
 */
const PROJECT_FOLDERS_CODEX_ACTS_ON = ["rules", "agents"] as const;

export type CodexProjectLayer = { dotCodexFolder: string; config: Record<string, unknown> };
/** A hook Codex would run in the project. `outsideProject`: Codex lists the same hook where no project applies. */
export type CodexHook = { key: string; source: string; enabled: boolean; outsideProject: boolean };
export type CodexProjectInspection = { projectLayers: CodexProjectLayer[]; hooks: CodexHook[] };
type LaunchView = { cwd: string; env: NodeJS.ProcessEnv; configOverrides: readonly string[] };

export type CodexHomeHarnessDependencies = {
  listServers(codexBin: string, options: { cwd: string; env: NodeJS.ProcessEnv; configOverrides: readonly string[] }): Promise<CodexMcpServerEntry[]>;
  inspect(codexBin: string, options: LaunchView): Promise<CodexProjectInspection>;
  /** Everything in one folder of a project layer (`rules`, `agents`). It may list more than Codex reads, never less. */
  projectFolderEntries(folder: string): string[];
};

/**
 * A hook is the owner's only when Codex says so twice: it names an owner's
 * source for it, and it lists the same hook outside any project. Everything
 * else Codex would run in the project is the project's.
 */
function isProjectHook(hook: CodexHook): boolean {
  return !hook.outsideProject || !OWNER_HOOK_SOURCES.has(hook.source);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** Everything about a listed server except its name and its sign-in state, which is not configuration. */
function serverShape(entry: CodexMcpServerEntry): string {
  const { name: _name, auth_status: _authStatus, ...shape } = entry;
  return stableJson(shape);
}

/**
 * A path as its owner knows it: from the top of the repository, not from
 * wherever LetAgents keeps the agent's copy of it. The top is the nearest
 * folder at or above the agent's that has a `.git`, or the agent's own.
 */
function pathInRepository(cwd: string, path: string): string {
  const tops = [cwd];
  try {
    const hasGit = (folder: string) => lstatSync(join(folder, ".git"), { throwIfNoEntry: false }) !== undefined;
    let top = cwd;
    while (!hasGit(top) && dirname(top) !== top) top = dirname(top);
    if (hasGit(top)) tops[0] = top;
    // Codex may name the path with its links followed.
    tops.push(realpathSync(tops[0]!));
  } catch {
    // A folder that cannot be looked at is not the top.
  }
  for (const top of tops) {
    const shown = relative(top, path);
    if (shown && !shown.startsWith("..") && !isAbsolute(shown)) return shown;
  }
  return path;
}

/** Names a project chose, as they are shown: printable, short, and only the first few. */
function shownNames(names: readonly string[]): string {
  const shown = names.slice(0, 3).map((name) => name.replace(/[^\x20-\x7e]/g, "?").slice(0, 60));
  return `${shown.join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
}

function refusal(reason: string, remedy: string): Error {
  return new Error(
    `${reason}, so LetAgents will not start Codex here with your own setup. ${remedy}, `
    + "stop trusting the project in Codex, or turn off \"Use your own Codex setup\" for this agent.",
  );
}

/**
 * Ask Codex, without starting anything, what a launch in `cwd` would read
 * from the project. A short-lived app-server is started outside any project,
 * so it loads no project config itself, and is asked for the layered config
 * and the hooks as seen from `cwd`. It opens no thread, so it starts no MCP
 * server and runs no hook. It is always stopped, and a slow one is an error.
 */
export function inspectCodexProject(codexBin: string, options: LaunchView, timeoutMs = INSPECTION_TIMEOUT_MS): Promise<CodexProjectInspection> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, [
      "app-server",
      ...options.configOverrides.flatMap((override) => ["-c", override]),
      "--listen", "stdio://",
    ], { cwd: parse(options.cwd).root || "/", env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let settled = false;
    let buffer = "";
    const pending = new Map<number, (result: unknown, error: unknown) => void>();
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const finish = (error: Error | null, value?: CodexProjectInspection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(DID_NOT_ANSWER_IN_TIME)), timeoutMs);
    const request = (id: number, method: string, params: unknown) => new Promise<unknown>((done, fail) => {
      pending.set(id, (result, error) => error ? fail(new Error(`${method} failed`)) : done(result));
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    child.once("error", (error) => finish(error));
    // What Codex prints when it stops can quote the owner's or the project's
    // config, so it is drained and never put into a message anyone is shown.
    child.stderr.resume();
    child.once("exit", () => finish(new Error("Codex stopped before it answered")));
    child.stdin.on("error", () => { /* Reported by the exit above. */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: Record<string, unknown> | null = null;
        try {
          message = record(JSON.parse(line));
        } catch {
          continue;
        }
        if (!message || typeof message.id !== "number" || typeof message.method === "string") continue;
        pending.get(message.id)?.(message.result, message.error);
        pending.delete(message.id);
      }
    });
    void (async () => {
      await request(1, "initialize", { clientInfo: { name: "letagents", title: "LetAgents", version: "1" } });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const outside = parse(options.cwd).root || "/";
      const [config, hooks] = await Promise.all([
        request(2, "config/read", { includeLayers: true, cwd: options.cwd }),
        // The same question for the project and for a folder no project applies to.
        request(3, "hooks/list", { cwds: [options.cwd, outside] }),
      ]);
      finish(null, readInspection(config, hooks, outside));
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/** An answer Codex gave in a shape this code does not know is an error, never an empty project. */
function readInspection(config: unknown, hooks: unknown, outsideFolder: string): CodexProjectInspection {
  const layers = record(config)?.layers;
  const listed = record(hooks)?.data;
  if (!Array.isArray(layers) || !Array.isArray(listed)) throw new Error("Codex returned unreadable settings");
  const projectLayers: CodexProjectLayer[] = [];
  for (const layer of layers) {
    const name = record(record(layer)?.name);
    if (!name || typeof name.type !== "string") throw new Error("Codex returned an unreadable settings layer");
    // A layer Codex is not applying, such as a project the owner has not trusted, contributes nothing.
    if (name.type !== "project" || record(layer)!.disabledReason != null) continue;
    const layerConfig = record(record(layer)!.config);
    if (typeof name.dotCodexFolder !== "string" || !layerConfig) throw new Error("Codex returned an unreadable project layer");
    projectLayers.push({ dotCodexFolder: name.dotCodexFolder, config: layerConfig });
  }
  // Two answers, in the order asked: the project's folder, then a folder outside any project.
  if (listed.length !== 2 || record(listed[1])?.cwd !== outsideFolder) throw new Error("Codex returned an unreadable hook list");
  const [inProject, outside] = listed.map((entry) => {
    const entryHooks = record(entry)?.hooks;
    if (!Array.isArray(entryHooks)) throw new Error("Codex returned an unreadable hook list");
    return entryHooks.map((hook) => {
      const item = record(hook);
      if (!item || typeof item.key !== "string" || !item.key || typeof item.source !== "string") {
        throw new Error("Codex returned an unreadable hook");
      }
      return { key: item.key, source: item.source, enabled: item.enabled !== false };
    });
  });
  const outsideKeys = new Set(outside!.map((hook) => `${hook.source}\n${hook.key}`));
  return { projectLayers, hooks: inProject!.map((hook) => ({ ...hook, outsideProject: outsideKeys.has(`${hook.source}\n${hook.key}`) })) };
}

/**
 * Every entry of one folder of a project layer. Codex cannot be asked which
 * rule or role files it loaded, so the folder is listed here, and listed more
 * widely than Codex reads it: every entry counts, whatever its name, kind or
 * depth, hidden or not, link or not. A folder that is there but cannot be
 * listed counts as one entry, and so does a link that leads nowhere. Only a
 * folder that is not there at all, or is empty, has none. This can make a
 * launch be refused for a file Codex would have ignored, never the reverse.
 */
function projectFolderEntries(folder: string): string[] {
  try {
    return readdirSync(folder).map((name) => join(folder, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !lstatSync(folder, { throwIfNoEntry: false })) return [];
    return [folder];
  }
}

/**
 * `codex mcp list` for a managed launch. A run that fails reports its whole
 * command line, and that line carries the room server's coordinates, so only
 * why it failed is passed on: it was too slow, or how it ended.
 */
export const runCodexMcpListForLaunch: CodexMcpListRunner = (bin, args, runOptions) =>
  runCodexMcpList(bin, args, runOptions).catch((error: unknown) => {
    const { killed, code } = (error ?? {}) as { killed?: unknown; code?: unknown };
    if (killed === true) throw new Error(DID_NOT_ANSWER_IN_TIME);
    throw new Error(typeof code === "number" ? `Codex stopped with exit code ${code}` : `Codex could not be run${typeof code === "string" ? ` (${code})` : ""}`);
  });

const DEFAULT_DEPENDENCIES: CodexHomeHarnessDependencies = {
  listServers: (codexBin, options) => listCodexMcpServers(codexBin, options, runCodexMcpListForLaunch),
  inspect: inspectCodexProject,
  projectFolderEntries,
};

/** Turns project hooks off by key. A parent-table override is merged into the owner's own hook records. */
export function codexHookDisableOverride(keys: readonly string[]): string | null {
  const unique = [...new Set(keys)].sort();
  if (!unique.length) return null;
  return `hooks.state={ ${unique.map((key) => `${JSON.stringify(key)} = { enabled = false }`).join(", ")} }`;
}

/**
 * The overrides for a launch that keeps the owner's own Codex setup: none for
 * the owner's own things, and one for each thing the project would add.
 *
 * - A server only the project defines is turned off by name.
 * - A project that changes any server the owner has, the room's included, is refused.
 * - A hook the project defines is turned off by key.
 * - A project whose config sets anything else, or whose `rules` or `agents` folder holds anything, is refused.
 *
 * A launch whose project cannot be inspected, or whose project things did not
 * turn off, is refused too.
 */
export async function codexHomeHarnessOverrides(
  codexBin: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv; configOverrides?: readonly string[] },
  dependencies: Partial<CodexHomeHarnessDependencies> = {},
): Promise<string[]> {
  // Without a folder of its own the launch would run wherever this process
  // does, and what Codex reads from there cannot be inspected.
  if (!options.cwd) throw new Error("Codex needs a working folder to start with your own setup.");
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const view: LaunchView = { cwd: options.cwd, env: options.env, configOverrides: options.configOverrides ?? [] };
  let inspection: CodexProjectInspection;
  const [inProject, outsideProject] = await Promise.all([
    deps.listServers(codexBin, view),
    // Outside any project only the owner's own config applies.
    deps.listServers(codexBin, { ...view, cwd: parse(view.cwd).root || "/" }),
  ]);
  try {
    inspection = await deps.inspect(codexBin, view);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`Codex could not report what this project would add, so LetAgents will not start it with your own setup: ${detail}`);
  }

  assertProjectKeepsLetAgentsServer(inProject, outsideProject);
  const owned = new Map(outsideProject.map((entry) => [entry.name, entry]));
  const projectServers = new Set<string>();
  const changedServer = (name: string) => refusal(
    `This project's Codex config changes your MCP server ${JSON.stringify(name)}`,
    `Remove [mcp_servers.${name}] from the project's .codex/config.toml`,
  );
  for (const entry of inProject) {
    const own = owned.get(entry.name);
    if (!own) projectServers.add(entry.name);
    else if (serverShape(own) !== serverShape(entry)) throw changedServer(entry.name);
  }
  // A project cannot remove a server either: one the owner has must still be listed in the project.
  for (const name of owned.keys()) {
    if (!inProject.some((entry) => entry.name === name)) throw changedServer(name);
  }

  for (const layer of inspection.projectLayers) {
    const config = pathInRepository(view.cwd, join(layer.dotCodexFolder, "config.toml"));
    // The listing shows how a server starts. The layer also shows settings it
    // does not, such as which of the owner's tools may run without approval.
    for (const name of Object.keys(record(layer.config.mcp_servers) ?? {})) {
      if (owned.has(name) || name === LETAGENTS_MCP_SERVER_NAME) throw changedServer(name);
      projectServers.add(name);
    }
    const others = Object.keys(layer.config).filter((key) => !NEUTRALISED_PROJECT_KEYS.has(key)).sort();
    if (others.length) {
      throw refusal(
        `This project's Codex config (${config}) sets ${others.join(", ")}`,
        "With your own setup on, an agent starts with your Codex settings only. Remove them from that file in the repository and commit the removal",
      );
    }
    for (const folder of PROJECT_FOLDERS_CODEX_ACTS_ON) {
      const path = join(layer.dotCodexFolder, folder);
      const entries = deps.projectFolderEntries(path);
      if (!entries.length) continue;
      // What is said holds for any entry, a README included: the listing is wider than what Codex reads.
      const names = entries.map((entry) => relative(path, entry)).filter(Boolean);
      const shown = pathInRepository(view.cwd, path);
      throw refusal(
        `Codex reads ${folder === "rules"
          ? "command rules, which can let commands run without your approval,"
          : "agent roles, which give the agents it starts their own instructions and model,"
        } from this project's ${shown}, and that folder ${names.length ? `has entries LetAgents cannot check (${shownNames(names)})` : "cannot be listed"}`,
        `Remove ${shown} from the repository and commit the removal`,
      );
    }
  }

  const projectHooks = inspection.hooks.filter(isProjectHook).map((hook) => hook.key);
  const serversOff = codexMcpServerDisableOverride([...projectServers]);
  const hooksOff = codexHookDisableOverride(projectHooks);
  const overrides = [serversOff, hooksOff].filter((override): override is string => override !== null);
  if (!overrides.length) return [];

  // Codex is asked again, as the launch will ask it, that each one is now off.
  if (projectServers.size) {
    const relisted = await deps.listServers(codexBin, { ...view, configOverrides: [...view.configOverrides, ...overrides] });
    // One Codex no longer lists at all is not started either.
    const stillOn = [...projectServers].find((name) => relisted.some((entry) => entry.name === name && entry.enabled !== false));
    if (stillOn) {
      throw new Error(`Codex did not turn off this project's own MCP server ${JSON.stringify(stillOn)}, so LetAgents will not start it with your own setup.`);
    }
  }
  if (projectHooks.length) {
    let rechecked: CodexProjectInspection;
    try {
      // The inspection runs outside the project, where a project's server has
      // nothing to be turned off in, so it is given the hook override alone.
      rechecked = await deps.inspect(codexBin, { ...view, configOverrides: [...view.configOverrides, hooksOff!] });
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new Error(`Codex could not confirm this project's hooks are off, so LetAgents will not start it with your own setup: ${detail}`);
    }
    if (rechecked.hooks.some((hook) => isProjectHook(hook) && hook.enabled)) {
      throw new Error("Codex did not turn off this project's own hooks, so LetAgents will not start it with your own setup.");
    }
  }
  return overrides;
}

// A running app-server reads a trusted project's config again whenever it
// starts or loads a thread, lists its MCP servers or reloads them. The
// overrides that keep a project's own servers and hooks off bind when the
// process starts, so anything the project gained since then would load as
// the owner's. So LetAgents does not ask a process that has its owner's setup
// to list its MCP servers when it re-attaches to it. Starting or loading a
// thread on it cannot be avoided when its conversation has to be restored, so
// before that the project is inspected again and compared with what the
// process was started with. A difference, or a project that cannot be
// inspected, means the call is not made: the process is stopped, and the next
// start inspects the project as every start does.

const COMMAND_LINE_TIMEOUT_MS = 3_000;
/** How many running agents may be checked against their projects at once. Each check starts Codex three times. */
const LIVE_CHECKS_AT_ONCE = 2;

export type CodexLiveProcess = {
  /** The process's full command line, which carries the overrides it started with. */
  commandLine: string;
  /** The agent's work folder, where its threads run. */
  cwd: string | null;
};

/**
 * Read a running app-server's command line without ever holding the caller
 * up: `ps` runs on its own, and one that has not answered in time is killed
 * and counted as a process that cannot be read. Null when it cannot be read.
 */
export function readCodexCommandLine(
  pid: number,
  tool: { ps?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value?.trim() || null);
    };
    try {
      const child = spawn(tool.ps ?? "/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { stdio: ["ignore", "pipe", "ignore"] });
      // The answer does not wait for the kill to land: a `ps` that cannot be killed still ends the wait.
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, tool.timeoutMs ?? COMMAND_LINE_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code === 0 ? output : null));
    } catch {
      finish(null);
    }
  });
}

/**
 * Whether a running app-server kept its owner's own setup. An isolated launch
 * always carries every override that turns the owner's extensions off, so a
 * command line without them all is treated as one that has the owner's setup.
 */
export function codexProcessKeepsOwnerSetup(commandLine: string): boolean {
  return !CODEX_OWNER_FEATURE_OVERRIDES.every((override) => commandLine.includes(override));
}

let liveChecksRunning = 0;
const liveChecksWaiting: Array<() => void> = [];
/** Run a check when fewer than the limit are running, so many agents checked at once do not all start Codex together. */
async function inLiveCheckSlot<T>(check: () => Promise<T>): Promise<T> {
  if (liveChecksRunning >= LIVE_CHECKS_AT_ONCE) await new Promise<void>((admit) => liveChecksWaiting.push(admit));
  else liveChecksRunning += 1;
  try {
    return await check();
  } finally {
    // A waiting check takes this slot over; with none waiting the slot is given back.
    const next = liveChecksWaiting.shift();
    if (next) next();
    else liveChecksRunning -= 1;
  }
}

/**
 * Refuse unless the project contributes nothing now that the running process
 * was not started with turned off. Throws the launch's own refusal when the
 * project changes an owner server, sets its own settings or ships rules, and
 * says so plainly when Codex could not be asked at all.
 */
export function assertLiveCodexProjectUnchanged(
  codexBin: string,
  live: CodexLiveProcess,
  env: NodeJS.ProcessEnv,
  dependencies: Partial<CodexHomeHarnessDependencies> = {},
): Promise<void> {
  return inLiveCheckSlot(async () => {
    if (!live.cwd) throw new Error("LetAgents could not tell which folder this Codex agent runs in, so it will not let Codex load a project's configuration with your own setup.");
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    // A Codex that could not be asked is told apart from one that answered with something to refuse.
    let notAsked: string | null = null;
    const asking = <T>(ask: Promise<T>): Promise<T> => ask.catch((error: unknown) => {
      notAsked ??= error instanceof Error && error.message.includes(DID_NOT_ANSWER_IN_TIME) ? "timed out" : "Codex could not be asked";
      throw error;
    });
    let needed: string[];
    try {
      needed = await codexHomeHarnessOverrides(codexBin, { cwd: live.cwd, env, configOverrides: [] }, {
        listServers: (bin, options) => asking(deps.listServers(bin, options)),
        inspect: (bin, options) => asking(deps.inspect(bin, options)),
        projectFolderEntries: deps.projectFolderEntries,
      });
    } catch (error) {
      if (!notAsked) throw error;
      throw new Error(
        `LetAgents could not check what this project adds to your own setup (${notAsked}), so it stopped the agent `
        + "before Codex could load the project's configuration. It starts again by itself.",
      );
    }
    if (needed.every((override) => live.commandLine.includes(override))) return;
    throw new Error(
      "This project's Codex config now adds MCP servers or hooks that were not there when this agent started, "
      + "so LetAgents stopped the agent before Codex could load them with your own setup. It starts again with them turned off.",
    );
  });
}
