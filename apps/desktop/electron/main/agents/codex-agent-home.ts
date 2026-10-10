import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

import { CODEX_OWNER_FEATURE_OVERRIDES, codexHomeDirectory } from "../../../../../shared/codex-owner-isolation.mjs";
import {
  askCodexAppServer,
  assertLayersAddNoCommandRules,
  firstFolderEntries,
  inspectCodexSettings,
  pathFrom,
  projectCommandRulesRefusal,
  projectDotCodexFolders,
  projectKeysRefusal,
  type CodexSettingsInspection,
} from "./codex-home-harness.js";

// An owner can save "always allow" command rules in the `rules` folder of
// their Codex home. Codex runs a command that matches one outside its sandbox
// and asks no one, and it has no launch switch for that. So an agent at a
// sandboxed access level gets a Codex home of its own that has no rules: one
// folder in which every entry of the owner's home is a link to that entry,
// and `rules` is an empty folder nothing can be saved into. The owner's
// sign-in, config, instructions and conversations are the owner's own files,
// reached through the links, so nothing is copied and nothing can drift. The
// owner's home is only read.
//
// The sign-in file is the one link that must never turn into a copy: Codex
// replaces its token when it refreshes it, and a copy with the new token
// would leave the owner's own file with a dead one. Codex rewrites the file in
// place, through the link. That is checked for each Codex binary, with a
// made-up sign-in and a made-up token service, before the real link is used.

const SIGN_IN_FILE = "auth.json";
const SIGN_IN_CHECK_TIMEOUT_MS = 15_000;
const SIGN_IN_CHECK_FOLDER = "codex-sign-in-check-";
const TOKEN_AFTER_REFRESH = "letagents-check-token-after-refresh";
const TOKEN_SERVICE_OVERRIDE = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
/**
 * Codex sends its sign-in tokens to the address in these variables. Only the
 * sign-in check, with its made-up sign-in, may set one: no agent is ever
 * started with one in its environment.
 */
export const CODEX_TOKEN_SERVICE_OVERRIDES: readonly string[] = [TOKEN_SERVICE_OVERRIDE, "CODEX_REVOKE_TOKEN_URL_OVERRIDE"];

/** The agents' home cannot be used as it is, and only its owner can put that right. The launch is refused in these words. */
export class CodexAgentHomeError extends Error {}
/** The agents' home holds a sign-in file of its own. Nothing is started until the owner has looked at it. */
export class CodexAgentHomeSignInError extends CodexAgentHomeError {}

/** A path with its links followed, for a folder that may not be there yet: the part that is there is resolved. */
function resolvedPath(path: string): string {
  let there = resolve(path);
  const missing: string[] = [];
  while (!existsSync(there) && dirname(there) !== there) {
    missing.unshift(basename(there));
    there = dirname(there);
  }
  return join(realpathSync(there), ...missing);
}

/** A path's name as two names are compared: without regard to case, or to how a letter is composed. */
const foldedPath = (path: string): string => path.normalize("NFC").toLowerCase();

/** Which file or folder a path leads to, with links followed. Null when nothing is there. */
function onDisk(path: string): string | null {
  try {
    const entry = statSync(path, { bigint: true });
    return `${entry.dev}:${entry.ino}`;
  } catch {
    return null;
  }
}

/**
 * Whether `inner` is the folder `outer`, or is in it. Every folder from
 * `inner` up, with its links followed, is compared with `outer` in two ways.
 * By what it is on disk: one folder can have more than one path, through a
 * link, through a second path of its volume (macOS shows a user's folder below
 * /System/Volumes/Data too), or in another spelling on a disk that ignores
 * case. And by name, without regard to case, for a folder that is not there
 * yet. So "/" holds everything, and a separator at the end changes nothing.
 * It may call two folders one that a disk keeps apart: that only refuses more.
 */
export function folderHolds(outer: string, inner: string): boolean {
  const outerName = foldedPath(resolvedPath(outer));
  const outerOnDisk = onDisk(outer);
  for (let at = resolvedPath(inner); ; at = dirname(at)) {
    if (foldedPath(at) === outerName || (outerOnDisk !== null && onDisk(at) === outerOnDisk)) return true;
    if (dirname(at) === at) return false;
  }
}

/**
 * Where the agents' Codex home for the owner's Codex home of `env` is. Each
 * owner home has one of its own, because its entries are links into that one
 * home: a launch for another owner home, such as a rental that is given no
 * CODEX_HOME beside an owner who sets one, must never turn those links
 * elsewhere under an agent that runs. The usual owner home keeps the plain
 * name. Any other is named by its real path, so two names for one home give
 * one folder.
 *
 * It is in the user's own folder and never in a temp folder: Codex's
 * project-only sandbox leaves temp folders writable, and a command must not be
 * able to save a rule or a config here. No setting moves it.
 */
export function codexAgentHomeDirectory(env: NodeJS.ProcessEnv): string {
  const userHome = env.HOME?.trim() || homedir();
  const ownerHome = resolvedPath(codexHomeDirectory(env));
  const usual = ownerHome === resolvedPath(join(userHome, ".codex"));
  return join(userHome, ".letagents", usual ? "codex-agent-home" : `codex-agent-home-${createHash("sha256").update(ownerHome).digest("hex").slice(0, 12)}`);
}

/** How the agents' home is named to its owner: by its last two names, never by its full path, which can be shown in a room. */
function shownAgentHome(home: string): string {
  return `${basename(home)} in your ${basename(dirname(home))} folder`;
}

/**
 * Make the agents' home match the owner's: a link for every entry of the
 * owner's home except `rules`. Returns what the agents' home holds of its own
 * afterwards, and which of those have a name the owner's home has too.
 *
 * Nothing with content is ever deleted here. What Codex wrote in this folder
 * can be a conversation index or the only token that still works, and this
 * code cannot tell. So an entry of its own that is empty is replaced by the
 * link, one with content is kept and reported, and a sign-in file of its own
 * stops the launch.
 */
export function linkCodexAgentHome(ownerHome: string, agentHome: string): { own: string[]; inPlaceOfOwners: string[] } {
  const owner = realpathSync(ownerHome);
  // Checked before the folder is made, so nothing is ever made inside the owner's home.
  const home = resolvedPath(agentHome);
  if (folderHolds(owner, home) || folderHolds(home, owner)) {
    throw new Error("The agents' Codex home must be a folder apart from the owner's Codex home.");
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // The folder is looked at before anything in it is changed: a launch that is refused leaves it as it was.
  const before = readdirSync(home).filter((name) => name !== "rules").sort().map((name) => ({ name, path: join(home, name), entry: lstatSync(join(home, name)) }));
  if (before.some(({ name, entry }) => name === SIGN_IN_FILE && !entry.isSymbolicLink())) {
    throw new CodexAgentHomeSignInError(
      `LetAgents found a Codex sign-in file of its own (${SIGN_IN_FILE}) in the folder it keeps for sandboxed agents (${shownAgentHome(home)}). `
      + "Two sign-in files can sign you out of Codex, so LetAgents will not start a sandboxed Codex agent. "
      + "Open Codex and check that it is still signed in, then delete that file and start the agent again. "
      + "If Codex asks you to sign in, sign in again: your conversations and settings are kept.",
    );
  }
  // A link into another folder than this owner's home was made for another home, or by something
  // else. An agent may be running with it, so it is never turned to this home under that agent.
  if (before.some(({ path, entry }) => entry.isSymbolicLink() && dirname(readlinkSync(path)) !== owner)) {
    const ownNames = before.filter(({ entry }) => !entry.isSymbolicLink()).map(({ name }) => name.replace(/[^\x20-\x7e]/g, "?").slice(0, 60));
    throw new CodexAgentHomeError(
      `The folder LetAgents keeps for sandboxed Codex agents (${shownAgentHome(home)}) is linked to another Codex home than the one this agent uses. `
      + "LetAgents does not change its links while an agent may be running with them, so it will not start a sandboxed Codex agent. "
      + "Pause every sandboxed Codex agent, delete that folder, and resume the agents: LetAgents makes it again. "
      + (ownNames.length
        ? `Besides links, the folder holds ${ownNames.slice(0, 5).join(", ")}${ownNames.length > 5 ? ` and ${ownNames.length - 5} more` : ""}: keep a copy if you need them.`
        : "It holds only links, so nothing of yours is deleted with it."),
    );
  }
  const toLink = new Set(readdirSync(owner));
  toLink.delete("rules");
  const own: string[] = [];
  const inPlaceOfOwners: string[] = [];
  for (const { name, path, entry } of before) {
    if (entry.isSymbolicLink()) {
      if (toLink.has(name) && readlinkSync(path) === join(owner, name)) toLink.delete(name);
      else unlinkSync(path);
      continue;
    }
    const empty = entry.isDirectory() ? readdirSync(path).length === 0 : entry.isFile() && entry.size === 0;
    if (toLink.has(name) && empty) {
      // Removed only while still empty: neither call removes anything that has content.
      if (entry.isDirectory()) rmdirSync(path);
      else unlinkSync(path);
      continue;
    }
    own.push(name);
    if (toLink.delete(name)) inPlaceOfOwners.push(name);
  }
  for (const name of toLink) symlinkSync(join(owner, name), join(home, name));
  const rules = join(home, "rules");
  if (lstatSync(rules, { throwIfNoEntry: false })?.isDirectory()) chmodSync(rules, 0o700);
  rmSync(rules, { recursive: true, force: true });
  mkdirSync(rules);
  chmodSync(rules, 0o555);
  return { own, inPlaceOfOwners };
}

function pretendToken(label: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { email: "check@letagents.invalid", exp: Math.floor(Date.now() / 1000) + 3600, label };
  return `${part({ alg: "none" })}.${part(claims)}.${label}`;
}

/** Every entry below a folder, as a path from it. */
function entriesBelow(folder: string, prefix = ""): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`;
    return entry.isDirectory() ? [path, ...entriesBelow(join(folder, entry.name), `${path}/`)] : [path];
  });
}

/**
 * Whether this Codex rewrites a linked sign-in file in place. Codex is given
 * a home whose sign-in file is a link to a made-up sign-in, and is asked to
 * refresh it against a listener on this machine. Nothing of the owner's is
 * read, and every other request Codex makes is sent to the same listener and
 * refused. True only when the link is still a link and the file it leads to
 * holds the new token. `env` is the launch's environment: only what Codex
 * needs to be found and run is taken from it.
 *
 * The Codex that is asked runs with no sandbox and obeys a config file in its
 * home. So its home is made in `parent`, the folder that holds the agents'
 * home, and never in a temp folder: Codex's project-only sandbox leaves temp
 * folders writable, and an agent's command could put a config there between
 * the moment the folder is made and the moment Codex starts. The folder is
 * the user's alone, it is looked at again just before Codex starts, and Codex
 * is not started when it holds anything this code did not put there.
 */
export async function checkCodexKeepsLinkedSignIn(codexBin: string, env: NodeJS.ProcessEnv, parent: string): Promise<boolean> {
  let scratch: string | null = null;
  const listener = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const refresh = request.method === "POST" && String(request.url).endsWith("/oauth/token");
      response.statusCode = refresh ? 200 : 404;
      response.setHeader("content-type", "application/json");
      response.end(refresh
        ? JSON.stringify({ id_token: pretendToken("after"), access_token: pretendToken("after"), refresh_token: TOKEN_AFTER_REFRESH })
        : "{}");
    });
  });
  listener.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    scratch = mkdtempSync(join(parent, SIGN_IN_CHECK_FOLDER));
    const home = join(scratch, "home");
    const signIn = join(scratch, "sign-in.json");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(signIn, JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: pretendToken("before"), access_token: pretendToken("before"), refresh_token: "letagents-check-token-before-refresh", account_id: "letagents-check" },
      last_refresh: "2000-01-01T00:00:00Z",
    }), { mode: 0o600 });
    symlinkSync(signIn, join(home, SIGN_IN_FILE));
    await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", () => resolve()));
    const address = listener.address();
    if (!address || typeof address === "string") return false;
    const origin = `http://127.0.0.1:${address.port}`;
    const proxies = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].map((key) => [key, origin]));
    const toRun = Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "LANG"].flatMap((key) => env[key] ? [[key, env[key]]] : []));
    // Exactly what was written above, and nothing else: no config, no rules, nothing unknown.
    if (entriesBelow(scratch).sort().join("\n") !== ["home", `home/${SIGN_IN_FILE}`, "sign-in.json"].join("\n")) return false;
    await askCodexAppServer(codexBin, {
      cwd: scratch,
      env: { ...toRun, HOME: scratch, CODEX_HOME: home, TMPDIR: scratch, [TOKEN_SERVICE_OVERRIDE]: `${origin}/oauth/token`, ...proxies },
      configOverrides: [...CODEX_OWNER_FEATURE_OVERRIDES, 'cli_auth_credentials_store="file"', `chatgpt_base_url="${origin}/"`, `openai_base_url="${origin}/v1"`],
    }, (request) => request("account/read", { refreshToken: true }), SIGN_IN_CHECK_TIMEOUT_MS);
    return lstatSync(join(home, SIGN_IN_FILE)).isSymbolicLink() && readFileSync(signIn, "utf8").includes(TOKEN_AFTER_REFRESH);
  } catch {
    return false;
  } finally {
    listener.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

const signInChecks = new Map<string, Promise<boolean>>();
/**
 * The check above, made once for each Codex as it answers now. Only a pass is
 * remembered. It is kept for the command together with what Codex says it is:
 * the command of an npm install is a small script that starts the real
 * program from another package, so the file on disk can stay the same when
 * the program is replaced, while the version Codex reports changes with it.
 * A Codex that does not say what it is is checked at every launch.
 *
 * It is not kept for each owner home: how Codex rewrites a sign-in file is a
 * matter of the program, and the check gives it a made-up home with the file
 * store. Where one owner home keeps its sign-in is never remembered: Codex is
 * asked at every launch.
 */
export function codexKeepsLinkedSignIn(codexBin: string, env: NodeJS.ProcessEnv, version: string | null): Promise<boolean> {
  const check = () => checkCodexKeepsLinkedSignIn(codexBin, env, dirname(codexAgentHomeDirectory(env)));
  if (!version) return check();
  let identity = `${codexBin}\n${version}`;
  try {
    const path = realpathSync(codexBin);
    const file = statSync(path);
    identity = `${path}\n${file.size}\n${file.mtimeMs}\n${version}`;
  } catch {
    // A command found on PATH is checked under its own name.
  }
  let remembered = signInChecks.get(identity);
  if (!remembered) {
    remembered = check();
    signInChecks.set(identity, remembered);
    void remembered.then((kept) => { if (!kept) signInChecks.delete(identity); });
  }
  return remembered;
}

export type CodexAgentHomeDependencies = {
  inspect(codexBin: string, options: { cwd: string; env: NodeJS.ProcessEnv; configOverrides: readonly string[] }): Promise<CodexSettingsInspection>;
  /** `version`: what Codex said it is when it answered for its settings. Null when it did not say. */
  keepsLinkedSignIn(codexBin: string, env: NodeJS.ProcessEnv, version: string | null): Promise<boolean>;
  link(ownerHome: string, agentHome: string): { own: string[]; inPlaceOfOwners: string[] };
  /** The first entries of one folder: none means it holds nothing. It may name more than Codex reads, never less. */
  folderEntries(folder: string): string[];
};

const DEFAULT_DEPENDENCIES: CodexAgentHomeDependencies = {
  inspect: inspectCodexSettings,
  keepsLinkedSignIn: codexKeepsLinkedSignIn,
  link: linkCodexAgentHome,
  folderEntries: firstFolderEntries,
};

/**
 * A sandbox that lets a command write the project also lets it write every
 * folder the Codex config names in `sandbox_workspace_write.writable_roots`.
 * Codex 0.153.4 adds them to a turn whatever sandbox the turn names: with the
 * conversation start and the turn policy that the adapter sends at the Auto
 * level, and with an empty list named in the turn too, a command wrote a
 * folder the owner's config named, one a trusted project's config named, and
 * the agents' home `rules` folder below one (an installed-Codex test holds
 * this). A read-only sandbox writes nowhere, and the roots do not apply to
 * it. A project's own list is refused where the keys of its config are
 * looked at, so the folders that come here are the owner's.
 *
 * A command that can write where Codex reads its settings or its command
 * rules can change them, and Codex reads them again when a conversation is
 * started or loaded. LetAgents looks at the rule folders just before it
 * starts or loads one. That look is not enough here: a process that a command
 * left running can write between the look and Codex's read, and LetAgents
 * does not look into every file Codex reads (a config, a sign-in). So a
 * launch or a load is refused when a named folder is one of these, holds
 * one, or is in one:
 *
 * - the agents' Codex home, and the home a running process says it has;
 *   through "holds", the LetAgents data folder it is in, where the sign-in
 *   check runs beside it; and any other owner home's agents' home there;
 * - the owner's Codex home;
 * - the `rules` folder of each other layer Codex reads rules from: the
 *   computer's own settings, and a managed config;
 * - a project layer's `.codex` folder. Codex 0.153.4 keeps the work folder's
 *   own `.codex` from a command whatever the roots are, and the `.codex`
 *   directly in a root. So for the work folder's own, only a root that is it
 *   or is in it is refused. For a layer above the work folder, a root above
 *   that layer's folder is refused too: it leaves that `.codex` open.
 *
 * A permission profile is not looked at: one that is the config's default was
 * seen not to apply to a conversation that is started with a named sandbox,
 * which is how every conversation here is started.
 */
function writableRootsRefusal(
  inspection: CodexSettingsInspection,
  env: NodeJS.ProcessEnv,
  where: { cwd?: string | null; runsWith?: string | null } = {},
): string | null {
  if (inspection.writableRoots === null) {
    return "Codex named the folders its config lets a sandboxed command write (sandbox_workspace_write.writable_roots) in a form LetAgents cannot read. "
      + "LetAgents cannot tell whether a command could write a Codex home and leave its sandbox, so it will not start Codex at this access level. "
      + "Give this agent an access level that does not let it write the project, or Full access if you accept that.";
  }
  const AGENTS = "the Codex home LetAgents keeps for sandboxed agents";
  const userHome = env.HOME?.trim() || homedir();
  const agentHome = codexAgentHomeDirectory(env);
  const dataFolder = dirname(agentHome);
  const ownerHome = codexHomeDirectory(env);
  const AGENT_HOME_NAME = /^codex-agent-home(-|$)/;
  let otherAgentHomes: string[] = [];
  try {
    otherAgentHomes = readdirSync(dataFolder).filter((name) => AGENT_HOME_NAME.test(name)).map((name) => join(dataFolder, name));
  } catch {
    // No data folder yet: nothing in it to name.
  }
  // A folder as its owner wrote it, so that it can be found in the config: from the user folder when it is named below it.
  const shownFolder = (folder: string) => {
    const fromHome = pathFrom(resolve(userHome), resolve(folder));
    return (fromHome === null ? folder : join("~", fromHome)).replace(/[^\x20-\x7e]/g, "?").slice(0, 240);
  };
  /** How a root and a folder lie: the root is the folder, holds it, or is in it. Null when they are apart. */
  const lies = (root: string, folder: string): "is" | "holds" | "is in" | null => {
    const holds = folderHolds(root, folder);
    const within = folderHolds(folder, root);
    return holds && within ? "is" : holds ? "holds" : within ? "is in" : null;
  };
  const touches = (root: string): string | null => {
    for (const home of [agentHome, ...(where.runsWith ? [where.runsWith] : [])]) {
      const how = lies(root, home);
      if (how) return `${how} ${AGENTS}`;
    }
    // Another owner home's agents' home in the same data folder: one that is there, and one that is only named so far.
    for (const other of otherAgentHomes) {
      const how = lies(root, other);
      if (how === "is" || how === "is in") return `${how} a Codex home LetAgents keeps for sandboxed agents`;
    }
    const inData = pathFrom(foldedPath(resolvedPath(dataFolder)), foldedPath(resolvedPath(root)));
    const entry = inData?.split(/[\\/]/)[0] ?? "";
    if (AGENT_HOME_NAME.test(entry)) return `${inData === entry ? "is" : "is in"} a Codex home LetAgents keeps for sandboxed agents`;
    const owner = lies(root, ownerHome);
    if (owner) return `${owner} your Codex home`;
    for (const rules of inspection.otherRuleFolders) {
      const how = lies(root, rules);
      if (how) return `${how} a folder that Codex reads command rules from (${shownFolder(rules)})`;
    }
    for (const layer of where.cwd ? projectDotCodexFolders(where.cwd) : []) {
      const how = lies(root, layer.folder);
      if (!how) continue;
      const from = `this project's ${layer.shown} folder, where Codex reads command rules and settings`;
      if (how !== "holds") return `${how} ${from}`;
      // Codex keeps from a command the work folder's own `.codex`, and the `.codex` directly in a root. Any other is open to it.
      if (!layer.own && lies(root, dirname(layer.folder)) !== "is") return `holds ${from}`;
    }
    return null;
  };
  for (const named of inspection.writableRoots ?? []) {
    const how = touches(named);
    if (!how) continue;
    const shown = shownFolder(named);
    return `Your Codex config lets a sandboxed command write ${shown} (sandbox_workspace_write.writable_roots), and that folder ${how}. `
      + "A command could change what Codex reads there and leave its sandbox, so LetAgents will not start Codex at this access level. "
      + `Take ${shown} out of writable_roots in your Codex config.toml, or give this agent Full access if you accept that.`;
  }
  return null;
}

/**
 * The same question asked again later, of the folders as they were named when
 * the process was last looked at: null while none of them may not be written.
 * Asked before every turn. Codex 0.153.4 itself keeps a command from removing
 * a writable folder, from renaming a folder above one, and stops running
 * commands when one has become a link. That is Codex's own, and may not hold
 * in a later one: a named folder that a command turned into a link to a home
 * would then open that home, and this finds it before the next turn.
 */
export type CodexWritableFoldersCheck = () => string | null;

async function inspected(
  deps: CodexAgentHomeDependencies,
  codexBin: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<CodexSettingsInspection> {
  try {
    return await deps.inspect(codexBin, {
      cwd: options.cwd ?? (parse(codexHomeDirectory(options.env)).root || "/"), env: options.env, configOverrides: [],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(
      `Codex did not answer when LetAgents asked for its settings (${detail}), so LetAgents will not start it at a sandboxed access level. `
      + "Start the agent again. If it happens again, check that the codex command runs on this computer, and update Codex.",
    );
  }
}

/**
 * The Codex home for a launch at a sandboxed access level: the agents' home,
 * or null for the owner's own, and what the owner is to be told. `env` is the
 * launch's environment as it is for the owner's home.
 *
 * The agents' home is used when Codex keeps its sign-in in a file in its home
 * and rewrites that file in place. When it cannot be used, the owner's home is
 * used only if it holds no saved rule, and the launch is refused if it holds
 * one. A launch is refused always when another layer Codex applies holds a
 * command rule: the project's own, or the machine's.
 */
export async function codexHomeForSandboxedLaunch(
  codexBin: string,
  /** `writableSandbox`: the access level's sandbox lets a command write the project. */
  options: { cwd?: string; env: NodeJS.ProcessEnv; writableSandbox?: boolean },
  dependencies: Partial<CodexAgentHomeDependencies> = {},
): Promise<{ codexHome: string | null; notices: string[]; writableFoldersCheck?: CodexWritableFoldersCheck }> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const ownerHome = codexHomeDirectory(options.env);
  // The project's own rule folders first, trusted or not, before Codex is asked anything.
  const inProject = options.cwd ? projectCommandRulesRefusal(options.cwd, deps.folderEntries, undefined, join(ownerHome, "rules")) : null;
  if (inProject) throw new Error(inProject);
  const inspection = await inspected(deps, codexBin, options);
  assertLayersAddNoCommandRules(options.cwd, inspection, deps.folderEntries);
  const writableSandbox = options.writableSandbox === true;
  const keys = options.cwd ? projectKeysRefusal(options.cwd, inspection.projectLayers, { writableSandbox }) : null;
  if (keys) throw new Error(keys);
  const writable = writableSandbox ? writableRootsRefusal(inspection, options.env, { cwd: options.cwd }) : null;
  if (writable) throw new Error(writable);
  // The folders as they are named now, to be looked at again before each turn.
  let named = inspection;
  const checked = <T extends { codexHome: string | null; notices: string[] }>(home: T): T & { writableFoldersCheck?: CodexWritableFoldersCheck } => (writableSandbox
    ? { ...home, writableFoldersCheck: () => writableRootsRefusal(named, options.env, { cwd: options.cwd, runsWith: home.codexHome }) } : home);

  let why: string;
  let otherWayOut = "";
  if (inspection.credentialStore === null) {
    why = "Codex did not say where it keeps its sign-in";
  } else if (inspection.credentialStore !== "file") {
    why = "Codex does not keep its sign-in in a file in its home folder";
    otherWayOut = " Or set cli_auth_credentials_store = \"file\" in your Codex config.toml, and sign in to Codex again if it asks.";
  } else if (!await deps.keepsLinkedSignIn(codexBin, options.env, inspection.userAgent ?? null)) {
    why = "LetAgents could not confirm that this Codex version keeps a shared sign-in file in place";
  } else {
    const agentHome = codexAgentHomeDirectory(options.env);
    let linked: { own: string[]; inPlaceOfOwners: string[] } | null = null;
    try {
      linked = deps.link(ownerHome, agentHome);
    } catch (error) {
      if (error instanceof CodexAgentHomeError) throw error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      why = `the folder for it could not be prepared${typeof code === "string" ? ` (${code})` : ""}`;
    }
    if (linked) {
      // With anything of its own in it, this home is not the owner's files alone: a config of its
      // own can trust a project or move the sign-in. So Codex is asked again, as it reads this home.
      if (linked.own.length) {
        const asAgents = await inspected(deps, codexBin, { ...options, env: { ...options.env, CODEX_HOME: agentHome } });
        if (asAgents.credentialStore !== "file") {
          throw new Error(
            `The folder LetAgents keeps for sandboxed Codex agents (${shownAgentHome(agentHome)}) has settings of its own that move Codex's sign-in out of its home folder. `
            + "A second place for the sign-in can sign you out of Codex, so LetAgents will not start a sandboxed Codex agent. "
            + "Stop the sandboxed Codex agents, delete config.toml in that folder, and start the agent again.",
          );
        }
        assertLayersAddNoCommandRules(options.cwd, asAgents, deps.folderEntries);
        const writableAsAgents = (options.cwd ? projectKeysRefusal(options.cwd, asAgents.projectLayers, { writableSandbox }) : null)
          ?? (writableSandbox ? writableRootsRefusal(asAgents, options.env, { cwd: options.cwd }) : null);
        if (writableAsAgents) throw new Error(writableAsAgents);
        named = asAgents;
      }
      // Kept and said, not refused: the copy can hold conversations, and it cannot open the sandbox,
      // because Codex was just asked what it reads with it. Deleting it is the owner's choice.
      const shown = linked.inPlaceOfOwners.slice(0, 5).map((name) => name.replace(/[^\x20-\x7e]/g, "?").slice(0, 60)).join(", ");
      return checked({
        codexHome: agentHome,
        notices: linked.inPlaceOfOwners.length ? [
          `The folder LetAgents keeps for sandboxed Codex agents (${shownAgentHome(agentHome)}) holds entries of its own with the same names as entries of your Codex home: ${shown}`
          + `${linked.inPlaceOfOwners.length > 5 ? ` and ${linked.inPlaceOfOwners.length - 5} more` : ""}. `
          + "That happens when a sandboxed agent's Codex makes an entry before your Codex home has it, for example the first time after a Codex update adds one. "
          + "Sandboxed agents use those, not yours, so they do not see what you or your own Codex later put in yours. "
          + "LetAgents never deletes them, because they can hold conversations; an empty one it replaces with a link to yours by itself. "
          + "To use your own again, stop the sandboxed Codex agents and delete those entries from that folder.",
        ] : [],
      });
    }
  }
  if (!deps.folderEntries(join(ownerHome, "rules")).length) return checked({ codexHome: null, notices: [] });
  throw new Error(
    "Codex has saved command rules (the rules folder in your Codex home), and a command that matches one runs outside this agent's sandbox. "
    + `LetAgents could not give this agent a Codex home without them: ${why!}. `
    + `So it will not start Codex at this access level. Remove the saved rules, or give this agent Full access.${otherWayOut}`,
  );
}

/** Why a Codex at a sandboxed access level may take no turn in the folder it works in. Null when it may. */
export function sandboxedCodexProjectRefusal(cwd: string | null, folderEntries: (folder: string) => string[] = firstFolderEntries): string | null {
  if (cwd === null) {
    return "Codex did not say which folder this agent works in, so LetAgents cannot look for command rules in its project, and gives it no work. "
      + "Pause the agent and resume it.";
  }
  return projectCommandRulesRefusal(cwd, folderEntries);
}

/**
 * Why a Codex at a sandboxed access level may take no turn with the home it
 * says it runs with. Null when it may: the home holds no saved rule. A Codex
 * that was started before agents had a home of their own, or with the owner's
 * home because it held no rule then, is found here.
 */
export function sandboxedCodexHomeRefusal(codexHome: string | null, folderEntries: (folder: string) => string[] = firstFolderEntries): string | null {
  if (codexHome === null) {
    return "Codex did not say which home folder it runs with, so LetAgents cannot tell that saved command rules stay away from this agent, and gives it no work. "
      + "Update Codex, then pause the agent and resume it.";
  }
  if (!folderEntries(join(codexHome, "rules")).length) return null;
  return "This agent's Codex runs with a home folder that holds saved command rules, and a command that matches one runs outside its sandbox. "
    + "So LetAgents gives it no work. Pause the agent and resume it: it then starts with a home folder without those rules.";
}

/**
 * Why a running Codex at a sandboxed access level may not start or load a
 * conversation now. Codex reads its command rules again each time it does,
 * so what a project or the machine gained since the launch would apply.
 */
export async function sandboxedCodexLoadRefusal(
  codexBin: string,
  /** `keepWritableFoldersCheck`: given the folders as they are named now, to be looked at again before each turn. Not called for a refusal. */
  options: { cwd: string; codexHome: string | null; env: NodeJS.ProcessEnv; writableSandbox?: boolean; keepWritableFoldersCheck?: (check: CodexWritableFoldersCheck) => void },
  dependencies: Partial<Pick<CodexAgentHomeDependencies, "inspect" | "folderEntries">> = {},
): Promise<string | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const known = sandboxedCodexHomeRefusal(options.codexHome, deps.folderEntries) ?? projectCommandRulesRefusal(options.cwd, deps.folderEntries);
  if (known) return known;
  try {
    const inspection = await inspected(deps, codexBin, { cwd: options.cwd, env: { ...options.env, CODEX_HOME: options.codexHome! } });
    assertLayersAddNoCommandRules(options.cwd, inspection, deps.folderEntries);
    const writableSandbox = options.writableSandbox === true;
    const check: CodexWritableFoldersCheck = () => writableRootsRefusal(inspection, options.env, { cwd: options.cwd, runsWith: options.codexHome });
    const refusal = projectKeysRefusal(options.cwd, inspection.projectLayers, { writableSandbox }) ?? (writableSandbox ? check() : null);
    if (!refusal && writableSandbox) options.keepWritableFoldersCheck?.(check);
    return refusal;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
