import assert from 'node:assert/strict';
import { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasReviewableRoomContribution } from '../../../../../shared/room-agent-work.mjs';
import { captureRecordedRemoteTips, captureWorkspaceHead, captureWorkspacePair, captureWorkspaceTree, releaseWorkspaceTree } from '../../../../../shared/workspace-turn-capture.mjs';

// Real repositories for the tests of what a change card counts: a bare remote with a
// `staging` branch, a teammate who lands work on it, and agent workspaces whose turns
// are captured as the daemon captures them.

export type Files = Record<string, string | Buffer | null>;
export const lines = (count: number, label = 'line') => Array.from({ length: count }, (_, index) => `${label} ${index + 1}\n`).join('');
// Fixture commands ignore the developer's own Git configuration (signing, hooks, pull strategy).
export const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.invalid' };
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function write(directory: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(directory, path);
    if (content === null) { rmSync(absolute); continue; }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}
export function commit(directory: string, message: string, files: Files) {
  write(directory, files);
  git(directory, 'add', '-A'); git(directory, 'commit', '-q', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

/** The remote the daemon recorded for each workspace when it provisioned it. Nothing in a workspace changes it. */
export const recorded = new Map<string, string>();

/** A bare remote with a `staging` branch, a teammate's clone that lands work on it, and agent workspaces. */
export function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-base-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'staging', remote);
  const team = join(root, 'team');
  git(root, 'clone', '-q', remote, team);
  git(team, 'checkout', '-q', '-B', 'staging');
  const first = commit(team, 'first', { 'README.md': lines(3, 'readme'), 'src/app.ts': lines(5, 'app'), 'src/shared.ts': lines(6, 'shared'),
    'src/old-name.ts': lines(8, 'rename me'), 'src/remove-me.ts': lines(2, 'remove'), 'src/legacy.ts': lines(4, 'legacy'), 'docs/guide.md': lines(9, 'guide') });
  git(team, 'push', '-q', 'origin', 'staging');
  /** A teammate lands one commit on staging. */
  const land = (message: string, files: Files) => {
    git(team, 'pull', '-q', '--ff-only', 'origin', 'staging');
    const landed = commit(team, message, files);
    git(team, 'push', '-q', 'origin', 'staging');
    return landed;
  };
  return {
    root, remote, team, first, land,
    /** A teammate publishes a branch that is not merged into staging. */
    pushFeatureBranch() {
      git(team, 'checkout', '-q', '-b', 'feature', first);
      const feature = commit(team, 'feature', { 'src/feature.ts': lines(7, 'feature') });
      git(team, 'push', '-q', 'origin', 'feature'); git(team, 'checkout', '-q', 'staging');
      return feature;
    },
    /** A normal clone, as an independent MCP agent has. */
    clone(name = 'agent') {
      const workspace = join(root, name);
      git(root, 'clone', '-q', remote, workspace);
      recorded.set(workspace, remote);
      return workspace;
    },
    /** The supervisor daemon's layout: a bare repository and a detached worktree at a fixed commit. */
    detachedWorktree(revision: string, name = 'daemon') {
      const bare = join(root, `${name}.git`);
      const workspace = join(root, name);
      git(root, 'clone', '-q', '--bare', '--no-local', remote, bare);
      git(bare, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
      git(bare, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', bare, '+refs/heads/*:refs/remotes/origin/*');
      git(bare, 'worktree', 'add', '-q', '--detach', workspace, revision);
      recorded.set(workspace, remote);
      return workspace;
    },
    /**
     * Other sessions' work lands on staging in two commits: 16 files (12 added, 2 edited,
     * 1 deleted, 1 renamed). A `release` branch stays on the first of the two commits.
     */
    landOnStaging() {
      land('another session', Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`lib/module-${String(index + 1).padStart(2, '0')}.ts`, lines(3, `module ${index + 1}`)])));
      git(team, 'push', '-q', 'origin', 'HEAD:refs/heads/release');
      git(team, 'mv', 'docs/guide.md', 'docs/handbook.md');
      return land('a third session', { 'README.md': lines(3, 'readme').replace('readme 2', 'readme 2 from staging'),
        'src/shared.ts': lines(6, 'shared').replace('shared 1', 'shared 1 from staging'), 'src/legacy.ts': null });
    },
  };
}
export const STAGING_FILES = 16;
export const OWN = { 'src/app.ts': lines(5, 'app').replace('app 3', 'app 3 fixed'), 'src/fix.ts': lines(2, 'fix') };
export const OWN_ROWS = ['added src/fix.ts +2 -0', 'modified src/app.ts +1 -1'];

export type Changes = Awaited<ReturnType<typeof captureWorkspacePair>>['workspace'];
export const count = (changes: Changes) => changes.files.length + changes.hidden_files;
export const listed = (changes: Changes) => changes.files.map(file => `${file.status} ${file.path} +${file.additions} -${file.deletions}`).sort();
export const timeless = (changes: Changes) => ({ ...changes, captured_at: '' });
export const card = (changes: Changes) => hasReviewableRoomContribution({ version: 3, recorded_state: 'completed', evidence_incomplete: false, elapsed_ms: null,
  operation_counts: { unresolved: 0, succeeded: 0, failed: 0, denied_before_start: 0, cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0 },
  workspace: changes, contribution: { changes, summary: null } });

/**
 * One turn, as the daemon captures it. The recorded remote is asked for its
 * branches before the work, with a real `git ls-remote`. The turn is then captured
 * twice: `before` is the plain tree comparison every card used, `after` also knows
 * the starting commit and the remote's answer. `evidence` replaces what the
 * capture is told.
 */
export async function turn(workspace: string, startingRevision: string, work: () => void | Promise<void>,
  evidence: { head?: string | null; tips?: string[] | null | Promise<string[] | null> } = {}) {
  const identity = randomUUID();
  const tips = await captureRecordedRemoteTips(recorded.get(workspace));
  const baseline = await captureWorkspaceTree(workspace, identity);
  assert.ok(baseline);
  const head = await captureWorkspaceHead(workspace);
  assert.ok(head);
  await work();
  const plain = await captureWorkspacePair(workspace, startingRevision, baseline, identity);
  const own = await captureWorkspacePair(workspace, startingRevision, baseline, identity,
    'head' in evidence ? evidence.head : head, 'tips' in evidence ? evidence.tips : tips);
  await releaseWorkspaceTree(workspace, identity);
  // Changes since the workspace started are the plain comparison, whatever the turn did.
  assert.deepEqual(timeless(own.workspace), timeless(plain.workspace));
  assert.deepEqual(timeless(own.review.workspace), timeless(plain.review.workspace));
  assert.deepEqual(listed(own.review.contribution), listed(own.contribution.changes));
  return { before: plain.contribution.changes, after: own.contribution.changes, tips };
}
/** The card is byte for byte the one from before: same files, counts and patch. */
export const assertPlain = (result: Awaited<ReturnType<typeof turn>>) => assert.deepEqual(timeless(result.after), timeless(result.before));
export const assertPlainRows = (result: Awaited<ReturnType<typeof turn>>, rows: string[]) => assert.deepEqual(listed(result.before), rows);
