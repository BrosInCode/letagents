import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

import { CODEX_OWNER_FEATURE_OVERRIDES, codexHomeDirectory } from "../../../../../shared/codex-owner-isolation.mjs";
import {
  askCodexAppServer,
  assertProjectAddsNoCommandRules,
  inspectCodexSettings,
  projectFolderEntries,
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
const TOKEN_AFTER_REFRESH = "letagents-check-token-after-refresh";

/**
 * Where the agents' Codex home is. It is in the user's own folder and never
 * in a temp folder: Codex's project-only sandbox leaves temp folders writable,
 * and a command must not be able to save a rule here.
 */
export function codexAgentHomeDirectory(env: NodeJS.ProcessEnv): string {
  return env.LETAGENTS_CODEX_AGENT_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".letagents", "codex-agent-home");
}

/** The agents' home holds a sign-in file of its own. Nothing is started until the owner has looked at it. */
export class CodexAgentHomeSignInError extends Error {}

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

/**
 * Make the agents' home match the owner's: a link for every entry of the
 * owner's home except `rules`. A file Codex wrote over a link is the owner's
 * file as it was, so it is removed and linked again. A sign-in file that is
 * not a link is never removed: it can hold the only token that still works.
 */
export function linkCodexAgentHome(ownerHome: string, agentHome: string): void {
  const owner = realpathSync(ownerHome);
  // Checked before the folder is made, so nothing is ever made inside the owner's home.
  const home = resolvedPath(agentHome);
  if (home === owner || home.startsWith(owner + sep) || owner.startsWith(home + sep)) {
    throw new Error("The agents' Codex home must be a folder apart from the owner's Codex home.");
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const toLink = new Set(readdirSync(owner));
  toLink.delete("rules");
  for (const name of readdirSync(home)) {
    if (name === "rules") continue;
    const path = join(home, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      if (toLink.has(name) && readlinkSync(path) === join(owner, name)) toLink.delete(name);
      else unlinkSync(path);
    } else if (name === SIGN_IN_FILE) {
      // The folder is named as its owner knows it, never by its full path: the message can be shown in a room.
      throw new CodexAgentHomeSignInError(
        `LetAgents found a Codex sign-in file of its own (${SIGN_IN_FILE}) in the folder it keeps for sandboxed agents `
        + `(${basename(home)} in your ${basename(dirname(home))} folder). `
        + "Two sign-in files can sign you out of Codex, so LetAgents will not start a sandboxed Codex agent. "
        + "Check that Codex is still signed in, then delete that file.",
      );
    } else if (toLink.has(name) && !entry.isDirectory()) {
      unlinkSync(path);
    } else {
      // A folder Codex made here, or an entry the owner's home does not have, is left as it is.
      toLink.delete(name);
    }
  }
  for (const name of toLink) symlinkSync(join(owner, name), join(home, name));
  const rules = join(home, "rules");
  if (lstatSync(rules, { throwIfNoEntry: false })?.isDirectory()) chmodSync(rules, 0o700);
  rmSync(rules, { recursive: true, force: true });
  mkdirSync(rules);
  chmodSync(rules, 0o555);
}

function pretendToken(label: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { email: "check@letagents.invalid", exp: Math.floor(Date.now() / 1000) + 3600, label };
  return `${part({ alg: "none" })}.${part(claims)}.${label}`;
}

/**
 * Whether this Codex rewrites a linked sign-in file in place. Codex is given
 * a scratch home whose sign-in file is a link to a made-up sign-in, and is
 * asked to refresh it against a listener on this machine. Nothing of the
 * owner's is read, and every other request Codex makes is sent to the same
 * listener and refused. True only when the link is still a link and the file
 * it leads to holds the new token. `env` is the launch's environment: only
 * what Codex needs to be found and run is taken from it.
 */
export async function checkCodexKeepsLinkedSignIn(codexBin: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const scratch = mkdtempSync(join(tmpdir(), "letagents-codex-sign-in-check-"));
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
    const home = join(scratch, "home");
    const signIn = join(scratch, "sign-in.json");
    mkdirSync(home);
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
    await askCodexAppServer(codexBin, {
      cwd: scratch,
      env: { ...toRun, HOME: scratch, CODEX_HOME: home, TMPDIR: scratch, CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${origin}/oauth/token`, ...proxies },
      configOverrides: [...CODEX_OWNER_FEATURE_OVERRIDES, 'cli_auth_credentials_store="file"', `chatgpt_base_url="${origin}/"`, `openai_base_url="${origin}/v1"`],
    }, (request) => request("account/read", { refreshToken: true }), SIGN_IN_CHECK_TIMEOUT_MS);
    return lstatSync(join(home, SIGN_IN_FILE)).isSymbolicLink() && readFileSync(signIn, "utf8").includes(TOKEN_AFTER_REFRESH);
  } catch {
    return false;
  } finally {
    listener.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

const signInChecks = new Map<string, Promise<boolean>>();
/** The check above, made once for each Codex binary as it is on disk now. Only a pass is remembered. */
function codexKeepsLinkedSignIn(codexBin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  let identity = codexBin;
  try {
    const path = realpathSync(codexBin);
    const file = statSync(path);
    identity = `${path}\n${file.size}\n${file.mtimeMs}`;
  } catch {
    // A command found on PATH is checked under its own name.
  }
  let check = signInChecks.get(identity);
  if (!check) {
    check = checkCodexKeepsLinkedSignIn(codexBin, env);
    signInChecks.set(identity, check);
    void check.then((kept) => { if (!kept) signInChecks.delete(identity); });
  }
  return check;
}

export type CodexAgentHomeDependencies = {
  inspect(codexBin: string, options: { cwd: string; env: NodeJS.ProcessEnv; configOverrides: readonly string[] }): Promise<CodexSettingsInspection>;
  keepsLinkedSignIn(codexBin: string, env: NodeJS.ProcessEnv): Promise<boolean>;
  link(ownerHome: string, agentHome: string): void;
  /** Everything in one folder. It may list more than Codex reads, never less. */
  folderEntries(folder: string): string[];
};

const DEFAULT_DEPENDENCIES: CodexAgentHomeDependencies = {
  inspect: inspectCodexSettings,
  keepsLinkedSignIn: codexKeepsLinkedSignIn,
  link: linkCodexAgentHome,
  folderEntries: projectFolderEntries,
};

/**
 * The Codex home for a launch at a sandboxed access level: the agents' home,
 * or null for the owner's own. `env` is the launch's environment as it is for
 * the owner's home.
 *
 * The agents' home is used when Codex keeps its sign-in in a file in its home
 * and rewrites that file in place. When it cannot be used, the owner's home is
 * used only if it holds no saved rule, and the launch is refused if it holds
 * one. A project whose own command rules Codex would load is refused always.
 */
export async function codexHomeForSandboxedLaunch(
  codexBin: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv },
  dependencies: Partial<CodexAgentHomeDependencies> = {},
): Promise<string | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const ownerHome = codexHomeDirectory(options.env);
  let inspection: CodexSettingsInspection;
  try {
    inspection = await deps.inspect(codexBin, { cwd: options.cwd ?? (parse(ownerHome).root || "/"), env: options.env, configOverrides: [] });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`Codex could not report its settings, so LetAgents will not start it at a sandboxed access level: ${detail}`);
  }
  if (options.cwd) assertProjectAddsNoCommandRules(options.cwd, inspection, deps.folderEntries);

  let why: string;
  if (inspection.credentialStore !== "file") {
    why = "Codex does not keep its sign-in in a file in its home folder";
  } else if (!await deps.keepsLinkedSignIn(codexBin, options.env)) {
    why = "LetAgents could not confirm that this Codex version keeps a shared sign-in file in place";
  } else {
    const agentHome = codexAgentHomeDirectory(options.env);
    try {
      deps.link(ownerHome, agentHome);
      return agentHome;
    } catch (error) {
      if (error instanceof CodexAgentHomeSignInError) throw error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      why = `the folder for it could not be prepared${typeof code === "string" ? ` (${code})` : ""}`;
    }
  }
  if (!deps.folderEntries(join(ownerHome, "rules")).length) return null;
  throw new Error(
    "Codex has saved command rules (the rules folder in your Codex home), and a command that matches one runs outside this agent's sandbox. "
    + `LetAgents could not give this agent a Codex home without them: ${why}. `
    + "So it will not start Codex at this access level. Remove the saved rules, or give this agent Full access.",
  );
}
