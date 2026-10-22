import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RENAME_RETRY_DELAYS_MS, renameWithRetry } from "../local-state/rename-retry.js";
import { readLocalState, updateLocalState } from "../local-state.js";

function failing(code: string, times: number) {
  const calls: Array<[string, string]> = [];
  const rename = (from: string, to: string) => {
    calls.push([from, to]);
    if (calls.length <= times) throw Object.assign(new Error(`${code}: busy`), { code });
  };
  return { rename, calls };
}

test("the rename is retried on the Windows sharing-violation codes with growing waits", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const { rename, calls } = failing(code, 3);
    const waits: number[] = [];
    renameWithRetry(rename, "state.tmp", "state.json", { sleep: (ms) => waits.push(ms), platform: "win32" });
    assert.equal(calls.length, 4, code);
    assert.deepEqual(calls[0], ["state.tmp", "state.json"]);
    assert.deepEqual(waits, RENAME_RETRY_DELAYS_MS.slice(0, 3));
  }
});

test("the rename is bounded: ten attempts and under a second of waiting, then the error is rethrown", () => {
  const { rename, calls } = failing("EBUSY", Number.POSITIVE_INFINITY);
  const waits: number[] = [];
  assert.throws(() => renameWithRetry(rename, "a", "b", { sleep: (ms) => waits.push(ms), platform: "win32" }), { code: "EBUSY" });
  assert.equal(calls.length, 10);
  assert.deepEqual(waits, [...RENAME_RETRY_DELAYS_MS]);
  assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 1_000);
  for (let index = 1; index < waits.length; index += 1) assert.ok(waits[index] > waits[index - 1]);
});

test("other rename errors are thrown at once", () => {
  const { rename, calls } = failing("ENOENT", 1);
  assert.throws(() => renameWithRetry(rename, "a", "b", { sleep: () => assert.fail("no wait"), platform: "win32" }), { code: "ENOENT" });
  assert.equal(calls.length, 1);
  const plain = () => { throw new Error("no code"); };
  assert.throws(() => renameWithRetry(plain, "a", "b", { sleep: () => assert.fail("no wait"), platform: "win32" }), /no code/);
});

test("off Windows the sharing-violation codes are lasting permission errors and are not retried", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const { rename, calls } = failing("EPERM", 1);
    assert.throws(() => renameWithRetry(rename, "a", "b", { sleep: () => assert.fail("no wait"), platform }), { code: "EPERM" });
    assert.equal(calls.length, 1, platform);
  }
});

test("the state file keeps its private mode and no temp file is left", () => {
  const previous = process.env.LETAGENTS_STATE_PATH;
  const directory = mkdtempSync(join(tmpdir(), "letagents-state-mode-"));
  process.env.LETAGENTS_STATE_PATH = join(directory, "mcp-state.json");
  try {
    updateLocalState((state) => ({ ...state, local_host_id: "host_1" }));
    assert.equal(readLocalState().local_host_id, "host_1");
    if (process.platform !== "win32") {
      assert.equal(statSync(process.env.LETAGENTS_STATE_PATH).mode & 0o777, 0o600);
    }
    assert.match(readFileSync(process.env.LETAGENTS_STATE_PATH, "utf8"), /"host_1"/);
    assert.deepEqual(readdirSync(directory), ["mcp-state.json"]);
  } finally {
    if (previous === undefined) delete process.env.LETAGENTS_STATE_PATH;
    else process.env.LETAGENTS_STATE_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
