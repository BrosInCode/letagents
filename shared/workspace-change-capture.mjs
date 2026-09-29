import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WORKSPACE_FILE_LIMIT, WORKSPACE_PATCH_LIMIT, parseWorkspaceChangeSummary } from './workspace-change-summary.mjs';
const execute = promisify(execFile);
async function git(cwd, args, limit = 4 * 1024 * 1024) {
    const result = await execute('git', ['--no-optional-locks', ...args], {
        cwd, encoding: 'utf8', timeout: 5_000, maxBuffer: limit,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0' },
    });
    return result.stdout;
}
/** Reads the actual provider workspace; never stages, commits, or changes its index. */
export async function captureWorkspaceChanges(workspace, startingRevision, settledTree, fullReview = false) {
    const patchLimit = fullReview ? 128 * 1024 * 1024 : WORKSPACE_PATCH_LIMIT;
    const fileLimit = fullReview ? 10_000 : WORKSPACE_FILE_LIMIT;
    const empty = (state) => ({
        captured_at: new Date().toISOString(), branch: null, base_revision: null, state,
        files: [], additions: 0, deletions: 0, hidden_files: 0, patch: '', patch_truncated: false,
    });
    try {
        if ((await git(workspace, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true')
            return empty('not_git');
    }
    catch (error) {
        return empty(/not a git repository/i.test(String(error.stderr ?? '')) ? 'not_git' : 'unavailable');
    }
    try {
        if (startingRevision !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(startingRevision))
            return empty('unavailable');
        const branch = await git(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(value => value.trim(), () => null);
        if (settledTree && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(settledTree))
            return empty('unavailable');
        const base = await git(workspace, ['rev-parse', '--verify', `${startingRevision ?? 'HEAD'}^{tree}`])
            .then(value => value.trim(), error => { if (startingRevision)
            throw error; return null; });
        const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'];
        const [names, stats, untracked] = await Promise.all([
            base ? git(workspace, ['diff', ...diffArgs, '--name-status', '-z', base, ...(settledTree ? [settledTree] : []), '--']) : Promise.resolve(''),
            base ? git(workspace, ['diff', ...diffArgs, '--numstat', '-z', base, ...(settledTree ? [settledTree] : []), '--']) : Promise.resolve(''),
            settledTree ? Promise.resolve('') : git(workspace, ['ls-files', '--others', '--exclude-standard', ...(base ? [] : ['--cached']), '-z']),
        ]);
        const files = new Map();
        const nameParts = names.split('\0');
        for (let i = 0; i < nameParts.length - 1;) {
            const code = nameParts[i++];
            const first = nameParts[i++];
            const renamed = code.startsWith('R') || code.startsWith('C');
            const path = renamed ? nameParts[i++] : first;
            const status = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' }[code[0]] ?? 'unknown';
            files.set(path, { path, previous_path: renamed ? first : null, status, additions: 0, deletions: 0, binary: false });
        }
        const statParts = stats.split('\0');
        for (let i = 0; i < statParts.length; i++) {
            const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(statParts[i]);
            if (!match)
                continue;
            let path = match[3];
            if (!path) {
                path = statParts[i + 2];
                i += 2;
            }
            const file = files.get(path);
            if (!file)
                continue;
            file.binary = match[1] === '-' || match[2] === '-';
            file.additions = file.binary ? 0 : Number(match[1]);
            file.deletions = file.binary ? 0 : Number(match[2]);
        }
        let patch = '';
        let truncated = false;
        if (base) {
            try {
                patch = await git(workspace, ['diff', ...diffArgs, '--unified=3', base, ...(settledTree ? [settledTree] : []), '--'], patchLimit);
            }
            catch (error) {
                const failure = error;
                if (failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
                    throw error;
                patch = String(failure.stdout ?? '').slice(0, patchLimit);
                truncated = true;
            }
        }
        const newPaths = [...new Set(untracked.split('\0').filter(Boolean))];
        let inspectedFiles = 0;
        for (const path of newPaths) {
            if (files.has(path))
                continue;
            const file = { path, previous_path: null, status: base ? 'untracked' : 'added', additions: 0, deletions: 0, binary: false };
            files.set(path, file);
            if (++inspectedFiles > fileLimit) {
                truncated = true;
                continue;
            }
            // Do not follow symlinks into files outside the workspace.
            const absolute = join(workspace, path);
            const metadata = await lstat(absolute);
            let bytes;
            if (metadata.isSymbolicLink())
                bytes = Buffer.from(await readlink(absolute));
            else if (metadata.isFile() && metadata.size <= 1024 * 1024) {
                const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const buffer = Buffer.alloc(1024 * 1024 + 1);
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                    bytes = buffer.subarray(0, bytesRead);
                    if (bytesRead > 1024 * 1024) {
                        truncated = true;
                        continue;
                    }
                }
                finally {
                    await handle.close();
                }
            }
            else {
                truncated = true;
                continue;
            }
            file.binary = bytes.includes(0);
            if (file.binary)
                continue;
            const text = bytes.toString('utf8');
            const lines = text ? text.replace(/\n$/, '').split('\n') : [];
            file.additions = lines.length;
            if (patch.length < patchLimit) {
                const label = JSON.stringify(`b/${path}`);
                const addition = `diff --git ${JSON.stringify(`a/${path}`)} ${label}\nnew file mode ${metadata.isSymbolicLink() ? '120000' : '100644'}\n--- /dev/null\n+++ ${label}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join('')}`;
                patch += addition;
            }
            else
                truncated = true;
        }
        const all = [...files.values()];
        const result = parseWorkspaceChangeSummary({ ...empty('ready'), branch, base_revision: startingRevision ?? base,
            files: all.slice(0, fileLimit), additions: all.reduce((n, file) => n + file.additions, 0),
            deletions: all.reduce((n, file) => n + file.deletions, 0), hidden_files: Math.max(0, all.length - fileLimit),
            patch: patch.slice(0, patchLimit), patch_truncated: truncated || patch.length > patchLimit,
        }, fullReview);
        return result ?? empty('unavailable');
    }
    catch {
        return empty('unavailable');
    }
}
