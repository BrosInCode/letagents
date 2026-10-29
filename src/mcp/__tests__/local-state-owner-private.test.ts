// The MCP state file (~/.letagents/mcp-state.json) holds the owner token and
// worker tokens. On Windows (an injected platform with a fake ACL backend) it
// is read only while its own DACL is private; POSIX is unchanged.
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLocalState, updateLocalState } from "../local-state.js";
import { withRegisteredWorkerStateFence } from "../../../shared/local-worker-state-fence.mjs";
import { asWindows, fakeWindowsSecurity } from "../../../apps/desktop/electron/__tests__/helpers/fake-windows-security.js";

const posixOnly = process.platform === "win32" ? "POSIX modes" : false;

/** A state file at `<home>/.letagents/mcp-state.json`, with HOME (and USERPROFILE) at `<home>`, or at a custom path. */
function withStateFile(callback: (paths: { folder: string; file: string }) => Promise<void> | void, { custom = false } = {}) {
  return async () => {
    const saved = { state: process.env.LETAGENTS_STATE_PATH, home: process.env.HOME, profile: process.env.USERPROFILE };
    const root = mkdtempSync(join(tmpdir(), "letagents-state-private-"));
    const folder = join(root, custom ? "custom" : ".letagents");
    mkdirSync(folder);
    const file = join(folder, "mcp-state.json");
    process.env.LETAGENTS_STATE_PATH = file;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    try { await callback({ folder, file }); } finally {
      for (const [name, value] of [["LETAGENTS_STATE_PATH", saved.state], ["HOME", saved.home], ["USERPROFILE", saved.profile]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const TOKENS = { auth: { token: "owner-token" }, agent_sessions: { s1: { session_id: "s1", session_token: "worker-token" } } };

test("Windows: state an older version left is made private by itself and read; later writes in the private folder run no tool", withStateFile(async ({ folder, file }) => {
  writeFileSync(file, JSON.stringify(TOKENS));
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    // The folder and the file have a profile folder's access: this account, SYSTEM and Administrators only.
    assert.equal(fake.isProtected(file), false);
    assert.deepEqual(readLocalState(), TOKENS);
    assert.deepEqual(fake.protects, [`protect:file:${file}`], "the read changes the file only, not its folder");
    for (let index = 0; index < 10; index += 1) readLocalState();
    // The first write makes LetAgents' own folder private (it hides nothing); then no tool runs per write.
    for (let index = 0; index < 10; index += 1) updateLocalState(state => ({ ...state, local_host_id: `host_${index}` }));
    assert.equal(readLocalState().local_host_id, "host_9");
    assert.deepEqual(fake.protects, [`protect:file:${file}`, `protect:directory:${folder}`]);
    assert.equal(fake.isProtected(file), true);
  });
}));

test("Windows: a state file with a grant of its own is refused by every read and update, named, and left as it is", withStateFile(async ({ file }) => {
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    updateLocalState(() => TOKENS);
    const bytes = readFileSync(file);
    const protects = fake.protects.length;
    fake.tamper(file);
    const refused = (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "EOWNERPRIVATE");
      assert.ok(error.message.includes(file), error.message);
      return true;
    };
    assert.throws(() => readLocalState(), refused);
    // Not read as empty state, so an update cannot replace the file (and its tokens) either.
    assert.throws(() => updateLocalState(state => ({ ...state, local_host_id: "host_x" })), refused);
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(fake.protects.length, protects, "the file is never repaired");
    assert.equal(fake.isProtected(file), false);
  });
}));

test("Windows: a state file another account owns is refused and never taken over", withStateFile(async ({ file }) => {
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    updateLocalState(() => TOKENS);
    fake.giveAway(file);
    const protects = fake.protects.length;
    assert.throws(() => readLocalState(), { code: "EOWNERPRIVATE" });
    assert.throws(() => updateLocalState(() => ({})), { code: "EOWNERPRIVATE" });
    assert.equal(fake.protects.length, protects);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).auth.token, "owner-token");
  });
}));

test("Windows: a state file that is a link is refused, not read as empty state, and the link is left in place", withStateFile(async ({ folder, file }) => {
  const target = join(folder, "elsewhere.json");
  writeFileSync(target, JSON.stringify(TOKENS));
  symlinkSync(target, file);
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    assert.throws(() => readLocalState(), { code: "EOWNERPRIVATE" });
    assert.throws(() => updateLocalState(() => ({})), { code: "EOWNERPRIVATE" });
  });
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), TOKENS);
}));

test("Windows: a state folder that grants another account is never changed; each write gets a protected DACL of its own", withStateFile(async ({ folder, file }) => {
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    fake.share(folder);
    updateLocalState(() => TOKENS);
    updateLocalState(state => ({ ...state, local_host_id: "host_1" }));
    assert.equal(readLocalState().local_host_id, "host_1");
    assert.equal(fake.isProtected(file), true);
    assert.equal(fake.isProtected(folder), false);
    assert.ok(!fake.protects.includes(`protect:directory:${folder}`), "the folder is left as it is");
  });
}));

test("Windows: a state file at a custom path never changes its folder", withStateFile(async ({ folder, file }) => {
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    updateLocalState(() => TOKENS);
    updateLocalState(state => ({ ...state, local_host_id: "host_1" }));
    assert.equal(readLocalState().local_host_id, "host_1");
    assert.equal(fake.isProtected(file), true);
    assert.ok(!fake.protects.includes(`protect:directory:${folder}`));
  });
}, { custom: true }));

test("Windows: a board request's worker fence reads the tokens only while the state file is private", withStateFile(async ({ file }) => {
  const fake = fakeWindowsSecurity();
  const supplied = { session_id: "s1", session_token: "worker-token", agent_instance_id: "i1", agent_key: "k1", room_id: "r1" };
  await asWindows(fake, () => {
    updateLocalState(() => ({ agent_sessions: { s1: supplied } }) as never);
    assert.equal(withRegisteredWorkerStateFence(file, supplied, (current: { session_id: string }) => current.session_id), "s1");
    fake.tamper(file);
    assert.throws(() => withRegisteredWorkerStateFence(file, supplied, () => assert.fail("authorized")), { code: "EOWNERPRIVATE" });
  });
}));

test("POSIX: the state file and its folder keep today's modes; a group-readable file is still read", { skip: posixOnly }, withStateFile(({ folder, file }) => {
  chmodSync(folder, 0o755);
  updateLocalState(() => TOKENS);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(folder).mode & 0o777, 0o755, "the folder is not changed on POSIX");
  chmodSync(file, 0o644);
  assert.deepEqual(readLocalState(), TOKENS);
}));
