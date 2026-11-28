import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

const opened: string[] = [];
const shell = { openExternal: async (url: string) => { opened.push(url); } };
mock.module("electron", { defaultExport: { shell }, namedExports: { shell } });
mock.module("../main/project-bindings-store.js", { namedExports: { listProjectBindings: async () => [] } });

const {
  claudeSessionFromRecord,
  codexLastTurnEvent,
  defaultLocalSessionSources,
  codexThreadNames,
  githubRepositoryFromRemote,
  localSessionOpenUrl,
  openDesktopLocalWorkSession,
  projectForFolder,
  projectsFromBindings,
  readLocalWorkSessions,
  LOCAL_SESSION_LOOKBACK_MS,
} = await import("../main/my-work/local-sessions.js");

const NOW = Date.parse("2026-11-28T18:00:00Z");
const home = await mkdtemp(join(tmpdir(), "my-work-sessions-"));
after(() => rm(home, { recursive: true, force: true }));

const repoRoot = join(home, "Projects", "letagents");
const sources = {
  claudeSessionsDir: join(home, "claude-code-sessions"),
  codexHome: join(home, ".codex"),
  letagentsHomes: [join(home, ".letagents")],
};
const projects = projectsFromBindings([
  binding(repoRoot, "git-room:local:0123456789abcdef"),
  binding(repoRoot, "github.com/brosincode/letagents"),
  binding(join(home, "Projects", "other"), "github.com/emmymay/other"),
]);

function binding(rootPath: string, room: string) {
  return {
    id: room, identityKey: room, verificationKeys: [], aliases: [`room:${room}`, `project-room:${room}`],
    rootPath, source: "local_folder" as const, createdAt: "", updatedAt: "",
  };
}

const CLAUDE_ID = "local_df13b133-1fad-402a-999e-a9c41e618fff";
const CODEX_ID = "01a102a9-0d35-7c23-b04b-4adb30cfd5c1";

function claudeRecord(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: CLAUDE_ID,
    cliSessionId: "c56b874d-05fc-4344-a6e0-9643bacf9a75",
    title: "Room publishing error with remote origin",
    cwd: repoRoot,
    isArchived: false,
    lastActivityAt: NOW - 60 * 60 * 1000,
    postTurnSummary: "must never be read",
    prs: [
      { prNumber: 1948, url: "https://github.com/BrosInCode/letagents/pull/1948", branch: "claude/project-remote-detection", state: "OPEN", own: true },
      { prNumber: 1922, url: "https://github.com/BrosInCode/letagents/pull/1922", state: "MERGED" },
      { prNumber: 1948, url: "https://github.com/brosincode/letagents/pull/1948", state: "OPEN", own: true },
    ],
    ...overrides,
  };
}

test("the person's folders come from the account home; the preview's private CODEX_HOME is ignored", () => {
  const preview = defaultLocalSessionSources("/Users/emmy", { CODEX_HOME: "/Users/emmy/.letagents-preview/home/.codex" });
  assert.equal(preview.codexHome, "/Users/emmy/.codex");
  assert.equal(preview.claudeSessionsDir, "/Users/emmy/Library/Application Support/Claude/claude-code-sessions");
  assert.equal(defaultLocalSessionSources("/Users/emmy", { CODEX_HOME: "/Volumes/work/codex" }).codexHome, "/Volumes/work/codex");
  assert.equal(defaultLocalSessionSources("/Users/emmy", {}).codexHome, "/Users/emmy/.codex");
});

test("bound folders become projects; a GitHub room wins over the local room of the same folder", () => {
  const letagents = projects.find(project => project.root === repoRoot);
  assert.equal(letagents?.roomId, "github.com/brosincode/letagents");
  assert.equal(letagents?.repository, "brosincode/letagents");
  assert.equal(projects.length, 2);
});

test("a folder matches the deepest bound project; a repository matches when the folder does not", () => {
  assert.equal(projectForFolder(projects, join(repoRoot, ".claude", "worktrees", "x"))?.root, repoRoot);
  assert.equal(projectForFolder(projects, `${repoRoot}-copy`), null, "a sibling folder with the same prefix is not inside");
  assert.equal(projectForFolder(projects, "/elsewhere/letagents", "brosincode/letagents")?.root, repoRoot);
  assert.equal(projectForFolder(projects, "/elsewhere/private", null), null);
});

test("GitHub remotes in https, ssh and scp form give owner/repo", () => {
  assert.equal(githubRepositoryFromRemote("git@github.com:BrosInCode/letagents.git"), "brosincode/letagents");
  assert.equal(githubRepositoryFromRemote("https://github.com/BrosInCode/letagents"), "brosincode/letagents");
  assert.equal(githubRepositoryFromRemote("ssh://git@github.com/BrosInCode/letagents.git"), "brosincode/letagents");
  assert.equal(githubRepositoryFromRemote("https://gitlab.com/a/b.git"), null);
});

test("a Claude record keeps only the index: title, project, the session's own pull requests and state", () => {
  const session = claudeSessionFromRecord(claudeRecord(), projects, sources, NOW);
  assert.deepEqual(session, {
    provider: "claude-code",
    id: CLAUDE_ID,
    title: "Room publishing error with remote origin",
    projectRoot: repoRoot,
    projectRoomId: "github.com/brosincode/letagents",
    branch: null,
    lastActivityAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    state: "idle",
    pullRequests: [{
      url: "https://github.com/BrosInCode/letagents/pull/1948", number: 1948, state: "OPEN", branch: "claude/project-remote-detection",
    }],
  });
  assert.ok(!JSON.stringify(session).includes("must never be read"));
});

test("Claude records outside bound projects, archived, too old or from LetAgents' own agents are dropped", () => {
  assert.equal(claudeSessionFromRecord(claudeRecord({ cwd: "/Users/someone/private", prs: [] }), projects, sources, NOW), null);
  assert.equal(claudeSessionFromRecord(claudeRecord({ isArchived: true }), projects, sources, NOW), null);
  assert.equal(claudeSessionFromRecord(claudeRecord({ lastActivityAt: NOW - LOCAL_SESSION_LOOKBACK_MS - 1 }), projects, sources, NOW), null);
  assert.equal(claudeSessionFromRecord(claudeRecord({ cwd: join(home, ".letagents", "worktrees", "a") }), projects, sources, NOW), null);
  assert.equal(claudeSessionFromRecord(claudeRecord({ sessionId: "local_../../x" }), projects, sources, NOW), null);
});

test("a Claude session is working when it changed in the last minutes and needs you when the app stopped for the person", () => {
  assert.equal(claudeSessionFromRecord(claudeRecord({ lastActivityAt: NOW - 30_000 }), projects, sources, NOW)?.state, "working");
  assert.equal(claudeSessionFromRecord(claudeRecord({ interruptedAwaitingPerson: { at: NOW } }), projects, sources, NOW)?.state, "needs_you");
  const worktree = claudeSessionFromRecord(
    claudeRecord({ cwd: repoRoot, worktreePath: join(repoRoot, ".claude", "worktrees", "a"), branch: "claude/a" }), projects, sources, NOW);
  assert.equal(worktree?.branch, "claude/a");
});

test("the last Codex turn event says whether a turn runs", () => {
  const started = JSON.stringify({ type: "event_msg", payload: { type: "task_started" } });
  const ended = JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } });
  assert.equal(codexLastTurnEvent(`${ended}\n${started}\n{"type":"response_item"}\n`), "started");
  assert.equal(codexLastTurnEvent(`${started}\n${ended}\n`), "ended");
  assert.equal(codexLastTurnEvent("partial line without events"), null);
});

test("Codex thread names: the last line for an id wins and a broken line is skipped", () => {
  const names = codexThreadNames([
    JSON.stringify({ id: CODEX_ID, thread_name: "Old name" }),
    JSON.stringify({ id: CODEX_ID, thread_name: "Room interactions" }),
    "{\"id\":\"half",
  ].join("\n"));
  assert.equal(names.get(CODEX_ID), "Room interactions");
});

async function writeClaude(name: string, record: unknown, mtimeMs: number) {
  const dir = join(sources.claudeSessionsDir, "account", "org");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(record));
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
}

async function writeCodex(day: string, id: string, meta: Record<string, unknown>, events: string[], mtimeMs: number) {
  const dir = join(sources.codexHome, "sessions", ...day.split("/"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${day.replace(/\//g, "-")}T10-00-00-${id}.jsonl`);
  const head = JSON.stringify({ type: "session_meta", payload: { id, ...meta } });
  await writeFile(path, [head, ...events.map(type => JSON.stringify({ type: "event_msg", payload: { type } }))].join("\n") + "\n");
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
}

test("reading the folders returns both apps' sessions of bound projects, newest first", async () => {
  await writeClaude(`${CLAUDE_ID}.json`, claudeRecord(), NOW - 60 * 60 * 1000);
  await writeClaude("local_00000000-0000-4000-8000-000000000001.json",
    claudeRecord({ sessionId: "local_00000000-0000-4000-8000-000000000001", cwd: "/private/elsewhere", prs: [] }), NOW);
  await writeClaude("local_00000000-0000-4000-8000-000000000002.json", "{not json", NOW);
  await mkdir(sources.codexHome, { recursive: true });
  await writeFile(join(sources.codexHome, "session_index.jsonl"), `${JSON.stringify({ id: CODEX_ID, thread_name: "Room interactions" })}\n`);
  // Started weeks ago (old day folder) but still active: the file time decides.
  await writeCodex("2026/10/04", CODEX_ID, {
    originator: "Codex Desktop", cwd: join(home, "Code", "letagents-worktree"),
    git: { branch: "codex/room-interactions", repository_url: "git@github.com:BrosInCode/letagents.git" },
  }, ["task_complete", "task_started"], NOW - 60_000);
  await writeCodex("2026/11/27", "11111111-1111-4111-8111-111111111111", {
    originator: "letagents-desktop-codex-supervisor", cwd: repoRoot,
  }, ["task_started"], NOW - 60_000);
  await writeCodex("2026/11/27", "22222222-2222-4222-8222-222222222222", {
    originator: "Codex Desktop", cwd: repoRoot, parent_thread_id: CODEX_ID,
  }, ["task_started"], NOW - 60_000);

  const sessions = await readLocalWorkSessions({ sources, projects, now: NOW });
  assert.deepEqual(sessions.map(session => [session.provider, session.id, session.title, session.state, session.branch]), [
    ["codex", CODEX_ID, "Room interactions", "working", "codex/room-interactions"],
    ["claude-code", CLAUDE_ID, "Room publishing error with remote origin", "idle", null],
  ]);
  assert.equal(sessions[0]!.projectRoot, repoRoot, "a Codex worktree outside the folder matches by repository");
});

test("no bound project means no session is read", async () => {
  assert.deepEqual(await readLocalWorkSessions({ sources, projects: [], now: NOW }), []);
});

test("only a checked id becomes a deep link, and only to the two apps", async () => {
  assert.equal(localSessionOpenUrl("claude-code", CLAUDE_ID), `claude://code/continue?session=${CLAUDE_ID}`);
  assert.equal(localSessionOpenUrl("codex", CODEX_ID), `codex://threads/${CODEX_ID}`);
  assert.throws(() => localSessionOpenUrl("claude-code", "local_x&session=other"));
  assert.throws(() => localSessionOpenUrl("codex", "../settings"));
  assert.throws(() => localSessionOpenUrl("cursor", CODEX_ID));
  await openDesktopLocalWorkSession("codex", CODEX_ID);
  assert.deepEqual(opened, [`codex://threads/${CODEX_ID}`]);
  await assert.rejects(openDesktopLocalWorkSession("codex", "javascript:alert(1)"));
  assert.equal(opened.length, 1);
});
