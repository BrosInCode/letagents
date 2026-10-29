/** Writing, loading, validating and cleaning up the generation manifest and its trees. */
import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isOwnerPrivate, openNoFollow, privateEntryCreated } from "../../../../../../shared/owner-private-fs.mjs";
import { renameWithRetryAsync } from "../../../../../../shared/rename-retry.mjs";
import { AUTHORITY_NAME, BASELINE_FILES_NAME, DEFAULT_LIMITS, type GenerationManifest, LIVE_NAME, MANIFEST_NAME, MANIFEST_VERSION, PROVIDER_GIT_NAME, RETIRED_NAME, STAGING_NAME, SupervisedWorkspaceConflictError, type SupervisedWorkspaceGenerationLimits, type SupervisedWorkspaceGenerationPhase, type TreeEntry } from "./types.js";
import { assertSafeRelativePath, fsyncDirectory, generationDirectoryName, generationError, isErrno, isProtectedPath, isWindowsGeneration, manifestPathOf, operationId, projectRelativePath, safeRelative } from "./helpers.js";

export async function atomicWrite(target: string, content: Buffer, mode: number, generationId: string): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.letagents-${generationId}-${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = await openNoFollow(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let closed = false;
  try {
    await descriptor.writeFile(content);
    await descriptor.chmod(mode);
    await descriptor.sync();
    await descriptor.close();
    closed = true;
    await renameWithRetryAsync(temporary, target);
    await fsyncDirectory(dirname(target));
  } catch (error) {
    if (!closed) await descriptor.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function assertSafeAncestors(root: string, relativePath: string, createMissing: boolean): Promise<void> {
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

export async function persistManifest(manifest: GenerationManifest): Promise<void> {
  validateManifest(manifest);
  const destination = manifestPathOf(manifest);
  const temporary = join(manifest.generationRoot, `.${MANIFEST_NAME}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = await openNoFollow(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let closed = false;
  try {
    // Windows has no mode bits: the empty file gets its private DACL before the manifest is written.
    await privateEntryCreated(temporary, "file");
    await descriptor.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await descriptor.sync();
    await descriptor.close();
    closed = true;
    await renameWithRetryAsync(temporary, destination);
    await fsyncDirectory(manifest.generationRoot);
  } catch (error) {
    if (!closed) await descriptor.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function loadManifest(manifestPath: string): Promise<GenerationManifest> {
  const resolvedPath = resolve(manifestPath);
  const descriptor = await openNoFollow(resolvedPath, fsConstants.O_RDONLY);
  try {
    const info = await descriptor.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024 || !await isOwnerPrivate(resolvedPath, info)) {
      throw generationError("Manifest is not a bounded owner-private regular file.", "INVALID_MANIFEST");
    }
    const parsed: unknown = normalizeManifestVersion(JSON.parse(await descriptor.readFile("utf8")));
    if (!isManifest(parsed)) throw generationError("Manifest schema is invalid.", "INVALID_MANIFEST");
    validateManifest(parsed);
    if (manifestPathOf(parsed) !== resolvedPath) throw generationError("Manifest path does not match its generation root.", "INVALID_MANIFEST");
    const rootInfo = await lstat(parsed.generationRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !await isOwnerPrivate(parsed.generationRoot, rootInfo)) {
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

export async function transition(
  manifest: GenerationManifest,
  phase: SupervisedWorkspaceGenerationPhase,
  patch: Partial<GenerationManifest> = {},
): Promise<GenerationManifest> {
  const next = { ...manifest, ...patch, phase, updatedAt: new Date().toISOString() };
  await persistManifest(next);
  return next;
}

export function validateManifest(manifest: GenerationManifest): void {
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

export function assertManifestLimits(value: unknown): asserts value is SupervisedWorkspaceGenerationLimits {
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

export function assertManifestPhaseShape(manifest: GenerationManifest): void {
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

export function assertTreeEntry(entry: TreeEntry | null): void {
  if (entry === null) return;
  if ((entry.mode !== "100644" && entry.mode !== "100755") || !/^[a-f0-9]{40,64}$/.test(entry.oid)) {
    throw generationError("Manifest tree entry is invalid.", "INVALID_MANIFEST");
  }
}

export function isManifest(value: unknown): value is GenerationManifest {
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

export function normalizeManifestVersion(value: unknown): unknown {
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

export async function cleanupTrees(manifest: GenerationManifest, preserveReconciliationEvidence = false): Promise<void> {
  const names = preserveReconciliationEvidence
    ? [LIVE_NAME, RETIRED_NAME, AUTHORITY_NAME]
    : [LIVE_NAME, RETIRED_NAME, AUTHORITY_NAME, BASELINE_FILES_NAME, STAGING_NAME];
  // The worktree's private clone goes after the worktree itself.
  if (isWindowsGeneration()) names.splice(names.indexOf(AUTHORITY_NAME), 0, PROVIDER_GIT_NAME);
  for (const name of names) {
    const target = join(manifest.generationRoot, name);
    safeRelative(manifest.generationRoot, target);
    await rm(target, { force: true, recursive: true, maxRetries: 2 });
  }
}

export const PHASES = new Set<SupervisedWorkspaceGenerationPhase>([
  "preparing", "ready", "quarantined", "frozen", "planned", "applying", "committed", "cleaned", "aborted",
]);
