/** The public entry points: support checks, create, recover, open and remove a generation, and its handle. */
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createPrivateDir, isOwnedByCurrentUser, protectOwnerPrivate } from "../../../../../../shared/owner-private-fs.mjs";
import { AUTHORITY_NAME, BASELINE_FILES_NAME, BASELINE_INDEX_NAME, type CreateSupervisedWorkspaceGenerationOptions, DEFAULT_LIMITS, type GenerationManifest, LIVE_NAME, MANIFEST_NAME, MANIFEST_VERSION, PROVIDER_GIT_NAME, type RecoverSupervisedWorkspaceGenerationOptions, SUPERVISED_WORKSPACE_GENERATION_LIMITATION, type SourceGitAuthority, type SupervisedWorkspaceGenerationFailpointHandler, type SupervisedWorkspaceGenerationHandle, type SupervisedWorkspaceGenerationLimits, type SupervisedWorkspaceGenerationResult, type SupervisedWorkspaceGenerationSupport, type SupervisedWorkspaceReadOnlyRoot } from "./types.js";
import { FileInspectionSession, validateAppliedOperationArtifacts } from "./file-inspection.js";
import { ProcessExitError, canonicalGitControlTarget, discoverSourceGitText, gitControlPath, gitOutputPath, gitText, readStableGitControlFile, runGit, sourceAuthorityText } from "./git.js";
import { abandonManifest, retireAndReconcile } from "./reconcile.js";
import { assertClonePlatform, fsyncDirectory, generationDirectoryName, generationError, generationIdFor, invokeFailpoint, isErrno, isWindowsGeneration, manifestPathOf, normalizeLimits, resultFor, safeRelative } from "./helpers.js";
import { assertClonefileSupported, assertIndexHasNoLinksOrGitlinks, assertNoUnmergedEntries, assertSafeBareAlternateRoot, assertSourceWorktreeWithinLimits, assertSparseCheckoutDisabled, disablePrivateGitAuthority, disableTrustedGitAuthority, installDependencyExcludes, linkIgnoredDependencyRoots, readSafeAlternateRoots } from "./source-authority.js";
import { cleanupTrees, loadManifest, persistManifest, transition } from "./manifest.js";
import { materializeSourceWorktree, pinPrivateCloneHead, reproduceProviderIndex, snapshotWorktree, sourceVisiblePaths } from "./worktree.js";
import { WINDOWS_FRESH_WORKTREE_NOTE, assertGenerationObjectsComplete, assertWindowsFreeSpace, assertWindowsFullClone, carryDirtyTrackedFiles, prepareWindowsWorktree, recordWindowsBaselineModes, sealRawSnapshotAuthority } from "./worktree-windows.js";

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
  const sourceRoot = gitOutputPath(await discoverSourceGitText(realWorkspace, ["rev-parse", "--show-toplevel"]));
  const canonicalSourceRoot = await realpath(sourceRoot);
  if (sourceRoot !== canonicalSourceRoot || resolve(sourceRoot) !== sourceRoot) {
    throw generationError("The Git top-level is symlinked or redirected.", "REDIRECTED_GIT_ROOT");
  }
  const workspaceRelativePath = safeRelative(sourceRoot, realWorkspace);
  const gitDirectoryRaw = gitOutputPath(await discoverSourceGitText(sourceRoot, ["rev-parse", "--absolute-git-dir"]));
  if (!isAbsolute(gitDirectoryRaw) || resolve(gitDirectoryRaw) !== gitDirectoryRaw) {
    throw generationError("The Git directory is not canonical.", "REDIRECTED_GIT_ROOT");
  }
  const gitDirectory = await realpath(gitDirectoryRaw);
  if (gitDirectory !== gitDirectoryRaw) {
    throw generationError("The Git directory is symlinked or redirected.", "REDIRECTED_GIT_ROOT");
  }
  const expectedGitDirectory = join(sourceRoot, ".git");
  const gitInfo = await lstat(expectedGitDirectory).catch(() => null);
  const commonDirectoryRaw = gitOutputPath(await discoverSourceGitText(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
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
  const pinnedSourceRoot = gitOutputPath(await sourceAuthorityText(sourceAuthority, ["rev-parse", "--show-toplevel"]));
  if (pinnedSourceRoot !== sourceRoot) {
    throw generationError("Pinned Git authority does not match the selected worktree.", "REDIRECTED_GIT_ROOT");
  }
  const headOid = await sourceAuthorityText(sourceAuthority, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const headRef = await sourceAuthorityText(sourceAuthority, ["symbolic-ref", "-q", "HEAD"])
    .catch((error) => {
      if (error instanceof ProcessExitError && error.exitCode === 1) return null;
      throw error;
    });
  const gitIndexPathRaw = gitOutputPath(await sourceAuthorityText(sourceAuthority, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
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
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !await isOwnedByCurrentUser(parent, parentInfo)) {
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
  if (!isWindowsGeneration()) await access("/bin/cp", fsConstants.X_OK);
  await gitText(sourceRoot, ["--version"]);
  const gitObjectPath = gitOutputPath(await sourceAuthorityText(sourceAuthority, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]));
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
    throw generationError(isWindowsGeneration()
      ? "The repository and its adjacent generation parent are on different volumes; reconciliation hard links cannot cross them."
      : "The repository and its adjacent generation parent are on different filesystems; clonefile isolation cannot be guaranteed.", "CLONE_FILESYSTEM_MISMATCH");
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
  if (isWindowsGeneration()) {
    await assertWindowsFullClone(support);
    await assertWindowsFreeSpace(support, parent, DEFAULT_LIMITS);
  } else await assertClonefileSupported(parent);
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
  await protectOwnerPrivate(generationRoot, "directory");
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

    const { baselineTreeOid, alternateRoots, dependencyRoots } = isWindowsGeneration()
      ? await prepareWindowsGeneration(support, generationRoot, liveSourceRoot, generationId, limits)
      : await prepareCloneGeneration(support, generationRoot, liveSourceRoot, generationId, limits);
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

interface PreparedGeneration {
  baselineTreeOid: string;
  alternateRoots: string[];
  dependencyRoots: SupervisedWorkspaceReadOnlyRoot[];
}

async function prepareCloneGeneration(
  support: SupervisedWorkspaceGenerationSupport,
  generationRoot: string,
  liveSourceRoot: string,
  generationId: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<PreparedGeneration> {
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
  await createPrivateDir(baselineFilesRoot);
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
  return { baselineTreeOid, alternateRoots, dependencyRoots };
}

/**
 * Windows: the supervisor authority is the same private bare clone, sealed
 * for raw snapshots; the provider gets a detached worktree of its own private
 * clone (worktree-windows.ts). baseline-files holds no copies, only the
 * tracked files' recorded modes (recordWindowsBaselineModes).
 */
async function prepareWindowsGeneration(
  support: SupervisedWorkspaceGenerationSupport,
  generationRoot: string,
  liveSourceRoot: string,
  generationId: string,
  limits: SupervisedWorkspaceGenerationLimits,
): Promise<PreparedGeneration> {
  const authorityRoot = join(generationRoot, AUTHORITY_NAME);
  await runGit(support.sourceRoot, [
    "clone", "--shared", "--bare", "--no-hardlinks", "--", support.gitCommonDirectory, authorityRoot,
  ], limits.maxPatchBytes);
  await disableTrustedGitAuthority(authorityRoot);
  await sealRawSnapshotAuthority(authorityRoot);
  const providerGit = await prepareWindowsWorktree(support, generationRoot, liveSourceRoot, limits);
  await createPrivateDir(join(generationRoot, BASELINE_FILES_NAME));
  const { tracked } = await sourceVisiblePaths(support, limits);
  const baselineModes = await recordWindowsBaselineModes(support, join(generationRoot, BASELINE_FILES_NAME), tracked, limits);
  const dependencyRoots = await linkIgnoredDependencyRoots(support, liveSourceRoot, limits);
  await installDependencyExcludes(providerGit, dependencyRoots, liveSourceRoot, generationId);
  await installDependencyExcludes(authorityRoot, dependencyRoots, liveSourceRoot, generationId);
  await assertSafeBareAlternateRoot(providerGit, support.gitObjectDirectory, limits);
  await assertSafeBareAlternateRoot(authorityRoot, support.gitObjectDirectory, limits);
  const sourceTree = await carryDirtyTrackedFiles(support, authorityRoot, providerGit, liveSourceRoot, tracked, baselineModes, limits);
  const baselineTreeOid = await snapshotWorktree(
    authorityRoot,
    liveSourceRoot,
    join(authorityRoot, BASELINE_INDEX_NAME),
    support.headOid,
    limits,
  );
  if (baselineTreeOid !== sourceTree) {
    throw generationError("The workspace changed while its Git worktree was prepared, or holds a tracked file Git ignores.", "GENERATION_SOURCE_CHANGED");
  }
  return { baselineTreeOid, alternateRoots: [support.gitObjectDirectory], dependencyRoots };
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
  const manifest = await loadManifest(manifestPath);
  if (isWindowsGeneration() && manifest.phase === "ready") {
    await assertGenerationObjectsComplete(
      join(manifest.generationRoot, AUTHORITY_NAME),
      [manifest.headOid, manifest.baselineTreeOid!],
      manifest.limits,
      { gitDirectory: join(manifest.generationRoot, PROVIDER_GIT_NAME), liveSourceRoot: manifest.liveSourceRoot, headOid: manifest.headOid },
    );
  }
  return makeHandle(manifest);
}

export function makeHandle(
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
    workspaceNote: isWindowsGeneration() ? WINDOWS_FRESH_WORKTREE_NOTE : null,
    retireAndReconcile: async () => retireAndReconcile(await loadManifest(manifestPathOf(manifest)), failpoint),
    recover: async (options = {}) => recoverSupervisedWorkspaceGeneration(manifestPathOf(manifest), {
      ...options,
      failpoint: options.failpoint ?? failpoint,
    }),
    abandon: async () => abandonManifest(await loadManifest(manifestPathOf(manifest)), failpoint),
  };
}
