import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { ExternalItem, ProviderConnection, WorkItemProvider } from "../connectors/providers/types.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const sync = url ? await import("../connectors/sync.js") : null;
const filters = url ? await import("../connectors/room-filters.js") : null;
const merge = url ? await import("../connectors/card-merge.js") : null;
const keys = url ? await import("../connectors/key-task-resolution.js") : null;
const details = url ? await import("../connectors/ticket-details.js") : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? "Set TEST_DB_URL to run PostgreSQL integration tests." : false };

let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;

function item(key: string, ticketState: ExternalItem["ticket_state"], updatedAt: string, rawStatus = "In Progress"): ExternalItem {
  return {
    provider: "jira",
    key,
    title: `Ticket ${key}`,
    ticket_state: ticketState,
    raw_status: rawStatus,
    unmapped: false,
    assignee_id: "acc-1",
    assignee_label: "Emmy",
    url: `https://acme.atlassian.net/browse/${key}`,
    tracker_updated_at: updatedAt,
    payload: {},
  };
}

/**
 * A Jira provider that answers from in-memory tickets and counts calls. It
 * reads `project = X` and `key = "K"` from the JQL, and honours the limit and
 * the updated window, newest first, as Jira does.
 */
function fakeJira(tickets: Map<string, ExternalItem>) {
  const calls = {
    listItems: [] as Array<{ filter: string | null; updatedSince?: string; updatedBefore?: string }>,
    getItem: [] as string[],
  };
  const provider = {
    name: "jira",
    async listItems(_conn: ProviderConnection, filter: string | null, opts: { updatedSince?: string; updatedBefore?: string; limit?: number }) {
      calls.listItems.push({ filter, updatedSince: opts.updatedSince, updatedBefore: opts.updatedBefore });
      const project = /project = (\w+)/.exec(filter ?? "")?.[1];
      const key = /key = "([^"]+)"/.exec(filter ?? "")?.[1];
      return [...tickets.values()]
        .filter((entry) => !project || entry.key.startsWith(`${project}-`))
        .filter((entry) => !key || entry.key === key)
        .filter((entry) => !opts.updatedBefore || Date.parse(entry.tracker_updated_at!) <= Date.parse(opts.updatedBefore))
        .sort((a, b) => Date.parse(b.tracker_updated_at!) - Date.parse(a.tracker_updated_at!))
        .slice(0, opts.limit ?? 50);
    },
    async getItem(_conn: ProviderConnection, key: string) {
      calls.getItem.push(key);
      return tickets.get(key) ?? null;
    },
  } as unknown as WorkItemProvider;
  return { provider, calls };
}

async function setup(label: string, tickets = new Map<string, ExternalItem>()) {
  const now = new Date().toISOString();
  const accountId = unique(`acct-${label}`);
  await client!.db.insert(schema!.accounts).values({
    id: accountId, provider: "github", provider_user_id: accountId, login: accountId, display_name: accountId,
    avatar_url: null, created_at: now, updated_at: now,
  });
  const connectionId = `tcon_${crypto.randomUUID()}`;
  const [connection] = await client!.db.insert(schema!.tracker_connections).values({
    id: connectionId, account_id: accountId, provider: "jira", display_name: "acme", site_key: unique("acme.atlassian.net"),
    site_url: "https://acme.atlassian.net", auth_kind: "api_token", credentials_ciphertext: "sealed", credentials_iv: "iv",
    credentials_version: 1, tracker_user_id: "acc-1", tracker_user_label: "Emmy", status_map: {},
  }).returning();
  const room = await db!.createProjectWithName(unique(`tickets-${label}`));
  await filters!.upsertRoomTrackerFilter({ room_id: room.id, connection_id: connectionId, filter: "project = HT", enabled: true, account_id: accountId });
  const [filter] = await client!.db.select().from(schema!.room_tracker_filters)
    .where((await import("drizzle-orm")).eq(schema!.room_tracker_filters.room_id, room.id));
  const jira = fakeJira(tickets);
  const service = sync!.createTrackerSync({
    providers: { jira: jira.provider, linear: jira.provider },
    connections: {
      open: () => ({ id: connectionId } as ProviderConnection),
      recordFailure: async (_row, error) => String(error),
    },
    store: {
      get: async (id) => (id === connectionId ? connection! : null),
      addUnmapped: async () => undefined,
    },
  });
  return { room, connection: connection!, filter: filter!, tickets, jira, service, accountId };
}

async function roomTasks(roomId: string) {
  return (await db!.getTasks(roomId)).tasks;
}

async function count(query: string, params: unknown[]): Promise<number> {
  return (await client!.pool.query(query, params)).rows[0].n;
}

const trackerEvents = (roomId: string) => count(
  "SELECT count(*)::int AS n FROM github_room_events WHERE room_id = $1 AND event_type = 'tracker_ticket'", [roomId]);

test("poll and webhook deliver the same change with one upsert and no duplicate card", options, async () => {
  const ctx = await setup("poll-webhook");
  ctx.tickets.set("HT-1", item("HT-1", "todo", "2026-10-21T10:00:00.000Z", "To Do"));

  const first = await ctx.service.syncFilter(ctx.filter);
  assert.deepEqual(first, { seen: 1, changed: 1, error: null });
  assert.equal(ctx.jira.calls.listItems[0]?.filter, "project = HT");
  assert.equal(ctx.jira.calls.listItems[0]?.updatedSince, undefined);
  const [card] = await roomTasks(ctx.room.id);
  assert.equal(card?.external_ref, "jira:HT-1");
  assert.equal(card?.ticket_state, "todo");
  assert.equal(card?.status, "proposed");
  assert.equal(card?.created_by, "tracker:jira");

  // The tracker moves the ticket; the webhook arrives first, then a poll sees the same change.
  ctx.tickets.set("HT-1", item("HT-1", "in_progress", "2026-10-21T10:05:00.000Z"));
  assert.deepEqual(await ctx.service.handleWebhook(ctx.connection, [{ key: "HT-1", item: null, deleted: false }]), { applied: 1 });
  const [refreshed] = await client!.db.select().from(schema!.room_tracker_filters)
    .where((await import("drizzle-orm")).eq(schema!.room_tracker_filters.id, ctx.filter.id));
  const second = await ctx.service.syncFilter({ ...refreshed!, sync_claimed_at: refreshed!.sync_claimed_at });
  assert.equal(second.changed, 0, "the poll finds nothing new after the webhook");
  assert.ok(ctx.jira.calls.listItems[1]?.updatedSince, "the second poll asks only for recent changes");

  // Two deliveries of one change at once still write once.
  ctx.tickets.set("HT-1", item("HT-1", "in_review", "2026-10-21T10:09:00.000Z", "In Review"));
  const results = await Promise.all([
    ctx.service.applyItem(ctx.connection, ctx.tickets.get("HT-1")!, { roomIds: [ctx.room.id] }),
    ctx.service.applyItem(ctx.connection, ctx.tickets.get("HT-1")!, { roomIds: [ctx.room.id] }),
  ]);
  assert.deepEqual(results.map((result) => result.changed).sort(), [false, true]);

  // An older copy (a slow poll) never undoes a newer one.
  const stale = await ctx.service.applyItem(ctx.connection, item("HT-1", "todo", "2026-10-21T09:00:00.000Z"));
  assert.equal(stale.stale, true);

  const tasks = await roomTasks(ctx.room.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.ticket_state, "in_review");
  assert.equal(await count("SELECT count(*)::int AS n FROM external_items WHERE connection_id = $1", [ctx.connection.id]), 1);
  // imported, then todo → in_progress, then in_progress → in_review.
  assert.equal(await trackerEvents(ctx.room.id), 3);
  const events = await db!.getGitHubRoomEvents({ room_id: ctx.room.id, limit: 10 });
  assert.ok(events.events.every((event) => (event.metadata as Record<string, unknown>)?.source === "tracker_sync"));

  const ticket = await details!.getTaskTicketDetails(ctx.room.id, tasks[0]!.id);
  assert.equal(ticket?.raw_status, "In Review");
  assert.equal(ticket?.assignee_label, "Emmy");
  assert.equal(ticket?.url, "https://acme.atlassian.net/browse/HT-1");
});

test("a ticket moved to Done updates ticket_state only and leaves the work state alone", options, async () => {
  const ctx = await setup("done");
  ctx.tickets.set("HT-2", item("HT-2", "in_progress", "2026-10-21T10:00:00.000Z"));
  await ctx.service.syncFilter(ctx.filter);
  const [card] = await roomTasks(ctx.room.id);
  await db!.updateTask(ctx.room.id, card!.id, { status: "accepted" });
  await db!.updateTask(ctx.room.id, card!.id, { status: "assigned", assignee: "agent-1" });
  await db!.updateTask(ctx.room.id, card!.id, { status: "in_progress" });
  await db!.updateTask(ctx.room.id, card!.id, { title: "Our own title" });

  ctx.tickets.set("HT-2", item("HT-2", "done", "2026-10-21T11:00:00.000Z", "Done"));
  await ctx.service.handleWebhook(ctx.connection, [{ key: "HT-2", item: null, deleted: false }]);
  const after = await db!.getTaskById(ctx.room.id, card!.id);
  assert.equal(after?.ticket_state, "done");
  assert.equal(after?.status, "in_progress");
  assert.equal(after?.assignee, "agent-1");
  // An imported card follows the ticket's title.
  assert.equal(after?.title, "Ticket HT-2");
});

test("linking a native card merges the imported card and keeps artifacts and mentions", options, async () => {
  const ctx = await setup("merge");
  ctx.tickets.set("HT-3", item("HT-3", "in_review", "2026-10-21T10:00:00.000Z", "In Review"));
  await ctx.service.syncFilter(ctx.filter);
  const [imported] = await roomTasks(ctx.room.id);
  const importedPr = "https://github.com/BrosInCode/letagents/pull/301";
  await db!.updateTask(ctx.room.id, imported!.id, { pr_url: importedPr });
  const mention = await db!.addMessage(ctx.room.id, "human", "HT-3 needs a look");
  const native = await db!.createTask(ctx.room.id, "Our proration card", "human");
  const nativePr = "https://github.com/BrosInCode/letagents/pull/300";
  await db!.updateTask(ctx.room.id, native.id, { pr_url: nativePr });
  assert.equal((await db!.getTaskMentions(ctx.room.id, imported!.id)).length, 1);

  const result = await merge!.mergeImportedCardIntoNative({ room_id: ctx.room.id, native_task_id: native.id, external_ref: "jira:HT-3" });
  assert.deepEqual(result, { merged: true, imported_task_id: imported!.id });

  assert.equal(await db!.getTaskById(ctx.room.id, imported!.id), undefined);
  const kept = await db!.getTaskById(ctx.room.id, native.id);
  assert.equal(kept?.external_ref, "jira:HT-3");
  assert.equal(kept?.ticket_state, "in_review");
  assert.equal(kept?.title, "Our proration card");
  assert.equal(kept?.pr_url, nativePr);
  const urls = kept!.workflow_artifacts.map((artifact) => artifact.url);
  assert.ok(urls.includes(nativePr) && urls.includes(importedPr), "both pull requests stay on the card");
  assert.deepEqual((await db!.getTaskMentions(ctx.room.id, native.id)).map((entry) => entry.message_id), [mention.id]);
  assert.ok((await db!.getRoomSharedArtifacts({ room_id: ctx.room.id, task_id: native.id }))
    .some((artifact) => artifact.url === importedPr), "the imported card's shared artifact moves");
  assert.equal(await count("SELECT count(*)::int AS n FROM github_room_events WHERE room_id = $1 AND linked_task_id = $2",
    [ctx.room.id, imported!.id]), 0);

  // Later syncs update the native card, not a new duplicate.
  ctx.tickets.set("HT-3", item("HT-3", "done", "2026-10-21T12:00:00.000Z", "Done"));
  await ctx.service.applyItem(ctx.connection, ctx.tickets.get("HT-3")!, { roomIds: [ctx.room.id] });
  const tasks = await roomTasks(ctx.room.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.ticket_state, "done");
  assert.equal(tasks[0]?.title, "Our proration card", "a native card keeps its own title");

  // A card a person created is never merged away.
  const other = await db!.createTask(ctx.room.id, "Another", "human");
  assert.deepEqual(
    await merge!.mergeImportedCardIntoNative({ room_id: ctx.room.id, native_task_id: other.id, external_ref: "jira:HT-3" }),
    { merged: false, imported_task_id: null },
  );
});

test("a merge waits while an agent works on the imported card", options, async () => {
  const ctx = await setup("merge-busy");
  ctx.tickets.set("HT-4", item("HT-4", "todo", "2026-10-21T10:00:00.000Z", "To Do"));
  await ctx.service.syncFilter(ctx.filter);
  const [imported] = await roomTasks(ctx.room.id);
  const now = new Date().toISOString();
  await client!.db.insert(schema!.task_leases).values({
    id: unique("lease"), room_id: ctx.room.id, task_id: imported!.id, kind: "work", status: "active", agent_key: "agent-1",
    actor_label: "agent-1", created_by: "agent-1", created_at: now, updated_at: now,
  });
  const native = await db!.createTask(ctx.room.id, "Native", "human");
  await assert.rejects(
    merge!.mergeImportedCardIntoNative({ room_id: ctx.room.id, native_task_id: native.id, external_ref: "jira:HT-4" }),
    (error: unknown) => error instanceof merge!.ImportedCardBusyError,
  );
  assert.ok(await db!.getTaskById(ctx.room.id, imported!.id));
});

test("a pull request naming an unknown key imports the ticket into a room with a filter", options, async () => {
  const ctx = await setup("auto-import");
  ctx.tickets.set("HT-5", item("HT-5", "in_progress", "2026-10-21T10:00:00.000Z"));
  const task = await keys!.findTaskByTicketKeys(ctx.room.id, { branchRef: "HT-5-proration", title: "Round", body: null }, {
    importTicket: (roomId, matches) => ctx.service.importTicketForRoom(roomId, matches),
  });
  assert.equal(task?.external_ref, "jira:HT-5");
  assert.equal(task?.ticket_state, "in_progress");
  assert.equal(ctx.jira.calls.listItems.at(-1)?.filter, '(project = HT) AND key = "HT-5"', "the import asks with the room's filter");
  assert.deepEqual(ctx.jira.calls.getItem, ["HT-5"]);

  // A ticket outside the room's filter is never read into the room.
  ctx.tickets.set("SEC-42", item("SEC-42", "todo", "2026-10-21T10:00:00.000Z"));
  assert.equal(await keys!.findTaskByTicketKeys(ctx.room.id, { branchRef: null, title: "SEC-42 fix", body: null }, {
    importTicket: (roomId, matches) => ctx.service.importTicketForRoom(roomId, matches),
  }), undefined);
  assert.equal((await roomTasks(ctx.room.id)).some((entry) => entry.external_ref === "jira:SEC-42"), false);

  // A key the tracker does not know is asked for once, then remembered.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(await keys!.findTaskByTicketKeys(ctx.room.id, { branchRef: "HT-404-x", title: null, body: null }, {
      importTicket: (roomId, matches) => ctx.service.importTicketForRoom(roomId, matches),
    }), undefined);
  }
  assert.equal(ctx.jira.calls.getItem.filter((key) => key === "HT-404").length, 1);
  assert.equal(ctx.jira.calls.listItems.filter((call) => call.filter?.includes('"HT-404"')).length, 0, "a missing key never reaches JQL");
});

test("a room without a filter runs no sync and gets no ticket state", options, async () => {
  const ctx = await setup("zero");
  const bare = await db!.createProjectWithName(unique("tickets-zero-room"));
  const native = await db!.createTask(bare.id, "Native card", "human", undefined, undefined, { externalRef: "jira:HT-6" });

  assert.deepEqual(await filters!.getRoomTrackerScope(bare.id), { sources: [], linearTeamKeys: [] });
  let imports = 0;
  const plain = await db!.createProjectWithName(unique("tickets-zero-plain"));
  assert.equal(await keys!.findTaskByTicketKeys(plain.id, { branchRef: "HT-6-x", title: null, body: null }, {
    importTicket: async () => { imports += 1; return undefined; },
  }), undefined);
  assert.equal(imports, 0, "no import is tried without a filter");

  ctx.tickets.set("HT-6", item("HT-6", "done", "2026-10-21T10:00:00.000Z", "Done"));
  await ctx.service.applyItem(ctx.connection, ctx.tickets.get("HT-6")!, { roomIds: [bare.id] });
  const after = await db!.getTaskById(bare.id, native.id);
  assert.equal(after?.ticket_state, null, "a room that does not import from the connection gets no ticket state");
  assert.equal((await roomTasks(bare.id)).length, 1, "and no card");
  assert.equal(await trackerEvents(bare.id), 0);

  // Only enabled filters are polled.
  await filters!.upsertRoomTrackerFilter({ room_id: ctx.room.id, connection_id: ctx.connection.id, filter: "project = HT", enabled: false, account_id: ctx.accountId });
  const claimed = await filters!.claimDueRoomTrackerFilters({ now: new Date(), intervalMs: 60_000, limit: 500 });
  assert.ok(!claimed.some((filter) => filter.room_id === ctx.room.id || filter.room_id === bare.id));
});

test("a person's card linked to a ticket gets its state only when the room's filter matches", options, async () => {
  const ctx = await setup("link-refresh");
  ctx.tickets.set("HT-8", item("HT-8", "in_review", "2026-10-21T10:00:00.000Z", "In Review"));
  ctx.tickets.set("OPS-1", item("OPS-1", "done", "2026-10-21T10:00:00.000Z", "Done"));
  const mine = await db!.createTask(ctx.room.id, "My card", "human", undefined, undefined, { externalRef: "jira:HT-8" });
  const outside = await db!.createTask(ctx.room.id, "Typed key", "human", undefined, undefined, { externalRef: "jira:OPS-1" });
  await ctx.service.refreshLinkedCard(ctx.room.id, "jira:HT-8");
  await ctx.service.refreshLinkedCard(ctx.room.id, "jira:OPS-1");
  assert.equal((await db!.getTaskById(ctx.room.id, mine.id))?.ticket_state, "in_review");
  assert.equal((await db!.getTaskById(ctx.room.id, mine.id))?.title, "My card");
  assert.equal((await db!.getTaskById(ctx.room.id, outside.id))?.ticket_state, null);

  // A webhook for a ticket outside the filter does not reach the typed card either.
  await ctx.service.handleWebhook(ctx.connection, [{ key: "OPS-1", item: null, deleted: false }]);
  assert.equal((await db!.getTaskById(ctx.room.id, outside.id))?.ticket_state, null);
  assert.equal(await details!.getTaskTicketDetails(ctx.room.id, outside.id), null);
});

test("a poll pages past a full answer instead of dropping older changes", options, async () => {
  const ctx = await setup("paging");
  const start = Date.parse("2026-10-21T08:00:00.000Z");
  for (let index = 0; index < 250; index += 1) {
    const key = `HT-${1000 + index}`;
    ctx.tickets.set(key, item(key, "todo", new Date(start + index * 1_000).toISOString(), "To Do"));
  }
  const result = await ctx.service.syncFilter(ctx.filter);
  assert.equal(result.error, null);
  assert.equal((await db!.getTasks(ctx.room.id, undefined, { limit: 500 })).tasks.length, 250);
  assert.equal(ctx.jira.calls.listItems.length, 2);
  assert.ok(ctx.jira.calls.listItems[1]?.updatedBefore, "the second page asks below the oldest ticket of the first");
});

test("a webhook request does not take over a poll that is still running", options, async () => {
  const ctx = await setup("claims");
  const now = new Date();
  const [claimed] = (await filters!.claimDueRoomTrackerFilters({ now, intervalMs: 60_000, limit: 500 }))
    .filter((filter) => filter.id === ctx.filter.id);
  assert.ok(claimed, "a new filter is due");
  await filters!.requestRoomTrackerFilterSync(ctx.connection.id, new Date(now.getTime() + 20_000));
  const again = await filters!.claimDueRoomTrackerFilters({ now: new Date(now.getTime() + 30_000), intervalMs: 60_000, limit: 500 });
  assert.equal(again.some((filter) => filter.id === ctx.filter.id), false, "the running poll keeps its claim");

  await ctx.service.syncFilter(claimed!);
  const after = await filters!.claimDueRoomTrackerFilters({ now: new Date(now.getTime() + 40_000), intervalMs: 60_000, limit: 500 });
  assert.equal(after.some((filter) => filter.id === ctx.filter.id), true, "the webhook's request runs once the poll finished");
});

test("a link update that fails leaves the imported card in place", options, async () => {
  const ctx = await setup("link-atomic");
  ctx.tickets.set("HT-9", item("HT-9", "todo", "2026-10-21T10:00:00.000Z", "To Do"));
  await ctx.service.syncFilter(ctx.filter);
  const [imported] = await roomTasks(ctx.room.id);
  const native = await db!.createTask(ctx.room.id, "Native", "human");

  // An invalid transition in the same request rolls the merge back.
  await assert.rejects(merge!.updateTaskLinkingTicket(
    { room_id: ctx.room.id, task_id: native.id, external_ref: "jira:HT-9", updates: { external_ref: "jira:HT-9", status: "done" as const } },
    (patch, tx) => db!.updateTask(ctx.room.id, native.id, patch, undefined, tx),
  ), /Invalid transition/);
  assert.ok(await db!.getTaskById(ctx.room.id, imported!.id));
  assert.equal((await db!.getTaskById(ctx.room.id, native.id))?.external_ref, null);

  const linked = await merge!.updateTaskLinkingTicket(
    { room_id: ctx.room.id, task_id: native.id, external_ref: "jira:HT-9", updates: { external_ref: "jira:HT-9", status: "accepted" as const } },
    (patch, tx) => db!.updateTask(ctx.room.id, native.id, patch, undefined, tx),
  );
  assert.equal(linked.merged_task_id, imported!.id);
  assert.equal(linked.task?.external_ref, "jira:HT-9");
  assert.equal(linked.task?.status, "accepted");
  assert.equal(linked.task?.ticket_state, "todo");
  assert.equal(await db!.getTaskById(ctx.room.id, imported!.id), undefined);
});
