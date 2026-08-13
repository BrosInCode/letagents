import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopLegacyProjectBindingCandidate,
  DesktopProjectBinding,
  DesktopProjectBindingContext,
  DesktopProjectBindingMigrationResult,
  DesktopProjectBindingSource,
} from "../ipc-types.js";
import {
  findProjectBinding,
  projectBindingAliases,
  projectBindingIdentityKey,
  projectBindingVerificationKeys,
} from "../project-bindings.js";
import { buildRepoStatus, resolveRoomIdentifierFromPath } from "../repo-status.js";

const require = createRequire(import.meta.url);

interface PersistedProjectBindings {
  version: 1;
  bindings: DesktopProjectBinding[];
}

export interface ProjectBindingsStoreOptions {
  storePath?: string;
}

function getElectronMain(): { app?: { getPath: (name: "userData") => string } } {
  try {
    const electron = require("electron") as unknown;
    return typeof electron === "object" && electron !== null
      ? electron as { app?: { getPath: (name: "userData") => string } }
      : {};
  } catch {
    return {};
  }
}

export function getProjectBindingsStorePath(
  options: ProjectBindingsStoreOptions = {},
): string {
  return options.storePath
    || process.env.LETAGENTS_PROJECT_BINDINGS_PATH
    || join(
      getElectronMain().app?.getPath("userData") || homedir(),
      "letagents-desktop-project-bindings.json",
    );
}

function validBinding(value: unknown): value is DesktopProjectBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<DesktopProjectBinding>;
  return typeof binding.id === "string" && binding.id.length > 0
    && typeof binding.identityKey === "string" && binding.identityKey.length > 0
    && Array.isArray(binding.verificationKeys)
    && binding.verificationKeys.every((key) => typeof key === "string" && key.length > 0)
    && Array.isArray(binding.aliases)
    && binding.aliases.every((alias) => typeof alias === "string" && alias.length > 0)
    && typeof binding.rootPath === "string" && binding.rootPath.length > 0
    && ["configured", "git_remote", "local_git", "local_folder"].includes(binding.source || "")
    && typeof binding.createdAt === "string" && Number.isFinite(Date.parse(binding.createdAt))
    && typeof binding.updatedAt === "string" && Number.isFinite(Date.parse(binding.updatedAt));
}

async function readStore(
  options: ProjectBindingsStoreOptions = {},
): Promise<PersistedProjectBindings> {
  try {
    const parsed = JSON.parse(
      await readFile(getProjectBindingsStorePath(options), "utf8"),
    ) as Partial<PersistedProjectBindings>;
    return {
      version: 1,
      bindings: Array.isArray(parsed.bindings)
        ? parsed.bindings.filter(validBinding)
        : [],
    };
  } catch {
    return { version: 1, bindings: [] };
  }
}

async function writeStore(
  store: PersistedProjectBindings,
  options: ProjectBindingsStoreOptions = {},
): Promise<void> {
  const storePath = getProjectBindingsStorePath(options);
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, storePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

let mutationQueue = Promise.resolve();

async function withStoreLock<T>(
  options: ProjectBindingsStoreOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const storePath = getProjectBindingsStorePath(options);
  const lockPath = `${storePath}.lock`;
  await mkdir(dirname(storePath), { recursive: true });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error("Project bindings are busy in another LetAgents process.", { cause: error });
      }
      let ownerPid: number | null = null;
      try {
        const parsedOwner = Number((await readFile(join(lockPath, "owner"), "utf8")).trim());
        ownerPid = Number.isInteger(parsedOwner) && parsedOwner > 0 ? parsedOwner : null;
        if (ownerPid) process.kill(ownerPid, 0);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException)?.code === "ESRCH") {
          await unlink(join(lockPath, "owner")).catch(() => undefined);
          await rmdir(lockPath).catch(() => undefined);
          continue;
        }
        if ((ownerError as NodeJS.ErrnoException)?.code !== "ENOENT") throw ownerError;
      }
      if (!ownerPid) {
        const lockAge = Date.now() - (await stat(lockPath)).mtimeMs;
        if (lockAge > 2_000) {
          await unlink(join(lockPath, "owner")).catch(() => undefined);
          await rmdir(lockPath).catch(() => undefined);
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    await writeFile(join(lockPath, "owner"), `${process.pid}\n`, { mode: 0o600 });
    return await operation();
  } finally {
    await unlink(join(lockPath, "owner")).catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
  }
}

function serializeMutation<T>(
  options: ProjectBindingsStoreOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const guarded = () => withStoreLock(options, operation);
  const result = mutationQueue.then(guarded, guarded);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function canonicalDirectory(rootPath: string): Promise<string> {
  const canonical = await realpath(rootPath.trim());
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error("The selected project path is not a folder.");
  }
  try {
    await lstat(join(canonical, ".letagents-work-attempt.json"));
    throw new Error("A managed agent worktree cannot become a project folder.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return canonical;
}

async function filesystemVerificationKeys(
  rootPath: string,
  context: DesktopProjectBindingContext,
): Promise<string[]> {
  const rootStats = await stat(rootPath);
  const keys = new Set(projectBindingVerificationKeys(context));
  keys.add(`fs-root:${rootStats.dev}:${rootStats.ino}`);
  try {
    const gitStats = await stat(join(rootPath, ".git"));
    keys.add(`fs-git:${gitStats.dev}:${gitStats.ino}`);
  } catch {
    // Plain folders have no Git identity axis.
  }
  return [...keys].sort();
}

async function deriveFilesystemContext(rootPath: string): Promise<{
  context: DesktopProjectBindingContext;
  source: DesktopProjectBindingSource;
}> {
  const resolved = await resolveRoomIdentifierFromPath(rootPath, { ignoreConfiguredRoom: true });
  return {
    context: { roomIdentifier: resolved.roomIdentifier, gitRoom: resolved.gitRoom },
    source: resolved.source || "local_folder",
  };
}

export async function listProjectBindings(
  options: ProjectBindingsStoreOptions = {},
): Promise<DesktopProjectBinding[]> {
  const bindings = (await readStore(options)).bindings;
  const available = await Promise.all(bindings.map(async (binding) => {
    try {
      const rootPath = await canonicalDirectory(binding.rootPath);
      const derived = await deriveFilesystemContext(rootPath);
      const currentKeys = new Set(await filesystemVerificationKeys(rootPath, derived.context));
      return binding.verificationKeys.every((key) => currentKeys.has(key));
    } catch {
      return false;
    }
  }));
  return bindings.filter((_binding, index) => available[index]);
}

export async function bindProjectRoot(input: {
  context: DesktopProjectBindingContext;
  rootPath: string;
  source: DesktopProjectBindingSource;
}, options: ProjectBindingsStoreOptions = {}): Promise<DesktopProjectBinding> {
  const aliases = projectBindingAliases(input.context);
  const identityKey = projectBindingIdentityKey(input.context);
  if (!aliases.length || !identityKey) throw new Error("The project room has no durable identity.");
  const rootPath = await canonicalDirectory(input.rootPath);
  const filesystem = await deriveFilesystemContext(rootPath);
  const hostedContext = /^(?:github\.com|gitlab\.com|bitbucket\.org)\//.test(
    String(input.context.roomIdentifier || "").toLowerCase(),
  ) || Boolean(input.context.gitRoom?.host && input.context.gitRoom.host !== "local");
  if (hostedContext && !projectBindingContextsOverlap(input.context, filesystem.context)) {
    throw new Error("The selected folder does not prove this project room's identity.");
  }
  const verificationKeys = await filesystemVerificationKeys(rootPath, filesystem.context);

  return serializeMutation(options, async () => {
    const store = await readStore(options);
    const matches = store.bindings.filter((binding) => binding.identityKey === identityKey);
    const now = new Date().toISOString();
    const existing = matches.sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    const binding: DesktopProjectBinding = {
      id: existing?.id || randomUUID(),
      identityKey,
      verificationKeys,
      aliases,
      rootPath,
      source: input.source,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    store.bindings = [
      ...store.bindings.filter((candidate) => !matches.includes(candidate)),
      binding,
    ];
    await writeStore(store, options);
    return binding;
  });
}

export function projectBindingContextsOverlap(
  left: DesktopProjectBindingContext,
  right: DesktopProjectBindingContext,
): boolean {
  const rightAliases = new Set(projectBindingVerificationKeys(right));
  return projectBindingVerificationKeys(left).some((alias) => rightAliases.has(alias));
}

/**
 * One-way upgrade from renderer-era path hints. Every candidate is re-derived
 * from the filesystem and must resolve to the same project identity before it
 * can become authoritative. Invalid, moved, or unrelated paths fail closed.
 */
export async function migrateLegacyProjectBindings(
  candidates: readonly DesktopLegacyProjectBindingCandidate[],
  options: ProjectBindingsStoreOptions = {},
): Promise<DesktopProjectBindingMigrationResult> {
  const retryLegacyKeys = new Set<string>();
  for (const candidate of candidates) {
    try {
      if (findProjectBinding(await listProjectBindings(options), candidate.context)) continue;
      const rootPath = await canonicalDirectory(candidate.rootPath);
      const resolved = await resolveRoomIdentifierFromPath(rootPath, { ignoreConfiguredRoom: true });
      const status = await buildRepoStatus(resolved.repoRoot || rootPath);
      const resolvedContext: DesktopProjectBindingContext = {
        roomIdentifier: resolved.roomIdentifier,
        gitRoom: resolved.gitRoom,
      };
      if (!projectBindingContextsOverlap(candidate.context, resolvedContext)) {
        if (candidate.legacyKey) retryLegacyKeys.add(candidate.legacyKey);
        continue;
      }
      await bindProjectRoot({
        context: {
          roomIdentifier: candidate.context.roomIdentifier || resolved.roomIdentifier,
          gitRoom: candidate.context.gitRoom || resolved.gitRoom,
        },
        rootPath: status.isGitRepo
          ? status.mainRootPath || status.rootPath
          : rootPath,
        source: resolved.source || "local_folder",
      }, options);
    } catch {
      // Legacy hints are optional migration input; one bad path must not block
      // startup or prevent other valid projects from migrating. Failed keys are
      // returned so the renderer retains them for a later launch.
      if (candidate.legacyKey) retryLegacyKeys.add(candidate.legacyKey);
    }
  }
  return {
    bindings: await listProjectBindings(options),
    retryLegacyKeys: [...retryLegacyKeys].sort(),
  };
}
