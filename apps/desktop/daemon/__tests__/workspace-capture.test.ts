import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkspaceCapture } from "../workspace-capture.js";
import { releaseWorkspaceTree } from "../../../../shared/workspace-turn-capture.mjs";

async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "isolated-workspace-capture-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  await writeFile(join(path, "file"), "before\n"); git("add", "."); git("commit", "-qm", "base");
  const capture = new WorkspaceCapture();
  t.after(async () => { capture.close(); await rm(path, { recursive: true, force: true }); });
  return { path, git, capture, head: git("rev-parse", "HEAD") };
}

test("worker pins settled bytes before a delayed remote answer; queued captures are bounded", async t => {
  const f = await fixture(t);
  const baseline = await f.capture.begin(f.path, "turn");
  assert.ok(baseline);
  await writeFile(join(f.path, "file"), "settled\n");
  let answer!: (tips: null) => void;
  const tips = new Promise<null>(resolve => { answer = resolve; });
  const settled = f.capture.settle(f.path, f.head, baseline, "turn", f.head, tips);
  // Its settled retention ref proves the bytes were captured, even while the
  // original remote request remains outstanding. Later edits are excluded.
  for (let count = 0; ; count++) {
    if (f.git("for-each-ref", "--format=%(refname)", "refs/letagents/workspace-review").split("\n").length === 2) break;
    assert.ok(count < 200, "settled snapshot should not wait for remote tips");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await writeFile(join(f.path, "file"), "later unrelated edit\n");
  const queued = Array.from({ length: 7 }, (_, i) => f.capture.begin(f.path, `queued-${i}`));
  await assert.rejects(f.capture.begin(f.path, "overflow"), /unavailable/);
  answer(null);
  const pair = await settled;
  assert.equal(pair.contribution.changes.state, "ready");
  assert.match(pair.review.contribution.patch, /\+settled/);
  assert.doesNotMatch(pair.review.contribution.patch, /later unrelated/);
  assert.ok((await Promise.all(queued)).every(Boolean));
  await releaseWorkspaceTree(f.path, "turn");
  for (let i = 0; i < 7; i++) await releaseWorkspaceTree(f.path, `queued-${i}`);
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/letagents/workspace-review"), "");
});

test("unavailable workspace is never reported as no change and does not poison the capture lane", async t => {
  const f = await fixture(t);
  assert.equal(await f.capture.begin(join(f.path, "missing"), "missing"), null);
  const pair = await f.capture.settle(join(f.path, "missing"), f.head, null, "missing");
  assert.equal(pair.workspace.state, "unavailable");
  assert.equal(pair.contribution.changes.state, "unavailable");
  assert.ok(await f.capture.begin(f.path, "next"));
  await releaseWorkspaceTree(f.path, "next");
  f.capture.close();
  await assert.rejects(f.capture.begin(f.path, "after-close"), /unavailable/);
});

test("queue expiry and close never abandon active Git cleanup or start a queued capture", async t => {
  const f = await fixture(t);
  const baseline = await f.capture.begin(f.path, "active");
  let answer!: (tips: null) => void;
  const tips = new Promise<null>(resolve => { answer = resolve; });
  let finished = false;
  const active = f.capture.settle(f.path, f.head, baseline, "active", f.head, tips).then(pair => { finished = true; return pair; });
  for (let count = 0; ; count++) {
    if (f.git("for-each-ref", "--format=%(refname)", "refs/letagents/workspace-review").split("\n").length === 2) break;
    assert.ok(count < 200);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expired = assert.rejects(f.capture.begin(f.path, "expired"), /queue is busy/);
  t.mock.timers.tick(30_001);
  await expired;
  assert.equal(finished, false, "queue timeout cannot settle a started capture");
  const closed = assert.rejects(f.capture.begin(f.path, "closed"), /closed or expired/);
  f.capture.close();
  t.mock.timers.reset();
  answer(null);
  assert.equal((await active).workspace.state, "ready");
  await closed;
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/letagents/workspace-review"), "",
    "active refs are cleaned and neither queued job ever captures a tree");
});
