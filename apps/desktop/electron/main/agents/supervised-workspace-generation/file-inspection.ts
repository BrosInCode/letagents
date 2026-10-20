/** Exact file inspection, artifact checks and canonical directory identity during reconciliation. */
import type { BigIntStats } from "node:fs";
import { link, lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ExactFileState, type GenerationManifest, type ReconcileOperation, type RegularFileInfo, SupervisedWorkspaceConflictError, type TreeEntry } from "./types.js";
import { assertSafeAncestors } from "./manifest.js";
import { cloneRegularFile } from "./git.js";
import { fileVersionKey, fsyncDirectory, generationError, isErrno, pathExists, safeRelative, treeEntryEqual } from "./helpers.js";
import { macFileMetadataDigest, removeEmptyAncestors, treeEntryForRegularFile } from "./worktree.js";

/**
 * Bound expensive content/flags/ACL/xattr probes to one reconciliation call.
 * A cache hit still performs a fresh no-follow lstat and is valid only for the
 * same inode version, including nanosecond change times and link count. Crash
 * recovery and receipt cleanup create new sessions. Do not batch the textual
 * ls/xattr protocols across paths: valid Git filenames can spoof their record
 * separators.
 */
export class FileInspectionSession {
  private readonly cache = new Map<string, ExactFileState>();
  private readonly maxEntries: number;

  constructor(maxChangedPaths: number) {
    this.maxEntries = Math.min(100_000, Math.max(1, maxChangedPaths * 4));
  }

  async inspect(
    manifest: GenerationManifest,
    target: string,
    relativePathForError?: string,
  ): Promise<ExactFileState | null> {
    let before: BigIntStats;
    try { before = await lstat(target, { bigint: true }); }
    catch (error) { if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null; throw error; }
    const relativePath = relativePathForError ?? safeRelative(manifest.realWorkspace, target);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new SupervisedWorkspaceConflictError(relativePath, "the path is not a regular file");
    }
    const beforeKey = fileVersionKey(before);
    const cached = this.cache.get(beforeKey);
    if (cached) {
      // Keep recently used commit-edge evidence resident even when a large
      // plan has already inspected more distinct files than the hard bound.
      this.cache.delete(beforeKey);
      this.cache.set(beforeKey, cached);
      return cached;
    }
    const info: RegularFileInfo = {
      size: Number(before.size),
      mode: Number(before.mode),
      uid: Number(before.uid),
      gid: Number(before.gid),
    };
    if (!Number.isSafeInteger(info.size) || !Number.isSafeInteger(info.mode)
      || !Number.isSafeInteger(info.uid) || !Number.isSafeInteger(info.gid)) {
      throw generationError("File metadata exceeds the supported integer range.", "UNSUPPORTED_FILE_METADATA");
    }
    const [entry, metadataDigest] = await Promise.all([
      treeEntryForRegularFile(manifest, target, info, beforeKey, relativePath),
      macFileMetadataDigest(manifest, target, info),
    ]);
    const after = await lstat(target, { bigint: true }).catch((error) => {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return null;
      throw error;
    });
    if (!after || !after.isFile() || after.isSymbolicLink() || fileVersionKey(after) !== beforeKey) {
      throw new SupervisedWorkspaceConflictError(relativePath, "the file changed during exact inspection");
    }
    const state: ExactFileState = {
      entry,
      fullMode: info.mode & 0o7777,
      metadataDigest,
      dev: after.dev,
      ino: after.ino,
    };
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(beforeKey, state);
    return state;
  }
}

export async function inspectExactFile(
  manifest: GenerationManifest,
  target: string,
  relativePathForError: string | undefined,
  inspections: FileInspectionSession,
): Promise<ExactFileState | null> {
  return inspections.inspect(manifest, target, relativePathForError);
}

export function matchesOperationState(
  state: ExactFileState | null,
  entry: TreeEntry | null,
  fullMode: number | null,
  metadataDigest: string | null,
): boolean {
  if (!state || !entry) return !state && !entry;
  return treeEntryEqual(state.entry, entry)
    && state.fullMode === fullMode
    && state.metadataDigest === metadataDigest;
}

export async function ensureDesiredArtifact(
  manifest: GenerationManifest,
  operation: ReconcileOperation,
  target: string,
  inspections: FileInspectionSession,
): Promise<void> {
  const existing = await inspectExactFile(manifest, target, operation.relativePath, inspections);
  if (existing) {
    if (!matchesOperationState(existing, operation.desired, operation.desiredMode, operation.desiredMetadataDigest)
      || existing.dev !== (await lstat(manifest.realWorkspace, { bigint: true })).dev) {
      throw new SupervisedWorkspaceConflictError(operation.relativePath, `the journaled desired artifact is occupied at ${JSON.stringify(target)}`);
    }
    return;
  }
  const source = join(manifest.generationRoot, operation.stagingRelativePath!);
  await cloneRegularFile(source, target, manifest.limits.maxFileBytes);
  const sealed = await inspectExactFile(manifest, target, operation.relativePath, inspections);
  if (!matchesOperationState(sealed, operation.desired, operation.desiredMode, operation.desiredMetadataDigest)) {
    throw generationError(`The desired commit artifact could not be sealed for ${JSON.stringify(operation.relativePath)}.`, "INVALID_RECONCILIATION_STAGE");
  }
  await fsyncDirectory(dirname(target));
}

export async function restoreDisplacedWithoutOverwrite(
  manifest: GenerationManifest,
  operation: ReconcileOperation,
  target: string,
  displaced: string,
): Promise<void> {
  if (await pathExists(target)) return;
  try {
    await link(displaced, target);
    await fsyncDirectory(dirname(target));
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  // Preserve displaced evidence on conflict. It is intentionally not unlinked.
  await assertSafeAncestors(manifest.realWorkspace, operation.relativePath, false);
}

export async function validateAppliedOperationArtifacts(
  manifest: GenerationManifest,
  operation: ReconcileOperation,
  inspections: FileInspectionSession,
): Promise<void> {
  const target = join(manifest.realWorkspace, operation.relativePath);
  const parent = dirname(target);
  const desiredArtifact = operation.desiredArtifactRelativePath
    ? join(manifest.generationRoot, operation.desiredArtifactRelativePath) : null;
  const displacedArtifact = operation.displacedArtifactRelativePath
    ? join(manifest.generationRoot, operation.displacedArtifactRelativePath) : null;
  const installed = await inspectExactFile(manifest, target, undefined, inspections);
  if (!matchesOperationState(installed, operation.desired, operation.desiredMode, operation.desiredMetadataDigest)) {
    throw new SupervisedWorkspaceConflictError(operation.relativePath, "the installed result changed before its durable operation checkpoint");
  }
  if (operation.desired) {
    const desiredEvidence = desiredArtifact
      ? await inspectExactFile(manifest, desiredArtifact, operation.relativePath, inspections) : null;
    if (!matchesOperationState(desiredEvidence, operation.desired, operation.desiredMode, operation.desiredMetadataDigest)
      || desiredEvidence?.dev !== installed?.dev || desiredEvidence?.ino !== installed?.ino) {
      throw new SupervisedWorkspaceConflictError(operation.relativePath, "the installed result is detached from its exact journaled artifact");
    }
  }
  if (operation.baseline) {
    if (!displacedArtifact || !(await pathExists(displacedArtifact))) {
      throw new SupervisedWorkspaceConflictError(operation.relativePath, "exact displaced baseline evidence is missing");
    }
    const displaced = await inspectExactFile(manifest, displacedArtifact, operation.relativePath, inspections);
    if (!matchesOperationState(displaced, operation.baseline, operation.baselineMode, operation.baselineMetadataDigest)) {
      throw new SupervisedWorkspaceConflictError(operation.relativePath, `displaced concurrent evidence was retained at ${JSON.stringify(displacedArtifact)}`);
    }
  }
  if (operation.kind === "delete") await removeEmptyAncestors(parent, manifest.realWorkspace);
}

export type DirectoryIdentity = { canonical: string; dev: number; ino: number };

export async function canonicalDirectoryIdentity(parent: string, root: string, relativePath: string): Promise<DirectoryIdentity> {
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SupervisedWorkspaceConflictError(relativePath, "the target parent is not a real directory");
  const canonical = await realpath(parent);
  safeRelative(root, canonical);
  return { canonical, dev: info.dev, ino: info.ino };
}

export async function assertCanonicalDirectoryIdentity(parent: string, expected: DirectoryIdentity, root: string, relativePath: string): Promise<void> {
  const actual = await canonicalDirectoryIdentity(parent, root, relativePath);
  if (actual.canonical !== expected.canonical || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new SupervisedWorkspaceConflictError(relativePath, "the target parent was swapped during reconciliation");
  }
}
