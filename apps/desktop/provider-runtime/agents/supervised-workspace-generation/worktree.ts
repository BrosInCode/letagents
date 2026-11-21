/** Materializing and snapshotting worktrees, tree entries and diffs, and reading git blobs. */
import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openNoFollow } from "../../../../../../shared/owner-private-fs.mjs";
import { GIT_ENV, cloneRegularFile, gitAuthorityBuffer, gitAuthorityText, runGit, runGitWithAuthority, runProcess, sourceAuthorityBuffer, sourceGitEnvironment } from "./git.js";
import { type GenerationManifest, type RegularFileInfo, type SourceGitAuthority, SupervisedWorkspaceConflictError, type SupervisedWorkspaceGenerationLimits, type TreeEntry } from "./types.js";
import { assertSafeAncestors } from "./manifest.js";
import { assertSafeRelativePath, compareUtf8, decodeGitPath, fileVersionKey, fsyncDirectory, generationError, isErrno, limitError, safeRelative, splitNul, splitNulBuffer } from "./helpers.js";

export async function reproduceProviderIndex(sourceIndex: string, liveRoot: string, limits: SupervisedWorkspaceGenerationLimits): Promise<void> {
  // Deliberately copy only the index, never config.worktree: it may contain
  // executable filters, hooks, or includes. The generated status therefore
  // reflects physical file state and may be more conservative than a source
  // worktree whose local config suppresses mode changes.
  const sourceIndexInfo = await lstat(sourceIndex);
  if (!sourceIndexInfo.isFile() || sourceIndexInfo.isSymbolicLink()) {
    throw generationError("The source Git index is redirected or unavailable.", "UNSAFE_SOURCE_INDEX");
  }
  const destination = join(liveRoot, ".git", "index");
  await unlink(destination).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  await cloneRegularFile(sourceIndex, destination, limits.maxFileBytes);
}

export async function pinPrivateCloneHead(liveRoot: string, headOid: string, headRef: string | null): Promise<void> {
  if (headRef) {
    await runGit(liveRoot, ["update-ref", headRef, headOid], 1024 * 1024);
    await runGit(liveRoot, ["symbolic-ref", "HEAD", headRef], 1024 * 1024);
  } else {
    await runGit(liveRoot, ["update-ref", "--no-deref", "HEAD", headOid], 1024 * 1024);
  }
  await runGit(liveRoot, ["remote", "remove", "origin"], 1024 * 1024);
}

export async function sourceVisiblePaths(
  authority: SourceGitAuthority,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<{ tracked: string[]; untracked: string[] }> {
  // ls-files is the one source-Git operation that must retain ignore authority.
  // core.fsmonitor is overridden and no filters, hooks, pager, diff helper, or
  // shell command is consulted by these two read-only index queries.
  const tracked = splitNul(await sourceAuthorityBuffer(authority, ["ls-files", "--cached", "-z"], limits.maxPatchBytes, sourceGitEnvironment()));
  const untracked = splitNul(await sourceAuthorityBuffer(authority, ["ls-files", "--others", "--exclude-standard", "-z"], limits.maxPatchBytes, sourceGitEnvironment()));
  if (tracked.length + untracked.length > limits.maxChangedPaths) throw limitError("source path count", limits.maxChangedPaths);
  return { tracked, untracked };
}

export async function materializeSourceWorktree(
  authority: SourceGitAuthority,
  liveRoot: string,
  baselineFilesRoot: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<void> {
  const sourceRoot = authority.sourceRoot;
  const { tracked, untracked } = await sourceVisiblePaths(authority, limits);
  const untrackedSet = new Set(untracked);
  let totalUntrackedBytes = 0;
  for (const relativePath of [...new Set([...tracked, ...untracked])].sort(compareUtf8)) {
    assertSafeRelativePath(relativePath, limits);
    const source = join(sourceRoot, relativePath);
    const destination = join(liveRoot, relativePath);
    const baselineDestination = join(baselineFilesRoot, relativePath);
    await assertSafeAncestors(sourceRoot, relativePath, false);
    let info: Stats;
    try { info = await lstat(source); }
    catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) continue;
      throw error;
    }
    // File<->directory dirty topology is represented by the leaf paths Git
    // reports. Directories themselves need no copy; their children do.
    if (info.isDirectory() && !info.isSymbolicLink()) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw generationError(
        `${untrackedSet.has(relativePath) ? "Untracked" : "Tracked"} symlink or special file denied at ${JSON.stringify(relativePath)}.`,
        untrackedSet.has(relativePath) ? "UNTRACKED_SPECIAL_FILE_UNSUPPORTED" : "DIRTY_TRACKED_SPECIAL_FILE_UNSUPPORTED",
      );
    }
    if (untrackedSet.has(relativePath)) {
      totalUntrackedBytes += info.size;
      if (info.size > limits.maxFileBytes || totalUntrackedBytes > limits.maxTotalUntrackedBytes) {
        throw limitError("untracked bytes", limits.maxTotalUntrackedBytes);
      }
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await mkdir(dirname(baselineDestination), { recursive: true, mode: 0o700 });
    await cloneRegularFile(source, destination, Math.max(limits.maxFileBytes, info.size));
    await cloneRegularFile(source, baselineDestination, Math.max(limits.maxFileBytes, info.size));
    const sourceAfter = await lstat(source);
    const clone = await lstat(destination);
    const baselineClone = await lstat(baselineDestination);
    if (!sourceAfter.isFile() || sourceAfter.dev !== info.dev || sourceAfter.ino !== info.ino
      || sourceAfter.size !== info.size || sourceAfter.mtimeMs !== info.mtimeMs
      || !clone.isFile() || clone.ino === info.ino || clone.nlink !== 1 || clone.dev !== info.dev
      || !baselineClone.isFile() || baselineClone.ino === info.ino || baselineClone.ino === clone.ino
      || baselineClone.nlink !== 1 || baselineClone.dev !== info.dev) {
      throw generationError(`Clone isolation or source stability could not be proven for ${JSON.stringify(relativePath)}.`, "CLONE_ISOLATION_UNPROVEN");
    }
  }
  await fsyncDirectory(baselineFilesRoot);
}

export async function snapshotWorktree(
  gitDirectory: string,
  worktree: string,
  indexPath: string,
  seedTree: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<string> {
  await unlink(indexPath).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
  const env = { ...GIT_ENV, GIT_INDEX_FILE: indexPath };
  await runGitWithAuthority(gitDirectory, worktree, ["read-tree", seedTree], limits.maxPatchBytes, env);
  await runGitWithAuthority(gitDirectory, worktree, ["add", "-A", "--", "."], limits.maxPatchBytes, env);
  const tree = await gitAuthorityText(gitDirectory, worktree, ["write-tree"], limits.maxPatchBytes, env);
  if (!/^[a-f0-9]{40,64}$/.test(tree)) throw generationError("Git returned an invalid snapshot tree id.", "INVALID_GIT_TREE");
  return tree;
}

export async function diffTreeEntries(
  gitDirectory: string,
  baselineTreeOid: string,
  finalTreeOid: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<Array<{ sourceRelativePath: string; before: TreeEntry | null; after: TreeEntry | null }>> {
  const output = await gitAuthorityBuffer(
    gitDirectory,
    null,
    ["diff-tree", "-r", "--raw", "-z", "--no-renames", baselineTreeOid, finalTreeOid],
    limits.maxPatchBytes,
  );
  const records = splitNulBuffer(output);
  if (records.length % 2 !== 0) throw generationError("Git changed-tree output was malformed.", "INVALID_GIT_TREE");
  const result: Array<{ sourceRelativePath: string; before: TreeEntry | null; after: TreeEntry | null }> = [];
  for (let index = 0; index < records.length; index += 2) {
    const header = records[index]!.toString("ascii");
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([AMDT])$/.exec(header);
    if (!match) throw generationError("Git changed-tree header was malformed.", "INVALID_GIT_TREE");
    const sourceRelativePath = decodeGitPath(records[index + 1]!);
    assertSafeRelativePath(sourceRelativePath, limits);
    const before = rawTreeEntry(match[1]!, match[3]!, sourceRelativePath);
    const after = rawTreeEntry(match[2]!, match[4]!, sourceRelativePath);
    result.push({ sourceRelativePath, before, after });
    if (result.length > limits.maxChangedPaths) throw limitError("changed path count", limits.maxChangedPaths);
  }
  return result;
}

export async function assertTreeHasNoNormalizedPathCollisions(
  gitDirectory: string,
  treeOid: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<void> {
  const output = await gitAuthorityBuffer(
    gitDirectory,
    null,
    ["ls-tree", "-r", "--name-only", "-z", treeOid],
    limits.maxPatchBytes,
  );
  const paths = splitNul(output);
  if (paths.length > limits.maxChangedPaths) throw limitError("tree path count", limits.maxChangedPaths);
  const foldedPaths = new Map<string, string>();
  for (const relativePath of paths) {
    assertSafeRelativePath(relativePath, limits);
    const folded = relativePath.normalize("NFC").toLowerCase();
    const prior = foldedPaths.get(folded);
    if (prior && prior !== relativePath) {
      throw generationError(
        `Case- or Unicode-normalization-only path changes are not reconciled automatically (${JSON.stringify(prior)} and ${JSON.stringify(relativePath)}).`,
        "AMBIGUOUS_PATH_NORMALIZATION",
      );
    }
    foldedPaths.set(folded, relativePath);
  }
}

export function rawTreeEntry(mode: string, oid: string, relativePath: string): TreeEntry | null {
  if (mode === "000000") return null;
  if (mode !== "100644" && mode !== "100755") {
    throw generationError(`Symlink, gitlink, or unsupported tree entry denied at ${JSON.stringify(relativePath)}.`, "UNSUPPORTED_GIT_TREE_ENTRY");
  }
  if (/^0+$/.test(oid)) throw generationError("Git changed-tree entry has an invalid object id.", "INVALID_GIT_TREE");
  return { mode, oid };
}

export async function inspectRealEntry(manifest: GenerationManifest, relativePath: string): Promise<TreeEntry | null> {
  const target = join(manifest.realWorkspace, relativePath);
  let info: Stats;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SupervisedWorkspaceConflictError(relativePath, "the path is not a regular file");
  }
  return treeEntryForRegularFile(manifest, target, info);
}

export async function treeEntryForRegularFile(
  manifest: GenerationManifest,
  target: string,
  info: RegularFileInfo,
  expectedVersionKey?: string,
  relativePathForError?: string,
): Promise<TreeEntry> {
  if (info.size > manifest.limits.maxFileBytes) throw limitError("file size", manifest.limits.maxFileBytes);
  const relativePath = relativePathForError ?? safeRelative(manifest.realWorkspace, target);
  const descriptor = await openNoFollow(target, fsConstants.O_RDONLY);
  let oid: string;
  let executable = false;
  try {
    const before = await descriptor.stat({ bigint: true });
    const beforeKey = fileVersionKey(before);
    if (!before.isFile() || before.isSymbolicLink()
      || (expectedVersionKey !== undefined && beforeKey !== expectedVersionKey)
      || before.size > BigInt(manifest.limits.maxFileBytes)) {
      throw new SupervisedWorkspaceConflictError(relativePath, "the file changed before content hashing");
    }
    const size = Number(before.size);
    executable = (Number(before.mode) & 0o111) !== 0;
    const digest = createHash(manifest.headOid.length === 64 ? "sha256" : "sha1");
    digest.update(`blob ${size}\0`);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
    let position = 0;
    while (position < size) {
      const { bytesRead } = await descriptor.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead <= 0) {
        throw new SupervisedWorkspaceConflictError(relativePath, "the file ended during content hashing");
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await descriptor.stat({ bigint: true });
    if (fileVersionKey(after) !== beforeKey) {
      throw new SupervisedWorkspaceConflictError(relativePath, "the file changed during content hashing");
    }
    oid = digest.digest("hex");
  } finally {
    await descriptor.close();
  }
  return { mode: executable ? "100755" : "100644", oid };
}

export async function macFileMetadataDigest(
  manifest: GenerationManifest,
  target: string,
  info: RegularFileInfo,
): Promise<string> {
  const metadataLimit = Math.min(manifest.limits.maxPatchBytes, 16 * 1024 * 1024);
  const [flags, aclListing, xattrs] = await Promise.all([
    runProcess("/usr/bin/stat", ["-f", "%f", target], dirname(target), undefined, 1024, GIT_ENV),
    runProcess("/bin/ls", ["-lde", target], dirname(target), undefined, metadataLimit, GIT_ENV),
    runProcess("/usr/bin/xattr", ["-lx", target], dirname(target), undefined, metadataLimit, GIT_ENV),
  ]);
  const firstLineEnd = aclListing.indexOf(0x0a);
  const aclEntries = firstLineEnd < 0 ? Buffer.alloc(0) : aclListing.subarray(firstLineEnd + 1);
  const digest = createHash("sha256");
  for (const field of [
    Buffer.from(String(info.mode & 0o7777)),
    Buffer.from(String(info.uid)),
    Buffer.from(String(info.gid)),
    flags,
    aclEntries,
    xattrs,
  ]) {
    digest.update(String(field.length)).update("\0").update(field).update("\0");
  }
  return digest.digest("hex");
}

export async function removeEmptyAncestors(start: string, root: string): Promise<void> {
  let current = start;
  while (current !== root) {
    safeRelative(root, current);
    try {
      await rmdir(current);
      await fsyncDirectory(dirname(current));
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        current = dirname(current);
        continue;
      }
      if (isErrno(error, "ENOTEMPTY") || isErrno(error, "EEXIST")) return;
      throw error;
    }
    current = dirname(current);
  }
}

export async function readGitBlob(gitDirectory: string, oid: string, limits: SupervisedWorkspaceGenerationLimits): Promise<Buffer> {
  const sizeText = await gitAuthorityText(gitDirectory, null, ["cat-file", "-s", oid], 1024);
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) throw limitError("file size", limits.maxFileBytes);
  const content = await gitAuthorityBuffer(gitDirectory, null, ["cat-file", "blob", oid], size + 1);
  if (content.length !== size) throw generationError("Git blob length did not match its declared size.", "INVALID_GIT_BLOB");
  return content;
}
