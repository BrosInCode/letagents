// The daemon's owner-private checks, after their move to shared/owner-private-fs:
// each check refuses an open file on POSIX as before, and on Windows (an
// injected platform with a fake ACL backend, or the real one on a Windows host)
// it refuses what lacks the private DACL and accepts what the code itself made.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createDaemonMaintenance,
  readDaemonMaintenance,
  withDaemonMaintenanceOperation,
} from "../../../../shared/daemon-maintenance.mjs";
import { forgetOwnerPrivateCache, isOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
import { openDaemonStateDatabase } from "../daemon-state-database.js";
import { isDaemonEntryPoint } from "../entry-point.js";
import { DaemonLifecycleLog } from "../lifecycle-log.js";
import { EphemeralWorkspaceProvisioner } from "../ephemeral-workspace-provisioner.js";
import { RoomTurnAttachmentStager } from "../room-turn-attachments.js";
import { decryptStateRecoveryBackup, prepareStateRecoveryBackup } from "../state-recovery-backup.js";
import { asWindows, fakeWindowsSecurity } from "../../electron/__tests__/helpers/fake-windows-security.js";

const posixOnly = process.platform === "win32" ? "POSIX modes" : false;
const windowsOnly = process.platform === "win32" ? false : "needs real Windows ACLs";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

async function scratch(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "owner-private-sites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function stateDatabase(directory: string): string {
  const path = join(directory, "daemon.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA user_version=17;
    CREATE TABLE manifest_metadata(singleton INTEGER PRIMARY KEY, schema_version INTEGER);
    INSERT INTO manifest_metadata VALUES(1,17);
    CREATE TABLE retained_worker_bindings(agent_id TEXT PRIMARY KEY, token TEXT);
    INSERT INTO retained_worker_bindings VALUES('agent','secret');`);
  database.close();
  return path;
}

const backupKey = randomBytes(32);
const getKey = async () => ({ key: Buffer.from(backupKey), sealedKey: "sealed" });

// ---------------------------------------------------------------- state recovery backup

test("Windows: the recovery snapshot needs a private folder, and its file inherits that folder's DACL", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const directory = join(root, "state");
  await mkdir(directory);
  const database = stateDatabase(directory);
  await asWindows(fake, async () => {
    // mkdir alone gives an inherited DACL: refused, as a 0755 folder is on POSIX.
    await assert.rejects(prepareStateRecoveryBackup(database, 18, getKey), { code: "snapshot_refused" });
    await fake.security.protect(directory, "directory");
    const before = fake.protects.length;
    const backup = await prepareStateRecoveryBackup(database, 18, getKey);
    assert.ok(backup);
    // The verified folder passes its entries on; no tool runs for the snapshot file.
    assert.equal(fake.protects.length, before);
    assert.equal(fake.isProtected(`${database}.recovery.enc`), true);
    (await decryptStateRecoveryBackup(`${database}.recovery.enc`, backupKey)).close();
    // A folder that lost its private DACL: the snapshot is refused.
    fake.tamper(directory);
    await assert.rejects(decryptStateRecoveryBackup(`${database}.recovery.enc`, backupKey), { code: "verify_failed" });
  });
});

test("POSIX: the recovery snapshot still refuses a group-readable folder", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const directory = join(root, "state");
  await mkdir(directory, { mode: 0o700 });
  const database = stateDatabase(directory);
  await chmod(directory, 0o750);
  await assert.rejects(prepareStateRecoveryBackup(database, 18, getKey), { code: "snapshot_refused" });
  await chmod(directory, 0o700);
  assert.ok(await prepareStateRecoveryBackup(database, 18, getKey));
  await chmod(`${database}.recovery.enc`, 0o640);
  await assert.rejects(decryptStateRecoveryBackup(`${database}.recovery.enc`, backupKey), { code: "verify_failed" });
});

// ---------------------------------------------------------------- service maintenance

test("Windows: a maintenance hold is written private and a tampered record is refused", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const path = join(root, "home", ".letagents", "daemon-maintenance.json");
  await asWindows(fake, async () => {
    const hold = await createDaemonMaintenance(path);
    assert.deepEqual(await readDaemonMaintenance(path), hold);
    // The first folder it made got the private DACL; the state folder, the lock and the
    // record inherit it, so no tool ran for them.
    assert.deepEqual(fake.protects, [`protect:directory:${join(root, "home")}`]);
    for (const made of [dirname(path), `${path}.lock`, path]) assert.equal(fake.isProtected(made), true, made);
    assert.deepEqual((await readdir(dirname(path))).sort(), ["daemon-maintenance.json", "daemon-maintenance.json.lock"]);
    fake.tamper(path);
    await assert.rejects(readDaemonMaintenance(path), /Unsafe service maintenance record/);
    // A lock this account owns but that is not private is repaired; another account's is refused,
    // even inside the verified folder (it may have been there before the folder was private).
    fake.tamper(`${path}.lock`);
    await withDaemonMaintenanceOperation(async () => undefined, path);
    assert.equal(fake.isProtected(`${path}.lock`), true);
    fake.giveAway(`${path}.lock`);
    await assert.rejects(withDaemonMaintenanceOperation(async () => undefined, path), /Unsafe service maintenance lock/);
    // A record is trusted only in a private folder; an operation repairs this account's own folder.
    // (A second folder: the fake remembers files by inode, which Linux reuses at once after a delete.)
    const second = join(root, "home2", ".letagents", "daemon-maintenance.json");
    const secondHold = await createDaemonMaintenance(second);
    // home2 loses its private DACL: .letagents now has a fresh profile folder's access, not private.
    fake.unprotect(join(root, "home2"));
    await assert.rejects(readDaemonMaintenance(second), /Unsafe service maintenance record/);
    assert.equal((await withDaemonMaintenanceOperation(owner => owner.read(), second))?.id, secondHold.id);
    assert.equal(fake.isProtected(dirname(second)), true);
    fake.giveAway(dirname(second));
    await assert.rejects(withDaemonMaintenanceOperation(async () => undefined, second), /Unsafe service maintenance folder/);
    // "No record" is trusted only in this account's folder: one that is not private yet
    // (it never held a hold) is made private; another account's folder fails closed.
    await rm(second);
    await assert.rejects(readDaemonMaintenance(second), /Unsafe service maintenance folder/);
    const fresh = join(root, "fresh", ".letagents");
    await mkdir(fresh, { recursive: true });
    assert.equal(await readDaemonMaintenance(join(fresh, "daemon-maintenance.json")), null);
    assert.equal(fake.isProtected(fresh), true);
    assert.equal(await readDaemonMaintenance(join(root, "missing", "daemon-maintenance.json")), null);
    // A folder another non-administrator account had access to is not hardened in place.
    const shared = join(root, "shared");
    await mkdir(shared);
    fake.share(shared);
    await assert.rejects(readDaemonMaintenance(join(shared, "daemon-maintenance.json")), /Unsafe service maintenance folder/);
    assert.equal(fake.isProtected(shared), false);
  });
});

test("POSIX: a group-readable maintenance record or lock is still refused", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const path = join(root, ".letagents", "daemon-maintenance.json");
  await createDaemonMaintenance(path);
  assert.equal((await lstat(join(root, ".letagents"))).mode & 0o777, 0o700);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await chmod(path, 0o640);
  await assert.rejects(readDaemonMaintenance(path), /Unsafe service maintenance record/);
  await chmod(path, 0o600);
  await chmod(`${path}.lock`, 0o604);
  await assert.rejects(withDaemonMaintenanceOperation(async () => undefined, path), /Unsafe service maintenance lock/);
});

test("real Windows: a maintenance hold passes the real ACL check, and an extra entry on its folder is refused", { skip: windowsOnly }, async (t) => {
  const root = await scratch(t);
  const folder = join(root, ".letagents");
  const path = join(folder, "daemon-maintenance.json");
  const hold = await createDaemonMaintenance(path);
  assert.deepEqual(await readDaemonMaintenance(path), hold);
  assert.equal(await isOwnerPrivate(folder, await lstat(folder)), true);
  const { execFileSync } = await import("node:child_process");
  const { forgetOwnerPrivateCache, windowsSystemTool } = await import("../../../../shared/owner-private-fs.mjs");
  // A cold reader (another process) refuses a record with an extra entry of its own.
  execFileSync(windowsSystemTool("icacls.exe"), [path, "/grant", "*S-1-1-0:R"], { stdio: "ignore", windowsHide: true });
  forgetOwnerPrivateCache();
  await assert.rejects(readDaemonMaintenance(path), /Unsafe service maintenance record/);
  // And a record in a folder that lost its private DACL.
  execFileSync(windowsSystemTool("icacls.exe"), [path, "/remove:g", "*S-1-1-0"], { stdio: "ignore", windowsHide: true });
  execFileSync(windowsSystemTool("icacls.exe"), [folder, "/grant", "*S-1-5-32-545:(OI)(CI)R"], { stdio: "ignore", windowsHide: true });
  forgetOwnerPrivateCache();
  await assert.rejects(readDaemonMaintenance(path), /Unsafe service maintenance record/);
  forgetOwnerPrivateCache();
});

test("Windows: when the ACL tools fail, a missing maintenance record is not read as no hold", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const broken = { ...fake, security: { ...fake.security,
    async readSddl(): Promise<(string | null)[]> { throw Object.assign(new Error("spawn icacls.exe ENOENT"), { code: "ENOENT" }); },
  } };
  await asWindows(broken, async () => {
    await assert.rejects(readDaemonMaintenance(join(root, "daemon-maintenance.json")), /Unsafe service maintenance folder/);
  });
});

// ---------------------------------------------------------------- ephemeral workspace

test("Windows: an ephemeral workspace, its parent and its marker get the private DACL", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  await asWindows(fake, async () => {
    const workAttemptId = "3b9b6c2e-6a8e-4c39-9a0e-0a3b8c1d2e4f";
    const result = await new EphemeralWorkspaceProvisioner(root).provision({ workAttemptId, taskId: "task" });
    assert.equal(fake.isProtected(result.path), true);
    assert.equal(fake.isProtected(join(root, "worktrees", "room-only")) || fake.protects.some(call => call.includes("worktrees")), true);
    assert.equal(fake.isProtected(join(result.path, ".letagents-work-attempt.json")), true);
  });
});

// ---------------------------------------------------------------- room turn attachments

test("Windows: staged attachment folders and files get the private DACL", async (t) => {
  const parent = await scratch(t);
  const root = join(parent, "room-turn-attachments");
  const fake = fakeWindowsSecurity();
  await asWindows(fake, async () => {
    const prepared = await new RoomTurnAttachmentStager(root).prepare({
      delivery: "file", localRoom: false, roomId: "room_1", apiUrl: "https://api.example.test", bearer: "b",
      sourceMessage: { id: "msg_7", text: "Look", attachments: [{ id: "att_1", filename: "a.png", content_type: "image/png",
        byte_size: PNG.byteLength, download_url: "/rooms/room_1/messages/msg_7/attachments/att_1" }] },
      sourceMessageId: "msg_7",
      http: { async downloadAttachment() { return PNG; } },
      signal: new AbortController().signal,
    } as Parameters<RoomTurnAttachmentStager["prepare"]>[0]);
    try {
      assert.equal(fake.isProtected(root), true);
      const staged = prepared.attachments.map(file => file.image?.path ?? "").filter(Boolean);
      assert.equal(staged.length, 1);
      assert.equal(fake.isProtected(staged[0]!), true);
      assert.equal(fake.isProtected(join(staged[0]!, "..")), true);
    } finally { await prepared.release(); }
  });
});

test("Windows: a kept file is used only from private cache folders", async (t) => {
  const parent = await scratch(t);
  const root = join(parent, "room-turn-attachments");
  const fake = fakeWindowsSecurity();
  let downloads = 0;
  const input = () => ({
    delivery: "file", fileAccess: { text: true, pdf: false }, localRoom: false, roomId: "room_1",
    apiUrl: "https://api.example.test", bearer: "b", sourceMessageId: "msg_7",
    sourceMessage: { id: "msg_7", text: "Log", attachments: [{ id: "att_1", filename: "log.txt", content_type: "text/plain",
      byte_size: 5, download_url: "/rooms/room_1/messages/msg_7/attachments/att_1" }] },
    http: { async downloadAttachment() { downloads += 1; return new TextEncoder().encode("hello"); } },
    signal: new AbortController().signal,
  } as unknown as Parameters<RoomTurnAttachmentStager["prepare"]>[0]);
  await asWindows(fake, async () => {
    const stager = new RoomTurnAttachmentStager(root);
    for (let turn = 0; turn < 2; turn += 1) await (await stager.prepare(input())).release();
    assert.equal(downloads, 1);
    // The attachment folder lost its private DACL: the kept copy is not trusted.
    fake.tamper(root);
    await (await stager.prepare(input())).release();
    assert.equal(downloads, 2);
    // Writing the new copy made the folder private again.
    assert.equal(fake.isProtected(root), true);
  });
});

// ---------------------------------------------------------------- state database

test("Windows: the state database folder and files get the private DACL", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const path = join(root, "daemon", "daemon-state.sqlite");
  await asWindows(fake, async () => {
    const database = await openDaemonStateDatabase(path, () => undefined);
    try {
      assert.equal(fake.isProtected(join(root, "daemon")), true);
      assert.equal(fake.isProtected(path), true);
      // A -wal or -shm file SQLite makes later inherits the folder's private entries.
    } finally { database.close(); }
  });
});

test("Windows: a new lifecycle log inherits its folder; an existing one is protected", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const path = join(root, "logs", "daemon-lifecycle.jsonl");
  await asWindows(fake, async () => {
    new DaemonLifecycleLog(path);
    // The folder is protected; the log it made needs no tool of its own.
    assert.deepEqual(fake.protects, [`protect:directory:${dirname(path)}`]);
    assert.equal(fake.isProtected(path), true);
    // A later process finds the log already there: it is protected in full.
    forgetOwnerPrivateCache();
    fake.protects.length = 0;
    new DaemonLifecycleLog(path);
    assert.deepEqual(fake.protects, [`protect:directory:${dirname(path)}`, `protect:file:${path}`]);
  });
});

// ---------------------------------------------------------------- daemon entry point

test("the daemon entry check keeps the POSIX comparison and resolves a Windows path to its URL", () => {
  assert.equal(isDaemonEntryPoint("file:///Applications/L.app/dist-daemon/main.js", "/Applications/L.app/dist-daemon/main.js", "darwin"), true);
  assert.equal(isDaemonEntryPoint("file:///a/main.js", "/b/main.js", "darwin"), false);
  assert.equal(isDaemonEntryPoint("file:///a/main.js", undefined, "darwin"), false);
  // Windows: argv[1] is resolved and real-path-ed, then compared as a file URL.
  const real = join(tmpdir(), "dist-daemon", "main.js");
  const url = pathToFileURL(real).href;
  assert.equal(isDaemonEntryPoint(url, "dist-daemon/main.js", "win32", () => real), true);
  assert.equal(isDaemonEntryPoint(url, real, "win32", () => join(tmpdir(), "other.js")), false);
  assert.equal(isDaemonEntryPoint(url, real, "win32", () => { throw new Error("ENOENT"); }), false);
  // The old POSIX comparison is never true for a Windows path.
  assert.notEqual(`file://C:\\app\\main.js`, pathToFileURL("C:\\app\\main.js").href);
});

test("real Windows: the daemon entry check matches this process's own entry module", { skip: windowsOnly }, async (t) => {
  const root = await scratch(t);
  const entry = join(root, "entry.mjs");
  const check = pathToFileURL(join(process.cwd(), "daemon", "entry-point.ts")).href;
  await writeFile(entry, `import { isDaemonEntryPoint } from ${JSON.stringify(check)};\nprocess.stdout.write(String(isDaemonEntryPoint(import.meta.url, process.argv[1])));\n`);
  const { execFileSync } = await import("node:child_process");
  const output = execFileSync(process.execPath, ["--import", "tsx", entry], { encoding: "utf8" });
  assert.equal(output, "true");
  assert.equal(await readFile(entry, "utf8").then(() => true), true);
});
