import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_GIT_OPTIONS, captureGitEnvironment, captureWorkspaceChanges } from '../../../../shared/workspace-change-capture.mjs';
import { captureWorkspaceHead, captureWorkspacePair, captureWorkspaceTree, releaseWorkspaceTree } from '../../../../shared/workspace-turn-capture.mjs';

// A capture runs as the owner, outside the sandbox of the agent whose work it observes,
// and that work can write the repository's configuration. Each test here puts a trap
// program in a setting, proves with a plain Git command that the trap is live, and then
// requires that the capture leaves it alone. The traps are POSIX scripts; the options
// that stop them are the same on every platform.
const posix = { skip: process.platform === 'win32' };
const quiet = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: quiet, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const attempt = (cwd: string, ...args: string[]) => { try { git(cwd, ...args); } catch { /* A trap may fail the command; that it ran is the point. */ } };

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'capture-programs-')));
  const traps = join(root, 'traps'); const programs = join(root, 'programs'); const repository = join(root, 'repository');
  for (const directory of [traps, programs, repository]) mkdirSync(directory);
  git(repository, 'init', '-q', '-b', 'main'); git(repository, 'config', 'user.name', 'Test'); git(repository, 'config', 'user.email', 'test@example.com');
  return {
    root, repository,
    /** A program that records that it ran, and then does `then`. */
    trap(name: string, then = '') {
      const path = join(programs, name);
      writeFileSync(path, `#!/bin/sh\ntouch "${join(traps, name)}"\n${then}\n`); chmodSync(path, 0o755);
      return path;
    },
    /** The traps that ran since the last call. */
    sprung() { const names = readdirSync(traps).sort(); for (const name of names) rmSync(join(traps, name)); return names; },
    remove() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('a turn capture never runs the file-system monitor program, a hook file or a configured hook of the repository', posix, async () => {
  const area = scratch();
  try {
    const { repository } = area;
    writeFileSync(join(repository, 'app.ts'), 'one\n'); git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'base');
    const base = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'config', 'core.fsmonitor', area.trap('fsmonitor'));
    for (const hook of ['post-index-change', 'reference-transaction']) {
      writeFileSync(join(repository, '.git/hooks', hook), `#!/bin/sh\nexec "${area.trap(`hook-${hook}`)}"\n`); chmodSync(join(repository, '.git/hooks', hook), 0o755);
    }
    // A hook that is configured, not a file (Git 2.54 and later): core.hooksPath does not stop it.
    git(repository, 'config', 'hook.trap.command', area.trap('configured-hook'));
    git(repository, 'config', 'hook.trap.event', 'reference-transaction'); git(repository, 'config', '--add', 'hook.trap.event', 'post-index-change');
    // The same with no name: a plain `[hook]` section. Apple Git 2.54 runs it; Git 2.56 does not.
    writeFileSync(join(repository, '.git/config'), `[hook]\n\tevent = reference-transaction\n\tevent = post-index-change\n\tcommand = ${area.trap('unnamed-hook')}\n`, { flag: 'a' });
    attempt(repository, 'status'); attempt(repository, 'update-ref', 'refs/heads/control', base);
    const [major, minor] = git(repository, '--version').match(/(\d+)\.(\d+)/)!.slice(1).map(Number);
    assert.deepEqual(area.sprung().filter(name => name !== 'unnamed-hook'), [...(major > 2 || minor >= 54 ? ['configured-hook'] : []), 'fsmonitor', 'hook-post-index-change',
      'hook-reference-transaction'], 'the traps are live for a plain Git command');

    const start = await captureWorkspaceTree(repository, 'turn');
    assert.ok(start);
    assert.equal(await captureWorkspaceHead(repository), base);
    writeFileSync(join(repository, 'app.ts'), 'one\ntwo\n'); writeFileSync(join(repository, 'new.ts'), 'new\n');
    const pair = await captureWorkspacePair(repository, base, start, 'turn', base, null);
    await releaseWorkspaceTree(repository, 'turn');
    assert.equal(pair.contribution.changes.state, 'ready');
    assert.deepEqual(pair.contribution.changes.files.map(file => file.path).sort(), ['app.ts', 'new.ts']);
    assert.match(pair.workspace.patch, /\+two/);
    assert.deepEqual(area.sprung(), []);
  } finally { area.remove(); }
});

test('a comparison with the working files never runs a filter program or a submodule\'s monitor program', posix, async () => {
  const area = scratch();
  try {
    const { repository, root } = area;
    const library = join(root, 'library'); mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main'); git(library, 'config', 'user.name', 'Test'); git(library, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(library, 'lib.txt'), 'lib\n'); git(library, 'add', '.'); git(library, 'commit', '-qm', 'library');
    git(repository, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'library');
    writeFileSync(join(repository, 'data.bin'), 'one\n'); writeFileSync(join(repository, 'notes.md'), 'one\n');
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'base');
    const base = git(repository, 'rev-parse', 'HEAD');
    writeFileSync(join(repository, '.gitattributes'), '*.bin filter=process\n*.md filter=clean\n');
    git(repository, 'config', 'filter.process.process', area.trap('filter-process'));
    git(repository, 'config', 'filter.clean.clean', area.trap('filter-clean', 'cat'));
    git(repository, 'config', 'filter.clean.required', 'true');
    git(join(repository, 'library'), 'config', 'core.fsmonitor', area.trap('submodule-fsmonitor'));
    // A filter that only the submodule's own configuration names; the change keeps the file's size.
    writeFileSync(join(repository, 'library/.gitattributes'), '*.txt filter=inner\n');
    git(join(repository, 'library'), 'config', 'filter.inner.clean', area.trap('submodule-filter', 'cat'));
    writeFileSync(join(repository, 'data.bin'), 'one\ntwo\n'); writeFileSync(join(repository, 'notes.md'), 'one\ntwo\n');
    writeFileSync(join(repository, 'library/lib.txt'), 'bil\n');
    for (const path of ['data.bin', 'notes.md', 'library']) attempt(repository, 'diff', 'HEAD', '--', path);
    assert.deepEqual(area.sprung(), ['filter-clean', 'filter-process', 'submodule-filter', 'submodule-fsmonitor'], 'the traps are live for a plain Git command');

    const snapshot = await captureWorkspaceChanges(repository, base);
    assert.equal(snapshot.state, 'ready');
    assert.match(snapshot.patch, /data\.bin[\s\S]*\+two/);
    assert.match(snapshot.patch, /notes\.md[\s\S]*\+two/);
    assert.deepEqual(area.sprung(), []);

    // `-c` ends a key at the first "=": a driver with one in its name cannot be switched off.
    writeFileSync(join(repository, '.gitattributes'), '*.md filter=a=b\n');
    git(repository, 'config', 'filter.a=b.clean', area.trap('filter-unnameable', 'cat'));
    attempt(repository, 'diff', 'HEAD', '--', 'notes.md');
    assert.deepEqual(area.sprung(), ['filter-unnameable'], 'the trap is live for a plain Git command');
    assert.equal((await captureWorkspaceChanges(repository, base)).state, 'unavailable');
    assert.equal(await captureWorkspaceTree(repository, 'unnameable'), null);
    assert.deepEqual(area.sprung(), []);
  } finally { area.remove(); }
});

test('a capture never asks a promisor remote for a missing object', posix, async () => {
  const area = scratch();
  try {
    const { repository, root } = area;
    writeFileSync(join(repository, 'app.ts'), 'one\n'); git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'base');
    const base = git(repository, 'rev-parse', 'HEAD'); const blob = git(repository, 'rev-parse', 'HEAD:app.ts');
    const start = await captureWorkspaceTree(repository, 'lazy');
    assert.ok(start);
    git(root, 'clone', '-q', '--bare', repository, join(root, 'remote.git'));
    git(repository, 'config', 'extensions.partialClone', 'origin'); git(repository, 'config', 'remote.origin.promisor', 'true');
    git(repository, 'config', 'remote.origin.url', join(root, 'remote.git'));
    git(repository, 'config', 'remote.origin.uploadpack', area.trap('upload-pack', 'exit 1'));
    rmSync(join(repository, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    attempt(repository, 'cat-file', '-p', blob);
    assert.deepEqual(area.sprung(), ['upload-pack'], 'the trap is live for a plain Git command');

    writeFileSync(join(repository, 'app.ts'), 'one\ntwo\n');
    const pair = await captureWorkspacePair(repository, base, start, 'lazy', base, null);
    await releaseWorkspaceTree(repository, 'lazy');
    assert.equal(pair.workspace.state, 'unavailable');
    assert.deepEqual(area.sprung(), []);
  } finally { area.remove(); }
});

test('the options of a capture command keep Git from giving a commit to the signature program', posix, () => {
  const area = scratch();
  try {
    const { repository } = area;
    writeFileSync(join(repository, 'app.ts'), 'one\n'); git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'base');
    // Anyone can write a commit with a signature header; no key is needed for Git to call the program.
    const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repository, encoding: 'utf8', env: quiet,
      input: git(repository, 'cat-file', 'commit', 'HEAD').replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQfake\n -----END PGP SIGNATURE-----\n\n') + '\n' }).trim();
    git(repository, 'config', 'gpg.program', area.trap('gpg', 'exit 1')); git(repository, 'config', 'log.showSignature', 'true');
    attempt(repository, 'show', '-s', '--format=%cI', signed);
    assert.deepEqual(area.sprung(), ['gpg'], 'the trap is live for a plain Git command');
    const shown = execFileSync('git', [...CAPTURE_GIT_OPTIONS, 'show', '-s', '--format=%cI', signed], { cwd: repository, encoding: 'utf8', env: captureGitEnvironment() });
    assert.match(shown, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(area.sprung(), []);
  } finally { area.remove(); }
});

test('a turn capture never runs a filter that only the committed attributes name', posix, async () => {
  const area = scratch();
  try {
    const { repository, root } = area;
    writeFileSync(join(repository, '.gitattributes'), '*.txt filter=committed\n'); writeFileSync(join(repository, 'notes.txt'), 'one\n');
    git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'base');
    // The user's index and the working files no longer have the attributes; HEAD still has
    // them, and the capture's private index starts from HEAD.
    git(repository, 'rm', '-q', '--cached', '.gitattributes'); rmSync(join(repository, '.gitattributes'));
    git(repository, 'config', 'core.autocrlf', 'true'); git(repository, 'config', 'filter.committed.clean', area.trap('filter-committed', 'cat'));
    writeFileSync(join(repository, 'notes.txt'), 'one\ntwo\n');
    const index = { ...quiet, GIT_INDEX_FILE: join(root, 'control-index') };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: repository, env: index });
    execFileSync('git', ['update-index', '--add', 'notes.txt'], { cwd: repository, env: index, stdio: 'ignore' });
    assert.deepEqual(area.sprung(), ['filter-committed'], 'the trap is live for a plain Git command');

    const tree = await captureWorkspaceTree(repository, 'committed');
    await releaseWorkspaceTree(repository, 'committed');
    assert.ok(tree);
    assert.deepEqual(area.sprung(), []);
  } finally { area.remove(); }
});

test('a comparison of two trees never starts a comparison inside a submodule', posix, async () => {
  const area = scratch();
  try {
    const { repository, root } = area;
    const library = join(root, 'library'); mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main'); git(library, 'config', 'user.name', 'Test'); git(library, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(library, 'lib.txt'), 'lib\n'); git(library, 'add', '.'); git(library, 'commit', '-qm', 'library');
    git(repository, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'library');
    git(repository, 'commit', '-qm', 'base');
    const base = git(repository, 'rev-parse', 'HEAD');
    // The turn takes the submodule out of the project and leaves its folder, ignored, in place.
    git(repository, 'rm', '-q', '--cached', 'library'); writeFileSync(join(repository, '.git/info/exclude'), 'library/\n');
    git(repository, 'commit', '-qam', 'no library');
    git(repository, 'config', 'diff.submodule', 'diff');
    git(join(repository, 'library'), 'config', 'diff.external', area.trap('submodule-external-diff'));
    attempt(repository, 'diff', base, 'HEAD');
    assert.deepEqual(area.sprung(), ['submodule-external-diff'], 'the trap is live for a plain Git command');

    // The comparison since the workspace started; a tree that holds a submodule gives a turn no start tree.
    const pair = await captureWorkspacePair(repository, base, null, 'inner');
    await releaseWorkspaceTree(repository, 'inner');
    assert.equal(pair.workspace.state, 'ready');
    assert.ok(pair.workspace.files.some(file => file.path === 'library' && file.status === 'deleted'));
    assert.deepEqual(area.sprung(), []);
  } finally { area.remove(); }
});
