import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const myWork = url ? await import("../connectors/my-work.js") : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? "Set TEST_DB_URL to run PostgreSQL integration tests." : false };

let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 21, 10, minute)).toISOString();

async function account(label: string) {
  const now = new Date().toISOString();
  const id = unique(`acct-${label}`);
  await client!.db.insert(schema!.accounts).values({
    id, provider: "github", provider_user_id: id, login: id, display_name: label, avatar_url: null, created_at: now, updated_at: now,
  });
  return { id, login: id };
}

async function connection(accountId: string, siteKey: string, trackerUserId: string | null) {
  const id = `tcon_${crypto.randomUUID()}`;
  await client!.db.insert(schema!.tracker_connections).values({
    id, account_id: accountId, provider: "jira", display_name: "acme", site_key: siteKey, site_url: "https://acme.atlassian.net",
    auth_kind: "api_token", credentials_ciphertext: "sealed", credentials_iv: "iv", credentials_version: 1,
    tracker_user_id: trackerUserId, tracker_user_label: trackerUserId, status_map: {},
  });
  return id;
}

async function room(label: string, ...admins: string[]) {
  const created = await db!.createProjectWithName(unique(label));
  for (const accountId of admins) {
    await client!.db.insert(schema!.project_admins).values({ project_id: created.id, account_id: accountId, assigned_at: new Date().toISOString() });
  }
  return created.id;
}

/** A card; `item` binds it to a synced ticket on a connection. */
async function card(roomId: string, title: string, input: {
  updatedMinute: number;
  ref?: string;
  item?: { connectionId: string; assigneeId: string | null; ticketState: string };
  assignee?: string;
  agentKey?: string;
  status?: string;
}) {
  const task = await db!.createTask(roomId, title, "human:test", undefined, undefined, { externalRef: input.ref ?? null });
  const number = Number(task.id.slice("task_".length));
  let itemId: string | null = null;
  if (input.item) {
    itemId = `ext_${crypto.randomUUID()}`;
    await client!.db.insert(schema!.external_items).values({
      id: itemId, connection_id: input.item.connectionId, provider: "jira", key: input.ref!.split(":")[1]!, title,
      ticket_state: input.item.ticketState, raw_status: "In Review", assignee_id: input.item.assigneeId, assignee_label: "Someone",
      url: `https://acme.atlassian.net/browse/${input.ref!.split(":")[1]}`, payload: {}, synced_at: at(0),
    });
  }
  await client!.pool.query(
    `UPDATE tasks SET external_item_id = $3, ticket_state = $4, assignee = $5, assignee_agent_key = $6,
            status = COALESCE($7::task_status, status), updated_at = $8 WHERE room_id = $1 AND number = $2`,
    [roomId, number, itemId, input.item?.ticketState ?? null, input.assignee ?? null, input.agentKey ?? null, input.status ?? null, at(input.updatedMinute)],
  );
  return task.id;
}

async function githubEvent(roomId: string, values: {
  type: string; action: string; url: string; taskId?: string; state?: string; actor?: string; metadata?: Record<string, unknown>; minute: number;
}) {
  const id = `ghe_${crypto.randomUUID()}`;
  await client!.db.insert(schema!.github_room_events).values({
    id, room_id: roomId, event_type: values.type, action: values.action, idempotency_key: id, github_object_id: "88",
    github_object_url: values.url, title: "Proration fix", state: values.state ?? null, actor_login: values.actor ?? null,
    event_order_at: at(values.minute), created_at: at(values.minute), linked_task_id: values.taskId ?? null,
    metadata: (values.metadata ?? {}) as never,
  });
}

test("a ticket assigned to my tracker user on the same site is my work; others are not", options, async () => {
  const me = await account("emmy");
  const teammate = await account("ada");
  const site = unique("acme.atlassian.net");
  // The room imports through the teammate's connection; my connection only names my tracker user.
  const theirs = await connection(teammate.id, site, "u-ada");
  await connection(me.id, site, "u-emmy");
  const otherSite = await connection(teammate.id, unique("other.atlassian.net"), "u-other");
  const roomId = await room("tickets", me.id, teammate.id);

  const mine = await card(roomId, "Proration", { updatedMinute: 5, ref: "jira:HT-1234", item: { connectionId: theirs, assigneeId: "u-emmy", ticketState: "in_review" } });
  await card(roomId, "Ada's ticket", { updatedMinute: 6, ref: "jira:HT-2", item: { connectionId: theirs, assigneeId: "u-ada", ticketState: "todo" } });
  await card(roomId, "Same id, other site", { updatedMinute: 7, ref: "jira:HT-3", item: { connectionId: otherSite, assigneeId: "u-emmy", ticketState: "todo" } });
  // A bound card counts by its ticket only: assigning it to me natively does not add it.
  await card(roomId, "Bound, natively mine", { updatedMinute: 8, ref: "jira:HT-4", item: { connectionId: theirs, assigneeId: "u-ada", ticketState: "todo" }, assignee: me.login });

  const page = await myWork!.listMyWork({ accountId: me.id, login: me.login });
  assert.deepEqual(page.cards.map((entry) => entry.task_id), [mine]);
  const [row] = page.cards;
  assert.equal(page.has_connections, true);
  assert.deepEqual(page.providers, ["jira"]);
  assert.equal(row!.assigned_via, "tracker");
  assert.equal(row!.key, "HT-1234");
  assert.equal(row!.provider, "jira");
  assert.equal(row!.ticket_state, "in_review");
  assert.equal(row!.ticket_status, "In Review");
  assert.match(row!.ticket_url ?? "", /^https:\/\/acme\.atlassian\.net\/browse\/HT-1234$/);

  // The teammate sees only their own ticket (and the bound card the tracker gave them).
  const theirsPage = await myWork!.listMyWork({ accountId: teammate.id, login: teammate.login });
  assert.deepEqual(theirsPage.cards.map((entry) => entry.title).sort(), ["Ada's ticket", "Bound, natively mine"]);
});

test("zero-connector mode lists native cards assigned to me or my agent", options, async () => {
  const me = await account("solo");
  const roomId = await room("native", me.id);
  const byLogin = await card(roomId, "Assigned to my login", { updatedMinute: 1, assignee: me.login.toUpperCase() });
  const now = new Date().toISOString();
  await client!.db.insert(schema!.room_agent_sessions).values({
    session_id: unique("sess"), room_id: roomId, token_hash: unique("hash"), session_kind: "worker", runtime: "claude",
    actor_label: "MapleRidge", agent_key: "agent:maple", display_name: "MapleRidge", owner_account_id: me.id,
    owner_label: "solo", ide_label: "desktop", created_at: now, updated_at: now, last_seen_at: now,
  });
  await client!.db.insert(schema!.room_agent_presence).values({
    room_id: roomId, actor_label: "MapleRidge", agent_key: "agent:maple", display_name: "MapleRidge", status: "working", runtime: "claude", ide_label: "desktop",
    status_text: "Running the proration tests", last_heartbeat_at: now, created_at: now, updated_at: now,
  });
  const byAgent = await card(roomId, "My agent's card", { updatedMinute: 2, agentKey: "agent:maple", assignee: "MapleRidge" });
  await card(roomId, "Someone else's", { updatedMinute: 3, assignee: "somebody" });
  await card(roomId, "Finished", { updatedMinute: 4, assignee: me.login, status: "done" });

  const page = await myWork!.listMyWork({ accountId: me.id, login: me.login });
  assert.equal(page.has_connections, false);
  assert.deepEqual(page.providers, []);
  assert.deepEqual(page.cards.map((entry) => entry.task_id), [byAgent, byLogin]);
  assert.equal(page.cards[0]!.ticket_state, null);
  assert.equal(page.cards[0]!.assigned_via, "native");
  assert.deepEqual(page.cards[0]!.agent, {
    provider: "claude", label: "MapleRidge", agent_key: "agent:maple", display_name: "MapleRidge", status: "working",
    status_text: "Running the proration tests", last_heartbeat_at: page.cards[0]!.agent!.last_heartbeat_at,
  });

  assert.equal(page.cards[1]!.agent!.provider, null, "human assignee does not receive an agent provider");
  await client!.pool.query("UPDATE room_agent_presence SET runtime = $1, ide_label = $2 WHERE room_id = $3 AND agent_key = $4", ["unknown", "Codex", roomId, "agent:maple"]);
  const fallback = await myWork!.listMyWork({ accountId: me.id, login: me.login });
  assert.equal(fallback.cards[0]!.agent!.provider, "Codex", "recorded IDE supplies a fallback for unknown runtime");

  // Paging: one card a page, newest first, then nothing.
  const first = await myWork!.listMyWork({ accountId: me.id, login: me.login, limit: 1 });
  assert.deepEqual(first.cards.map((entry) => entry.task_id), [byAgent]);
  assert.ok(first.next_cursor);
  const second = await myWork!.listMyWork({ accountId: me.id, login: me.login, limit: 1, cursor: first.next_cursor });
  assert.deepEqual(second.cards.map((entry) => entry.task_id), [byLogin]);
  assert.equal(second.next_cursor, null);
});

test("needs me: review requested of me, an open request on the card, a done ticket with an open PR", options, async () => {
  const me = await account("reviewer");
  const site = unique("acme.atlassian.net");
  const conn = await connection(me.id, site, "u-me");
  const roomId = await room("signals", me.id);
  const pr = (n: number) => `https://github.com/acme/app/pull/${n}`;

  const review = await card(roomId, "Review me", { updatedMinute: 1, ref: "jira:HT-10", item: { connectionId: conn, assigneeId: "u-me", ticketState: "in_review" } });
  await githubEvent(roomId, { type: "pull_request", action: "opened", url: pr(10), taskId: review, state: "open", minute: 1 });
  await githubEvent(roomId, { type: "pull_request", action: "review_requested", url: pr(10), taskId: review, state: "open", minute: 2,
    metadata: { participant: { role: "reviewer", change: "added", login: me.login.toUpperCase() } } });

  const asked = await card(roomId, "Asked about", { updatedMinute: 2, ref: "jira:HT-11", item: { connectionId: conn, assigneeId: "u-me", ticketState: "in_progress" } });
  await client!.db.insert(schema!.room_knowledge).values({
    room_id: roomId, id: unique("attention"), type: "attention", version: 1,
    value: { category: "decision", title: "Ship HT-11 behind a flag?", body: "", archived: false, response: null } as never,
  });

  const done = await card(roomId, "Done but open", { updatedMinute: 3, ref: "jira:HT-12", item: { connectionId: conn, assigneeId: "u-me", ticketState: "done" } });
  await githubEvent(roomId, { type: "pull_request", action: "opened", url: pr(12), taskId: done, state: "open", minute: 3 });

  const quiet = await card(roomId, "Nothing to do", { updatedMinute: 4, ref: "jira:HT-13", item: { connectionId: conn, assigneeId: "u-me", ticketState: "in_review" } });
  await githubEvent(roomId, { type: "pull_request", action: "opened", url: pr(13), taskId: quiet, state: "open", minute: 4 });
  await githubEvent(roomId, { type: "pull_request", action: "review_requested", url: pr(13), taskId: quiet, state: "open", minute: 5,
    metadata: { participant: { role: "reviewer", change: "added", login: me.login } } });
  await githubEvent(roomId, { type: "pull_request_review", action: "submitted", url: `${pr(13)}#pullrequestreview-1`, taskId: quiet, state: "approved", actor: me.login, minute: 6 });

  const page = await myWork!.listMyWork({ accountId: me.id, login: me.login });
  const reasons = Object.fromEntries(page.cards.map((entry) => [entry.title, entry.needs_me_reasons]));
  assert.deepEqual(reasons, {
    "Review me": ["review_requested"],
    "Asked about": ["human_request"],
    "Done but open": ["ticket_done_pr_open"],
    "Nothing to do": [],
  });
  const reviewed = page.cards.find((entry) => entry.title === "Nothing to do")!;
  assert.equal(reviewed.pull_requests[0]?.url, pr(13));
  assert.deepEqual(reviewed.pull_requests[0]?.review_summary, { total: 1, approved: 1, changes_requested: 0 });

  const needsMe = await myWork!.listMyWork({ accountId: me.id, login: me.login, needsMe: true, limit: 2 });
  assert.deepEqual(needsMe.cards.map((entry) => entry.task_id), [done, asked]);
  assert.ok(needsMe.next_cursor);
  const rest = await myWork!.listMyWork({ accountId: me.id, login: me.login, needsMe: true, limit: 2, cursor: needsMe.next_cursor });
  assert.deepEqual(rest.cards.map((entry) => entry.task_id), [review]);
  assert.equal(rest.next_cursor, null);

  // A room the account can no longer read drops out, and the page still fills from the rest.
  const denied = await myWork!.listMyWork({ accountId: me.id, login: me.login }, { canReadRoom: async (_account, id) => id !== roomId });
  assert.deepEqual(denied.cards, []);
  assert.equal(denied.next_cursor, null);

  // Filters: room and tracker.
  assert.equal((await myWork!.listMyWork({ accountId: me.id, login: me.login, tracker: "native" })).cards.length, 0);
  assert.equal((await myWork!.listMyWork({ accountId: me.id, login: me.login, roomId: "no-such-room" })).cards.length, 0);
  assert.equal((await myWork!.listMyWork({ accountId: me.id, login: me.login, tracker: "jira", roomId })).cards.length, 4);
});

test("finished work leaves the page unless its ticket is still open", options, async () => {
  const me = await account("finisher");
  const conn = await connection(me.id, unique("acme.atlassian.net"), "u-fin");
  const roomId = await room("finished", me.id);
  const open = await card(roomId, "Merged, ticket open", { updatedMinute: 1, ref: "jira:HT-20", item: { connectionId: conn, assigneeId: "u-fin", ticketState: "in_review" }, status: "merged" });
  const done = await card(roomId, "Done everywhere", { updatedMinute: 2, ref: "jira:HT-21", item: { connectionId: conn, assigneeId: "u-fin", ticketState: "done" }, status: "done" });
  const cancelled = await card(roomId, "Cancelled native", { updatedMinute: 3, assignee: me.login, status: "cancelled" });
  const page = await myWork!.listMyWork({ accountId: me.id, login: me.login });
  assert.deepEqual(page.cards.map((entry) => entry.task_id), [open]);
  assert.deepEqual((await myWork!.listMyWork({ accountId: me.id, login: me.login, includeCompleted: false })).cards.map((entry) => entry.task_id), [open]);

  // Opting in keeps the same ownership and room fences, and pages at the same bound.
  await card(roomId, "Someone else's completed work", { updatedMinute: 4, assignee: "someone-else", status: "done" });
  const query = { accountId: me.id, login: me.login, includeCompleted: true, limit: 2 };
  const first = await myWork!.listMyWork(query);
  assert.deepEqual(first.cards.map((entry) => entry.task_id), [cancelled, done]);
  assert.ok(first.next_cursor);
  const second = await myWork!.listMyWork({ ...query, cursor: first.next_cursor });
  assert.deepEqual(second.cards.map((entry) => entry.task_id), [open]);
  assert.equal(second.next_cursor, null);
  const native = await myWork!.listMyWork({ ...query, tracker: "native", roomId });
  assert.deepEqual(native.cards.map((entry) => entry.task_id), [cancelled]);
  const denied = await myWork!.listMyWork(query, { canReadRoom: async () => false });
  assert.deepEqual(denied.cards, []);
});

test("a private repo room the account cannot read is left out, through the real access check", options, async () => {
  const me = await account("outsider");
  const repoRoomId = `github.com/my-work-test/${unique("private").toLowerCase()}`;
  const { room: repoRoom } = await db!.getOrCreateCanonicalRoom(repoRoomId);
  await client!.db.insert(schema!.project_admins).values({ project_id: repoRoom.id, account_id: me.id, assigned_at: new Date().toISOString() });
  const openRoom = await room("open", me.id);
  const hidden = await card(repoRoom.id, "In the private repo", { updatedMinute: 2, assignee: me.login });
  const shown = await card(openRoom, "In a plain room", { updatedMinute: 1, assignee: me.login });

  // GitHub does not show the repository to an anonymous caller, and the
  // account holds no GitHub token: the access check does not allow it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes("api.github.com")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return realFetch(input);
  }) as typeof fetch;
  try {
    const page = await myWork!.listMyWork({ accountId: me.id, login: me.login });
    assert.deepEqual(page.cards.map((entry) => `${entry.room_id}/${entry.task_id}`), [`${openRoom}/${shown}`]);
    assert.ok(!page.cards.some((entry) => entry.task_id === hidden && entry.room_id === repoRoom.id));
  } finally {
    globalThis.fetch = realFetch;
  }
});
