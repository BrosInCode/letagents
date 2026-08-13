import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
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

interface SqliteStatement {
  all: (...values: unknown[]) => unknown[];
  get: (...values: unknown[]) => unknown;
  run: (...values: unknown[]) => unknown;
}

interface SqliteDatabase {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
}

interface ProjectBindingRow {
  id: string;
  identity_key: string;
  verification_keys_json: string;
  aliases_json: string;
  root_path: string;
  source: DesktopProjectBindingSource;
  created_at: string;
  updated_at: string;
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
      "letagents-desktop-project-bindings.sqlite",
    );
}

function openStore(options: ProjectBindingsStoreOptions = {}): SqliteDatabase {
  const storePath = getProjectBindingsStorePath(options);
  require("node:fs").mkdirSync(dirname(storePath), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const database = new DatabaseSync(storePath);
  database.exec("PRAGMA busy_timeout = 10000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS project_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      identity_key TEXT NOT NULL UNIQUE,
      verification_keys_json TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      root_path TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('configured', 'git_remote', 'local_git', 'local_folder')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  for (const path of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  return database;
}

function parseStringArray(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.length > 0)
      ? [...new Set(parsed)].sort()
      : null;
  } catch {
    return null;
  }
}

function mapRow(row: unknown): DesktopProjectBinding | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Partial<ProjectBindingRow>;
  const aliases = typeof value.aliases_json === "string" ? parseStringArray(value.aliases_json) : null;
  const verificationKeys = typeof value.verification_keys_json === "string"
    ? parseStringArray(value.verification_keys_json)
    : null;
  if (
    typeof value.id !== "string" || !value.id
    || typeof value.identity_key !== "string" || !value.identity_key
    || !aliases || !verificationKeys
    || typeof value.root_path !== "string" || !value.root_path
    || !["configured", "git_remote", "local_git", "local_folder"].includes(value.source || "")
    || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))
    || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))
  ) return null;
  return {
    id: value.id,
    identityKey: value.identity_key,
    verificationKeys,
    aliases,
    rootPath: value.root_path,
    source: value.source!,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function readBindings(options: ProjectBindingsStoreOptions = {}): DesktopProjectBinding[] {
  const database = openStore(options);
  try {
    return database.prepare(`
      SELECT id, identity_key, verification_keys_json, aliases_json,
             root_path, source, created_at, updated_at
      FROM project_bindings
      ORDER BY created_at ASC
    `).all().map(mapRow).filter((binding): binding is DesktopProjectBinding => Boolean(binding));
  } finally {
    database.close();
  }
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
  const rootStats = await stat(rootPath, { bigint: true });
  const keys = new Set(projectBindingVerificationKeys(context));
  keys.add(`fs-root:${rootStats.dev}:${rootStats.ino}:${rootStats.birthtimeNs}`);
  try {
    const gitStats = await stat(join(rootPath, ".git"), { bigint: true });
    keys.add(`fs-git:${gitStats.dev}:${gitStats.ino}:${gitStats.birthtimeNs}`);
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
  const bindings = readBindings(options);
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
  const now = new Date().toISOString();
  const database = openStore(options);
  try {
    database.exec("BEGIN IMMEDIATE");
    const existing = database.prepare(`
      SELECT id, identity_key, verification_keys_json, aliases_json,
             root_path, source, created_at, updated_at
      FROM project_bindings
      WHERE identity_key = ?
    `).get(identityKey);
    const current = mapRow(existing);
    const binding: DesktopProjectBinding = {
      id: current?.id || randomUUID(),
      identityKey,
      verificationKeys,
      aliases,
      rootPath,
      source: input.source,
      createdAt: current?.createdAt || now,
      updatedAt: now,
    };
    database.prepare(`
      INSERT INTO project_bindings (
        id, identity_key, verification_keys_json, aliases_json,
        root_path, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET
        verification_keys_json = excluded.verification_keys_json,
        aliases_json = excluded.aliases_json,
        root_path = excluded.root_path,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(
      binding.id,
      binding.identityKey,
      JSON.stringify(binding.verificationKeys),
      JSON.stringify(binding.aliases),
      binding.rootPath,
      binding.source,
      binding.createdAt,
      binding.updatedAt,
    );
    database.exec("COMMIT");
    return binding;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the transaction's original failure.
    }
    throw error;
  } finally {
    database.close();
  }
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
      if (candidate.legacyKey) retryLegacyKeys.add(candidate.legacyKey);
    }
  }
  return {
    bindings: await listProjectBindings(options),
    retryLegacyKeys: [...retryLegacyKeys].sort(),
  };
}
