import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { parseRoomAgentWorkSummary } from '../../../../shared/room-agent-work.mjs';
import { letagentsHome } from '../../../../shared/letagents-home.mjs';
import { apiUrl } from './paths.js';
import { pollDesktopRoomAgentWork } from './rooms/agent-work.js';

export type WorkspaceFileRequest = { roomId: string; agentKey: string; sourceMessageId: string; paths: string[] };
export type WorkspaceFileLink = { path: string; kind: 'local' | 'github'; url?: string };
const run = promisify(execFile);
const textExtensions = new Set(['.txt', '.md', '.mdx', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json', '.css', '.scss', '.html', '.py', '.rs', '.go', '.java', '.swift', '.c', '.h', '.cpp', '.yaml', '.yml', '.toml', '.xml', '.sql']);
export function safeWorkspaceFilePath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path.length < 1024
    && !path.startsWith('/') && !/[\\\x00-\x1f\x7f:]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}
export async function localWorkspaceFile(root: string, path: string): Promise<string | null> {
  if (!safeWorkspaceFilePath(path) || !textExtensions.has(extname(path).toLowerCase())) return null;
  try {
    const base = await realpath(root);
    const file = await realpath(resolve(base, path));
    const inside = relative(base, file);
    // Windows separates with \ and may answer with another drive's absolute path.
    if (!inside || inside.startsWith('../') || inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return null;
    const info = await stat(file);
    return info.isFile() && !(info.mode & 0o111) ? file : null;
  } catch { return null; }
}
function validate(input: WorkspaceFileRequest) {
  if (!input || typeof input.roomId !== 'string' || input.roomId.length > 512
    || typeof input.agentKey !== 'string' || input.agentKey.length > 512
    || !/^msg_[1-9]\d{0,9}$/.test(input.sourceMessageId)
    || !Array.isArray(input.paths) || input.paths.length > 3 || !input.paths.every(safeWorkspaceFilePath)) throw new Error('Invalid workspace reference.');
}
async function context(input: WorkspaceFileRequest, options: { cachedPoll?: boolean } = {}) {
  validate(input);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(letagentsHome({ homedir }), 'daemon-state.sqlite'), { readOnly: true });
    const row = database.prepare(`SELECT c.settled_json, a.workspace_path FROM room_workspace_captures c
      JOIN room_work_publications p USING(agent_id,room_id,source_message_id)
      JOIN work_attempts a USING(work_attempt_id)
      WHERE p.room_id=? AND p.agent_key=? AND p.source_message_id=? AND p.state='open' AND p.api_origin=?`).get(input.roomId, input.agentKey, input.sourceMessageId, apiUrl);
    const summary = row && parseRoomAgentWorkSummary(JSON.parse(String(row.settled_json)));
    if (summary && 'workspace' in summary) return { summary, root: String(row!.workspace_path) };
  } catch { /* Remote hosts and old installations have no local receipt. */ }
  finally { database?.close(); }
  const result = options.cachedPoll
    ? await cachedRoomAgentWorkPoll(input.roomId)
    : await pollDesktopRoomAgentWork(input.roomId).catch(() => null);
  const work = result?.response?.snapshot?.work.find(item => item.agentKey === input.agentKey && item.sourceMessageId === input.sourceMessageId);
  return work && 'workspace' in work.summary ? { summary: work.summary, root: null } : null;
}
type Expiring<T> = { expiresAt: number; value: Promise<T> };
// Rendered contribution rows ask for links on every mount. These memos serve
// only that advisory decoration; openWorkspaceFile reads everything afresh.
const ROOM_WORK_POLL_TTL_MS = 15_000;
const GITHUB_FILE_TTL_MS = 10 * 60_000;
const GITHUB_FILE_MISS_TTL_MS = 60_000;
const EDITOR_ASSOCIATION_TTL_MS = 5 * 60_000;
const EDITOR_VERIFICATION_TTL_MS = 10 * 60_000;
const EDITOR_VERIFICATION_FAILURE_TTL_MS = 60_000;
const MEMO_LIMIT = 256;
const roomWorkPolls = new Map<string, Expiring<Awaited<ReturnType<typeof pollDesktopRoomAgentWork>> | null>>();
const githubFiles = new Map<string, Expiring<string | null>>();
const editorAssociations = new Map<string, Expiring<{ id: string; path: string } | null>>();
const editorVerifications = new Map<string, Expiring<boolean>>();

function remember<T>(memo: Map<string, Expiring<T>>, key: string, load: () => Promise<T>, ttl: (value: T) => number): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  if (memo.size >= MEMO_LIMIT) {
    for (const [entryKey, entry] of memo) if (entry.expiresAt <= now) memo.delete(entryKey);
    // Insertion order is age order: drop the oldest entries past the bound.
    for (const entryKey of memo.keys()) { if (memo.size < MEMO_LIMIT) break; memo.delete(entryKey); }
  }
  // In flight, the entry never expires, so concurrent rows share one command.
  const entry: Expiring<T> = { expiresAt: Number.POSITIVE_INFINITY, value: load() };
  memo.set(key, entry);
  entry.value.then(
    value => { if (memo.get(key) === entry) entry.expiresAt = Date.now() + ttl(value); },
    () => { if (memo.get(key) === entry) memo.delete(key); },
  );
  return entry.value;
}

/** Test-only: forget every advisory memo. */
export function clearWorkspaceFileLinkCachesForTest(): void {
  roomWorkPolls.clear(); githubFiles.clear(); editorAssociations.clear(); editorVerifications.clear();
}

function cachedRoomAgentWorkPoll(roomId: string) {
  return remember(roomWorkPolls, roomId, () => pollDesktopRoomAgentWork(roomId).catch(() => null),
    result => result?.status === 'ready' ? ROOM_WORK_POLL_TTL_MS : 0);
}

function cachedGithubFile(room: string, branch: string | null | undefined, path: string): Promise<string | null> {
  return remember(githubFiles, JSON.stringify([room, branch ?? null, path]), () => githubFile(room, branch, path),
    url => url ? GITHUB_FILE_TTL_MS : GITHUB_FILE_MISS_TTL_MS);
}

export async function githubFile(room: string, branch: string | null | undefined, path: string): Promise<string | null> {
  const repo = /^github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(room);
  if (!repo || (branch && branch.length > 256) || !safeWorkspaceFilePath(path)) return null;
  // Verify existence in the published branch; never invent a URL for an unpushed file.
  const endpoint = `repos/${repo[1]}/${repo[2]}/contents/${path.split('/').map(encodeURIComponent).join('/')}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`;
  try {
    const { stdout } = await run('gh', ['api', endpoint], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    const file = JSON.parse(stdout);
    const url = new URL(file.html_url);
    if (file.type !== 'file' || file.path !== path || url.protocol !== 'https:' || url.hostname !== 'github.com'
      || !url.pathname.startsWith(`/${repo[1]}/${repo[2]}/blob/`)) return null;
    return url.href;
  } catch { return null; }
}
export async function resolveWorkspaceFileLinks(input: WorkspaceFileRequest): Promise<WorkspaceFileLink[]> {
  const value = await context(input, { cachedPoll: true });
  if (!value) return [];
  const snapshot = value.summary.contribution?.changes ?? value.summary.workspace;
  if (!snapshot) return [];
  return (await Promise.all(input.paths.map(async (path): Promise<WorkspaceFileLink | null> => {
    if (!snapshot.files.some(file => file.path === path)) return null;
    const local = value.root && await localWorkspaceFile(value.root, path);
    if (local && await advisoryDefaultSourceEditor(local)) return { path, kind: 'local' as const };
    const url = await cachedGithubFile(input.roomId, snapshot.branch, path);
    return url ? { path, kind: 'github' as const, url } : null;
  }))).filter((item): item is WorkspaceFileLink => item !== null);
}
export async function openWorkspaceFile(input: WorkspaceFileRequest, openPath: (path: string) => Promise<string>, openWeb: (url: string) => Promise<void>): Promise<void> {
  if (input.paths?.length !== 1) throw new Error('Choose one file.');
  const value = await context(input);
  const path = input.paths[0]!;
  const snapshot = value?.summary.contribution?.changes ?? value?.summary.workspace;
  if (!snapshot?.files.some(file => file.path === path)) throw new Error('This file is no longer available.');
  const local = value?.root && await localWorkspaceFile(value.root, path);
  if (local) {
    const error = await openPath(local);
    if (!error) return;
  }
  const url = await githubFile(input.roomId, snapshot.branch, path);
  if (url) return openWeb(url);
  throw new Error('This file is no longer available locally or on GitHub.');
}

const EDITORS: Record<string, string> = {
  'com.microsoft.VSCode': 'UBF8T346G9', 'com.microsoft.VSCodeInsiders': 'UBF8T346G9',
  'com.todesktop.230313mzl4w4u92': 'VDXQ22DGB9', 'dev.zed.Zed': 'MQ55VZLNZQ',
  'com.google.antigravity-ide': 'EQHXZ8M8AV',
  'com.apple.TextEdit': 'apple', 'com.apple.dt.Xcode': 'apple',
};
export function editorSignatureRequirement(id: string): string | null {
  const publisher = EDITORS[id];
  if (!publisher) return null;
  return publisher === 'apple' ? `anchor apple and identifier "${id}"`
    : `anchor apple generic and identifier "${id}" and certificate leaf[subject.OU] = "${publisher}"`;
}
export function trustedEditor(value: unknown): value is { id: string; path: string } {
  if (!value || typeof value !== 'object') return false;
  const editor = value as { id?: unknown; path?: unknown };
  return typeof editor.id === 'string' && Object.hasOwn(EDITORS, editor.id)
    && typeof editor.path === 'string' && editor.path.startsWith('/') && editor.path.endsWith('.app') && !/[\x00-\x1f]/.test(editor.path);
}
export async function defaultSourceEditor(path: string): Promise<{ id: string; path: string } | null> {
  return findDefaultSourceEditor(path);
}
async function queryDefaultSourceEditor(path: string): Promise<{ id: string; path: string } | null> {
  if (process.platform !== 'darwin') return null;
  // Query Launch Services only. The pathname is an argv value, never evaluated as code.
  const script = `ObjC.import('AppKit'); function run(argv) {
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]));
    if (!url) return ''; const bundle = $.NSBundle.bundleWithURL(url);
    return JSON.stringify({id: ObjC.unwrap(bundle.bundleIdentifier), path: ObjC.unwrap(url.path)});
  }`;
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, path], { timeout: 3000, maxBuffer: 8192 });
    const editor: unknown = JSON.parse(stdout);
    return trustedEditor(editor) ? { id: editor.id, path: editor.path } : null;
  } catch { return null; }
}
async function verifyEditor(editor: { id: string; path: string }): Promise<boolean> {
  try {
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R', '=' + editorSignatureRequirement(editor.id)!, editor.path], { timeout: 5000, maxBuffer: 8192 });
    return true;
  } catch { return false; }
}
/**
 * Identity of the installed bundle: an update, re-sign, or replacement
 * changes it. Covers the bundle, Info.plist, the seal (CodeResources) and
 * every file in Contents/MacOS, which holds the main executable.
 */
async function editorBundleFingerprint(editorPath: string): Promise<string | null> {
  try {
    const parts = [];
    const executables = await readdir(join(editorPath, 'Contents', 'MacOS')).catch(() => [] as string[]);
    const paths = [editorPath, join(editorPath, 'Contents', 'Info.plist'), join(editorPath, 'Contents', '_CodeSignature', 'CodeResources'),
      ...executables.sort().map(name => join(editorPath, 'Contents', 'MacOS', name))];
    for (const path of paths) {
      const info = await stat(path, { bigint: true }).catch(() => null);
      parts.push(info ? [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') : '-');
    }
    return parts[0] === '-' ? null : parts.join('|');
  } catch { return null; }
}
/**
 * Advisory link decoration only. The Launch Services answer is memoized per
 * extension and the signature result per exact editor bundle identity, so a
 * page of rows costs at most one osascript and one codesign. Opening a file
 * never uses these memos: openLocalSourceFile queries and verifies afresh.
 */
async function advisoryDefaultSourceEditor(path: string): Promise<{ id: string; path: string } | null> {
  if (process.platform === 'win32') return windowsSourceEditor();
  if (process.platform !== 'darwin') return null;
  const editor = await remember(editorAssociations, extname(path).toLowerCase(), () => queryDefaultSourceEditor(path),
    () => EDITOR_ASSOCIATION_TTL_MS);
  if (!editor) return null;
  const fingerprint = await editorBundleFingerprint(editor.path);
  // A missing bundle has no stable identity to key on; verify it every time.
  const verified = fingerprint
    ? await remember(editorVerifications, JSON.stringify([editor.id, editor.path, fingerprint]), () => verifyEditor(editor),
      ok => ok ? EDITOR_VERIFICATION_TTL_MS : EDITOR_VERIFICATION_FAILURE_TTL_MS)
    : await verifyEditor(editor);
  return verified ? editor : null;
}
async function findDefaultSourceEditor(path: string): Promise<{ id: string; path: string } | null> {
  if (process.platform === 'win32') return windowsSourceEditor();
  const editor = await queryDefaultSourceEditor(path);
  return editor && await verifyEditor(editor) ? editor : null;
}
/**
 * Windows has no Launch Services answer to verify, so only VS Code is used:
 * its `bin\code.cmd` on PATH marks the install, and the Code.exe one folder
 * up opens files directly, as Explorer's "Open with Code" does. Running the
 * .exe needs no shell, so a file name is never parsed as a command.
 */
export function windowsSourceEditor(options: { env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {}): { id: string; path: string } | null {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const searchPath = env.Path ?? env.PATH ?? '';
  for (const entry of searchPath.split(';')) {
    const folder = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!win32.isAbsolute(folder) || !exists(win32.join(folder, 'code.cmd'))) continue;
    const executable = win32.resolve(folder, '..', 'Code.exe');
    if (exists(executable)) return { id: 'com.microsoft.VSCode', path: executable };
  }
  return null;
}
async function openWithWindowsEditor(editorPath: string, path: string): Promise<string> {
  // Loaded here so macOS-only callers and tests never need spawn.
  const { spawn } = await import('node:child_process');
  return new Promise(resolveOpen => {
    try {
      // Detached: a first VS Code window keeps running after LetAgents is done.
      // Without these, Code.exe would start as plain Node instead of the editor.
      const { ELECTRON_RUN_AS_NODE: _runAsNode, NODE_OPTIONS: _nodeOptions, ...env } = process.env;
      const child = spawn(editorPath, [path], { detached: true, stdio: 'ignore', windowsHide: false, env });
      child.once('error', () => resolveOpen('The default editor could not open this file.'));
      child.once('spawn', () => { child.unref(); resolveOpen(''); });
    } catch { resolveOpen('The default editor could not open this file.'); }
  });
}
export async function openLocalSourceFile(path: string): Promise<string> {
  const editor = await defaultSourceEditor(path);
  if (!editor) return 'No supported default editor is available.';
  if (process.platform === 'win32') return openWithWindowsEditor(editor.path, path);
  try { await run('/usr/bin/open', ['-a', editor.path, path], { timeout: 5000 }); return ''; }
  catch { return 'The default editor could not open this file.'; }
}
