/** Generation names and limits, the public option, result and handle types, the generation errors and the manifest shapes. */
import type { Stats } from "node:fs";

export const MANIFEST_VERSION = 3 as const;
export const MANIFEST_NAME = "generation-manifest.json";
export const LIVE_NAME = "live";
export const RETIRED_NAME = "retired";
export const AUTHORITY_NAME = "private-git";
export const BASELINE_FILES_NAME = "baseline-files";
export const STAGING_NAME = "reconcile-staging";
export const BASELINE_INDEX_NAME = "letagents-baseline.index";
export const FINAL_INDEX_NAME = "letagents-final.index";

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

export type SourceGitAuthority = Pick<
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

export interface TreeEntry {
  mode: "100644" | "100755";
  oid: string;
}

export interface ReconcileOperation {
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

export interface GenerationManifest {
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

export const DEFAULT_LIMITS: SupervisedWorkspaceGenerationLimits = {
  maxChangedPaths: 25_000,
  maxFileBytes: 128 * 1024 * 1024,
  maxPatchBytes: 256 * 1024 * 1024,
  maxTotalUntrackedBytes: 2 * 1024 * 1024 * 1024,
  maxRelativePathBytes: 4_096,
};

export type ExactFileState = { entry: TreeEntry; fullMode: number; metadataDigest: string; dev: bigint; ino: bigint };

export type RegularFileInfo = Pick<Stats, "size" | "mode" | "uid" | "gid">;
