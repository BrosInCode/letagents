import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { access, chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { AUTHORITY_NAME, BASELINE_FILES_NAME, BASELINE_INDEX_NAME, type CreateSupervisedWorkspaceGenerationOptions, DEFAULT_LIMITS, FINAL_INDEX_NAME, type GenerationManifest, LIVE_NAME, MANIFEST_NAME, MANIFEST_VERSION, RETIRED_NAME, type ReconcileOperation, type RecoverSupervisedWorkspaceGenerationOptions, STAGING_NAME, SUPERVISED_WORKSPACE_GENERATION_LIMITATION, type SourceGitAuthority, SupervisedWorkspaceConflictError, SupervisedWorkspaceGenerationError, type SupervisedWorkspaceGenerationFailpointHandler, type SupervisedWorkspaceGenerationHandle, type SupervisedWorkspaceGenerationLimits, type SupervisedWorkspaceGenerationResult, type SupervisedWorkspaceGenerationSupport, type SupervisedWorkspaceReadOnlyRoot, type TreeEntry } from "./supervised-workspace-generation/types.js";
import { FileInspectionSession, assertCanonicalDirectoryIdentity, canonicalDirectoryIdentity, ensureDesiredArtifact, inspectExactFile, matchesOperationState, restoreDisplacedWithoutOverwrite, validateAppliedOperationArtifacts } from "./supervised-workspace-generation/file-inspection.js";
import { ProcessExitError, canonicalGitControlTarget, cloneRegularFile, discoverSourceGitText, gitControlPath, gitText, readStableGitControlFile, runGit, sourceAuthorityBuffer, sourceAuthorityExitCode, sourceAuthorityText, sourceGitEnvironment } from "./supervised-workspace-generation/git.js";
import { assertClonePlatform, assertSafeRelativePath, compareUtf8, fsyncDirectory, generationDirectoryName, generationError, generationIdFor, invokeFailpoint, isErrno, isProtectedPath, limitError, manifestPathOf, normalizeLimits, operationId, pathExists, projectRelativePath, resultFor, safeRelative, splitNul, splitNulBuffer, treeEntryEqual } from "./supervised-workspace-generation/helpers.js";
import { assertSafeAncestors, atomicWrite, cleanupTrees, loadManifest, persistManifest, transition, validateManifest } from "./supervised-workspace-generation/manifest.js";
import { assertTreeHasNoNormalizedPathCollisions, diffTreeEntries, materializeSourceWorktree, pinPrivateCloneHead, readGitBlob, reproduceProviderIndex, snapshotWorktree, sourceVisiblePaths, treeEntryForRegularFile } from "./supervised-workspace-generation/worktree.js";
export { SUPERVISED_WORKSPACE_GENERATION_LIMITATION } from "./supervised-workspace-generation/types.js";
export type { SupervisedWorkspaceGenerationPhase } from "./supervised-workspace-generation/types.js";
export type { SupervisedWorkspaceGenerationFailpoint } from "./supervised-workspace-generation/types.js";
export type { SupervisedWorkspaceGenerationLimits } from "./supervised-workspace-generation/types.js";
export type { SupervisedWorkspaceGenerationSupport } from "./supervised-workspace-generation/types.js";
export type { SupervisedWorkspaceReadOnlyRoot } from "./supervised-workspace-generation/types.js";
export type { SupervisedWorkspaceGenerationFailpointHandler } from "./supervised-workspace-generation/types.js";
export type { CreateSupervisedWorkspaceGenerationOptions } from "./supervised-workspace-generation/types.js";
export type { RecoverSupervisedWorkspaceGenerationOptions } from "./supervised-workspace-generation/types.js";
export type { SupervisedWorkspaceGenerationResult } from "./supervised-workspace-generation/types.js";
export type { SupervisedWorkspaceGenerationHandle } from "./supervised-workspace-generation/types.js";
export { SupervisedWorkspaceGenerationError } from "./supervised-workspace-generation/types.js";
export { SupervisedWorkspaceConflictError } from "./supervised-workspace-generation/types.js";


export async function assertSupervisedWorkspaceGenerationSupported(
  realWorkspaceInput: string,
): Promise<SupervisedWorkspaceGenerationSupport> {
  assertClonePlatform();
  const requested = resolve(realWorkspaceInput);
  const realWorkspace = await realpath(requested);
  const selectedInfo = await lstat(realWorkspace);
  if (!selectedInfo.isDirectory() || selectedInfo.isSymbolicLink()) {
    throw generationError("The selected workspace is not a real directory.", "UNSAFE_WORKSPACE_ROOT");
  }
  const sourceRoot = await discoverSourceGitText(realWorkspace, ["rev-parse", "--show-toplevel"]);
  const canonicalSourceRoot = await realpath(sourceRoot);
  if (sourceRoot !== canonicalSourceRoot || resolve(sourceRoot) !== sourceRoot) {
    throw generationError("The Git top-level is symlinked or redirected.", "REDIRECTED_GIT_ROOT");
  }
  const workspaceRelativePath = safeRelative(sourceRoot, realWorkspace);
  const gitDirectoryRaw = await discoverSourceGitText(sourceRoot, ["rev-parse", "--absolute-git-dir"]);
  if (!isAbsolute(gitDirectoryRaw) || resolve(gitDirectoryRaw) !== gitDirectoryRaw) {
    throw generationError("The Git directory is not canonical.", "REDIRECTED_GIT_ROOT");
  }
  const gitDirectory = await realpath(gitDirectoryRaw);
  if (gitDirectory !== gitDirectoryRaw) {
    throw generationError("The Git directory is symlinked or redirected.", "REDIRECTED_GIT_ROOT");
  }
  const expectedGitDirectory = join(sourceRoot, ".git");
  const gitInfo = await lstat(expectedGitDirectory).catch(() => null);
  const commonDirectoryRaw = await discoverSourceGitText(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDirectoryPath = resolve(isAbsolute(commonDirectoryRaw) ? commonDirectoryRaw : join(sourceRoot, commonDirectoryRaw));
  const commonDirectory = await realpath(commonDirectoryPath);
  if (commonDirectory !== commonDirectoryPath) {
    throw generationError("The common Git directory is symlinked or redirected.", "REDIRECTED_GIT_ROOT");
  }
  const commonInfo = await lstat(commonDirectory);
  if (!commonInfo.isDirectory() || commonInfo.isSymbolicLink()) {
    throw generationError("The common Git directory is not a real directory.", "REDIRECTED_GIT_ROOT");
  }
  if (gitInfo?.isDirectory() && !gitInfo.isSymbolicLink()) {
    if (gitDirectory !== expectedGitDirectory || commonDirectory !== gitDirectory) {
      throw generationError(SUPERVISED_WORKSPACE_GENERATION_LIMITATION, "SEPARATE_GIT_DIR_UNSUPPORTED");
    }
  } else if (gitInfo?.isFile() && !gitInfo.isSymbolicLink()) {
    const markerTarget = gitControlPath(
      await readStableGitControlFile(expectedGitDirectory),
      "gitdir: ",
      sourceRoot,
      "The linked-worktree Git marker is malformed.",
    );
    if (await canonicalGitControlTarget(markerTarget, "The linked-worktree Git marker target is unavailable.") !== gitDirectory
      || commonDirectory === gitDirectory
      || dirname(gitDirectory) !== join(commonDirectory, "worktrees")) {
      throw generationError(SUPERVISED_WORKSPACE_GENERATION_LIMITATION, "SEPARATE_GIT_DIR_UNSUPPORTED");
    }
    const commonTarget = gitControlPath(
      await readStableGitControlFile(join(gitDirectory, "commondir")),
      "",
      gitDirectory,
      "The linked-worktree common-directory marker is malformed.",
    );
    const worktreeTarget = gitControlPath(
      await readStableGitControlFile(join(gitDirectory, "gitdir")),
      "",
      gitDirectory,
      "The linked-worktree back-pointer is malformed.",
    );
    if (await canonicalGitControlTarget(commonTarget, "The linked-worktree common directory is unavailable.") !== commonDirectory
      || await canonicalGitControlTarget(worktreeTarget, "The linked-worktree back-pointer target is unavailable.") !== expectedGitDirectory) {
      throw generationError("The linked-worktree Git topology is inconsistent.", "REDIRECTED_GIT_ROOT");
    }
  } else {
    throw generationError("The worktree Git marker is unavailable or redirected.", "REDIRECTED_GIT_ROOT");
  }
  const sourceAuthority: SourceGitAuthority = {
    sourceRoot,
    gitDirectory,
    gitCommonDirectory: commonDirectory,
  };
  const pinnedSourceRoot = await sourceAuthorityText(sourceAuthority, ["rev-parse", "--show-toplevel"]);
  if (pinnedSourceRoot !== sourceRoot) {
    throw generationError("Pinned Git authority does not match the selected worktree.", "REDIRECTED_GIT_ROOT");
  }
  const headOid = await sourceAuthorityText(sourceAuthority, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const headRef = await sourceAuthorityText(sourceAuthority, ["symbolic-ref", "-q", "HEAD"])
    .catch((error) => {
      if (error instanceof ProcessExitError && error.exitCode === 1) return null;
      throw error;
    });
  const gitIndexPathRaw = await sourceAuthorityText(sourceAuthority, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const gitIndexPath = await realpath(gitIndexPathRaw);
  const gitIndexInfo = await lstat(gitIndexPathRaw);
  if (!isAbsolute(gitIndexPathRaw) || resolve(gitIndexPathRaw) !== gitIndexPathRaw
    || gitIndexPath !== gitIndexPathRaw || gitIndexPath !== join(gitDirectory, "index")
    || !gitIndexInfo.isFile() || gitIndexInfo.isSymbolicLink()) {
    throw generationError("The source Git index is redirected or unavailable.", "UNSAFE_SOURCE_INDEX");
  }
  const sharedIndexPath = await sourceAuthorityText(sourceAuthority, ["rev-parse", "--shared-index-path"]);
  if (sharedIndexPath) {
    throw generationError("Split Git indexes cannot be reproduced safely.", "SPLIT_INDEX_UNSUPPORTED");
  }
  try {
    await lstat(join(sourceRoot, ".gitmodules"));
    throw generationError(SUPERVISED_WORKSPACE_GENERATION_LIMITATION, "SUBMODULES_UNSUPPORTED");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  const parent = dirname(sourceRoot);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid?.()) {
    throw generationError("The adjacent generation parent is not a canonical user-owned directory.", "UNSAFE_GENERATION_PARENT");
  }
  try {
    await access(parent, fsConstants.W_OK | fsConstants.X_OK);
    await access(realWorkspace, fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    throw generationError(
      `The selected workspace and adjacent generation parent must be writable and searchable: ${error instanceof Error ? error.message : String(error)}`,
      "GENERATION_PATH_UNWRITABLE",
    );
  }
  await access("/bin/cp", fsConstants.X_OK);
  await gitText(sourceRoot, ["--version"]);
  const gitObjectPath = await sourceAuthorityText(sourceAuthority, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  const gitObjectInfo = await lstat(gitObjectPath);
  const gitObjectDirectory = await realpath(gitObjectPath);
  if (!isAbsolute(gitObjectPath) || resolve(gitObjectPath) !== gitObjectPath
    || !gitObjectInfo.isDirectory() || gitObjectInfo.isSymbolicLink()
    || gitObjectDirectory !== gitObjectPath || gitObjectDirectory !== join(commonDirectory, "objects")) {
    throw generationError(SUPERVISED_WORKSPACE_GENERATION_LIMITATION, "GIT_OBJECT_REDIRECTION_UNSUPPORTED");
  }
  try {
    await lstat(join(gitObjectDirectory, "info", "alternates"));
    throw generationError(SUPERVISED_WORKSPACE_GENERATION_LIMITATION, "GIT_OBJECT_ALTERNATES_UNSUPPORTED");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  if ((await stat(sourceRoot)).dev !== parentInfo.dev) {
    throw generationError("The repository and its adjacent generation parent are on different filesystems; clonefile isolation cannot be guaranteed.", "CLONE_FILESYSTEM_MISMATCH");
  }
  const support: SupervisedWorkspaceGenerationSupport = {
    sourceRoot,
    realWorkspace,
    workspaceRelativePath,
    headOid,
    headRef,
    gitDirectory,
    gitCommonDirectory: commonDirectory,
    gitIndexPath,
    gitObjectDirectory,
  };
  await assertSparseCheckoutDisabled(support);
  await assertIndexHasNoLinksOrGitlinks(support, DEFAULT_LIMITS);
  await assertNoUnmergedEntries(support, DEFAULT_LIMITS);
  await assertSourceWorktreeWithinLimits(support, DEFAULT_LIMITS);
  await assertClonefileSupported(parent);
  return support;
}

export async function supervisedWorkspaceGenerationManifestPath(
  realWorkspace: string,
  turnIdentity: string,
): Promise<string> {
  const support = await assertSupervisedWorkspaceGenerationSupported(realWorkspace);
  const generationId = generationIdFor(support.sourceRoot, turnIdentity);
  return join(dirname(support.sourceRoot), generationDirectoryName(support.sourceRoot, generationId), MANIFEST_NAME);
}

export async function createSupervisedWorkspaceGeneration(
  options: CreateSupervisedWorkspaceGenerationOptions,
): Promise<SupervisedWorkspaceGenerationHandle> {
  const support = await assertSupervisedWorkspaceGenerationSupported(options.realWorkspace);
  const limits = normalizeLimits(options.limits);
  await assertIndexHasNoLinksOrGitlinks(support, limits);
  await assertNoUnmergedEntries(support, limits);
  await assertSourceWorktreeWithinLimits(support, limits);
  const generationId = generationIdFor(support.sourceRoot, options.turnIdentity);
  const generationRoot = join(dirname(support.sourceRoot), generationDirectoryName(support.sourceRoot, generationId));
  try {
    await mkdir(generationRoot, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw generationError("A durable generation already exists for this turn; recover or abandon it instead of replacing it.", "GENERATION_ALREADY_EXISTS");
    }
    throw error;
  }
  await chmod(generationRoot, 0o700);
  const liveSourceRoot = join(generationRoot, LIVE_NAME);
  const liveWorkspace = support.workspaceRelativePath === "" ? liveSourceRoot : join(liveSourceRoot, support.workspaceRelativePath);
  const now = new Date().toISOString();
  let manifest: GenerationManifest = {
    version: MANIFEST_VERSION,
    generationId,
    phase: "preparing",
    sourceRoot: support.sourceRoot,
    realWorkspace: support.realWorkspace,
    workspaceRelativePath: support.workspaceRelativePath,
    generationRoot,
    liveSourceRoot,
    liveWorkspace,
    headOid: support.headOid,
    sourceGitObjectDirectory: support.gitObjectDirectory,
    baselineTreeOid: null,
    finalTreeOid: null,
    readOnlyRoots: [],
    limits,
    operationJournal: [],
    createdAt: now,
    updatedAt: now,
  };
  try {
    await persistManifest(manifest);
    await invokeFailpoint(options.failpoint, "after_preparing", manifestPathOf(manifest));

    // The provider-visible clone is disposable compatibility metadata. Trusted
    // snapshots use the distinct supervisor-only bare authority below and never
    // consume this .git directory after native release.
    await runGit(support.sourceRoot, [
      "clone", "--shared", "--no-checkout", "--no-hardlinks", "--", support.gitCommonDirectory, liveSourceRoot,
    ], limits.maxPatchBytes);
    await runGit(support.sourceRoot, [
      "clone", "--shared", "--bare", "--no-hardlinks", "--", support.gitCommonDirectory, join(generationRoot, AUTHORITY_NAME),
    ], limits.maxPatchBytes);
    await pinPrivateCloneHead(liveSourceRoot, support.headOid, support.headRef);
    await disablePrivateGitAuthority(liveSourceRoot);
    await disableTrustedGitAuthority(join(generationRoot, AUTHORITY_NAME));
    await reproduceProviderIndex(support.gitIndexPath, liveSourceRoot, limits);
    const baselineFilesRoot = join(generationRoot, BASELINE_FILES_NAME);
    await mkdir(baselineFilesRoot, { mode: 0o700 });
    await materializeSourceWorktree(support, liveSourceRoot, baselineFilesRoot, limits);
    const dependencyRoots = await linkIgnoredDependencyRoots(support, liveSourceRoot, limits);
    await installDependencyExcludes(join(liveSourceRoot, ".git"), dependencyRoots, liveSourceRoot, generationId);
    await installDependencyExcludes(join(generationRoot, AUTHORITY_NAME), dependencyRoots, liveSourceRoot, generationId);
    const alternateRoots = await readSafeAlternateRoots(liveSourceRoot, support.gitObjectDirectory, limits);
    await assertSafeBareAlternateRoot(join(generationRoot, AUTHORITY_NAME), support.gitObjectDirectory, limits);
    const baselineTreeOid = await snapshotWorktree(
      join(generationRoot, AUTHORITY_NAME),
      liveSourceRoot,
      join(generationRoot, AUTHORITY_NAME, BASELINE_INDEX_NAME),
      support.headOid,
      limits,
    );
    manifest = await transition(manifest, "ready", {
      baselineTreeOid,
      readOnlyRoots: [
        ...alternateRoots.map((sourcePath) => ({ sourcePath, generationPath: null, purpose: "git-objects" as const })),
        ...dependencyRoots,
      ],
    });
    await invokeFailpoint(options.failpoint, "after_ready", manifestPathOf(manifest));
    return makeHandle(manifest, options.failpoint);
  } catch (error) {
    // Failpoints model a process crash, so their durable evidence must remain
    // for the recovery tests/caller. Ordinary preparation failures never
    // released native authority and are cleaned before the error escapes.
    if (!options.failpoint) {
      try {
        const durable = await loadManifest(manifestPathOf(manifest)).catch((loadError) => {
          if (isErrno(loadError, "ENOENT")) return null;
          throw loadError;
        });
        if (durable) {
          const receipt = await abandonManifest(durable);
          await removeSupervisedWorkspaceGenerationReceipt(receipt.manifestPath);
        }
        else {
          await rm(generationRoot, { force: true, recursive: true, maxRetries: 2 });
          await fsyncDirectory(dirname(generationRoot));
        }
      } catch (cleanupError) {
        throw generationError(
          `Workspace generation failed (${error instanceof Error ? error.message : String(error)}) and its private preparation could not be retired (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}).`,
          "GENERATION_PREPARATION_CLEANUP_FAILED",
        );
      }
    }
    throw error;
  }
}

/**
 * Remove the small durable receipt only after the caller has checkpointed the
 * normalized turn result. Keeping it until then is what makes a crash between
 * filesystem reconciliation and daemon checkpointing recoverable.
 */
export async function removeSupervisedWorkspaceGenerationReceipt(manifestPath: string,
  options: { settlementVerified?: boolean } = {}): Promise<void> {
  let manifest: GenerationManifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (manifest.phase !== "cleaned" && manifest.phase !== "aborted") {
    throw generationError("A live or unreconciled workspace-generation receipt cannot be removed.", "GENERATION_RECEIPT_STILL_REQUIRED");
  }
  // A provider's fsynced exact-turn settlement can outlive partially removed
  // receipt artifacts. It proves the reconciliation already finished; never
  // infer that proof merely from missing artifacts or a missing manifest.
  if (manifest.phase === "cleaned" && !options.settlementVerified) {
    const inspections = new FileInspectionSession(manifest.limits.maxChangedPaths);
    for (const operation of manifest.operationJournal) {
      await validateAppliedOperationArtifacts(manifest, operation, inspections);
    }
  }
  await cleanupTrees(manifest);
  await rm(manifest.generationRoot, { force: true, recursive: true, maxRetries: 2 });
  await fsyncDirectory(dirname(manifest.generationRoot));
}

export async function recoverSupervisedWorkspaceGeneration(
  manifestPath: string,
  options: RecoverSupervisedWorkspaceGenerationOptions = {},
): Promise<SupervisedWorkspaceGenerationResult> {
  const manifest = await loadManifest(manifestPath);
  if (manifest.phase === "preparing") return abandonManifest(manifest, options.failpoint);
  if (manifest.phase === "aborted") {
    await cleanupTrees(manifest);
    return resultFor(manifest);
  }
  if (manifest.phase === "ready" && !options.retireReadyGeneration) {
    throw generationError(
      "The generation is still live. Revoke its native process authority before recovery with retireReadyGeneration=true.",
      "LIVE_GENERATION_REQUIRES_EXPLICIT_RETIREMENT",
    );
  }
  return retireAndReconcile(manifest, options.failpoint);
}

/** Reopen the validated exact generation for provider continuation recovery. */
export async function openSupervisedWorkspaceGeneration(manifestPath: string): Promise<SupervisedWorkspaceGenerationHandle> {
  return makeHandle(await loadManifest(manifestPath));
}

function makeHandle(
  manifest: GenerationManifest,
  failpoint?: SupervisedWorkspaceGenerationFailpointHandler,
): SupervisedWorkspaceGenerationHandle {
  return {
    generationId: manifest.generationId,
    manifestPath: manifestPathOf(manifest),
    sourceRoot: manifest.sourceRoot,
    realWorkspace: manifest.realWorkspace,
    liveSourceRoot: manifest.liveSourceRoot,
    liveWorkspace: manifest.liveWorkspace,
    readOnlyRoots: manifest.readOnlyRoots,
    retireAndReconcile: async () => retireAndReconcile(await loadManifest(manifestPathOf(manifest)), failpoint),
    recover: async (options = {}) => recoverSupervisedWorkspaceGeneration(manifestPathOf(manifest), {
      ...options,
      failpoint: options.failpoint ?? failpoint,
    }),
    abandon: async () => abandonManifest(await loadManifest(manifestPathOf(manifest)), failpoint),
  };
}

async function retireAndReconcile(
  initial: GenerationManifest,
  failpoint?: SupervisedWorkspaceGenerationFailpointHandler,
): Promise<SupervisedWorkspaceGenerationResult> {
  let manifest = initial;
  validateManifest(manifest);
  const inspections = new FileInspectionSession(manifest.limits.maxChangedPaths);
  const retiredRoot = join(manifest.generationRoot, RETIRED_NAME);
  const authorityRoot = join(manifest.generationRoot, AUTHORITY_NAME);
  if (manifest.phase === "ready") {
    await ensureQuarantined(manifest, retiredRoot, authorityRoot);
    manifest = await transition(manifest, "quarantined");
    await invokeFailpoint(failpoint, "after_quarantined", manifestPathOf(manifest));
  }
  if (manifest.phase === "quarantined") {
    await assertTrustedAuthority(manifest, authorityRoot);
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

async function abandonManifest(
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

async function ensureQuarantined(
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
  await assertNoProtectedPathAliases(retiredRoot, manifest.limits);
  await assertTrustedAuthority(manifest, authorityRoot);
}

async function assertNoProtectedPathAliases(
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
      const normalized = entry.name.normalize("NFC");
      const folded = normalized.toLowerCase();
      if ([".git", ".cursor", ".claude", ".letagents-fence"].includes(folded) && entry.name !== folded) {
        throw generationError(
          `Generation changed a case- or Unicode-normalization alias of protected workspace authority at ${JSON.stringify(relativePath)}.`,
          "PROTECTED_GENERATION_CHANGE",
        );
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(relativePath);
    }
  }
}

async function buildPlan(
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
    if (before) {
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

type PlanEntry =
  | { kind: "missing" | "blocked" | "directory" }
  | { kind: "file"; entry: TreeEntry; fullMode: number; metadataDigest: string };

async function inspectPlanEntry(
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

async function assertReplacementDirectoryContainsOnlyPlannedDeletes(
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

function compareOperationsForApply(a: ReconcileOperation, b: ReconcileOperation): number {
  if (a.kind !== b.kind) return a.kind === "delete" ? -1 : 1;
  const depthA = a.relativePath.split(sep).length;
  const depthB = b.relativePath.split(sep).length;
  if (a.kind === "delete" && depthA !== depthB) return depthB - depthA;
  if (a.kind === "write" && depthA !== depthB) return depthA - depthB;
  return compareUtf8(a.relativePath, b.relativePath);
}

function ancestorPaths(relativePath: string): string[] {
  const components = relativePath.split(sep);
  const result: string[] = [];
  for (let length = components.length - 1; length > 0; length -= 1) {
    result.push(components.slice(0, length).join(sep));
  }
  return result;
}

async function applyOperation(
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

async function linkIgnoredDependencyRoots(
  support: SupervisedWorkspaceGenerationSupport,
  liveRoot: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<SupervisedWorkspaceReadOnlyRoot[]> {
  const candidates = new Set<string>();
  for (const base of [support.sourceRoot, support.realWorkspace]) {
    for (const name of ["node_modules", ".pnpm", join(".yarn", "cache"), "vendor", ".venv"]) {
      candidates.add(join(base, name));
    }
  }
  const ignored = splitNul(await sourceAuthorityBuffer(
    support,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    limits.maxPatchBytes,
    sourceGitEnvironment(),
  ));
  if (ignored.length > limits.maxChangedPaths) throw limitError("ignored root discovery count", limits.maxChangedPaths);
  for (const entry of ignored) {
    const components = entry.replace(/[\\/]$/, "").split(/[\\/]+/).filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index]!;
      let end = -1;
      if (["node_modules", ".pnpm", "vendor", ".venv"].includes(component)) end = index + 1;
      else if (component === ".yarn" && components[index + 1] === "cache") end = index + 2;
      if (end > 0) {
        const relativePath = components.slice(0, end).join(sep);
        assertSafeRelativePath(relativePath, limits);
        candidates.add(join(support.sourceRoot, relativePath));
        break;
      }
    }
  }
  const mappings: SupervisedWorkspaceReadOnlyRoot[] = [];
  for (const candidate of candidates) {
    let info: Stats;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const sourceRelativePath = safeRelative(support.sourceRoot, candidate);
    assertSafeRelativePath(sourceRelativePath, limits);
    const ignored = await sourceAuthorityExitCode(
      support,
      ["check-ignore", "-q", "--", sourceRelativePath],
      sourceGitEnvironment(),
    );
    if (ignored !== 0) continue;
    const generationPath = join(liveRoot, sourceRelativePath);
    if (await pathExists(generationPath)) continue;
    await mkdir(dirname(generationPath), { recursive: true, mode: 0o700 });
    await symlink(candidate, generationPath, "dir");
    mappings.push({ sourcePath: candidate, generationPath, purpose: "dependency" });
  }
  return mappings;
}

async function installDependencyExcludes(
  gitDirectory: string,
  mappings: SupervisedWorkspaceReadOnlyRoot[],
  liveRoot: string,
  generationId: string,
): Promise<void> {
  const dependencyPaths = mappings
    .filter((entry): entry is SupervisedWorkspaceReadOnlyRoot & { generationPath: string } => entry.purpose === "dependency" && entry.generationPath !== null)
    .map((entry) => safeRelative(liveRoot, entry.generationPath))
    .sort(compareUtf8);
  if (dependencyPaths.length === 0) return;
  const excludePath = join(gitDirectory, "info", "exclude");
  const existing = await readFile(excludePath, "utf8").catch((error) => {
    if (isErrno(error, "ENOENT")) return "";
    throw error;
  });
  const suffix = dependencyPaths.map((relativePath) => `/${relativePath}`).join("\n");
  await atomicWrite(excludePath, Buffer.from(`${existing.replace(/\s*$/, "\n")}${suffix}\n`), 0o600, generationId);
}

async function readSafeAlternateRoots(
  liveRoot: string,
  expectedObjectRoot: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<string[]> {
  const alternatesPath = join(liveRoot, ".git", "objects", "info", "alternates");
  const info = await lstat(alternatesPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFileBytes) {
    throw generationError("The shared clone's alternates file is unsafe.", "UNSAFE_GIT_ALTERNATES");
  }
  const roots = (await readFile(alternatesPath, "utf8")).split(/\r?\n/).filter(Boolean);
  if (roots.length !== 1 || !isAbsolute(roots[0]!)) throw generationError("The shared clone did not produce one absolute object alternate.", "UNSAFE_GIT_ALTERNATES");
  const canonical = await realpath(roots[0]!);
  if (canonical !== expectedObjectRoot) throw generationError("The shared clone points at an unexpected Git object directory.", "UNSAFE_GIT_ALTERNATES");
  return [canonical];
}

async function disablePrivateGitAuthority(liveRoot: string): Promise<void> {
  await runGit(liveRoot, ["config", "--local", "core.hooksPath", "/dev/null"], 1024 * 1024);
  await runGit(liveRoot, ["config", "--local", "core.fsmonitor", "false"], 1024 * 1024);
  await runGit(liveRoot, ["config", "--local", "gc.auto", "0"], 1024 * 1024);
}

async function disableTrustedGitAuthority(authorityRoot: string): Promise<void> {
  await chmod(authorityRoot, 0o700);
  await runGit(authorityRoot, ["config", "--local", "core.hooksPath", "/dev/null"], 1024 * 1024);
  await runGit(authorityRoot, ["config", "--local", "core.fsmonitor", "false"], 1024 * 1024);
  await runGit(authorityRoot, ["config", "--local", "gc.auto", "0"], 1024 * 1024);
}

async function assertSafeBareAlternateRoot(
  authorityRoot: string,
  expectedObjectRoot: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<void> {
  const alternatesPath = join(authorityRoot, "objects", "info", "alternates");
  const info = await lstat(alternatesPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFileBytes) {
    throw generationError("The trusted shared authority's alternates file is unsafe.", "UNSAFE_GIT_ALTERNATES");
  }
  const roots = (await readFile(alternatesPath, "utf8")).split(/\r?\n/).filter(Boolean);
  if (roots.length !== 1 || !isAbsolute(roots[0]!) || await realpath(roots[0]!) !== expectedObjectRoot) {
    throw generationError("The trusted shared authority points at an unexpected object directory.", "UNSAFE_GIT_ALTERNATES");
  }
}

async function assertTrustedAuthority(manifest: GenerationManifest, authorityRoot: string): Promise<void> {
  const info = await lstat(authorityRoot).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o077) !== 0 || authorityRoot !== join(manifest.generationRoot, AUTHORITY_NAME)) {
    throw generationError("Supervisor-owned Git authority disappeared or was redirected.", "GIT_AUTHORITY_MISSING");
  }
  const objectRoot = manifest.readOnlyRoots.find((entry) => entry.purpose === "git-objects")?.sourcePath;
  if (!objectRoot) throw generationError("The sealed Git object authority is missing.", "INVALID_MANIFEST");
  await assertSafeBareAlternateRoot(authorityRoot, objectRoot, manifest.limits);
  const baselineRoot = join(manifest.generationRoot, BASELINE_FILES_NAME);
  const baselineInfo = await lstat(baselineRoot).catch(() => null);
  if (!baselineInfo?.isDirectory() || baselineInfo.isSymbolicLink() || baselineInfo.uid !== process.getuid?.()
    || (baselineInfo.mode & 0o077) !== 0) {
    throw generationError("Supervisor-owned baseline metadata disappeared or was redirected.", "INVALID_BASELINE_METADATA");
  }
}

async function assertIndexHasNoLinksOrGitlinks(authority: SourceGitAuthority, limits: SupervisedWorkspaceGenerationLimits): Promise<void> {
  const output = await sourceAuthorityBuffer(authority, ["ls-files", "-s", "-z"], limits.maxPatchBytes);
  for (const record of splitNulBuffer(output)) {
    const mode = record.subarray(0, record.indexOf(0x20)).toString("ascii");
    if (mode === "120000" || mode === "160000") {
      throw generationError(SUPERVISED_WORKSPACE_GENERATION_LIMITATION, "TRACKED_LINK_OR_GITLINK_UNSUPPORTED");
    }
  }
}

async function assertNoUnmergedEntries(authority: SourceGitAuthority, limits: SupervisedWorkspaceGenerationLimits): Promise<void> {
  const output = await sourceAuthorityBuffer(authority, ["ls-files", "-u", "-z"], limits.maxPatchBytes);
  if (output.length > 0) throw generationError("Unmerged index entries cannot be reproduced safely.", "UNMERGED_INDEX_UNSUPPORTED");
}

async function assertSparseCheckoutDisabled(authority: SourceGitAuthority): Promise<void> {
  const configured = await sourceAuthorityBuffer(authority, ["config", "--bool", "core.sparseCheckout"], 1024)
    .then((value) => value.toString("utf8").trim() === "true")
    .catch((error) => {
      if (error instanceof ProcessExitError && error.exitCode === 1) return false;
      throw error;
    });
  const sparseIndex = await sourceAuthorityBuffer(authority, ["config", "--bool", "index.sparse"], 1024)
    .then((value) => value.toString("utf8").trim() === "true")
    .catch((error) => {
      if (error instanceof ProcessExitError && error.exitCode === 1) return false;
      throw error;
    });
  if (configured || sparseIndex) {
    throw generationError("Sparse-checkout worktrees are not supported by writable supervised generations.", "SPARSE_CHECKOUT_UNSUPPORTED");
  }
}

async function assertSourceWorktreeWithinLimits(authority: SourceGitAuthority, limits: SupervisedWorkspaceGenerationLimits): Promise<void> {
  const sourceRoot = authority.sourceRoot;
  const { tracked, untracked } = await sourceVisiblePaths(authority, limits);
  for (const relativePath of tracked) {
    assertSafeRelativePath(relativePath, limits);
    let info: Stats;
    try { info = await lstat(join(sourceRoot, relativePath)); }
    catch (error) { if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) continue; throw error; }
    if (info.isDirectory() && !info.isSymbolicLink()) continue;
    if (info.isFile() && info.size > limits.maxFileBytes) throw limitError("file size", limits.maxFileBytes);
  }
  let total = 0;
  for (const relativePath of untracked) {
    assertSafeRelativePath(relativePath, limits);
    await assertSafeAncestors(sourceRoot, relativePath, false);
    const info = await lstat(join(sourceRoot, relativePath));
    if (!info.isFile() || info.isSymbolicLink()) {
      throw generationError(`Untracked symlink or special file denied at ${JSON.stringify(relativePath)}.`, "UNTRACKED_SPECIAL_FILE_UNSUPPORTED");
    }
    total += info.size;
    if (info.size > limits.maxFileBytes || total > limits.maxTotalUntrackedBytes) {
      throw limitError("untracked bytes", limits.maxTotalUntrackedBytes);
    }
  }
}

async function assertClonefileSupported(parent: string): Promise<void> {
  const probeRoot = join(parent, `.letagents-clonefile-probe-${randomBytes(12).toString("hex")}`);
  const source = join(probeRoot, "source");
  const destination = join(probeRoot, "destination");
  try {
    await mkdir(probeRoot, { mode: 0o700 });
    const descriptor = await open(source, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await descriptor.writeFile("clonefile-probe\n"); await descriptor.sync(); } finally { await descriptor.close(); }
    await cloneRegularFile(source, destination, 1024 * 1024);
    const [before, after] = await Promise.all([lstat(source), lstat(destination)]);
    if (!after.isFile() || before.dev !== after.dev || before.ino === after.ino || after.nlink !== 1) {
      throw generationError("The adjacent generation filesystem did not prove isolated clonefile support.", "CLONE_ISOLATION_UNPROVEN");
    }
  } catch (error) {
    if (error instanceof SupervisedWorkspaceGenerationError) throw error;
    throw generationError(`The adjacent generation filesystem does not support clonefile isolation: ${error instanceof Error ? error.message : String(error)}`, "CLONE_FILESYSTEM_UNSUPPORTED");
  } finally {
    await rm(probeRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
  }
}

async function prepareOperationStages(
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

async function freezeDesiredStages(
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
