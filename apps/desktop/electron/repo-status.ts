import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type {
  DesktopGitRoomInfo,
  DesktopGitRoomRefType,
  RepoBranchDelta,
  DesktopRepoRoomSelection,
  RepoChangeSummary,
  RepoStatus,
  RepoWorktreeEntry,
} from "./ipc-types.js";
import { runGitStdout } from "./main/git-exec.js";
import { normalizeGitPath, sameLocalPath } from "./main/local-paths.js";

export type RepoStatusBuildOptions = {
  signal?: AbortSignal;
  /** Room opening needs repository identity before the watcher loads branch statistics. */
  includeBranchDeltas?: boolean;
  /** Project ownership checks must derive identity from Git, never repository config. */
  ignoreConfiguredRoom?: boolean;
  /**
   * Receives exactly what `git remote get-url origin` returned while the room
   * was derived (stdout, or the failure), so a caller can prove which origin
   * a decision was based on.
   */
  onOriginRemoteRead?: (read: { stdout: string } | { error: unknown }) => void;
};

/**
 * Git output already read during one build or refresh, keyed by folder and
 * arguments. One build asks several helpers for the same fact (the top level,
 * the branch list, origin HEAD); each command runs once and the others share
 * its result. It lives only as long as that one call.
 */
type GitReads = Map<string, Promise<string>>;

type RepoStatusCallOptions = RepoStatusBuildOptions & { gitReads?: GitReads };

function withGitReads(options: RepoStatusCallOptions): RepoStatusCallOptions {
  return options.gitReads ? options : { ...options, gitReads: new Map() };
}

function gitReadKey(cwd: string, args: readonly string[]): string {
  return [cwd, ...args].join("\0");
}

function throwIfAborted(options: RepoStatusBuildOptions): void {
  options.signal?.throwIfAborted();
}

async function runGit(
  cwd: string,
  args: string[],
  options: RepoStatusCallOptions,
): Promise<string> {
  throwIfAborted(options);
  const reads = options.gitReads;
  const key = gitReadKey(cwd, args);
  let read = reads?.get(key);
  if (!read) {
    read = runGitStdout(cwd, args, { signal: options.signal });
    reads?.set(key, read);
  }
  const stdout = await read;
  throwIfAborted(options);
  return stdout;
}

async function getRepoRoot(
  workspaceRoot: string,
  options: RepoStatusCallOptions,
): Promise<string | null> {
  try {
    const stdout = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"], options);
    const repoRoot = normalizeGitPath(stdout.trim()) || null;
    // The top level of a top level is itself: a later lookup from the root
    // (room routing does one) reuses this answer instead of starting Git.
    const rootKey = repoRoot ? gitReadKey(repoRoot, ["rev-parse", "--show-toplevel"]) : null;
    if (rootKey && !options.gitReads?.has(rootKey)) {
      options.gitReads?.set(rootKey, Promise.resolve(stdout));
    }
    return repoRoot;
  } catch (error) {
    throwIfAborted(options);
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 128 && /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point\b)/.test(failure.stderr || "")) {
      return null;
    }
    throw error;
  }
}

async function getGitHeadPath(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string | null> {
  try {
    // One run also finds the repository's info/attributes file, which the
    // branch shortstat cache watches (see `readDiffContext`).
    const stdout = await runGit(workspaceRoot, [
      "rev-parse",
      "--git-path",
      "HEAD",
      "--git-path",
      "info/attributes",
    ], options);
    const [headLine = "", attributesLine, ...extra] = stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    const attributesPath = attributesLine?.trim();
    if (attributesPath && extra.length === 0) {
      rememberInfoAttributesPath(workspaceRoot, resolve(workspaceRoot, attributesPath));
    }
    const headPath = headLine.trim();
    if (!headPath) return null;
    return resolve(workspaceRoot, headPath);
  } catch {
    throwIfAborted(options);
    return null;
  }
}

async function getCurrentBranch(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string | null> {
  try {
    const stdout = await runGit(workspaceRoot, ["branch", "--show-current"], options);
    const branch = stdout.trim();
    return branch || null;
  } catch {
    throwIfAborted(options);
    return null;
  }
}

async function getRebaseHeadBranch(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string | null> {
  for (const relativePath of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
    try {
      const stdout = await runGit(workspaceRoot, ["rev-parse", "--git-path", relativePath], options);
      const rebaseHeadPath = resolve(workspaceRoot, stdout.trim());
      if (!existsSync(rebaseHeadPath)) continue;
      const branch = readFileSync(rebaseHeadPath, "utf8")
        .trim()
        .replace(/^refs\/heads\//, "");
      if (branch) return branch;
    } catch {
      throwIfAborted(options);
      // Try the next rebase state path.
    }
  }
  return null;
}

async function getRoutingBranch(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string | null> {
  return (await getCurrentBranch(workspaceRoot, options))
    || await getRebaseHeadBranch(workspaceRoot, options);
}

/**
 * Local branch names with the commit each one points at, in Git's order.
 * `refname:short` gives the bare name only when that name is unambiguous, so a
 * name found here resolves to exactly this commit wherever Git reads it.
 */
async function getLocalBranchTips(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<Map<string, string>> {
  const tips = new Map<string, string>();
  try {
    const stdout = await runGit(workspaceRoot, [
      "for-each-ref",
      "--format=%(objectname) %(refname:short)",
      "refs/heads",
    ], options);
    for (const line of stdout.split(/\r?\n/)) {
      const separator = line.indexOf(" ");
      if (separator < 0) continue;
      const branch = line.slice(separator + 1).trim();
      if (branch) tips.set(branch, line.slice(0, separator).trim());
    }
  } catch {
    throwIfAborted(options);
  }
  return tips;
}

async function getLocalBranches(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string[]> {
  return [...(await getLocalBranchTips(workspaceRoot, options)).keys()];
}

function fallbackDefaultBranch(localBranches: string[]): string | null {
  for (const candidate of ["main", "master", "trunk", "develop"]) {
    if (localBranches.includes(candidate)) return candidate;
  }
  return null;
}

async function getRemoteDefaultBranch(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string | null> {
  try {
    const stdout = await runGit(workspaceRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ], options);
    return stdout.trim().replace(/^origin\//, "") || null;
  } catch {
    throwIfAborted(options);
    return null;
  }
}

export function parseGitWorktreePorcelain(
  stdout: string,
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): RepoWorktreeEntry[] {
  const lines = stdout.split(/\r?\n/);
  const entries: RepoWorktreeEntry[] = [];
  let current: Partial<RepoWorktreeEntry> | null = null;

  const pushCurrent = () => {
    if (current?.path && current.head) {
      entries.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head,
        isCurrent: sameLocalPath(current.path, workspaceRoot, platform),
        isMain: entries.length === 0,
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (!line.trim()) {
      pushCurrent();
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      pushCurrent();
      current = { path: normalizeGitPath(value, platform) };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    }
  }

  pushCurrent();

  return entries;
}

async function getWorktrees(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<RepoWorktreeEntry[]> {
  try {
    const stdout = await runGit(workspaceRoot, ["worktree", "list", "--porcelain"], options);
    return parseGitWorktreePorcelain(stdout, workspaceRoot);
  } catch {
    throwIfAborted(options);
    return [];
  }
}

/**
 * Resolve the stable repository root shared by every worktree of a repo.
 *
 * `git rev-parse --show-toplevel` returns the *current* worktree's root, so a
 * linked worktree (`git worktree add`) reports a different path than the main
 * checkout. Keying a local room off that path would split one repository into N
 * rooms. `--git-common-dir` points every worktree at the same `.git` directory,
 * whose parent is the main worktree root; we fall back to the worktree list's
 * main entry, then to the passed-in root for bare/unusual layouts.
 */
async function getMainWorktreeRoot(
  worktreeRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string> {
  try {
    const stdout = await runGit(worktreeRoot, ["rev-parse", "--git-common-dir"], options);
    const commonDir = stdout.trim();
    if (commonDir) {
      const absoluteCommonDir = resolve(worktreeRoot, commonDir);
      if (basename(absoluteCommonDir) === ".git") {
        return dirname(absoluteCommonDir);
      }
    }
  } catch {
    throwIfAborted(options);
    // Fall back to the worktree list below.
  }
  try {
    const stdout = await runGit(worktreeRoot, ["worktree", "list", "--porcelain"], options);
    const main = parseGitWorktreePorcelain(stdout, worktreeRoot).find((entry) => entry.isMain);
    if (main?.path) return resolve(main.path);
  } catch {
    throwIfAborted(options);
    // Fall back to the worktree root.
  }
  return resolve(worktreeRoot);
}

export type ParsedGitStatus = {
  head: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: RepoChangeSummary;
  dirty: boolean;
};

/**
 * Signals collected by the desktop repository watcher between refreshes.
 *
 * A working-tree or index change only needs `git status`. Ref, HEAD, and
 * worktree changes can also invalidate branch deltas and room routing. `full`
 * is reserved for the infrequent reconciliation pass (and watcher recovery).
 */
export type RepoStatusInvalidation = {
  status?: boolean;
  head?: boolean;
  refs?: boolean;
  worktrees?: boolean;
  static?: boolean;
  full?: boolean;
};

function emptyChangeSummary(): RepoChangeSummary {
  return {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  };
}

export function parseGitShortStat(
  stdout: string,
  baseBranch: string | null,
  branch: string | null = null,
): RepoBranchDelta {
  const text = stdout.trim();
  const filesMatch = /(\d+)\s+files?\s+changed/.exec(text);
  const insertionsMatch = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const deletionsMatch = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    branch,
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    additions: insertionsMatch ? Number(insertionsMatch[1]) : 0,
    deletions: deletionsMatch ? Number(deletionsMatch[1]) : 0,
    baseBranch,
  };
}

/**
 * Shortstat results that can be reused while nothing they depend on changed.
 *
 * `git diff --shortstat --merge-base A B`, run in a worktree, depends on:
 * 1. the two commits (the cache key holds both commit IDs);
 * 2. the effective Git configuration, for example `diff.renames` or a diff
 *    driver (the key holds a hash of `git var -l`, which prints the merged
 *    configuration of every scope and include);
 * 3. the attributes Git reads for each changed path. A diff of two commits
 *    reads them from the working tree's `.gitattributes` in the path's folder
 *    and every parent folder, from `$GIT_COMMON_DIR/info/attributes`, from the
 *    global file (`core.attributesFile`) and from the system file. It does
 *    not read them from the index or from either commit (checked with Git
 *    2.51: a `-diff` in the index only, or only in a commit's tree, does not
 *    change the result). The key holds the state of the last three files;
 *    each entry keeps the folders of its changed paths and the state of the
 *    `.gitattributes` in each, and is used only while those are unchanged.
 * When a source cannot be identified (Git older than 2.42 does not print the
 * attribute file paths), nothing is cached and every branch is measured.
 * Bounded; the least recently used entry goes first.
 */
type CachedBranchDelta = Pick<RepoBranchDelta, "filesChanged" | "additions" | "deletions"> & {
  attributeFolders: string[];
  attributeState: string;
};
const branchDeltaCacheLimit = 4096;
const branchDeltaCache = new Map<string, CachedBranchDelta>();
/** Shortstats run at most this many at a time. */
const branchDeltaConcurrency = 4;
/** Path lists of large branches; Node's default 1 MiB would fail them. */
const branchDeltaMaxBuffer = 64 * 1024 * 1024;
/** Where each repository root keeps info/attributes, learned during a build. */
const infoAttributesPaths = new Map<string, string>();

/** Test-only: forget every cached branch shortstat. */
export function clearBranchDeltaCacheForTest(): void {
  branchDeltaCache.clear();
}

function rememberInfoAttributesPath(repoRoot: string, path: string): void {
  infoAttributesPaths.set(resolve(repoRoot), path);
}

/** The diff inputs shared by every branch of one build or refresh. */
type DiffContext = {
  key: string;
  /** Memo of `.gitattributes` states read during this build. */
  attributeStates: Map<string, string>;
};

/** Identity of a file's contents without reading it: missing, or inode, size and times. */
function fileState(path: string, followLink: boolean): string {
  try {
    const info = followLink ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true });
    return [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  } catch {
    return "-";
  }
}

async function readGitVariables(
  repoRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string | null> {
  try {
    return await runGit(repoRoot, ["var", "-l"], options);
  } catch {
    throwIfAborted(options);
    return null;
  }
}

async function readInfoAttributesPath(
  repoRoot: string,
  options: RepoStatusBuildOptions,
): Promise<string | null> {
  const known = infoAttributesPaths.get(resolve(repoRoot));
  if (known) return known;
  try {
    const stdout = await runGit(repoRoot, ["rev-parse", "--git-path", "info/attributes"], options);
    const lines = stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    if (lines.length !== 1 || !lines[0]?.trim()) return null;
    const path = resolve(repoRoot, lines[0].trim());
    rememberInfoAttributesPath(repoRoot, path);
    return path;
  } catch {
    throwIfAborted(options);
    return null;
  }
}

function diffContextFrom(
  gitVariables: string | null,
  infoAttributesPath: string | null,
): DiffContext | null {
  if (gitVariables === null || !infoAttributesPath) return null;
  const lines = gitVariables.split(/\r?\n/)
    // The identities carry the current time; they do not affect a diff.
    .filter((line) => !/^GIT_(?:AUTHOR|COMMITTER)_IDENT=/.test(line));
  const systemAttributes = lines.find((line) => line.startsWith("GIT_ATTR_SYSTEM="))?.slice("GIT_ATTR_SYSTEM=".length);
  const globalAttributes = lines.find((line) => line.startsWith("GIT_ATTR_GLOBAL="))?.slice("GIT_ATTR_GLOBAL=".length);
  if (!systemAttributes || !globalAttributes) return null;
  const environment = Object.entries(process.env)
    .filter(([name]) => name.startsWith("GIT_"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value ?? ""}`);
  const key = createHash("sha256")
    .update(lines.join("\n"))
    .update("\0")
    .update(environment.join("\n"))
    .update("\0")
    .update([
      fileState(systemAttributes, true),
      fileState(globalAttributes, true),
      fileState(infoAttributesPath, true),
    ].join("|"))
    .digest("hex");
  return { key, attributeStates: new Map() };
}

/** Folders whose `.gitattributes` apply to these paths: each parent folder and the root. */
function attributeFoldersOf(paths: readonly string[]): string[] {
  const folders = new Set<string>([""]);
  for (const path of paths) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      folders.add(parts.slice(0, depth).join("/"));
    }
  }
  return [...folders].sort();
}

function attributeStateOf(workspaceRoot: string, folders: readonly string[], context: DiffContext): string {
  return folders.map((folder) => {
    let state = context.attributeStates.get(folder);
    if (state === undefined) {
      // Git does not follow a symbolic link named .gitattributes in the tree.
      state = fileState(join(workspaceRoot, folder, ".gitattributes"), false);
      context.attributeStates.set(folder, state);
    }
    return state;
  }).join("|");
}

/** File times can be coarse (one second on some file systems). */
const attributeClockSlackMs = 2_000;

function attributesChangedSince(workspaceRoot: string, folders: readonly string[], sinceNs: bigint): boolean {
  return folders.some((folder) => {
    try {
      const info = lstatSync(join(workspaceRoot, folder, ".gitattributes"), { bigint: true });
      return info.ctimeNs >= sinceNs || info.mtimeNs >= sinceNs;
    } catch {
      return false;
    }
  });
}

/**
 * Parse `git diff --numstat --shortstat -z`: NUL-terminated numstat records
 * (a rename has an empty path followed by the old and new paths), then the
 * shortstat line.
 */
export function parseGitNumstatShortStat(stdout: string): { shortStat: string; paths: string[] } {
  const fields = stdout.split("\0");
  const shortStat = fields.pop() ?? "";
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const match = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]*)$/.exec(fields[index] ?? "");
    if (!match) continue;
    if (match[1]) {
      paths.push(match[1]);
    } else {
      paths.push(fields[index + 1] ?? "", fields[index + 2] ?? "");
      index += 2;
    }
  }
  return { shortStat, paths: paths.filter(Boolean) };
}

async function getBranchDelta(
  workspaceRoot: string,
  branch: string | null,
  defaultBranch: string | null,
  branchTips: ReadonlyMap<string, string>,
  context: DiffContext | null,
  options: RepoStatusBuildOptions,
): Promise<RepoBranchDelta | null> {
  if (!branch || !defaultBranch) return null;
  if (branch === defaultBranch) {
    return { branch, filesChanged: 0, additions: 0, deletions: 0, baseBranch: defaultBranch };
  }
  const baseOid = branchTips.get(defaultBranch);
  const headOid = branchTips.get(branch);
  const cacheKey = context && baseOid && headOid
    ? [resolve(workspaceRoot), baseOid, headOid, context.key].join("\0")
    : null;
  const cached = cacheKey ? branchDeltaCache.get(cacheKey) : undefined;
  if (cacheKey && cached && context
    && attributeStateOf(workspaceRoot, cached.attributeFolders, context) === cached.attributeState) {
    branchDeltaCache.delete(cacheKey);
    branchDeltaCache.set(cacheKey, cached);
    return {
      branch,
      filesChanged: cached.filesChanged,
      additions: cached.additions,
      deletions: cached.deletions,
      baseBranch: defaultBranch,
    };
  }
  try {
    throwIfAborted(options);
    if (!cacheKey || !context || !baseOid || !headOid) {
      const stdout = await runGitStdout(workspaceRoot, [
        "--no-optional-locks",
        "diff",
        "--shortstat",
        "--merge-base",
        defaultBranch,
        branch,
        "--",
      ], { signal: options.signal });
      throwIfAborted(options);
      return parseGitShortStat(stdout, defaultBranch, branch);
    }
    // The diff names the commits of the cache key, so a branch that moves
    // meanwhile cannot store a later result under an earlier commit.
    const startedAtNs = BigInt(Date.now() - attributeClockSlackMs) * 1_000_000n;
    const stdout = await runGitStdout(workspaceRoot, [
      "--no-optional-locks",
      "diff",
      "--numstat",
      "--shortstat",
      "-z",
      "--merge-base",
      baseOid,
      headOid,
      "--",
    ], { signal: options.signal, maxBuffer: branchDeltaMaxBuffer });
    throwIfAborted(options);
    const { shortStat, paths } = parseGitNumstatShortStat(stdout);
    const delta = parseGitShortStat(shortStat, defaultBranch, branch);
    const attributeFolders = attributeFoldersOf(paths);
    // A .gitattributes written while Git ran may or may not be in this
    // result; keep the result but do not reuse it.
    if (attributesChangedSince(workspaceRoot, attributeFolders, startedAtNs)) return delta;
    branchDeltaCache.set(cacheKey, {
      filesChanged: delta.filesChanged,
      additions: delta.additions,
      deletions: delta.deletions,
      attributeFolders,
      attributeState: attributeStateOf(workspaceRoot, attributeFolders, context),
    });
    if (branchDeltaCache.size > branchDeltaCacheLimit) {
      const oldest = branchDeltaCache.keys().next().value;
      if (oldest !== undefined) branchDeltaCache.delete(oldest);
    }
    return delta;
  } catch {
    throwIfAborted(options);
    return null;
  }
}

async function getKnownBranchDeltas(
  workspaceRoot: string,
  branches: Array<string | null | undefined>,
  defaultBranch: string | null,
  branchTips: ReadonlyMap<string, string>,
  context: DiffContext | null,
  options: RepoStatusBuildOptions,
): Promise<RepoBranchDelta[]> {
  const uniqueBranches = [...new Set(branches.map((branch) => branch?.trim()).filter(Boolean) as string[])];
  const deltas: Array<RepoBranchDelta | null> = new Array(uniqueBranches.length).fill(null);
  let nextIndex = 0;
  const measureNext = async (): Promise<void> => {
    while (nextIndex < uniqueBranches.length) {
      const index = nextIndex;
      nextIndex += 1;
      throwIfAborted(options);
      deltas[index] = await getBranchDelta(
        workspaceRoot,
        uniqueBranches[index],
        defaultBranch,
        branchTips,
        context,
        options,
      );
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(branchDeltaConcurrency, uniqueBranches.length) },
    measureNext,
  ));
  return deltas.filter((delta): delta is RepoBranchDelta => Boolean(delta));
}

export function parseGitStatusPorcelainV2(stdout: string): ParsedGitStatus {
  const changes = emptyChangeSummary();
  let head: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice("# branch.oid ".length).trim();
      head = oid && oid !== "(initial)" ? oid : null;
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const name = line.slice("# branch.head ".length).trim();
      detached = name === "(detached)";
      branch = detached ? null : name || null;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = /^\# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        ahead = Number(match[1] || 0);
        behind = Number(match[2] || 0);
      }
      continue;
    }
    if (line.startsWith("? ")) {
      changes.untracked += 1;
      continue;
    }
    if (line.startsWith("u ")) {
      changes.conflicted += 1;
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const stagedState = line[2];
      const unstagedState = line[3];
      if (stagedState && stagedState !== ".") changes.staged += 1;
      if (unstagedState && unstagedState !== ".") changes.unstaged += 1;
    }
  }

  return {
    head,
    branch,
    detached,
    upstream,
    ahead,
    behind,
    changes,
    dirty: changes.staged > 0
      || changes.unstaged > 0
      || changes.untracked > 0
      || changes.conflicted > 0,
  };
}

async function getStatusPorcelain(
  workspaceRoot: string,
  options: RepoStatusBuildOptions,
): Promise<ParsedGitStatus> {
  try {
    const stdout = await runGit(workspaceRoot, [
      "--no-optional-locks",
      "status",
      "--porcelain=v2",
      "--branch",
    ], options);
    return parseGitStatusPorcelainV2(stdout);
  } catch {
    throwIfAborted(options);
    return {
      head: null,
      branch: await getCurrentBranch(workspaceRoot, options),
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: emptyChangeSummary(),
      dirty: false,
    };
  }
}

export async function buildRepoStatus(
  workspaceRoot: string,
  buildOptions: RepoStatusBuildOptions = {},
): Promise<RepoStatus> {
  const options = withGitReads(buildOptions);
  throwIfAborted(options);
  const repoRoot = await getRepoRoot(workspaceRoot, options);
  if (!repoRoot) {
    return {
      rootPath: workspaceRoot,
      mainRootPath: workspaceRoot,
      isGitRepo: false,
      gitHeadPath: null,
      head: null,
      branch: null,
      detached: false,
      defaultBranch: null,
      routingDefaultBranch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: emptyChangeSummary(),
      branchDelta: null,
      branchDeltas: [],
      dirty: false,
      roomIdentifier: null,
      roomSource: "local_folder",
      worktrees: [],
    };
  }

  const includeBranchDeltas = options.includeBranchDeltas !== false;
  const [worktrees, gitStatus, branchTips, headPath, resolvedRoom, gitVariables] = await Promise.all([
    getWorktrees(repoRoot, options),
    getStatusPorcelain(repoRoot, options),
    getLocalBranchTips(repoRoot, options),
    getGitHeadPath(repoRoot, options),
    resolveRoomIdentifierFromPath(repoRoot, options),
    includeBranchDeltas ? readGitVariables(repoRoot, options) : Promise.resolve(null),
  ]);
  const defaultBranch = resolvedRoom.routingDefaultBranch || fallbackDefaultBranch([...branchTips.keys()]);
  throwIfAborted(options);

  const branchDeltas = includeBranchDeltas
    ? await getKnownBranchDeltas(
      repoRoot,
      [defaultBranch, gitStatus.branch, ...worktrees.map((worktree) => worktree.branch)],
      defaultBranch,
      branchTips,
      diffContextFrom(gitVariables, await readInfoAttributesPath(repoRoot, options)),
      options,
    )
    : [];
  const branchDelta = branchDeltas.find((delta) => delta.branch === gitStatus.branch) ?? null;
  throwIfAborted(options);

  return {
    rootPath: repoRoot,
    mainRootPath: worktrees.find((worktree) => worktree.isMain)?.path ?? repoRoot,
    isGitRepo: true,
    gitHeadPath: headPath,
    head: gitStatus.head,
    branch: gitStatus.branch,
    detached: gitStatus.detached,
    defaultBranch,
    routingDefaultBranch: resolvedRoom.routingDefaultBranch,
    upstream: gitStatus.upstream,
    ahead: gitStatus.ahead,
    behind: gitStatus.behind,
    changes: gitStatus.changes,
    branchDelta,
    branchDeltas,
    dirty: gitStatus.dirty,
    roomIdentifier: resolvedRoom.roomIdentifier,
    roomSource: resolvedRoom.source,
    worktrees,
  };
}

/**
 * Refresh a cached repository snapshot according to filesystem evidence.
 *
 * The common path is deliberately one command (`git status --porcelain=v2`).
 * Static repository discovery, worktree enumeration, room routing, and branch
 * shortstats are reused until the watcher says their backing metadata changed.
 * If the cheap status read discovers a missed HEAD/ref event, it promotes the
 * refresh so correctness does not depend solely on filesystem notifications.
 */
export async function refreshRepoStatus(
  workspaceRoot: string,
  previous: RepoStatus,
  invalidation: RepoStatusInvalidation,
  refreshOptions: RepoStatusBuildOptions = {},
): Promise<RepoStatus> {
  const options = withGitReads(refreshOptions);
  throwIfAborted(options);
  if (invalidation.full || !previous.isGitRepo || !previous.rootPath) {
    return buildRepoStatus(workspaceRoot, options);
  }

  const repoRoot = previous.rootPath;
  const gitStatus = await getStatusPorcelain(repoRoot, options);
  const branchSelectionChanged = gitStatus.branch !== previous.branch
    || gitStatus.detached !== Boolean(previous.detached);
  const identityChanged = gitStatus.head !== (previous.head ?? null)
    || branchSelectionChanged
    || gitStatus.upstream !== (previous.upstream ?? null);
  const refsChanged = Boolean(invalidation.head || invalidation.refs || identityChanged);
  const worktreesChanged = Boolean(invalidation.worktrees || refsChanged);
  const staticFactsChanged = Boolean(invalidation.static);

  const refreshBranchDeltas = refsChanged || worktreesChanged;
  const [worktrees, branchTips, remoteDefaultBranch, gitVariables, infoAttributesPath] = await Promise.all([
    worktreesChanged ? getWorktrees(repoRoot, options) : Promise.resolve(previous.worktrees),
    // Branch tips and the diff context decide which shortstats are still current.
    refreshBranchDeltas
      ? getLocalBranchTips(repoRoot, options)
      : Promise.resolve(new Map<string, string>()),
    refsChanged ? getRemoteDefaultBranch(repoRoot, options) : Promise.resolve<string | null>(null),
    refreshBranchDeltas ? readGitVariables(repoRoot, options) : Promise.resolve(null),
    refreshBranchDeltas ? readInfoAttributesPath(repoRoot, options) : Promise.resolve(null),
  ]);
  const defaultBranch = refsChanged
    ? remoteDefaultBranch || fallbackDefaultBranch([...branchTips.keys()])
    : previous.defaultBranch ?? null;
  const routingChanged = staticFactsChanged
    || branchSelectionChanged
    || (refsChanged && remoteDefaultBranch !== (previous.routingDefaultBranch ?? null))
    || defaultBranch !== (previous.defaultBranch ?? null)
    || Boolean(invalidation.head && gitStatus.detached);
  const [branchDeltas, resolvedRoom] = await Promise.all([
    refreshBranchDeltas
      ? getKnownBranchDeltas(
        repoRoot,
        [defaultBranch, gitStatus.branch, ...worktrees.map((worktree) => worktree.branch)],
        defaultBranch,
        branchTips,
        diffContextFrom(gitVariables, infoAttributesPath),
        options,
      )
      : Promise.resolve(previous.branchDeltas ?? []),
    routingChanged
      ? resolveRoomIdentifierFromPath(repoRoot, options)
      : Promise.resolve(null),
  ]);
  const branchDelta = refreshBranchDeltas
    ? branchDeltas.find((delta) => delta.branch === gitStatus.branch) ?? null
    : previous.branchDelta ?? null;
  throwIfAborted(options);

  return {
    ...previous,
    mainRootPath: worktrees.find((worktree) => worktree.isMain)?.path
      ?? previous.mainRootPath
      ?? repoRoot,
    head: gitStatus.head,
    branch: gitStatus.branch,
    detached: gitStatus.detached,
    defaultBranch,
    routingDefaultBranch: resolvedRoom
      ? resolvedRoom.routingDefaultBranch
      : refsChanged
        ? remoteDefaultBranch
        : previous.routingDefaultBranch ?? null,
    upstream: gitStatus.upstream,
    ahead: gitStatus.ahead,
    behind: gitStatus.behind,
    changes: gitStatus.changes,
    branchDelta,
    branchDeltas,
    dirty: gitStatus.dirty,
    roomIdentifier: resolvedRoom?.roomIdentifier ?? previous.roomIdentifier ?? null,
    roomSource: resolvedRoom?.source ?? previous.roomSource ?? null,
    worktrees,
  };
}

/**
 * Hostnames that serve the same GitHub repositories as github.com:
 * ssh.github.com is GitHub's SSH-over-HTTPS endpoint (port 443) and
 * www.github.com is the same site as github.com. An SSH config alias such as
 * `git@github-work:acme/app.git` is not listed: its real host lives in
 * ~/.ssh/config, so it keeps the alias and the server refuses that room as an
 * unsupported provider.
 */
const GITHUB_HOST_ALIASES = new Set(["ssh.github.com", "www.github.com"]);

/**
 * Normalize the casing of a `host/owner/repo` room identifier derived from a git
 * remote. Hostnames are always case-insensitive, so they are safe to lowercase.
 * GitHub owner/repo names are also case-insensitive, so we lowercase the path for
 * github.com to keep two differently-cased clones in the same repo-level room
 * (branch rooms are already lowercased downstream). Other hosts may be
 * case-sensitive, so their path casing is preserved. The GitHub host aliases map
 * to github.com first, so a clone through them lands in its real room.
 */
function normalizeDerivedRoomIdentifierCasing(identifier: string): string {
  const trimmed = identifier.trim().replace(/\/+$/, "");
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) return trimmed.toLowerCase();
  const lowercaseHost = trimmed.slice(0, slashIndex).toLowerCase();
  const host = GITHUB_HOST_ALIASES.has(lowercaseHost) ? "github.com" : lowercaseHost;
  const rest = trimmed.slice(slashIndex + 1);
  return host === "github.com" ? `${host}/${rest.toLowerCase()}` : `${host}/${rest}`;
}

export function normalizeGitRemoteToRoomIdentifier(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;

  const sshMatch = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(value);
  if (sshMatch) {
    return normalizeDerivedRoomIdentifierCasing(
      `${sshMatch[1]}/${sshMatch[2]}`.replace(/\.git$/, ""),
    );
  }

  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return normalizeDerivedRoomIdentifierCasing(
      `${url.hostname}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, ""),
    );
  } catch {
    return null;
  }
}

function readConfiguredRoomIdentifierAt(repoRoot: string): string | null {
  try {
    const configPath = join(repoRoot, ".letagents.json");
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { room?: string };
    return parsed.room?.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveRoomIdentifier(
  workspaceRoot: string,
  options: RepoStatusBuildOptions = {},
): Promise<string | null> {
  return (await resolveWorkspaceRoom(workspaceRoot, options))?.roomIdentifier || null;
}

export async function resolveWorkspaceRoom(
  workspaceRoot: string,
  options: RepoStatusBuildOptions = {},
): Promise<{
  repoRoot: string;
  roomIdentifier: string;
  source: DesktopRepoRoomSelection["source"];
  gitRoom: DesktopGitRoomInfo | null;
} | null> {
  const resolved = await resolveRoomIdentifierFromPath(workspaceRoot, options);
  if (!resolved.repoRoot || resolved.source === "local_folder") return null;
  return {
    repoRoot: resolved.repoRoot,
    roomIdentifier: resolved.roomIdentifier,
    source: resolved.source,
    gitRoom: resolved.gitRoom,
  };
}

function slugifyLocalProjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "project";
}

function createLocalRoomIdentifier(projectPath: string): string {
  const normalizedPath = resolve(projectPath);
  const folderName = slugifyLocalProjectName(basename(normalizedPath));
  const pathHash = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 10);
  return `local-${folderName}-${pathHash}`;
}

function encodeRefForRoomId(refName: string): string {
  return Buffer.from(refName, "utf8").toString("base64url");
}

function repoRootKey(repoRoot: string): string {
  return createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 16);
}

function githubRepositoryFullNameFromRoom(repoRoom: string | null | undefined): string | null {
  const parts = repoRoom?.trim().replace(/\/+$/, "").split("/") || [];
  const [host, owner, repo] = parts;
  if (host?.toLowerCase() !== "github.com" || !owner || !repo || parts.length !== 3) {
    return null;
  }
  return `${owner}/${repo}`;
}

function isLikelyDefaultBranchName(branchName: string | null): boolean {
  return branchName === "main" || branchName === "master" || branchName === "trunk";
}

function shouldUseBranchRoom(input: {
  currentBranch: string | null;
  defaultBranch: string | null;
}): boolean {
  const currentBranch = input.currentBranch?.trim() || null;
  const defaultBranch = input.defaultBranch?.trim() || null;
  return Boolean(
    currentBranch && (
      defaultBranch
        ? currentBranch !== defaultBranch
        : !isLikelyDefaultBranchName(currentBranch)
    ),
  );
}

export function buildGitHubBranchRoomIdentifier(
  repoRoom: string | null,
  branchName: string | null,
): string | null {
  const repositoryFullName = githubRepositoryFullNameFromRoom(repoRoom);
  const refName = branchName?.trim();
  if (!repositoryFullName || !refName) return null;
  return `github.com/${repositoryFullName.toLowerCase()}/focus/git:branch:${encodeRefForRoomId(refName)}`;
}

export function activeGitHubRoomIdentifier(input: {
  repoRoom: string | null;
  currentBranch: string | null;
  defaultBranch: string | null;
}): string | null {
  if (!input.repoRoom) return null;
  return shouldUseBranchRoom(input)
    ? buildGitHubBranchRoomIdentifier(input.repoRoom, input.currentBranch)
    : input.repoRoom;
}

export function buildLocalGitRoomIdentifier(
  repoRoot: string,
  activeRef: string | null,
): string {
  const refName = activeRef?.trim();
  const suffix = refName
    ? `branch:${encodeRefForRoomId(refName)}`
    : "repo";
  return `git-room:local:${repoRootKey(repoRoot)}:${suffix}`;
}

export function buildLocalGitRoomInfo(input: {
  repoRoot: string;
  currentBranch: string | null;
  defaultBranch: string | null;
}): DesktopGitRoomInfo {
  const repoName = basename(resolve(input.repoRoot)) || "Repository";
  const branchName = input.currentBranch?.trim() || null;
  const defaultBranch = input.defaultBranch?.trim() || null;
  const refType: DesktopGitRoomRefType = branchName ? "branch" : "default_branch";
  return {
    provider: "git",
    host: "local",
    repository: {
      id: `local:${repoRootKey(input.repoRoot)}`,
      fullName: repoName,
      owner: "local",
      name: repoName,
    },
    ref: {
      type: refType,
      name: branchName,
      defaultBranch,
      baseRef: defaultBranch,
      headRef: branchName,
      headRepository: null,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: Boolean(
      branchName && (
        defaultBranch
          ? branchName === defaultBranch
          : isLikelyDefaultBranchName(branchName)
      ),
    ),
    source: "local_git",
  };
}

export async function resolveRoomIdentifierFromPath(
  folderPath: string,
  resolveOptions: RepoStatusBuildOptions = {},
): Promise<{
  repoRoot: string | null;
  roomIdentifier: string;
  source: DesktopRepoRoomSelection["source"];
  gitRoom: DesktopGitRoomInfo | null;
  warning: string | null;
  routingDefaultBranch: string | null;
}> {
  const options = withGitReads(resolveOptions);
  throwIfAborted(options);
  const repoRoot = await getRepoRoot(folderPath, options);

  if (!repoRoot) {
    return {
      repoRoot: null,
      roomIdentifier: createLocalRoomIdentifier(folderPath),
      source: "local_folder",
      gitRoom: null,
      warning: "This folder is not a Git repository. LetAgents opened a plain local folder room.",
      routingDefaultBranch: null,
    };
  }

  const [currentBranch, localBranches, routingDefaultBranch] = await Promise.all([
    getRoutingBranch(repoRoot, options),
    getLocalBranches(repoRoot, options),
    getRemoteDefaultBranch(repoRoot, options),
  ]);
  const defaultBranch = routingDefaultBranch || fallbackDefaultBranch(localBranches);
  throwIfAborted(options);

  const configured = options.ignoreConfiguredRoom
    ? null
    : readConfiguredRoomIdentifierAt(repoRoot);
  if (configured) {
    return {
      repoRoot,
      roomIdentifier: activeGitHubRoomIdentifier({
        repoRoom: configured,
        currentBranch,
        defaultBranch: routingDefaultBranch,
      }) || configured,
      source: "configured",
      gitRoom: null,
      warning: null,
      routingDefaultBranch,
    };
  }

  try {
    let stdout: string;
    try {
      stdout = await runGit(repoRoot, ["remote", "get-url", "origin"], options);
    } catch (error) {
      options.onOriginRemoteRead?.({ error });
      throw error;
    }
    options.onOriginRemoteRead?.({ stdout });
    const repoRoom = normalizeGitRemoteToRoomIdentifier(stdout);
    if (repoRoom) {
      return {
        repoRoot,
        roomIdentifier: activeGitHubRoomIdentifier({
          repoRoom,
          currentBranch,
          defaultBranch: routingDefaultBranch,
        }) || repoRoom,
        source: "git_remote",
        gitRoom: null,
        warning: null,
        routingDefaultBranch,
      };
    }
  } catch (error) {
    throwIfAborted(options);
    const failure = error as { code?: number; stderr?: string };
    if (failure.code !== 2 || failure.stderr?.trim() !== "error: No such remote 'origin'") {
      throw error;
    }
    // A repository without an origin still opens as a local Git room.
  }

  // Local-only repos are keyed by a hash of the repository root. Normalize to the
  // main worktree root so a linked worktree resolves to the same room as the main
  // checkout. The returned `repoRoot` stays the actually-opened worktree root.
  const identityRoot = await getMainWorktreeRoot(repoRoot, options);
  return {
    repoRoot,
    roomIdentifier: buildLocalGitRoomIdentifier(identityRoot, currentBranch),
    source: "local_git",
    gitRoom: buildLocalGitRoomInfo({ repoRoot: identityRoot, currentBranch, defaultBranch }),
    warning: null,
    routingDefaultBranch,
  };
}
