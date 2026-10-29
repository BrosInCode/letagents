// The MCP state file (~/.letagents/mcp-state.json) holds the owner token and
// worker tokens. On Windows (an injected platform with a fake ACL backend) it
// is read only while its own DACL is private; POSIX is unchanged.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLocalState, updateLocalState } from "../local-state.js";
import { asWindows, fakeWindowsSecurity } from "../../../apps/desktop/electron/__tests__/helpers/fake-windows-security.js";

const posixOnly = process.platform === "win32" ? "POSIX modes" : false;

function withStateFile(callback: (paths: { folder: string; file: string }) => Promise<void> | void) {
  return async () => {
    const previous = process.env.LETAGENTS_STATE_PATH;
    const root = mkdtempSync(join(tmpdir(), "letagents-state-private-"));
    const folder = join(root, ".letagents");
    mkdirSync(folder);
    const file = join(folder, "mcp-state.json");
    process.env.LETAGENTS_STATE_PATH = file;
    try { await callback({ folder, file }); } finally {
      if (previous === undefined) delete process.env.LETAGENTS_STATE_PATH;
      else process.env.LETAGENTS_STATE_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const TOKENS = { auth: { token: "owner-token" }, agent_sessions: { s1: { session_id: "s1", session_token: "worker-token" } } };

test("Windows: state an older version left in a profile folder is read after its folder is made private, once", withStateFile(async ({ folder, file }) => {
  writeFileSync(file, JSON.stringify(TOKENS));
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    assert.equal(fake.isProtected(file), false);
    assert.deepEqual(readLocalState(), TOKENS);
    assert.deepEqual(fake.protects, [`protect:directory:${folder}`]);
    // The file inherits the folder's private entries now; nothing is changed on it.
    assert.equal(fake.isProtected(file), true);
    for (let index = 0; index < 10; index += 1) readLocalState();
    // Updates in the private folder run no tool: each new file is private from its exclusive create.
    for (let index = 0; index < 10; index += 1) updateLocalState(state => ({ ...state, local_host_id: `host_${index}` }));
    assert.equal(readLocalState().local_host_id, "host_9");
    assert.deepEqual(fake.protects, [`protect:directory:${folder}`]);
    assert.equal(fake.isProtected(file), true);
  });
}));

test("Windows: a state file with a grant of its own is refused by every read and update, named, and left as it is", withStateFile(async ({ folder, file }) => {
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    updateLocalState(() => TOKENS);
    const bytes = readFileSync(file);
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
    assert.deepEqual(fake.protects, [`protect:directory:${folder}`], "the file is never repaired");
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

test("Windows: a state folder another account owns is refused, not taken over", withStateFile(async ({ folder, file }) => {
  writeFileSync(file, JSON.stringify(TOKENS));
  const fake = fakeWindowsSecurity();
  await asWindows(fake, () => {
    fake.giveAway(folder);
    assert.throws(() => readLocalState(), { code: "EPERM" });
    assert.deepEqual(fake.protects, []);
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
