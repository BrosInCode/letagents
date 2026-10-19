import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
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
  resolveFilesystemNamespace?: (rootPath: string) => Promise<string | null>;
}

interface FilesystemVerification {
  keys: string[];
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

type OpenStore = { database: SqliteDatabase; dev: number; ino: number };

const openStores = new Map<string, OpenStore>();
const OPEN_STORE_LIMIT = 4;

/**
 * One long-lived connection per store file. Every statement runs
 * synchronously, so callers never interleave inside a transaction. The file's
 * identity is checked on each use: a deleted or replaced store reopens.
 */
function openStore(options: ProjectBindingsStoreOptions = {}): SqliteDatabase {
  const storePath = getProjectBindingsStorePath(options);
  const cached = openStores.get(storePath);
  if (cached) {
    try {
      const current = statSync(storePath);
      if (current.dev === cached.dev && current.ino === cached.ino) return cached.database;
    } catch {
      // Missing store: reopen below, which recreates it.
    }
    openStores.delete(storePath);
    try { cached.database.close(); } catch { /* already closed */ }
  }
  const database = openStoreConnection(storePath);
  const identity = statSync(storePath);
  if (openStores.size >= OPEN_STORE_LIMIT) {
    const [oldestPath, oldest] = openStores.entries().next().value as [string, OpenStore];
    openStores.delete(oldestPath);
    try { oldest.database.close(); } catch { /* already closed */ }
  }
  openStores.set(storePath, { database, dev: identity.dev, ino: identity.ino });
  return database;
}

/** Test-only: close long-lived connections and forget every validation memo. */
export function resetProjectBindingsStoreCachesForTest(): void {
  for (const { database } of openStores.values()) {
    try { database.close(); } catch { /* already closed */ }
  }
  openStores.clear();
  validatedBindings.clear();
}

function openStoreConnection(storePath: string): SqliteDatabase {
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

function discardStore(storePath: string, database: SqliteDatabase): void {
  if (openStores.get(storePath)?.database === database) openStores.delete(storePath);
  try { database.close(); } catch { /* already closed */ }
}

/** Test-only hook run inside the bind transaction, just before COMMIT. */
export const projectBindingsStoreTestHooks: { beforeCommit?: (database: SqliteDatabase) => void } = {};

function releaseStore(_database: SqliteDatabase): void {
  // The connection is shared and long-lived; see openStore.
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

function runSystemCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
      windowsHide: true,
    }, (error, stdout) => resolve(error ? null : stdout.trim()));
  });
}

export function parseMacosVolumeUuid(diskInfoPlist: string): string | null {
  const readUuid = (key: "VolumeUUID" | "DiskUUID") =>
    new RegExp(`<key>${key}</key>\\s*<string>([A-F\\d-]+)</string>`, "i").exec(diskInfoPlist)?.[1];
  return readUuid("VolumeUUID") || readUuid("DiskUUID") || null;
}

async function defaultFilesystemNamespace(rootPath: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const diskUsage = await runSystemCommand("/bin/df", ["-P", rootPath]);
  const device = diskUsage?.split(/\r?\n/).slice(1).find(Boolean)?.trim().split(/\s+/)[0];
  if (!device) return null;
  const diskInfo = await runSystemCommand("/usr/sbin/diskutil", ["info", "-plist", device]);
  const volumeUuid = diskInfo && parseMacosVolumeUuid(diskInfo);
  return volumeUuid ? `darwin:${volumeUuid.toLowerCase()}` : null;
}

function namespaceDigest(namespace: string): string {
  return createHash("sha256").update(namespace).digest("hex");
}

function filesystemObjectKey(key: string, durable: boolean): string | null {
  const match = durable
    ? /^(fs-(?:root|git)):v2:[a-f\d]{64}:(\d+):(\d+)$/i.exec(key)
    : /^(fs-(?:root|git)):\d+:(\d+):(\d+)$/.exec(key);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
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
    releaseStore(database);
  }
}

function readBindingById(
  bindingId: string,
  options: ProjectBindingsStoreOptions,
): DesktopProjectBinding | null {
  const database = openStore(options);
  try {
    return mapRow(database.prepare(`
      SELECT id, identity_key, verification_keys_json, aliases_json,
             root_path, source, created_at, updated_at
      FROM project_bindings
      WHERE id = ?
    `).get(bindingId));
  } finally {
    releaseStore(database);
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

/**
 * Mount device number -> volume UUID (df + diskutil), shared only inside one
 * listProjectBindings pass. Device numbers are reused when another volume is
 * mounted at the same place, so an answer never outlives the pass.
 */
type FilesystemNamespaceCache = Map<string, Promise<string | null>>;

let filesystemNamespaceResolver: (path: string) => Promise<string | null> = defaultFilesystemNamespace;

/** Test-only: replace the df + diskutil lookup used for the default namespace path. */
export function setFilesystemNamespaceResolverForTest(
  resolver: ((path: string) => Promise<string | null>) | null,
): void {
  filesystemNamespaceResolver = resolver ?? defaultFilesystemNamespace;
}

async function filesystemVerificationKeys(
  rootPath: string,
  context: DesktopProjectBindingContext,
  options: ProjectBindingsStoreOptions,
  namespaceCache: FilesystemNamespaceCache = new Map(),
): Promise<FilesystemVerification> {
  const rootStats = await stat(rootPath, { bigint: true });
  const resolveNamespace = async (path: string, device: bigint): Promise<string | null> => {
    if (options.resolveFilesystemNamespace) return options.resolveFilesystemNamespace(path);
    const cacheKey = device.toString();
    let namespace = namespaceCache.get(cacheKey);
    if (!namespace) {
      namespace = filesystemNamespaceResolver(path);
      namespaceCache.set(cacheKey, namespace);
    }
    return namespace;
  };
  const rootNamespace = await resolveNamespace(rootPath, rootStats.dev);
  const rootNamespaceKey = rootNamespace ? namespaceDigest(rootNamespace) : null;
  const keys = new Set(projectBindingVerificationKeys(context));
  keys.add(rootNamespaceKey
    ? `fs-root:v2:${rootNamespaceKey}:${rootStats.ino}:${rootStats.birthtimeNs}`
    : `fs-root:${rootStats.dev}:${rootStats.ino}:${rootStats.birthtimeNs}`);
  try {
    const gitPath = join(rootPath, ".git");
    const gitStats = await stat(gitPath, { bigint: true });
    const gitNamespace = await resolveNamespace(gitPath, gitStats.dev);
    const gitNamespaceKey = gitNamespace ? namespaceDigest(gitNamespace) : null;
    keys.add(gitNamespaceKey
      ? `fs-git:v2:${gitNamespaceKey}:${gitStats.ino}:${gitStats.birthtimeNs}`
      : `fs-git:${gitStats.dev}:${gitStats.ino}:${gitStats.birthtimeNs}`);
  } catch {
    // Plain folders have no Git identity axis.
  }
  return { keys: [...keys].sort() };
}

function compareVerificationKeys(
  storedKeys: readonly string[],
  current: FilesystemVerification,
): { matches: boolean; shouldUpgrade: boolean } {
  const currentKeys = new Set(current.keys);
  const durableFilesystemObjects = new Set(
    current.keys.map((key) => filesystemObjectKey(key, true)).filter(Boolean),
  );
  let shouldUpgrade = false;
  for (const storedKey of storedKeys) {
    if (currentKeys.has(storedKey)) continue;
    // Old releases only recorded the ephemeral mount device number. Recover
    // that proof once from the durable object fields, then persist v2 below.
    const legacyObject = filesystemObjectKey(storedKey, false);
    if (!legacyObject || !durableFilesystemObjects.has(legacyObject)) {
      return { matches: false, shouldUpgrade: false };
    }
    shouldUpgrade = true;
  }
  return { matches: true, shouldUpgrade };
}

function replaceVerificationKeysIfCurrent(
  binding: DesktopProjectBinding,
  verificationKeys: string[],
  options: ProjectBindingsStoreOptions,
): boolean {
  const database = openStore(options);
  try {
    const result = database.prepare(`
      UPDATE project_bindings
      SET verification_keys_json = ?
      WHERE id = ? AND root_path = ? AND updated_at = ? AND verification_keys_json = ?
    `).run(
      JSON.stringify(verificationKeys),
      binding.id,
      binding.rootPath,
      binding.updatedAt,
      JSON.stringify(binding.verificationKeys),
    ) as { changes?: number | bigint };
    return Number(result.changes || 0) === 1;
  } finally {
    releaseStore(database);
  }
}

function sameLocalProjectAfterGitSetup(
  binding: DesktopProjectBinding,
  current: FilesystemVerification,
  source: DesktopProjectBindingSource,
): boolean {
  if (source !== "local_git" && source !== "git_remote") return false;
  const identityKeys = binding.verificationKeys.filter((key) => !key.startsWith("fs-"));
  const localRoomKey = /^(?:project-room:(?:git-room:local:[a-f0-9]+|local-[a-z0-9-]+-[a-f0-9]{10}|local\/.+)|repository-id:local:.+)$/;
  if (!identityKeys.length || !identityKeys.every((key) => localRoomKey.test(key))) return false;
  const filesystemKeys = binding.verificationKeys.filter((key) => key.startsWith("fs-"));
  // A remote is new metadata on the same project, not a replacement folder.
  // Require every saved object (including .git, when present) to still match.
  // Persisting the hosted verification keys ends this local-only exception;
  // subsequent remote replacements must pass the ordinary strict check.
  return filesystemKeys.some((key) => key.startsWith("fs-root:"))
    && compareVerificationKeys(filesystemKeys, current).matches;
}

/**
 * Bindings that passed the full validation below, keyed by binding id. A memo
 * is reused only while all of these still hold:
 *  - the stored row is byte-for-byte the row that was validated;
 *  - the folder still canonicalizes to the same path and is not a managed
 *    worktree (canonicalDirectory runs on every call);
 *  - the folder and its `.git` directory are the same filesystem objects
 *    (device, inode, birth time) - a swapped folder or Git directory differs;
 *  - HEAD, config, config.worktree, commondir, packed-refs and
 *    refs/remotes/origin/HEAD are unchanged (device, inode, size, mtime,
 *    ctime) - these feed the derived room;
 *  - the global and system Git config files and the GIT_CONFIG_* variables
 *    are unchanged (they can rewrite the origin URL through insteadOf);
 *  - fewer than 45 seconds have passed (fallback for anything not listed,
 *    for example a nested local branch file).
 * Only folders whose `.git` is a real directory are memoized. Plain folders,
 * linked worktrees (`.git` file), nested checkouts and any repository whose
 * config (or the global config) uses [include]/[includeIf] validate in full:
 * an included file can change the origin URL without touching these files.
 */
type ValidatedBinding = {
  row: string;
  fingerprint: string;
  expiresAt: number;
};

const validatedBindings = new Map<string, ValidatedBinding>();
const VALIDATED_BINDING_TTL_MS = 45_000;
const VALIDATED_BINDING_LIMIT = 256;

/** Test-only counters: full validations and memo hits. */
export const projectBindingValidationCountsForTest = { full: 0, memo: 0 };

function bindingRowKey(binding: DesktopProjectBinding): string {
  return JSON.stringify([
    binding.id,
    binding.identityKey,
    binding.verificationKeys,
    binding.aliases,
    binding.rootPath,
    binding.source,
    binding.createdAt,
    binding.updatedAt,
  ]);
}

async function statIdentity(path: string, content: boolean): Promise<string> {
  try {
    const info = await lstat(path, { bigint: true });
    const identity = [info.dev, info.ino, info.birthtimeNs, info.mode];
    if (content) identity.push(info.size, info.mtimeNs, info.ctimeNs);
    return identity.join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "-";
    throw error;
  }
}

const GIT_CONFIG_INCLUDE = /^\s*\[\s*include(?:if)?\b/im;

function globalGitConfigPaths(): string[] {
  const home = homedir();
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return [
    process.env.GIT_CONFIG_GLOBAL?.trim() || join(home, ".gitconfig"),
    join(xdg, "git", "config"),
    process.env.GIT_CONFIG_SYSTEM?.trim() || "/etc/gitconfig",
    "/opt/homebrew/etc/gitconfig",
    "/usr/local/etc/gitconfig",
  ];
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw error;
  }
}

async function bindingFingerprint(rootPath: string): Promise<string | null> {
  try {
    const gitPath = join(rootPath, ".git");
    const gitInfo = await lstat(gitPath);
    if (!gitInfo.isDirectory()) return null;
    const configFiles = [join(gitPath, "config"), join(gitPath, "config.worktree"), ...globalGitConfigPaths()];
    const configTexts = await Promise.all(configFiles.map(readOptionalText));
    if (configTexts.some((text) => GIT_CONFIG_INCLUDE.test(text))) return null;
    const parts = await Promise.all([
      statIdentity(rootPath, false),
      statIdentity(gitPath, false),
      ...["HEAD", "commondir", "packed-refs", join("refs", "remotes", "origin", "HEAD")]
        .map((name) => statIdentity(join(gitPath, name), true)),
      ...configFiles.map((path) => statIdentity(path, true)),
    ]);
    const environment = Object.keys(process.env)
      .filter((name) => name.startsWith("GIT_"))
      .sort()
      .map((name) => [name, process.env[name]]);
    return JSON.stringify([rootPath, ...parts, environment]);
  } catch {
    return null;
  }
}

function rememberValidatedBinding(binding: DesktopProjectBinding, fingerprint: string): void {
  const now = Date.now();
  if (validatedBindings.size >= VALIDATED_BINDING_LIMIT) {
    for (const [id, entry] of validatedBindings) {
      if (entry.expiresAt <= now) validatedBindings.delete(id);
    }
    if (validatedBindings.size >= VALIDATED_BINDING_LIMIT) validatedBindings.clear();
  }
  validatedBindings.set(binding.id, {
    row: bindingRowKey(binding),
    fingerprint,
    expiresAt: now + VALIDATED_BINDING_TTL_MS,
  });
}

async function validateProjectBinding(
  binding: DesktopProjectBinding,
  options: ProjectBindingsStoreOptions,
  namespaceCache: FilesystemNamespaceCache,
  rereadOnConflict: boolean,
): Promise<DesktopProjectBinding | null> {
  try {
    const rootPath = await canonicalDirectory(binding.rootPath);
    // Taken before validation: a change during validation alters the next
    // fingerprint, so a racing swap can never be served from this memo.
    const fingerprint = await bindingFingerprint(rootPath);
    const memo = validatedBindings.get(binding.id);
    if (
      memo && fingerprint
      && memo.expiresAt > Date.now()
      && memo.row === bindingRowKey(binding)
      && memo.fingerprint === fingerprint
    ) {
      projectBindingValidationCountsForTest.memo += 1;
      return binding;
    }
    validatedBindings.delete(binding.id);
    projectBindingValidationCountsForTest.full += 1;
    const derived = await deriveFilesystemContext(rootPath);
    const current = await filesystemVerificationKeys(rootPath, derived.context, options, namespaceCache);
    const comparison = compareVerificationKeys(binding.verificationKeys, current);
    const gitSetup = !comparison.matches && sameLocalProjectAfterGitSetup(binding, current, derived.source);
    if (!comparison.matches && !gitSetup) return null;
    if (!comparison.shouldUpgrade && !gitSetup) {
      if (fingerprint) rememberValidatedBinding(binding, fingerprint);
      return binding;
    }
    try {
      if (replaceVerificationKeysIfCurrent(binding, current.keys, options)) {
        return { ...binding, verificationKeys: current.keys };
      }
    } catch {
      // Re-read below so a failed upgrade can never return superseded state.
    }
    if (!rereadOnConflict) return null;
    const latest = readBindingById(binding.id, options);
    return latest
      ? validateProjectBinding(latest, options, namespaceCache, false)
      : null;
  } catch {
    return null;
  }
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
  const namespaceCache: FilesystemNamespaceCache = new Map();
  const available = await Promise.all(bindings.map((binding) =>
    validateProjectBinding(binding, options, namespaceCache, true)
  ));
  return available.filter((binding): binding is DesktopProjectBinding => Boolean(binding));
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
  const verificationKeys = (await filesystemVerificationKeys(rootPath, filesystem.context, options)).keys;
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
    projectBindingsStoreTestHooks.beforeCommit?.(database);
    database.exec("COMMIT");
    return binding;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The shared connection may still be inside the transaction. Discard
      // it so no later caller inherits (or commits) half of this write.
      // The original failure is preserved below.
      discardStore(getProjectBindingsStorePath(options), database);
    }
    throw error;
  } finally {
    releaseStore(database);
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
      const status = await buildRepoStatus(resolved.repoRoot || rootPath, { includeBranchDeltas: false });
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
