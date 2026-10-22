import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readlink, realpath, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import nodePath, { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { captureWorkspaceChanges, GIT_TIMEOUT_MS, WORKSPACE_CAPTURE_TIMEOUT_MS, WORKSPACE_SETTLE_TIMEOUT_MS } from './workspace-change-capture.mjs';
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
// Replace refs are off: with them the workspace could put any object in the place of
// the one a capture reads (a base's tree, the start snapshot itself).
function git(cwd, args, signal, index, input, extra) {
    return new Promise((resolve, reject) => {
        const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '--no-optional-locks', ...args], {
            cwd, signal, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 8 * 1024 * 1024, encoding: 'utf8',
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
            // Windows has no process groups: only Git itself is killed there, and a stalled
            // ssh it started is orphaned until it gives up on its own (ConnectTimeout). Good
            // enough for tier 1; the Windows agent work (tier 3) should kill the job tree.
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
/**
 * Whether `parent`, the real path of a tracked path's directory, lies outside `root`.
 * The remainder is `..` (or starts with it) on the same volume; on Windows, a parent on
 * another drive gives an absolute remainder (`D:\\...`), which `..` would never catch.
 */
export function escapesWorkspace(root, parent, path = nodePath) {
    const remainder = path.relative(root, parent);
    return remainder === '..' || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder);
}
const gitBool = (root, key, signal, fallback) => git(root, ['config', '--type=bool', key], signal).then(value => value.trim() === 'true', () => fallback);
/**
 * The Git settings that decide what `git add` would store for a working file. A Git for
 * Windows checkout sets core.fileMode and core.symlinks to false and usually
 * core.autocrlf to true; an unset value is Git's default, except that an exec bit
 * cannot exist on Windows, so an unset core.fileMode is false there.
 */
async function storageSettings(root, signal) {
    const [trustExecutableBit, symlinks, autocrlf] = await Promise.all([
        gitBool(root, 'core.fileMode', signal, process.platform !== 'win32'),
        gitBool(root, 'core.symlinks', signal, process.platform !== 'win32'),
        git(root, ['config', '--get', 'core.autocrlf'], signal).then(value => /^(?:true|input|yes|on|1)$/i.test(value.trim()), () => false),
    ]);
    return { trustExecutableBit, symlinks, autocrlf };
}
const ATTRIBUTES = ['filter', 'text', 'crlf', 'eol', 'ident', 'working-tree-encoding'];
/** The conversion attributes of every path, in one Git call: path -> { attribute: value }. */
async function conversionAttributes(root, paths, signal) {
    const output = await git(root, ['check-attr', '-z', '--stdin', ...ATTRIBUTES], signal, undefined, paths.map(path => `${path}\0`).join(''));
    const parts = output.split('\0');
    const attributes = new Map();
    for (let i = 0; i + 2 < parts.length; i += 3) {
        const entry = attributes.get(parts[i]) ?? {};
        entry[parts[i + 1]] = parts[i + 2];
        attributes.set(parts[i], entry);
    }
    return attributes;
}
const unspecified = (value) => value === undefined || value === 'unspecified';
/** A `filter=<driver>` attribute: a clean program Git would run on `git add`, or LFS. */
const filterDriver = (attributes) => unspecified(attributes.filter) || attributes.filter === 'unset' ? null : attributes.filter;
/** Whether one of Git's own conversions (line endings, ident, working-tree-encoding) may change what is stored. */
function converts(attributes, autocrlf) {
    const text = unspecified(attributes.text) ? attributes.crlf : attributes.text; // `crlf` is the old name of `text`.
    return !unspecified(attributes.ident) || !unspecified(attributes['working-tree-encoding'])
        || (text !== 'unset' && (autocrlf || !unspecified(text) || !unspecified(attributes.eol)));
}
const LFS_POINTER_VERSIONS = ['version https://git-lfs.github.com/spec/v1\n', 'version https://hawser.github.com/spec/v1\n'];
const isLfsPointer = (bytes) => bytes.length <= 1024 && LFS_POINTER_VERSIONS.some(version => bytes.subarray(0, version.length).toString('utf8') === version);
/** The pointer file that git-lfs's clean filter stores for these bytes (pointer spec v1); an empty file stays empty. */
const lfsPointer = (bytes) => Buffer.from(`${LFS_POINTER_VERSIONS[0]}oid sha256:${createHash('sha256').update(bytes).digest('hex')}\nsize ${bytes.length}\n`);
/**
 * Retained Git tree, with no changes to the user's index, branch, or working files.
 * Unsupported/oversized observations fail closed; a partial baseline is never a turn diff.
 * `deadline` (the settled turn's budget) ends the capture early; it always has its own.
 *
 * Each file is stored as `git add` would store it, so that a file nobody touched has
 * HEAD's blob and mode, and both trees of a turn (start and settled) are made the same
 * way. That matters in a Git for Windows checkout: with core.autocrlf every text file on
 * disk has CRLF while HEAD has LF, core.fileMode=false means no exec bit on disk, and
 * core.symlinks=false checks a link out as a plain file holding its target. Read as
 * raw bytes and modes, every such file would look changed, or the capture would hit
 * its limits and give no baseline at all.
 *
 * How a file is hashed, decided from its attributes (one `git check-attr` for all paths):
 *  - No conversion applies (the common case outside Windows): the raw bytes are hashed
 *    here and only a changed file is given to Git, as before.
 *  - Git's own conversions apply (core.autocrlf, or a text, eol, ident or
 *    working-tree-encoding attribute): Git adds the file to the private index itself,
 *    all such files in one `update-index --add`, so the result is exactly `git add`'s:
 *    the index holds HEAD, and a file that is CRLF in HEAD stays CRLF (Git converts
 *    only files whose indexed blob has no CR). `hash-object --path` with the raw bytes
 *    has no index and would strip every CR, and one process per file is too slow when,
 *    under autocrlf, every text file needs it. core.safecrlf is off for this call: a
 *    file with mixed endings is an observation here, not a commit to warn about.
 *  - A `filter=<driver>` attribute names a clean program. The capture never runs one:
 *    it must not execute what the workspace configures (see the filter sentinel test),
 *    and an LFS clean on a large binary is slow and may contact a server. git-lfs's
 *    pointer is a fixed text, so for `filter=lfs` the pointer is written here from the
 *    file's SHA-256; an unchanged LFS file then matches HEAD and a changed one is
 *    stored as `git add` would store it. A file that is still the pointer (not
 *    smudged) is hashed as is. Any other driver's file is hashed raw: it shows as
 *    changed whenever the clean output would differ from the working bytes.
 *    The attributes are read once, before the files: a workspace that rewrites
 *    `.gitattributes` and its filter configuration in between can still have Git run
 *    its program, as the agent could run it itself. The guard is against accident.
 */
export async function captureWorkspaceTree(workspace, identity, deadline = undefined) {
    const signal = deadline ? AbortSignal.any([AbortSignal.timeout(WORKSPACE_CAPTURE_TIMEOUT_MS), deadline]) : AbortSignal.timeout(WORKSPACE_CAPTURE_TIMEOUT_MS);
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
        const settings = await storageSettings(root, signal);
        const attributes = await conversionAttributes(root, paths, signal);
        /** The mode `git add` would record: the link or exec bit on disk where the checkout can hold one, else HEAD's. */
        const modeOf = (path, stat) => {
            const committed = original.get(path)?.[0];
            if (stat.isSymbolicLink())
                return '120000';
            if (!settings.symlinks && committed === '120000')
                return '120000'; // Checked out as a file whose bytes are the link target; `git add` keeps it a link.
            if (!settings.trustExecutableBit)
                return committed === '100755' || committed === '100644' ? committed : '100644';
            return stat.mode & 0o111 ? '100755' : '100644';
        };
        // Four bounded lanes overlap filesystem waits without a promise or buffer per file.
        // Each lane owns its reusable buffer until hash-object has consumed its stdin.
        // Slots preserve Git index-info order, including directory-to-file replacements.
        const results = new Array(paths.length);
        const converted = []; // Files Git adds to the private index itself after the lanes, with its conversions.
        let bytesRead = 0, next = 0, failed = false;
        await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
            let readBuffer;
            try {
                while (!failed && !signal.aborted) {
                    const slot = next++;
                    if (slot >= paths.length) return;
                    const path = paths[slot];
                    // Parent symlinks must not redirect an observation outside the managed workspace.
                    const parent = await realpath(dirname(join(root, path))).catch(() => null);
                    if (parent && escapesWorkspace(root, parent))
                        throw new Error('Workspace observation unavailable.');
                    if (signal.aborted)
                        throw new Error('Workspace observation unavailable.');
                    const absolute = join(root, path);
                    const stat = await lstat(absolute).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
                        return null; throw error; });
                    if (original.get(path)?.[1] === 'commit')
                        throw new Error('Workspace observation unavailable.'); // Submodules need their own workspace.
                    if (!stat) {
                        results[slot] = `0 ${'0'.repeat(head.length)}\t${path}\0`;
                        continue;
                    }
                    const mode = modeOf(path, stat);
                    const driver = mode === '120000' ? null : filterDriver(attributes.get(path) ?? {});
                    let bytes;
                    if (stat.isSymbolicLink())
                        bytes = Buffer.from(await readlink(absolute));
                    else if (stat.isFile() && stat.size <= 8 * 1024 * 1024) {
                        if (mode !== '120000' && !driver && converts(attributes.get(path) ?? {}, settings.autocrlf)) {
                            // Git reads this one itself; the budget counts its size now.
                            if ((bytesRead += stat.size) > 64 * 1024 * 1024)
                                throw new Error('Workspace observation unavailable.');
                            converted.push(path);
                            continue;
                        }
                        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
                        try {
                            const buffer = readBuffer ??= Buffer.alloc(8 * 1024 * 1024 + 1);
                            const read = await handle.read(buffer, 0, buffer.length, 0);
                            bytes = buffer.subarray(0, read.bytesRead);
                        }
                        finally {
                            await handle.close();
                        }
                    }
                    else
                        throw new Error('Workspace observation unavailable.'); // Includes submodule changes: do not attribute a fabricated text diff.
                    bytesRead += bytes.length;
                    if (bytes.length > 8 * 1024 * 1024 || bytesRead > 64 * 1024 * 1024)
                        throw new Error('Workspace observation unavailable.');
                    if (driver === 'lfs' && bytes.length && !isLfsPointer(bytes))
                        bytes = lfsPointer(bytes);
                    const rawOid = createHash(head.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
                    if (original.get(path)?.[0] === mode && original.get(path)?.[2] === rawOid)
                        continue;
                    const oid = (await git(root, ['hash-object', '-w', '--no-filters', '--stdin'], signal, undefined, bytes)).trim();
                    results[slot] = `${mode} ${oid}\t${path}\0`;

                }
            } catch { failed = true; }
            // Do not reject early: every started file/Git operation must finish before cleanup.
        }));
        if (failed || signal.aborted) return null;
        // Converted files first, raw entries after: --replace lets a file take a directory's place
        // and the reverse, and a removal of an entry that is already gone is not an error.
        if (converted.length)
            await git(root, ['-c', 'core.safecrlf=false', 'update-index', '--add', '--replace', '-z', '--stdin'], signal, index, converted.map(path => `${path}\0`).join(''));
        const entries = results.filter(value => value !== undefined);
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
        await git(workspace, ['update-ref', '-d', reviewRef(identity)], AbortSignal.timeout(GIT_TIMEOUT_MS));
    }
    catch { /* Retain on failure, never jeopardize provider work. */ }
}
/** The commit a piece of work starts on. With it and the remotes' tips, the settled capture can tell a base update from the work. */
export async function captureWorkspaceHead(workspace) {
    return git(workspace, ['rev-parse', '--verify', 'HEAD^{commit}'], AbortSignal.timeout(GIT_TIMEOUT_MS)).then(value => value.trim(), () => null);
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
async function ownStartingTree(workspace, start, startingHead, remoteTips, deadline) {
    if (!objectId.test(start ?? '') || !objectId.test(startingHead ?? '') || !Array.isArray(remoteTips))
        return start;
    const signal = AbortSignal.any([AbortSignal.timeout(WORKSPACE_CAPTURE_TIMEOUT_MS), deadline]);
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
        // A sparse checkout leaves files out: an untouched file would look deleted against the
        // new base. The trees hold text files as Git stores them, so core.autocrlf no longer
        // makes an untouched file look changed; the plain comparison is kept for it all the
        // same, until the base-update rule is proven under it. Neither can make a changed
        // file look untouched.
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
    // One budget for the whole settled turn, whatever Defender or a slow disk does to each command.
    const deadline = AbortSignal.timeout(WORKSPACE_SETTLE_TIMEOUT_MS);
    const tree = await captureWorkspaceTree(workspace, `${identity}:settled`, deadline);
    try {
        const full = tree ? await captureWorkspaceChanges(workspace, startingRevision, tree, true, deadline) : unavailableWorkspace();
        const turn = async () => {
            // The settled files are already captured: a remote that is still silent delays only this
            // comparison, and a question that failed in any way leaves the plain one.
            const from = await ownStartingTree(workspace, baseline, startingHead, await Promise.resolve(remoteTips).catch(() => null), deadline);
            const own = from === baseline ? null : await captureWorkspaceChanges(workspace, from, tree, true, deadline);
            return own?.state === 'ready' ? { ...own, base_revision: baseline } : captureWorkspaceChanges(workspace, baseline, tree, true, deadline);
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
