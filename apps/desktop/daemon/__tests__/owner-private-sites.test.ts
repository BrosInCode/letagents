// The daemon's owner-private checks, after their move to shared/owner-private-fs:
// each check refuses an open file on POSIX as before, and on Windows (an
// injected platform with a fake ACL backend, or the real one on a Windows host)
// it refuses what lacks the private DACL and accepts what the code itself made.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createDaemonMaintenance,
  readDaemonMaintenance,
  withDaemonMaintenanceOperation,
} from "../../../../shared/daemon-maintenance.mjs";
import { isOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
import { isDaemonEntryPoint } from "../entry-point.js";
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

test("Windows: the recovery snapshot needs a private folder, and its file gets the DACL before any ciphertext", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const directory = join(root, "state");
  await mkdir(directory);
  const database = stateDatabase(directory);
  await asWindows(fake, async () => {
    // mkdir alone gives an inherited DACL: refused, as a 0755 folder is on POSIX.
    await assert.rejects(prepareStateRecoveryBackup(database, 18, getKey), { code: "snapshot_refused" });
    await fake.security.protect(directory, "directory");
    const backup = await prepareStateRecoveryBackup(database, 18, getKey);
    assert.ok(backup);
    assert.ok(fake.protects.some(call => call === `protect:file:${database}.recovery.enc.pending`));
    assert.equal(fake.isProtected(`${database}.recovery.enc`), true);
    (await decryptStateRecoveryBackup(`${database}.recovery.enc`, backupKey)).close();
    fake.tamper(`${database}.recovery.enc`);
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
    // Every folder it made, the lock and the record's temporary file got the private DACL.
    assert.ok(fake.protects.includes(`protect:directory:${join(root, "home")}`));
    assert.ok(fake.protects.includes(`protect:directory:${join(root, "home", ".letagents")}`));
    assert.ok(fake.protects.includes(`protect:file:${path}.lock`));
    assert.ok(fake.protects.some(call => call.startsWith(`protect:file:${path}.`) && call.endsWith(".tmp")));
    fake.tamper(path);
    await assert.rejects(readDaemonMaintenance(path), /Unsafe service maintenance record/);
    fake.tamper(`${path}.lock`);
    await assert.rejects(withDaemonMaintenanceOperation(async () => undefined, path), /Unsafe service maintenance lock/);
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

test("real Windows: a maintenance hold passes the real ACL check, and an extra entry is refused", { skip: windowsOnly }, async (t) => {
  const root = await scratch(t);
  const path = join(root, ".letagents", "daemon-maintenance.json");
  const hold = await createDaemonMaintenance(path);
  assert.deepEqual(await readDaemonMaintenance(path), hold);
  assert.equal(await isOwnerPrivate(join(root, ".letagents"), await lstat(join(root, ".letagents"))), true);
  const { execFileSync } = await import("node:child_process");
  const { windowsSystemTool } = await import("../../../../shared/owner-private-fs.mjs");
  execFileSync(windowsSystemTool("icacls.exe"), [path, "/grant", "*S-1-1-0:R"], { stdio: "ignore", windowsHide: true });
  await assert.rejects(readDaemonMaintenance(path), /Unsafe service maintenance record/);
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
