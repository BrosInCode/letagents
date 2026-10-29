// The agent-side owner-private checks after their move to shared/owner-private-fs:
// POSIX keeps its mode/uid rules; on Windows (an injected platform with a fake
// ACL backend) the private DACL decides, and POSIX-only literals are replaced.
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
import { readAgentLocalState, readAgentLocalStateSnapshot, saveAgentSession, type StoredAgentSessionState } from "../main/agents/state.js";
import { loadLocalSupervisorKey } from "../main/rooms/local-supervision-authority.js";
import { readRuntimeControl, writeRuntimeControl } from "../main/agents/open-model/runtime-launch.js";
import { protectOwnerPrivate } from "../../../../shared/owner-private-fs.mjs";
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

test("Windows: the approval signing key's folder gets the private DACL, the key inherits it, and a tampered folder is refused", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const path = join(root, "host-approval", "signing-key.sealed");
  await asWindows(fake, async () => {
    const signer = await loadHostApprovalSigner(path, storage());
    assert.equal(fake.isProtected(dirname(path)), true);
    assert.equal(fake.isProtected(path), true);
    assert.equal((await loadHostApprovalSigner(path, storage())).publicKey, signer.publicKey);
    // The only folder that ran a tool is the key's own; the key file inherits it.
    assert.deepEqual(fake.protects, [`protect:directory:${dirname(path)}`]);
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

test("Windows: moving a Cursor conversation reads every owner in one call, and a foreign entry or profile stops it", async (t) => {
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
    // The walk's entries were not made through the helper, so their owners are read: once, in one call.
    assert.deepEqual(reads, [3]);
    const target = join(chats, createHash("md5").update(workspaceB).digest("hex"));
    assert.equal(await readFile(join(target, "s1", "store.db"), "utf8"), "db");
    // An entry another account owns stops the move.
    fake.security.readSddlSync = paths => paths.length > 1 ? paths.map((_, index) => index === 0 ? null : "x") : readSddlSync(paths);
    assert.throws(() => relocateCursorConversationNamespace({ configDir }, workspaceB, workspaceA, "s1"), /unsupported or redirected entries/);
    fake.security.readSddlSync = readSddlSync;
    // So does a profile folder another account owns.
    fake.giveAway(dirname(configDir));
    assert.throws(() => relocateCursorConversationNamespace({ configDir }, workspaceB, workspaceA, "s1"), /belongs to another account/);
  });
});

// ---------------------------------------------------------------- supervised workspace git

test("the trusted git environment keeps /tmp and /var/empty on POSIX and uses private Windows folders", async (t) => {
  assert.equal(gitTemporaryRoot(), process.platform === "win32" ? tmpdir() : "/tmp");
  if (process.platform !== "win32") assert.equal(gitEmptyHome(), "/var/empty");
  const root = await scratch(t);
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  });
  const fake = fakeWindowsSecurity();
  await asWindows(fake, async () => {
    assert.equal(gitTemporaryRoot(), tmpdir());
    const home = gitEmptyHome();
    assert.equal(home, join(root, ".letagents", "git-empty-home"));
    assert.equal(fake.isProtected(home), true);
    assert.equal(gitEmptyHome(), home);
    // Not empty, or not private (made by someone else): a new private folder instead.
    await writeFile(join(home, ".gitconfig"), "[core]\n\tfsmonitor = calc.exe\n");
    const fresh = gitEmptyHome();
    t.after(() => rm(fresh, { recursive: true, force: true }));
    assert.notEqual(fresh, home);
    assert.equal(dirname(fresh), tmpdir());
    assert.equal(fake.isProtected(fresh), true);
    await rm(join(home, ".gitconfig"));
    fake.tamper(home);
    const another = gitEmptyHome();
    t.after(() => rm(another, { recursive: true, force: true }));
    assert.notEqual(another, home);
  });
});

// ---------------------------------------------------------------- high-value secrets read back from disk

test("Windows: the desktop reads the shared state file (worker tokens) only while its own DACL is private", async (t) => {
  const root = await scratch(t);
  const folder = join(root, ".letagents");
  await mkdir(folder);
  const file = join(folder, "mcp-state.json");
  const session = { session_id: "s1", session_token: "worker-token", room_id: "r", session_kind: "worker" } as StoredAgentSessionState;
  await writeFile(file, JSON.stringify({ agent_sessions: { s1: session } }));
  const saved = { state: process.env.LETAGENTS_STATE_PATH, home: process.env.HOME, profile: process.env.USERPROFILE };
  process.env.LETAGENTS_STATE_PATH = file;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  t.after(() => {
    for (const [name, value] of [["LETAGENTS_STATE_PATH", saved.state], ["HOME", saved.home], ["USERPROFILE", saved.profile]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    // State an older version left (this account, SYSTEM and Administrators only): the file alone is made private, then read.
    assert.equal(readAgentLocalState().agent_sessions?.s1?.session_token, "worker-token");
    assert.deepEqual(fake.protects, [`upgrade:${file}`]);
    // The first write makes LetAgents' own folder private; later writes run no tool.
    saveAgentSession({ ...session, session_token: "worker-token-2" });
    saveAgentSession({ ...session, session_token: "worker-token-3" });
    assert.equal(readAgentLocalState().agent_sessions?.s1?.session_token, "worker-token-3");
    assert.deepEqual(fake.protects, [`upgrade:${file}`, `protect:directory:${folder}`]);
    // A grant of its own: refused (never read as empty state, so never overwritten), named, not repaired.
    fake.tamper(file);
    for (const read of [() => readAgentLocalState(), () => readAgentLocalStateSnapshot(), () => saveAgentSession(session)]) {
      assert.throws(read, (error: NodeJS.ErrnoException) => error.code === "EOWNERPRIVATE" && error.message.includes(file));
    }
    assert.equal(fake.isProtected(file), false);
    assert.equal(fake.protects.length, 2);
  });
  assert.match(await readFile(file, "utf8"), /worker-token-3/);
  // A dangling link at the state path is refused, not read as "no state", and left in place.
  await rm(file);
  await symlink(join(folder, "gone.json"), file);
  await asWindows(fakeWindowsSecurity(), () => {
    assert.throws(() => readAgentLocalState(), { code: "EOWNERPRIVATE" });
    assert.throws(() => readAgentLocalStateSnapshot(), { code: "EOWNERPRIVATE" });
    assert.throws(() => saveAgentSession(session), { code: "EOWNERPRIVATE" });
  });
  assert.equal((await lstat(file)).isSymbolicLink(), true);
});

test("Windows: the local supervisor key is private from birth, read again unchanged, and refused when exposed or another account's", async (t) => {
  const root = await scratch(t);
  const fake = fakeWindowsSecurity();
  const path = join(root, "local-chat.sqlite.supervisor-key");
  await asWindows(fake, async () => {
    const key = await loadLocalSupervisorKey(path);
    assert.equal(key.length, 32);
    assert.equal(fake.isProtected(path), true);
    assert.deepEqual(await loadLocalSupervisorKey(path), key, "an existing key is never replaced");
    assert.deepEqual(await readdir(root), [basename(path)]);
    fake.tamper(path);
    await assert.rejects(loadLocalSupervisorKey(path), (error: NodeJS.ErrnoException) => error.code === "EOWNERPRIVATE" && error.message.includes(path));
    const planted = join(root, "planted.supervisor-key");
    await writeFile(planted, Buffer.alloc(32, 7));
    fake.giveAway(planted);
    const protects = fake.protects.length;
    await assert.rejects(loadLocalSupervisorKey(planted), { code: "EOWNERPRIVATE" });
    assert.equal(fake.protects.length, protects, "another account's key is never taken over");
  });
});

test("Windows: the Open Model server password is written with no tool in its private runtime folder and refused when exposed", async (t) => {
  const root = await scratch(t);
  const runtime = join(root, "runtime");
  const path = join(runtime, "server-auth.json");
  const fake = fakeWindowsSecurity();
  await asWindows(fake, async () => {
    await mkdir(runtime);
    await protectOwnerPrivate(runtime, "directory");
    const protects = fake.protects.length;
    await writeRuntimeControl(path, { username: "opencode", password: "p1" });
    await writeRuntimeControl(path, { username: "opencode", password: "p2" });
    assert.equal(fake.protects.length, protects, "no icacls per write");
    assert.equal(fake.isProtected(path), true);
    assert.equal((await readRuntimeControl(path)).password, "p2");
    fake.tamper(path);
    await assert.rejects(readRuntimeControl(path), { code: "EOWNERPRIVATE" });
  });
});

test("POSIX: the local supervisor key and the Open Model password keep mode 0600; the shared state file is read as before", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const keyPath = join(root, "supervisor-key");
  const key = await loadLocalSupervisorKey(keyPath);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.deepEqual(await loadLocalSupervisorKey(keyPath), key);
  const auth = join(root, "server-auth.json");
  await writeRuntimeControl(auth, { username: "opencode", password: "p" });
  assert.equal((await stat(auth)).mode & 0o777, 0o600);
  // POSIX never refused a readable password file here; it still does not.
  await chmod(auth, 0o644);
  assert.equal((await readRuntimeControl(auth)).password, "p");
});
