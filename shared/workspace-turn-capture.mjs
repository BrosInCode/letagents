import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readlink, realpath, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { captureWorkspaceChanges } from './workspace-change-capture.mjs';
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
// Replace refs are off: with them the workspace could put any object in the place of
// the one a capture reads (a base's tree, the start snapshot itself).
function git(cwd, args, signal, index, input, extra) {
    return new Promise((resolve, reject) => {
        const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '--no-optional-locks', ...args], {
            cwd, signal, timeout: 5_000, maxBuffer: 4 * 8 * 1024 * 1024, encoding: 'utf8',
            env: { ...environment(), GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', ...(index ? { GIT_INDEX_FILE: index } : {}), ...extra },
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin?.on('error', () => { });
        child.stdin?.end(input);
    });
}
/**
 * A Git command that starts a transport of its own (ssh, a credential or remote
 * helper). Killing Git alone leaves a stalled transport running. So the command
 * has its own process group, and when the time is up the whole group is killed
 * and the answer does not wait for anything.
 */
function remoteGit(cwd, args, signal, extra) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '--no-optional-locks', ...args], {
            cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...environment(), GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', ...extra },
        });
        let output = '';
        const stop = () => {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch { child.kill('SIGKILL'); } // No process group on this platform, or it is gone.
            child.stdout.destroy();
            reject(new Error('The remote did not answer in time.'));
        };
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
        child.stdout.setEncoding('utf8').on('data', (chunk) => { if ((output += chunk).length > 4 * 8 * 1024 * 1024) stop(); });
        child.once('error', reject);
        child.once('close', (code) => { signal.removeEventListener('abort', stop); code === 0 ? resolve(output) : reject(new Error('Git could not ask the remote.')); });
    });
}
export const unavailableWorkspace = () => ({ captured_at: new Date().toISOString(), branch: null,
    base_revision: null, state: 'unavailable', files: [], additions: 0, deletions: 0, hidden_files: 0, patch: '', patch_truncated: false });
const reviewRef = (identity) => `refs/letagents/workspace-review/${createHash('sha256').update(identity).digest('hex')}`;
/** Retained Git tree, with no changes to the user's index, branch, or working files.
 * Unsupported/oversized observations fail closed; a partial baseline is never a turn diff. */
export async function captureWorkspaceTree(workspace, identity) {
    const signal = AbortSignal.timeout(20_000);
    const scratch = await mkdtemp(join(tmpdir(), 'letagents-workspace-'));
    const index = join(scratch, 'index');
    try {
        const root = await realpath(workspace);
        const head = (await git(root, ['rev-parse', '--verify', 'HEAD^{tree}'], signal)).trim();
        await git(root, ['read-tree', head], signal, index);
        const original = new Map((await git(root, ['ls-tree', '-r', '-z', head], signal)).split('\0').filter(Boolean).map(entry => {
            const split = entry.indexOf('\t');
            return [entry.slice(split + 1), entry.slice(0, split).split(' ')];
        }));
        const paths = [...new Set([...original.keys(), ...(await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean)])];
        if (paths.length > 10_000)
            return null;
        const entries = [];
        let bytesRead = 0;
        for (const path of paths) {
            // Parent symlinks must not redirect an observation outside the managed workspace.
            const parent = await realpath(dirname(join(root, path))).catch(() => null);
            if (parent && (relative(root, parent).startsWith('..') || relative(root, parent).startsWith('/')))
                return null;
            if (signal.aborted)
                return null;
            const absolute = join(root, path);
            const stat = await lstat(absolute).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
                return null; throw error; });
            if (original.get(path)?.[1] === 'commit')
                return null; // Submodules need their own workspace.
            if (!stat) {
                entries.push(`0 ${'0'.repeat(head.length)}\t${path}\0`);
                continue;
            }
            let bytes;
            if (stat.isSymbolicLink())
                bytes = Buffer.from(await readlink(absolute));
            else if (stat.isFile() && stat.size <= 8 * 1024 * 1024) {
                const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
                    const read = await handle.read(buffer, 0, buffer.length, 0);
                    bytes = buffer.subarray(0, read.bytesRead);
                }
                finally {
                    await handle.close();
                }
            }
            else
                return null; // Includes submodule changes: do not attribute a fabricated text diff.
            bytesRead += bytes.length;
            if (bytes.length > 8 * 1024 * 1024 || bytesRead > 64 * 1024 * 1024)
                return null;
            const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
            const rawOid = createHash(head.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
            if (original.get(path)?.[0] === mode && original.get(path)?.[2] === rawOid)
                continue;
            if (entries.length >= 10_000)
                return null;
            const oid = (await git(root, ['hash-object', '-w', '--no-filters', '--stdin'], signal, undefined, bytes)).trim();
            entries.push(`${mode} ${oid}\t${path}\0`);
        }
        if (entries.length)
            await git(root, ['update-index', '-z', '--index-info'], signal, index, entries.join(''));
        const tree = (await git(root, ['write-tree'], signal, index)).trim();
        await git(root, ['update-ref', reviewRef(identity), tree], signal);
        return tree;
    }
    catch {
        return null;
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
export async function releaseWorkspaceTree(workspace, identity) {
    try {
        await git(workspace, ['update-ref', '-d', reviewRef(identity)], AbortSignal.timeout(5_000));
    }
    catch { /* Retain on failure, never jeopardize provider work. */ }
}
/** The commit a piece of work starts on. With it and the remotes' tips, the settled capture can tell a base update from the work. */
export async function captureWorkspaceHead(workspace) {
    return git(workspace, ['rev-parse', '--verify', 'HEAD^{commit}'], AbortSignal.timeout(5_000)).then(value => value.trim(), () => null);
}
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const noPrompt = (ssh) => ({ GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes -o ConnectTimeout=5`, GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' });
const branchTips = (listed) => [...new Set(listed.flatMap(lines => lines.split('\n').map(line => line.split('\t')[0])))].filter(tip => objectId.test(tip));
/**
 * The commit of every branch on every configured remote, asked from the remotes
 * themselves before a piece of work starts. It is the only evidence of "upstream"
 * the capture accepts: remote-tracking branches and reflogs are local files that
 * the work can move or clear. Resolves to null when there is no remote or when a
 * remote does not answer; all of them together get five seconds, and then Git is
 * killed. It never rejects and never asks for a password, a passphrase or a host
 * key. Start it without waiting, so that a slow remote cannot delay the work, and
 * await it when the work has settled.
 *
 * The repository's own configuration names the remotes here, and whoever can
 * write that configuration can name another repository. That is acceptable only
 * for a worker that reports its own work from its own clone (the MCP capture
 * tools). A supervisor that must not take the workspace's word asks the remote it
 * recorded itself: captureRecordedRemoteTips.
 */
export async function captureRemoteTips(workspace) {
    const signal = AbortSignal.timeout(5_000);
    try {
        const remotes = (await git(workspace, ['remote'], signal)).split('\n').filter(Boolean);
        if (!remotes.length)
            return null;
        const ssh = process.env.GIT_SSH_COMMAND || (await git(workspace, ['config', '--get', 'core.sshCommand'], signal).catch(() => '')).trim() || 'ssh';
        return branchTips(await Promise.all(remotes.map(remote => remoteGit(workspace, ['-c', 'credential.interactive=false', 'ls-remote', '--heads', '--', remote], signal, noPrompt(ssh)))));
    }
    catch {
        return null;
    }
}
/**
 * The same question for one remote that the caller recorded itself, with the same
 * bound and the same silence. The remote is asked by URL, and Git runs with no
 * repository (GIT_DIR names nothing). So nothing that the work can write in the
 * workspace or in the repository it shares applies: not a remote's url, not a
 * url.<base>.insteadOf rewrite, not a worktree or included configuration file.
 * The owner's own Git configuration (global and system) still applies, because a
 * private remote needs the owner's stored credentials, SSH command and proxy. If
 * that configuration sends this URL somewhere else, there is no answer. Which
 * recorded remotes are worth asking is the caller's decision. Git starts in
 * `directory`, which is not the workspace; with no repository it does not matter
 * where.
 */
export async function captureRecordedRemoteTips(url, directory = tmpdir()) {
    const signal = AbortSignal.timeout(5_000);
    try {
        if (typeof url !== 'string' || !url)
            return null;
        const outside = { GIT_DIR: devNull };
        const ssh = process.env.GIT_SSH_COMMAND || (await git(directory, ['config', '--get', 'core.sshCommand'], signal, undefined, undefined, outside).catch(() => '')).trim() || 'ssh';
        const quiet = { ...outside, ...noPrompt(ssh) };
        // An insteadOf rewrite, or a remote that is named like the URL, shows in the address Git would use.
        if ((await git(directory, ['ls-remote', '--get-url', '--', url], signal, undefined, undefined, quiet)).trim() !== url)
            return null;
        return branchTips([await remoteGit(directory, ['-c', 'credential.interactive=false', 'ls-remote', '--heads', '--', url], signal, quiet)]);
    }
    catch {
        return null;
    }
}
async function changedEntries(root, from, to, signal) {
    const parts = (await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', from, to], signal)).split('\0');
    const entries = new Map();
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const [oldMode, newMode, oldId, newId] = parts[i].slice(1).split(' ');
        entries.set(parts[i + 1], [`${oldMode} ${oldId}`, `${newMode} ${newId}`]);
    }
    return entries;
}
const parents = (path) => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
/**
 * The tree to compare a settled turn against so that the result is the agent's
 * own changes. A fetch followed by a checkout, merge, rebase or pull brings
 * upstream commits into the workspace; compared tree to tree, all of them look
 * like work done in the turn.
 *
 * `remoteTips` is what the remotes held before the turn (captureRemoteTips or
 * captureRecordedRemoteTips). The
 * new base N is the one tip among them that HEAD gained during the turn: an
 * ancestor of HEAD now, not an ancestor of `startingHead`. The old base B is the
 * merge base of `startingHead` and N. Then, for each path that differs between B
 * and N, with S the start tree and E the settled tree:
 *  - S has B's content and E has N's content: the path changed only because the
 *    base moved. It is not in the comparison.
 *  - S has B's content and E differs from N: the turn changed the path, and it is
 *    measured against N. This includes a path that was put back to its old
 *    content, where S equals E: the turn dropped an upstream change.
 *  - S differs from B: the path was changed here before the base moved. It is
 *    measured from S as before; a resolved merge conflict shows here.
 * Every other path is measured from S as before.
 *
 * So a path leaves the comparison only when its settled content is, byte for
 * byte, content that a remote already held before the turn started. Nothing made
 * during the turn can be hidden, whatever happens to local refs afterwards.
 * Without that certainty the result is `start`, the plain comparison: no answer
 * from the remotes, an unknown starting commit, no tip or more than one
 * independent tip gained, or any Git failure.
 */
async function ownStartingTree(workspace, start, startingHead, remoteTips) {
    if (!objectId.test(start ?? '') || !objectId.test(startingHead ?? '') || !Array.isArray(remoteTips))
        return start;
    const signal = AbortSignal.timeout(20_000);
    let scratch;
    try {
        const root = await realpath(workspace);
        const gained = new Set((await git(root, ['rev-list', 'HEAD', `^${startingHead}`], signal)).split('\n'));
        const candidates = [...new Set(remoteTips)].filter(tip => objectId.test(tip) && gained.has(tip));
        if (!candidates.length || candidates.length > 256)
            return start;
        // A tip that another gained tip already contains is not a second base.
        const newest = candidates.length > 1 ? (await git(root, ['merge-base', '--independent', ...candidates], signal)).split('\n').filter(Boolean) : candidates;
        if (newest.length !== 1)
            return start;
        const [base] = newest;
        const old = (await git(root, ['merge-base', startingHead, base], signal)).trim();
        // The trees hold the files as they are on disk. With core.autocrlf those are not the
        // committed bytes, and a sparse checkout leaves files out: an untouched file would
        // look changed against the new base. Neither can make a changed file look untouched.
        if (/ (?:true|yes|on|1)$/im.test(await git(root, ['config', '--get-regexp', '^core\\.(autocrlf|sparsecheckout)$'], signal).catch(() => '')))
            return start;
        const incoming = await changedEntries(root, `${old}^{tree}`, `${base}^{tree}`, signal);
        const touched = await changedEntries(root, `${old}^{tree}`, `${start}^{tree}`, signal);
        const absent = `000000 ${'0'.repeat(base.length)}`;
        const kept = [...touched].filter(([, [, entry]]) => entry !== absent).map(([path]) => path);
        const keptFiles = new Set(kept);
        const keptDirectories = new Set(kept.flatMap(parents));
        const entries = [];
        for (const [path, [, entry]] of incoming) {
            // A file cannot take the place of a directory that holds an earlier change, or the reverse. The earlier change stays.
            if (touched.has(path) || (entry !== absent && (keptDirectories.has(path) || parents(path).some(parent => keptFiles.has(parent)))))
                continue;
            entries.push(`${entry}\t${path}\0`);
        }
        if (!entries.length)
            return start;
        scratch = await mkdtemp(join(tmpdir(), 'letagents-workspace-'));
        const index = join(scratch, 'index');
        await git(root, ['read-tree', `${start}^{tree}`], signal, index);
        await git(root, ['update-index', '-z', '--index-info'], signal, index, entries.join(''));
        return (await git(root, ['write-tree'], signal, index)).trim();
    }
    catch {
        return start;
    }
    finally {
        if (scratch)
            await rm(scratch, { recursive: true, force: true });
    }
}
/**
 * `startingHead` and `remoteTips` describe the moment `baseline` was captured:
 * the commit HEAD was on, and what the remotes held (the answer, or the pending
 * question). Without both, the turn's changes are the plain difference between
 * the two trees. The changes since the workspace started are always the plain
 * difference.
 */
export async function captureWorkspacePair(workspace, startingRevision, baseline, identity, startingHead = null, remoteTips = null) {
    const tree = await captureWorkspaceTree(workspace, `${identity}:settled`);
    try {
        const full = tree ? await captureWorkspaceChanges(workspace, startingRevision, tree, true) : unavailableWorkspace();
        const turn = async () => {
            // The settled files are already captured: a remote that is still silent delays only this
            // comparison, and a question that failed in any way leaves the plain one.
            const from = await ownStartingTree(workspace, baseline, startingHead, await Promise.resolve(remoteTips).catch(() => null));
            const own = from === baseline ? null : await captureWorkspaceChanges(workspace, from, tree, true);
            return own?.state === 'ready' ? { ...own, base_revision: baseline } : captureWorkspaceChanges(workspace, baseline, tree, true);
        };
        const changes = tree && baseline ? await turn() : unavailableWorkspace();
        const preview = (snapshot) => ({ ...snapshot,
            files: snapshot.files.slice(0, 200), hidden_files: snapshot.hidden_files + Math.max(0, snapshot.files.length - 200),
            patch: snapshot.patch.slice(0, 48 * 1024), patch_truncated: snapshot.patch_truncated || snapshot.patch.length > 48 * 1024 });
        return { workspace: preview(full), contribution: { changes: preview(changes), summary: null },
            review: { version: 1, workspace: full, contribution: changes } };
    }
    finally {
        await releaseWorkspaceTree(workspace, `${identity}:settled`);
    }
}
