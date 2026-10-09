import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { captureRecordedRemoteTips, captureRemoteTips, releaseWorkspaceTree } from '../../../../shared/workspace-turn-capture.mjs';
import { OWN, OWN_ROWS, STAGING_FILES, assertPlain, card, commit, count, environment, fixture, git, lines, listed, recorded, turn, write } from './fixtures/workspace-turns.js';

// A change card must count what the agent changed. Commits that enter the
// workspace through a fetch followed by a checkout, merge, rebase or pull are
// the base branch moving, not the agent's work. The card is also a trust
// surface: it may show too much, but it must never hide a change the agent made.
// So the only evidence of "upstream" is what the remote held before the turn. The
// supervisor daemon asks the remote it recorded itself when it made the workspace,
// because an agent can point the repository's own remotes at a repository of its own.

test('case A: a workspace that starts on an old commit is not credited with the history it fetches', async t => {
  const f = fixture(t);
  const workspace = f.detachedWorktree(f.first);
  const landed = f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
    commit(workspace, 'the fix', OWN);
    git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
  });
  assert.equal(git(workspace, 'rev-parse', 'HEAD^'), landed, 'the fix sits on the fetched staging commit');
  assert.equal(count(result.before), STAGING_FILES + 2, 'the plain comparison counts every file staging gained');
  assert.deepEqual(listed(result.after), OWN_ROWS);
  assert.deepEqual([result.after.additions, result.after.deletions], [3, 1]);
  assert.doesNotMatch(result.after.patch, /module|from staging|handbook/);
  assert.match(result.after.patch, /\+app 3 fixed/);
});

test('case B: merging the base branch into the feature branch is not the agent\'s change', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  commit(workspace, 'earlier turn', { 'src/own.ts': lines(4, 'own') });
  git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
  f.landOnStaging();
  const merge = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'merge', '-q', '--no-edit', 'origin/staging');
    git(workspace, 'push', '-q', 'origin', 'fix/own');
  });
  assert.equal(count(merge.before), STAGING_FILES);
  assert.equal(merge.after.state, 'ready');
  assert.deepEqual(listed(merge.after), [], 'a turn that only updates the base changed nothing of its own');
  assert.equal(merge.after.patch, '');
  assert.equal(card(merge.after), false, 'no card and no review are published for it');

  const next = await turn(workspace, f.first, () => {
    commit(workspace, 'next turn', { 'src/own.ts': lines(5, 'own') });
    git(workspace, 'push', '-q', 'origin', 'fix/own');
  });
  assert.deepEqual(listed(next.after), ['modified src/own.ts +1 -0']);
  assertPlain(next);
});

test('a merge and an own commit in the same turn show the own commit only', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  commit(workspace, 'earlier turn', { 'src/own.ts': lines(4, 'own') });
  git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
  f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'merge', '-q', '--no-edit', 'origin/staging');
    commit(workspace, 'after the merge', { 'src/own.ts': lines(5, 'own') });
    git(workspace, 'push', '-q', 'origin', 'fix/own');
  });
  assert.equal(count(result.before), STAGING_FILES + 1);
  assert.deepEqual(listed(result.after), ['modified src/own.ts +1 -0']);
});

test('rebasing onto a newer base shows only what the turn added', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  commit(workspace, 'earlier turn', { 'src/own.ts': lines(4, 'own') });
  git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
  const landed = f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'rebase', '-q', 'origin/staging');
    commit(workspace, 'second', { 'src/second.ts': lines(3, 'second') });
    git(workspace, 'push', '-q', '--force', 'origin', 'fix/own');
  });
  assert.equal(git(workspace, 'merge-base', 'HEAD', 'origin/staging'), landed);
  assert.equal(count(result.before), STAGING_FILES + 1);
  assert.deepEqual(listed(result.after), ['added src/second.ts +3 -0']);
});

test('a fast-forward pull keeps uncommitted and untracked edits and drops what was pulled', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  const second = f.clone('second');
  f.landOnStaging();
  const pulled = await turn(workspace, f.first, () => { git(workspace, 'pull', '-q', '--ff-only'); });
  assert.equal(count(pulled.before), STAGING_FILES);
  assert.deepEqual(listed(pulled.after), []);
  assert.equal(card(pulled.after), false);

  const result = await turn(second, f.first, () => {
    git(second, 'pull', '-q', '--ff-only');
    write(second, { 'src/app.ts': lines(5, 'app').replace('app 1', 'app 1 edited'), 'notes.txt': 'untracked\n' });
  });
  assert.equal(git(second, 'status', '--porcelain'), 'M src/app.ts\n?? notes.txt');
  assert.equal(count(result.before), STAGING_FILES + 2);
  assert.deepEqual(listed(result.after), ['added notes.txt +1 -0', 'modified src/app.ts +1 -1']);
});

test('an own edit to a file the base update also changed is measured against the new base', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'pull', '-q', '--ff-only');
    commit(workspace, 'own edits', { 'src/shared.ts': readFileSync(join(workspace, 'src/shared.ts'), 'utf8').replace('shared 6', 'shared 6 edited'),
      'lib/module-03.ts': `${lines(3, 'module 3')}own line\n` });
  });
  const before = result.before.files.filter(file => ['src/shared.ts', 'lib/module-03.ts'].includes(file.path));
  assert.deepEqual(listed({ ...result.before, files: before }), ['added lib/module-03.ts +4 -0', 'modified src/shared.ts +2 -2']);
  assert.deepEqual(listed(result.after), ['modified lib/module-03.ts +1 -0', 'modified src/shared.ts +1 -1']);
  assert.doesNotMatch(result.after.patch, /^[+-]shared 1/m, 'the line staging changed is context, not a change');
});

test('an upstream change that the turn drops is the agent\'s change, although the file is as it was', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  commit(workspace, 'earlier turn', { 'src/own.ts': lines(4, 'own') });
  f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'merge', '-q', '--no-edit', 'origin/staging');
    git(workspace, 'checkout', 'HEAD~1', '--', 'src/shared.ts');
    git(workspace, 'commit', '-q', '-m', 'put the old file back');
  });
  assert.equal(readFileSync(join(workspace, 'src/shared.ts'), 'utf8'), lines(6, 'shared'));
  assert.ok(!result.before.files.some(file => file.path === 'src/shared.ts'), 'start and end are equal, so the plain comparison is silent');
  assert.deepEqual(listed(result.after), ['modified src/shared.ts +1 -1']);
  assert.match(result.after.patch, /-shared 1 from staging\n\+shared 1\n/);
});

test('a file the agent changed before the base moved stays as before, conflict resolution included', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  commit(workspace, 'earlier turn', { 'src/shared.ts': lines(6, 'shared').replace('shared 1', 'shared 1 from the agent') });
  f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    assert.throws(() => git(workspace, 'merge', '--no-edit', 'origin/staging'));
    assert.match(git(workspace, 'status', '--porcelain'), /^UU src\/shared\.ts$/m);
    write(workspace, { 'src/shared.ts': lines(6, 'shared').replace('shared 1', 'shared 1 resolved') });
    git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '--no-edit');
  });
  assert.equal(count(result.before), STAGING_FILES);
  assert.deepEqual(listed(result.after), ['modified src/shared.ts +1 -1']);
  assert.deepEqual(listed(result.after), listed({ ...result.before, files: result.before.files.filter(file => file.path === 'src/shared.ts') }));
  assert.match(result.after.patch, /-shared 1 from the agent\n\+shared 1 resolved/);
});

test('an earlier change stays on the card when upstream turns its directory into a file', async t => {
  const f = fixture(t);
  f.land('a package', { 'pkg/a.ts': lines(3, 'a'), 'pkg/b.ts': lines(3, 'b') });
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  commit(workspace, 'earlier turn', { 'pkg/a.ts': lines(4, 'a') });
  git(f.team, 'rm', '-rq', 'pkg');
  f.land('the package becomes one file', { pkg: lines(2, 'package') });
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    assert.throws(() => git(workspace, 'merge', '--no-edit', 'origin/staging'));
    // Accept theirs: the earlier change to pkg/a.ts is given up.
    git(workspace, 'read-tree', '--reset', '-u', 'origin/staging');
    git(workspace, 'commit', '-q', '--no-edit');
  });
  assert.deepEqual(listed(result.before), ['added pkg +2 -0', 'deleted pkg/a.ts +0 -4', 'deleted pkg/b.ts +0 -3']);
  assert.deepEqual(listed(result.after), ['added pkg +2 -0', 'deleted pkg/a.ts +0 -4'], 'the untouched pkg/b.ts went with the base; the given-up change did not');
});

test('renames, deletions and binary files of the agent survive a base update', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'pull', '-q', '--ff-only');
    git(workspace, 'mv', 'src/old-name.ts', 'src/new-name.ts');
    write(workspace, { 'src/remove-me.ts': null, 'assets/logo.bin': Buffer.from([0, 1, 2, 3, 0, 255]) });
  });
  assert.equal(count(result.before), STAGING_FILES + 3);
  assert.deepEqual(listed(result.after), ['added assets/logo.bin +0 -0', 'deleted src/remove-me.ts +0 -2', 'renamed src/new-name.ts +0 -0']);
  assert.equal(result.after.files.find(file => file.path === 'src/new-name.ts')?.previous_path, 'src/old-name.ts');
  assert.equal(result.after.files.find(file => file.path === 'assets/logo.bin')?.binary, true);
});

test('a turn without a base update produces exactly the card it produced before', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  const result = await turn(workspace, f.first, () => {
    commit(workspace, 'committed', { 'src/app.ts': lines(5, 'app').replace('app 2', 'app 2 changed'), 'src/remove-me.ts': null });
    git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
    git(workspace, 'mv', 'src/old-name.ts', 'src/new-name.ts');
    write(workspace, { 'assets/logo.bin': Buffer.from([0, 1, 2]), 'notes.txt': 'untracked\n' });
  });
  assert.equal(count(result.after), 5);
  assertPlain(result);

  // Staging moved on the remote, but this turn does not take it in.
  f.landOnStaging();
  const unfetched = await turn(workspace, f.first, () => { commit(workspace, 'more', { 'src/more.ts': lines(2, 'more') }); });
  assert.ok(unfetched.tips?.length);
  assert.deepEqual(listed(unfetched.after), ['added src/more.ts +2 -0']);
  assertPlain(unfetched);
});

test('a base update is recognized on a branch that is stacked on another remote branch', async t => {
  const f = fixture(t);
  const feature = f.pushFeatureBranch();
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/feature');
  commit(workspace, 'earlier turn', { 'src/own.ts': lines(4, 'own') });
  f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'merge', '-q', '--no-edit', 'origin/staging');
  });
  assert.ok(result.tips?.includes(feature), 'the teammate\'s branch is on the remote, but it was already in the starting history');
  assert.equal(count(result.before), STAGING_FILES);
  assert.deepEqual(listed(result.after), []);
});

test('a base that moves during the turn is counted: only what the remote held before the turn is a base', async t => {
  const f = fixture(t);
  const behind = f.clone('behind');
  f.landOnStaging();
  const current = f.clone('current');
  // The workspace is behind, the snapshot sees staging, and then staging moves again.
  const result = await turn(behind, f.first, () => {
    f.land('late', { 'late.ts': lines(2, 'late') });
    git(behind, 'pull', '-q', '--ff-only');
    commit(behind, 'own work', OWN);
  });
  assert.equal(count(result.before), STAGING_FILES + 3);
  assert.deepEqual(listed(result.after), ['added late.ts +2 -0', ...OWN_ROWS]);

  // The workspace is up to date when the turn starts. Nothing the remotes hold is new to it.
  git(current, 'pull', '-q', '--ff-only');
  const none = await turn(current, f.first, () => {
    f.land('later', { 'later.ts': lines(2, 'later') });
    git(current, 'pull', '-q', '--ff-only');
    commit(current, 'own work', OWN);
  });
  assert.deepEqual(listed(none.after), ['added later.ts +2 -0', ...OWN_ROWS]);
  assertPlain(none);
});

test('without an answer from the remote, the card is the plain comparison', async t => {
  const f = fixture(t);
  const lonely = join(f.root, 'lonely');
  git(f.root, 'init', '-q', '-b', 'main', lonely);
  commit(lonely, 'first', { 'app.ts': lines(2, 'app') });
  const noRemote = await turn(lonely, git(lonely, 'rev-parse', 'HEAD'), () => { commit(lonely, 'second', { 'app.ts': lines(3, 'app') }); });
  assert.equal(noRemote.tips, null);
  assertPlain(noRemote);

  const unreachable = f.clone('unreachable');
  const partly = f.clone('partly');
  const forgotten = f.clone('forgotten');
  f.landOnStaging();
  const work = (workspace: string) => () => { git(workspace, 'pull', '-q', '--ff-only', f.remote, 'staging'); commit(workspace, 'own work', OWN); };

  recorded.set(unreachable, join(f.root, 'missing.git'));
  const failed = await turn(unreachable, f.first, work(unreachable));
  assert.equal(failed.tips, null);
  assert.equal(count(failed.after), STAGING_FILES + 2);
  assertPlain(failed);

  // An MCP worker asks every remote its clone configures. One that does not answer makes the answer incomplete: no answer.
  git(partly, 'remote', 'add', 'gone', join(f.root, 'missing.git'));
  assert.equal(await captureRemoteTips(partly), null);
  assert.ok((await captureRecordedRemoteTips(f.remote))?.length, 'the daemon asks its one recorded remote only');

  // The remote answered, but the capture does not know the answer or the starting commit (a restarted daemon), or the commit is gone.
  const broken = Promise.reject<string[] | null>(new Error('the question broke'));
  broken.catch(() => {});
  for (const [index, evidence] of [{ tips: null }, { head: null }, { head: 'a'.repeat(40) }, { tips: [] }, { tips: broken }].entries()) {
    const workspace = f.clone(`forgotten-${index}`);
    git(workspace, 'reset', '-q', '--hard', f.first);
    const result = await turn(workspace, f.first, work(workspace), evidence);
    assert.equal(count(result.after), STAGING_FILES + 2, JSON.stringify(evidence));
    assertPlain(result);
  }
  // The same turn with its evidence, to show that the evidence is what makes the difference.
  git(forgotten, 'reset', '-q', '--hard', f.first);
  assert.deepEqual(listed((await turn(forgotten, f.first, work(forgotten))).after), OWN_ROWS);
});

test('two unrelated upstream lines in one turn give the plain comparison', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  f.landOnStaging();
  f.pushFeatureBranch();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'checkout', '-q', '-b', 'fix/own');
    git(workspace, 'merge', '-q', '--no-edit', 'origin/staging', 'origin/feature');
  });
  assert.equal(count(result.after), STAGING_FILES + 1);
  assertPlain(result);
});

test('when the files on disk are not the committed files, the card is the plain comparison', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'config', 'core.autocrlf', 'true');
  git(workspace, 'rm', '-rq', '--cached', '.'); git(workspace, 'reset', '-q', '--hard');
  assert.match(readFileSync(join(workspace, 'src/app.ts'), 'utf8'), /\r\n/);
  f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'pull', '-q', '--ff-only');
    write(workspace, { 'src/app.ts': lines(5, 'app').replace('app 3', 'app 3 fixed').replaceAll('\n', '\r\n') });
  });
  assert.equal(count(result.after), STAGING_FILES + 1);
  assertPlain(result);

  // A sparse checkout leaves files out. They are not deletions by the agent.
  const sparse = f.clone('sparse');
  git(sparse, 'reset', '-q', '--hard', f.first);
  git(sparse, 'sparse-checkout', 'set', '--cone', 'src');
  const partial = await turn(sparse, f.first, () => {
    git(sparse, 'pull', '-q', '--ff-only');
    write(sparse, { 'src/app.ts': lines(5, 'app').replace('app 3', 'app 3 fixed') });
  });
  assert.ok(partial.tips?.length);
  assert.deepEqual(listed(partial.after), ['deleted src/legacy.ts +0 -4', 'modified README.md +1 -1', 'modified src/app.ts +1 -1', 'modified src/shared.ts +1 -1']);
  assertPlain(partial);
});

test('more gained remote branches than the capture will sort out give the plain comparison', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  let tip = f.landOnStaging();
  // 257 more commits on staging, each with a branch of its own on the remote.
  execFileSync('git', ['fast-import', '--quiet'], { cwd: f.team, env: environment, stdio: ['pipe', 'ignore', 'pipe'], input: Array.from({ length: 257 }, (_, index) =>
    `commit refs/heads/many/b${index}\nmark :${index + 1}\ncommitter Fixture Author <author@example.invalid> ${1_700_000_000 + index} +0000\ndata 5\nmore\n\nfrom ${index ? `:${index}` : tip}\n\n`).join('') });
  tip = git(f.team, 'rev-parse', 'refs/heads/many/b256');
  git(f.team, 'push', '-q', 'origin', 'refs/heads/many/*:refs/heads/many/*', 'refs/heads/many/b256:refs/heads/staging');
  const result = await turn(workspace, f.first, () => { git(workspace, 'pull', '-q', '--ff-only'); commit(workspace, 'own work', OWN); });
  assert.equal(git(workspace, 'rev-parse', 'HEAD^'), tip);
  assert.equal(result.tips?.length, 258, '257 branches (staging is one of them) and release');
  assert.equal(count(result.after), STAGING_FILES + 2);
  assertPlain(result);
});

test('an independent MCP worker\'s capture follows the same rule', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  f.landOnStaging();
  const directory = mkdtempSync(join(tmpdir(), 'workspace-base-update-prepared-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const capture = { capture_id: randomUUID(), workspace, base_revision: git(workspace, 'rev-parse', 'HEAD'), baseline: null as string | null, preparation_id: randomUUID() };
  const run = async (operation: 'begin' | 'finish', remoteTips: string[] | null = null) => {
    const worker = new Worker(new URL('../../../../shared/mcp-workspace-capture-worker.mjs', import.meta.url), {
      workerData: { operation, capture, directory, text: 'Edited the app.', remoteTips }, execArgv: [],
    });
    try {
      return await new Promise<{ baseline?: string | null }>((resolve, reject) => {
        worker.once('message', value => value.error ? reject(new Error(value.error)) : resolve(value));
        worker.once('error', reject);
      });
    } finally { await worker.terminate(); }
  };
  const tips = await captureRemoteTips(workspace);
  capture.baseline = (await run('begin')).baseline ?? null;
  assert.ok(capture.baseline);
  git(workspace, 'pull', '-q', '--ff-only');
  commit(workspace, 'own work', OWN);
  await run('finish', tips);
  const prepared = JSON.parse(readFileSync(join(directory, 'prepared.json'), 'utf8'));
  assert.deepEqual(listed(prepared.summary.contribution.changes), OWN_ROWS);
  assert.equal(count(prepared.summary.workspace), STAGING_FILES + 2, 'changes since the capture began stay the plain comparison');
  // A restarted MCP server has no answer from the remotes any more.
  capture.preparation_id = randomUUID();
  await run('finish');
  assert.equal(count(JSON.parse(readFileSync(join(directory, 'prepared.json'), 'utf8')).summary.contribution.changes), STAGING_FILES + 2);
  await releaseWorkspaceTree(workspace, `mcp-workspace:${capture.capture_id}`);
});
