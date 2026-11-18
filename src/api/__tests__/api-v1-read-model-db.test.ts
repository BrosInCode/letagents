import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { AgentList } from "../../../shared/api/agents.mjs";
import { PullRequestList } from "../../../shared/api/git.mjs";
import { MemoryList } from "../../../shared/api/memory.mjs";
import { MessageThread, RecentMessages } from "../../../shared/api/messages.mjs";
import { PeopleList, Person } from "../../../shared/api/people.mjs";
import { Planning } from "../../../shared/api/planning.mjs";
import { Task, TaskPage } from "../../../shared/api/tasks.mjs";
import { createKnowledgeRecord } from "../../../shared/room-knowledge.mjs";

// The read model v1 (people, agents, messages, tasks, planning, git, memory)
// end to end: the real app, auth middleware, room access and database.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 read model DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const boardPlanning = testDatabaseUrl ? await import("../db/board-planning.js") : null;
const knowledge = testDatabaseUrl ? await import("../db/room-knowledge.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;

const REPO_ROOM = "github.com/acme/widgets";
let server: Server | null = null;
let github: Server | null = null;
let base = "";
let roomId = "";
const previousGitHubBaseUrl = process.env.GITHUB_API_BASE_URL;

interface Caller { id: string; cookie: string }
let ada: Caller;
let bob: Caller;
let cy: Caller;

async function person(login: string, githubToken: string | null = null): Promise<Caller> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `api-v1-read-${login}`, login, display_name: login.toUpperCase() });
  const token = `api-v1-read-session-${login}`;
  await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60 * 60_000).toISOString(), githubToken);
  return { id: account.id, cookie: `letagents_session=${token}` };
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

async function prEvent(input: {
  number: number; action: string; state: string; head: string; minutesAgo: number;
  eventType?: "pull_request" | "pull_request_review" | "check_run";
  title?: string; actor?: string; metadata?: Record<string, unknown>; objectId?: string; url?: string;
}) {
  const url = input.url ?? `https://github.com/acme/widgets/pull/${input.number}`;
  await api!.insertGitHubRoomEvent({
    room_id: REPO_ROOM,
    event_type: input.eventType ?? "pull_request",
    action: input.action,
    idempotency_key: `acme/widgets:${input.eventType ?? "pr"}:${input.objectId ?? input.number}:${input.action}:${input.minutesAgo}:${input.actor ?? ""}`,
    github_object_id: input.objectId ?? String(input.number),
    github_object_url: url,
    title: input.title ?? `PR ${input.number}`,
    state: input.state,
    actor_login: input.actor ?? "ada",
    provider_event_at: at(input.minutesAgo),
    head_ref: `feature-${input.number}`,
    base_ref: "main",
    head_sha: input.head,
    metadata: { author_login: "ada", draft: false, ...input.metadata },
  });
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

    // A GitHub stub: acme/widgets is public; the token "github-token-role" has a role on it.
    github = createServer((req, res) => {
      const found = (req.url ?? "").toLowerCase().startsWith("/repos/acme/widgets");
      const role = req.headers.authorization === "Bearer github-token-role";
      res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(found ? { private: false, owner: { login: "acme" }, permissions: { pull: true, triage: role, admin: false } } : { message: "Not Found" }));
    }).listen(0, "127.0.0.1");
    await once(github, "listening");
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

    ada = await person("ada", "github-token-role");
    bob = await person("bob");
    cy = await person("cy");
    const room = await api!.createProjectWithName("api-v1-read");
    roomId = room.id;
    await members!.addRoomMember({ roomId, accountId: ada.id, addedVia: "creator" });
    await api!.assignProjectAdmin(roomId, ada.id);
    await members!.addRoomMember({ roomId, accountId: bob.id, addedVia: "seed" });

    await dbClient!.pool.query("INSERT INTO rooms (id, display_name, created_at) VALUES ($1, 'acme/widgets', now())", [REPO_ROOM]);
    await dbClient!.pool.query(`INSERT INTO room_git_bindings (room_id, provider, host, repository_full_name, repository_owner,
      repository_name, ref_type, ref_name, default_branch, visibility, is_default, source, created_at, updated_at)
      VALUES ($1, 'github', 'github.com', 'acme/widgets', 'acme', 'widgets', 'default_branch', 'main', 'main',
      'public', true, 'manual', now(), now())`, [REPO_ROOM]);

    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => github?.close(() => resolve()) ?? resolve());
    if (previousGitHubBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = previousGitHubBaseUrl;
    await dbClient!.pool.end();
  });
}

async function get(route: string, caller?: Caller) {
  const res = await fetch(`${base}${route}`, { headers: caller ? { cookie: caller.cookie } : {} });
  return { status: res.status, body: await res.json() };
}
const room = (rest = "") => `/rooms/${encodeURIComponent(roomId)}${rest}`;
const repoRoom = (rest = "") => `/rooms/${encodeURIComponent(REPO_ROOM)}${rest}`;

test("every read refuses a signed-in person who is not a participant", { skip }, async () => {
  const routes = ["/people", "/people/me", "/agents", "/messages", "/messages/msg_1/thread", "/tasks", "/tasks/task_1",
    "/planning", "/git/pull-requests", "/memory"];
  for (const route of routes) {
    assert.deepEqual(await get(room(route), cy), {
      status: 403, body: { code: "not_participant", message: "You are not a participant in this room." },
    }, route);
    assert.equal((await get(room(route))).body.code, "unauthenticated", route);
  }
  // No GitHub role on the public repository: not a participant of its room either.
  assert.equal((await get(repoRoom("/git/pull-requests"), bob)).body.code, "not_participant");
});

test("people.list gives members with roles; people.viewer gives the caller", { skip }, async () => {
  const list = await get(room("/people"), bob);
  assert.equal(list.status, 200);
  assert.ok(PeopleList.safeParse(list.body).success);
  assert.deepEqual(list.body, {
    managedBy: "letagents",
    people: [
      { login: "ada", name: "ADA", avatarUrl: null, role: "admin" },
      { login: "bob", name: "BOB", avatarUrl: null, role: "participant" },
    ],
  });
  assert.deepEqual(await get(room("/people/me"), bob), { status: 200, body: { login: "bob", name: "BOB", avatarUrl: null, role: "participant" } });
  const me = await get(room("/people/me"), ada);
  assert.ok(Person.safeParse(me.body).success);
  assert.equal(me.body.role, "admin");
});

test("people.list in a repository room gives stored admins and the people the room has seen", { skip }, async () => {
  await api!.assignProjectAdmin(REPO_ROOM, ada.id);
  await api!.upsertRoomParticipant({ room_id: REPO_ROOM, participant_key: "human:dee", kind: "human", github_login: "dee", display_name: "dee" });
  await api!.upsertRoomParticipant({ room_id: REPO_ROOM, participant_key: "agent:x", kind: "agent", actor_label: "X | dee's agent", display_name: "X" });
  assert.deepEqual((await get(repoRoom("/people"), ada)).body, {
    managedBy: "github",
    people: [
      { login: "ada", name: "ADA", avatarUrl: null, role: "admin" },
      { login: "dee", name: null, avatarUrl: null, role: "participant" },
    ],
  });
});

test("agents.list marks only agents heard from in the presence window as online", { skip }, async () => {
  const online = "Ana | ada's agent | Claude Code";
  const offline = "Ola | bob's agent | Codex";
  await api!.upsertRoomParticipant({ room_id: roomId, participant_key: `agent:${online}`, kind: "agent", actor_label: online, agent_key: "ada/ana", display_name: "Ana", last_seen_at: at(1) });
  await api!.upsertRoomParticipant({ room_id: roomId, participant_key: `agent:${offline}`, kind: "agent", actor_label: offline, agent_key: "bob/ola", display_name: "Ola", last_seen_at: at(60) });
  await api!.markRoomAgentDeliveryConnected({ room_id: roomId, actor_label: online, agent_key: "ada/ana", display_name: "Ana", session_kind: "worker", transport: "long_poll" });
  await api!.upsertRoomAgentPresence({ room_id: roomId, actor_label: online, agent_key: "ada/ana", display_name: "Ana", session_kind: "worker", status: "working", status_text: "task_1" });
  // A status heartbeat alone, with no live delivery, is not "online".
  await api!.upsertRoomAgentPresence({ room_id: roomId, actor_label: offline, agent_key: "bob/ola", display_name: "Ola", session_kind: "worker", status: "idle" });

  const { status, body } = await get(room("/agents"), bob);
  assert.equal(status, 200);
  assert.ok(AgentList.safeParse(body).success);
  assert.deepEqual(body.agents.map(({ lastSeenAt: _, ...agent }: { lastSeenAt: string }) => agent), [
    { name: "Ana", label: online, agentKey: "ada/ana", ownerLogin: "ada", online: true, status: "working", statusText: "task_1" },
    { name: "Ola", label: offline, agentKey: "bob/ola", ownerLogin: "bob", online: false, status: null, statusText: null },
  ]);
  assert.ok(body.agents.every((agent: { lastSeenAt: string }) => Number.isFinite(Date.parse(agent.lastSeenAt))));
});

test("messages.recent pages newest first; messages.thread pages a thread's replies", { skip }, async () => {
  const messageRoom = await api!.createProjectWithName("api-v1-read-messages");
  await members!.addRoomMember({ roomId: messageRoom.id, accountId: bob.id, addedVia: "seed" });
  const ids: string[] = [];
  for (let i = 1; i <= 60; i++) {
    ids.push((await api!.addMessage(messageRoom.id, i % 2 ? "bob" : "Ana | ada's agent | Claude Code", `message ${i}`, {
      source: i % 2 ? "browser" : "agent",
      ...(i % 2 ? { account_id: bob.id } : { publisher_agent_key: "ada/ana" }),
    })).id);
  }
  await api!.addMessage(messageRoom.id, "letagents", "GitHub: PR #1 opened", { source: "github" });
  // An automatic agent turn with no text is prompt-only: not part of the room's history.
  await api!.addMessage(messageRoom.id, "bob", "", { source: "browser", agent_prompt_kind: "auto" });
  await api!.createMessageAttachmentUpload({
    upload_id: "upload_read_1", room_id: messageRoom.id, uploader: null, filename: "notes.txt", content_type: "text/plain",
    byte_size: 12, storage_provider: "local", bucket: "test", object_key: "notes.txt", expires_at: at(-60),
  });
  const withFile = await api!.addMessage(messageRoom.id, "bob", "see file", { source: "browser", attachments: [{ upload_id: "upload_read_1" }] });
  for (let i = 1; i <= 3; i++) {
    await api!.addMessage(messageRoom.id, "bob", `reply ${i}`, { source: "browser", thread_root_message_id: ids[0] });
  }
  const at$ = (rest: string) => `/rooms/${encodeURIComponent(messageRoom.id)}${rest}`;

  const first = await get(at$("/messages?limit=25"), bob);
  assert.equal(first.status, 200);
  assert.ok(RecentMessages.safeParse(first.body).success);
  assert.equal(first.body.messages.length, 25);
  assert.deepEqual(first.body.messages.slice(0, 5).map((message: { text: string }) => message.text),
    ["reply 3", "reply 2", "reply 1", "see file", "GitHub: PR #1 opened"]);
  const [reply3, , , file, system] = first.body.messages;
  assert.equal(reply3.threadRootId, ids[0]);
  assert.equal(file.id, withFile.id);
  assert.deepEqual(file.attachments, [{ id: file.attachments[0].id, name: "notes.txt", contentType: "text/plain", byteSize: 12 }]);
  assert.equal(JSON.stringify(file).includes("download"), false);
  assert.deepEqual(system.sender, { name: "letagents", kind: "system", login: null, agentKey: null });
  assert.deepEqual(first.body.messages[5].sender, { name: "Ana | ada's agent | Claude Code", kind: "agent", login: null, agentKey: "ada/ana" });

  // Page back to the oldest message.
  const seen = [...first.body.messages];
  let before = first.body.nextBefore;
  while (before) {
    const page = await get(at$(`/messages?limit=25&before=${before}`), bob);
    seen.push(...page.body.messages);
    before = page.body.nextBefore;
  }
  assert.equal(seen.length, 65);
  assert.equal(seen.at(-1).id, ids[0]);
  assert.equal(seen.at(-1).replyCount, 3);
  assert.equal(seen.at(-1).threadRootId, null);
  assert.deepEqual(seen.at(-1).sender, { name: "bob", kind: "person", login: "bob", agentKey: null });

  const thread = await get(at$(`/messages/${ids[0]}/thread?limit=2`), bob);
  assert.equal(thread.status, 200);
  assert.ok(MessageThread.safeParse(thread.body).success);
  assert.equal(thread.body.root.id, ids[0]);
  assert.deepEqual(thread.body.replies.map((reply: { text: string }) => reply.text), ["reply 2", "reply 3"]);
  const older = await get(at$(`/messages/${ids[0]}/thread?limit=2&before=${thread.body.nextBefore}`), bob);
  assert.deepEqual(older.body.replies.map((reply: { text: string }) => reply.text), ["reply 1"]);
  assert.equal(older.body.nextBefore, null);

  assert.deepEqual(await get(at$("/messages/msg_9999/thread"), bob), {
    status: 404, body: { code: "not_found", message: "No message with this id in this room." },
  });
  assert.equal((await get(at$("/messages?before=42"), bob)).body.code, "invalid_input");
  assert.equal((await get(at$("/messages?limit=500"), bob)).body.code, "invalid_input");
});

test("tasks.list pages the board with assignees, reviewers, tickets and pull requests; tasks.get reads one", { skip }, async () => {
  const taskRoom = await api!.createProjectWithName("api-v1-read-tasks");
  await members!.addRoomMember({ roomId: taskRoom.id, accountId: bob.id, addedVia: "seed" });
  for (let i = 1; i <= 7; i++) await api!.createTask(taskRoom.id, `Task ${i}`, "bob", undefined, undefined, i === 1 ? { externalRef: "jira:HT-12" } : undefined);
  await api!.updateTask(taskRoom.id, "task_1", {
    status: "accepted", assignee: "Ana | ada's agent | Claude Code", assignee_agent_key: "ada/ana",
    pr_url: "https://github.com/acme/widgets/pull/7",
  });
  await api!.createTaskLease({ room_id: taskRoom.id, task_id: "task_1", kind: "review", agent_key: "bob/ola", actor_label: "Ola | bob's agent | Codex", created_by: "bob" });
  const at$ = (rest: string) => `/rooms/${encodeURIComponent(taskRoom.id)}${rest}`;

  const first = await get(at$("/tasks?limit=3"), bob);
  assert.equal(first.status, 200);
  assert.ok(TaskPage.safeParse(first.body).success);
  assert.deepEqual(first.body.tasks.map((task: { id: string }) => task.id), ["task_1", "task_2", "task_3"]);
  assert.equal(first.body.nextAfter, "task_3");
  const [task1] = first.body.tasks;
  assert.deepEqual({ ...task1, createdAt: undefined, updatedAt: undefined }, {
    id: "task_1", title: "Task 1", description: null, status: "accepted",
    assignee: { name: "Ana | ada's agent | Claude Code", agentKey: "ada/ana" },
    reviewers: [{ name: "Ola | bob's agent | Codex", agentKey: "bob/ola" }],
    createdBy: "bob", externalRef: "jira:HT-12", ticketKey: "HT-12", ticketState: null,
    pullRequests: [{ url: "https://github.com/acme/widgets/pull/7", number: 7, title: null, state: null, draft: null, checks: null, reviews: null }],
    createdAt: undefined, updatedAt: undefined,
  });

  const rest = await get(at$("/tasks?limit=3&after=task_6"), bob);
  assert.deepEqual(rest.body.tasks.map((task: { id: string }) => task.id), ["task_7"]);
  assert.equal(rest.body.nextAfter, null);
  assert.deepEqual((await get(at$("/tasks?status=accepted"), bob)).body.tasks.map((task: { id: string }) => task.id), ["task_1"]);

  const one = await get(at$("/tasks/task_2"), bob);
  assert.equal(one.status, 200);
  assert.ok(Task.safeParse(one.body).success);
  assert.equal(one.body.title, "Task 2");
  assert.deepEqual(await get(at$("/tasks/task_99"), bob), { status: 404, body: { code: "not_found", message: "No task with this id in this room." } });
});

test("planning.get gives columns, sprints with their tasks, task plans and the release queue", { skip }, async () => {
  const planRoom = await api!.createProjectWithName("api-v1-read-planning");
  await members!.addRoomMember({ roomId: planRoom.id, accountId: bob.id, addedVia: "seed" });
  for (let i = 1; i <= 3; i++) await api!.createTask(planRoom.id, `Plan ${i}`, "bob");
  await api!.updateTask(planRoom.id, "task_3", { status: "accepted" });
  await boardPlanning!.updateBoardPlanning(planRoom.id, "ada", {
    expectedRevision: 0,
    document: {
      columns: [
        { id: "todo", name: "To do", statuses: ["accepted", "assigned"] },
        { id: "progress", name: "In progress", statuses: ["in_progress", "blocked", "in_review"] },
        { id: "done", name: "Done", statuses: ["merged", "done"] },
      ],
      sprints: [{ id: "s1", name: "Sprint 1", state: "active", startDate: "2026-11-16", endDate: "2026-11-27", goal: "Ship the API" }],
      defaultTargetPoints: 16,
      sprintTargets: { s1: 20 },
      tasks: { task_1: { sprintId: "s1", estimate: 3 }, task_2: { priority: "high" } },
      releaseRule: { kind: "column", columnId: "todo" },
    },
  });

  const { status, body } = await get(`/rooms/${encodeURIComponent(planRoom.id)}/planning`, bob);
  assert.equal(status, 200);
  assert.ok(Planning.safeParse(body).success);
  assert.equal(body.revision, 1);
  assert.deepEqual(body.columns.map((column: { id: string }) => column.id), ["todo", "progress", "done"]);
  assert.deepEqual(body.sprints, [{
    id: "s1", name: "Sprint 1", state: "active", startDate: "2026-11-16", endDate: "2026-11-27", goal: "Ship the API",
    source: null, targetPoints: 20, taskIds: ["task_1"],
  }]);
  assert.deepEqual(body.tasks, [
    { taskId: "task_1", sprintId: "s1", estimate: 3, type: null, priority: null },
    { taskId: "task_2", sprintId: null, estimate: null, type: null, priority: "high" },
  ]);
  assert.deepEqual(body.releaseQueue, {
    rule: "column",
    items: [{ taskId: "task_3", title: "Plan 3", ticketKey: null, ticketUrl: null, owner: null, checkedAt: null, pullRequests: [] }],
    unavailable: 0,
  });
});

test("git.pullRequests lists open pull requests from stored events with checks, reviews and tasks", { skip }, async () => {
  // A room with no repository has no pull requests.
  assert.deepEqual((await get(room("/git/pull-requests"), bob)).body, { repo: null, pullRequests: [], truncated: false });

  await prEvent({ number: 1, action: "opened", state: "open", head: "sha1a", minutesAgo: 50 });
  await prEvent({ number: 1, action: "synchronize", state: "open", head: "sha1b", minutesAgo: 40, title: "Add the API" });
  await prEvent({ number: 2, action: "opened", state: "open", head: "sha2", minutesAgo: 30, metadata: { draft: true, author_login: "bob" } });
  await prEvent({ number: 3, action: "opened", state: "open", head: "sha3", minutesAgo: 60 });
  await prEvent({ number: 3, action: "closed", state: "merged", head: "sha3", minutesAgo: 20 });
  // Checks: one on the old head (ignored), a rerun on the new head (the newest counts).
  await prEvent({ eventType: "check_run", number: 1, objectId: "901", action: "completed", state: "failure", head: "sha1a", minutesAgo: 45, title: "test", metadata: { status: "completed", conclusion: "failure" } });
  await prEvent({ eventType: "check_run", number: 1, objectId: "902", action: "completed", state: "failure", head: "sha1b", minutesAgo: 39, title: "test", metadata: { status: "completed", conclusion: "failure" } });
  await prEvent({ eventType: "check_run", number: 1, objectId: "903", action: "completed", state: "success", head: "sha1b", minutesAgo: 35, title: "test", metadata: { status: "completed", conclusion: "success" } });
  await prEvent({ eventType: "check_run", number: 1, objectId: "904", action: "completed", state: "success", head: "sha1b", minutesAgo: 35, title: "lint", metadata: { status: "completed", conclusion: "success" } });
  // Reviews: cy approved, then commented (the approval stands); dee asked for changes.
  await prEvent({ eventType: "pull_request_review", number: 1, action: "submitted", state: "approved", head: "sha1b", minutesAgo: 34, actor: "cy", url: "https://github.com/acme/widgets/pull/1#pullrequestreview-1" });
  await prEvent({ eventType: "pull_request_review", number: 1, action: "submitted", state: "commented", head: "sha1b", minutesAgo: 33, actor: "cy", url: "https://github.com/acme/widgets/pull/1#pullrequestreview-2" });
  await prEvent({ eventType: "pull_request_review", number: 1, action: "submitted", state: "changes_requested", head: "sha1b", minutesAgo: 32, actor: "dee", url: "https://github.com/acme/widgets/pull/1#pullrequestreview-3" });
  // Review requests: eve still asked; cy asked before she reviewed; fay asked, then removed.
  for (const [login, action, minutesAgo] of [["eve", "review_requested", 38], ["cy", "review_requested", 37], ["fay", "review_requested", 37], ["fay", "review_request_removed", 36]] as const) {
    await prEvent({ number: 1, action, state: "open", head: "sha1b", minutesAgo, actor: "ada", metadata: { participant: { role: "reviewer", change: action === "review_requested" ? "added" : "removed", login } } });
  }
  await api!.createTask(REPO_ROOM, "Build the API", "ada");
  await api!.updateTask(REPO_ROOM, "task_1", { pr_url: "https://github.com/acme/widgets/pull/1" });

  const { status, body } = await get(repoRoom("/git/pull-requests"), ada);
  assert.equal(status, 200);
  assert.ok(PullRequestList.safeParse(body).success);
  assert.equal(body.repo, "acme/widgets");
  assert.equal(body.truncated, false);
  assert.deepEqual(body.pullRequests.map((pr: { number: number }) => pr.number), [2, 1]);
  const [draft, pr1] = body.pullRequests;
  assert.equal(draft.draft, true);
  assert.equal(draft.author, "bob");
  assert.deepEqual({ ...pr1, updatedAt: undefined }, {
    number: 1, title: "Add the API", url: "https://github.com/acme/widgets/pull/1", author: "ada", draft: false,
    headRef: "feature-1", baseRef: "main", updatedAt: undefined,
    checks: { total: 2, success: 2, failure: 0, pending: 0 },
    checkRuns: [
      { name: "lint", status: "completed", conclusion: "success", url: "https://github.com/acme/widgets/pull/1" },
      { name: "test", status: "completed", conclusion: "success", url: "https://github.com/acme/widgets/pull/1" },
    ],
    reviews: { total: 2, approved: 1, changesRequested: 1 },
    reviewers: [{ login: "dee", state: "changes_requested" }, { login: "cy", state: "approved" }],
    requestedReviewers: ["eve"],
    taskIds: ["task_1"],
  });
  assert.ok(Math.abs(Date.parse(pr1.updatedAt) - Date.parse(at(40))) < 60_000);
});

test("memory.list gives the room's facts, current ones first", { skip }, async () => {
  const author = { id: ada.id, label: "ada", kind: "human" as const };
  const at10 = at(10);
  await knowledge!.createRoomKnowledge(createKnowledgeRecord(roomId, "memory",
    { client_id: "fact-0001", category: "decision", title: "Use zod 4", body: "One schema library.", source_url: "https://example.com/adr" }, author, at10));
  const old = await knowledge!.createRoomKnowledge(createKnowledgeRecord(roomId, "memory",
    { client_id: "fact-0002", category: "term", title: "Room", body: "A place for agents." }, { id: "agent", label: "Ana", kind: "agent" }, at(20)));
  await knowledge!.reviseRoomKnowledge({ ...old, archived: true, version: 2, updated_at: at(5), updated_by: author }, 1);

  const { status, body } = await get(room("/memory"), bob);
  assert.equal(status, 200);
  assert.ok(MemoryList.safeParse(body).success);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.facts.map((fact: { title: string; archived: boolean }) => [fact.title, fact.archived]), [["Use zod 4", false], ["Room", true]]);
  assert.deepEqual(body.facts[0], {
    id: body.facts[0].id, category: "decision", title: "Use zod 4", body: "One schema library.", sourceUrl: "https://example.com/adr",
    sourceMessageId: null, author: { name: "ada", kind: "person" }, updatedBy: { name: "ada", kind: "person" },
    createdAt: at10, updatedAt: at10, archived: false,
  });
  assert.deepEqual(body.facts[1].author, { name: "Ana", kind: "agent" });
});
