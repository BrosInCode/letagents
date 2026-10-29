import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
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
import { createWindowsSecurity, icaclsSetOwnerArguments, INHERITED_GROUP_SIDS, parseSddl, protectOwnerPrivateSync, sddlExtraGrantSids, sddlIsOwnerPrivate, SYSTEM_SID, type UserIdentity, windowsSystemTool } from "../../../../../shared/owner-private-fs.mjs";
import { renameSyncWithRetry } from "../../../../../shared/rename-retry.mjs";
import { shadowProfileEnvironment, windowsSystemEnvironment } from "./windows-child-environment.js";

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
// Windows lets only an administrator, or Developer Mode, make a symbolic
// link. There the agents' home links a folder with a junction and a file
// with a hard link (a second name of the same file), which need neither; so
// the agents' home must be on the owner's home's disk, and a file that is a
// link in the owner's home is linked as the file it leads to. Codex's SQLite
// databases are not linked (see WINDOWS_OWN_DATABASE). A hard link stays the
// owner's file only while both are written in place: a file the owner's side
// replaces (an editor that saves by rename) leaves the agents' home with the
// old one, which is kept and reported like any entry of its own. `rules` is
// given a DACL that lets this account read it and nothing more, the Windows
// form of its mode 0555.
//
// The sign-in file is the one link that must never turn into a copy: Codex
// replaces its token when it refreshes it, and a copy with the new token
// would leave the owner's own file with a dead one. Codex rewrites the file in
// place, through the link. That is checked for each Codex binary, with a
// made-up sign-in and a made-up token service, before the real link is used.
//
// Codex's sandboxes refuse no read, so a command of a sandboxed agent can read
// the owner's sign-in file, at the owner's path and through the link. A
// Read-only agent is therefore started with a permission profile of its own:
// Codex's built-in read-only one, and a `deny` for the sign-in file. Codex's
// own process is not in the sandbox, so it still reads the file and refreshes
// it. The profile is given as launch overrides, and nothing is written to the
// owner's config. That Codex honours such a `deny` is checked for each Codex
// binary with a made-up file, before a Read-only agent is started.

const SIGN_IN_FILE = "auth.json";
const SIGN_IN_CHECK_TIMEOUT_MS = 15_000;
const SIGN_IN_CHECK_FOLDER = "codex-sign-in-check-";
const TOKEN_AFTER_REFRESH = "letagents-check-token-after-refresh";
const TOKEN_SERVICE_OVERRIDE = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";
const READ_ONLY_PROFILE_PREFIX = "letagents_read_only_";
/** Codex's own read-only profile, which a Read-only agent's profile extends. Codex reports it back with the profile's name. */
export const CODEX_BUILT_IN_READ_ONLY_PROFILE = ":read-only";
const DENY_CHECK_TIMEOUT_MS = 15_000;
const DENY_CHECK_FOLDER = "codex-deny-check-";
const DENY_CHECK_DENIED = "letagents-check-denied-file";
const DENY_CHECK_OPEN = "letagents-check-open-file";
/** An address on this machine where nothing listens: what a check that needs no service gives Codex for every address it could call. */
const NOWHERE = "http://127.0.0.1:9";
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

/** Which file a path names, links not followed unless asked. Null when nothing is there, or the disk gives no file id. */
function fileId(path: string, followLinks = false): string | null {
  try {
    const entry = followLinks ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true });
    return entry.ino === 0n ? null : `${entry.dev}:${entry.ino}`;
  } catch {
    return null;
  }
}

/**
 * A second name for the file `target`: a symbolic link to it, or on Windows,
 * where a symbolic link needs an administrator, a hard link.
 */
function linkFile(target: string, path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") linkSync(target, path);
  else symlinkSync(target, path);
}

/**
 * Whether `path` is still the second name `linkFile` made for `target`, and
 * not a file of its own. On Windows: the same file as the one `target` leads
 * to, since a hard link is made to that file and never to a link.
 */
function isFileLink(path: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return lstatSync(path).isSymbolicLink();
  const id = fileId(path);
  return id !== null && id === fileId(target, true);
}

/**
 * Windows: the files of a Codex home that get no hard link, an SQLite
 * database and the files SQLite keeps beside it. SQLite finds the journal of
 * a database by its path, so a database opened by two names (the owner's and
 * the agents') would have two journals, and writes could be lost. Through a
 * POSIX link SQLite opens the file the link leads to, so the agents' home
 * there shares the owner's database. On Windows the agents' Codex keeps a
 * database of its own; the conversations themselves are in `sessions`, which
 * is linked.
 */
const WINDOWS_OWN_DATABASE = /\.(?:sqlite3?|db)(?:-wal|-shm|-journal)?$/i;

/**
 * Windows: the hard links this code made in the agents' home, by name, with
 * the file each was when it was last seen linked. A hard link is a file like
 * any other, so without this record a link whose owner's file was replaced
 * (an editor's save, a sign-out and sign-in) could not be told from a file
 * the agents' Codex made, and would be kept for good. An entry that is still
 * exactly that file is a former link: nothing wrote it since, so it is
 * removed and linked again. One that changed is an entry of its own.
 */
const WINDOWS_LINK_RECORD = ".letagents-links.json";
/** Windows: the name a former link that changed while it was moved aside is kept under. */
const WINDOWS_FORMER_LINK_PREFIX = ".letagents-former-";
/** `mtimeNs` in full (NTFS keeps 100 ns), as text: a millisecond would let a write in the same one pass for no write. */
type LinkedFileState = { id: string; size: string; mtimeNs: string };

function linkedFileState(path: string): LinkedFileState | null {
  try {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || entry.ino === 0n) return null;
    return { id: `${entry.dev}:${entry.ino}`, size: String(entry.size), mtimeNs: String(entry.mtimeNs) };
  } catch {
    return null;
  }
}

function readLinkRecord(home: string): Record<string, LinkedFileState> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, WINDOWS_LINK_RECORD), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, LinkedFileState] => {
      const state = entry[1] as Partial<LinkedFileState> | null;
      return typeof state?.id === "string" && typeof state.size === "string" && typeof state.mtimeNs === "string";
    }));
  } catch {
    return {};
  }
}

/** The variables a Codex check is run with, besides its own home: what Codex needs to be found and to run. */
function codexCheckEnvironment(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return {
    ...windowsSystemEnvironment(env),
    ...Object.fromEntries(["PATH", "Path", "PATHEXT", "SystemRoot", "LANG"].flatMap((key) => env[key] ? [[key, env[key]]] : [])),
  };
}

/** Windows: the variables beside HOME that name a user's folders there, all pointed at the check's own folder. Empty elsewhere. */
function windowsShadowProfile(folder: string): Record<string, string> {
  return process.platform === "win32" ? shadowProfileEnvironment(folder) : {};
}

/**
 * The icacls arguments that let `sid` only read the folder `path` and what is
 * in it: list, read, traverse, and change its permissions and owner, so that
 * this code can open it again on the next launch. Nothing can be made in it.
 * SYSTEM keeps full access. Inheritance is off and the groups a profile
 * passes on are removed, as for a private folder.
 */
export function icaclsReadOnlyFolderArguments(path: string, sid: string): string[] {
  if (!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(sid)) throw new Error("A read-only folder is given to a SID only.");
  return [path, "/inheritance:r", "/remove:g", ...INHERITED_GROUP_SIDS.map((group) => `*${group}`),
    "/grant:r", `*${sid}:(OI)(CI)(RD,REA,X,RA,RC,S,WDAC,WO)`, `*${SYSTEM_SID}:(OI)(CI)F`, "/q"];
}

/** Every right of the account's read-only grant: RD, REA, X, RA, RC, S, WDAC, WO. */
const READ_ONLY_FOLDER_MASK = 0x1e00a9;

/**
 * Whether a folder's descriptor is the read-only one: owned by the account,
 * protected, and allow entries for only the account and SYSTEM, the
 * account's with no right beyond READ_ONLY_FOLDER_MASK. A right written as
 * anything but a number is not read, and refuses.
 */
export function sddlIsReadOnlyFolderFor(sddl: string | null | undefined, user: UserIdentity): boolean {
  if (!sddlIsOwnerPrivate(sddl, user)) return false;
  const { sid, aliases = [] } = typeof user === "string" ? { sid: user } : user;
  const isUser = (ace: string) => ace === sid.toUpperCase() || aliases.includes(ace);
  return parseSddl(sddl)!.dacl!.aces.every((ace) => {
    if ((ace.type !== "A" && ace.type !== "OA") || !isUser(ace.sid)) return true;
    if (!/^0x[0-9a-f]{1,8}$/i.test(ace.rights)) return false;
    return (Number.parseInt(ace.rights, 16) & ~READ_ONLY_FOLDER_MASK) === 0;
  });
}

/** The default backend: it has every optional method, which this check needs. */
let rulesFolderSecurity: Required<ReturnType<typeof createWindowsSecurity>> | null = null;

/**
 * Make the empty `rules` folder one nothing can be saved into: mode 0555 on
 * POSIX, and on Windows a DACL that lets this account only read it. On
 * Windows the descriptor is read back, and a folder whose descriptor is not
 * exactly that one is not used.
 */
export function lockRulesFolder(rules: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") {
    chmodSync(rules, 0o555);
    return;
  }
  rulesFolderSecurity ??= createWindowsSecurity() as Required<ReturnType<typeof createWindowsSecurity>>;
  const user = rulesFolderSecurity.currentUserSidSync();
  const icacls = (args: string[]) => execFileSync(windowsSystemTool("icacls.exe"), args, { stdio: "ignore", windowsHide: true, timeout: 30_000 });
  // The account owns it, as a private folder: an elevated process's new folder belongs to Administrators.
  icacls(icaclsSetOwnerArguments(rules, user));
  icacls(icaclsReadOnlyFolderArguments(rules, user));
  // A profile can pass on entries that no fixed list names (a logon session's, a domain group's):
  // read the result back and remove every other allow entry by its SID, as a private folder does.
  const identity = { sid: user, aliases: rulesFolderSecurity.currentUserAliasesSync() };
  let [sddl] = rulesFolderSecurity.readSddlSync([rules]);
  const others = sddlExtraGrantSids(sddl, identity);
  if (others?.length) {
    rulesFolderSecurity.removeGrantsSync(rules, others);
    [sddl] = rulesFolderSecurity.readSddlSync([rules]);
  }
  // Exactly the account's read-only entry and SYSTEM, as read back: anything else, or what cannot be read, is refused.
  if (!sddlIsReadOnlyFolderFor(sddl, identity)) {
    throw Object.assign(new Error("The rules folder of the agents' Codex home could not be made read-only: other entries remain in its permissions."), { code: "EPERM" });
  }
  // The descriptor read back is the proof. A write from this process would not be: Node opens files
  // with backup semantics, so an elevated process whose backup privileges are on (one started from
  // Git Bash, say) writes past any DACL, as root writes past mode 0555. For every other process the
  // DACL is the control.
}

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

/** A sign-in file of the agents' home's own: nothing is started until the owner has looked at it. */
function signInOfItsOwn(home: string): CodexAgentHomeSignInError {
  return new CodexAgentHomeSignInError(
    `LetAgents found a Codex sign-in file of its own (${SIGN_IN_FILE}) in the folder it keeps for sandboxed agents (${shownAgentHome(home)}). `
    + "Two sign-in files can sign you out of Codex, so LetAgents will not start a sandboxed Codex agent. "
    + "Open Codex and check that it is still signed in, then delete that file and start the agent again. "
    + "If Codex asks you to sign in, sign in again: your conversations and settings are kept.",
  );
}

/** How the agents' home is named to its owner: by its last two names, never by its full path, which can be shown in a room. */
function shownAgentHome(home: string): string {
  return `${basename(home)} in your ${basename(dirname(home))} folder`;
}

/**
 * The name of the permission profile a Read-only agent's Codex is started
 * with, for one work attempt. Every request of that Codex names it, and every
 * reply is held to it.
 *
 * The name is made from the work attempt's own id, which nobody knows before
 * the attempt exists. Codex 0.153.4 was seen to merge a profile of the same
 * name from the owner's config, and so from a trusted project's, into the
 * launch's: a `":root" = "write"` entry and an open network of such a profile
 * stayed in force beside the launch's `deny`. A name that cannot be written
 * into a config file beforehand has nothing to be merged with.
 */
export function codexReadOnlyProfileId(workAttemptId: string): string {
  return `${READ_ONLY_PROFILE_PREFIX}${createHash("sha256").update(`letagents codex read-only profile\n${workAttemptId}`).digest("hex").slice(0, 24)}`;
}

/**
 * The launch overrides that define a profile which extends Codex's built-in
 * read-only one and denies `denied` to every command, and that make it the
 * launch's default. A conversation still has to name the profile: one that is
 * started with a named sandbox does not get the default.
 */
export function codexReadOnlyProfileOverrides(profile: string, denied: readonly string[]): string[] {
  const entries = [...new Set(denied)].map((path) => `${JSON.stringify(path)} = "deny"`).join(", ");
  return [
    `permissions.${profile}={ extends = ${JSON.stringify(CODEX_BUILT_IN_READ_ONLY_PROFILE)}, filesystem = { ${entries} } }`,
    `default_permissions=${JSON.stringify(profile)}`,
  ];
}

/**
 * Every path that names the owner's sign-in file for a launch: the file in
 * the owner's home with that home's links followed, the file it leads to when
 * it is a link itself, and the link in the agents' home when the launch runs
 * with one.
 *
 * The owner's path is the one the sandbox holds a command to: it looks at the
 * file a path leads to, so a `deny` there also refuses a read through the
 * link. Codex 0.153.4 was also seen to refuse the file when only the link is
 * named. Both are named, so that the `deny` rests on neither alone.
 */
export function codexSignInPaths(env: NodeJS.ProcessEnv, codexHome: string | null): string[] {
  const owners = join(resolvedPath(codexHomeDirectory(env)), SIGN_IN_FILE);
  const paths = [owners];
  try {
    paths.push(realpathSync(owners));
  } catch {
    // Not there yet, or a link that leads nowhere: a deny for a path that is not there holds once it is.
  }
  if (codexHome) paths.push(join(codexHome, SIGN_IN_FILE), join(resolvedPath(codexHome), SIGN_IN_FILE));
  return [...new Set(paths)];
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
export function linkCodexAgentHome(ownerHome: string, agentHome: string, platform: NodeJS.Platform = process.platform): { own: string[]; inPlaceOfOwners: string[] } {
  const windows = platform === "win32";
  const owner = realpathSync(ownerHome);
  // Checked before the folder is made, so nothing is ever made inside the owner's home.
  const home = resolvedPath(agentHome);
  if (folderHolds(owner, home) || folderHolds(home, owner)) {
    throw new Error("The agents' Codex home must be a folder apart from the owner's Codex home.");
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Where a link leads. Windows: a junction's target, without the `\\?\` prefix it may carry.
  const target = (path: string) => windows ? readlinkSync(path).replace(/^\\\\\?\\/, "") : readlinkSync(path);
  // Windows compares names without case, as its disks do.
  const sameName = (left: string, right: string) => windows ? foldedPath(resolve(left)) === foldedPath(resolve(right)) : left === right;
  // Windows: a file of the owner's home is linked by a second name of the same file.
  const linkedFile = (path: string, entry: Stats, name: string) => windows && entry.isFile() && isFileLink(path, join(owner, name), platform);
  // Windows: a hard link of this code's whose owner's file is gone or replaced, and that nothing wrote since.
  const record = windows ? readLinkRecord(home) : {};
  const formerLink = (path: string, entry: Stats, name: string) => {
    if (!windows || !entry.isFile() || !record[name] || linkedFile(path, entry, name)) return false;
    const now = linkedFileState(path);
    return now !== null && now.id === record[name].id && now.size === record[name].size && now.mtimeNs === record[name].mtimeNs;
  };
  // The folder is looked at before anything in it is changed: a launch that is refused leaves it as it was.
  if (windows) {
    // A record staged by a launch that stopped before its rename is this code's own leftover.
    for (const name of readdirSync(home)) if (name.startsWith(`${WINDOWS_LINK_RECORD}.`)) rmSync(join(home, name), { force: true });
  }
  const before = readdirSync(home).filter((name) => name !== "rules" && !(windows && name === WINDOWS_LINK_RECORD)).sort().map((name) => ({ name, path: join(home, name), entry: lstatSync(join(home, name)) }));
  if (before.some(({ name, path, entry }) => name === SIGN_IN_FILE && !entry.isSymbolicLink() && !linkedFile(path, entry, name) && !formerLink(path, entry, name))) {
    throw signInOfItsOwn(home);
  }
  // A link into another folder than this owner's home was made for another home, or by something
  // else. An agent may be running with it, so it is never turned to this home under that agent.
  if (before.some(({ path, entry }) => entry.isSymbolicLink() && !sameName(dirname(target(path)), owner))) {
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
  const ownDatabase = (name: string) => windows && WINDOWS_OWN_DATABASE.test(name);
  // The record's own name is this code's, never a link to an owner's file of that name.
  const toLink = new Set(readdirSync(owner).filter((name) => !ownDatabase(name) && !(windows && name === WINDOWS_LINK_RECORD)));
  toLink.delete("rules");
  const own: string[] = [];
  const inPlaceOfOwners: string[] = [];
  for (const { name, path, entry } of before) {
    // The agents' own database on Windows: kept as it is, and not an entry in place of the owner's.
    if (ownDatabase(name) && !entry.isSymbolicLink()) continue;
    if (entry.isSymbolicLink()) {
      if (toLink.has(name) && sameName(target(path), join(owner, name))) toLink.delete(name);
      else unlinkSync(path);
      continue;
    }
    if (toLink.has(name) && linkedFile(path, entry, name)) {
      toLink.delete(name);
      continue;
    }
    if (formerLink(path, entry, name)) {
      // Still exactly the owner's former file. It is moved aside first and looked at again there, so a
      // write that a running agent makes between the look and the move is never deleted: a file that
      // changed stays, under its new name, as an entry of the agents' own. The name is linked again below.
      // The sign-in is never kept beside the owner's: a second one can sign the owner out, and under
      // another name no Read-only profile denies it. So it is put back and the launch refused instead.
      const aside = join(home, `${WINDOWS_FORMER_LINK_PREFIX}${randomBytes(6).toString("hex")}-${name}`);
      try {
        renameSyncWithRetry(path, aside);
      } catch {
        // Held open without delete sharing, or gone: kept as it is, as an entry of its own.
        if (name === SIGN_IN_FILE) throw signInOfItsOwn(home);
        own.push(name);
        if (toLink.delete(name)) inPlaceOfOwners.push(name);
        continue;
      }
      const moved = linkedFileState(aside);
      const recorded = record[name]!;
      if (moved && moved.id === recorded.id && moved.size === recorded.size && moved.mtimeNs === recorded.mtimeNs) {
        unlinkSync(aside);
      } else if (name === SIGN_IN_FILE) {
        try { renameSyncWithRetry(aside, path); } catch { /* kept under the aside name; the owner is told below */ }
        throw signInOfItsOwn(home);
      } else {
        own.push(basename(aside));
      }
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
  for (const name of toLink) {
    if (!windows) {
      symlinkSync(join(owner, name), join(home, name));
      continue;
    }
    // Junctions and hard links need no administrator. An entry that leads nowhere has nothing to link.
    const kind = statSync(join(owner, name), { throwIfNoEntry: false });
    if (kind?.isDirectory()) symlinkSync(join(owner, name), join(home, name), "junction");
    else if (kind) linkSync(realpathSync(join(owner, name)), join(home, name));
  }
  if (windows) {
    // Every file that is a link now, as it is now. Without the record a stale link is only kept, never lost.
    const linked = Object.fromEntries(readdirSync(home).flatMap((name) => {
      const path = join(home, name);
      const entry = lstatSync(path);
      const state = name !== WINDOWS_LINK_RECORD && linkedFile(path, entry, name) ? linkedFileState(path) : null;
      return state ? [[name, state]] : [];
    }));
    // Written beside it and renamed over it: a rename replaces whatever is at that name and writes through nothing.
    const staged = join(home, `${WINDOWS_LINK_RECORD}.${randomBytes(6).toString("hex")}`);
    try {
      writeFileSync(staged, JSON.stringify(linked), { flag: "wx" });
      renameSync(staged, join(home, WINDOWS_LINK_RECORD));
    } catch {
      // The next launch keeps what it cannot tell.
      rmSync(staged, { force: true });
    }
  }
  const rules = join(home, "rules");
  if (lstatSync(rules, { throwIfNoEntry: false })?.isDirectory()) protectOwnerPrivateSync(rules, "directory");
  rmSync(rules, { recursive: true, force: true });
  mkdirSync(rules);
  lockRulesFolder(rules, platform);
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
      // Recent Codex versions discover workspace routing during account/read.
      // This is synthetic account metadata only; the proxy still refuses all
      // tunnels, including requests to this deliberately non-existent origin.
      if (request.method === "GET" && String(request.url).endsWith("/api/codex/accounts/check")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ accounts: [{
          id: "letagents-check", name: "LetAgents sign-in check", plan_type: "plus",
          workspace_backend_origin: "https://codex-check.letagents.invalid",
          account_routing_override: "NO_CONSTRAINT",
        }] }));
        return;
      }
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
    linkFile(signIn, join(home, SIGN_IN_FILE));
    await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", () => resolve()));
    const address = listener.address();
    if (!address || typeof address === "string") return false;
    const origin = `http://127.0.0.1:${address.port}`;
    const proxies = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].map((key) => [key, origin]));
    const toRun = codexCheckEnvironment(env);
    // Exactly what was written above, and nothing else: no config, no rules, nothing unknown.
    if (entriesBelow(scratch).sort().join("\n") !== ["home", `home/${SIGN_IN_FILE}`, "sign-in.json"].join("\n")) return false;
    await askCodexAppServer(codexBin, {
      cwd: scratch,
      env: { ...toRun, HOME: scratch, CODEX_HOME: home, TMPDIR: scratch, ...windowsShadowProfile(scratch), [TOKEN_SERVICE_OVERRIDE]: `${origin}/oauth/token`, ...proxies },
      configOverrides: [...CODEX_OWNER_FEATURE_OVERRIDES, 'cli_auth_credentials_store="file"', `chatgpt_base_url="${origin}/"`, `openai_base_url="${origin}/v1"`],
    }, (request) => request("account/read", { refreshToken: true }), SIGN_IN_CHECK_TIMEOUT_MS);
    return isFileLink(join(home, SIGN_IN_FILE), signIn) && readFileSync(signIn, "utf8").includes(TOKEN_AFTER_REFRESH);
  } catch {
    return false;
  } finally {
    listener.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A check of a Codex program, made once for each Codex as it answers now.
 * Only a pass is remembered. It is kept for the command together with what
 * Codex says it is: the command of an npm install is a small script that
 * starts the real program from another package, so the file on disk can stay
 * the same when the program is replaced, while the version Codex reports
 * changes with it. A Codex that does not say what it is is checked at every
 * launch.
 */
function oncePerCodex(remembered: Map<string, Promise<boolean>>, codexBin: string, version: string | null, check: () => Promise<boolean>): Promise<boolean> {
  if (!version) return check();
  let identity = `${codexBin}\n${version}`;
  try {
    const path = realpathSync(codexBin);
    const file = statSync(path);
    identity = `${path}\n${file.size}\n${file.mtimeMs}\n${version}`;
  } catch {
    // A command found on PATH is checked under its own name.
  }
  let passed = remembered.get(identity);
  if (!passed) {
    passed = check();
    remembered.set(identity, passed);
    void passed.then((pass) => { if (!pass) remembered.delete(identity); });
  }
  return passed;
}

const signInChecks = new Map<string, Promise<boolean>>();
/**
 * The sign-in check above, made once for each Codex as it answers now.
 *
 * It is not kept for each owner home: how Codex rewrites a sign-in file is a
 * matter of the program, and the check gives it a made-up home with the file
 * store. Where one owner home keeps its sign-in is never remembered: Codex is
 * asked at every launch.
 */
export function codexKeepsLinkedSignIn(codexBin: string, env: NodeJS.ProcessEnv, version: string | null): Promise<boolean> {
  return oncePerCodex(signInChecks, codexBin, version, () => checkCodexKeepsLinkedSignIn(codexBin, env, dirname(codexAgentHomeDirectory(env))));
}

/**
 * Whether this Codex keeps a file that a launch's permission profile denies
 * from a command. Codex is started with a made-up home and a profile, given
 * as launch overrides the way a Read-only launch gives its own, that denies a
 * made-up file and a link to it. It is asked to run a command that reads the
 * file, one that reads it through the link, and one that reads a file beside
 * them. True only when the first two are refused and print nothing of the
 * file, and the third prints its file: a Codex that runs no command at all
 * does not pass. No conversation is started and no model is asked.
 *
 * What this shows is that the program honours a `deny` for a command. It does
 * not show that one conversation has the profile: each reply is held to that.
 * Codex's own tool that reads a picture without the shell can only be asked
 * for by a model, so it is not tried here; the installed-Codex tests try it.
 *
 * Like the sign-in check, the folder is made in `parent`, beside the agents'
 * home and never in a temp folder, it is looked at again just before Codex
 * starts, and it is removed on every path.
 */
export async function checkCodexHonoursDeny(codexBin: string, env: NodeJS.ProcessEnv, parent: string): Promise<boolean> {
  let scratch: string | null = null;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    scratch = mkdtempSync(join(parent, DENY_CHECK_FOLDER));
    const home = join(scratch, "home");
    const denied = join(scratch, "denied.txt");
    const open = join(scratch, "open.txt");
    const link = join(home, "linked.txt");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(denied, DENY_CHECK_DENIED, { mode: 0o600 });
    writeFileSync(open, DENY_CHECK_OPEN, { mode: 0o600 });
    linkFile(denied, link);
    const proxies = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"].map((key) => [key, NOWHERE]));
    const toRun = codexCheckEnvironment(env);
    // Exactly what was written above, and nothing else: no config, no rules, nothing unknown.
    if (entriesBelow(scratch).sort().join("\n") !== ["denied.txt", "home", "home/linked.txt", "open.txt"].join("\n")) return false;
    const folder = scratch;
    const profile = `${READ_ONLY_PROFILE_PREFIX}check`;
    const reads = (path: string) => process.platform === "win32" ? ["cmd.exe", "/d", "/c", "type", path] : ["/bin/cat", path];
    return await askCodexAppServer(codexBin, {
      cwd: folder,
      env: { ...toRun, HOME: folder, CODEX_HOME: home, TMPDIR: folder, ...windowsShadowProfile(folder), ...proxies },
      configOverrides: [
        ...CODEX_OWNER_FEATURE_OVERRIDES, `chatgpt_base_url="${NOWHERE}/"`, `openai_base_url="${NOWHERE}/v1"`,
        ...codexReadOnlyProfileOverrides(profile, [denied, link]),
      ],
      experimentalApi: true,
    }, async (request) => {
      const ran = async (path: string) => {
        const answer = await request("command/exec", { command: reads(path), cwd: folder, permissionProfile: profile }) as { exitCode?: unknown; stdout?: unknown } | null;
        return { ended: typeof answer?.exitCode === "number" ? answer.exitCode : null, printed: typeof answer?.stdout === "string" ? answer.stdout : null };
      };
      const refused = (command: Awaited<ReturnType<typeof ran>>) => command.ended !== null && command.ended !== 0 && command.printed !== null && !command.printed.includes(DENY_CHECK_DENIED);
      const atItsPath = await ran(denied);
      const throughTheLink = await ran(link);
      const beside = await ran(open);
      return refused(atItsPath) && refused(throughTheLink) && beside.ended === 0 && beside.printed === DENY_CHECK_OPEN;
    }, DENY_CHECK_TIMEOUT_MS);
  } catch {
    return false;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

const denyChecks = new Map<string, Promise<boolean>>();
/** The check above, made once for each Codex as it answers now. Only a pass is remembered. */
export function codexHonoursDeny(codexBin: string, env: NodeJS.ProcessEnv, version: string | null): Promise<boolean> {
  return oncePerCodex(denyChecks, codexBin, version, () => checkCodexHonoursDeny(codexBin, env, dirname(codexAgentHomeDirectory(env))));
}

export type CodexAgentHomeDependencies = {
  inspect(codexBin: string, options: { cwd: string; env: NodeJS.ProcessEnv; configOverrides: readonly string[] }): Promise<CodexSettingsInspection>;
  /** `version`: what Codex said it is when it answered for its settings. Null when it did not say. */
  keepsLinkedSignIn(codexBin: string, env: NodeJS.ProcessEnv, version: string | null): Promise<boolean>;
  /** Whether this Codex keeps a file its launch's permission profile denies from a command. Asked only for a Read-only launch. */
  honoursDeny(codexBin: string, env: NodeJS.ProcessEnv, version: string | null): Promise<boolean>;
  link(ownerHome: string, agentHome: string): { own: string[]; inPlaceOfOwners: string[] };
  /** The first entries of one folder: none means it holds nothing. It may name more than Codex reads, never less. */
  folderEntries(folder: string): string[];
};

const DEFAULT_DEPENDENCIES: CodexAgentHomeDependencies = {
  inspect: inspectCodexSettings,
  keepsLinkedSignIn: codexKeepsLinkedSignIn,
  honoursDeny: codexHonoursDeny,
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
 * which is how every conversation with a writable sandbox is started here.
 * A Read-only conversation names a profile of the launch's own, which extends
 * Codex's read-only one and so writes nowhere.
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
 * Why a Read-only launch is refused when Codex has not shown that it honours a `deny`. Said to the owner as it is.
 * The check cannot tell a Codex that is too old from one that is newer than LetAgents knows, so the line claims
 * neither and names what helps in each case.
 */
export const SIGN_IN_NOT_HIDDEN = "Read-only access keeps your Codex sign-in file from the agent's commands, and LetAgents could not confirm that this version of Codex does that: "
  + "it asked Codex to keep a made-up file from a command, and Codex did not show that it does. So LetAgents will not start Codex at this access level. "
  + "If Codex is not up to date, update it and start the agent again. If it is, update LetAgents, or choose another access level: at every other level the agent's commands can read that file.";

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
 *
 * For a Read-only launch, which names its permission profile, the answer also
 * holds the launch overrides that define the profile, with a `deny` for the
 * owner's sign-in file. They are given only once this Codex has shown, with a
 * made-up file, that it honours a `deny`. When it has not, the launch is
 * refused: it is never started the old way, without the profile.
 */
export async function codexHomeForSandboxedLaunch(
  codexBin: string,
  /**
   * `writableSandbox`: the access level's sandbox lets a command write the project.
   * `hideSignInProfile`: the launch is a Read-only agent's, and this is the name of its permission profile.
   */
  options: { cwd?: string; env: NodeJS.ProcessEnv; writableSandbox?: boolean; hideSignInProfile?: string },
  dependencies: Partial<CodexAgentHomeDependencies> = {},
): Promise<{ codexHome: string | null; notices: string[]; writableFoldersCheck?: CodexWritableFoldersCheck; configOverrides?: string[] }> {
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
  /** The home a launch runs with, and for a Read-only launch the profile that keeps the sign-in file from its commands. */
  const launchedWith = async <T extends { codexHome: string | null; notices: string[] }>(home: T): Promise<T & { configOverrides?: string[] }> => {
    if (!options.hideSignInProfile) return home;
    if (!await deps.honoursDeny(codexBin, options.env, inspection.userAgent ?? null)) throw new Error(SIGN_IN_NOT_HIDDEN);
    return { ...home, configOverrides: codexReadOnlyProfileOverrides(options.hideSignInProfile, codexSignInPaths(options.env, home.codexHome)) };
  };

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
      return launchedWith(checked({
        codexHome: agentHome,
        notices: linked.inPlaceOfOwners.length ? [
          `The folder LetAgents keeps for sandboxed Codex agents (${shownAgentHome(agentHome)}) holds entries of its own with the same names as entries of your Codex home: ${shown}`
          + `${linked.inPlaceOfOwners.length > 5 ? ` and ${linked.inPlaceOfOwners.length - 5} more` : ""}. `
          + "That happens when a sandboxed agent's Codex makes an entry before your Codex home has it, for example the first time after a Codex update adds one. "
          + (process.platform === "win32"
            ? "On Windows it also happens when a file of your Codex home is saved as a new file after an agent changed it, because that folder holds a second name of each of your files, not a link. "
            : "")
          + "Sandboxed agents use those, not yours, so they do not see what you or your own Codex later put in yours. "
          + "LetAgents never deletes them, because they can hold conversations; an empty one it replaces with a link to yours by itself. "
          + "To use your own again, stop the sandboxed Codex agents and delete those entries from that folder.",
        ] : [],
      }));
    }
  }
  if (!deps.folderEntries(join(ownerHome, "rules")).length) return launchedWith(checked({ codexHome: null, notices: [] }));
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
