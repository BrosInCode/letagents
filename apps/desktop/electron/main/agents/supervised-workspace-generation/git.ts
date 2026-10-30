/** Running git and other processes for the source authority and the private clone, git control files and file clones. */
import { spawn } from "node:child_process";
import { constants as fsConstants, mkdtempSync, readdirSync } from "node:fs";
import { copyFile, lstat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { assertOwnerPrivateSync, createPrivateDirSync, nullDevice, openNoFollow, ownerPrivatePlatform, protectOwnerPrivateSync, windowsSystemTool } from "../../../../../../shared/owner-private-fs.mjs";
import { letagentsHomePath } from "../../../../../../shared/letagents-home.mjs";
import { GIT_NOT_FOUND_MESSAGE, resolveGitExecutable } from "../../../../../../shared/git-executable.mjs";
import type { SourceGitAuthority } from "./types.js";
import { fileVersionKey, generationError, limitError } from "./helpers.js";

/** POSIX keeps /tmp. Windows has no /tmp: its per-user temporary folder stands in. */
export function gitTemporaryRoot(): string {
  return ownerPrivatePlatform() === "win32" ? tmpdir() : "/tmp";
}

/**
 * POSIX keeps /var/empty. Windows has no such folder (a bare "/var/empty" is
 * a folder at the root of the current drive, which any local user may make),
 * so an empty folder private to this account stands in: ~/.letagents/git-empty-home
 * when it is private and empty, else a new private folder in the temp folder.
 * A folder another account made first is never used.
 */
export function gitEmptyHome(): string {
  if (ownerPrivatePlatform() !== "win32") return "/var/empty";
  const home = letagentsHomePath("git-empty-home");
  try {
    createPrivateDirSync(home, { recursive: true });
    assertOwnerPrivateSync(home, { kind: "directory" });
    if (readdirSync(home).length === 0) return home;
  } catch { /* use a new folder below */ }
  const fresh = mkdtempSync(join(tmpdir(), "letagents-git-home-"));
  protectOwnerPrivateSync(fresh, "directory");
  return fresh;
}

/** POSIX keeps $HOME or /var/empty. Windows rarely sets HOME: the user's own profile keeps their global Git config. */
function sourceGitHome(): string {
  if (process.env.HOME) return process.env.HOME;
  return ownerPrivatePlatform() === "win32" ? homedir() : "/var/empty";
}

/**
 * The config file Git reads as empty. POSIX keeps /dev/null. Git for Windows
 * cannot open os.devNull (`\\.\nul`: "unable to access ... Invalid argument",
 * seen on windows-latest with Git 2.56), but it opens the DOS device name `nul`.
 * Git opens this name as given (it is not joined to a folder), and a bare
 * device name is the device on every Windows version.
 */
export function gitEmptyConfigPath(): string {
  return ownerPrivatePlatform() === "win32" ? "nul" : nullDevice();
}

/**
 * core.hooksPath for every command. POSIX keeps /dev/null. Windows has no
 * absolute path Git opens as the null device, and a relative value is joined
 * to the working tree (`<tree>\nul\post-index-change` is an ordinary path the
 * agent can create). So it names an existing FILE no user can write,
 * System32's icacls.exe: no hook can exist under a file. Not an empty
 * folder either: clone and remote run reference-transaction, and read-tree,
 * add and update-index run post-index-change.
 */
export function gitHooksPath(): string {
  return ownerPrivatePlatform() === "win32" ? windowsSystemTool("icacls.exe") : nullDevice();
}

/** Windows: the folders a Git child needs on PATH and the variables Windows itself needs. */
function windowsBaseEnvironment(): NodeJS.ProcessEnv {
  const system32 = win32.dirname(windowsSystemTool("icacls.exe"));
  const temporary = gitTemporaryRoot();
  return {
    PATH: [system32, win32.dirname(system32)].join(";"),
    SystemRoot: win32.dirname(system32),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  };
}

// Git honors a large ambient control surface (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, object alternates, injected config pairs, and helpers).
// Never inherit it into trusted generation/reconciliation commands.
export const GIT_ENV: NodeJS.ProcessEnv = ownerPrivatePlatform() === "win32"
  ? (() => {
    const emptyHome = gitEmptyHome();
    return {
      ...windowsBaseEnvironment(),
      HOME: emptyHome,
      XDG_CONFIG_HOME: emptyHome,
      GIT_CONFIG_GLOBAL: gitEmptyConfigPath(),
      GIT_CONFIG_SYSTEM: gitEmptyConfigPath(),
      GIT_CONFIG_NOSYSTEM: "1",
      // Git for Windows ships system attributes beside its system config.
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      // A partial clone (or a promisor remote the agent writes into its
      // clone's config) would otherwise fetch a missing object, running the
      // remote's transport.
      GIT_NO_LAZY_FETCH: "1",
      LC_ALL: "C",
    };
  })()
  : {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: gitTemporaryRoot(),
    HOME: gitEmptyHome(),
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_CONFIG_SYSTEM: nullDevice(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    LC_ALL: "C",
  };

// Source ignore decisions are user-owned repository semantics, so this narrow
// read-only environment deliberately retains the normal global/system Git
// config lookup. Ambient GIT_* injection is still discarded and gitArgs()
// disables hooks and fsmonitor before every invocation.
export function sourceGitEnvironment(): NodeJS.ProcessEnv {
  if (ownerPrivatePlatform() === "win32") {
    return {
      ...windowsBaseEnvironment(),
      HOME: sourceGitHome(),
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_PAGER: "cat",
      PAGER: "cat",
      LC_ALL: "C",
    };
  }
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: gitTemporaryRoot(),
    HOME: sourceGitHome(),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
  };
}

/**
 * The Git every command here runs: /usr/bin/git on macOS, and on Windows the
 * absolute git.exe the shared resolver finds (PATH, the registry's PATH, then
 * where Git for Windows installs). Never a .cmd or .bat: those run through a shell.
 */
export function gitExecutable(): string {
  if (ownerPrivatePlatform() !== "win32") return "/usr/bin/git";
  const git = resolveGitExecutable({ platform: "win32" });
  if (git === null) throw generationError(GIT_NOT_FOUND_MESSAGE, "GIT_EXECUTABLE_NOT_FOUND");
  return git;
}

export async function readStableGitControlFile(path: string): Promise<string> {
  const descriptor = await openNoFollow(path, fsConstants.O_RDONLY).catch((error) => {
    throw generationError(
      `A Git control file is unavailable or redirected: ${error instanceof Error ? error.message : String(error)}`,
      "REDIRECTED_GIT_ROOT",
    );
  });
  try {
    const before = await descriptor.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(16 * 1024)) {
      throw generationError("A Git control file is unavailable, redirected, or oversized.", "REDIRECTED_GIT_ROOT");
    }
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    if (fileVersionKey(after) !== fileVersionKey(before) || BigInt(bytes.length) !== after.size) {
      throw generationError("A Git control file changed during inspection.", "REDIRECTED_GIT_ROOT");
    }
    const decoded = bytes.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(bytes)) {
      throw generationError("A Git control file is not valid UTF-8.", "REDIRECTED_GIT_ROOT");
    }
    return decoded;
  } finally {
    await descriptor.close();
  }
}

export function gitControlPath(contents: string, prefix: string, base: string, malformedMessage: string): string {
  const match = /^(.*?)(?:\r?\n)?$/.exec(contents);
  const line = match?.[1];
  if (line === undefined || line.includes("\n") || line.includes("\r") || !line.startsWith(prefix)) {
    throw generationError(malformedMessage, "REDIRECTED_GIT_ROOT");
  }
  const value = line.slice(prefix.length);
  if (!value || value.includes("\0")) {
    throw generationError(malformedMessage, "REDIRECTED_GIT_ROOT");
  }
  return resolve(base, value);
}

export async function canonicalGitControlTarget(path: string, unavailableMessage: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw generationError(
      `${unavailableMessage} ${error instanceof Error ? error.message : String(error)}`,
      "REDIRECTED_GIT_ROOT",
    );
  }
}

export async function cloneRegularFile(source: string, destination: string, maxBytes: number): Promise<void> {
  if (ownerPrivatePlatform() === "win32") return copyWindowsRegularFile(source, destination, maxBytes);
  // BSD cp(1) -c is clonefile-only on macOS. A filesystem without clone support
  // returns a non-zero exit; deliberately do not retry as an ordinary copy.
  await runProcess("/bin/cp", ["-c", "-p", "-P", source, destination], dirname(destination), undefined, Math.min(maxBytes, 1024 * 1024), GIT_ENV);
}

/**
 * Windows has no clonefile, and its generation tree is a Git checkout, not a
 * copy. Only single journal artifacts (a changed file's stages, and the
 * workspace's dirty tracked files) are copied here, each within maxFileBytes.
 * CopyFileW follows links, so the source must be a regular file before and
 * after; it never replaces a destination (COPYFILE_EXCL, as cp's no-clobber
 * callers expect). The new file inherits its folder's DACL, not the source's.
 */
async function copyWindowsRegularFile(source: string, destination: string, maxBytes: number): Promise<void> {
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw generationError(`Refusing to copy a link or special file at ${JSON.stringify(source)}.`, "CLONE_ISOLATION_UNPROVEN");
  }
  if (before.size > BigInt(maxBytes)) throw limitError("file size", maxBytes);
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  const after = await lstat(source, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw generationError(`The copy source was replaced at ${JSON.stringify(source)}.`, "CLONE_ISOLATION_UNPROVEN");
  }
}

/**
 * A path Git printed. Git for Windows prints `C:/a/b`; every comparison here
 * is with Node's `C:\a\b`. POSIX output is returned as it is.
 */
export function gitOutputPath(text: string): string {
  if (ownerPrivatePlatform() !== "win32" || !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(text)) return text;
  return win32.normalize(text);
}

export async function discoverSourceGitText(cwd: string, args: string[]): Promise<string> {
  try {
    return await gitText(cwd, args);
  } catch (error) {
    throw generationError(
      `The selected workspace Git topology could not be resolved safely: ${error instanceof Error ? error.message : String(error)}`,
      "REDIRECTED_GIT_ROOT",
    );
  }
}

export async function gitText(cwd: string, args: string[], maxBytes = 1024 * 1024): Promise<string> {
  return (await gitBuffer(cwd, args, maxBytes)).toString("utf8").trim();
}

export async function gitBuffer(cwd: string, args: string[], maxBytes: number): Promise<Buffer> {
  return runProcess(gitExecutable(), gitArgs(args), cwd, undefined, maxBytes, GIT_ENV);
}

export async function sourceAuthorityBuffer(
  authority: SourceGitAuthority,
  args: string[],
  maxBytes: number,
  env = GIT_ENV,
): Promise<Buffer> {
  return gitAuthorityBuffer(authority.gitDirectory, authority.sourceRoot, args, maxBytes, {
    ...env,
    // --git-dir alone is insufficient for linked worktrees: Git otherwise
    // rereads the mutable per-worktree `commondir` control file on every call.
    GIT_COMMON_DIR: authority.gitCommonDirectory,
  });
}

export async function sourceAuthorityText(
  authority: SourceGitAuthority,
  args: string[],
  maxBytes = 1024 * 1024,
  env = GIT_ENV,
): Promise<string> {
  return (await sourceAuthorityBuffer(authority, args, maxBytes, env)).toString("utf8").trim();
}

export async function runGit(cwd: string, args: string[], maxBytes: number): Promise<void> {
  await gitBuffer(cwd, args, maxBytes);
}

export async function gitExitCode(cwd: string, args: string[]): Promise<number> {
  try { await gitBuffer(cwd, args, 1024 * 1024); return 0; } catch (error) {
    if (error instanceof ProcessExitError) return error.exitCode;
    throw error;
  }
}

export async function sourceAuthorityExitCode(authority: SourceGitAuthority, args: string[], env = GIT_ENV): Promise<number> {
  try { await sourceAuthorityBuffer(authority, args, 1024 * 1024, env); return 0; } catch (error) {
    if (error instanceof ProcessExitError) return error.exitCode;
    throw error;
  }
}

export function gitArgs(args: string[]): string[] {
  return [
    "-c", `core.hooksPath=${gitHooksPath()}`,
    "-c", "core.fsmonitor=false",
    // The physical namespace is authoritative for reconciliation. Do not let a
    // case-insensitive/precomposed index silently collapse a provider rename.
    "-c", "core.ignorecase=false",
    "-c", "core.precomposeunicode=false",
    // The generation folder adds about 60 characters to every path; Git for
    // Windows otherwise stops at MAX_PATH (260).
    ...(ownerPrivatePlatform() === "win32" ? ["-c", "core.longpaths=true"] : []),
    ...args,
  ];
}

export async function gitAuthorityText(
  gitDirectory: string,
  worktree: string | null,
  args: string[],
  maxBytes: number,
  env = GIT_ENV,
): Promise<string> {
  return (await gitAuthorityBuffer(gitDirectory, worktree, args, maxBytes, env)).toString("utf8").trim();
}

export async function gitAuthorityBuffer(
  gitDirectory: string,
  worktree: string | null,
  args: string[],
  maxBytes: number,
  env = GIT_ENV,
): Promise<Buffer> {
  const authorityArgs = [`--git-dir=${gitDirectory}`];
  if (worktree) authorityArgs.push(`--work-tree=${worktree}`);
  return runProcess(gitExecutable(), gitArgs([...authorityArgs, ...args]), worktree ?? dirname(gitDirectory), undefined, maxBytes, env);
}

export async function runGitWithAuthority(
  gitDirectory: string,
  worktree: string,
  args: string[],
  maxBytes: number,
  env = GIT_ENV,
): Promise<void> {
  await gitAuthorityBuffer(gitDirectory, worktree, args, maxBytes, env);
}

export class ProcessExitError extends Error {
  constructor(readonly exitCode: number, message: string) { super(message); }
}

export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  input: Buffer | undefined,
  maxBytes: number,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const windows = ownerPrivatePlatform() === "win32";
    const child = windows
      // An absolute git.exe still needs its own folder on PATH for the DLLs and helpers beside it.
      ? spawn(command, args, { cwd, env: { ...env, PATH: `${win32.dirname(command)};${env.PATH ?? ""}` }, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true })
      : spawn(command, args, { cwd, env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timeout = setTimeout(() => fail(generationError(`Git command timed out: ${args[0] ?? "command"}.`, "GIT_COMMAND_TIMEOUT")), 120_000);
    timeout.unref();
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return fail(limitError("Git output bytes", maxBytes));
      stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return fail(limitError("Git output bytes", maxBytes));
      stderr.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolvePromise(Buffer.concat(stdout));
      else reject(new ProcessExitError(code ?? -1, `${command} ${args[0] ?? "command"} failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    if (input) {
      child.stdin!.once("error", fail);
      child.stdin!.end(input);
    }
  });
}
