import { constants } from "node:fs";
import { link, lstat, open, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { letagentsHome } from "./letagents-home.mjs";
import {
  createPrivateDir, createPrivateStagingFolder, isOwnedByCurrentUser, isOwnerPrivate, openNoFollow, ownerPrivatePlatform,
  protectOwnerPrivate, syncDirectory as syncFolder,
} from "./owner-private-fs.mjs";

export const daemonMaintenancePath = (root = letagentsHome()) => join(root, "daemon-maintenance.json");
export const DAEMON_MAINTENANCE_MESSAGE = "Agent supervision is paused for service maintenance. Resume it in Settings → Updates.";

async function syncDirectory(path) {
  await syncFolder(dirname(path));
}

/**
 * Windows reads a file's permissions by path, so a record is trusted only in
 * a folder no other account can change (no swap during the read).
 */
async function privateParent(path) {
  const folder = dirname(path);
  const info = await lstat(folder);
  return info.isDirectory() && !info.isSymbolicLink() && await isOwnerPrivate(folder, info);
}

/**
 * Windows: "no record" is trusted only where no other account could have
 * deleted one. A hold is only ever written into a private folder, so a folder
 * of this account's that is not private yet has never held one: it is made
 * private now and the absence stands. A missing folder holds nothing. A
 * folder another account owns fails closed.
 */
async function absenceIsTrusted(path) {
  try { await ensurePrivateParent(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

/** Windows: make this account's own state folder private if it is not yet (the daemon does the same at start). */
async function ensurePrivateParent(path) {
  const folder = dirname(path);
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || !await isOwnedByCurrentUser(folder, info)) {
    throw new Error("Unsafe service maintenance folder.");
  }
  if (!await isOwnerPrivate(folder, info)) await protectOwnerPrivate(folder, "directory");
}

/** Only ENOENT means normal operation. Corruption or an unsafe path must fail closed. */
export async function readDaemonMaintenance(path = daemonMaintenancePath()) {
  let file;
  try { file = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (ownerPrivatePlatform() === "win32") await absenceIsTrusted(path);
    return null;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || !await isOwnerPrivate(path, stat)
      || (ownerPrivatePlatform() === "win32" && !await privateParent(path))) throw new Error("Unsafe service maintenance record.");
    const value = JSON.parse(await file.readFile("utf8"));
    if (value?.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || Object.keys(value).sort().join(",") !== "createdAt,id,version") throw new Error("Invalid service maintenance record.");
    return value;
  } finally { await file.close(); }
}

/** Publish a complete, fsynced hold before any daemon signal; never replace an existing hold. */
async function publishHold(path) {
  const existing = await readDaemonMaintenance(path);
  if (existing) { await syncDirectory(path); return existing; }
  await createPrivateDir(dirname(path), { recursive: true });
  const value = { version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
  // Windows has no mode bits: the record is made inside a private staging
  // folder, so it is private from birth, and gets its own DACL before it is
  // written. The hard link shares that DACL.
  const staging = ownerPrivatePlatform() === "win32" ? await createPrivateStagingFolder(path) : null;
  const temporary = staging ? join(staging, "record") : `${path}.${value.id}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      if (staging) await protectOwnerPrivate(temporary, "file");
      await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await file.sync();
      try { await link(temporary, path); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      await syncDirectory(path);
      const published = await readDaemonMaintenance(path);
      if (!published) throw new Error("Service maintenance record disappeared before commit.");
      return published;
    } finally {
      await file.close();
      // Windows: the staging folder removal below also cleans up; a busy file must not undo a published hold.
      if (staging) await unlink(temporary).catch(() => undefined);
      else await unlink(temporary);
    }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Explicit resume owns removal, after the held daemon has exited. */
async function removeHold(id, path) {
  const before = await lstat(path);
  const value = await readDaemonMaintenance(path);
  const after = await lstat(path);
  if (!value || value.id !== id || before.ino !== after.ino || before.dev !== after.dev) {
    throw new Error("Service maintenance changed. Refresh before resuming.");
  }
  await unlink(path);
  await syncDirectory(path);
}

// Keep this inode forever. Unlinking a flock file can create two owners. Darwin
// uses the kernel lock; non-Darwin tests model ownership in-process, like the
// daemon singleton. Product maintenance is currently macOS-only.
const simulatedClaims = new Set();
export async function withDaemonMaintenanceOperation(operation, path = daemonMaintenancePath()) {
  const lockPath = `${resolve(path)}.lock`;
  await createPrivateDir(dirname(lockPath), { recursive: true });
  if (ownerPrivatePlatform() === "win32") await ensurePrivateParent(lockPath);
  const native = process.platform === "darwin";
  if (!native && simulatedClaims.has(lockPath)) throw new Error("Another service maintenance action is in progress.");
  if (!native) simulatedClaims.add(lockPath);
  let lock;
  let active = true;
  const assertActive = () => { if (!active) throw new Error("Service maintenance action has ended."); };
  try {
    if (ownerPrivatePlatform() === "win32") await createWindowsLock(lockPath);
    lock = await openNoFollow(lockPath, constants.O_CREAT | constants.O_RDWR
      | constants.O_NONBLOCK | (native ? 0x20 /* Darwin O_EXLOCK */ : 0), 0o600);
    let stat = await lock.stat();
    // Windows: another of this account's processes may have made the lock and
    // not yet set its DACL. A lock this account owns is made private here
    // (it holds no data); one another account owns is refused.
    if (ownerPrivatePlatform() === "win32" && stat.isFile() && !await isOwnerPrivate(lockPath, stat)
      && await isOwnedByCurrentUser(lockPath, stat)) {
      await protectOwnerPrivate(lockPath, "file");
      stat = await lock.stat();
    }
    if (!stat.isFile() || !await isOwnerPrivate(lockPath, stat)) {
      throw new Error("Unsafe service maintenance lock.");
    }
    return await operation({
      read: () => { assertActive(); return readDaemonMaintenance(path); },
      create: () => { assertActive(); return publishHold(path); },
      clear: id => { assertActive(); return removeHold(id, path); },
    });
  } catch (error) {
    if (["EAGAIN", "EWOULDBLOCK"].includes(error.code)) throw new Error("Another service maintenance action is in progress.");
    throw error;
  } finally {
    active = false;
    await lock?.close();
    if (!native) simulatedClaims.delete(lockPath);
  }
}
/** Windows has no mode bits: a new lock file is made exclusively and given its private DACL before use. */
async function createWindowsLock(lockPath) {
  let created;
  try { created = await open(lockPath, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") return; throw error; }
  try { await protectOwnerPrivate(lockPath, "file"); } finally { await created.close(); }
}
export const createDaemonMaintenance = (path = daemonMaintenancePath()) => withDaemonMaintenanceOperation(owner => owner.create(), path);
export const clearDaemonMaintenance = (id, path = daemonMaintenancePath()) => withDaemonMaintenanceOperation(owner => owner.clear(id), path);
