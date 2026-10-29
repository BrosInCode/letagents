/**
 * Windows generations. There is no clonefile, so the provider's tree is a
 * detached `git worktree add` of a private shared bare clone in the
 * owner-private generation folder, never of the source repository: nothing in
 * the generation writes the source .git (it is read through alternates only).
 * The workspace's dirty tracked files are carried over one by one; untracked
 * files are not (the agent is told so). Snapshots in the supervisor authority
 * are raw bytes with every mode 100644, because Windows has no executable bit
 * and its Git converts line endings. Journal states, reconciliation, cleanup
 * and crash recovery are the shared ones.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, readdir, statfs, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isOwnerPrivate, openNoFollow, privateEntryCreated, windowsSystemTool } from "../../../../../../shared/owner-private-fs.mjs";
import { BASELINE_FILES_NAME, type GenerationManifest, PROVIDER_GIT_NAME, type RegularFileInfo, type SupervisedWorkspaceGenerationLimits, type SupervisedWorkspaceGenerationSupport } from "./types.js";
import { GIT_ENV, ProcessExitError, canonicalGitControlTarget, cloneRegularFile, gitArgs, gitAuthorityText, gitControlPath, gitExecutable, gitHooksPath, readStableGitControlFile, runGit, runGitWithAuthority, runProcess, sourceAuthorityBuffer, sourceAuthorityText, sourceGitEnvironment } from "./git.js";
import { assertSafeAncestors } from "./manifest.js";
import { assertSafeRelativePath, generationError, gitRelativePath, isErrno, limitError, splitNulBuffer } from "./helpers.js";
import { diffTreeEntries, snapshotWorktree } from "./worktree.js";

/** Shown to the agent on a turn that runs in a Windows generation. */
export const WINDOWS_FRESH_WORKTREE_NOTE = "fresh git worktree: untracked files not present";

/**
 * The supervisor authority's info/attributes (highest precedence): no line
 * ending, filter, ident or encoding conversion, so a tree entry's id is the
 * hash of the file's bytes, as treeEntryForRegularFile computes it.
 */
const RAW_SNAPSHOT_ATTRIBUTES = "* -text -eol -filter -ident -working-tree-encoding\n";

const WINDOWS_FREE_SPACE_RESERVE_BYTES = 64n * 1024n * 1024n;

/**
 * statfs, not df or diskutil: the checkout writes every file at HEAD, so the
 * volume needs HEAD's bytes plus a tenth and a fixed reserve.
 */
export async function assertWindowsFreeSpace(
  support: SupervisedWorkspaceGenerationSupport,
  generationParent: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<void> {
  const listing = await sourceAuthorityBuffer(support, ["ls-tree", "-r", "-l", "-z", "--full-tree", support.headOid], limits.maxPatchBytes);
  let treeBytes = 0n;
  for (const record of splitNulBuffer(listing)) {
    const header = record.subarray(0, record.indexOf(0x09)).toString("ascii");
    const size = /^\d{6} \w+ [a-f0-9]{40,64} +(\d+|-)$/.exec(header)?.[1];
    if (size === undefined) throw generationError("Git tree listing was malformed.", "INVALID_GIT_TREE");
    if (size !== "-") treeBytes += BigInt(size);
  }
  const space = await statfs(generationParent, { bigint: true });
  const available = space.bavail * space.bsize;
  const required = treeBytes + treeBytes / 10n + WINDOWS_FREE_SPACE_RESERVE_BYTES;
  if (available < required) {
    throw generationError(
      `The generation volume has ${available} bytes free; a Git worktree of this repository needs about ${required}.`,
      "GENERATION_DISK_SPACE_INSUFFICIENT",
    );
  }
}

/** The authority config that makes snapshots raw: see RAW_SNAPSHOT_ATTRIBUTES. */
export async function sealRawSnapshotAuthority(authorityRoot: string): Promise<void> {
  await runGit(authorityRoot, ["config", "--local", "core.filemode", "true"], 1024 * 1024);
  await runGit(authorityRoot, ["config", "--local", "core.autocrlf", "false"], 1024 * 1024);
  const info = join(authorityRoot, "info");
  await mkdir(info, { recursive: true });
  const attributes = join(info, "attributes");
  await writeFile(attributes, RAW_SNAPSHOT_ATTRIBUTES, { flag: "wx" });
  await privateEntryCreated(attributes, "file");
}

/**
 * The private clone the provider's worktree belongs to, and the worktree.
 * extensions.worktreeConfig holds core.bare=false for the worktree only (the
 * clone itself is bare). The source's own line-ending settings are copied so
 * the checkout writes the bytes the user's checkout has, and so the agent's
 * `git status` reads like the user's. Hooks stay off: hooksPath is the empty
 * private folder, checked empty right before the checkout.
 */
export async function prepareWindowsWorktree(
  support: SupervisedWorkspaceGenerationSupport,
  generationRoot: string,
  liveSourceRoot: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<string> {
  const providerGit = join(generationRoot, PROVIDER_GIT_NAME);
  const lineEndings = await sourceLineEndings(support);
  await runGit(support.sourceRoot, [
    "clone", "--shared", "--bare", "--no-hardlinks", "--", support.gitCommonDirectory, providerGit,
  ], limits.maxPatchBytes);
  for (const [key, value] of [
    ["core.hooksPath", gitHooksPath()],
    ["core.fsmonitor", "false"],
    ["gc.auto", "0"],
    ["extensions.worktreeConfig", "true"],
    ...lineEndings,
  ] as const) {
    await runGit(providerGit, ["config", "--local", key, value], 1024 * 1024);
  }
  await runGit(providerGit, ["remote", "remove", "origin"], 1024 * 1024);
  if ((await readdir(gitHooksPath())).length !== 0) {
    throw generationError("The private empty Git hooks folder is not empty.", "UNSAFE_GIT_HOOKS_PATH");
  }
  await runGit(providerGit, ["worktree", "add", "--detach", "--", liveSourceRoot, support.headOid], limits.maxPatchBytes);
  const administration = await worktreeAdministration(providerGit, liveSourceRoot);
  await runGitWithAuthority(administration, liveSourceRoot, ["config", "--worktree", "core.bare", "false"], 1024 * 1024);
  return providerGit;
}

/**
 * Both private clones borrow the repository's objects (alternates). A `git gc`
 * or a history rewrite there can remove objects a generation still needs.
 * Check, without walking history, that every object of the base commit and of
 * the given snapshot trees is present (and, for the provider's worktree, of
 * every commit the agent made on top), so a resume or an export fails closed
 * instead of reconciling from a partial tree.
 */
export async function assertGenerationObjectsComplete(
  authorityRoot: string,
  tips: readonly string[],
  limits: SupervisedWorkspaceGenerationLimits,
  provider?: { gitDirectory: string; liveSourceRoot: string; headOid: string },
): Promise<void> {
  const checks: Array<[string, string[]]> = [
    [authorityRoot, ["rev-list", "--objects", "--missing=error", "--quiet", "--no-walk", ...tips]],
  ];
  if (provider) {
    const administration = await worktreeAdministration(provider.gitDirectory, provider.liveSourceRoot);
    checks.push(
      [provider.gitDirectory, ["rev-list", "--objects", "--missing=error", "--quiet", "--no-walk", provider.headOid]],
      [administration, ["rev-list", "--objects", "--missing=error", "--quiet", "HEAD", "--not", provider.headOid]],
    );
  }
  for (const [gitDirectory, args] of checks) {
    try {
      await gitAuthorityText(gitDirectory, null, args, limits.maxPatchBytes);
    } catch (error) {
      if (!(error instanceof ProcessExitError)) throw error;
      throw generationError(
        `Git objects this generation borrows from the repository are missing (pruned by git gc or removed by a history rewrite); it cannot be resumed or reconciled. Retire or abandon it and start a fresh generation. ${error.message}`,
        "GENERATION_OBJECTS_MISSING",
      );
    }
  }
}

/** The worktree's own folder under the private clone, read from its .git file and checked. */
async function worktreeAdministration(providerGit: string, liveSourceRoot: string): Promise<string> {
  const target = gitControlPath(
    await readStableGitControlFile(join(liveSourceRoot, ".git")),
    "gitdir: ",
    liveSourceRoot,
    "The generation worktree's Git marker is malformed.",
  );
  const administration = await canonicalGitControlTarget(target, "The generation worktree's Git folder is unavailable.");
  if (administration !== join(providerGit, "worktrees", basename(administration))) {
    throw generationError("The generation worktree belongs to another repository.", "REDIRECTED_GIT_ROOT");
  }
  return administration;
}

async function sourceLineEndings(support: SupervisedWorkspaceGenerationSupport): Promise<Array<[string, string]>> {
  const allowed: Record<string, readonly string[]> = {
    "core.autocrlf": ["true", "false", "input"],
    "core.eol": ["lf", "crlf", "native"],
  };
  const result: Array<[string, string]> = [];
  for (const [key, values] of Object.entries(allowed)) {
    const value = await sourceAuthorityText(support, ["config", "--get", key], 1024, sourceGitEnvironment())
      .catch((error) => {
        if (error instanceof ProcessExitError && error.exitCode === 1) return "";
        throw error;
      });
    if (values.includes(value.toLowerCase())) result.push([key, value.toLowerCase()]);
  }
  return result;
}

/**
 * Make the worktree's tracked files the workspace's own bytes: every tracked
 * path whose raw bytes differ from the checkout (an edit, a staged file, a
 * deletion, or a file the user's Git converted differently) is copied or
 * removed, then the workspace's index is reproduced so the agent sees its
 * staged state. Returns the raw tree of the workspace's tracked files; the
 * caller's baseline snapshot of the worktree must equal it.
 */
export async function carryDirtyTrackedFiles(
  support: SupervisedWorkspaceGenerationSupport,
  authorityRoot: string,
  providerGit: string,
  liveSourceRoot: string,
  trackedPaths: readonly string[],
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<string> {
  const checkoutTree = await snapshotWorktree(authorityRoot, liveSourceRoot, join(authorityRoot, "letagents-checkout.index"), support.headOid, limits);
  const sourceIndex = join(authorityRoot, "letagents-source.index");
  await unlink(sourceIndex).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  const env = { ...GIT_ENV, GIT_INDEX_FILE: sourceIndex };
  await runGitWithAuthority(authorityRoot, support.sourceRoot, ["read-tree", support.headOid], limits.maxPatchBytes, env);
  const pathList = Buffer.concat(trackedPaths.map((path) => Buffer.from(`${gitRelativePath(path)}\0`)));
  await runProcessInAuthority(authorityRoot, support.sourceRoot, ["update-index", "--add", "--remove", "-z", "--stdin"], pathList, limits.maxPatchBytes, env);
  const sourceTree = await gitAuthorityText(authorityRoot, support.sourceRoot, ["write-tree"], limits.maxPatchBytes, env);
  if (!/^[a-f0-9]{40,64}$/.test(sourceTree)) throw generationError("Git returned an invalid snapshot tree id.", "INVALID_GIT_TREE");
  await unlink(sourceIndex);
  await unlink(join(authorityRoot, "letagents-checkout.index"));

  let copiedBytes = 0;
  for (const { sourceRelativePath, after } of await diffTreeEntries(authorityRoot, checkoutTree, sourceTree, limits)) {
    assertSafeRelativePath(sourceRelativePath, limits);
    const destination = join(liveSourceRoot, sourceRelativePath);
    await assertSafeAncestors(liveSourceRoot, sourceRelativePath, after !== null);
    await unlink(destination).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    if (!after) continue;
    await assertSafeAncestors(support.sourceRoot, sourceRelativePath, false);
    const source = join(support.sourceRoot, sourceRelativePath);
    const info = await lstat(source);
    copiedBytes += info.size;
    if (info.size > limits.maxFileBytes || copiedBytes > limits.maxTotalUntrackedBytes) {
      throw limitError("dirty tracked bytes", limits.maxTotalUntrackedBytes);
    }
    await mkdir(dirname(destination), { recursive: true });
    await cloneRegularFile(source, destination, limits.maxFileBytes);
  }
  const administration = await worktreeAdministration(providerGit, liveSourceRoot);
  await unlink(join(administration, "index"));
  await cloneRegularFile(support.gitIndexPath, join(administration, "index"), limits.maxFileBytes);
  return sourceTree;
}

async function runProcessInAuthority(
  authorityRoot: string,
  worktree: string,
  args: string[],
  input: Buffer,
  maxBytes: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await runProcess(gitExecutable(), gitArgs([`--git-dir=${authorityRoot}`, `--work-tree=${worktree}`, ...args]), worktree, input, maxBytes, env);
}

/** The mode Node reports for a Windows file without the read-only attribute. */
export const WINDOWS_DEFAULT_FILE_MODE = 0o666;

const BASELINE_MODES_NAME = "modes.json";

/**
 * Windows keeps no baseline copies, so the one piece of metadata Windows
 * reports (the read-only attribute, as mode 0o444) is recorded per tracked
 * file when the generation is made: a change during the turn still conflicts.
 * Only modes other than WINDOWS_DEFAULT_FILE_MODE are written.
 */
export async function recordWindowsBaselineModes(
  support: SupervisedWorkspaceGenerationSupport,
  baselineFilesRoot: string,
  trackedPaths: readonly string[],
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<void> {
  const modes: Record<string, number> = {};
  for (const relativePath of trackedPaths) {
    assertSafeRelativePath(relativePath, limits);
    const info = await lstat(join(support.sourceRoot, relativePath)).catch((error) => {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
      throw error;
    });
    if (info?.isFile() && (info.mode & 0o7777) !== WINDOWS_DEFAULT_FILE_MODE) modes[relativePath] = info.mode & 0o7777;
  }
  const path = join(baselineFilesRoot, BASELINE_MODES_NAME);
  await writeFile(path, `${JSON.stringify(modes)}\n`, { flag: "wx" });
  await privateEntryCreated(path, "file");
}

export async function readWindowsBaselineModes(manifest: GenerationManifest): Promise<Map<string, number>> {
  const path = join(manifest.generationRoot, BASELINE_FILES_NAME, BASELINE_MODES_NAME);
  const descriptor = await openNoFollow(path, fsConstants.O_RDONLY).catch((error) => {
    throw generationError(`Windows baseline metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`, "INVALID_BASELINE_METADATA");
  });
  let parsed: unknown;
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024 || !await isOwnerPrivate(path, info)) {
      throw generationError("Windows baseline metadata is not a bounded owner-private file.", "INVALID_BASELINE_METADATA");
    }
    parsed = JSON.parse(await descriptor.readFile("utf8"));
  } finally {
    await descriptor.close();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw generationError("Windows baseline metadata is malformed.", "INVALID_BASELINE_METADATA");
  }
  const result = new Map<string, number>();
  for (const [relativePath, mode] of Object.entries(parsed)) {
    if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777) {
      throw generationError("Windows baseline metadata is malformed.", "INVALID_BASELINE_METADATA");
    }
    result.set(relativePath, mode as number);
  }
  return result;
}

/**
 * Windows file metadata in the digest's framing: Node reports only the
 * read-only attribute (mode 0o444 or 0o666) and uid/gid 0. The DACL is left
 * out on purpose: generation files inherit the private folder's entries and
 * an installed file is reset to inherit the workspace's (see
 * inheritWorkspaceAcl), so the two never match by design.
 */
export function windowsFileMetadataDigest(info: RegularFileInfo): string {
  const digest = createHash("sha256");
  for (const field of [
    Buffer.from(String(info.mode & 0o7777)),
    Buffer.from(String(info.uid)),
    Buffer.from(String(info.gid)),
    Buffer.alloc(0),
    Buffer.alloc(0),
    Buffer.alloc(0),
  ]) {
    digest.update(String(field.length)).update("\0").update(field).update("\0");
  }
  return digest.digest("hex");
}

/**
 * A hard link shares one security descriptor, so a file installed from the
 * private journal would keep the generation's owner-only entries. Reset it to
 * the entries the workspace folder passes on, as a file made there gets.
 */
export async function inheritWorkspaceAcl(target: string): Promise<void> {
  await runProcess(windowsSystemTool("icacls.exe"), [target, "/reset", "/q"], dirname(target), undefined, 64 * 1024, GIT_ENV);
}
