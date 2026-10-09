import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureRecordedRemoteTips, captureRemoteTips } from '../../../../shared/workspace-turn-capture.mjs';
import { OWN, OWN_ROWS, STAGING_FILES, assertPlain, assertPlainRows, commit, count, fixture, git, listed, recorded, turn } from './fixtures/workspace-turns.js';

// What the capture takes for "upstream" is the answer of the remote that the daemon
// recorded, asked before the turn. Nothing that an agent can write locally changes
// that answer or what the capture reads from it.

test('the remote is asked for its branches, and local refs are not part of the answer', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  f.pushFeatureBranch();
  const landed = f.landOnStaging();
  git(f.team, 'checkout', '-q', '--detach');
  const tagged = commit(f.team, 'tagged only', { 'tagged.txt': 'tagged\n' });
  git(f.team, 'tag', 'v1'); git(f.team, 'push', '-q', 'origin', 'v1'); git(f.team, 'checkout', '-q', 'staging');
  commit(workspace, 'local only', { 'local.txt': 'local\n' });
  git(workspace, 'update-ref', 'refs/remotes/origin/invented', 'HEAD');
  const branches = git(f.remote, 'for-each-ref', '--format=%(objectname)', 'refs/heads/').split('\n').sort();
  assert.equal(git(f.remote, 'rev-parse', 'v1'), tagged);
  // The daemon asks the remote it recorded; an MCP worker asks the remotes its clone configures.
  for (const tips of [await captureRecordedRemoteTips(f.remote), await captureRemoteTips(workspace)]) {
    assert.deepEqual([...tips ?? []].sort(), branches);
    assert.equal(tips?.length, 3, 'staging, release and feature');
    assert.ok(tips?.includes(landed), 'the remote is read, not the stale local origin/staging');
    assert.ok(!tips?.includes(git(workspace, 'rev-parse', 'HEAD')));
    assert.ok(!tips?.includes(tagged), 'a tag on the remote is not a branch');
  }
  // No recorded remote (a room-only workspace, a project folder without an origin): no question, no answer.
  for (const none of [null, undefined, '']) assert.equal(await captureRecordedRemoteTips(none), null);
});

// An agent needs no push rights to make a repository of its own on this machine. It holds
// staging and one commit of the agent. The agent then makes the repository's configuration
// lead there, and merges the commit in a later turn.
const redirects: Record<string, (workspace: string, own: string, real: string, root: string) => string> = {
  'a second remote that points at it': (workspace, own) => { git(workspace, 'remote', 'add', 'mine', own); return 'mine'; },
  'origin pointed at it': (workspace, own) => { git(workspace, 'remote', 'set-url', 'origin', own); return 'origin'; },
  'a url.<its>.insteadOf rewrite of the real remote in the repository configuration': (workspace, own, real) => {
    git(workspace, 'config', `url.${own}.insteadOf`, real); return 'origin';
  },
  'the same rewrite in the worktree configuration': (workspace, own, real) => {
    git(workspace, 'config', 'extensions.worktreeConfig', 'true'); git(workspace, 'config', '--worktree', `url.${own}.insteadOf`, real); return 'origin';
  },
  'the same rewrite in an included file': (workspace, own, real, root) => {
    writeFileSync(join(root, 'rewrite.config'), `[url "${own}"]\n\tinsteadOf = ${real}\n`);
    git(workspace, 'config', 'include.path', join(root, 'rewrite.config')); return 'origin';
  },
};
for (const [name, redirect] of Object.entries(redirects)) {
  test(`the agent's own repository is never taken for the remote - ${name}`, async t => {
    const f = fixture(t);
    const workspace = f.clone();
    git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
    f.landOnStaging();
    const own = join(f.root, 'own.git'), builder = join(f.root, 'builder');
    git(f.root, 'clone', '-q', '--bare', f.remote, own); git(f.root, 'clone', '-q', own, builder);
    const smuggled = commit(builder, 'smuggled', OWN);
    git(builder, 'push', '-q', 'origin', 'HEAD:staging');
    const from = redirect(workspace, own, f.remote, f.root);
    const result = await turn(workspace, f.first, () => {
      git(workspace, 'fetch', '-q', from);
      git(workspace, 'merge', '-q', '--no-edit', `${from}/staging`);
    });
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), smuggled);
    assert.ok((await captureRemoteTips(workspace))?.includes(smuggled), 'the repository\'s own configuration leads to the agent\'s repository');
    assert.ok(result.tips?.length && !result.tips.includes(smuggled), 'the recorded remote was asked, and it does not hold the commit');
    // The daemon starts Git somewhere else. Even started inside the agent's repository, Git takes no word from it.
    assert.deepEqual(await captureRecordedRemoteTips(f.remote, workspace), result.tips);
    assert.equal(count(result.before), STAGING_FILES + 2);
    assert.deepEqual(listed(result.after), OWN_ROWS, 'what really landed on staging is the base; the agent\'s commit is not');
  });
}

test('when the owner\'s own Git configuration sends the recorded address elsewhere, there is no answer', async t => {
  const f = fixture(t);
  const own = join(f.root, 'own.git');
  git(f.root, 'clone', '-q', '--bare', f.remote, own);
  const home = mkdtempSync(join(tmpdir(), 'workspace-base-update-home-'));
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const restore = () => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  t.after(() => { restore(); rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home; process.env.XDG_CONFIG_HOME = join(home, '.config');
  const configure = (text: string) => writeFileSync(join(home, '.gitconfig'), text);

  configure(`[url "${own}"]\n\tinsteadOf = ${join(f.root, 'another.git')}\n`);
  assert.equal((await captureRecordedRemoteTips(f.remote))?.length, 1, 'the owner\'s configuration applies, and this rule is about another address');
  configure(`[url "${own}"]\n\tinsteadOf = ${f.remote}\n`);
  assert.equal(await captureRecordedRemoteTips(f.remote), null, 'a rewrite of the recorded address');
  configure(`[remote "file://${f.remote}"]\n\turl = ${own}\n`);
  assert.equal(await captureRecordedRemoteTips(`file://${f.remote}`), null, 'a remote that is named like the recorded address');
  configure('');
  assert.equal((await captureRecordedRemoteTips(`file://${f.remote}`))?.length, 1);
  restore();
});

// Git can be told to read one object in the place of another (`git replace`), and to
// give a commit other parents (a grafts file, a shallow file). All of it is local, and
// none of it may take the agent's commit off the card.
test('a replace ref on the base that the turn merged does not hide the agent\'s commit', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  f.landOnStaging();
  const result = await turn(workspace, f.first, () => {
    git(workspace, 'fetch', '-q', 'origin'); git(workspace, 'merge', '-q', '--no-edit', 'origin/staging');
    commit(workspace, 'own work', OWN);
    // A commit with the final files, put in the place of the real staging commit.
    const fake = git(workspace, 'commit-tree', 'HEAD^{tree}', '-p', 'origin/staging^', '-m', 'fake');
    git(workspace, 'replace', 'origin/staging', fake);
  });
  assert.equal(git(workspace, 'diff', '--name-only', 'origin/staging', 'HEAD'), '', 'with the replace ref, Git itself sees no difference');
  assert.equal(count(result.before), STAGING_FILES + 2);
  assert.deepEqual(listed(result.after), OWN_ROWS);
});

test('a replace ref on a teammate\'s branch that was merged without its content does not hide the agent\'s commit', async t => {
  const f = fixture(t);
  const feature = f.pushFeatureBranch();
  const workspace = f.clone();
  git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  const result = await turn(workspace, f.first, () => {
    commit(workspace, 'own work', OWN);
    git(workspace, 'merge', '-q', '--no-edit', '-s', 'ours', 'origin/feature');
    const fake = git(workspace, 'commit-tree', 'HEAD^{tree}', '-p', f.first, '-m', 'fake');
    git(workspace, 'replace', feature, fake);
  });
  assert.ok(result.tips?.includes(feature));
  assertPlainRows(result, OWN_ROWS);
  // The teammate's branch is in the history without its file: the turn dropped it, and that shows too.
  assert.deepEqual(listed(result.after), ['added src/fix.ts +2 -0', 'deleted src/feature.ts +0 -7', 'modified src/app.ts +1 -1']);
});

test('a replace ref on the start snapshot does not empty the plain comparison either', async t => {
  const f = fixture(t);
  const workspace = f.clone();
  const result = await turn(workspace, f.first, () => {
    commit(workspace, 'own work', OWN);
    // The start snapshot is a tree under a ref that the agent can read.
    const start = git(workspace, 'for-each-ref', '--format=%(objectname)', 'refs/letagents/workspace-review/');
    assert.match(start, /^[a-f0-9]{40}$/);
    git(workspace, 'replace', start, git(workspace, 'rev-parse', 'HEAD^{tree}'));
  });
  assertPlainRows(result, OWN_ROWS);
  assert.deepEqual(listed(result.after), OWN_ROWS);
});

test('a grafts file or a shallow file changes only which commits look related, never what a tree holds', async t => {
  const f = fixture(t);
  const feature = f.pushFeatureBranch();
  const grafted = f.clone('grafted');
  const cut = f.clone('cut');
  const landed = f.landOnStaging();
  for (const workspace of [grafted, cut]) git(workspace, 'checkout', '-q', '-b', 'fix/own', 'origin/staging');
  // A teammate's branch becomes a parent of the agent's commit, on paper.
  const graft = await turn(grafted, f.first, () => {
    git(grafted, 'fetch', '-q', 'origin');
    const own = commit(grafted, 'own work', OWN);
    writeFileSync(join(grafted, '.git/info/grafts'), `${own} ${f.first} ${feature}\n`);
  });
  for (const row of OWN_ROWS) assert.ok(listed(graft.after).includes(row), row);
  // The base that was merged has no parents any more, on paper.
  const shallow = await turn(cut, f.first, () => {
    git(cut, 'fetch', '-q', 'origin'); git(cut, 'merge', '-q', '--no-edit', 'origin/staging');
    commit(cut, 'own work', OWN);
    writeFileSync(join(cut, '.git/shallow'), `${landed}\n`);
  });
  for (const row of OWN_ROWS) assert.ok(listed(shallow.after).includes(row), row);
});

test('the question cannot prompt, and a transport that hangs does not outlive it', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const workspace = f.clone();
  git(workspace, 'remote', 'set-url', 'origin', 'ssh://git.example.invalid/team/project');
  // An "ssh" that writes down how it was started and then hangs. Nothing here uses the network.
  const ssh = join(f.root, 'bin', 'ssh'), seen = join(f.root, 'seen');
  mkdirSync(dirname(ssh)); mkdirSync(seen);
  writeFileSync(ssh, `#!/bin/sh\n{ echo "arguments=$*"; echo "terminal=$GIT_TERMINAL_PROMPT"; echo "askpass=[$GIT_ASKPASS][$SSH_ASKPASS][$SSH_ASKPASS_REQUIRE]"; echo "manager=$GCM_INTERACTIVE"; } > "${seen}/$$"\nexec sleep 45\n`, { mode: 0o755 });
  const saved = process.env.GIT_SSH_COMMAND;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const started: number[] = [];
  t.after(() => { if (saved === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = saved; for (const pid of started) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  process.env.GIT_SSH_COMMAND = ssh;
  const begun = Date.now();
  assert.deepEqual(await Promise.all([captureRecordedRemoteTips('ssh://git.example.invalid/team/project'), captureRemoteTips(workspace)]), [null, null]);
  assert.ok(Date.now() - begun < 7_500);
  const runs = readdirSync(seen);
  assert.equal(runs.length, 2, 'the daemon\'s question and the MCP worker\'s question each started the transport');
  for (const run of runs) {
    started.push(Number(run));
    const record = readFileSync(join(seen, run), 'utf8');
    assert.match(record, /^arguments=-o BatchMode=yes -o ConnectTimeout=5 .*git\.example\.invalid/m);
    assert.match(record, /^terminal=0$/m);
    assert.match(record, /^askpass=\[\]\[\]\[never\]$/m);
    assert.match(record, /^manager=never$/m);
  }
  await new Promise(done => setTimeout(done, 300));
  assert.deepEqual(started.filter(alive), [], 'the transport died with the question');
});

test('a remote that does not answer in time gives no answer and delays nothing', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const workspace = f.clone();
  f.landOnStaging();
  // A server that accepts the connection and never says anything, and a transport that only sleeps.
  const sockets: Socket[] = [];
  const silent = createServer(socket => { sockets.push(socket); }).listen(0, '127.0.0.1');
  await once(silent, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); silent.close(); });
  git(workspace, 'config', 'protocol.ext.allow', 'always');
  git(workspace, 'remote', 'add', 'slow', 'ext::sleep 8');
  const started = Date.now();
  const pending = [captureRecordedRemoteTips(`git://127.0.0.1:${(silent.address() as AddressInfo).port}/repository`), captureRemoteTips(workspace)];
  assert.ok(Date.now() - started < 1_000, 'the question is asked without waiting for the answer');
  assert.deepEqual(await Promise.all(pending), [null, null]);
  const waited = Date.now() - started;
  assert.ok(waited >= 4_000 && waited < 7_500, `five seconds in total, waited ${waited} ms`);
  assert.equal(sockets.length, 1, 'the recorded remote was really asked');
  recorded.set(workspace, `git://127.0.0.1:${(silent.address() as AddressInfo).port}/repository`);
  const result = await turn(workspace, f.first, () => { git(workspace, 'pull', '-q', '--ff-only', 'origin', 'staging'); commit(workspace, 'own work', OWN); });
  assert.equal(result.tips, null);
  assertPlain(result);
});
