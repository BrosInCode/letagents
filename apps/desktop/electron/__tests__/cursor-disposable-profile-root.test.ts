import "./isolated-home.js";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mock, test } from "node:test";

// On Windows a stopped MCP inspection (its timeout or the turn's abort) can
// return before its process tree has exited: the parent waits only 3 s for the
// process-tree helper to close. The helper, the wrapper, Cursor's node, and
// Cursor's identity.js script all run in the inspection root, so removing it
// right away fails EBUSY on rmdir until they exit. In the Windows VM with real
// Cursor and the sealed helper, every stopped pass one (31 of 31) failed this
// way, and on a quiet machine the root became removable within one 15 ms
// process-watcher step of the tree's exit. Model that hold here on every
// platform.
const IN_USE_REMOVALS = 2;
const inUseRemovalsLeft = new Map<string, number>();
function failWhileInUse(path: fs.PathLike): void {
  const root = String(path);
  if (!basename(root).startsWith("letagents-cursor-mcp-inspection-")) return;
  const left = inUseRemovalsLeft.get(root) ?? IN_USE_REMOVALS;
  if (left === 0) return;
  inUseRemovalsLeft.set(root, left - 1);
  throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${root}'`), {
    code: "EBUSY",
    errno: -4082,
    syscall: "rmdir",
    path: root,
  });
}
const rmSync: typeof fs.rmSync = (path, options) => {
  failWhileInUse(path);
  fs.rmSync(path, options);
};
const rm: typeof fsPromises.rm = async (path, options) => {
  failWhileInUse(path);
  await fsPromises.rm(path, options);
};

test("a pass-one root that is briefly in use is removed before pass two starts, and the turn launches", async () => {
  mock.module("node:fs", { namedExports: { ...fs, rmSync }, defaultExport: { ...fs, rmSync } });
  mock.module("node:fs/promises", { namedExports: { ...fsPromises, rm }, defaultExport: { ...fsPromises, rm } });
  try {
    const {
      createHarness,
      supervisedAdapter,
      spawnDaemonLane,
      roomTurnRequest,
      waitFor,
      withLoopAlive,
    } = await import("./cursor-provider-adapter.fixture.js");
    const harness = createHarness();
    const attest = harness.dependencies.attestSupervisedMcp;
    const passOneRootAtPassTwo: Array<{ root: string; present: boolean }> = [];
    harness.dependencies.attestSupervisedMcp = async (input) => {
      const passOne = harness.mcpAttestations[0];
      if (passOne) {
        passOneRootAtPassTwo.push({ root: passOne.writableProfileRoot, present: fs.existsSync(passOne.writableProfileRoot) });
      }
      await attest(input);
    };
    const adapter = supervisedAdapter(harness);
    const handle = await spawnDaemonLane(adapter, harness);

    const turn = withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    await waitFor(() => harness.children[0]?.isReleased === true);

    assert.equal(harness.mcpAttestations.length, 2, "pass two ran after the in-use pass-one root");
    const passOneRoot = harness.mcpAttestations[0]!.writableProfileRoot;
    assert.equal(inUseRemovalsLeft.get(passOneRoot), 0, "the pass-one root was in use for two removals");
    assert.deepEqual(
      passOneRootAtPassTwo,
      [{ root: passOneRoot, present: false }],
      "pass two starts only after pass one's root is gone",
    );
    assert.equal(fs.existsSync(harness.mcpAttestations[1]!.writableProfileRoot), false, "the pass-two root is removed");
    assert.equal(harness.launches.length, 1, "the native turn launches");
    harness.children[0]!.emit({
      type: "result", subtype: "success", is_error: false,
      result: "done", session_id: "sess-cursor-1",
    });
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await turn;
  } finally {
    mock.restoreAll();
  }
});

test("removal tries again only while the root is in use, then fails closed at the bound", async () => {
  const { removeDisposableProfileRoot } = await import("../main/agents/cursor/disposable-profile-root.js");
  const coded = (code: string) => Object.assign(new Error(code), { code });
  let clock = 0;
  const waits: number[] = [];
  const timing = {
    now: () => clock,
    wait: async (ms: number) => { waits.push(ms); clock += ms; },
    boundMs: 1_000,
  };

  let calls = 0;
  await removeDisposableProfileRoot("root", {
    ...timing,
    remove: async () => {
      calls += 1;
      if (calls === 1) throw coded("EBUSY");
      if (calls === 2) throw coded("EPERM");
      if (calls === 3) throw coded("ENOTEMPTY");
    },
  });
  assert.equal(calls, 4, "each in-use code is tried again");
  assert.deepEqual(waits, [25, 50, 100]);

  calls = 0;
  await assert.rejects(
    removeDisposableProfileRoot("root", { ...timing, remove: async () => { calls += 1; throw coded("EACCES"); } }),
    /EACCES/,
  );
  assert.equal(calls, 1, "a code that does not mean 'in use' fails at once");

  calls = 0;
  clock = 0;
  waits.length = 0;
  await assert.rejects(
    removeDisposableProfileRoot("root", { ...timing, remove: async () => { calls += 1; throw coded("EBUSY"); } }),
    /EBUSY/,
  );
  assert.ok(clock >= 1_000 && clock < 1_500, `fails closed once the bound is spent (waited ${clock} ms)`);
  assert.ok(waits.every((ms) => ms <= 500), "each wait is short");
});

test("removal leaves no root behind on a real folder", async () => {
  const { removeDisposableProfileRoot } = await import("../main/agents/cursor/disposable-profile-root.js");
  const root = fs.mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-bridge-"));
  fs.mkdirSync(join(root, "home", ".cursor"), { recursive: true });
  fs.writeFileSync(join(root, "home", ".cursor", "mcp.json"), "{}");
  await removeDisposableProfileRoot(root);
  assert.equal(fs.existsSync(root), false);
});
