/** Dependency links and excludes, alternates, and the safety checks on the source and trusted git authority. */
import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { isOwnerPrivate, protectOwnerPrivate } from "../../../../../../shared/owner-private-fs.mjs";
import { AUTHORITY_NAME, BASELINE_FILES_NAME, type GenerationManifest, SUPERVISED_WORKSPACE_GENERATION_LIMITATION, type SourceGitAuthority, SupervisedWorkspaceGenerationError, type SupervisedWorkspaceGenerationLimits, type SupervisedWorkspaceGenerationSupport, type SupervisedWorkspaceReadOnlyRoot } from "./types.js";
import { ProcessExitError, cloneRegularFile, gitHooksPath, runGit, sourceAuthorityBuffer, sourceAuthorityExitCode, sourceGitEnvironment } from "./git.js";
import { assertSafeAncestors, atomicWrite } from "./manifest.js";
import { assertSafeRelativePath, compareUtf8, generationError, gitRelativePath, isErrno, isWindowsGeneration, limitError, pathExists, safeRelative, splitNul, splitNulBuffer } from "./helpers.js";
import { sourceVisiblePaths } from "./worktree.js";

export async function linkIgnoredDependencyRoots(
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
      ["check-ignore", "-q", "--", gitRelativePath(sourceRelativePath)],
      sourceGitEnvironment(),
    );
    if (ignored !== 0) continue;
    const generationPath = join(liveRoot, sourceRelativePath);
    if (await pathExists(generationPath)) continue;
    await mkdir(dirname(generationPath), { recursive: true, mode: 0o700 });
    // Windows: a junction needs no symlink privilege; lstat reports it as a
    // link, so Git, readdir and rm never walk into the source dependency.
    await symlink(candidate, generationPath, isWindowsGeneration() ? "junction" : "dir");
    mappings.push({ sourcePath: candidate, generationPath, purpose: "dependency" });
  }
  return mappings;
}

export async function installDependencyExcludes(
  gitDirectory: string,
  mappings: SupervisedWorkspaceReadOnlyRoot[],
  liveRoot: string,
  generationId: string,
): Promise<void> {
  const dependencyPaths = mappings
    .filter((entry): entry is SupervisedWorkspaceReadOnlyRoot & { generationPath: string } => entry.purpose === "dependency" && entry.generationPath !== null)
    .map((entry) => gitRelativePath(safeRelative(liveRoot, entry.generationPath)))
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

export async function readSafeAlternateRoots(
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

export async function disablePrivateGitAuthority(liveRoot: string): Promise<void> {
  await runGit(liveRoot, ["config", "--local", "core.hooksPath", gitHooksPath()], 1024 * 1024);
  await runGit(liveRoot, ["config", "--local", "core.fsmonitor", "false"], 1024 * 1024);
  await runGit(liveRoot, ["config", "--local", "gc.auto", "0"], 1024 * 1024);
}

export async function disableTrustedGitAuthority(authorityRoot: string): Promise<void> {
  await protectOwnerPrivate(authorityRoot, "directory");
  await runGit(authorityRoot, ["config", "--local", "core.hooksPath", gitHooksPath()], 1024 * 1024);
  await runGit(authorityRoot, ["config", "--local", "core.fsmonitor", "false"], 1024 * 1024);
  await runGit(authorityRoot, ["config", "--local", "gc.auto", "0"], 1024 * 1024);
}

export async function assertSafeBareAlternateRoot(
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

export async function assertTrustedAuthority(manifest: GenerationManifest, authorityRoot: string): Promise<void> {
  const info = await lstat(authorityRoot).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink() || !await isOwnerPrivate(authorityRoot, info)
    || authorityRoot !== join(manifest.generationRoot, AUTHORITY_NAME)) {
    throw generationError("Supervisor-owned Git authority disappeared or was redirected.", "GIT_AUTHORITY_MISSING");
  }
  const objectRoot = manifest.readOnlyRoots.find((entry) => entry.purpose === "git-objects")?.sourcePath;
  if (!objectRoot) throw generationError("The sealed Git object authority is missing.", "INVALID_MANIFEST");
  await assertSafeBareAlternateRoot(authorityRoot, objectRoot, manifest.limits);
  const baselineRoot = join(manifest.generationRoot, BASELINE_FILES_NAME);
  const baselineInfo = await lstat(baselineRoot).catch(() => null);
  if (!baselineInfo?.isDirectory() || baselineInfo.isSymbolicLink() || !await isOwnerPrivate(baselineRoot, baselineInfo)) {
    throw generationError("Supervisor-owned baseline metadata disappeared or was redirected.", "INVALID_BASELINE_METADATA");
  }
}

export async function assertIndexHasNoLinksOrGitlinks(authority: SourceGitAuthority, limits: SupervisedWorkspaceGenerationLimits): Promise<void> {
  const output = await sourceAuthorityBuffer(authority, ["ls-files", "-s", "-z"], limits.maxPatchBytes);
  for (const record of splitNulBuffer(output)) {
    const mode = record.subarray(0, record.indexOf(0x20)).toString("ascii");
    if (mode === "120000" || mode === "160000") {
      throw generationError(SUPERVISED_WORKSPACE_GENERATION_LIMITATION, "TRACKED_LINK_OR_GITLINK_UNSUPPORTED");
    }
  }
}

export async function assertNoUnmergedEntries(authority: SourceGitAuthority, limits: SupervisedWorkspaceGenerationLimits): Promise<void> {
  const output = await sourceAuthorityBuffer(authority, ["ls-files", "-u", "-z"], limits.maxPatchBytes);
  if (output.length > 0) throw generationError("Unmerged index entries cannot be reproduced safely.", "UNMERGED_INDEX_UNSUPPORTED");
}

export async function assertSparseCheckoutDisabled(authority: SourceGitAuthority): Promise<void> {
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

export async function assertSourceWorktreeWithinLimits(authority: SourceGitAuthority, limits: SupervisedWorkspaceGenerationLimits): Promise<void> {
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
  // A Windows generation never copies untracked files, so they cannot exceed a limit there.
  if (isWindowsGeneration()) return;
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

export async function assertClonefileSupported(parent: string): Promise<void> {
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
