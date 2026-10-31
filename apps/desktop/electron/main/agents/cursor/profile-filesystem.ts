// Owner-private profile filesystem primitives: no-follow reads, atomic writes,
// private trees, journal pruning, approval-state purges, and login keychain links.

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { openNoFollowSync, ownerPrivatePlatform, protectOwnerPrivateSync, writePrivateFileAtomicallySync } from "../../../../../../shared/owner-private-fs.mjs";
import { getLetAgentsLocalStatePath } from "../../paths.js";
import {
  CURSOR_STATSIG_TEMP_PATTERN,
  CURSOR_TURN_STREAM_PATTERN,
  DARWIN_CURSOR_ENTERPRISE_HOOK_PATH,
  MAX_CURSOR_PROFILE_ENTRIES,
  RETAINED_CURSOR_TURN_JOURNALS,
} from "./profile-types.js";

export function assertCursorPlatformEnterpriseHooksAbsent(): void {
  if (process.platform === "darwin" && pathEntryExists(DARWIN_CURSOR_ENTERPRISE_HOOK_PATH)) {
    throw new Error(
      `Cursor enterprise hooks are not supported for supervised agents (${DARWIN_CURSOR_ENTERPRISE_HOOK_PATH}). Remove the hook policy before starting the agent.`,
    );
  }
}

export function removePrivateProfileAuthorityEntry(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error(`Cursor private authority state is not a file: ${path}`);
  }
  unlinkSync(path);
}

/** Remove a private provider-managed authority subtree without following it. */
export function removePrivateProfileTreeEntry(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: false });
    return;
  }
  unlinkSync(path);
}

/**
 * Cursor writes Statsig atomically through sibling
 * `statsig-cache.json.<pid>.<uuid>.tmp` files. The final authority file is
 * sandbox-denied, so interrupted/denied renames can otherwise leave megabytes
 * of remote feature configuration in the stable attempt profile. Inspect only
 * the exact private directory shape and unlink entries without following them.
 */
export function purgeCursorStatsigTemporaryFiles(cursorRuntimeConfigDir: string): void {
  const directory = opendirSync(cursorRuntimeConfigDir);
  let entries = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > MAX_CURSOR_PROFILE_ENTRIES) {
        throw new Error("Cursor runtime config contains too many entries to inspect safely.");
      }
      if (!CURSOR_STATSIG_TEMP_PATTERN.test(entry.name)) continue;
      removePrivateProfileAuthorityEntry(join(cursorRuntimeConfigDir, entry.name));
    }
  } finally {
    directory.closeSync();
  }
}

/** Escape an absolute filesystem path for a literal Seatbelt regex prefix. */
export function escapeSandboxRegex(path: string): string {
  if (/[\x00-\x1f\x7f[\]\\^]/.test(path)) {
    throw new Error("Cursor sandbox regex paths contain unsupported characters.");
  }
  return [...path].map((character) => /[A-Za-z0-9/_-]/.test(character)
    ? character
    : `[${character}]`).join("");
}

/**
 * Remove Cursor's persisted project-MCP grants without deleting conversation
 * state stored beside them. Cursor currently stores each grant at
 * `projects/<workspace>/mcp-approvals.json`. We deliberately inspect exactly
 * that bounded shape and never follow a redirected projects/workspace entry.
 */
export function purgeCursorMcpApprovalState(projectsRoot: string): void {
  let rootStat;
  try {
    rootStat = lstatSync(projectsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    // This entry belongs entirely to the private profile. Removing the entry
    // cannot affect a symlink target and prevents Cursor from following it.
    if (rootStat.isDirectory()) {
      throw new Error(`Cursor MCP approval root is not a real directory: ${projectsRoot}`);
    }
    unlinkSync(projectsRoot);
    return;
  }

  const projects = opendirSync(projectsRoot);
  let entries = 0;
  try {
    for (;;) {
      const project = projects.readSync();
      if (!project) break;
      entries += 1;
      if (entries > MAX_CURSOR_PROFILE_ENTRIES) {
        throw new Error("Cursor project state contains too many entries to inspect safely.");
      }
      const projectPath = join(projectsRoot, project.name);
      const projectStat = lstatSync(projectPath);
      if (projectStat.isSymbolicLink()) {
        // A redirected project directory could conceal an approval file. Drop
        // only the link; its target and any transcript there are untouched.
        unlinkSync(projectPath);
        continue;
      }
      if (!projectStat.isDirectory()) continue;

      const approvalPath = join(projectPath, "mcp-approvals.json");
      let approvalStat;
      try {
        approvalStat = lstatSync(approvalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (approvalStat.isDirectory() && !approvalStat.isSymbolicLink()) {
        throw new Error(`Cursor MCP approval state is not a file: ${approvalPath}`);
      }
      // unlink removes a regular/special file or the symlink itself without
      // following it. Cursor will recreate a clean approval record if needed.
      unlinkSync(approvalPath);
    }
  } finally {
    projects.closeSync();
  }
}

/** Remove only the deterministic owner-private profile for an exact purged attempt. */
export function removeCursorSupervisedProfile(workAttemptId: string): void {
  const normalized = workAttemptId.trim();
  if (!normalized) return;
  const profileRoot = join(
    dirname(getLetAgentsLocalStatePath()),
    "cursor-supervised",
    createHash("sha256").update(normalized).digest("hex").slice(0, 32),
  );
  const profileParent = dirname(profileRoot);
  if (!existsSync(profileParent)) return;
  assertRealDirectory(profileParent, "Cursor supervised profile parent");
  if (!existsSync(profileRoot)) return;
  const stat = lstatSync(profileRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing to purge a redirected Cursor supervised profile.");
  }
  rmSync(profileRoot, { recursive: true, force: true });
}

export function copyOptionalFile(source: string, destination: string): void {
  if (!existsSync(source)) {
    return;
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function pruneCompletedCursorTurnJournals(configDir: string): void {
  const directory = opendirSync(configDir);
  const completed: Array<{ streamPath: string; terminalPath: string; mtimeMs: number }> = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > MAX_CURSOR_PROFILE_ENTRIES) {
        throw new Error("Cursor supervised profile contains too many entries to inspect safely.");
      }
      if (!entry.name.endsWith(".terminal.json")) continue;
      const streamName = entry.name.slice(0, -".terminal.json".length);
      if (!CURSOR_TURN_STREAM_PATTERN.test(streamName)) continue;
      const terminalPath = join(configDir, entry.name);
      const streamPath = join(configDir, streamName);
      const terminalStat = lstatSync(terminalPath);
      if (!terminalStat.isFile() || terminalStat.isSymbolicLink()) {
        throw new Error("Cursor supervised terminal journal is not a regular file.");
      }
      let streamStat;
      try {
        streamStat = lstatSync(streamPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!streamStat.isFile() || streamStat.isSymbolicLink()) {
        throw new Error("Cursor supervised stream journal is not a regular file.");
      }
      completed.push({ streamPath, terminalPath, mtimeMs: terminalStat.mtimeMs });
    }
  } finally {
    directory.closeSync();
  }
  completed.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const journal of completed.slice(RETAINED_CURSOR_TURN_JOURNALS)) {
    // Retire authority first. A crash can leave only an inert stream prefix.
    unlinkSync(journal.terminalPath);
    try {
      unlinkSync(journal.streamPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Replace a private profile file without following a destination symlink left
 * by a prior provider turn. The temporary file is created beside the target
 * with owner-only permissions, then renamed over the directory entry.
 */
export function writePrivateFileAtomic(destination: string, data: string | Buffer): void {
  const parent = dirname(destination);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`Cursor private profile parent is not a real directory: ${parent}`);
  }
  // Windows has no mode bits: the shared writer gives the temporary file the private DACL first.
  if (ownerPrivatePlatform() === "win32") {
    writePrivateFileAtomicallySync(destination, data);
    return;
  }
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, destination);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the original failure; a same-profile retry may clean up the
      // owner-only temporary file after the filesystem becomes writable.
    }
    throw error;
  }
}

export function linkDarwinLoginKeychains(sourceHomeDir: string, homeDir: string): void {
  if (process.platform !== "darwin") {
    return;
  }
  const source = join(sourceHomeDir, "Library", "Keychains");
  if (!existsSync(source)) {
    return;
  }
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Cursor login keychain source must be a real directory.");
  }
  const link = join(homeDir, "Library", "Keychains");
  ensurePrivateDirectory(dirname(link));
  if (existsSync(link)) {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink() || readlinkSync(link) !== source) {
      throw new Error("Cursor private profile contains an unexpected login keychain entry.");
    }
    return;
  }
  symlinkSync(source, link, "dir");
}

/**
 * Windows has no login Keychain: Cursor keeps its login in
 * %APPDATA%\\Cursor\\auth.json. As on macOS, only a profile that may see the
 * login gets it. It is a hard link, so a token Cursor refreshes reaches the
 * owner's own file, and removing the profile leaves that file as it is.
 */
export function linkWindowsCursorLogin(sourceHomeDir: string, homeDir: string, sourceAppData = process.env.APPDATA?.trim(), platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  removeWindowsCursorLogin(homeDir, platform);
  const source = join(sourceAppData || join(sourceHomeDir, "AppData", "Roaming"), "Cursor", "auth.json");
  if (!pathEntryExists(source)) return;
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Cursor's saved login must be a regular file.");
  const roaming = join(homeDir, "AppData", "Roaming");
  ensurePrivateProfileTree(homeDir, [join(homeDir, "AppData"), roaming, join(roaming, "Cursor")]);
  // The profile may be on another volume than APPDATA. A copy then holds until the next link.
  try { linkSync(source, windowsCursorLoginPath(homeDir)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(source, windowsCursorLoginPath(homeDir));
  }
}

export function removeWindowsCursorLogin(homeDir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  // A junction in the profile must not lead this removal to the owner's own file.
  for (const folder of [join(homeDir, "AppData"), join(homeDir, "AppData", "Roaming"), join(homeDir, "AppData", "Roaming", "Cursor")]) {
    if (pathEntryExists(folder) && lstatSync(folder).isSymbolicLink()) {
      throw new Error("Cursor private profile contains an unexpected link where its login folder belongs.");
    }
  }
  removePrivateProfileAuthorityEntry(windowsCursorLoginPath(homeDir));
}

function windowsCursorLoginPath(homeDir: string): string {
  return join(homeDir, "AppData", "Roaming", "Cursor", "auth.json");
}

export function darwinLoginKeychainReadRoots(sourceHomeDir: string): string[] {
  if (process.platform !== "darwin") return [];
  const source = join(sourceHomeDir, "Library", "Keychains");
  if (!existsSync(source)) return [];
  const stat = lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Cursor login keychain source must be a real directory.");
  }
  return [realpathSync(source)];
}

export function ensurePrivateProfileTree(profileRoot: string, directories: string[]): void {
  ensureRealDirectoryChain(dirname(profileRoot));
  if (!existsSync(profileRoot)) mkdirSync(profileRoot, { recursive: false, mode: 0o700 });
  ensurePrivateDirectory(profileRoot);
  const canonicalRoot = realpathSync(profileRoot);
  const logicalRoot = resolve(profileRoot);
  for (const directory of directories) {
    const logicalDirectory = resolve(directory);
    const suffix = relative(logicalRoot, logicalDirectory);
    if (suffix.startsWith("..") || resolve(logicalRoot, suffix) !== logicalDirectory) {
      throw new Error(`Cursor private profile directory escapes its root: ${directory}`);
    }
    ensurePrivateDirectory(directory);
    const canonical = realpathSync(directory);
    const expectedCanonical = resolve(canonicalRoot, suffix);
    if (canonical !== expectedCanonical) {
      throw new Error(`Cursor private profile directory is redirected outside its root: ${directory}`);
    }
  }
}

/** Create only missing descendants below the nearest existing real directory. */
function ensureRealDirectoryChain(directory: string): void {
  const missing: string[] = [];
  let cursor = resolve(directory);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Cursor private profile has no real parent: ${directory}`);
    missing.push(cursor);
    cursor = parent;
  }
  assertRealDirectory(cursor, "Cursor private profile ancestor");
  for (const component of missing.reverse()) {
    mkdirSync(component, { recursive: false, mode: 0o700 });
    assertRealDirectory(component, "Cursor private profile parent");
  }
}

function assertRealDirectory(directory: string, label: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
}

function ensurePrivateDirectory(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: false, mode: 0o700 });
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Cursor private profile path is not a real directory: ${directory}`);
  }
  protectOwnerPrivateSync(directory, "directory");
}

export function readRegularFileNoFollow(path: string, maxBytes: number): Buffer {
  let fd: number | null = null;
  try {
    fd = openNoFollowSync(path, constants.O_RDONLY);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw new Error(`exceeds the ${maxBytes}-byte limit`);
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(fd);
    if (offset !== data.length || after.size !== stat.size
      || after.dev !== stat.dev || after.ino !== stat.ino
      || after.mtimeMs !== stat.mtimeMs) {
      throw new Error("changed while it was being read");
    }
    return data;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cursor config must be a bounded regular file at ${path}: ${detail}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function normalizePath(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? resolve(trimmed) : null;
}
