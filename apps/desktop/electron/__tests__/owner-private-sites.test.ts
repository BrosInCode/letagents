// The agent-side owner-private checks after their move to shared/owner-private-fs:
// POSIX keeps its mode/uid rules; on Windows (an injected platform with a fake
// ACL backend) the private DACL decides, and POSIX-only literals are replaced.
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { loadHostApprovalSigner } from "../main/host-approval-auth.js";
import { cursorMcpConnectorParent } from "../main/agents/cursor-provider-constants.js";
import { cursorRoomTurnImageFolders } from "../main/agents/cursor-room-turn-images.js";
import {
  prepareCursorResumeOwnershipLock,
  prepareCursorTurnRuntimeDataDir,
  removeCursorTurnRuntimeDataDir,
} from "../main/agents/cursor-sandbox-policy.js";
import { readRegularFileNoFollow, writePrivateFileAtomic } from "../main/agents/cursor/profile-filesystem.js";
import { relocateCursorConversationNamespace } from "../main/agents/cursor/managed-profile.js";
import { gitEmptyHome, gitTemporaryRoot } from "../main/agents/supervised-workspace-generation/git.js";
import { asWindows, fakeWindowsSecurity } from "./helpers/fake-windows-security.js";
import type { ProviderRoomTurnRequest } from "../main/agents/provider-adapter.js";

const posixOnly = process.platform === "win32" ? "POSIX modes" : false;

async function scratch(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "owner-private-electron-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function storage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^sealed:/, ""),
  };
}

// ---------------------------------------------------------------- host approval signing key

test("Windows: the approval signing key and its folder get the private DACL; a tampered one is refused", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const path = join(root, "host-approval", "signing-key.sealed");
  await asWindows(fake, async () => {
    const signer = await loadHostApprovalSigner(path, storage());
    assert.equal(fake.isProtected(dirname(path)), true);
    assert.equal(fake.isProtected(path), true);
    assert.equal((await loadHostApprovalSigner(path, storage())).publicKey, signer.publicKey);
    fake.tamper(path);
    await assert.rejects(loadHostApprovalSigner(path, storage()), /Host approval signing is unavailable/);
    await fake.security.protect(path, "file");
    fake.tamper(dirname(path));
    await assert.rejects(loadHostApprovalSigner(path, storage()), /Host approval signing is unavailable/);
  });
});

test("POSIX: the approval signing key must still be exactly 0600 in a private folder", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const path = join(root, "host-approval", "signing-key.sealed");
  await loadHostApprovalSigner(path, storage());
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  for (const mode of [0o400, 0o640, 0o700]) {
    await chmod(path, mode);
    await assert.rejects(loadHostApprovalSigner(path, storage()), /Host approval signing is unavailable/);
  }
  await chmod(path, 0o600);
  await chmod(dirname(path), 0o750);
  await assert.rejects(loadHostApprovalSigner(path, storage()), /Host approval signing is unavailable/);
});

// ---------------------------------------------------------------- Cursor

test("Cursor's connector parent and turn data root use /tmp on POSIX and the temp folder on Windows", async () => {
  assert.equal(cursorMcpConnectorParent("darwin"), "/tmp");
  assert.equal(cursorMcpConnectorParent("linux"), "/tmp");
  assert.equal(cursorMcpConnectorParent("win32"), tmpdir());
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    const root = prepareCursorTurnRuntimeDataDir();
    try {
      assert.equal(dirname(root), realpathSync(tmpdir()));
      assert.match(basename(root), /^letagents-cursor-data-[A-Za-z0-9]{6}$/);
      assert.equal(fake.isProtected(root), true);
      assert.throws(() => removeCursorTurnRuntimeDataDir(join(tmpdir(), "elsewhere", basename(root))), /unexpected Cursor turn data root/);
    } finally { removeCursorTurnRuntimeDataDir(root); }
    assert.throws(() => prepareCursorResumeOwnershipLock("3b9b6c2e-6a8e-4c39-9a0e-0a3b8c1d2e4f"), /only for the macOS sandbox/);
  });
});

test("Windows: a staged image folder is opened to Cursor only when its owner is this account", async (t) => {
  const root = await scratch(t);
  const folder = join(root, "turn-1");
  await mkdir(folder);
  const request = { attachments: [{ status: "image", image: { path: join(folder, "a.png") } }] } as unknown as ProviderRoomTurnRequest;
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => assert.deepEqual(cursorRoomTurnImageFolders(request), [folder]));
  const theirs = fakeWindowsSecurity();
  theirs.security.readSddlSync = paths => paths.map(() => "O:S-1-5-21-1-2-3-1002D:P(A;;FA;;;S-1-5-21-1-2-3-1002)");
  await asWindows(theirs, () => assert.deepEqual(cursorRoomTurnImageFolders(request), []));
});

test("Windows: Cursor profile files are written private and read without following a link", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const file = join(root, "cli-config.json");
  await asWindows(fake, () => {
    writePrivateFileAtomic(file, "{\"a\":1}");
    assert.equal(fake.isProtected(file), true);
    assert.equal(readRegularFileNoFollow(file, 1024).toString("utf8"), "{\"a\":1}");
  });
  assert.equal(await readFile(file, "utf8"), "{\"a\":1}");
});

test("Windows: moving a Cursor conversation reads every owner in one call, and a foreign one stops the move", async (t) => {
  const root = await scratch(t);
  const configDir = join(root, "profile", "config");
  const fake = fakeWindowsSecurity();
  const reads: number[] = [];
  const readSddlSync = fake.security.readSddlSync;
  fake.security.readSddlSync = (paths) => { reads.push(paths.length); return readSddlSync(paths); };
  const workspaceA = join(root, "a");
  const workspaceB = join(root, "b");
  await asWindows(fake, async () => {
    relocateCursorConversationNamespace({ configDir }, workspaceA, workspaceB, null);
    const { createHash } = await import("node:crypto");
    const chats = join(configDir, "cursor", "chats");
    const source = join(chats, createHash("md5").update(workspaceA).digest("hex"));
    await mkdir(join(source, "s1"), { recursive: true });
    await writeFile(join(source, "s1", "store.db"), "db");
    reads.length = 0;
    relocateCursorConversationNamespace({ configDir }, workspaceA, workspaceB, "s1");
    assert.deepEqual(reads, [3]);
    const target = join(chats, createHash("md5").update(workspaceB).digest("hex"));
    assert.equal(await readFile(join(target, "s1", "store.db"), "utf8"), "db");
    fake.security.readSddlSync = paths => paths.map((_, index) => index === 0 ? null : "x");
    assert.throws(() => relocateCursorConversationNamespace({ configDir }, workspaceB, workspaceA, "s1"), /unsupported or redirected entries/);
  });
});

// ---------------------------------------------------------------- supervised workspace git

test("the trusted git environment keeps /tmp and /var/empty on POSIX and uses private Windows folders", async () => {
  assert.equal(gitTemporaryRoot(), process.platform === "win32" ? tmpdir() : "/tmp");
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    assert.equal(gitTemporaryRoot(), tmpdir());
    const home = gitEmptyHome();
    assert.equal(home, join(tmpdir(), "letagents-git-empty-home"));
    assert.equal(gitEmptyHome(), home);
  });
  if (process.platform !== "win32") assert.equal(gitEmptyHome(), "/var/empty");
});
