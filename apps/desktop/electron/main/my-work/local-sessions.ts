/**
 * My Work: the Claude Code sessions and Codex threads on this computer that
 * belong to a project bound in LetAgents.
 *
 * The reader keeps to an index. It reads the Claude app's own session records
 * (title, folder, archive flag, the pull requests the app bound to the
 * session) and the first line plus the tail of each Codex thread file (folder,
 * Git facts, turn start and end). It never reads prompts, answers or tool
 * output, and nothing it returns leaves this computer.
 *
 * Sessions outside every bound project folder are dropped, so private work in
 * other folders stays out of My Work.
 */
import { open, readdir, readFile, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

import electron from "electron";

import type {
  MyWorkLocalSession,
  MyWorkSessionProvider,
  MyWorkSessionPullRequest,
  MyWorkSessionState,
} from "../../../../../shared/ticket-connectors.mjs";
import type { DesktopProjectBinding } from "../../ipc-types.js";
import { listProjectBindings } from "../project-bindings-store.js";

const { shell } = electron as typeof import("electron");
export type { MyWorkSessionState };

/** Sessions older than this are history, not work in progress. */
export const LOCAL_SESSION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** A session that changed this recently is working now. */
export const LOCAL_SESSION_WORKING_MS = 3 * 60 * 1000;
/** At most this many sessions are returned, newest first. */
export const LOCAL_SESSION_LIMIT = 60;
/** A Claude session record is a small JSON file; a larger one is not read. */
const CLAUDE_RECORD_MAX_BYTES = 2 * 1024 * 1024;
/** The first line of a Codex thread holds its metadata; it can be long. */
const CODEX_HEAD_MAX_BYTES = 512 * 1024;
/** The tail read to find the last turn event of a Codex thread. */
const CODEX_TAIL_BYTES = 256 * 1024;
const CACHE_MS = 10_000;

const CLAUDE_SESSION_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LocalSessionSources {
  /** The Claude app's session records: `<dir>/<account>/<org>/local_*.json`. */
  claudeSessionsDir: string;
  /** `CODEX_HOME`, or `~/.codex`. */
  codexHome: string;
  /** Folders of LetAgents' own agents; their sessions are not the person's. */
  letagentsHomes: string[];
}

/**
 * The person's own folders. `userInfo()` reads the account's home, not `HOME`:
 * the isolated preview build points `HOME` and `CODEX_HOME` at its private
 * profile, and the person's sessions are not there.
 */
export function defaultLocalSessionSources(
  home = userInfo().homedir,
  env: NodeJS.ProcessEnv = process.env,
): LocalSessionSources {
  const previewRoot = join(home, ".letagents-preview");
  const envCodexHome = normalizeFolder(env.CODEX_HOME);
  return {
    claudeSessionsDir: join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
    codexHome: envCodexHome && !isInside(envCodexHome, previewRoot) ? envCodexHome : join(home, ".codex"),
    letagentsHomes: [join(home, ".letagents"), previewRoot],
  };
}

/** A bound project: its folder and the project room it belongs to. */
export interface LocalSessionProject {
  root: string;
  roomId: string | null;
  /** `owner/repo` on github.com, when the room is a GitHub repository room. */
  repository: string | null;
}

export function projectsFromBindings(bindings: readonly DesktopProjectBinding[]): LocalSessionProject[] {
  const projects = new Map<string, LocalSessionProject>();
  for (const binding of bindings) {
    const root = normalizeFolder(binding.rootPath);
    if (!root) continue;
    const roomId = binding.aliases.find(alias => alias.startsWith("project-room:"))?.slice("project-room:".length) || null;
    const repository = roomId?.match(/^github\.com\/([^/]+\/[^/]+)$/i)?.[1]?.toLowerCase() ?? null;
    const known = projects.get(root);
    // A folder bound to a local room and to its published GitHub room keeps the GitHub room.
    if (!known || (!known.repository && repository)) projects.set(root, { root, roomId, repository });
  }
  return [...projects.values()];
}

function normalizeFolder(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const folder = resolve(value.trim());
  return folder.length > 1 && folder.endsWith(sep) ? folder.slice(0, -1) : folder;
}

function isInside(folder: string, root: string): boolean {
  return folder === root || folder.startsWith(root + sep);
}

/** The bound project that holds a folder (the deepest root wins), or one whose repository matches. */
export function projectForFolder(
  projects: readonly LocalSessionProject[],
  folder: string | null,
  repository: string | null = null,
): LocalSessionProject | null {
  let best: LocalSessionProject | null = null;
  if (folder) {
    for (const project of projects) {
      if (isInside(folder, project.root) && (!best || project.root.length > best.root.length)) best = project;
    }
  }
  if (best) return best;
  if (!repository) return null;
  return projects.find(project => project.repository === repository) ?? null;
}

/** `owner/repo` from a GitHub remote URL in https, ssh or scp form. */
export function githubRepositoryFromRemote(remote: unknown): string | null {
  if (typeof remote !== "string") return null;
  const match = remote.trim().match(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

function isLetAgentsFolder(folder: string, sources: LocalSessionSources): boolean {
  return sources.letagentsHomes.some(home => {
    const root = normalizeFolder(home);
    return Boolean(root && isInside(folder, root));
  });
}

function sessionState(lastActivityMs: number, needsYou: boolean, now: number): MyWorkSessionState {
  if (needsYou) return "needs_you";
  return now - lastActivityMs <= LOCAL_SESSION_WORKING_MS ? "working" : "idle";
}

function finiteTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Claude Code

/** The fields read from one Claude app session record. Everything else is ignored. */
export function claudeSessionFromRecord(
  record: unknown,
  projects: readonly LocalSessionProject[],
  sources: LocalSessionSources,
  now: number,
): MyWorkLocalSession | null {
  if (!record || typeof record !== "object") return null;
  const value = record as Record<string, unknown>;
  const id = typeof value.sessionId === "string" ? value.sessionId : "";
  if (!CLAUDE_SESSION_ID.test(id) || value.isArchived === true) return null;
  const lastActivity = finiteTime(value.lastActivityAt) ?? finiteTime(value.createdAt);
  if (lastActivity === null || now - lastActivity > LOCAL_SESSION_LOOKBACK_MS) return null;
  const folder = normalizeFolder(value.worktreePath) ?? normalizeFolder(value.cwd);
  if (!folder || isLetAgentsFolder(folder, sources)) return null;
  const pullRequests: MyWorkSessionPullRequest[] = [];
  const seen = new Set<string>();
  for (const pr of Array.isArray(value.prs) ? value.prs : []) {
    if (!pr || typeof pr !== "object") continue;
    const item = pr as Record<string, unknown>;
    // `own` marks a pull request the session made or works on; others were only read.
    if (item.own !== true) continue;
    const url = typeof item.url === "string" && /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+/i.test(item.url) ? item.url : null;
    const number = typeof item.prNumber === "number" && Number.isInteger(item.prNumber) ? item.prNumber : null;
    if (!url || number === null || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    pullRequests.push({ url, number, state: text(item.state, 20), branch: text(item.branch) });
  }
  const repository = pullRequests.map(pr => githubRepositoryFromRemote(pr.url.replace(/\/pull\/\d+.*$/, ""))).find(Boolean) ?? null;
  const project = projectForFolder(projects, folder, repository);
  if (!project) return null;
  const needsYou = Boolean(value.interruptedAwaitingPerson) || Boolean(value.error);
  return {
    provider: "claude-code",
    id,
    title: text(value.title),
    projectRoot: project.root,
    projectRoomId: project.roomId,
    branch: text(value.branch),
    lastActivityAt: new Date(lastActivity).toISOString(),
    state: sessionState(lastActivity, needsYou, now),
    pullRequests,
  };
}

async function readClaudeSessions(
  sources: LocalSessionSources,
  projects: readonly LocalSessionProject[],
  now: number,
): Promise<MyWorkLocalSession[]> {
  const sessions: MyWorkLocalSession[] = [];
  for (const account of await listDirectory(sources.claudeSessionsDir)) {
    const accountDir = join(sources.claudeSessionsDir, account);
    for (const org of await listDirectory(accountDir)) {
      const orgDir = join(accountDir, org);
      for (const name of await listDirectory(orgDir)) {
        if (!/^local_[0-9a-f-]+\.json$/i.test(name)) continue;
        const path = join(orgDir, name);
        try {
          const info = await stat(path);
          if (!info.isFile() || info.size > CLAUDE_RECORD_MAX_BYTES) continue;
          // A record not written for the whole look-back window cannot be recent.
          if (now - info.mtimeMs > LOCAL_SESSION_LOOKBACK_MS) continue;
          const session = claudeSessionFromRecord(JSON.parse(await readFile(path, "utf8")), projects, sources, now);
          if (session) sessions.push(session);
        } catch {
          // A record mid-write or in an older format is skipped; the next read retries.
        }
      }
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Codex

async function readHead(path: string, maxBytes: number): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const end = chunk.indexOf("\n");
    return end === -1 ? (bytesRead < maxBytes ? chunk : null) : chunk.slice(0, end);
  } finally {
    await handle.close();
  }
}

async function readTail(path: string, size: number, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The last turn event in a thread's tail: whether a turn is running or ended. */
export function codexLastTurnEvent(tail: string): "started" | "ended" | null {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes("\"event_msg\"")) continue;
    if (line.includes("\"task_started\"")) return "started";
    if (line.includes("\"task_complete\"") || line.includes("\"turn_aborted\"")) return "ended";
  }
  return null;
}

/** Thread names from `session_index.jsonl`; a later line for the same id wins. */
export function codexThreadNames(index: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of index.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const name = text(entry.thread_name);
      if (typeof entry.id === "string" && name) names.set(entry.id, name);
    } catch {
      // A half-written last line is skipped.
    }
  }
  return names;
}

export function codexSessionFromMeta(
  headLine: string,
  input: { name: string | null; lastActivityMs: number; turn: "started" | "ended" | null },
  projects: readonly LocalSessionProject[],
  sources: LocalSessionSources,
  now: number,
): MyWorkLocalSession | null {
  let meta: Record<string, unknown>;
  try {
    const parsed = JSON.parse(headLine) as Record<string, unknown>;
    if (parsed.type !== "session_meta" || !parsed.payload || typeof parsed.payload !== "object") return null;
    meta = parsed.payload as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof meta.id === "string" ? meta.id : "";
  if (!CODEX_THREAD_ID.test(id)) return null;
  // Only threads a person started in the Codex app: not sub-agents, LetAgents' own agents or scripts.
  if (meta.originator !== "Codex Desktop" || meta.parent_thread_id) return null;
  const folder = normalizeFolder(meta.cwd);
  if (!folder || isLetAgentsFolder(folder, sources)) return null;
  const git = meta.git && typeof meta.git === "object" ? meta.git as Record<string, unknown> : {};
  const project = projectForFolder(projects, folder, githubRepositoryFromRemote(git.repository_url));
  if (!project) return null;
  // A running turn that has not written for an hour has stopped without an end event.
  const running = input.turn === "started" && now - input.lastActivityMs <= 60 * 60 * 1000;
  return {
    provider: "codex",
    id,
    title: input.name,
    projectRoot: project.root,
    projectRoomId: project.roomId,
    branch: text(git.branch),
    lastActivityAt: new Date(input.lastActivityMs).toISOString(),
    state: running ? "working" : "idle",
    pullRequests: [],
  };
}

async function codexThreadFiles(codexHome: string, now: number): Promise<string[]> {
  const files: string[] = [];
  const sessionsDir = join(codexHome, "sessions");
  // A thread lives in the folder of the day it started and can stay active for
  // weeks, so day folders are not skipped by date; the file time decides.
  const oldestYear = new Date(now).getFullYear() - 1;
  for (const year of await listDirectory(sessionsDir)) {
    if (!/^\d{4}$/.test(year) || Number(year) < oldestYear) continue;
    for (const month of await listDirectory(join(sessionsDir, year))) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const day of await listDirectory(join(sessionsDir, year, month))) {
        if (!/^\d{2}$/.test(day)) continue;
        for (const name of await listDirectory(join(sessionsDir, year, month, day))) {
          if (/^rollout-.+\.jsonl$/.test(name)) files.push(join(sessionsDir, year, month, day, name));
        }
      }
    }
  }
  return files;
}

async function readCodexThreads(
  sources: LocalSessionSources,
  projects: readonly LocalSessionProject[],
  now: number,
): Promise<MyWorkLocalSession[]> {
  let names = new Map<string, string>();
  try {
    names = codexThreadNames(await readFile(join(sources.codexHome, "session_index.jsonl"), "utf8"));
  } catch {
    // No index: threads show without a name.
  }
  const sessions: MyWorkLocalSession[] = [];
  for (const path of await codexThreadFiles(sources.codexHome, now)) {
    try {
      const info = await stat(path);
      if (!info.isFile() || now - info.mtimeMs > LOCAL_SESSION_LOOKBACK_MS) continue;
      const head = await readHead(path, CODEX_HEAD_MAX_BYTES);
      if (!head || !head.includes("\"Codex Desktop\"")) continue;
      const turn = codexLastTurnEvent(await readTail(path, info.size, CODEX_TAIL_BYTES));
      const idMatch = head.match(/"id"\s*:\s*"([0-9a-f-]{36})"/i);
      const session = codexSessionFromMeta(
        head,
        { name: idMatch ? names.get(idMatch[1]!) ?? null : null, lastActivityMs: info.mtimeMs, turn },
        projects,
        sources,
        now,
      );
      if (session) sessions.push(session);
    } catch {
      // A thread file being written or rotated is skipped; the next read retries.
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------

export async function readLocalWorkSessions(input: {
  sources: LocalSessionSources;
  projects: readonly LocalSessionProject[];
  now?: number;
}): Promise<MyWorkLocalSession[]> {
  const now = input.now ?? Date.now();
  if (!input.projects.length) return [];
  const [claude, codex] = await Promise.all([
    readClaudeSessions(input.sources, input.projects, now),
    readCodexThreads(input.sources, input.projects, now),
  ]);
  return [...claude, ...codex]
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, LOCAL_SESSION_LIMIT);
}

let cached: { at: number; value: Promise<MyWorkLocalSession[]> } | null = null;

/** IPC entry: the sessions of the bound projects, cached for a few seconds. */
export function getDesktopLocalWorkSessions(): Promise<MyWorkLocalSession[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = listProjectBindings()
    .then(bindings => readLocalWorkSessions({ sources: defaultLocalSessionSources(), projects: projectsFromBindings(bindings) }))
    .catch(() => [] as MyWorkLocalSession[]);
  cached = { at: now, value };
  return value;
}

export function resetLocalWorkSessionsCacheForTest(): void {
  cached = null;
}

/** The deep link that opens a session in its app. The id is checked; no other link can be built. */
export function localSessionOpenUrl(provider: unknown, id: unknown): string {
  if (provider === "claude-code" && typeof id === "string" && CLAUDE_SESSION_ID.test(id)) {
    return `claude://code/continue?session=${encodeURIComponent(id)}`;
  }
  if (provider === "codex" && typeof id === "string" && CODEX_THREAD_ID.test(id)) {
    return `codex://threads/${encodeURIComponent(id)}`;
  }
  throw new Error("This session cannot be opened.");
}

/** IPC entry: open a session in Claude Code or Codex. */
export async function openDesktopLocalWorkSession(provider: unknown, id: unknown): Promise<void> {
  const url = localSessionOpenUrl(provider as MyWorkSessionProvider, id);
  await shell.openExternal(url);
}
