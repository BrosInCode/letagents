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
