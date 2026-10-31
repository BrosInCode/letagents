import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { OWN, OWN_ROWS, STAGING_FILES, assertPlain, commit, count, fixture, git, lines, listed, turn } from './fixtures/workspace-turns.js';

// The card may show too much, but it must never hide a change the agent made.
// The agent commits two files in the turn. Whatever happens to the remote and to
// local refs afterwards, the two files stay on the card.
const afterTheCommit: Record<string, (f: ReturnType<typeof fixture>, workspace: string) => string[]> = {
  'a: another session pushes onto the pushed branch, then a fetch': (f, workspace) => {
    git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
    git(f.team, 'fetch', '-q', 'origin'); git(f.team, 'checkout', '-q', '-b', 'fix/own', 'origin/fix/own');
    commit(f.team, 'update branch', { 'bot.txt': 'bot\n' });
    git(f.team, 'push', '-q', 'origin', 'fix/own'); git(f.team, 'checkout', '-q', 'staging');
    git(workspace, 'fetch', '-q', 'origin');
    assert.notEqual(git(workspace, 'rev-parse', 'origin/fix/own'), git(workspace, 'rev-parse', 'HEAD'));
    return [];
  },
  'a, daemon layout: the fetch comes from another agent\'s worktree of the same repository': (f, workspace) => {
    git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
    git(f.team, 'fetch', '-q', 'origin'); git(f.team, 'checkout', '-q', '-b', 'fix/own', 'origin/fix/own');
    commit(f.team, 'update branch', { 'bot.txt': 'bot\n' });
    git(f.team, 'push', '-q', 'origin', 'fix/own'); git(f.team, 'checkout', '-q', 'staging');
    const other = join(f.root, 'other-agent');
    git(workspace, 'worktree', 'add', '-q', '--detach', other, f.first);
    git(other, 'fetch', '-q', 'origin');
    return [];
  },
  'b: a push to staging, a teammate lands, then a fetch': (f, workspace) => {
    git(workspace, 'push', '-q', 'origin', 'HEAD:staging');
    f.land('teammate', { 'teammate.txt': 'teammate\n' });
    git(workspace, 'fetch', '-q', 'origin');
    return [];
  },
  'c: as b, then a rebase pull, a second commit and a push': (f, workspace) => {
    git(workspace, 'push', '-q', 'origin', 'HEAD:staging');
    f.land('teammate', { 'teammate.txt': 'teammate\n' });
    git(workspace, 'pull', '-q', '--rebase', 'origin', 'staging');
    commit(workspace, 'second', { 'src/second.ts': lines(3, 'second') });
    git(workspace, 'push', '-q', 'origin', 'HEAD:staging');
    return ['added src/second.ts +3 -0', 'added teammate.txt +1 -0'];
  },
  'd: the pull request is merged with a merge commit, then a fetch': (f, workspace) => {
    git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
    git(f.team, 'pull', '-q', '--ff-only', 'origin', 'staging'); git(f.team, 'fetch', '-q', 'origin');
    git(f.team, 'merge', '-q', '--no-ff', '--no-edit', 'origin/fix/own'); git(f.team, 'push', '-q', 'origin', 'staging');
    git(workspace, 'fetch', '-q', 'origin');
    return [];
  },
  'e: the pull request is squash-merged, then staging is checked out and pulled': (f, workspace) => {
    git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
    git(f.team, 'pull', '-q', '--ff-only', 'origin', 'staging'); git(f.team, 'fetch', '-q', 'origin');
    git(f.team, 'merge', '-q', '--squash', 'origin/fix/own'); git(f.team, 'commit', '-q', '-m', 'squash'); git(f.team, 'push', '-q', 'origin', 'staging');
    git(workspace, 'checkout', '-q', 'staging'); git(workspace, 'pull', '-q', '--ff-only');
    return [];
  },
  'f: a push by URL, then a fetch': (f, workspace) => {
    git(workspace, 'push', '-q', f.remote, 'fix/own');
    git(workspace, 'fetch', '-q', 'origin');
    assert.equal(git(workspace, 'rev-parse', 'origin/fix/own'), git(workspace, 'rev-parse', 'HEAD'));
    return [];
  },
  'g: a push, then a fetch of a second remote of the same repository': (f, workspace) => {
    git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
    git(workspace, 'remote', 'add', 'mirror', f.remote); git(workspace, 'fetch', '-q', 'mirror');
    assert.equal(git(workspace, 'rev-parse', 'mirror/fix/own'), git(workspace, 'rev-parse', 'HEAD'));
    return [];
  },
  'hostile: a remote-tracking ref is written by hand': (_f, workspace) => {
    git(workspace, 'update-ref', 'refs/remotes/origin/staging', 'HEAD');
    git(workspace, 'update-ref', 'refs/remotes/origin/x', 'HEAD');
    return [];
  },
  'hostile: every reflog is expired after a push': (_f, workspace) => {
    git(workspace, 'push', '-q', '-u', 'origin', 'fix/own');
    git(workspace, 'reflog', 'expire', '--expire=now', '--all');
    return [];
  },
  'hostile: a push to a fork remote, its tracking ref deleted, then a fetch from the fork': (_f, workspace) => {
    git(workspace, 'push', '-q', 'fork', 'HEAD:refs/heads/x');
    git(workspace, 'update-ref', '-d', 'refs/remotes/fork/x');
    git(workspace, 'fetch', '-q', 'fork');
    assert.equal(git(workspace, 'rev-parse', 'fork/x'), git(workspace, 'rev-parse', 'HEAD'));
    return [];
  },
};
for (const [name, afterCommit] of Object.entries(afterTheCommit)) for (const baseUpdate of [false, true]) {
  test(`the agent's commit stays on the card${baseUpdate ? ' next to a base update' : ''} - ${name}`, async t => {
    const f = fixture(t);
    const workspace = f.clone();
    git(f.root, 'clone', '-q', '--bare', f.remote, join(f.root, 'fork.git'));
    git(workspace, 'remote', 'add', 'fork', join(f.root, 'fork.git'));
    git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
    if (baseUpdate) f.landOnStaging();
    let others: string[] = [];
    const result = await turn(workspace, f.first, () => {
      if (baseUpdate) { git(workspace, 'fetch', '-q', 'origin'); git(workspace, 'merge', '-q', '--no-edit', 'origin/staging'); }
      commit(workspace, 'own work', OWN);
      others = afterCommit(f, workspace);
    });
    // Work that a teammate landed during the turn is counted too. That is the safe direction.
    assert.deepEqual(listed(result.after), [...OWN_ROWS, ...others].sort());
    if (baseUpdate) assert.equal(count(result.before), STAGING_FILES + 2 + others.length);
    else assertPlain(result);
  });
}
