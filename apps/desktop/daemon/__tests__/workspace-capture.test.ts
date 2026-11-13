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

const pinned = async (f: Awaited<ReturnType<typeof fixture>>) => {
  // Its settled retention ref proves the bytes were captured, even while the
  // original remote request remains outstanding.
  for (let count = 0; ; count++) {
    if (f.git("for-each-ref", "--format=%(refname)", "refs/letagents/workspace-review").split("\n").length === 2) break;
    assert.ok(count < 200, "settled snapshot should not wait for remote tips");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test("settled bytes are pinned before a delayed remote answer, and the wait holds no other capture", async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const baseline = await f.capture.begin(f.path, "turn");
  assert.ok(baseline);
  // The turn moves HEAD: only such a turn needs what the remote held.
  await writeFile(join(f.path, "file"), "settled\n"); f.git("commit", "-qam", "the turn's commit");
  let answer!: (tips: null) => void;
  const tips = new Promise<null>(resolve => { answer = resolve; });
  let finished = false;
  const settled = f.capture.settle(f.path, f.head, baseline, "turn", f.head, tips).then(pair => { finished = true; return pair; });
  await pinned(f);
  // Later edits are excluded.
  await writeFile(join(f.path, "file"), "later unrelated edit\n");
  // The queue is one for all agents. Another agent's turn does not start before its starting
  // capture, so that capture must not wait for this turn's remote: here the remote never answers.
  assert.ok(await f.capture.begin(other.path, "another agent's turn"), "a starting capture runs while a settled turn waits for the remote");
  const queued = Array.from({ length: 8 }, (_, i) => f.capture.begin(f.path, `queued-${i}`));
  await assert.rejects(f.capture.begin(f.path, "overflow"), /unavailable/, "queued captures are bounded");
  assert.ok((await Promise.all(queued)).every(Boolean));
  assert.equal(finished, false, "the settled turn still waits for its answer");
  answer(null);
  const pair = await settled;
  assert.equal(pair.contribution.changes.state, "ready");
  assert.match(pair.review.contribution.patch, /\+settled/);
  assert.doesNotMatch(pair.review.contribution.patch, /later unrelated/);
  await releaseWorkspaceTree(f.path, "turn");
  await releaseWorkspaceTree(other.path, "another agent's turn");
  for (let i = 0; i < 8; i++) await releaseWorkspaceTree(f.path, `queued-${i}`);
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/letagents/workspace-review"), "");
});

test("a turn that did not move HEAD is settled without the remote answer", async t => {
  const f = await fixture(t);
  const baseline = await f.capture.begin(f.path, "turn");
  await writeFile(join(f.path, "file"), "edited\n");
  // The answer never comes.
  const pair = await f.capture.settle(f.path, f.head, baseline, "turn", f.head, new Promise<null>(() => {}));
  assert.match(pair.review.contribution.patch, /\+edited/);
  await releaseWorkspaceTree(f.path, "turn");
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
  const baseline = await f.capture.begin(f.path, "waiting");
  await writeFile(join(f.path, "file"), "settled\n"); f.git("commit", "-qam", "the turn's commit");
  let answer!: (tips: null) => void;
  const tips = new Promise<null>(resolve => { answer = resolve; });
  const waiting = f.capture.settle(f.path, f.head, baseline, "waiting", f.head, tips);
  await pinned(f);
  // A capture that runs holds the queue. One behind it expires, and never starts.
  const active = f.capture.begin(f.path, "active");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expired = assert.rejects(f.capture.begin(f.path, "expired"), /queue is busy/);
  t.mock.timers.tick(30_001);
  await expired;
  t.mock.timers.reset();
  assert.ok(await active, "queue timeout cannot settle a started capture");
  await releaseWorkspaceTree(f.path, "active");
  // Closed while a settled turn waits for its remote: the comparison never starts, and its pinned files are released.
  const closed = assert.rejects(f.capture.begin(f.path, "closed"), /closed or expired/);
  f.capture.close();
  answer(null);
  await assert.rejects(waiting, /unavailable/);
  await closed;
  assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/letagents/workspace-review"), "",
    "active refs are cleaned and neither queued job ever captures a tree");
});
