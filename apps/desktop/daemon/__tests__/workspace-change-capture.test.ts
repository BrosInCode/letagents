import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureWorkspaceChanges } from '../workspace-change-capture.js';
import { parseRoomAgentWorkSummary } from '../../../../shared/room-agent-work.mjs';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('workspace review includes committed work, net staged edits, and untracked files without touching the index', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-review-'));
  try {
    git(directory, 'init', '-q');
    git(directory, 'config', 'user.name', 'Test');
    git(directory, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(directory, 'base.txt'), 'original\n');
    git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'base');
    const base = git(directory, 'rev-parse', 'HEAD');
    writeFileSync(join(directory, 'committed.txt'), 'committed work\n');
    git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'work');
    writeFileSync(join(directory, 'base.txt'), 'temporary staged text\n');
    git(directory, 'add', '.');
    writeFileSync(join(directory, 'base.txt'), 'original\n');
    writeFileSync(join(directory, 'new file.txt'), 'first\nsecond\n');
    const index = git(directory, 'diff', '--cached');
    const snapshot = await captureWorkspaceChanges(directory, base);
    assert.equal(snapshot.state, 'ready');
    assert.equal(snapshot.base_revision, base);
    assert.deepEqual(snapshot.files.map(file => file.path).sort(), ['committed.txt', 'new file.txt']);
    assert.equal(snapshot.additions, 3);
    assert.equal(snapshot.deletions, 0);
    assert.match(snapshot.patch, /\+committed work/);
    assert.match(snapshot.patch, /\+second/);
    assert.equal(git(directory, 'diff', '--cached'), index);
    const summary = { version: 2, recorded_state: 'completed', evidence_incomplete: false, elapsed_ms: 5,
      operation_counts: { unresolved: 0, succeeded: 1, failed: 0, denied_before_start: 0, cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0 }, workspace: snapshot };
    assert.deepEqual(parseRoomAgentWorkSummary(summary)?.workspace, snapshot);
    assert.equal(parseRoomAgentWorkSummary({ ...summary, workspace: { ...snapshot, host_path: directory } }), null);
    assert.equal(parseRoomAgentWorkSummary({ ...summary, version: 1 }), null, 'v1 does not silently accept source content');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unborn repos and symlinks produce review data without reading external targets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-review-'));
  const outside = join(tmpdir(), `workspace-review-secret-${Date.now()}`);
  try {
    git(directory, 'init', '-q');
    writeFileSync(join(directory, 'new.txt'), 'new work\n');
    writeFileSync(outside, 'OUTSIDE_CONTENT_MUST_NOT_BE_READ');
    symlinkSync(outside, join(directory, 'link'));
    const snapshot = await captureWorkspaceChanges(directory, null);
    assert.equal(snapshot.state, 'ready');
    assert.equal(snapshot.files.length, 2);
    assert.match(snapshot.patch, /\+new work/);
    assert.doesNotMatch(snapshot.patch, /OUTSIDE_CONTENT_MUST_NOT_BE_READ/);
    assert.equal((await captureWorkspaceChanges(directory, 'bad-ref')).state, 'unavailable');
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});
