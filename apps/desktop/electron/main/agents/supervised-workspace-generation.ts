import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, type BigIntStats, type Stats } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MANIFEST_VERSION = 3 as const;
const MANIFEST_NAME = "generation-manifest.json";
const LIVE_NAME = "live";
const RETIRED_NAME = "retired";
const AUTHORITY_NAME = "private-git";
const BASELINE_FILES_NAME = "baseline-files";
const STAGING_NAME = "reconcile-staging";
const BASELINE_INDEX_NAME = "letagents-baseline.index";
const FINAL_INDEX_NAME = "letagents-final.index";

export const SUPERVISED_WORKSPACE_GENERATION_LIMITATION =
  "Writable supervised generations require macOS clonefile support and a canonical Git worktree. Submodules, separate Git directories, object alternates, tracked symlinks/gitlinks, and arbitrary ignored writable content are not supported. Ignored dependency roots are exposed separately and must be sandboxed read-only by the caller.";

export type SupervisedWorkspaceGenerationPhase =
  | "preparing"
  | "ready"
  | "quarantined"
  | "frozen"
  | "planned"
  | "applying"
  | "committed"
  | "cleaned"
  | "aborted";

export type SupervisedWorkspaceGenerationFailpoint =
  | "after_preparing"
  | "after_ready"
  | "after_quarantined"
  | "after_frozen"
  | "after_planned"
  | "after_applying"
  | "after_operation_effect"
  | "after_operation"
  | "after_committed"
  | "after_cleaned"
  | "after_aborted";

export interface SupervisedWorkspaceGenerationLimits {
  maxChangedPaths: number;
  maxFileBytes: number;
  maxPatchBytes: number;
  maxTotalUntrackedBytes: number;
  maxRelativePathBytes: number;
}

export interface SupervisedWorkspaceGenerationSupport {
  sourceRoot: string;
  realWorkspace: string;
  workspaceRelativePath: string;
  headOid: string;
  headRef: string | null;
  gitDirectory: string;
  gitCommonDirectory: string;
  gitIndexPath: string;
  gitObjectDirectory: string;
}

type SourceGitAuthority = Pick<
  SupervisedWorkspaceGenerationSupport,
  "sourceRoot" | "gitDirectory" | "gitCommonDirectory"
>;

export interface SupervisedWorkspaceReadOnlyRoot {
  sourcePath: string;
  generationPath: string | null;
  purpose: "git-objects" | "dependency";
}

export type SupervisedWorkspaceGenerationFailpointHandler = (
  point: SupervisedWorkspaceGenerationFailpoint,
  manifestPath: string,
) => void | Promise<void>;

export interface CreateSupervisedWorkspaceGenerationOptions {
  realWorkspace: string;
  /** Used only as SHA-256 input. The raw turn identity is never persisted. */
  turnIdentity: string;
  limits?: Partial<SupervisedWorkspaceGenerationLimits>;
  failpoint?: SupervisedWorkspaceGenerationFailpointHandler;
}

export interface RecoverSupervisedWorkspaceGenerationOptions {
  /** The caller must revoke the old process authority before setting this. */
  retireReadyGeneration?: boolean;
  failpoint?: SupervisedWorkspaceGenerationFailpointHandler;
}

export interface SupervisedWorkspaceGenerationResult {
  phase: SupervisedWorkspaceGenerationPhase;
  appliedPaths: string[];
  manifestPath: string;
}

export interface SupervisedWorkspaceGenerationHandle {
  readonly generationId: string;
  readonly manifestPath: string;
  readonly sourceRoot: string;
  readonly realWorkspace: string;
  readonly liveSourceRoot: string;
  readonly liveWorkspace: string;
  readonly readOnlyRoots: readonly SupervisedWorkspaceReadOnlyRoot[];
  retireAndReconcile(): Promise<SupervisedWorkspaceGenerationResult>;
  recover(options?: RecoverSupervisedWorkspaceGenerationOptions): Promise<SupervisedWorkspaceGenerationResult>;
  abandon(): Promise<SupervisedWorkspaceGenerationResult>;
}

export class SupervisedWorkspaceGenerationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SupervisedWorkspaceGenerationError";
  }
}

export class SupervisedWorkspaceConflictError extends SupervisedWorkspaceGenerationError {
  constructor(readonly relativePath: string, detail: string) {
    super(`The real workspace changed concurrently at ${JSON.stringify(relativePath)}: ${detail}`, "WORKSPACE_CONFLICT");
    this.name = "SupervisedWorkspaceConflictError";
  }
}

interface TreeEntry {
  mode: "100644" | "100755";
  oid: string;
}

interface ReconcileOperation {
  id: string;
  kind: "write" | "delete";
  relativePath: string;
  sourceRelativePath: string;
  baseline: TreeEntry | null;
  desired: TreeEntry | null;
  baselineMode: number | null;
  desiredMode: number | null;
  baselineMetadataDigest: string | null;
  desiredMetadataDigest: string | null;
  stagingRelativePath: string | null;
  desiredArtifactRelativePath: string | null;
  displacedArtifactRelativePath: string | null;
  status: "pending" | "applied";
}

interface GenerationManifest {
  version: typeof MANIFEST_VERSION;
  generationId: string;
  phase: SupervisedWorkspaceGenerationPhase;
  sourceRoot: string;
  realWorkspace: string;
  workspaceRelativePath: string;
  generationRoot: string;
  liveSourceRoot: string;
  liveWorkspace: string;
  headOid: string;
  sourceGitObjectDirectory: string;
  baselineTreeOid: string | null;
  finalTreeOid: string | null;
  readOnlyRoots: SupervisedWorkspaceReadOnlyRoot[];
  limits: SupervisedWorkspaceGenerationLimits;
  operationJournal: ReconcileOperation[];
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_LIMITS: SupervisedWorkspaceGenerationLimits = {
  maxChangedPaths: 25_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxPatchBytes: 256 * 1024 * 1024,
  maxTotalUntrackedBytes: 2 * 1024 * 1024 * 1024,
  maxRelativePathBytes: 4_096,
};

// Git honors a large ambient control surface (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, object alternates, injected config pairs, and helpers).
// Never inherit it into trusted generation/reconciliation commands.
const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: "/tmp",
  HOME: "/var/empty",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
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
function sourceGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: "/tmp",
    HOME: process.env.HOME || "/var/empty",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
  };
}

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
export async function removeSupervisedWorkspaceGenerationReceipt(manifestPath: string): Promise<void> {
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
  if (manifest.phase === "cleaned") {
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

type ExactFileState = { entry: TreeEntry; fullMode: number; metadataDigest: string; dev: bigint; ino: bigint };

type RegularFileInfo = Pick<Stats, "size" | "mode" | "uid" | "gid">;

/**
 * Bound expensive content/flags/ACL/xattr probes to one reconciliation call.
 * A cache hit still performs a fresh no-follow lstat and is valid only for the
 * same inode version, including nanosecond change times and link count. Crash
 * recovery and receipt cleanup create new sessions. Do not batch the textual
 * ls/xattr protocols across paths: valid Git filenames can spoof their record
 * separators.
 */
class FileInspectionSession {
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

function fileVersionKey(info: BigIntStats): string {
  return [
    info.dev, info.ino, info.birthtimeNs, info.ctimeNs, info.mtimeNs,
    info.size, info.mode, info.uid, info.gid, info.nlink,
  ].join(":");
}

async function inspectExactFile(
  manifest: GenerationManifest,
  target: string,
  relativePathForError: string | undefined,
  inspections: FileInspectionSession,
): Promise<ExactFileState | null> {
  return inspections.inspect(manifest, target, relativePathForError);
}

function matchesOperationState(
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

async function ensureDesiredArtifact(
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

async function restoreDisplacedWithoutOverwrite(
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

async function validateAppliedOperationArtifacts(
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

type DirectoryIdentity = { canonical: string; dev: number; ino: number };

async function canonicalDirectoryIdentity(parent: string, root: string, relativePath: string): Promise<DirectoryIdentity> {
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SupervisedWorkspaceConflictError(relativePath, "the target parent is not a real directory");
  const canonical = await realpath(parent);
  safeRelative(root, canonical);
  return { canonical, dev: info.dev, ino: info.ino };
}

async function assertCanonicalDirectoryIdentity(parent: string, expected: DirectoryIdentity, root: string, relativePath: string): Promise<void> {
  const actual = await canonicalDirectoryIdentity(parent, root, relativePath);
  if (actual.canonical !== expected.canonical || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new SupervisedWorkspaceConflictError(relativePath, "the target parent was swapped during reconciliation");
  }
}

async function reproduceProviderIndex(sourceIndex: string, liveRoot: string, limits: SupervisedWorkspaceGenerationLimits): Promise<void> {
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

async function pinPrivateCloneHead(liveRoot: string, headOid: string, headRef: string | null): Promise<void> {
  if (headRef) {
    await runGit(liveRoot, ["update-ref", headRef, headOid], 1024 * 1024);
    await runGit(liveRoot, ["symbolic-ref", "HEAD", headRef], 1024 * 1024);
  } else {
    await runGit(liveRoot, ["update-ref", "--no-deref", "HEAD", headOid], 1024 * 1024);
  }
  await runGit(liveRoot, ["remote", "remove", "origin"], 1024 * 1024);
}

async function sourceVisiblePaths(
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

async function materializeSourceWorktree(
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

async function snapshotWorktree(
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

async function diffTreeEntries(
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

async function assertTreeHasNoNormalizedPathCollisions(
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

function rawTreeEntry(mode: string, oid: string, relativePath: string): TreeEntry | null {
  if (mode === "000000") return null;
  if (mode !== "100644" && mode !== "100755") {
    throw generationError(`Symlink, gitlink, or unsupported tree entry denied at ${JSON.stringify(relativePath)}.`, "UNSUPPORTED_GIT_TREE_ENTRY");
  }
  if (/^0+$/.test(oid)) throw generationError("Git changed-tree entry has an invalid object id.", "INVALID_GIT_TREE");
  return { mode, oid };
}

async function inspectRealEntry(manifest: GenerationManifest, relativePath: string): Promise<TreeEntry | null> {
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

async function treeEntryForRegularFile(
  manifest: GenerationManifest,
  target: string,
  info: RegularFileInfo,
  expectedVersionKey?: string,
  relativePathForError?: string,
): Promise<TreeEntry> {
  if (info.size > manifest.limits.maxFileBytes) throw limitError("file size", manifest.limits.maxFileBytes);
  const relativePath = relativePathForError ?? safeRelative(manifest.realWorkspace, target);
  const descriptor = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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

async function macFileMetadataDigest(
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

async function removeEmptyAncestors(start: string, root: string): Promise<void> {
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

async function readGitBlob(gitDirectory: string, oid: string, limits: SupervisedWorkspaceGenerationLimits): Promise<Buffer> {
  const sizeText = await gitAuthorityText(gitDirectory, null, ["cat-file", "-s", oid], 1024);
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) throw limitError("file size", limits.maxFileBytes);
  const content = await gitAuthorityBuffer(gitDirectory, null, ["cat-file", "blob", oid], size + 1);
  if (content.length !== size) throw generationError("Git blob length did not match its declared size.", "INVALID_GIT_BLOB");
  return content;
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

async function atomicWrite(target: string, content: Buffer, mode: number, generationId: string): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.letagents-${generationId}-${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let closed = false;
  try {
    await descriptor.writeFile(content);
    await descriptor.chmod(mode);
    await descriptor.sync();
    await descriptor.close();
    closed = true;
    await rename(temporary, target);
    await fsyncDirectory(dirname(target));
  } catch (error) {
    if (!closed) await descriptor.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function assertSafeAncestors(root: string, relativePath: string, createMissing: boolean): Promise<void> {
  const components = relativePath.split(sep).filter(Boolean);
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isErrno(error, "ENOENT") && !createMissing) return;
      if (!isErrno(error, "ENOENT")) throw error;
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SupervisedWorkspaceConflictError(relativePath, "an ancestor is not a real directory");
    }
    safeRelative(root, await realpath(current));
  }
}

async function persistManifest(manifest: GenerationManifest): Promise<void> {
  validateManifest(manifest);
  const destination = manifestPathOf(manifest);
  const temporary = join(manifest.generationRoot, `.${MANIFEST_NAME}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let closed = false;
  try {
    await descriptor.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await descriptor.sync();
    await descriptor.close();
    closed = true;
    await rename(temporary, destination);
    await fsyncDirectory(manifest.generationRoot);
  } catch (error) {
    if (!closed) await descriptor.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function loadManifest(manifestPath: string): Promise<GenerationManifest> {
  const resolvedPath = resolve(manifestPath);
  const descriptor = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
      throw generationError("Manifest is not a bounded owner-private regular file.", "INVALID_MANIFEST");
    }
    const parsed: unknown = normalizeManifestVersion(JSON.parse(await descriptor.readFile("utf8")));
    if (!isManifest(parsed)) throw generationError("Manifest schema is invalid.", "INVALID_MANIFEST");
    validateManifest(parsed);
    if (manifestPathOf(parsed) !== resolvedPath) throw generationError("Manifest path does not match its generation root.", "INVALID_MANIFEST");
    const rootInfo = await lstat(parsed.generationRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0 || rootInfo.uid !== process.getuid?.()) {
      throw generationError("Generation root is not an owner-private real directory.", "INVALID_MANIFEST");
    }
    if (await realpath(parsed.sourceRoot) !== parsed.sourceRoot || await realpath(parsed.realWorkspace) !== parsed.realWorkspace) {
      throw generationError("Manifest source paths are no longer canonical.", "INVALID_MANIFEST");
    }
    return parsed;
  } finally {
    await descriptor.close();
  }
}

async function transition(
  manifest: GenerationManifest,
  phase: SupervisedWorkspaceGenerationPhase,
  patch: Partial<GenerationManifest> = {},
): Promise<GenerationManifest> {
  const next = { ...manifest, ...patch, phase, updatedAt: new Date().toISOString() };
  await persistManifest(next);
  return next;
}

function validateManifest(manifest: GenerationManifest): void {
  assertManifestLimits(manifest.limits);
  if (manifest.operationJournal.length > manifest.limits.maxChangedPaths) {
    throw generationError("Manifest operation journal exceeds its durable limit.", "INVALID_MANIFEST");
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isFinite(Date.parse(manifest.updatedAt))) {
    throw generationError("Manifest timestamps are invalid.", "INVALID_MANIFEST");
  }
  const root = resolve(manifest.generationRoot);
  if (root !== manifest.generationRoot || manifest.liveSourceRoot !== join(root, LIVE_NAME)) throw generationError("Manifest paths were altered.", "INVALID_MANIFEST");
  const expectedRoot = join(dirname(manifest.sourceRoot), generationDirectoryName(manifest.sourceRoot, manifest.generationId));
  if (root !== expectedRoot) throw generationError("Generation root does not match its source and identity.", "INVALID_MANIFEST");
  const expectedWorkspace = manifest.workspaceRelativePath === "" ? manifest.liveSourceRoot : join(manifest.liveSourceRoot, manifest.workspaceRelativePath);
  if (expectedWorkspace !== manifest.liveWorkspace || safeRelative(manifest.sourceRoot, manifest.realWorkspace) !== manifest.workspaceRelativePath) {
    throw generationError("Manifest workspace mapping was altered.", "INVALID_MANIFEST");
  }
  if (!isAbsolute(manifest.sourceGitObjectDirectory)
    || resolve(manifest.sourceGitObjectDirectory) !== manifest.sourceGitObjectDirectory
    || basename(manifest.sourceGitObjectDirectory) !== "objects") {
    throw generationError("Manifest Git-object authority is invalid.", "INVALID_MANIFEST");
  }
  let gitObjectRoots = 0;
  for (const entry of manifest.readOnlyRoots) {
    if (!isAbsolute(entry.sourcePath) || (entry.purpose !== "git-objects" && entry.purpose !== "dependency")) {
      throw generationError("Manifest read-only roots are invalid.", "INVALID_MANIFEST");
    }
    if (entry.purpose === "git-objects") {
      gitObjectRoots += 1;
      if (entry.generationPath !== null || entry.sourcePath !== manifest.sourceGitObjectDirectory) {
        throw generationError("Manifest Git-object authority was widened.", "INVALID_MANIFEST");
      }
    } else {
      const sourceRelativePath = safeRelative(manifest.sourceRoot, entry.sourcePath);
      if (entry.generationPath !== join(manifest.liveSourceRoot, sourceRelativePath)) {
        throw generationError("Manifest dependency mapping was altered.", "INVALID_MANIFEST");
      }
    }
  }
  if (gitObjectRoots > 1) {
    throw generationError("Manifest contains duplicate Git-object authority.", "INVALID_MANIFEST");
  }
  const operationIds = new Set<string>();
  for (const operation of manifest.operationJournal) {
    if ((operation.kind !== "write" && operation.kind !== "delete") || (operation.status !== "pending" && operation.status !== "applied")) {
      throw generationError("Manifest operation journal is invalid.", "INVALID_MANIFEST");
    }
    assertSafeRelativePath(operation.relativePath, manifest.limits);
    assertSafeRelativePath(operation.sourceRelativePath, manifest.limits);
    if (projectRelativePath(operation.sourceRelativePath, manifest.workspaceRelativePath) !== operation.relativePath) {
      throw generationError("Manifest operation mapping was altered.", "INVALID_MANIFEST");
    }
    assertTreeEntry(operation.baseline);
    assertTreeEntry(operation.desired);
    if ((operation.kind === "write" && operation.desired === null)
      || (operation.kind === "delete" && (operation.baseline === null || operation.desired !== null))) {
      throw generationError("Manifest operation kind does not match its tree entries.", "INVALID_MANIFEST");
    }
    const expectedId = operationId(
      operation.sourceRelativePath,
      operation.baseline,
      operation.desired,
    );
    const validMode = (mode: number | null): boolean => mode === null || (Number.isInteger(mode) && mode >= 0 && mode <= 0o7777);
    const validDigest = (digest: string | null): boolean => digest === null || /^[a-f0-9]{64}$/.test(digest);
    const expectedStage = operation.desired ? join(STAGING_NAME, `${operation.id}.desired`) : null;
    const expectedTemporary = operation.desired ? join(STAGING_NAME, `${operation.id}.commit`) : null;
    const expectedGuard = operation.baseline ? join(STAGING_NAME, `${operation.id}.displaced`) : null;
    if (operation.id !== expectedId || operationIds.has(operation.id) || isProtectedPath(operation.relativePath)
      || !validMode(operation.baselineMode) || !validMode(operation.desiredMode)
      || !validDigest(operation.baselineMetadataDigest) || !validDigest(operation.desiredMetadataDigest)
      || (operation.baseline !== null) !== (operation.baselineMode !== null)
      || (operation.desired !== null) !== (operation.desiredMode !== null)
      || (operation.baseline !== null) !== (operation.baselineMetadataDigest !== null)
      || (operation.desired !== null) !== (operation.desiredMetadataDigest !== null)
      || operation.stagingRelativePath !== expectedStage
      || operation.desiredArtifactRelativePath !== expectedTemporary
      || operation.displacedArtifactRelativePath !== expectedGuard) {
      throw generationError("Manifest operation identity is invalid.", "INVALID_MANIFEST");
    }
    operationIds.add(operation.id);
  }
  assertManifestPhaseShape(manifest);
}

function assertManifestLimits(value: unknown): asserts value is SupervisedWorkspaceGenerationLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw generationError("Manifest limits are invalid.", "INVALID_MANIFEST");
  }
  const candidate = value as Record<string, unknown>;
  const required = Object.keys(DEFAULT_LIMITS);
  if (Object.keys(candidate).length !== required.length
    || required.some((key) => !Object.hasOwn(candidate, key))) {
    throw generationError("Manifest limits are invalid.", "INVALID_MANIFEST");
  }
  for (const key of required) {
    const limit = candidate[key];
    if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
      throw generationError("Manifest limits are invalid.", "INVALID_MANIFEST");
    }
  }
}

function assertManifestPhaseShape(manifest: GenerationManifest): void {
  const hasBaseline = manifest.baselineTreeOid !== null;
  const hasFinal = manifest.finalTreeOid !== null;
  const hasOperations = manifest.operationJournal.length > 0;
  const allApplied = manifest.operationJournal.every((operation) => operation.status === "applied");
  if (manifest.phase === "preparing"
    && (hasBaseline || hasFinal || manifest.readOnlyRoots.length > 0 || hasOperations)) {
    throw generationError("Preparing manifest contains authority from a later phase.", "INVALID_MANIFEST");
  }
  if ((manifest.phase === "ready" || manifest.phase === "quarantined")
    && (!hasBaseline || hasFinal || hasOperations)) {
    throw generationError("Ready manifest has an invalid snapshot shape.", "INVALID_MANIFEST");
  }
  if (manifest.phase === "frozen" && (!hasBaseline || !hasFinal || hasOperations)) {
    throw generationError("Frozen manifest has an invalid snapshot shape.", "INVALID_MANIFEST");
  }
  if ((manifest.phase === "planned" || manifest.phase === "applying") && (!hasBaseline || !hasFinal)) {
    throw generationError("Planned manifest is missing immutable snapshot authority.", "INVALID_MANIFEST");
  }
  if ((manifest.phase === "committed" || manifest.phase === "cleaned")
    && (!hasBaseline || !hasFinal || !allApplied)) {
    throw generationError("Committed manifest has incomplete operation evidence.", "INVALID_MANIFEST");
  }
  if (manifest.phase === "aborted" && (hasFinal || hasOperations)) {
    throw generationError("Aborted manifest contains reconciliation authority.", "INVALID_MANIFEST");
  }
}

function assertTreeEntry(entry: TreeEntry | null): void {
  if (entry === null) return;
  if ((entry.mode !== "100644" && entry.mode !== "100755") || !/^[a-f0-9]{40,64}$/.test(entry.oid)) {
    throw generationError("Manifest tree entry is invalid.", "INVALID_MANIFEST");
  }
}

function isManifest(value: unknown): value is GenerationManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GenerationManifest>;
  return candidate.version === MANIFEST_VERSION
    && typeof candidate.generationId === "string" && /^[a-f0-9]{32}$/.test(candidate.generationId)
    && typeof candidate.phase === "string" && PHASES.has(candidate.phase as SupervisedWorkspaceGenerationPhase)
    && typeof candidate.sourceRoot === "string"
    && typeof candidate.realWorkspace === "string"
    && typeof candidate.workspaceRelativePath === "string"
    && typeof candidate.generationRoot === "string"
    && typeof candidate.liveSourceRoot === "string"
    && typeof candidate.liveWorkspace === "string"
    && typeof candidate.headOid === "string" && /^[a-f0-9]{40,64}$/.test(candidate.headOid)
    && typeof candidate.sourceGitObjectDirectory === "string"
    && (candidate.baselineTreeOid === null || (typeof candidate.baselineTreeOid === "string" && /^[a-f0-9]{40,64}$/.test(candidate.baselineTreeOid)))
    && (candidate.finalTreeOid === null || (typeof candidate.finalTreeOid === "string" && /^[a-f0-9]{40,64}$/.test(candidate.finalTreeOid)))
    && Array.isArray(candidate.readOnlyRoots)
    && Array.isArray(candidate.operationJournal)
    && !!candidate.limits;
}

function normalizeManifestVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) return value;
  const legacy = value as Record<string, unknown>;
  const legacyRoots = Array.isArray(legacy.readOnlyRoots) ? legacy.readOnlyRoots : [];
  const recordedObjectRoot = legacyRoots.find((entry) =>
    !!entry && typeof entry === "object" && (entry as { purpose?: unknown }).purpose === "git-objects",
  );
  const sourceRoot = typeof legacy.sourceRoot === "string" ? legacy.sourceRoot : "";
  const sourceGitObjectDirectory = recordedObjectRoot
    && typeof (recordedObjectRoot as { sourcePath?: unknown }).sourcePath === "string"
    ? (recordedObjectRoot as { sourcePath: string }).sourcePath
    : join(sourceRoot, ".git", "objects");
  return { ...legacy, version: MANIFEST_VERSION, sourceGitObjectDirectory };
}

async function cleanupTrees(manifest: GenerationManifest, preserveReconciliationEvidence = false): Promise<void> {
  const names = preserveReconciliationEvidence
    ? [LIVE_NAME, RETIRED_NAME, AUTHORITY_NAME]
    : [LIVE_NAME, RETIRED_NAME, AUTHORITY_NAME, BASELINE_FILES_NAME, STAGING_NAME];
  for (const name of names) {
    const target = join(manifest.generationRoot, name);
    safeRelative(manifest.generationRoot, target);
    await rm(target, { force: true, recursive: true, maxRetries: 2 });
  }
}

function projectRelativePath(sourcePath: string, prefix: string): string | null {
  if (prefix === "") return sourcePath;
  if (sourcePath === prefix) return "";
  return sourcePath.startsWith(`${prefix}${sep}`) ? sourcePath.slice(prefix.length + 1) : null;
}

function isProtectedPath(relativePath: string): boolean {
  const protectedComponents = new Set([".git", ".cursor", ".claude", ".letagents-fence"]);
  return relativePath.split(sep).some((component) =>
    protectedComponents.has(component.normalize("NFC").toLowerCase()),
  );
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

function generationIdFor(sourceRoot: string, turnIdentity: string): string {
  return createHash("sha256").update(sourceRoot).update("\0").update(turnIdentity).digest("hex").slice(0, 32);
}

function generationDirectoryName(sourceRoot: string, generationId: string): string {
  return `.${basename(sourceRoot)}.letagents-generation-${generationId}`;
}

function manifestPathOf(manifest: GenerationManifest): string {
  return join(manifest.generationRoot, MANIFEST_NAME);
}

function resultFor(manifest: GenerationManifest): SupervisedWorkspaceGenerationResult {
  return {
    phase: manifest.phase,
    appliedPaths: manifest.operationJournal.filter((entry) => entry.status === "applied").map((entry) => entry.relativePath),
    manifestPath: manifestPathOf(manifest),
  };
}

function treeEntryEqual(a: TreeEntry | null | undefined, b: TreeEntry | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.mode === b.mode && a.oid === b.oid;
}

function operationId(sourceRelativePath: string, before: TreeEntry | null, after: TreeEntry | null): string {
  return createHash("sha256")
    .update(sourceRelativePath).update("\0")
    .update(before?.mode ?? "missing").update("\0").update(before?.oid ?? "missing").update("\0")
    .update(after?.mode ?? "missing").update("\0").update(after?.oid ?? "missing")
    .digest("hex").slice(0, 24);
}

function safeRelative(parent: string, child: string): string {
  const result = relative(resolve(parent), resolve(child));
  if (result === "") return "";
  if (result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) throw generationError("Path escapes its supervised root.", "PATH_ESCAPE");
  return result;
}

async function readStableGitControlFile(path: string): Promise<string> {
  const descriptor = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
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

function gitControlPath(contents: string, prefix: string, base: string, malformedMessage: string): string {
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

async function canonicalGitControlTarget(path: string, unavailableMessage: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw generationError(
      `${unavailableMessage} ${error instanceof Error ? error.message : String(error)}`,
      "REDIRECTED_GIT_ROOT",
    );
  }
}

function assertSafeRelativePath(relativePath: string, limits: SupervisedWorkspaceGenerationLimits): void {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(sep).includes("..") || relativePath.includes("\0")) {
    throw generationError("Unsafe relative path.", "PATH_ESCAPE");
  }
  if (Buffer.byteLength(relativePath) > limits.maxRelativePathBytes) throw limitError("relative path bytes", limits.maxRelativePathBytes);
}

function normalizeLimits(input: Partial<SupervisedWorkspaceGenerationLimits> | undefined): SupervisedWorkspaceGenerationLimits {
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw generationError(`Invalid ${key} limit.`, "INVALID_LIMIT");
  }
  return result;
}

function assertClonePlatform(): void {
  if (process.platform !== "darwin") {
    throw generationError("Writable supervised generations require macOS clonefile support; no ordinary-copy fallback is allowed.", "CLONE_PLATFORM_UNSUPPORTED");
  }
}

async function cloneRegularFile(source: string, destination: string, maxBytes: number): Promise<void> {
  // BSD cp(1) -c is clonefile-only on macOS. A filesystem without clone support
  // returns a non-zero exit; deliberately do not retry as an ordinary copy.
  await runProcess("/bin/cp", ["-c", "-p", "-P", source, destination], dirname(destination), undefined, Math.min(maxBytes, 1024 * 1024), GIT_ENV);
}

function generationError(message: string, code: string): SupervisedWorkspaceGenerationError {
  return new SupervisedWorkspaceGenerationError(message, code);
}

function limitError(kind: string, value: number): SupervisedWorkspaceGenerationError {
  return generationError(`Supervised generation ${kind} exceeded its limit (${value}).`, "GENERATION_LIMIT_EXCEEDED");
}

function compareUtf8(a: string, b: string): number {
  return Buffer.from(a).compare(Buffer.from(b));
}

function splitNul(buffer: Buffer): string[] {
  return splitNulBuffer(buffer).map(decodeGitPath);
}

function decodeGitPath(value: Buffer): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw generationError("Git returned a path that is not valid UTF-8.", "UNSUPPORTED_GIT_PATH_ENCODING");
  }
  return decoded;
}

function splitNulBuffer(buffer: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) result.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) result.push(buffer.subarray(start));
  return result;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, fsConstants.O_RDONLY);
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (isErrno(error, "ENOENT")) return false; throw error; }
}

async function invokeFailpoint(
  handler: SupervisedWorkspaceGenerationFailpointHandler | undefined,
  point: SupervisedWorkspaceGenerationFailpoint,
  manifestPath: string,
): Promise<void> {
  await handler?.(point, manifestPath);
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

const PHASES = new Set<SupervisedWorkspaceGenerationPhase>([
  "preparing", "ready", "quarantined", "frozen", "planned", "applying", "committed", "cleaned", "aborted",
]);

async function discoverSourceGitText(cwd: string, args: string[]): Promise<string> {
  try {
    return await gitText(cwd, args);
  } catch (error) {
    throw generationError(
      `The selected workspace Git topology could not be resolved safely: ${error instanceof Error ? error.message : String(error)}`,
      "REDIRECTED_GIT_ROOT",
    );
  }
}

async function gitText(cwd: string, args: string[], maxBytes = 1024 * 1024): Promise<string> {
  return (await gitBuffer(cwd, args, maxBytes)).toString("utf8").trim();
}

async function gitBuffer(cwd: string, args: string[], maxBytes: number): Promise<Buffer> {
  return runProcess("/usr/bin/git", gitArgs(args), cwd, undefined, maxBytes, GIT_ENV);
}

async function sourceAuthorityBuffer(
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

async function sourceAuthorityText(
  authority: SourceGitAuthority,
  args: string[],
  maxBytes = 1024 * 1024,
  env = GIT_ENV,
): Promise<string> {
  return (await sourceAuthorityBuffer(authority, args, maxBytes, env)).toString("utf8").trim();
}

async function runGit(cwd: string, args: string[], maxBytes: number): Promise<void> {
  await gitBuffer(cwd, args, maxBytes);
}

async function gitExitCode(cwd: string, args: string[]): Promise<number> {
  try { await gitBuffer(cwd, args, 1024 * 1024); return 0; } catch (error) {
    if (error instanceof ProcessExitError) return error.exitCode;
    throw error;
  }
}

async function sourceAuthorityExitCode(authority: SourceGitAuthority, args: string[], env = GIT_ENV): Promise<number> {
  try { await sourceAuthorityBuffer(authority, args, 1024 * 1024, env); return 0; } catch (error) {
    if (error instanceof ProcessExitError) return error.exitCode;
    throw error;
  }
}

function gitArgs(args: string[]): string[] {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    // The physical namespace is authoritative for reconciliation. Do not let a
    // case-insensitive/precomposed index silently collapse a provider rename.
    "-c", "core.ignorecase=false",
    "-c", "core.precomposeunicode=false",
    ...args,
  ];
}

async function gitAuthorityText(
  gitDirectory: string,
  worktree: string | null,
  args: string[],
  maxBytes: number,
  env = GIT_ENV,
): Promise<string> {
  return (await gitAuthorityBuffer(gitDirectory, worktree, args, maxBytes, env)).toString("utf8").trim();
}

async function gitAuthorityBuffer(
  gitDirectory: string,
  worktree: string | null,
  args: string[],
  maxBytes: number,
  env = GIT_ENV,
): Promise<Buffer> {
  const authorityArgs = [`--git-dir=${gitDirectory}`];
  if (worktree) authorityArgs.push(`--work-tree=${worktree}`);
  return runProcess("/usr/bin/git", gitArgs([...authorityArgs, ...args]), worktree ?? dirname(gitDirectory), undefined, maxBytes, env);
}

async function runGitWithAuthority(
  gitDirectory: string,
  worktree: string,
  args: string[],
  maxBytes: number,
  env = GIT_ENV,
): Promise<void> {
  await gitAuthorityBuffer(gitDirectory, worktree, args, maxBytes, env);
}

class ProcessExitError extends Error {
  constructor(readonly exitCode: number, message: string) { super(message); }
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  input: Buffer | undefined,
  maxBytes: number,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
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
