import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const daemonMaintenancePath = (root = join(homedir(), ".letagents")) => join(root, "daemon-maintenance.json");
export const DAEMON_MAINTENANCE_MESSAGE = "Agent supervision is paused for service maintenance. Resume it in Settings → Updates.";

async function syncDirectory(path) {
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Only ENOENT means normal operation. Corruption or an unsafe path must fail closed. */
export async function readDaemonMaintenance(path = daemonMaintenancePath()) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe service maintenance record.");
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const value = { version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
  const temporary = `${path}.${value.id}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
    try { await link(temporary, path); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await syncDirectory(path);
    const published = await readDaemonMaintenance(path);
    if (!published) throw new Error("Service maintenance record disappeared before commit.");
    return published;
  } finally { await file.close(); await unlink(temporary); }
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
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const native = process.platform === "darwin";
  if (!native && simulatedClaims.has(lockPath)) throw new Error("Another service maintenance action is in progress.");
  if (!native) simulatedClaims.add(lockPath);
  let lock;
  let active = true;
  const assertActive = () => { if (!active) throw new Error("Service maintenance action has ended."); };
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW
      | constants.O_NONBLOCK | (native ? 0x20 /* Darwin O_EXLOCK */ : 0), 0o600);
    const stat = await lock.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
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
export const createDaemonMaintenance = (path = daemonMaintenancePath()) => withDaemonMaintenanceOperation(owner => owner.create(), path);
export const clearDaemonMaintenance = (id, path = daemonMaintenancePath()) => withDaemonMaintenanceOperation(owner => owner.clear(id), path);
