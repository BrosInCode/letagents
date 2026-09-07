import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { captureWorkspaceChanges } from './workspace-change-capture.js';
import type { WorkspaceChangeSummary } from '../../../shared/workspace-change-summary.mjs';

const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(cwd: string, args: string[], signal: AbortSignal, index?: string, input?: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-optional-locks', ...args], {
      cwd, signal, timeout: 5_000, maxBuffer: 4 * 8 * 1024 * 1024, encoding: 'utf8',
      env: { ...environment(), GIT_TERMINAL_PROMPT: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
export const unavailableWorkspace = (): WorkspaceChangeSummary => ({ captured_at: new Date().toISOString(), branch: null,
  base_revision: null, state: 'unavailable', files: [], additions: 0, deletions: 0, hidden_files: 0, patch: '', patch_truncated: false });
const reviewRef = (identity: string) => `refs/letagents/workspace-review/${createHash('sha256').update(identity).digest('hex')}`;

/** Retained Git tree, with no changes to the user's index, branch, or working files.
 * Unsupported/oversized observations fail closed; a partial baseline is never a turn diff. */
export async function captureWorkspaceTree(workspace: string, identity: string): Promise<string | null> {
  const signal = AbortSignal.timeout(20_000);
  const scratch = await mkdtemp(join(tmpdir(), 'letagents-workspace-'));
  const index = join(scratch, 'index');
  try {
    const root = await realpath(workspace);
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{tree}'], signal)).trim();
    await git(root, ['read-tree', head], signal, index);
    const original = new Map((await git(root, ['ls-tree', '-r', '-z', head], signal)).split('\0').filter(Boolean).map(entry => {
      const split = entry.indexOf('\t'); return [entry.slice(split + 1), entry.slice(0, split).split(' ')];
    }));
    const paths = [...new Set([...original.keys(), ...(await git(root,
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean)])];
    if (paths.length > 10_000) return null;
    const entries: string[] = [];
    let bytesRead = 0;
    for (const path of paths) {
      // Parent symlinks must not redirect an observation outside the managed workspace.
      const parent = await realpath(dirname(join(root, path))).catch(() => null);
      if (parent && (relative(root, parent).startsWith('..') || relative(root, parent).startsWith('/'))) return null;
      if (signal.aborted) return null;
      const absolute = join(root, path);
      const stat = await lstat(absolute).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
      if (original.get(path)?.[1] === 'commit') return null; // Submodules need their own workspace.
      if (!stat) { entries.push(`0 ${'0'.repeat(head.length)}\t${path}\0`); continue; }
      let bytes: Buffer;
      if (stat.isSymbolicLink()) bytes = Buffer.from(await readlink(absolute));
      else if (stat.isFile() && stat.size <= 8 * 1024 * 1024) {
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const buffer = Buffer.alloc(8 * 1024 * 1024 + 1); const read = await handle.read(buffer, 0, buffer.length, 0); bytes = buffer.subarray(0, read.bytesRead); }
        finally { await handle.close(); }
      } else return null; // Includes submodule changes: do not attribute a fabricated text diff.
      bytesRead += bytes.length;
      if (bytes.length > 8 * 1024 * 1024 || bytesRead > 64 * 1024 * 1024) return null;
      const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
      const rawOid = createHash(head.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (original.get(path)?.[0] === mode && original.get(path)?.[2] === rawOid) continue;
      if (entries.length >= 200) return null;
      const oid = (await git(root, ['hash-object', '-w', '--no-filters', '--stdin'], signal, undefined, bytes)).trim();
      entries.push(`${mode} ${oid}\t${path}\0`);
    }
    if (entries.length) await git(root, ['update-index', '-z', '--index-info'], signal, index, entries.join(''));
    const tree = (await git(root, ['write-tree'], signal, index)).trim();
    await git(root, ['update-ref', reviewRef(identity), tree], signal);
    return tree;
  } catch { return null; }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function releaseWorkspaceTree(workspace: string, identity: string): Promise<void> {
  try { await git(workspace, ['update-ref', '-d', reviewRef(identity)], AbortSignal.timeout(5_000)); } catch { /* Retain on failure, never jeopardize provider work. */ }
}
export async function captureWorkspacePair(workspace: string, startingRevision: string | null, baseline: string | null, identity: string) {
  const tree = await captureWorkspaceTree(workspace, `${identity}:settled`);
  try {
    const full = tree ? await captureWorkspaceChanges(workspace, startingRevision, tree) : unavailableWorkspace();
    const changes = tree && baseline ? await captureWorkspaceChanges(workspace, baseline, tree) : unavailableWorkspace();
    // Bound the combined v3 envelope without changing accurate file totals.
    for (const snapshot of [full, changes]) {
      if (snapshot.patch.length > 48 * 1024) { snapshot.patch = snapshot.patch.slice(0, 48 * 1024); snapshot.patch_truncated = true; }
    }
    return { workspace: full, contribution: { changes, summary: null as string | null } };
  } finally { await releaseWorkspaceTree(workspace, `${identity}:settled`); }
}
