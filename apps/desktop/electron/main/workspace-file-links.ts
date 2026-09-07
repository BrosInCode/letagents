import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, relative, resolve, extname } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRoomAgentWorkSummary } from '../../../../shared/room-agent-work.mjs';
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
    if (!inside || inside.startsWith('../') || inside === '..' || inside.startsWith('/')) return null;
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
async function context(input: WorkspaceFileRequest) {
  validate(input);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(homedir(), '.letagents', 'daemon-state.sqlite'), { readOnly: true });
    const row = database.prepare(`SELECT c.settled_json, a.workspace_path FROM room_workspace_captures c
      JOIN room_work_publications p USING(agent_id,room_id,source_message_id)
      JOIN work_attempts a USING(work_attempt_id)
      WHERE p.room_id=? AND p.agent_key=? AND p.source_message_id=? AND p.state='open' AND p.api_origin=?`).get(input.roomId, input.agentKey, input.sourceMessageId, apiUrl);
    const summary = row && parseRoomAgentWorkSummary(JSON.parse(String(row.settled_json)));
    if (summary && 'workspace' in summary) return { summary, root: String(row!.workspace_path) };
  } catch { /* Remote hosts and old installations have no local receipt. */ }
  finally { database?.close(); }
  const result = await pollDesktopRoomAgentWork(input.roomId).catch(() => null);
  const work = result?.response?.snapshot?.work.find(item => item.agentKey === input.agentKey && item.sourceMessageId === input.sourceMessageId);
  return work && 'workspace' in work.summary ? { summary: work.summary, root: null } : null;
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
  const value = await context(input);
  if (!value) return [];
  const snapshot = value.summary.contribution?.changes ?? value.summary.workspace;
  if (!snapshot) return [];
  return (await Promise.all(input.paths.map(async (path): Promise<WorkspaceFileLink | null> => {
    if (!snapshot.files.some(file => file.path === path)) return null;
    const local = value.root && await localWorkspaceFile(value.root, path);
    if (local && await defaultSourceEditor(local)) return { path, kind: 'local' as const };
    const url = await githubFile(input.roomId, snapshot.branch, path);
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
    if (!trustedEditor(editor)) return null;
    await run('/usr/bin/codesign', ['--verify', '--strict', '-R', '=' + editorSignatureRequirement(editor.id)!, editor.path], { timeout: 5000, maxBuffer: 8192 });
    return editor;
  } catch { return null; }
}
export async function openLocalSourceFile(path: string): Promise<string> {
  const editor = await defaultSourceEditor(path);
  if (!editor) return 'No supported default editor is available.';
  try { await run('/usr/bin/open', ['-a', editor.path, path], { timeout: 5000 }); return ''; }
  catch { return 'The default editor could not open this file.'; }
}
