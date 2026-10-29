/** Retiring a generation and reconciling it back into the source: plan, stages and applying operations. */
import type { Stats } from "node:fs";
import { link, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { AUTHORITY_NAME, BASELINE_FILES_NAME, FINAL_INDEX_NAME, type GenerationManifest, RETIRED_NAME, type ReconcileOperation, STAGING_NAME, SupervisedWorkspaceConflictError, type SupervisedWorkspaceGenerationFailpointHandler, type SupervisedWorkspaceGenerationLimits, type SupervisedWorkspaceGenerationResult, type TreeEntry } from "./types.js";
import { FileInspectionSession, assertCanonicalDirectoryIdentity, canonicalDirectoryIdentity, ensureDesiredArtifact, inspectExactFile, matchesOperationState, restoreDisplacedWithoutOverwrite, validateAppliedOperationArtifacts } from "./file-inspection.js";
import { assertNoShortNameAncestors, assertSafeAncestors, cleanupTrees, transition, validateManifest } from "./manifest.js";
import { assertSafeRelativePath, compareUtf8, fsyncDirectory, generationError, gitRelativePath, invokeFailpoint, isErrno, isProtectedPath, isWindowsGeneration, limitError, manifestPathOf, operationId, pathExists, projectRelativePath, resultFor, safeRelative, splitNul, treeEntryEqual } from "./helpers.js";
import { assertTreeHasNoNormalizedPathCollisions, diffTreeEntries, readGitBlob, snapshotWorktree, treeEntryForRegularFile } from "./worktree.js";
import { assertTrustedAuthority } from "./source-authority.js";
import { cloneRegularFile, gitAuthorityBuffer } from "./git.js";
import { WINDOWS_DEFAULT_FILE_MODE, assertGenerationObjectsComplete, ignoredGitPaths, inheritWorkspaceAcl, readWindowsBaselineModes, windowsFileMetadataDigest } from "./worktree-windows.js";

export async function retireAndReconcile(
  initial: GenerationManifest,
  failpoint?: SupervisedWorkspaceGenerationFailpointHandler,
): Promise<SupervisedWorkspaceGenerationResult> {
  let manifest = initial;
  validateManifest(manifest);
  const inspections = new FileInspectionSession(manifest.limits.maxChangedPaths);
  const retiredRoot = join(manifest.generationRoot, RETIRED_NAME);
  const authorityRoot = join(manifest.generationRoot, AUTHORITY_NAME);
  // Windows: checked before the rename, so a generation whose borrowed objects
  // are gone stays ready and can be abandoned for a fresh one.
  let baseObjectsChecked = false;
  const assertBaseObjects = async (): Promise<void> => {
    if (!isWindowsGeneration() || baseObjectsChecked) return;
    await assertGenerationObjectsComplete(authorityRoot, [manifest.headOid, manifest.baselineTreeOid!], manifest.limits);
    baseObjectsChecked = true;
  };
  if (manifest.phase === "ready") {
    await assertBaseObjects();
    await ensureQuarantined(manifest, retiredRoot, authorityRoot);
    manifest = await transition(manifest, "quarantined");
    await invokeFailpoint(failpoint, "after_quarantined", manifestPathOf(manifest));
  }
  if (manifest.phase === "quarantined") {
    await assertTrustedAuthority(manifest, authorityRoot);
    await assertBaseObjects();
    const finalTreeOid = await snapshotWorktree(
      authorityRoot,
      retiredRoot,
      join(authorityRoot, FINAL_INDEX_NAME),
      manifest.baselineTreeOid!,
      manifest.limits,
    );
    await freezeDesiredStages(manifest, authorityRoot, finalTreeOid, inspections);
    manifest = await transition(manifest, "frozen", { finalTreeOid });
    await invokeFailpoint(failpoint, "after_frozen", manifestPathOf(manifest));
  }
  if (manifest.phase === "frozen") {
    if (isWindowsGeneration()) {
      await assertGenerationObjectsComplete(authorityRoot, [manifest.baselineTreeOid!, manifest.finalTreeOid!], manifest.limits);
    }
    const operationJournal = await buildPlan(manifest, authorityRoot, inspections);
    manifest = await transition(manifest, "planned", { operationJournal });
    await invokeFailpoint(failpoint, "after_planned", manifestPathOf(manifest));
  }
  if (manifest.phase === "planned") {
    manifest = await transition(manifest, "applying");
    await invokeFailpoint(failpoint, "after_applying", manifestPathOf(manifest));
  }
  if (manifest.phase === "applying") {
    for (let index = 0; index < manifest.operationJournal.length; index += 1) {
      const operation = manifest.operationJournal[index]!;
      if (operation.status === "applied") {
        await validateAppliedOperationArtifacts(manifest, operation, inspections);
        continue;
      }
      await applyOperation(manifest, operation, authorityRoot, inspections);
      await invokeFailpoint(failpoint, "after_operation_effect", manifestPathOf(manifest));
      await validateAppliedOperationArtifacts(manifest, operation, inspections);
      const operationJournal = manifest.operationJournal.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, status: "applied" as const } : entry,
      );
      manifest = await transition(manifest, "applying", { operationJournal });
      await invokeFailpoint(failpoint, "after_operation", manifestPathOf(manifest));
    }
    manifest = await transition(manifest, "committed");
    await invokeFailpoint(failpoint, "after_committed", manifestPathOf(manifest));
  }
  if (manifest.phase === "committed") {
    try {
      await cleanupTrees(manifest, true);
    } catch (error) {
      throw generationError(
        `Reconciliation committed, but private-generation cleanup is deferred: ${error instanceof Error ? error.message : String(error)}`,
        "COMMITTED_CLEANUP_DEFERRED",
      );
    }
    manifest = await transition(manifest, "cleaned");
    await invokeFailpoint(failpoint, "after_cleaned", manifestPathOf(manifest));
  }
  if (manifest.phase === "cleaned" || manifest.phase === "aborted") return resultFor(manifest);
  throw generationError(`Cannot reconcile phase ${manifest.phase}.`, "INVALID_PHASE");
}

export async function abandonManifest(
  manifest: GenerationManifest,
  failpoint?: SupervisedWorkspaceGenerationFailpointHandler,
): Promise<SupervisedWorkspaceGenerationResult> {
  if (manifest.phase === "aborted") {
    await cleanupTrees(manifest);
    return resultFor(manifest);
  }
  if (manifest.phase !== "preparing" && manifest.phase !== "ready") {
    throw generationError("A released generation cannot be abandoned; it must be recovered.", "ABANDON_AFTER_RELEASE_DENIED");
  }
  const aborted = await transition(manifest, "aborted");
  await invokeFailpoint(failpoint, "after_aborted", manifestPathOf(aborted));
  await cleanupTrees(aborted);
  return resultFor(aborted);
}

export async function ensureQuarantined(
  manifest: GenerationManifest,
  retiredRoot: string,
  authorityRoot: string,
): Promise<void> {
  if (await pathExists(manifest.liveSourceRoot)) {
    if (await pathExists(retiredRoot)) throw generationError("Both live and retired generation paths exist.", "AMBIGUOUS_GENERATION_PATHS");
    await rename(manifest.liveSourceRoot, retiredRoot);
    await fsyncDirectory(manifest.generationRoot);
  }
  if (!(await pathExists(retiredRoot))) throw generationError("The generation disappeared before quarantine.", "GENERATION_MISSING");
  const embeddedAuthority = join(retiredRoot, ".git");
  if (await pathExists(embeddedAuthority)) {
    // Provider-visible Git metadata is untrusted input. Remove it after the
    // generation is retired; it is never promoted into reconciliation authority.
    await rm(embeddedAuthority, { recursive: true, force: true, maxRetries: 2 });
    await fsyncDirectory(retiredRoot);
  }
  if (isWindowsGeneration()) await assertWindowsRetiredTree(manifest, retiredRoot);
  else await assertNoProtectedPathAliases(retiredRoot, manifest.limits);
  await assertTrustedAuthority(manifest, authorityRoot);
}

/**
 * Windows, in place of assertNoProtectedPathAliases: before Git snapshots the
 * retired tree, refuse protected-name aliases, every DOS device name (NUL,
 * CON, COM1...), which Windows does not open as a plain path, and every link
 * or junction Git does not ignore except the dependency junctions this
 * generation made (any user can make a junction, and whether Git records one
 * as a link depends on its settings). The walk skips an ignored folder, so a
 * package manager's node_modules neither blocks retirement nor counts against
 * the path limit, unless it holds a baseline path: the agent writes the
 * .gitignore files, and Git still refreshes tracked files under them.
 */
export async function assertWindowsRetiredTree(manifest: GenerationManifest, retiredRoot: string): Promise<void> {
  const mapped = new Set(manifest.readOnlyRoots
    .filter((entry) => entry.purpose === "dependency" && entry.generationPath !== null)
    .map((entry) => safeRelative(manifest.liveSourceRoot, entry.generationPath!)));
  const authorityRoot = join(manifest.generationRoot, AUTHORITY_NAME);
  // Folded: NTFS ignores case, so "SRC" reaches the tracked "src". NTFS
  // compares upper-cased names ("ı" and "ſ" upper-case to "I" and "S"), so
  // fold through upper case; an extra match (ß, ss) only refuses more.
  const fold = (path: string) => path.normalize("NFC").toUpperCase().toLowerCase();
  const trackedFiles = new Set((await treePaths(authorityRoot, manifest.baselineTreeOid!, manifest.limits)).map(fold));
  const trackedFolders = new Set([...trackedFiles].flatMap(ancestorPaths));
  let level = [""];
  let visited = 0;
  while (level.length > 0) {
    const links: string[] = [];
    const folders: string[] = [];
    for (const parentRelativePath of level) {
      for (const entry of await readdir(join(retiredRoot, parentRelativePath), { withFileTypes: true })) {
        const relativePath = parentRelativePath ? join(parentRelativePath, entry.name) : entry.name;
        assertSafeRelativePath(relativePath, manifest.limits);
        visited += 1;
        if (visited > manifest.limits.maxChangedPaths) throw limitError("retired path count", manifest.limits.maxChangedPaths);
        assertNotProtectedAlias(entry.name, relativePath);
        if (WINDOWS_DEVICE_NAME.test(entry.name)) {
          throw generationError(`A Windows device name cannot be reconciled at ${JSON.stringify(relativePath)}.`, "UNSUPPORTED_GIT_TREE_ENTRY");
        }
        if (entry.isSymbolicLink()) {
          if (!mapped.has(relativePath)) links.push(relativePath);
        } else if (entry.isDirectory()) folders.push(relativePath);
      }
    }
    const ignored = await ignoredGitPaths(authorityRoot, retiredRoot, [
      ...links.map(gitRelativePath),
      ...folders.map((folder) => `${gitRelativePath(folder)}/`),
    ], manifest.limits);
    const exported = links.find((link) => !ignored.has(gitRelativePath(link))
      || trackedFiles.has(fold(link)) || trackedFolders.has(fold(link)));
    if (exported !== undefined) {
      throw generationError(`Symlink, junction, or unsupported tree entry denied at ${JSON.stringify(exported)}.`, "UNSUPPORTED_GIT_TREE_ENTRY");
    }
    level = folders.filter((folder) => !ignored.has(`${gitRelativePath(folder)}/`) || trackedFolders.has(fold(folder)));
  }
}

/** CON, PRN, AUX, NUL, COM1-9, LPT1-9 (also with an extension or trailing dots and spaces). */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.[^.]*)?[. ]*$/i;

async function treePaths(gitDirectory: string, treeOid: string, limits: SupervisedWorkspaceGenerationLimits): Promise<string[]> {
  const paths = splitNul(await gitAuthorityBuffer(gitDirectory, null, ["ls-tree", "-r", "--name-only", "-z", treeOid], limits.maxPatchBytes));
  if (paths.length > limits.maxChangedPaths) throw limitError("tree path count", limits.maxChangedPaths);
  return paths;
}

export async function assertNoProtectedPathAliases(
  retiredRoot: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<void> {
  const pending = [""];
  let visited = 0;
  while (pending.length > 0) {
    const parentRelativePath = pending.pop()!;
    const entries = await readdir(join(retiredRoot, parentRelativePath), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = parentRelativePath ? join(parentRelativePath, entry.name) : entry.name;
      assertSafeRelativePath(relativePath, limits);
      visited += 1;
      if (visited > limits.maxChangedPaths) throw limitError("retired path count", limits.maxChangedPaths);
      assertNotProtectedAlias(entry.name, relativePath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(relativePath);
    }
  }
}

function assertNotProtectedAlias(name: string, relativePath: string): void {
  const normalized = name.normalize("NFC");
  const folded = normalized.toLowerCase();
  if ([".git", ".cursor", ".claude", ".letagents-fence"].includes(folded) && name !== folded) {
    throw generationError(
      `Generation changed a case- or Unicode-normalization alias of protected workspace authority at ${JSON.stringify(relativePath)}.`,
      "PROTECTED_GENERATION_CHANGE",
    );
  }
}

export async function buildPlan(
  manifest: GenerationManifest,
  authorityRoot: string,
  inspections: FileInspectionSession,
): Promise<ReconcileOperation[]> {
  const operations: ReconcileOperation[] = [];
  await assertTreeHasNoNormalizedPathCollisions(authorityRoot, manifest.finalTreeOid!, manifest.limits);
  const changes = await diffTreeEntries(
    authorityRoot,
    manifest.baselineTreeOid!,
    manifest.finalTreeOid!,
    manifest.limits,
  );
  let baselineModes: Map<string, number> | undefined;
  const normalizedPaths = new Map<string, string>();
  for (const change of changes) {
    const relativePath = projectRelativePath(change.sourceRelativePath, manifest.workspaceRelativePath);
    if (relativePath === null) continue;
    const folded = relativePath.normalize("NFC").toLowerCase();
    const prior = normalizedPaths.get(folded);
    if (prior && prior !== relativePath) {
      throw generationError(
        `Case- or Unicode-normalization-only path changes are not reconciled automatically (${JSON.stringify(prior)} and ${JSON.stringify(relativePath)}).`,
        "AMBIGUOUS_PATH_NORMALIZATION",
      );
    }
    normalizedPaths.set(folded, relativePath);
  }
  for (const { sourceRelativePath, before, after } of changes) {
    const relativePath = projectRelativePath(sourceRelativePath, manifest.workspaceRelativePath);
    if (relativePath === null) {
      throw generationError(`Generation changed outside the writable project mapping at ${JSON.stringify(sourceRelativePath)}.`, "OUT_OF_SCOPE_GENERATION_CHANGE");
    }
    if (isProtectedPath(relativePath)) {
      throw generationError(`Generation changed protected workspace authority at ${JSON.stringify(relativePath)}.`, "PROTECTED_GENERATION_CHANGE");
    }
    assertSafeRelativePath(relativePath, manifest.limits);
    const id = operationId(sourceRelativePath, before, after);
    let baselineMode: number | null = null;
    let baselineMetadataDigest: string | null = null;
    if (before && isWindowsGeneration()) {
      // Windows keeps no baseline copies (the tree is a checkout, not a
      // clone). The real file must still hold the baseline bytes; its
      // metadata is the one Windows reports (the read-only attribute).
      const realState = await inspections.inspect(manifest, join(manifest.realWorkspace, relativePath), relativePath);
      if (!realState) throw new SupervisedWorkspaceConflictError(relativePath, "the immutable baseline file disappeared");
      if (!treeEntryEqual(realState.entry, before)) {
        throw new SupervisedWorkspaceConflictError(relativePath, "content or metadata no longer matches the immutable baseline");
      }
      baselineModes ??= await readWindowsBaselineModes(manifest);
      baselineMode = baselineModes.get(sourceRelativePath) ?? WINDOWS_DEFAULT_FILE_MODE;
      baselineMetadataDigest = windowsFileMetadataDigest({ size: 0, mode: baselineMode, uid: 0, gid: 0 });
    } else if (before) {
      const baselineRoot = join(manifest.generationRoot, BASELINE_FILES_NAME);
      await assertSafeAncestors(baselineRoot, sourceRelativePath, false);
      const baselinePath = join(baselineRoot, sourceRelativePath);
      const baselineState = await inspections.inspect(manifest, baselinePath, sourceRelativePath);
      if (!baselineState) {
        throw generationError(`Immutable baseline metadata is unavailable at ${JSON.stringify(sourceRelativePath)}.`, "INVALID_BASELINE_METADATA");
      }
      if (!treeEntryEqual(baselineState.entry, before)) {
        throw generationError(`Immutable baseline metadata does not match the baseline tree at ${JSON.stringify(sourceRelativePath)}.`, "INVALID_BASELINE_METADATA");
      }
      baselineMode = baselineState.fullMode;
      baselineMetadataDigest = baselineState.metadataDigest;
    }
    let desiredMode: number | null = null;
    let desiredMetadataDigest: string | null = null;
    if (after) {
      const desiredState = await inspections.inspect(
        manifest,
        join(manifest.generationRoot, STAGING_NAME, `${id}.desired`),
        sourceRelativePath,
      );
      if (!desiredState) {
        throw generationError(`Desired file metadata is unavailable at ${JSON.stringify(sourceRelativePath)}.`, "UNSUPPORTED_GIT_TREE_ENTRY");
      }
      desiredMode = desiredState.fullMode;
      desiredMetadataDigest = desiredState.metadataDigest;
    }
    operations.push({
      id,
      kind: after ? "write" : "delete",
      relativePath,
      sourceRelativePath,
      baseline: before,
      desired: after,
      baselineMode,
      desiredMode,
      baselineMetadataDigest,
      desiredMetadataDigest,
      stagingRelativePath: after ? join(STAGING_NAME, `${id}.desired`) : null,
      desiredArtifactRelativePath: after ? join(STAGING_NAME, `${id}.commit`) : null,
      displacedArtifactRelativePath: before ? join(STAGING_NAME, `${id}.displaced`) : null,
      status: "pending",
    });
  }
  if (operations.length > manifest.limits.maxChangedPaths) throw limitError("changed path count", manifest.limits.maxChangedPaths);
  const byPath = new Map(operations.map((operation) => [operation.relativePath, operation]));
  for (const operation of operations) {
    // Windows: refuse an alias ancestor (see assertSafeAncestors) before anything is applied.
    if (isWindowsGeneration()) await assertNoShortNameAncestors(manifest.realWorkspace, operation.relativePath);
    const observed = await inspectPlanEntry(manifest, operation.relativePath, inspections);
    if (observed.kind === "file") {
      if (!treeEntryEqual(observed.entry, operation.baseline)
        || observed.fullMode !== operation.baselineMode
        || observed.metadataDigest !== operation.baselineMetadataDigest) {
        throw new SupervisedWorkspaceConflictError(operation.relativePath, "content or metadata no longer matches the immutable baseline");
      }
      continue;
    }
    if (observed.kind === "missing") {
      if (operation.baseline !== null) {
        throw new SupervisedWorkspaceConflictError(operation.relativePath, "the immutable baseline file disappeared");
      }
      continue;
    }
    if (observed.kind === "blocked") {
      const blockingDelete = ancestorPaths(operation.relativePath)
        .map((ancestor) => byPath.get(ancestor))
        .find((candidate) => candidate?.kind === "delete" && candidate.baseline !== null);
      if (!blockingDelete || operation.baseline !== null) {
        throw new SupervisedWorkspaceConflictError(operation.relativePath, "an unexpected file blocks its path");
      }
      continue;
    }
    if (operation.baseline !== null || operation.kind !== "write") {
      throw new SupervisedWorkspaceConflictError(operation.relativePath, "the path is unexpectedly a directory");
    }
    await assertReplacementDirectoryContainsOnlyPlannedDeletes(manifest, operation.relativePath, byPath);
  }
  await prepareOperationStages(manifest, operations, authorityRoot, inspections);
  return operations.sort(compareOperationsForApply);
}

export type PlanEntry =
  | { kind: "missing" | "blocked" | "directory" }
  | { kind: "file"; entry: TreeEntry; fullMode: number; metadataDigest: string };

export async function inspectPlanEntry(
  manifest: GenerationManifest,
  relativePath: string,
  inspections: FileInspectionSession,
): Promise<PlanEntry> {
  const target = join(manifest.realWorkspace, relativePath);
  let info: Stats;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "missing" };
    if (isErrno(error, "ENOTDIR")) return { kind: "blocked" };
    throw error;
  }
  if (info.isDirectory() && !info.isSymbolicLink()) return { kind: "directory" };
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SupervisedWorkspaceConflictError(relativePath, "the path is not a regular file or directory");
  }
  const state = await inspections.inspect(manifest, target, relativePath);
  if (!state) return { kind: "missing" };
  return { kind: "file", entry: state.entry, fullMode: state.fullMode, metadataDigest: state.metadataDigest };
}

export async function assertReplacementDirectoryContainsOnlyPlannedDeletes(
  manifest: GenerationManifest,
  directoryRelativePath: string,
  operations: Map<string, ReconcileOperation>,
): Promise<void> {
  const pending = [directoryRelativePath];
  let visited = 0;
  let matchedDeletion = false;
  while (pending.length > 0) {
    const currentRelativePath = pending.pop()!;
    const entries = await readdir(join(manifest.realWorkspace, currentRelativePath));
    for (const name of entries) {
      const relativePath = join(currentRelativePath, name);
      assertSafeRelativePath(relativePath, manifest.limits);
      visited += 1;
      if (visited > manifest.limits.maxChangedPaths) throw limitError("replacement-directory entries", manifest.limits.maxChangedPaths);
      const info = await lstat(join(manifest.realWorkspace, relativePath));
      if (info.isDirectory() && !info.isSymbolicLink()) {
        pending.push(relativePath);
        continue;
      }
      const operation = operations.get(relativePath);
      if (!operation || operation.kind !== "delete" || operation.baseline === null
        || !info.isFile() || info.isSymbolicLink()) {
        throw new SupervisedWorkspaceConflictError(directoryRelativePath, "the replacement directory contains untracked or special entries");
      }
      const current = await treeEntryForRegularFile(manifest, join(manifest.realWorkspace, relativePath), info);
      if (!treeEntryEqual(current, operation.baseline)) {
        throw new SupervisedWorkspaceConflictError(relativePath, "it no longer matches the immutable baseline tree");
      }
      matchedDeletion = true;
    }
  }
  if (!matchedDeletion) {
    throw new SupervisedWorkspaceConflictError(directoryRelativePath, "an untracked empty directory occupies the new file path");
  }
}

export function compareOperationsForApply(a: ReconcileOperation, b: ReconcileOperation): number {
  if (a.kind !== b.kind) return a.kind === "delete" ? -1 : 1;
  const depthA = a.relativePath.split(sep).length;
  const depthB = b.relativePath.split(sep).length;
  if (a.kind === "delete" && depthA !== depthB) return depthB - depthA;
  if (a.kind === "write" && depthA !== depthB) return depthA - depthB;
  return compareUtf8(a.relativePath, b.relativePath);
}

export function ancestorPaths(relativePath: string): string[] {
  const components = relativePath.split(sep);
  const result: string[] = [];
  for (let length = components.length - 1; length > 0; length -= 1) {
    result.push(components.slice(0, length).join(sep));
  }
  return result;
}

export async function applyOperation(
  manifest: GenerationManifest,
  operation: ReconcileOperation,
  _authorityRoot: string,
  inspections: FileInspectionSession,
): Promise<void> {
  await assertSafeAncestors(manifest.realWorkspace, operation.relativePath, operation.kind === "write");
  const target = join(manifest.realWorkspace, operation.relativePath);
  const parent = dirname(target);
  const parentIdentity = await canonicalDirectoryIdentity(parent, manifest.realWorkspace, operation.relativePath);
  const desiredArtifact = operation.desiredArtifactRelativePath
    ? join(manifest.generationRoot, operation.desiredArtifactRelativePath) : null;
  const displacedArtifact = operation.displacedArtifactRelativePath
    ? join(manifest.generationRoot, operation.displacedArtifactRelativePath) : null;
  const current = await inspectExactFile(manifest, target, undefined, inspections);
  if (matchesOperationState(current, operation.desired, operation.desiredMode, operation.desiredMetadataDigest)) {
    if (operation.desired) {
      const desiredEvidence = desiredArtifact
        ? await inspectExactFile(manifest, desiredArtifact, operation.relativePath, inspections) : null;
      if (!matchesOperationState(desiredEvidence, operation.desired, operation.desiredMode, operation.desiredMetadataDigest)
        || desiredEvidence?.dev !== current?.dev || desiredEvidence?.ino !== current?.ino) {
        throw new SupervisedWorkspaceConflictError(operation.relativePath, "the desired state exists without the exact journaled install artifact");
      }
    }
    if (operation.baseline) {
      if (!displacedArtifact || !(await pathExists(displacedArtifact))) {
        throw new SupervisedWorkspaceConflictError(operation.relativePath, "the desired state exists without exact displaced baseline evidence");
      }
      const displaced = await inspectExactFile(manifest, displacedArtifact, operation.relativePath, inspections);
      if (!matchesOperationState(displaced, operation.baseline, operation.baselineMode, operation.baselineMetadataDigest)) {
        throw new SupervisedWorkspaceConflictError(operation.relativePath, `the retained displaced file changed at ${JSON.stringify(displacedArtifact)}`);
      }
    }
    if (operation.desired && isWindowsGeneration()) await inheritWorkspaceAcl(target);
    await assertCanonicalDirectoryIdentity(parent, parentIdentity, manifest.realWorkspace, operation.relativePath);
    return;
  }

  if (operation.desired && desiredArtifact) {
    await ensureDesiredArtifact(manifest, operation, desiredArtifact, inspections);
  }

  if (operation.baseline === null) {
    if (current !== null) {
      throw new SupervisedWorkspaceConflictError(operation.relativePath, "a concurrent entry occupies the new file path");
    }
    try {
      await link(desiredArtifact!, target);
    } catch (error) {
      if (isErrno(error, "EEXIST")) throw new SupervisedWorkspaceConflictError(operation.relativePath, "a concurrent entry won the no-replace install");
      throw error;
    }
    if (isWindowsGeneration()) await inheritWorkspaceAcl(target);
    await fsyncDirectory(parent);
    await assertCanonicalDirectoryIdentity(parent, parentIdentity, manifest.realWorkspace, operation.relativePath);
    const installed = await inspectExactFile(manifest, target, undefined, inspections);
    if (!matchesOperationState(installed, operation.desired, operation.desiredMode, operation.desiredMetadataDigest)) {
      throw new SupervisedWorkspaceConflictError(operation.relativePath, "the no-replace desired install was changed concurrently");
    }
    return;
  }

  if (!displacedArtifact) throw generationError("A baseline operation has no displaced-file journal path.", "INVALID_MANIFEST");
  let displaced = await inspectExactFile(manifest, displacedArtifact, operation.relativePath, inspections);
  if (displaced === null) {
    if (!matchesOperationState(current, operation.baseline, operation.baselineMode, operation.baselineMetadataDigest)) {
      throw new SupervisedWorkspaceConflictError(operation.relativePath, "it changed after the reconciliation plan was persisted");
    }
    await assertCanonicalDirectoryIdentity(parent, parentIdentity, manifest.realWorkspace, operation.relativePath);
    await rename(target, displacedArtifact);
    await fsyncDirectory(parent);
    await fsyncDirectory(dirname(displacedArtifact));
    displaced = await inspectExactFile(manifest, displacedArtifact, operation.relativePath, inspections);
  }
  if (!matchesOperationState(displaced, operation.baseline, operation.baselineMode, operation.baselineMetadataDigest)) {
    await restoreDisplacedWithoutOverwrite(manifest, operation, target, displacedArtifact);
    throw new SupervisedWorkspaceConflictError(operation.relativePath, `the exact displaced file no longer matches baseline; evidence retained at ${JSON.stringify(displacedArtifact)}`);
  }
  const targetAfterDisplacement = await inspectExactFile(manifest, target, undefined, inspections);
  if (targetAfterDisplacement !== null) {
    throw new SupervisedWorkspaceConflictError(operation.relativePath, `a concurrent entry appeared after displacement; baseline evidence retained at ${JSON.stringify(displacedArtifact)}`);
  }
  if (operation.kind === "write") {
    try {
      await link(desiredArtifact!, target);
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new SupervisedWorkspaceConflictError(operation.relativePath, `a concurrent entry won the no-replace install; baseline evidence retained at ${JSON.stringify(displacedArtifact)}`);
      }
      throw error;
    }
    if (isWindowsGeneration()) await inheritWorkspaceAcl(target);
  }
  await fsyncDirectory(parent);
  await assertCanonicalDirectoryIdentity(parent, parentIdentity, manifest.realWorkspace, operation.relativePath);
  const [installed, displacedAfter] = await Promise.all([
    inspectExactFile(manifest, target, undefined, inspections),
    inspectExactFile(manifest, displacedArtifact, operation.relativePath, inspections),
  ]);
  if (!matchesOperationState(installed, operation.desired, operation.desiredMode, operation.desiredMetadataDigest)
    || !matchesOperationState(displacedAfter, operation.baseline, operation.baselineMode, operation.baselineMetadataDigest)) {
    throw new SupervisedWorkspaceConflictError(operation.relativePath, `the commit edge changed concurrently; displaced evidence retained at ${JSON.stringify(displacedArtifact)}`);
  }
}

export async function prepareOperationStages(
  manifest: GenerationManifest,
  operations: ReconcileOperation[],
  authorityRoot: string,
  inspections: FileInspectionSession,
): Promise<void> {
  const stagingRoot = join(manifest.generationRoot, STAGING_NAME);
  await mkdir(stagingRoot, { mode: 0o700, recursive: true });
  for (const operation of operations) {
    if (!operation.desired || !operation.stagingRelativePath || operation.desiredMode === null) continue;
    const source = join(manifest.generationRoot, RETIRED_NAME, operation.sourceRelativePath);
    const destination = join(manifest.generationRoot, operation.stagingRelativePath);
    safeRelative(manifest.generationRoot, destination);
    if (!(await pathExists(destination))) await cloneRegularFile(source, destination, manifest.limits.maxFileBytes);
    const info = await lstat(destination);
    const state = await inspections.inspect(manifest, destination, operation.relativePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !state
      || !treeEntryEqual(state.entry, operation.desired) || state.fullMode !== operation.desiredMode
      || state.metadataDigest !== operation.desiredMetadataDigest) {
      throw generationError(`Desired reconciliation stage could not be sealed for ${JSON.stringify(operation.relativePath)}.`, "INVALID_RECONCILIATION_STAGE");
    }
  }
  await fsyncDirectory(stagingRoot);
  await fsyncDirectory(manifest.generationRoot);
  // Prove the tree objects referenced by the plan exist only in the trusted
  // authority before the provider-retired tree is eligible for deletion.
  for (const operation of operations) {
    if (operation.desired) await readGitBlob(authorityRoot, operation.desired.oid, manifest.limits);
  }
}

export async function freezeDesiredStages(
  manifest: GenerationManifest,
  authorityRoot: string,
  finalTreeOid: string,
  inspections: FileInspectionSession,
): Promise<void> {
  const stagingRoot = join(manifest.generationRoot, STAGING_NAME);
  await rm(stagingRoot, { recursive: true, force: true, maxRetries: 2 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const changes = await diffTreeEntries(authorityRoot, manifest.baselineTreeOid!, finalTreeOid, manifest.limits);
  for (const { sourceRelativePath, before, after } of changes) {
    if (!after) continue;
    const id = operationId(sourceRelativePath, before, after);
    const source = join(manifest.generationRoot, RETIRED_NAME, sourceRelativePath);
    const destination = join(stagingRoot, `${id}.desired`);
    const beforeInfo = await lstat(source);
    if (!beforeInfo.isFile() || beforeInfo.isSymbolicLink()) {
      throw generationError(`Desired frozen file is not regular at ${JSON.stringify(sourceRelativePath)}.`, "UNSUPPORTED_GIT_TREE_ENTRY");
    }
    await cloneRegularFile(source, destination, manifest.limits.maxFileBytes);
    const afterInfo = await lstat(source);
    const stagedInfo = await lstat(destination);
    const stagedState = await inspections.inspect(manifest, destination, sourceRelativePath);
    if (beforeInfo.dev !== afterInfo.dev || beforeInfo.ino !== afterInfo.ino
      || beforeInfo.size !== afterInfo.size || beforeInfo.mtimeMs !== afterInfo.mtimeMs
      || !stagedState || !treeEntryEqual(stagedState.entry, after) || stagedInfo.nlink !== 1) {
      throw generationError(`Desired frozen file changed during sealing at ${JSON.stringify(sourceRelativePath)}.`, "GENERATION_CHANGED_DURING_FREEZE");
    }
  }
  await fsyncDirectory(stagingRoot);
  await fsyncDirectory(manifest.generationRoot);
}
