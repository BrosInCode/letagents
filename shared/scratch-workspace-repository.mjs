import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Branch the empty repository starts on. It has no commits. */
export const SCRATCH_WORKSPACE_BRANCH = "main";

const STAGING = /^\.git\.([1-9][0-9]*)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
// Our own entries beside the repository stay out of an agent's `git add`.
const OWN_EXCLUDE = ["/.git.*.tmp", "/.git.replaced.*"];
const REPLACED = /^\.git\.replaced\.([0-9]+)\.[0-9a-f-]{36}$/;
let replacedCount = 0;
/** How many broken `.git` entries are kept aside for inspection. */
export const RETAINED_REPLACED_ENTRIES = 3;
// A symbolic ref, or a detached SHA-1 or SHA-256 object name.
const HEAD_CONTENT = /^(?:ref: refs\/\S+|[0-9a-f]{40}|[0-9a-f]{64})\n?$/;

async function kind(path) {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** The least Git and OpenCode need to take `.git` as a repository. */
async function isRepository(target) {
  if (await kind(target) !== "directory") return false;
  if (!(await kind(join(target, "HEAD")) === "file"
    && await kind(join(target, "config")) === "file"
    && await kind(join(target, "objects")) === "directory"
    && await kind(join(target, "refs")) === "directory")) return false;
  // Git refuses a directory whose HEAD it cannot read as a ref or an object name.
  const head = await readFile(join(target, "HEAD"), "utf8").catch(() => "");
  return HEAD_CONTENT.test(head);
}

/** Keeps only the newest few broken `.git` entries that were moved aside. */
async function pruneReplaced(workspace) {
  const replaced = (await readdir(workspace))
    .map((name) => ({ name, at: Number(REPLACED.exec(name)?.[1] ?? NaN) }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((left, right) => right.at - left.at || (left.name < right.name ? 1 : -1));
  for (const { name } of replaced.slice(RETAINED_REPLACED_ENTRIES)) {
    await rm(join(workspace, name), { recursive: true, force: true });
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** Removes staging directories left by a process that died mid-write. */
async function removeAbandonedStaging(workspace) {
  for (const name of await readdir(workspace)) {
    const match = STAGING.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || alive(pid)) continue;
    if (await kind(join(workspace, name)) === "directory") {
      await rm(join(workspace, name), { recursive: true, force: true });
    }
  }
}

async function build(workspace, exclude) {
  const staging = join(workspace, `.git.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staging, { mode: 0o700 });
  for (const directory of ["objects/info", "objects/pack", "refs/heads", "refs/tags", "info"]) {
    await mkdir(join(staging, directory), { recursive: true, mode: 0o700 });
  }
  const file = (path, content) => writeFile(join(staging, path), content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await file("HEAD", `ref: refs/heads/${SCRATCH_WORKSPACE_BRANCH}\n`);
  // Git records whether the file system ignores case, as `git init` does.
  const ignoreCase = await kind(join(staging, "head")) === "file";
  await file("config", [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    ...(ignoreCase ? ["\tignorecase = true"] : []),
    ...(process.platform === "darwin" ? ["\tprecomposeunicode = true"] : []),
    "",
  ].join("\n"));
  await file(join("info", "exclude"), [...OWN_EXCLUDE, ...exclude].map((line) => `${line}\n`).join(""));
  return staging;
}

/**
 * Makes a room's scratch workspace the root of its own empty Git repository.
 *
 * Agent tools treat the root of a Git repository as the edge of a project.
 * Without one, OpenCode 1.18.20 searches every directory from the workspace
 * up to the file system root and imports any plugin it finds there into the
 * process that holds the model provider's key. A repository in the workspace
 * stops that search at the workspace. It has to be the workspace itself: a
 * repository in the parent `room-only` directory would make every other
 * room's workspace part of the same project.
 *
 * The repository is written as files, without running Git. Nothing from the
 * owner's Git configuration, templates, hooks or `GIT_*` variables can reach
 * it, and a machine without Git still gets a workspace. It has no remote and
 * no commits, so nothing can be pushed from it unless an agent adds a remote
 * itself. `exclude` lines go into `.git/info/exclude`, which keeps the
 * daemon's own files out of `git add` and `git clean`.
 *
 * A `.git` that is a directory with `HEAD`, `config`, `objects` and `refs` is
 * left as it is when its HEAD names a ref or an object: it is a repository,
 * possibly one the agent made. Anything else at `.git` (a file, a link, an
 * empty or partial directory, an unreadable HEAD) would let Git and OpenCode
 * look above the workspace again, so it is moved aside to
 * `.git.replaced.<time>.<uuid>` and a repository takes its place; only the
 * newest few moved-aside entries are kept. The repository
 * is built beside the workspace's files and renamed into place, so a crash
 * or a second caller never leaves a half-written `.git`; a staging directory
 * left by a process that died is removed on the next call.
 *
 * @param {string} workspace Absolute path of an existing directory.
 * @param {{ exclude?: readonly string[] }} [options]
 * @returns {Promise<"created" | "present" | "replaced">}
 */
export async function ensureScratchWorkspaceRepository(workspace, options = {}) {
  const target = join(workspace, ".git");
  await removeAbandonedStaging(workspace);
  if (await isRepository(target)) return "present";
  let replaced = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staging = await build(workspace, options.exclude ?? []);
    try {
      if (await kind(target) !== null && !await isRepository(target)) {
        // Time, then a per-process count, so that order survives several in one millisecond.
        const order = Date.now() * 10_000 + (replacedCount++ % 10_000);
        await rename(target, join(workspace, `.git.replaced.${order}.${randomUUID()}`)).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        replaced = true;
      }
      try {
        await rename(staging, target);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error?.code)) throw error;
      }
      // Whoever won, only a verified repository counts.
      if (await isRepository(target)) {
        if (replaced) await pruneReplaced(workspace);
        const ours = await kind(staging) === null;
        return replaced ? "replaced" : ours ? "created" : "present";
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  throw new Error("The scratch workspace's .git could not be made a repository.");
}

const SYSTEM_GIT = "/usr/bin/git";

/** The first executable `git` on a `PATH`, as a shell would find it. */
async function resolveGit(path) {
  for (const directory of String(path ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, "git");
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

/**
 * Checks, with a launch's environment, that Git takes a scratch workspace as
 * a repository: `git -C <workspace> rev-parse --git-dir`, as OpenCode runs
 * it. Without that, OpenCode does not see the repository and the plugin
 * boundary is not in effect. On macOS, when the `git` found is Apple's
 * `/usr/bin/git` and `xcode-select -p` fails, the command line tools are
 * missing: that is reported without running Git, so the check itself never
 * brings up Apple's install prompt. Each command is bounded by `timeoutMs`.
 * Resolves to null when Git works, otherwise to what went wrong.
 *
 * @param {string} workspace
 * @param {Record<string, string | undefined>} environment
 * @param {{ timeoutMs?: number, platform?: string, xcodeSelect?: string }} [options]
 * @returns {Promise<string | null>}
 */
export async function probeScratchWorkspaceGit(workspace, environment, options = {}) {
  const { execFile } = await import("node:child_process");
  const timeout = options.timeoutMs ?? 2_000;
  const env = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME", "LANG", "LC_ALL", "TMPDIR"]) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  const run = (file, args) => new Promise((resolve) => {
    execFile(file, args, { env, timeout, maxBuffer: 16 * 1024 }, (error, stdout) => resolve({ error, stdout: String(stdout ?? "") }));
  });
  const git = await resolveGit(env.PATH);
  if (!git) return "no git on the launch's PATH";
  if ((options.platform ?? process.platform) === "darwin" && git === SYSTEM_GIT) {
    const tools = await run(options.xcodeSelect ?? "/usr/bin/xcode-select", ["-p"]);
    if (tools.error) return "the Xcode command line tools are not installed (xcode-select -p failed), so /usr/bin/git cannot run";
  }
  const result = await run(git, ["-C", workspace, "rev-parse", "--git-dir"]);
  if (result.error) return `git rev-parse --git-dir failed: ${String(result.error.message).split("\n")[0]}`;
  const gitDir = result.stdout.trim();
  if (gitDir !== ".git" && gitDir !== join(workspace, ".git")) return `git found its repository at ${gitDir}, not in the workspace`;
  return null;
}
