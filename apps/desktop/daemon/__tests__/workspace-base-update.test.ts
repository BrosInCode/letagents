import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { captureRecordedRemoteTips, captureRemoteTips, releaseWorkspaceTree } from '../../../../shared/workspace-turn-capture.mjs';
import { OWN, OWN_ROWS, STAGING_FILES, assertPlain, card, commit, count, environment, fixture, git, lines, listed, recorded, turn, write } from './fixtures/workspace-turns.js';
import { removeTestDirectory } from "../../electron/__tests__/harness.js";
import { DaemonLifecycleLog } from '../lifecycle-log.js';
import { REMOTE_FAILURE_PAUSE_MS, askRecordedRemote, setRemoteUnansweredReporter } from '../recorded-remote-answers.js';

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
  // A null always comes with its reason, so a capture compared plainly for a fixable cause is not silent.
  const reasons: string[] = [];
  const onNoAnswer = (reason: string) => { reasons.push(reason); };
  git(partly, 'remote', 'add', 'gone', join(f.root, 'missing.git'));
  assert.equal(await captureRemoteTips(partly, { onNoAnswer }), null);
  assert.equal(await captureRemoteTips(lonely, { onNoAnswer }), null);
  assert.equal(await captureRecordedRemoteTips(join(f.root, 'missing.git'), undefined, { onNoAnswer }), null);
  assert.equal(await captureRecordedRemoteTips(null, undefined, { onNoAnswer }), null);
  assert.equal(reasons.length, 4);
  assert.ok(reasons.every(reason => reason.length > 0), JSON.stringify(reasons));
  assert.equal(reasons[1], 'the repository has no remote');
  assert.equal(reasons[3], 'no remote was recorded');
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

// The real case behind the tests below: the daemon makes an agent's workspace at the commit the
// owner's project folder is on, and that was an old local branch, far from the remote's staging on
// both sides. The agent made its branch from the remote's staging and committed one file. The card
// showed 3213 files: without an answer from the remote, every difference between the two branches;
// with one, still each file that the old branch had changed.
// Between the old branch and staging: 15 files that both changed (12 modules, the readme, shared.ts, legacy.ts),
// 2 that only the old branch has, and the guide that only staging renamed.
const BRANCH_DIFFERENCES = 18;
/**
 * A workspace that the daemon made on `old`, the commit of an old local branch. That branch changed the
 * files staging changes too, and files of its own. Staging lands after it.
 */
function onOldBranch(f: ReturnType<typeof fixture>, name: string, pushed = false) {
  const workspace = f.clone(name);
  git(workspace, 'checkout', '-q', '-b', 'old-work');
  commit(workspace, 'old work 1', { ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`lib/module-${String(index + 1).padStart(2, '0')}.ts`, lines(4, `old module ${index + 1}`)])),
    'old/one.ts': lines(3, 'old one') });
  const old = commit(workspace, 'old work 2', { 'README.md': lines(3, 'readme').replace('readme 2', 'readme 2 from the old branch'),
    'src/shared.ts': lines(6, 'shared').replace('shared 1', 'shared 1 from the old branch'), 'src/legacy.ts': lines(5, 'legacy'), 'old/two.ts': lines(3, 'old two') });
  if (pushed) git(workspace, 'push', '-q', 'origin', 'old-work');
  // The daemon's workspace is detached at the commit of the owner's folder.
  git(workspace, 'checkout', '-q', '--detach');
  return { workspace, old, landed: f.landOnStaging() };
}
const FIX = { 'src/fix.test.ts': lines(33, 'case') };

test('a workspace that starts on an old diverged branch that no remote has: a branch made from the remote\'s staging shows its one file', async t => {
  for (const pushed of [false, true]) {
    const f = fixture(t);
    const { workspace, old, landed } = onOldBranch(f, 'agent', pushed);
    const result = await turn(workspace, old, () => {
      git(workspace, 'fetch', '-q', 'origin');
      git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
      commit(workspace, 'the fix', FIX);
      git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
    });
    assert.equal(git(workspace, 'rev-parse', 'HEAD^'), landed);
    assert.equal(result.tips?.includes(old), pushed, 'the old branch is on the remote or it is not; the card is the same');
    assert.equal(git(workspace, 'rev-list', '--count', `${landed}..${old}`), '2', 'the old branch has commits that staging lacks');
    // Plainly compared, the card is every difference between the two branches.
    assert.equal(count(result.before), BRANCH_DIFFERENCES + 1, 'every difference between the branches, and the fix');
    if (pushed) {
      // The old branch is on the remote: its tip is a held commit, and the turn left it for a line that lacks it.
      // Nothing tells that from a turn that drops a remote branch's work, so the turn is read as before:
      // the 17 files of the old branch, and the fix. The file that only staging renamed went with the base.
      assert.equal(count(result.after), BRANCH_DIFFERENCES);
      assert.ok(listed(result.after).includes('added src/fix.test.ts +33 -0'));
      continue;
    }
    assert.deepEqual(listed(result.after), ['added src/fix.test.ts +33 -0']);
    assert.deepEqual([result.after.additions, result.after.deletions], [33, 0]);
    assert.doesNotMatch(result.after.patch, /old|module|from staging|handbook|legacy/);
  }
});

test('on a line the turn left, an edit is measured against the new base and an uncommitted start is kept as it was', async t => {
  const f = fixture(t);
  const { workspace, old } = onOldBranch(f, 'agent');
  // Before the turn: an uncommitted edit and an untracked file, in files that no branch changed.
  write(workspace, { 'src/old-name.ts': lines(8, 'rename me').replace('rename me 4', 'rename me 4 edited earlier'), 'notes.txt': 'earlier notes\n' });
  const result = await turn(workspace, old, () => {
    git(workspace, 'fetch', '-q', 'origin');
    // The checkout carries both along.
    git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
    assert.equal(git(workspace, 'status', '--porcelain'), 'M src/old-name.ts\n?? notes.txt');
    // A file that the old branch and staging both changed, and one that only the old branch had.
    write(workspace, { 'src/shared.ts': readFileSync(join(workspace, 'src/shared.ts'), 'utf8').replace('shared 6', 'shared 6 edited'), 'old/one.ts': lines(3, 'old one') });
    git(workspace, 'add', 'src/shared.ts', 'old/one.ts'); git(workspace, 'commit', '-q', '-m', 'own edits');
    write(workspace, { 'notes.txt': 'earlier notes\nmore notes\n' });
  });
  // The old branch's file is new on this line, although its content was in the workspace at the start.
  assert.deepEqual(listed(result.after), ['added old/one.ts +3 -0', 'modified notes.txt +1 -0', 'modified src/shared.ts +1 -1']);
  assert.match(result.after.patch, /-shared 6\n\+shared 6 edited\n/);
  assert.doesNotMatch(result.after.patch, /shared 1|rename me/, 'the first line differs between the branches and is no change of the turn; the earlier edit is not this turn\'s');
  // The same turn without the two own edits: the earlier, uncommitted changes alone make no card.
  const quiet = onOldBranch(fixture(t), 'quiet').workspace;
  write(quiet, { 'src/old-name.ts': lines(8, 'rename me').replace('rename me 4', 'rename me 4 edited earlier'), 'notes.txt': 'earlier notes\n' });
  const none = await turn(quiet, git(quiet, 'rev-parse', 'HEAD'), () => { git(quiet, 'fetch', '-q', 'origin'); git(quiet, 'checkout', '-q', '-b', 'fix/own', 'origin/staging'); });
  assert.equal(count(none.before), BRANCH_DIFFERENCES);
  assert.deepEqual(listed(none.after), []);
  assert.equal(card(none.after), false);
});

test('an agent that leaves its line cannot hide a commit by pushing it, by moving local refs or by writing commit dates', async t => {
  const f = fixture(t);
  const { workspace, old, landed } = onOldBranch(f, 'agent');
  const dated = (...args: string[]) => execFileSync('git', args, { cwd: workspace, env: { ...environment, GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let pushed = '';
  const result = await turn(workspace, old, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
    write(workspace, OWN); git(workspace, 'add', '-A'); dated('commit', '-q', '-m', 'own work');
    pushed = git(workspace, 'rev-parse', 'HEAD');
    // On the remote: on a branch of its own, and on the base branch itself.
    git(workspace, 'push', '-q', 'origin', 'fix/own', 'HEAD:refs/heads/staging');
    // In the workspace: every local name for "upstream" points at the agent's commit.
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'update-ref', 'refs/remotes/origin/release', pushed);
    git(workspace, 'branch', '-q', '-f', 'old-work', pushed);
  });
  assert.equal(git(workspace, 'rev-parse', 'origin/staging'), pushed);
  assert.ok((await captureRecordedRemoteTips(f.remote))?.includes(pushed), 'the remote holds the commit now');
  assert.ok(result.tips?.includes(landed) && !result.tips.includes(pushed), 'the answer of the turn is from before the push');
  assert.deepEqual(listed(result.after), OWN_ROWS);
  assert.match(result.after.patch, /\+app 3 fixed/);

  // A base that the history holds cannot be passed over for an older one. The agent starts its branch on the
  // first commit, makes commits with old dates, merges staging and puts one of staging's files back.
  const g = fixture(t);
  const { workspace: second, old: secondOld } = onOldBranch(g, 'agent');
  const older = (...args: string[]) => execFileSync('git', args, { cwd: second, env: { ...environment, GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const dropped = await turn(second, secondOld, () => {
    git(second, 'fetch', '-q', 'origin');
    git(second, 'checkout', '-q', '-b', 'fix/own', g.first);
    for (let index = 0; index < 12; index++) older('commit', '-q', '--allow-empty', '-m', `empty ${index}`);
    older('merge', '-q', '--no-edit', 'origin/staging');
    git(second, 'checkout', g.first, '--', 'src/shared.ts');
    older('commit', '-q', '-m', 'put the old file back');
  });
  assert.equal(readFileSync(join(second, 'src/shared.ts'), 'utf8'), lines(6, 'shared'));
  assert.deepEqual(listed(dropped.after), ['modified src/shared.ts +1 -1'], 'the upstream change that the turn dropped');
  assert.match(dropped.after.patch, /-shared 1 from staging\n\+shared 1\n/);
});

test('work of this workspace that a turn leaves behind is on the card, pushed or not', async t => {
  for (const [name, published, leave] of [
    ['a new branch, the earlier work not pushed', false, 'branch'], ['a new branch, the earlier work pushed', true, 'branch'],
    ['a reset, the earlier work not pushed', false, 'reset'], ['a reset, the earlier work pushed', true, 'reset']] as const) {
    const f = fixture(t);
    // The workspace was made on the first commit. An earlier turn committed there.
    const workspace = f.clone();
    git(workspace, 'checkout', '-q', '-b', 'fix/earlier');
    commit(workspace, 'earlier turn', { 'src/earlier.ts': lines(4, 'earlier'), 'src/app.ts': lines(5, 'app').replace('app 1', 'app 1 earlier') });
    if (published) git(workspace, 'push', '-q', '-u', 'origin', 'fix/earlier');
    f.landOnStaging();
    const result = await turn(workspace, f.first, () => {
      git(workspace, 'fetch', '-q', 'origin');
      if (leave === 'branch') { git(workspace, 'checkout', '-q', '-b', 'fix/next', 'origin/staging'); commit(workspace, 'the next fix', FIX); }
      else git(workspace, 'reset', '-q', '--hard', 'origin/staging');
    });
    const next = leave === 'branch' ? ['added src/fix.test.ts +33 -0'] : [];
    assert.equal(count(result.before), STAGING_FILES + 2 + next.length, name);
    // The turn gave the earlier work up, and the card says so as it did before. What staging gained is not on it.
    assert.deepEqual(listed(result.after), [...next, 'deleted src/earlier.ts +0 -4', 'modified src/app.ts +1 -1'].sort(), name);
  }
});

test('a turn that goes back, or to the side, onto history that the start already had is read as before', async t => {
  const f = fixture(t);
  // A teammate's branch that is not in staging, and two commits on staging: a feature and a security fix.
  git(f.team, 'checkout', '-q', '-b', 'wip');
  commit(f.team, 'wip', { 'src/app.ts': lines(5, 'app').replace('app 2', 'app 2 not reviewed') });
  git(f.team, 'push', '-q', 'origin', 'wip'); git(f.team, 'checkout', '-q', 'staging');
  f.land('feature', { 'src/feature.ts': lines(4, 'feature') });
  const tip = f.land('security fix', { 'src/shared.ts': lines(6, 'shared').replace('shared 2', 'shared 2 checks the token') });
  const undone = ['modified src/shared.ts +1 -1'];
  const shapes: Array<[string, (workspace: string) => void, string[], boolean]> = [
    ['a reset to the commit before the security fix', workspace => { git(workspace, 'reset', '-q', '--hard', 'HEAD~1'); }, undone, true],
    ['a branch from that commit, and an own commit', workspace => { git(workspace, 'checkout', '-q', '-b', 'fix', 'HEAD~1'); commit(workspace, 'own', { 'src/own.ts': 'own\n' }); },
      ['added src/own.ts +1 -0', ...undone], true],
    ['a detached checkout of the first commit', workspace => { git(workspace, 'checkout', '-q', '--detach', f.first); }, ['deleted src/feature.ts +0 -4', ...undone], true],
    // The teammate's file is the content of a branch the remote held. What staging had and that branch lacks was dropped.
    ['a reset to a remote branch that lacks staging\'s commits', workspace => { git(workspace, 'reset', '-q', '--hard', 'origin/wip'); }, ['deleted src/feature.ts +0 -4', ...undone], false],
  ];
  for (const [index, [name, work, rows, plain]] of shapes.entries()) {
    // Both layouts: a clone on the branch, and the daemon's detached worktree.
    for (const workspace of [f.clone(`clone-${index}`), f.detachedWorktree(tip, `daemon-${index}`)]) {
      const result = await turn(workspace, tip, () => work(workspace));
      assert.ok(result.tips?.includes(tip), 'the turn started on a commit that the remote held');
      assert.deepEqual(listed(result.after), rows, name);
      if (plain) assertPlain(result);
    }
  }
});

/** The directory that a workspace shares with its repository: `.git` in a clone, the bare repository under a daemon worktree. */
const repositoryOf = (workspace: string) => resolve(workspace, git(workspace, 'rev-parse', '--git-common-dir'));
/**
 * Ways to give `child` the parent `parent` on paper, with files that an agent can write next to the objects.
 * Each one makes `merge-base` say that `parent` is in the history of `child`.
 */
const FORGED_PARENTS: Record<string, (workspace: string, child: string, parent: string) => void> = {
  'a grafts file': (workspace, child, parent) => {
    mkdirSync(join(repositoryOf(workspace), 'info'), { recursive: true });
    writeFileSync(join(repositoryOf(workspace), 'info', 'grafts'), `${child} ${parent}\n`);
  },
  'a replace ref': (workspace, child, parent) => { git(workspace, 'replace', '--graft', child, parent); },
  // The commit-graph file holds every commit's parents by position. Git reads them from it and not from the commits.
  'a commit-graph file': (workspace, child, parent) => {
    execFileSync('git', ['-c', 'commitGraph.generationVersion=1', 'commit-graph', 'write', '--stdin-commits'], { cwd: workspace, env: environment, input: `${child}\n${parent}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
    const path = join(repositoryOf(workspace), 'objects', 'info', 'commit-graph');
    const graph = readFileSync(path);
    assert.equal(graph.subarray(0, 4).toString('latin1'), 'CGPH');
    const chunks = new Map(Array.from({ length: graph[6] + 1 }, (_, index) => [graph.subarray(8 + index * 12, 12 + index * 12).toString('latin1'), Number(graph.readBigUInt64BE(12 + index * 12))]));
    const offsets = [...chunks.values()].sort((a, b) => a - b);
    const ids = chunks.get('OIDL')!, data = chunks.get('CDAT')!, width = child.length / 2;
    const commits = (offsets[offsets.indexOf(ids) + 1] - ids) / width;
    const position = (id: string) => {
      const found = Array.from({ length: commits }, (_, index) => graph.subarray(ids + index * width, ids + (index + 1) * width).toString('hex')).indexOf(id);
      assert.ok(found >= 0, 'the commit is in the graph');
      return found;
    };
    const entry = (id: string) => data + position(id) * (width + 16) + width;
    const generation = (id: string) => graph.readUInt32BE(entry(id) + 8) >>> 2;
    graph.writeUInt32BE(position(parent), entry(child));
    graph.writeUInt32BE((((Math.max(generation(child), generation(parent) + 1)) << 2) | (graph.readUInt32BE(entry(child) + 8) & 3)) >>> 0, entry(child) + 8);
    createHash(width === 20 ? 'sha1' : 'sha256').update(graph.subarray(0, graph.length - width)).digest().copy(graph, graph.length - width);
    rmSync(path, { force: true }); writeFileSync(path, graph);
  },
};
const BACKDOOR = { 'src/shared.ts': lines(6, 'shared').replace('shared 2', 'shared 2 BACKDOOR') };

test('a commit of the turn cannot be made to look held by the remote: grafts, replace refs and a commit-graph file are not read', async t => {
  for (const [name, forge] of Object.entries(FORGED_PARENTS)) {
    for (const layout of ['clone', 'daemon'] as const) {
      const f = fixture(t);
      // The shape that the left-line reading is for: the workspace was made on an old commit that no remote has.
      const workspace = layout === 'clone' ? f.clone() : f.detachedWorktree(f.first);
      git(workspace, 'checkout', '-q', '--detach');
      const old = commit(workspace, 'old work', { 'old/a.ts': 'a\n' });
      // Two commits land. Git reads the commit it is asked about from the object itself, and the parents of
      // every commit below it from where they are kept: the forged parent goes under the commit below the tip.
      const below = f.land('second', { 'src/feature.ts': lines(4, 'feature') });
      const tip = f.land('third', { 'src/more.ts': lines(2, 'more') });
      let twin = '';
      const result = await turn(workspace, old, () => {
        git(workspace, 'fetch', '-q', 'origin');
        git(workspace, 'checkout', '-q', '--detach', 'origin/staging');
        const real = commit(workspace, 'evil', BACKDOOR);
        // A twin of the commit, with the same files. On paper a commit of staging gets the twin as its parent,
        // so that the twin is "in the history of a commit that the remote held", and is the base of its own card.
        twin = git(workspace, 'commit-tree', `${real}^{tree}`, '-p', f.first, '-m', 'evil');
        forge(workspace, below, twin);
        git(workspace, 'checkout', '-q', '--detach', twin);
      });
      // The forgery is real: a Git that reads these files takes the twin for an ancestor of the remote's tip.
      assert.doesNotThrow(() => git(workspace, 'merge-base', '--is-ancestor', twin, tip), `${name} (${layout})`);
      assert.ok(result.tips?.includes(tip) && !result.tips.includes(twin));
      assert.ok(listed(result.after).includes('modified src/shared.ts +1 -1'), `${name} (${layout}): ${JSON.stringify(listed(result.after))}`);
      assert.match(result.after.patch, /\+shared 2 BACKDOOR/);
      assertPlain(result);
    }
  }
});

test('a shallow file cannot hide that the turn went back: parents that are taken away do not make a step back a step to the side', async t => {
  const f = fixture(t);
  f.land('feature', { 'src/feature.ts': lines(4, 'feature') });
  const fixed = f.land('security fix', { 'src/shared.ts': lines(6, 'shared').replace('shared 2', 'shared 2 checks the token') });
  const workspace = f.clone();
  // Commits that no remote has: one on staging's tip, one on the first commit, and their merge. The workspace was made on the merge.
  const onTip = commit(workspace, 'local on the tip', { 'local/one.ts': 'one\n' });
  git(workspace, 'checkout', '-q', '--detach', f.first);
  const onFirst = commit(workspace, 'local on the first commit', { 'local/two.ts': 'two\n' });
  git(workspace, 'checkout', '-q', '--detach', onTip);
  git(workspace, 'merge', '-q', '--no-ff', '--no-edit', onFirst);
  const made = git(workspace, 'rev-parse', 'HEAD');
  const result = await turn(workspace, made, () => {
    // Back to the commit before the security fix. The shallow file cuts the only path from the start to it:
    // the start then seems to contain no more of the remote than the first commit.
    git(workspace, 'checkout', '-q', '--detach', `${fixed}~1`);
    writeFileSync(join(workspace, '.git', 'shallow'), `${onTip}\n`);
  });
  assert.throws(() => git(workspace, 'merge-base', '--is-ancestor', `${fixed}~1`, made), 'Git itself no longer sees the commit in the start\'s history');
  assert.deepEqual(listed(result.after), ['deleted local/one.ts +0 -1', 'deleted local/two.ts +0 -1', 'modified src/shared.ts +1 -1']);
  assert.match(result.after.patch, /-shared 2 checks the token\n\+shared 2\n/);
  assertPlain(result);
});

test('a recorded tip that is not in the repository is not fetched, and proves nothing', async t => {
  const [major, minor] = git(tmpdir(), 'version').replace(/^git version /, '').split('.').map(Number);
  if (major < 2 || (major === 2 && minor < 44)) return t.skip('GIT_NO_LAZY_FETCH needs Git 2.44');
  const f = fixture(t);
  git(f.remote, 'config', 'uploadpack.allowFilter', 'true');
  git(f.remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  // A partial clone: Git fetches a missing object when a command names it, with the remote that the clone configures.
  const workspace = join(f.root, 'partial');
  git(f.root, 'clone', '-q', '--filter=blob:none', pathToFileURL(f.remote).href, workspace);
  recorded.set(workspace, f.remote);
  git(workspace, 'checkout', '-q', '--detach');
  const old = commit(workspace, 'old work', { 'old/a.ts': 'a\n' });
  f.landOnStaging();
  // A teammate's branch that the workspace never fetches.
  const unfetched = f.pushFeatureBranch();
  const local = (id: string) => { try { execFileSync('git', ['cat-file', '-e', id], { cwd: workspace, env: { ...environment, GIT_NO_LAZY_FETCH: '1' }, stdio: 'ignore' }); return true; } catch { return false; } };
  const result = await turn(workspace, old, () => {
    git(workspace, 'fetch', '-q', 'origin', 'staging');
    git(workspace, 'checkout', '-q', '--detach', 'FETCH_HEAD');
    commit(workspace, 'the fix', FIX);
    assert.equal(local(unfetched), false);
  });
  assert.ok(result.tips?.includes(unfetched), 'the remote held the branch');
  assert.equal(local(unfetched), false, 'the capture started no fetch for it');
  assert.deepEqual(listed(result.after), ['added src/fix.test.ts +33 -0'], 'the tips that are in the repository are enough');
});

test('a rebase and an amended commit leave the start too, and show what they showed before', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  commit(workspace, 'earlier turn', { 'src/own.ts': lines(4, 'own'), 'src/other.ts': lines(2, 'other') });
  // Not pushed: the remote never held the earlier commit.
  const amended = await turn(workspace, f.first, () => {
    write(workspace, { 'src/own.ts': lines(5, 'own') });
    git(workspace, 'add', '-A'); git(workspace, 'commit', '-q', '--amend', '--no-edit');
  });
  assert.deepEqual(listed(amended.after), ['modified src/own.ts +1 -0'], 'not the whole amended commit again');
  assertPlain(amended);
  f.landOnStaging();
  const rebased = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'rebase', '-q', 'origin/staging');
    commit(workspace, 'second', { 'src/second.ts': lines(3, 'second') });
  });
  assert.equal(count(rebased.before), STAGING_FILES + 1);
  assert.deepEqual(listed(rebased.after), ['added src/second.ts +3 -0']);
});

test('a remote question without an answer is in the lifecycle log, and the card stays the plain comparison', async t => {
  const f = fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'workspace-base-update-log-'));
  const path = join(directory, 'daemon-lifecycle.jsonl');
  const log = new DaemonLifecycleLog(path);
  t.after(() => { setRemoteUnansweredReporter(null); log.close(); removeTestDirectory(directory); });
  // As the daemon's entrypoint installs it.
  setRemoteUnansweredReporter(sample => log.append({ event: 'workspace_remote_unanswered', detail: JSON.stringify(sample) }));
  const events = () => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const warned: string[] = [];
  // As the daemon's publisher asks.
  const ask = (remote: string) => askRecordedRemote(remote, (address, onNoAnswer) => captureRecordedRemoteTips(address, undefined, { onNoAnswer }), { warn: reason => { warned.push(reason); } });

  assert.ok((await ask(f.remote))?.length);
  assert.deepEqual([events(), warned], [[], []], 'an answer is no event');

  const none = await ask(join(f.root, 'missing.git'));
  assert.equal(none, null);
  assert.deepEqual(events().map(event => event.event), ['workspace_remote_unanswered']);
  const detail = JSON.parse(events()[0].detail);
  assert.deepEqual(Object.keys(detail).sort(), ['elapsed_ms', 'pause_ms', 'reason']);
  assert.ok(detail.reason.length > 0);
  assert.deepEqual(warned, [detail.reason], 'the warning is kept, with the same reason');
  assert.ok(Number.isInteger(detail.elapsed_ms) && detail.elapsed_ms >= 0 && detail.elapsed_ms < 20_000);
  assert.equal(detail.pause_ms, REMOTE_FAILURE_PAUSE_MS);

  // The turn that had no answer: the card is what it was before, the whole difference between the branches.
  const { workspace, old } = onOldBranch(f, 'agent');
  const result = await turn(workspace, old, () => {
    git(workspace, 'fetch', '-q', 'origin');
    git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
    commit(workspace, 'the fix', FIX);
  }, { tips: none });
  assert.equal(count(result.after), BRANCH_DIFFERENCES + 1);
  assertPlain(result);
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

test('under core.autocrlf the rule holds; a sparse checkout keeps the plain comparison', async t => {
  // The files on disk are not the committed bytes under core.autocrlf (CRLF on disk, LF in
  // HEAD), the default of Git for Windows. The captured trees hold text files as Git stores
  // them, so the pulled base is told from the agent's own CRLF edit all the same.
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
  assert.equal(count(result.before), STAGING_FILES + 1, 'the plain comparison counts every file staging gained');
  assert.deepEqual(listed(result.after), ['modified src/app.ts +1 -1']);
  assert.match(result.after.patch, /\+app 3 fixed\n/);
  assert.doesNotMatch(result.after.patch, /\r|module|from staging|handbook/);

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
  t.after(() => removeTestDirectory(directory));
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
