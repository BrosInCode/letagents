import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceFilePatches } from '../src/domain/workspace-diff.js';
import type { WorkspaceChangedFile } from '../../../../shared/workspace-change-summary.mjs';
const file = (path: string): WorkspaceChangedFile => ({ path, previous_path: null, status: 'modified', additions: 1, deletions: 1, binary: false });
test('workspace review associates files by path and counts context, added, and removed lines', () => {
  const patches = workspaceFilePatches('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -8,2 +8,2 @@\n-old\n+new\n context\n', [file('b.ts'), file('a.ts')]);
  assert.equal(patches.has('b.ts'), false);
  assert.deepEqual(patches.get('a.ts')?.slice(1), [
    {text:'old',kind:'deleted',before:8,after:null}, {text:'new',kind:'added',before:null,after:8}, {text:'context',kind:'context',before:9,after:9},
  ]);
});
test('workspace review handles deletion, spaces, Git octal UTF-8 paths, and renames without hunks', () => {
  const paths = ['gone file.ts', 'café.ts', 'new name.ts'];
  const patches = workspaceFilePatches('diff --git a/gone file.ts b/gone file.ts\n--- a/gone file.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- /dev/null\n+++ "b/caf\\303\\251.ts"\n@@ -0,0 +1 @@\n+hello\ndiff --git a/old.ts b/new name.ts\nsimilarity index 100%\nrename from old.ts\nrename to new name.ts\n', paths.map(file));
  assert.deepEqual([...patches.keys()], paths);
  assert.deepEqual(patches.get('new name.ts'), []);
});
test('workspace review does not treat source code resembling patch headers as file metadata', () => {
  const patches = workspaceFilePatches('diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1,2 @@\n+++ b/not-the-file.ts\n+<script>alert(1)</script>\n', [file('file.ts')]);
  assert.equal(patches.get('file.ts')?.[1].text, '++ b/not-the-file.ts');
  assert.equal(patches.get('file.ts')?.[2].text, '<script>alert(1)</script>');
});


test('large-file review parses a bounded page while retaining exact line numbers across pages', () => {
  const patch = 'diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,1000000 @@\n' + '+line\n'.repeat(1_000_000);
  const first = workspaceFilePatches(patch, [file('a.ts')], { offset: 0, limit: 501 }).get('a.ts')!;
  assert.equal(first.length, 501);
  assert.equal(first[0].kind, 'hunk'); assert.equal(first[500].after, 500);
  const second = workspaceFilePatches(patch, [file('a.ts')], { offset: 500, limit: 501 }).get('a.ts')!;
  assert.equal(second.length, 501); assert.equal(second[0].after, 500);
  const last = workspaceFilePatches(patch, [file('a.ts')], { offset: 1_000_000, limit: 501 }).get('a.ts')!;
  assert.equal(last.length, 1); assert.equal(last[0].after, 1_000_000);
});


test('indexed pages bound long text, preserve every character and reuse line checkpoints', async () => {
  const { createWorkspaceDiffIndex, readWorkspaceDiffPage } = await import('../src/domain/workspace-diff.js');
  const text = 'a'.repeat(4095) + '😀' + 'z'.repeat(8192) + 'END';
  const patch = 'diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,1000001 @@\n' + '+x\n'.repeat(1_000_000) + '+' + text + '\n';
  const index = createWorkspaceDiffIndex(patch, [file('a.ts')]);
  const last = readWorkspaceDiffPage(index, 'a.ts', { offset: 1_000_000 });
  assert.equal(last.lines.length, 2); assert.equal(last.lines[1].after, 1_000_001);
  assert.ok(index.files.get('a.ts')!.checkpoints.length > 1000);
  const checkpoints = index.files.get('a.ts')!.checkpoints.length;
  assert.deepEqual(readWorkspaceDiffPage(index, 'a.ts', { offset: 1_000_000 }), last);
  assert.equal(index.files.get('a.ts')!.checkpoints.length, checkpoints);
  let reconstructed = '', textOffset = 0;
  do {
    const part = readWorkspaceDiffPage(index, 'a.ts', { offset: 1_000_001, singleLine: true, textOffset }).lines[0];
    assert.ok(part.text.length <= 4096); reconstructed += part.text;
    if (part.nextTextOffset === null) break;
    textOffset = part.nextTextOffset;
  } while (true);
  assert.equal(reconstructed, text);
  assert.throws(() => readWorkspaceDiffPage(index, 'a.ts', { offset: -1 }), /Invalid/);
});

test('a diff page has a total character budget even when every line is enormous', async () => {
  const { createWorkspaceDiffIndex, readWorkspaceDiffPage } = await import('../src/domain/workspace-diff.js');
  const patch = 'diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,600 @@\n' + ('+' + 'x'.repeat(5000) + '\n').repeat(600);
  const index = createWorkspaceDiffIndex(patch, [file('a.ts')]);
  let offset = 0, rows = 0;
  do {
    const page = readWorkspaceDiffPage(index, 'a.ts', { offset });
    assert.ok(page.lines.length <= 500); assert.ok(page.lines.reduce((n, line) => n + line.text.length, 0) <= 128 * 1024);
    rows += page.lines.length;
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  } while (true);
  assert.equal(rows, 601);
});
