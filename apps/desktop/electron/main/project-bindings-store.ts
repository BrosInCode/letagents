import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopLegacyProjectBindingCandidate,
  DesktopProjectBinding,
  DesktopProjectBindingContext,
  DesktopProjectBindingSource,
} from "../ipc-types.js";
import {
  findProjectBinding,
  projectBindingAliases,
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
  await rename(temporaryPath, storePath);
}

let mutationQueue = Promise.resolve();

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
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

export async function listProjectBindings(
  options: ProjectBindingsStoreOptions = {},
): Promise<DesktopProjectBinding[]> {
  const bindings = (await readStore(options)).bindings;
  const available = await Promise.all(bindings.map(async (binding) => {
    try {
      return (await stat(binding.rootPath)).isDirectory();
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
  if (!aliases.length) throw new Error("The project room has no durable identity.");
  const rootPath = await canonicalDirectory(input.rootPath);

  return serializeMutation(async () => {
    const store = await readStore(options);
    const aliasSet = new Set(aliases);
    const matches = store.bindings.filter(
      (binding) => binding.aliases.some((alias) => aliasSet.has(alias)),
    );
    const now = new Date().toISOString();
    const existing = matches.sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    const binding: DesktopProjectBinding = {
      id: existing?.id || randomUUID(),
      aliases: [...new Set([...aliases, ...matches.flatMap((match) => match.aliases)])].sort(),
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
  const rightAliases = new Set(projectBindingAliases(right));
  return projectBindingAliases(left).some((alias) => rightAliases.has(alias));
}

/**
 * One-way upgrade from renderer-era path hints. Every candidate is re-derived
 * from the filesystem and must resolve to the same project identity before it
 * can become authoritative. Invalid, moved, or unrelated paths fail closed.
 */
export async function migrateLegacyProjectBindings(
  candidates: readonly DesktopLegacyProjectBindingCandidate[],
  options: ProjectBindingsStoreOptions = {},
): Promise<DesktopProjectBinding[]> {
  for (const candidate of candidates) {
    try {
      if (findProjectBinding(await listProjectBindings(options), candidate.context)) continue;
      const rootPath = await canonicalDirectory(candidate.rootPath);
      const resolved = await resolveRoomIdentifierFromPath(rootPath);
      const status = await buildRepoStatus(resolved.repoRoot || rootPath);
      const resolvedContext: DesktopProjectBindingContext = {
        roomIdentifier: resolved.roomIdentifier,
        gitRoom: resolved.gitRoom,
      };
      if (!projectBindingContextsOverlap(candidate.context, resolvedContext)) continue;
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
      // startup or prevent other valid projects from migrating.
    }
  }
  return listProjectBindings(options);
}
