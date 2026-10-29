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
import { chmod, lstat, mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { isOwnerPrivate, openNoFollow, privateEntryCreated, windowsSystemTool } from "../../../../../../shared/owner-private-fs.mjs";
import { BASELINE_FILES_NAME, type GenerationManifest, PROVIDER_GIT_NAME, type RegularFileInfo, type SupervisedWorkspaceGenerationLimits, type SupervisedWorkspaceGenerationSupport } from "./types.js";
import { GIT_ENV, ProcessExitError, canonicalGitControlTarget, cloneRegularFile, gitArgs, gitAuthorityText, gitControlPath, gitExecutable, gitHooksPath, readStableGitControlFile, runGit, runGitWithAuthority, runProcess, sourceAuthorityBuffer, sourceAuthorityText, sourceGitEnvironment } from "./git.js";
import { assertSafeAncestors } from "./manifest.js";
import { assertSafeRelativePath, generationError, gitRelativePath, isErrno, limitError, splitNulBuffer } from "./helpers.js";
import { diffTreeEntries, removeEmptyAncestors, snapshotWorktree } from "./worktree.js";

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

/**
 * A partial clone lacks blobs that only its promisor remote can fetch, and
 * the private clones have no such remote (and lazy fetches are off). Refuse
 * it before anything is made, instead of failing in the checkout.
 */
export async function assertWindowsFullClone(support: SupervisedWorkspaceGenerationSupport): Promise<void> {
  const partialClone = await sourceAuthorityText(support, ["config", "--get", "extensions.partialClone"], 1024)
    .catch((error) => {
      if (error instanceof ProcessExitError && error.exitCode === 1) return "";
      throw error;
    });
  if (partialClone) {
    throw generationError("Partial clones (a promisor remote) are not supported by Windows workspace generations.", "PARTIAL_CLONE_UNSUPPORTED");
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
 * `git status` reads like the user's. Hooks stay off (hooksPath `nul`).
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
    // The agent's own Git: the generation folder lengthens every path.
    ["core.longpaths", "true"],
    ...lineEndings,
  ] as const) {
    await runGit(providerGit, ["config", "--local", key, value], 1024 * 1024);
  }
  await runGit(providerGit, ["remote", "remove", "origin"], 1024 * 1024);
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
  const checks: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [
    { args: ["rev-list", "--objects", "--missing=error", "--quiet", "--no-walk", ...tips], env: GIT_ENV },
  ];
  if (provider) {
    // Only the agent's HEAD is read through its own clone. Its commits are
    // checked from the supervisor authority, with the clone's objects as an
    // extra alternate, so no other part of the agent-written config is used.
    const administration = await worktreeAdministration(provider.gitDirectory, provider.liveSourceRoot);
    const agentHead = await gitAuthorityText(administration, null, ["rev-parse", "--verify", "HEAD^{commit}"], 1024)
      .catch((error) => { throw missingObjects(error); });
    if (!/^[a-f0-9]{40,64}$/.test(agentHead)) throw generationError("Git returned an invalid commit id.", "INVALID_GIT_TREE");
    checks.push({
      args: ["rev-list", "--objects", "--missing=error", "--quiet", agentHead, "--not", provider.headOid],
      env: { ...GIT_ENV, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(provider.gitDirectory, "objects") },
    });
  }
  for (const { args, env } of checks) {
    await gitAuthorityText(authorityRoot, null, args, limits.maxPatchBytes, env).catch((error) => { throw missingObjects(error); });
  }
}

function missingObjects(error: unknown): unknown {
  if (!(error instanceof ProcessExitError)) return error;
  return generationError(
    `Git objects this generation borrows from the repository are missing (pruned by git gc or removed by a history rewrite); it cannot be resumed or reconciled. Retire or abandon it and start a fresh generation. ${error.message}`,
    "GENERATION_OBJECTS_MISSING",
  );
}

/**
 * Windows keeps one read-only attribute per file, shared by its hard links.
 * Deleting the journal's link to an installed read-only file would clear the
 * attribute on the user's file too (Node clears it to delete), so each such
 * link is removed here first and the attribute is set again.
 */
export async function releaseReadOnlyInstalls(manifest: GenerationManifest): Promise<void> {
  for (const operation of manifest.operationJournal) {
    if (operation.status !== "applied" || !operation.desiredArtifactRelativePath
      || operation.desiredMode === null || (operation.desiredMode & 0o222) !== 0) continue;
    const artifact = join(manifest.generationRoot, operation.desiredArtifactRelativePath);
    const target = join(manifest.realWorkspace, operation.relativePath);
    const [artifactInfo, targetInfo] = await Promise.all([
      lstat(artifact, { bigint: true }).catch(() => null),
      lstat(target, { bigint: true }).catch(() => null),
    ]);
    if (!artifactInfo || !targetInfo || artifactInfo.dev !== targetInfo.dev || artifactInfo.ino !== targetInfo.ino) continue;
    // The file's attribute now, which the user may have changed since.
    const mode = Number(targetInfo.mode) & 0o7777;
    await chmod(artifact, mode | 0o222);
    await unlink(artifact);
    await chmod(target, mode);
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
 * Make the worktree's tracked files the workspace's own: every tracked path
 * whose raw bytes differ from the checkout (an edit, a staged or unstaged
 * deletion, a rename, a staged file/folder replacement, or a file the user's
 * Git converted differently) is removed or copied, deletions first. A tracked
 * folder replaced by a file but not staged is refused, as on macOS.
 * The source side is built from an EMPTY index holding only the tracked
 * paths that are regular files now, so a deleted path cannot survive from
 * HEAD. Then the read-only attributes are reproduced, and the workspace's
 * index, so the agent sees its staged state. Returns the raw tree of the
 * workspace's tracked files; the caller's baseline snapshot must equal it.
 */
export async function carryDirtyTrackedFiles(
  support: SupervisedWorkspaceGenerationSupport,
  authorityRoot: string,
  providerGit: string,
  liveSourceRoot: string,
  trackedPaths: readonly string[],
  baselineModes: ReadonlyMap<string, number>,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<string> {
  const checkoutIndex = join(authorityRoot, "letagents-checkout.index");
  const checkoutTree = await snapshotWorktree(authorityRoot, liveSourceRoot, checkoutIndex, support.headOid, limits);
  await unlink(checkoutIndex);
  const presentPaths: string[] = [];
  for (const relativePath of trackedPaths) {
    assertSafeRelativePath(relativePath, limits);
    await assertSafeAncestors(support.sourceRoot, relativePath, false);
    const info = await lstat(join(support.sourceRoot, relativePath)).catch((error) => {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
      throw error;
    });
    if (info?.isFile()) presentPaths.push(relativePath);
  }
  const sourceIndex = join(authorityRoot, "letagents-source.index");
  await unlink(sourceIndex).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  const env = { ...GIT_ENV, GIT_INDEX_FILE: sourceIndex };
  const pathList = Buffer.concat(presentPaths.map((path) => Buffer.from(`${gitRelativePath(path)}\0`)));
  await runProcessInAuthority(authorityRoot, support.sourceRoot, ["update-index", "--add", "-z", "--stdin"], pathList, limits.maxPatchBytes, env);
  const sourceTree = await gitAuthorityText(authorityRoot, support.sourceRoot, ["write-tree"], limits.maxPatchBytes, env);
  if (!/^[a-f0-9]{40,64}$/.test(sourceTree)) throw generationError("Git returned an invalid snapshot tree id.", "INVALID_GIT_TREE");
  await unlink(sourceIndex);

  const changes = await diffTreeEntries(authorityRoot, checkoutTree, sourceTree, limits);
  const deletions = changes.filter((change) => change.after === null)
    .sort((a, b) => b.sourceRelativePath.split(sep).length - a.sourceRelativePath.split(sep).length);
  for (const { sourceRelativePath } of deletions) {
    assertSafeRelativePath(sourceRelativePath, limits);
    await assertSafeAncestors(liveSourceRoot, sourceRelativePath, false);
    const destination = join(liveSourceRoot, sourceRelativePath);
    await unlink(destination).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    await removeEmptyAncestors(dirname(destination), liveSourceRoot);
  }
  let copiedBytes = 0;
  for (const { sourceRelativePath } of changes.filter((change) => change.after !== null)) {
    assertSafeRelativePath(sourceRelativePath, limits);
    await assertSafeAncestors(support.sourceRoot, sourceRelativePath, false);
    await assertSafeAncestors(liveSourceRoot, sourceRelativePath, true);
    const source = join(support.sourceRoot, sourceRelativePath);
    const destination = join(liveSourceRoot, sourceRelativePath);
    const info = await lstat(source);
    copiedBytes += info.size;
    if (info.size > limits.maxFileBytes || copiedBytes > limits.maxTotalUntrackedBytes) {
      throw limitError("dirty tracked bytes", limits.maxTotalUntrackedBytes);
    }
    await unlink(destination).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    await cloneRegularFile(source, destination, limits.maxFileBytes);
  }
  // A clean read-only file is not copied, so the checkout made it writable.
  for (const [relativePath, mode] of baselineModes) {
    const destination = join(liveSourceRoot, relativePath);
    if ((await lstat(destination).catch(() => null))?.isFile()) await chmod(destination, mode);
  }
  const administration = await worktreeAdministration(providerGit, liveSourceRoot);
  await unlink(join(administration, "index"));
  await cloneRegularFile(support.gitIndexPath, join(administration, "index"), limits.maxFileBytes);
  return sourceTree;
}

/** Which of these Git-form paths (a folder ends in "/") the worktree's ignore rules exclude. */
export async function ignoredGitPaths(
  authorityRoot: string,
  worktree: string,
  paths: readonly string[],
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const input = Buffer.concat(paths.map((path) => Buffer.from(`${path}\0`)));
  try {
    const output = await runProcess(gitExecutable(), gitArgs([
      `--git-dir=${authorityRoot}`, `--work-tree=${worktree}`, "check-ignore", "--no-index", "-z", "--stdin",
    ]), worktree, input, limits.maxPatchBytes, GIT_ENV);
    return new Set(splitNulBuffer(output).map((value) => value.toString("utf8")));
  } catch (error) {
    // check-ignore exits 1 when no path is ignored.
    if (error instanceof ProcessExitError && error.exitCode === 1) return new Set();
    throw error;
  }
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
): Promise<Map<string, number>> {
  const modes = new Map<string, number>();
  for (const relativePath of trackedPaths) {
    assertSafeRelativePath(relativePath, limits);
    const info = await lstat(join(support.sourceRoot, relativePath)).catch((error) => {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
      throw error;
    });
    if (info?.isFile() && (info.mode & 0o7777) !== WINDOWS_DEFAULT_FILE_MODE) modes.set(relativePath, info.mode & 0o7777);
  }
  // An array of pairs: a path such as "__proto__" is never an object key here.
  const path = join(baselineFilesRoot, BASELINE_MODES_NAME);
  await writeFile(path, `${JSON.stringify([...modes])}\n`, { flag: "wx" });
  await privateEntryCreated(path, "file");
  return modes;
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
  if (!Array.isArray(parsed)) throw generationError("Windows baseline metadata is malformed.", "INVALID_BASELINE_METADATA");
  const result = new Map<string, number>();
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"
      || !Number.isInteger(entry[1]) || entry[1] < 0 || entry[1] > 0o7777) {
      throw generationError("Windows baseline metadata is malformed.", "INVALID_BASELINE_METADATA");
    }
    result.set(entry[0], entry[1]);
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
