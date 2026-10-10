import { spawn } from "node:child_process";
import { lstatSync, opendirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  CODEX_OWNER_FEATURE_OVERRIDES,
  LETAGENTS_MCP_SERVER_NAME,
  assertProjectKeepsLetAgentsServer,
  codexHomeDirectory,
  codexMcpServerDisableOverride,
  codexOwnerIsolationOverrides,
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
/**
 * What an owner is told when LetAgents stopped a running agent so that it
 * starts afresh. The background service starts an agent again only when it is
 * set to run, so the words hold for an agent its owner paused too.
 */
export const STARTS_AGAIN_BY_ITSELF = "It starts again by itself, unless you paused it.";
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
/**
 * `credentialStore`: where Codex keeps its sign-in (`file`, `keyring`, ...). Null when Codex did not say.
 * `otherRuleFolders`: the `rules` folder of every other layer Codex applies that is a file in a folder:
 * the system and managed config, and defaults shipped with Codex. Not the user's own layer.
 */
export type CodexSettingsInspection = {
  projectLayers: CodexProjectLayer[];
  credentialStore: string | null;
  otherRuleFolders: string[];
  /**
   * The folders the owner's or the project's Codex config lets a sandboxed
   * command write besides the project (`sandbox_workspace_write.writable_roots`).
   * They apply to a turn whose sandbox lets it write the project. Null when
   * Codex named them in a form this code cannot read: that is not "none".
   */
  writableRoots?: string[] | null;
  /** What Codex says it is: its name and version. Null when it did not say. */
  userAgent?: string | null;
};
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
 * Whether Codex takes a folder as the top of a repository. Codex 0.153.4 does
 * when the folder's `.git`, with links followed, is a file of any content, or
 * a folder that holds a HEAD: a file or a folder, also through a link. It does
 * not for a `.git` that is an empty folder, a folder without HEAD or with a
 * HEAD link that leads nowhere, or a link that leads nowhere: it reads on to
 * the folders above. Anything this cannot look at is not a top, so the walk
 * goes on: it may read further up than Codex, never less far.
 */
function isRepositoryTop(folder: string): boolean {
  try {
    const git = statSync(join(folder, ".git"), { throwIfNoEntry: false });
    if (!git) return false;
    return git.isFile() || (git.isDirectory() && statSync(join(folder, ".git", "HEAD"), { throwIfNoEntry: false }) !== undefined);
  } catch {
    return false;
  }
}

/**
 * `inner` as it is named from `outer`, when it is that folder or in it: empty
 * for the folder itself. Null when it is not. The two are compared name by
 * name and not letter by letter, so "/" holds every path, "/a" does not hold
 * "/ab", a folder named "..b" is in its parent, and a separator at the end
 * changes nothing.
 */
export function pathFrom(outer: string, inner: string): string | null {
  const from = relative(outer, inner);
  return from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from) ? null : from;
}

/**
 * A path as its owner knows it: from the top of the repository, not from
 * wherever LetAgents keeps the agent's copy of it. The top is the nearest
 * folder at or above the agent's that Codex takes as one, or the agent's own.
 */
function pathInRepository(cwd: string, path: string): string {
  const tops = [cwd];
  try {
    const hasGit = isRepositoryTop;
    let top = cwd;
    while (!hasGit(top) && dirname(top) !== top) top = dirname(top);
    if (hasGit(top)) tops[0] = top;
    // Codex may name the path with its links followed.
    tops.push(realpathSync(tops[0]!));
  } catch {
    // A folder that cannot be looked at is not the top.
  }
  for (const top of tops) {
    const shown = pathFrom(top, path);
    if (shown) return shown;
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
 * Start a short-lived app-server, ask it things, and stop it. It opens no
 * thread, so it starts no MCP server and runs no hook. It is always stopped,
 * and a slow one is an error. `experimentalApi`: the questions use a part of
 * Codex's protocol that it answers only to a client that asks for it.
 */
export function askCodexAppServer<T>(
  codexBin: string,
  options: LaunchView & { experimentalApi?: boolean },
  ask: (request: (method: string, params: unknown) => Promise<unknown>, initialized: unknown) => Promise<T>,
  timeoutMs = INSPECTION_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, [
      "app-server",
      ...options.configOverrides.flatMap((override) => ["-c", override]),
      "--listen", "stdio://",
    ], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let settled = false;
    let buffer = "";
    let nextId = 1;
    const pending = new Map<number, (result: unknown, error: unknown) => void>();
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(DID_NOT_ANSWER_IN_TIME)), timeoutMs);
    const request = (method: string, params: unknown) => new Promise<unknown>((done, fail) => {
      const id = nextId++;
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
      const initialized = await request("initialize", {
        clientInfo: { name: "letagents", title: "LetAgents", version: "1" },
        ...(options.experimentalApi ? { capabilities: { experimentalApi: true } } : {}),
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      finish(null, await ask(request, initialized));
    })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/**
 * Ask Codex, without starting anything, what a launch in `cwd` would read
 * from the project. The app-server is started outside any project, so it
 * loads no project config itself, and is asked for the layered config and the
 * hooks as seen from `cwd`.
 */
export function inspectCodexProject(codexBin: string, options: LaunchView, timeoutMs = INSPECTION_TIMEOUT_MS): Promise<CodexProjectInspection> {
  const outside = parse(options.cwd).root || "/";
  return askCodexAppServer(codexBin, { ...options, cwd: outside }, async (request) => {
    const [config, hooks] = await Promise.all([
      request("config/read", { includeLayers: true, cwd: options.cwd }),
      // The same question for the project and for a folder no project applies to.
      request("hooks/list", { cwds: [options.cwd, outside] }),
    ]);
    return readInspection(config, hooks, outside);
  }, timeoutMs);
}

/**
 * The same question without the hooks: the project layers a launch in `cwd`
 * would apply, and where Codex keeps its sign-in.
 */
export function inspectCodexSettings(codexBin: string, options: LaunchView, timeoutMs = INSPECTION_TIMEOUT_MS): Promise<CodexSettingsInspection> {
  return askCodexAppServer(codexBin, { ...options, cwd: parse(options.cwd).root || "/" }, async (request, initialized) => {
    const config = await request("config/read", { includeLayers: true, cwd: options.cwd });
    const credentialStore = record(record(config)?.config)?.cli_auth_credentials_store;
    const writableRoots = record(record(record(config)?.config)?.sandbox_workspace_write)?.writable_roots;
    const userAgent = record(initialized)?.userAgent;
    const projectLayers = readProjectLayers(config);
    // Codex reads command rules from the folder of each layer it applies. The
    // layers that are neither the user's nor a project's are named by a file
    // (the system config, a managed config, shipped defaults) or by nothing
    // at all (settings sent by a device manager or the cloud, launch flags),
    // and only a file has a folder. Codex 0.153.4 names these layer types;
    // one it adds later is covered when it names a file.
    const otherRuleFolders = (record(config)!.layers as unknown[]).flatMap((layer) => {
      const name = record(record(layer)?.name)!;
      return name.type !== "user" && name.type !== "project" && record(layer)!.disabledReason == null && typeof name.file === "string"
        ? [join(dirname(name.file), "rules")] : [];
    });
    return {
      projectLayers,
      credentialStore: typeof credentialStore === "string" ? credentialStore : null,
      otherRuleFolders: [...new Set(otherRuleFolders)],
      // Codex 0.153.4 names each folder by its full path, with "~", ".." and a path from the config's own folder worked out.
      // Any other form is one this code cannot place.
      writableRoots: writableRoots == null ? []
        : Array.isArray(writableRoots) && writableRoots.every((root): root is string =>
          typeof root === "string" && isAbsolute(root) && !root.split(/[\\/]/).includes("..")) ? writableRoots : null,
      userAgent: typeof userAgent === "string" && userAgent ? userAgent : null,
    };
  }, timeoutMs);
}

/** An answer Codex gave in a shape this code does not know is an error, never an empty project. */
function readProjectLayers(config: unknown): CodexProjectLayer[] {
  const layers = record(config)?.layers;
  if (!Array.isArray(layers)) throw new Error("Codex returned unreadable settings");
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
  return projectLayers;
}

function readInspection(config: unknown, hooks: unknown, outsideFolder: string): CodexProjectInspection {
  const projectLayers = readProjectLayers(config);
  const listed = record(hooks)?.data;
  if (!Array.isArray(listed)) throw new Error("Codex returned unreadable settings");
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
export function projectFolderEntries(folder: string): string[] {
  try {
    return readdirSync(folder).map((name) => join(folder, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !lstatSync(folder, { throwIfNoEntry: false })) return [];
    return [folder];
  }
}

/**
 * The first entries of a folder, `limit` at most. It means what
 * `projectFolderEntries` means, and reads no more of the folder than it
 * returns: a check that runs at every turn must not list a folder of any size.
 */
export function firstFolderEntries(folder: string, limit = 4): string[] {
  let open;
  try {
    open = opendirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !lstatSync(folder, { throwIfNoEntry: false })) return [];
    return [folder];
  }
  try {
    const entries: string[] = [];
    for (let entry = open.readSync(); entry && entries.length < limit; entry = open.readSync()) entries.push(join(folder, entry.name));
    return entries;
  } catch {
    return [folder];
  } finally {
    open.closeSync();
  }
}

/** The names of a folder's first entries as they are shown: printable, short, three at most, and whether there are more. */
function shownFirstNames(folder: string, entries: readonly string[]): string {
  const names = entries.map((entry) => relative(folder, entry)).filter(Boolean);
  if (!names.length) return "the folder cannot be listed";
  return `${names.slice(0, 3).map((name) => name.replace(/[^\x20-\x7e]/g, "?").slice(0, 60)).join(", ")}${names.length > 3 ? " and more" : ""}`;
}

/** Whether two paths name one folder, with links followed. A folder that is not there is the same only by name. */
function sameFolder(left: string, right: string): boolean {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  // Without regard to case or to how a letter is composed: a disk may keep one folder under both spellings.
  const folded = (path: string) => real(path).normalize("NFC").toLowerCase();
  return folded(left) === folded(right);
}

/**
 * The folders Codex reads a project's command rules from, for work in `cwd`:
 * `.codex/rules` in that folder and in each folder above it, up to the top of
 * its repository (see `isRepositoryTop`). Codex 0.153.4 reads no further up,
 * not from a folder beside these, and not from a worktree's main clone. With
 * no repository it reads the folder's own only.
 */
export function projectRuleFolders(cwd: string): string[] {
  let folder = resolve(cwd);
  try {
    folder = realpathSync(folder);
  } catch {
    // A folder that is not there yet is looked for as it was named.
  }
  let top = folder;
  while (!isRepositoryTop(top) && dirname(top) !== top) top = dirname(top);
  if (!isRepositoryTop(top)) top = folder;
  const folders = [folder];
  while (folders.at(-1) !== top) folders.push(dirname(folders.at(-1)!));
  return folders.map((path) => join(path, ".codex", "rules"));
}

/**
 * The `.codex` folder of each project layer Codex reads for work in `cwd`, as
 * `projectRuleFolders` walks them. `own`: the layer of the work folder itself.
 * `shown`: its path from the top of the repository.
 */
export function projectDotCodexFolders(cwd: string): Array<{ folder: string; shown: string; own: boolean }> {
  return projectRuleFolders(cwd).map((rules, index) => {
    const folder = dirname(rules);
    return { folder, shown: pathInRepository(cwd, folder).replace(/[^\x20-\x7e]/g, "?").slice(0, 120), own: index === 0 };
  });
}

/**
 * What a trusted project's Codex config may set for an agent at a sandboxed
 * access level. A key is here only when it was shown to be harmless there, or
 * is dealt with by a check of its own. Every other key that Codex reports for
 * a project layer refuses the launch, and so does a key that a later Codex
 * adds: nothing here depends on a list of keys known to be bad.
 *
 * - `mcp_servers`: each server is turned off by name, and they are compared
 *   again before a conversation is started or loaded.
 * - `hooks`: off for the launch, by its flag or one by one.
 * - `approval_policy`, `sandbox_mode`: every conversation and every turn names
 *   its approval policy and its sandbox. With Codex 0.153.4 the named ones
 *   hold against these, for a command and for a sub-agent the model starts.
 * - `sandbox_workspace_write`, for what `SANDBOX_KEYS_A_PROJECT_MAY_SET` names
 *   and nothing else. `network_access`: the turn's own "no network" holds
 *   against it. The two `exclude_` keys only say whether the temp folders are
 *   written, which the access level allows as it is. `writable_roots` is not
 *   among them: Codex adds those folders to a turn whatever the turn names,
 *   so a project would choose where the agent's commands may write. It
 *   refuses where the sandbox can write at all, unless the list is empty.
 * - The rest choose the model and how it answers, or are text for the model,
 *   as the project's AGENTS.md is.
 *
 * Not here, with the reason for some: `project_root_markers` moves the top of
 * the repository, and with it the rule folders Codex reads; `web_search` can
 * give the model the live web at a level whose commands have no network;
 * `features`, `tools`, `agents`, `apps` and `shell_environment_policy` turn
 * on or shape things nobody has shown to be harmless; `projects` trusts other
 * folders; the sign-in and storage keys move where Codex keeps things; and
 * `zsh_path` and `js_repl_node_path` name a program (Codex 0.153.4 was seen
 * to run neither, which is no promise for the next one).
 */
export const SANDBOXED_PROJECT_KEYS: ReadonlySet<string> = new Set([
  "mcp_servers", "hooks",
  "approval_policy", "sandbox_mode", "sandbox_workspace_write",
  "model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "personality",
  "instructions", "developer_instructions", "project_doc_max_bytes", "project_doc_fallback_filenames",
]);
/** What a project may set under `sandbox_workspace_write`. A list of folders to write is not one of them. */
export const SANDBOX_KEYS_A_PROJECT_MAY_SET: ReadonlySet<string> = new Set(["network_access", "exclude_tmpdir_env_var", "exclude_slash_tmp"]);

/**
 * Why Codex is not used at a sandboxed access level in a project whose own
 * config sets something that is not in `SANDBOXED_PROJECT_KEYS`. Null when
 * every project layer Codex applies sets only what is. A layer Codex does not
 * apply, such as a project its owner has not trusted, is not in `layers`: so
 * to stop trusting the project in Codex is a way out that leaves the file,
 * which can be a team's, as it is.
 */
export function projectKeysRefusal(
  cwd: string,
  layers: readonly CodexProjectLayer[],
  /** `writableSandbox`: the access level's sandbox lets a command write the project, so folders a project adds would be written too. */
  options: { writableSandbox?: boolean } = {},
): string | null {
  for (const layer of layers) {
    const others = Object.keys(layer.config).filter((key) => !SANDBOXED_PROJECT_KEYS.has(key));
    if (Object.hasOwn(layer.config, "sandbox_workspace_write")) {
      const sandbox = record(layer.config.sandbox_workspace_write);
      // A value in a form this code does not know is not looked into: the whole key is refused.
      if (!sandbox) others.push("sandbox_workspace_write");
      for (const [key, value] of Object.entries(sandbox ?? {})) {
        const noFolders = key === "writable_roots" && ((Array.isArray(value) && value.length === 0) || options.writableSandbox !== true);
        if (!SANDBOX_KEYS_A_PROJECT_MAY_SET.has(key) && !noFolders) others.push(`sandbox_workspace_write.${key}`);
      }
    }
    others.sort();
    if (!others.length) continue;
    const file = pathInRepository(cwd, join(layer.dotCodexFolder, "config.toml")).replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
    const one = others.length === 1;
    // Every key is named while they fit, so one visit to the file is enough.
    const named = `${others.slice(0, 8).map((key) => key.replace(/[^\x20-\x7e]/g, "?").slice(0, 40)).join(", ")}${others.length > 8 ? ` and ${others.length - 8} more` : ""}`;
    return `This project's Codex config (${file}) sets ${named}. `
      + `LetAgents does not know that ${one ? "this setting is" : "these settings are"} harmless for a sandboxed agent, so it will not start Codex here at this access level. `
      + `Remove ${one ? "it" : "them"} from that file, stop trusting the project in Codex, or give this agent Full access if you accept that.`;
  }
  return null;
}

/**
 * Why Codex is not used at a sandboxed access level in a work folder that has
 * command rule folders of its own. Null when it has none. A command that
 * matches an allow rule runs outside Codex's sandbox with no approval.
 *
 * It does not ask whether Codex trusts the project. Codex reads these folders
 * once it does, and trust can come at any time from outside this agent: the
 * owner's own Codex, an agent with Full access, or a conversation that is
 * started with the folder named, which Codex takes as trust and which turns
 * the rules on for that same conversation. So a folder that holds anything is
 * enough. Only names are read, and no more of them than are shown: what a
 * file says, and whether it is a rule file at all, is not known here, and the
 * words say so.
 *
 * `savedRules` is the owner's own saved-rules folder. An agent whose
 * repository top is the folder that holds the owner's Codex home has that
 * folder as its project's, and is told so.
 */
export function projectCommandRulesRefusal(
  cwd: string,
  folderEntries: (folder: string) => string[] = firstFolderEntries,
  folders: readonly string[] = projectRuleFolders(cwd),
  savedRules: string = join(codexHomeDirectory(process.env), "rules"),
): string | null {
  for (const path of folders) {
    const entries = folderEntries(path);
    if (!entries.length) continue;
    const holds = shownFirstNames(path, entries);
    const unread = "LetAgents does not read the files in it. If one of them allows a command, a sandboxed Codex agent runs that command with no sandbox and no approval. "
      + "So LetAgents does not start Codex here, or give it work, at this access level. ";
    if (sameFolder(path, savedRules)) {
      return "This agent's work folder is in a repository whose top is the folder that holds your Codex home. "
        + `So Codex reads your saved command rules (the rules folder in your Codex home) as this project's own once it trusts the project, and that folder is not empty (${holds}). `
        + unread
        + "Give the agent a work folder in a repository of its own, remove your saved rules, or give this agent Full access if you accept that.";
    }
    const shown = pathInRepository(cwd, path);
    return `Codex reads command rules from ${shown} in this agent's work folder once it trusts the project, and that folder is not empty (${holds}). `
      + unread
      + `Remove or rename ${shown} in the agent's work folder, which can differ from your own copy of the project, or give this agent Full access if you accept that.`;
  }
  return null;
}

/**
 * The same for what Codex itself reports: a rule folder of a project layer it
 * applies, wherever its settings put the top of the project, or of one of the
 * machine's own layers (the system and managed config folders).
 */
export function assertLayersAddNoCommandRules(
  cwd: string | undefined,
  inspection: Pick<CodexSettingsInspection, "projectLayers" | "otherRuleFolders">,
  folderEntries: (folder: string) => string[] = firstFolderEntries,
): void {
  const layerFolders = inspection.projectLayers.map((layer) => join(layer.dotCodexFolder, "rules"));
  const inProject = layerFolders.length ? projectCommandRulesRefusal(cwd ?? dirname(dirname(layerFolders[0]!)), folderEntries, layerFolders) : null;
  if (inProject) throw new Error(inProject);
  for (const path of inspection.otherRuleFolders) {
    const entries = folderEntries(path);
    if (!entries.length) continue;
    // A folder in the user's own home is named from there, never by its full path.
    const fromHome = pathFrom(homedir(), path);
    const shown = fromHome ? join("~", fromHome) : path;
    throw new Error(
      `Codex also reads command rules from ${shown}, a folder of this computer's own Codex settings that applies to every Codex on it, and that folder is not empty (${shownFirstNames(path, entries)}). `
      + "LetAgents does not read the files in it. If one of them allows a command, a sandboxed Codex agent runs that command with no sandbox and no approval. "
      + "So LetAgents starts no Codex agent at a sandboxed access level on this computer while that folder holds anything. "
      + "Only someone who may change that folder can empty it: on a computer that your organization manages, that is its administrator. "
      + "Until then, give this agent Full access if you accept that.",
    );
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
        + `before Codex could load the project's configuration. ${STARTS_AGAIN_BY_ITSELF}`,
      );
    }
    if (needed.every((override) => live.commandLine.includes(override))) return;
    throw new Error(
      "This project's Codex config now adds MCP servers or hooks that were not there when this agent started, "
      + "so LetAgents stopped the agent before Codex could load them with your own setup. It starts again with them turned off, unless you paused it.",
    );
  });
}

/**
 * One server or one personal skill as a launch override turns it off: whole,
 * with its quoted name or path, so that no name is found inside another.
 */
const TURNED_OFF_BY_NAME = /"(?:[^"\\]|\\.)*" = \{ enabled = false \}|\{ path = "(?:[^"\\]|\\.)*", enabled = false \}/g;

/**
 * The same for a process that was started without its owner's setup. Such a
 * launch turns every MCP server off by name, but the room's own, and every
 * personal skill. A server that a trusted project's config, or the owner's,
 * gained since then has no such override: Codex would start it, with no
 * sandbox, when the process next starts or loads a conversation. So what a
 * launch would turn off now is compared with what the process was started
 * with. Throws when they differ, and when Codex cannot be asked.
 *
 * The room's own server is compared in and outside the project exactly as a
 * launch compares it: with the launch's own overrides, `launchOverrides`,
 * which set that server. Codex merges a project's keys for it under those, so
 * a project that sets only keys the launch sets changes nothing, and one that
 * adds a key does. Without them such a project would stop its agent at every
 * load while every launch accepts it. A process that was found running has
 * no known overrides (null). Its project may then not name the room's server
 * at all, and the words say that the next start decides.
 */
export function assertLiveCodexIsolationUnchanged(
  codexBin: string,
  live: CodexLiveProcess & { launchOverrides?: readonly string[] | null },
  env: NodeJS.ProcessEnv,
  run: CodexMcpListRunner = runCodexMcpListForLaunch,
): Promise<void> {
  return inLiveCheckSlot(async () => {
    const cwd = live.cwd;
    if (!cwd) throw new Error("LetAgents could not tell which folder this Codex agent runs in, so it will not let Codex load a project's MCP servers.");
    const known = live.launchOverrides ?? null;
    if (!known) {
      const view = { env, configOverrides: [...CODEX_OWNER_FEATURE_OVERRIDES] };
      const [inProject, outsideProject] = await Promise.all([
        listCodexMcpServers(codexBin, { ...view, cwd }, run),
        listCodexMcpServers(codexBin, { ...view, cwd: parse(cwd).root || "/" }, run),
      ]);
      let named = false;
      try {
        assertProjectKeepsLetAgentsServer(inProject, outsideProject);
      } catch {
        named = true;
      }
      if (named) {
        throw new Error(
          "This project's Codex config has settings of its own for the LetAgents MCP server. This agent's Codex was started before LetAgents last restarted, "
          + "so LetAgents cannot compare those settings with what the agent was started with, and stopped the agent before Codex could load them. "
          + "LetAgents starts it again and compares them then, unless you paused it.",
        );
      }
    }
    // Throws as a launch does: the servers cannot be listed, or the project changes the room's own server.
    const needed = await codexOwnerIsolationOverrides(codexBin, { cwd, env, configOverrides: known ?? [] }, run);
    // Servers and skills are turned off one by one, by name, in one override each. They are compared by name:
    // one that is gone since the launch is no reason to stop, and only one the process was not started without is.
    const startedWithout = new Set(live.commandLine.match(TURNED_OFF_BY_NAME) ?? []);
    const gained = needed.some((override) => {
      const byName = override.startsWith("mcp_servers={ ") || override.startsWith("skills.config=[") ? override.match(TURNED_OFF_BY_NAME) : null;
      return byName ? byName.some((one) => !startedWithout.has(one)) : !live.commandLine.includes(override);
    });
    if (!gained) return;
    throw new Error(
      "This project's Codex config, or your own, now has an MCP server or a skill that was not there when this agent started, "
      + "so LetAgents stopped the agent before Codex could load it. It starts again with it turned off, unless you paused it.",
    );
  });
}
