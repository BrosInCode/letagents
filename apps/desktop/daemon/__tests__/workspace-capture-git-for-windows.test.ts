import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { captureWorkspaceChanges } from '../../../../shared/workspace-change-capture.mjs';
import { captureWorkspacePair, captureWorkspaceTree, escapesWorkspace, releaseWorkspaceTree } from '../../../../shared/workspace-turn-capture.mjs';

// A Git for Windows checkout stores files differently from what is on disk: text files
// have CRLF on disk and LF in HEAD (core.autocrlf), no file has an exec bit
// (core.fileMode=false) and a symlink is a plain file holding its target
// (core.symlinks=false). There is no Windows machine in CI, so each test sets the same
// configuration in a temporary repository here and checks that the captured tree is what
// `git add` would store: an untouched file keeps HEAD's blob and mode, and a changed file
// is stored converted. The capture must still never run a clean filter.

const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const pointer = (content: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(content)}\nsize ${Buffer.byteLength(content)}\n`;

/** A repository with `files` committed, then `config` set and the files checked out again under it. */
function repo(t: TestContext, files: Record<string, string | Buffer>, config: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-git-for-windows-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(directory, path), content);
  git(directory, 'add', '-A'); git(directory, 'commit', '-qm', 'base');
  for (const [key, value] of Object.entries(config)) git(directory, 'config', key, value);
  // Check the files out again so that the working tree is what Git for Windows would write.
  git(directory, 'rm', '-rq', '--cached', '.'); git(directory, 'reset', '-q', '--hard');
  const head = git(directory, 'rev-parse', 'HEAD');
  const tree = git(directory, 'rev-parse', 'HEAD^{tree}');
  const index = readFileSync(join(directory, '.git/index'));
  const blob = (captured: string, path: string) => execFileSync('git', ['cat-file', 'blob', `${captured}:${path}`], { cwd: directory, env: environment }).toString('utf8');
  const mode = (captured: string, path: string) => git(directory, 'ls-tree', captured, '--', path).split(' ')[0];
  const capture = async (identity: string) => { const captured = await captureWorkspaceTree(directory, identity); assert.ok(captured, `${identity}: a complete baseline`); return captured; };
  return { directory, head, tree, index, blob, mode, capture };
}

test('text files under line-ending conversion are stored as git add stores them', async t => {
  const cases = [
    { name: 'core.autocrlf=true (Git for Windows default)', config: { 'core.autocrlf': 'true' } },
    { name: 'core.autocrlf=input', config: { 'core.autocrlf': 'input' } },
    { name: 'text=auto with core.eol=crlf', config: { 'core.eol': 'crlf' }, attributes: '* text=auto\n' },
    { name: 'eol=crlf attribute', config: {}, attributes: '*.txt eol=crlf\n' },
  ];
  for (const { name, config, attributes } of cases) {
    const files: Record<string, string | Buffer> = { 'text.txt': 'one\ntwo\n', 'binary.dat': Buffer.from([0x78, 0x00, 0x79, 0x0a]), ...(attributes ? { '.gitattributes': attributes } : {}) };
    const f = repo(t, files, config);
    const onDisk = readFileSync(join(f.directory, 'text.txt'), 'utf8');
    const converted = name.includes('input') ? onDisk === 'one\ntwo\n' : onDisk === 'one\r\ntwo\r\n';
    assert.ok(converted, `${name}: the checkout differs from HEAD as it would on Windows`);
    // Nothing changed: the captured tree is HEAD's tree, whatever the bytes on disk are.
    assert.equal(await f.capture(`${name} untouched`), f.tree, `${name}: an untouched checkout is HEAD's tree`);
    // The same edit a Windows editor makes, with CRLF, is stored with LF like `git add` would.
    writeFileSync(join(f.directory, 'text.txt'), name.includes('input') ? 'one\ntwo\nthree\n' : 'one\r\ntwo\r\nthree\r\n');
    writeFileSync(join(f.directory, 'binary.dat'), Buffer.from([0x78, 0x00, 0x79, 0x0d, 0x0a]));
    const settled = await f.capture(`${name} edited`);
    assert.equal(f.blob(settled, 'text.txt'), 'one\ntwo\nthree\n', `${name}: the edited text file is stored with LF`);
    assert.deepEqual(f.blob(settled, 'binary.dat'), 'x\0y\r\n', `${name}: binary bytes are stored as they are`);
    assert.equal(git(f.directory, 'diff', '--name-only', f.tree, settled), 'binary.dat\ntext.txt', `${name}: only the edited files differ`);
    assert.deepEqual(readFileSync(join(f.directory, '.git/index')), f.index, `${name}: the index is untouched`);
    for (const identity of [`${name} untouched`, `${name} edited`]) await releaseWorkspaceTree(f.directory, identity);
  }
});

test('files Git itself would leave alone under core.autocrlf stay HEAD\'s blob', async t => {
  // `git add` converts a file only when its indexed blob has no CR: a .bat committed with
  // CRLF stays CRLF. A file with mixed endings is stored converted, and core.safecrlf=true
  // (which makes `git add` refuse it) does not make the capture fail.
  const f = repo(t, { 'build.bat': 'echo one\r\necho two\r\n', 'plain.txt': 'one\ntwo\n', 'mixed.txt': 'x\n' }, { 'core.autocrlf': 'true', 'core.safecrlf': 'true' });
  assert.equal(git(f.directory, 'status', '--short'), '', 'Git itself sees the checkout as clean');
  assert.equal(await f.capture('crlf in head'), f.tree, 'a CRLF-committed file is unchanged');
  writeFileSync(join(f.directory, 'build.bat'), 'echo one\r\necho three\r\n');
  writeFileSync(join(f.directory, 'mixed.txt'), 'x\r\ny\n');
  // Windows itself refuses control characters in a file name, so that path exists only elsewhere.
  const oddName = process.platform === 'win32' ? null : 'new line\nin name.txt';
  if (oddName) writeFileSync(join(f.directory, oddName), 'odd\r\n');
  const settled = await f.capture('crlf edited');
  assert.equal(f.blob(settled, 'build.bat'), 'echo one\r\necho three\r\n', 'stays CRLF, as git add keeps it');
  assert.equal(f.blob(settled, 'mixed.txt'), 'x\ny\n', 'mixed endings are stored converted; safecrlf does not stop the capture');
  if (oddName) assert.equal(f.blob(settled, oddName), 'odd\n', 'a path with a newline is converted too');
  for (const identity of ['crlf in head', 'crlf edited']) await releaseWorkspaceTree(f.directory, identity);
});

test('ident, working-tree-encoding and the old crlf attribute are Git\'s conversions too', async t => {
  const cases = [
    { name: 'ident', attributes: '*.c ident\n', files: { 'a.c': '/* $Id$ */\n' }, onDisk: (text: string) => /\$Id: [0-9a-f]{40} \$/.test(text) },
    // `text` with no core.eol writes the platform's native ending: LF here, CRLF on Windows.
    { name: 'working-tree-encoding', attributes: '*.ps1 text working-tree-encoding=UTF-16LE\n', files: { 'a.ps1': Buffer.from('Write-Host hi\n', 'utf16le') }, onDisk: (text: string) => text.replace(/\r\n/g, '\n') === 'Write-Host hi\n' },
    { name: 'crlf (old name of text)', attributes: '*.txt crlf\n', config: { 'core.eol': 'crlf' }, files: { 'a.txt': 'one\ntwo\n' }, onDisk: (text: string) => text === 'one\r\ntwo\r\n' },
  ];
  for (const { name, attributes, config, files, onDisk } of cases) {
    const f = repo(t, { '.gitattributes': attributes, ...files }, config);
    const [path] = Object.keys(files);
    assert.ok(onDisk(readFileSync(join(f.directory, path), name.startsWith('working') ? 'utf16le' : 'utf8')), `${name}: Git converted the checkout`);
    assert.equal(await f.capture(name), f.tree, `${name}: an untouched checkout is HEAD's tree`);
    if (name.startsWith('working')) assert.equal(f.blob(f.tree, path), 'Write-Host hi\n', 'HEAD holds UTF-8');
    await releaseWorkspaceTree(f.directory, name);
  }
});

test('a turn under core.autocrlf shows the turn\'s own edit and no line-ending noise', async t => {
  const f = repo(t, { 'app.ts': 'line 1\nline 2\nline 3\n', 'other.ts': 'other\n' }, { 'core.autocrlf': 'true' });
  const baseline = await f.capture('turn');
  writeFileSync(join(f.directory, 'app.ts'), 'line 1\r\nline 2 changed\r\nline 3\r\n');
  const pair = await captureWorkspacePair(f.directory, f.head, baseline, 'turn');
  await releaseWorkspaceTree(f.directory, 'turn');
  assert.equal(pair.contribution.changes.state, 'ready');
  assert.deepEqual(pair.contribution.changes.files.map(file => `${file.status} ${file.path} +${file.additions} -${file.deletions}`), ['modified app.ts +1 -1']);
  assert.match(pair.contribution.changes.patch, /-line 2\n\+line 2 changed\n/);
  assert.doesNotMatch(pair.contribution.changes.patch, /\r/);
  assert.deepEqual(pair.workspace.files.map(file => file.path), ['app.ts'], 'the whole-workspace view does not list every text file either');
});

test('an LFS file is stored as its pointer without running the clean filter', async t => {
  const f = repo(t, { '.gitattributes': '*.bin filter=lfs -text\n', 'model.bin': pointer('real content'), 'notes.txt': 'notes\n' }, { 'core.autocrlf': 'true' });
  // What `git lfs` leaves after a checkout: the real bytes on disk, the pointer in HEAD.
  // The configured clean filter is a sentinel: the capture must never run it.
  git(f.directory, 'config', 'filter.lfs.clean', 'touch FILTER_EXECUTED; cat');
  git(f.directory, 'config', 'filter.lfs.required', 'true');
  writeFileSync(join(f.directory, 'model.bin'), 'real content');
  assert.equal(await f.capture('lfs untouched'), f.tree, 'a smudged LFS file that matches its pointer is unchanged');
  writeFileSync(join(f.directory, 'model.bin'), 'other content');
  const settled = await f.capture('lfs edited');
  assert.equal(f.blob(settled, 'model.bin'), pointer('other content'), 'a changed LFS file is stored as the pointer git-lfs would write');
  // A clone without git-lfs keeps the pointer on disk; it is stored as it is.
  writeFileSync(join(f.directory, 'model.bin'), pointer('real content'));
  assert.equal(await f.capture('lfs pointer on disk'), f.tree);
  // git-lfs stores an empty file as an empty blob, not as a pointer.
  writeFileSync(join(f.directory, 'empty.bin'), '');
  const withEmpty = await f.capture('lfs empty');
  assert.equal(f.blob(withEmpty, 'empty.bin'), '');
  assert.equal(existsSync(join(f.directory, 'FILTER_EXECUTED')), false, 'no clean filter ran');
  for (const identity of ['lfs untouched', 'lfs edited', 'lfs pointer on disk', 'lfs empty']) await releaseWorkspaceTree(f.directory, identity);
});

test('a file with another clean filter is stored raw and the filter never runs', async t => {
  const f = repo(t, { '.gitattributes': '*.ipynb filter=strip\n', 'a.ipynb': 'cells\n' }, { 'core.autocrlf': 'true' });
  // Configured after the checkout: Git's own reset refreshes the index through the clean filter.
  git(f.directory, 'config', 'filter.strip.clean', 'touch FILTER_EXECUTED; cat');
  writeFileSync(join(f.directory, 'a.ipynb'), 'cells\r\n');
  const settled = await f.capture('other filter');
  assert.equal(f.blob(settled, 'a.ipynb'), 'cells\r\n', 'raw bytes, since the clean program is not run');
  assert.equal(existsSync(join(f.directory, 'FILTER_EXECUTED')), false);
  await releaseWorkspaceTree(f.directory, 'other filter');
});

test('without an exec bit on disk, core.fileMode=false keeps HEAD\'s mode and gives new files 100644', async t => {
  const files = { 'run.sh': '#!/bin/sh\n', 'plain.txt': 'plain\n' };
  const cases = [
    { name: 'core.fileMode=false (Git for Windows)', config: { 'core.fileMode': 'false' }, modes: { 'run.sh': '100755', 'plain.txt': '100644', 'new.sh': '100644' }, unchanged: true },
    { name: 'core.fileMode=true (POSIX)', config: { 'core.fileMode': 'true' }, modes: { 'run.sh': '100644', 'plain.txt': '100755', 'new.sh': '100755' }, unchanged: false },
  ];
  for (const { name, config, modes, unchanged } of cases) {
    // Windows stat reports no exec bit on any file, so only the fileMode=false row is observable there.
    if (process.platform === 'win32' && !unchanged) continue;
    const directory = mkdtempSync(join(tmpdir(), 'workspace-filemode-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    git(directory, 'init', '-q');
    for (const [path, content] of Object.entries(files)) writeFileSync(join(directory, path), content);
    chmodSync(join(directory, 'run.sh'), 0o755);
    // HEAD's mode through the index as well, which holds where chmod changes nothing.
    git(directory, 'add', '-A'); git(directory, 'update-index', '--chmod=+x', 'run.sh'); git(directory, 'commit', '-qm', 'base');
    assert.equal(git(directory, 'ls-tree', 'HEAD', 'run.sh').split(' ')[0], '100755');
    for (const [key, value] of Object.entries(config)) git(directory, 'config', key, value);
    // On Windows stat reports no exec bit on any file. Flip both bits here to show which setting decides.
    chmodSync(join(directory, 'run.sh'), 0o644);
    chmodSync(join(directory, 'plain.txt'), 0o755);
    const tree = await captureWorkspaceTree(directory, name); assert.ok(tree);
    assert.equal(tree === git(directory, 'rev-parse', 'HEAD^{tree}'), unchanged, `${name}: mode bits on disk ${unchanged ? 'do not' : 'do'} count`);
    writeFileSync(join(directory, 'new.sh'), 'new\n'); chmodSync(join(directory, 'new.sh'), 0o755);
    const settled = await captureWorkspaceTree(directory, `${name} new`); assert.ok(settled);
    for (const [path, mode] of Object.entries(modes)) assert.equal(git(directory, 'ls-tree', settled, '--', path).split(' ')[0], mode, `${name}: ${path}`);
    for (const identity of [name, `${name} new`]) await releaseWorkspaceTree(directory, identity);
  }
});

test('with core.symlinks=false a link checked out as a file keeps mode 120000', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-symlinks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q');
  writeFileSync(join(directory, 'target.txt'), 'target\n');
  symlinkSync('target.txt', join(directory, 'link'));
  git(directory, 'add', '-A'); git(directory, 'commit', '-qm', 'base');
  const tree = git(directory, 'rev-parse', 'HEAD^{tree}');
  assert.equal(git(directory, 'ls-tree', 'HEAD', 'link').split(' ')[0], '120000');
  const cases = [
    { name: 'core.symlinks=false (Git for Windows)', symlinks: 'false', unchanged: true, mode: '120000' },
    { name: 'core.symlinks=true (POSIX): a file in a link\'s place is a type change', symlinks: 'true', unchanged: false, mode: '100644' },
  ];
  for (const { name, symlinks, unchanged, mode } of cases) {
    git(directory, 'config', 'core.symlinks', symlinks);
    // What Git for Windows writes for a link: a plain file whose bytes are the link target.
    rmSync(join(directory, 'link')); writeFileSync(join(directory, 'link'), 'target.txt');
    const captured = await captureWorkspaceTree(directory, name); assert.ok(captured);
    assert.equal(captured === tree, unchanged, name);
    assert.equal(git(directory, 'ls-tree', captured, '--', 'link').split(' ')[0], mode, name);
    // A new target in that file is a changed link, stored as `git add` stores it.
    writeFileSync(join(directory, 'link'), 'other.txt');
    const retargeted = await captureWorkspaceTree(directory, `${name} retargeted`); assert.ok(retargeted);
    assert.equal(git(directory, 'ls-tree', retargeted, '--', 'link').split(' ')[0], mode, `${name}: retargeted`);
    assert.equal(execFileSync('git', ['cat-file', 'blob', `${retargeted}:link`], { cwd: directory, env: environment }).toString(), 'other.txt');
    for (const identity of [name, `${name} retargeted`]) await releaseWorkspaceTree(directory, identity);
    unlinkSync(join(directory, 'link')); symlinkSync('target.txt', join(directory, 'link'));
  }
});

test('the whole Git for Windows configuration at once gives HEAD\'s tree for an untouched checkout', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-all-windows-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q');
  writeFileSync(join(directory, 'text.txt'), 'one\ntwo\n');
  writeFileSync(join(directory, 'run.sh'), '#!/bin/sh\n'); chmodSync(join(directory, 'run.sh'), 0o755);
  symlinkSync('text.txt', join(directory, 'link'));
  git(directory, 'add', '-A'); git(directory, 'commit', '-qm', 'base');
  for (const [key, value] of Object.entries({ 'core.autocrlf': 'true', 'core.fileMode': 'false', 'core.symlinks': 'false' })) git(directory, 'config', key, value);
  git(directory, 'rm', '-rq', '--cached', '.'); git(directory, 'reset', '-q', '--hard');
  chmodSync(join(directory, 'run.sh'), 0o644);
  assert.match(readFileSync(join(directory, 'text.txt'), 'utf8'), /\r\n/);
  assert.equal(readFileSync(join(directory, 'link'), 'utf8'), 'text.txt', 'reset under core.symlinks=false wrote the link as a file');
  const captured = await captureWorkspaceTree(directory, 'all');
  assert.equal(captured, git(directory, 'rev-parse', 'HEAD^{tree}'));
  await releaseWorkspaceTree(directory, 'all');
});

test('a parent directory on another drive escapes the workspace', () => {
  const cases: Array<[string, string, boolean]> = [
    ['C:\\work\\repo', 'C:\\work\\repo\\src', false],
    ['C:\\work\\repo', 'C:\\work\\repo', false],
    ['C:\\work\\repo', 'C:\\work\\other', true],
    ['C:\\work\\repo', 'C:\\work', true],
    ['C:\\work\\repo', 'D:\\elsewhere\\repo\\src', true],
    ['C:\\work\\repo', 'C:\\work\\repo\\..dots\\src', false],
  ];
  for (const [root, parent, escapes] of cases) assert.equal(escapesWorkspace(root, parent, win32), escapes, `${root} -> ${parent}`);
  assert.equal(escapesWorkspace('/work/repo', '/work/repo/..dots'), false);
  assert.equal(escapesWorkspace('/work/repo', '/work'), true);
  assert.equal(escapesWorkspace('/work/repo', '/elsewhere'), true);
});

test('a settled turn has one deadline that ends its tree capture and its comparisons', async t => {
  const f = repo(t, { 'a.txt': 'a\n' });
  const expired = AbortSignal.abort();
  assert.equal(await captureWorkspaceTree(f.directory, 'expired', expired), null, 'no partial tree past the deadline');
  assert.equal(git(f.directory, 'for-each-ref', '--format=%(refname)', 'refs/letagents/workspace-review'), '');
  assert.equal((await captureWorkspaceChanges(f.directory, f.head, f.tree, true, expired)).state, 'unavailable');
  const baseline = await f.capture('live');
  const pair = await captureWorkspacePair(f.directory, f.head, baseline, 'live');
  assert.equal(pair.contribution.changes.state, 'ready', 'a deadline that is not reached changes nothing');
  await releaseWorkspaceTree(f.directory, 'live');
});
