import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { ExternalItem, ListItemsOptions, ProviderConnection, WorkItemProvider } from "../connectors/providers/types.js";
import { linearPlanning } from "../connectors/providers/planning.js";

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
const planning = url ? await import("../connectors/board-planning.js") : null;
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
    planningReads: [] as string[],
  };
  const failures = { listItems: null as Error | null, getItem: null as Error | null };
  const provider = {
    name: "jira",
    async listItems(_conn: ProviderConnection, filter: string | null, opts: ListItemsOptions) {
      calls.listItems.push({ filter, updatedSince: opts.updatedSince, updatedBefore: opts.updatedBefore });
      if (opts.includePlanning) calls.planningReads.push("list");
      if (failures.listItems) throw failures.listItems;
      const project = /project = (\w+)/.exec(filter ?? "")?.[1];
      const key = /key = "([^"]+)"/.exec(filter ?? "")?.[1];
      return [...tickets.values()]
        .filter((entry) => !project || entry.key.startsWith(`${project}-`))
        .filter((entry) => !key || entry.key === key)
        .filter((entry) => !opts.updatedBefore || Date.parse(entry.tracker_updated_at!) <= Date.parse(opts.updatedBefore))
        .sort((a, b) => Date.parse(b.tracker_updated_at!) - Date.parse(a.tracker_updated_at!))
        .slice(0, opts.limit ?? 50);
    },
    async getItem(_conn: ProviderConnection, key: string, opts?: { includePlanning?: boolean }) {
      calls.getItem.push(key);
      if (opts?.includePlanning) calls.planningReads.push(key);
      if (failures.getItem) throw failures.getItem;
      return tickets.get(key) ?? null;
    },
  } as unknown as WorkItemProvider;
  return { provider, calls, failures };
}

async function setup(label: string, tickets = new Map<string, ExternalItem>(), opts: { now?: () => Date; provider?: "jira" | "linear" } = {}) {
  const now = new Date().toISOString();
  const accountId = unique(`acct-${label}`);
  await client!.db.insert(schema!.accounts).values({
    id: accountId, provider: "github", provider_user_id: accountId, login: accountId, display_name: accountId,
    avatar_url: null, created_at: now, updated_at: now,
  });
  const connectionId = `tcon_${crypto.randomUUID()}`;
  const [connection] = await client!.db.insert(schema!.tracker_connections).values({
    id: connectionId, account_id: accountId, provider: opts.provider ?? "jira", display_name: "acme", site_key: unique("acme.atlassian.net"),
    site_url: "https://acme.atlassian.net", auth_kind: "api_token", credentials_ciphertext: "sealed", credentials_iv: "iv",
    credentials_version: 1, tracker_user_id: "acc-1", tracker_user_label: "Emmy", status_map: {},
  }).returning();
  const room = await db!.createProjectWithName(unique(`tickets-${label}`));
  await filters!.upsertRoomTrackerFilter({ room_id: room.id, connection_id: connectionId, provider: opts.provider ?? "jira", filter: opts.provider === "linear" ? "team:HT" : "project = HT", enabled: true, account_id: accountId });
  const [filter] = await client!.db.select().from(schema!.room_tracker_filters)
    .where((await import("drizzle-orm")).eq(schema!.room_tracker_filters.room_id, room.id));
  const jira = fakeJira(tickets);
  const service = sync!.createTrackerSync({
    now: opts.now,
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
  assert.deepEqual(ctx.jira.calls.planningReads, ["list"]);
  const [card] = await roomTasks(ctx.room.id);
  assert.equal(card?.external_ref, "jira:HT-1");
  assert.equal(card?.ticket_state, "todo");
  assert.equal(card?.status, "proposed");
  assert.equal(card?.created_by, "tracker:jira");

  // The tracker moves the ticket; the webhook arrives first, then a poll sees the same change.
  ctx.tickets.set("HT-1", item("HT-1", "in_progress", "2026-10-21T10:05:00.000Z"));
  assert.deepEqual(await ctx.service.handleWebhook(ctx.connection, [{ key: "HT-1", item: null, deleted: false }]), { applied: 1 });
  assert.deepEqual(ctx.jira.calls.planningReads, ["list", "HT-1"], "webhook reads enrich planning too");
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
  // A person renamed the imported card, so the rename stays.
  assert.equal(after?.title, "Our own title");
});

test("planning-only imports refresh bound cards once, stay room-scoped, and preserve native execution", options, async () => {
  const ctx = await setup("planning");
  const original = item("HT-21", "in_progress", "2026-11-06T10:00:00.000Z");
  ctx.tickets.set(original.key, original);
  await ctx.service.syncFilter(ctx.filter);
  const [card] = await roomTasks(ctx.room.id);
  await db!.updateTask(ctx.room.id, card!.id, { status: "accepted" });
  await db!.updateTask(ctx.room.id, card!.id, { status: "assigned", assignee: "agent-1" });
  await db!.updateTask(ctx.room.id, card!.id, { status: "in_progress" });
  const eventCount = await trackerEvents(ctx.room.id);
  const currentSprint = { id: "24", name: "Sprint 24", state: "active", startDate: "2026-11-02", endDate: "2026-11-13", goal: null };
  const previousSprint = { ...currentSprint, id: "23", name: "Sprint 23", state: "closed", startDate: "2026-10-19", endDate: "2026-10-30" };
  const enriched = { ...original, payload: { planning: {
    estimate: 0, estimateAvailable: true, iterationsAvailable: true,
    iterations: [previousSprint, currentSprint], assigneeAvatarUrl: "https://avatar.example/emmy.png",
  } } };
  const first = await ctx.service.applyItem(ctx.connection, enriched);
  assert.equal(first.changed, true, "metadata is added even when Jira's updated time did not change");
  assert.equal(first.updated.length, 1, "the board receives a live refresh for the planning change");
  const repeated = await ctx.service.applyItem(ctx.connection, enriched);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.updated.length, 0);
  assert.equal(await trackerEvents(ctx.room.id), eventCount, "planning does not fabricate a ticket-state event");
  const after = await db!.getTaskById(ctx.room.id, card!.id);
  assert.equal(after?.status, "in_progress");
  assert.equal(after?.assignee, "agent-1");

  const imported = await planning!.getImportedBoardPlanning(ctx.room.id);
  const prefix = `imported:jira:${ctx.connection.id}:`;
  assert.equal(imported.tasks[card!.id].estimate, 0, "zero is a known estimate");
  assert.equal(imported.tasks[card!.id].sprintId, `${prefix}24`);
  assert.deepEqual(imported.tasks[card!.id].sprintIds, [`${prefix}23`, `${prefix}24`]);
  assert.equal(imported.tasks[card!.id].assigneeId, `jira:${ctx.connection.id}:acc-1`);
  assert.equal(imported.tasks[card!.id].assigneeAvatarUrl, "https://avatar.example/emmy.png");
  assert.equal(imported.tasks[card!.id].done, false);
  assert.equal(imported.tasks[card!.id].ticketState, "in_progress");
  const source = imported.sprints.find(sprint => sprint.id === `${prefix}24`)!.source!;
  assert.deepEqual({ provider: source.provider, id: source.id, connectionId: source.connectionId },
    { provider: "jira", id: "24", connectionId: ctx.connection.id });
  assert.equal(source.stale, false);

  const other = await setup("planning-other");
  assert.deepEqual(await planning!.getImportedBoardPlanning(other.room.id), { sprints: [], tasks: {} });
  await other.service.applyItem(other.connection, { ...enriched, payload: { planning: {
    ...enriched.payload.planning, estimate: null, iterations: [currentSprint],
  } } }, { roomIds: [other.room.id] });
  const otherPlanning = await planning!.getImportedBoardPlanning(other.room.id);
  assert.equal(otherPlanning.sprints[0].id, `imported:jira:${other.connection.id}:24`, "identical Jira sprint IDs from different sites do not collide");
  assert.equal(Object.values(otherPlanning.tasks)[0].estimate, null, "unknown estimates do not turn into zero");
  const stale = await ctx.service.applyItem(ctx.connection, { ...original, tracker_updated_at: "2026-11-05T10:00:00.000Z" });
  assert.equal(stale.stale, true);
  assert.deepEqual(await planning!.getImportedBoardPlanning(ctx.room.id), imported);
});

test("Linear board reads cross exact cycle boundaries without an issue edit", options, async () => {
  const ctx = await setup("linear-cycle-clock", new Map(), { provider: "linear" });
  const cycle = { id: "cycle-24", name: "Cycle 24", startsAt: "2026-11-06T09:00:00+01:00", endsAt: "2026-11-20T09:00:00+01:00", completedAt: null };
  const metadata = linearPlanning({ estimate: 8, cycle }, new Date("2026-11-06T07:00:00Z"));
  await ctx.service.applyItem(ctx.connection, { ...item("HT-1", "in_progress", "2026-11-01T10:00:00Z"), provider: "linear", payload: { planning: metadata } }, { roomIds: [ctx.room.id] });
  const stateAt = async (time: string) => (await planning!.getImportedBoardPlanning(ctx.room.id, new Date(time))).sprints[0];
  assert.equal((await stateAt("2026-11-06T07:59:59Z")).state, "future");
  assert.equal((await stateAt("2026-11-06T08:00:00Z")).state, "active");
  assert.equal((await stateAt("2026-11-20T07:59:59Z")).state, "active");
  assert.equal((await stateAt("2026-11-20T08:00:00Z")).state, "closed");
  assert.equal((await stateAt("2026-11-20T08:00:00Z")).source?.stale, false);
});

test("Jira refreshes sprint authority during incremental polls and marks failed metadata stale", options, async () => {
  let clock = new Date("2026-11-06T08:00:00Z");
  const ctx = await setup("jira-sprint-refresh", new Map(), { now: () => clock });
  const issue = { ...item("HT-1", "in_progress", "2026-11-01T10:00:00Z"), payload: { planning: {
    estimate: 8, estimateAvailable: true, iterationsAvailable: true,
    iterations: [{ id: "24", name: "Sprint 24", state: "future", startDate: "2026-11-06", endDate: "2026-11-20", goal: null }],
  } } };
  ctx.tickets.set(issue.key, issue);
  await ctx.service.syncFilter(ctx.filter);
  const originalList = ctx.jira.provider.listItems;
  let fail = false;
  ctx.jira.provider.listItems = async (conn, filter, opts) => {
    if (opts.updatedSince) return [];
    assert.match(filter ?? "", /^\(project = HT\) AND key in \("HT-1"\)$/);
    if (fail) throw new Error("metadata unavailable");
    return originalList(conn, filter, opts);
  };
  const nextPoll = async () => {
    const [filter] = await client!.db.select().from(schema!.room_tracker_filters)
      .where((await import("drizzle-orm")).eq(schema!.room_tracker_filters.id, ctx.filter.id));
    return ctx.service.syncFilter(filter!);
  };
  clock = new Date("2026-11-06T08:03:00Z");
  issue.payload.planning.iterations[0].state = "active";
  assert.deepEqual(await nextPoll(), { seen: 0, changed: 1, error: null });
  let imported = await planning!.getImportedBoardPlanning(ctx.room.id, clock);
  assert.equal(imported.sprints[0].state, "active");
  assert.equal(imported.sprints[0].source?.stale, false);
  assert.equal(imported.sprints[0].source?.checkedAt, clock.toISOString());

  // A fresh unchanged read renews authority without changing or reordering cards.
  clock = new Date("2026-11-06T08:06:00Z");
  assert.deepEqual(await nextPoll(), { seen: 0, changed: 0, error: null });
  const [card] = await roomTasks(ctx.room.id);
  assert.equal(new Date(card.updated_at).toISOString(), "2026-11-06T08:03:00.000Z");
  assert.equal((await planning!.getImportedBoardPlanning(ctx.room.id, clock)).sprints[0].source?.checkedAt, clock.toISOString());

  clock = new Date("2026-11-06T08:09:00Z");
  fail = true;
  assert.match((await nextPoll()).error ?? "", /Sprint statuses could not be refreshed/);
  imported = await planning!.getImportedBoardPlanning(ctx.room.id, clock);
  assert.equal(imported.sprints[0].source?.stale, true);
  assert.equal(Object.values(imported.tasks)[0].sprintId, imported.sprints[0].id, "a failure does not erase known membership");
  assert.equal((await roomTasks(ctx.room.id)).length, 1, "the refresh creates no cards");

  // Discovery denial also preserves membership but never pretends estimates are known.
  await ctx.service.applyItem(ctx.connection, { ...issue, payload: { planning: {
    estimate: null, estimateAvailable: false, iterationsAvailable: false, iterations: [],
  } } });
  imported = await planning!.getImportedBoardPlanning(ctx.room.id, clock);
  assert.equal(imported.sprints[0].source?.stale, true);
  assert.equal(Object.values(imported.tasks)[0].estimate, null);
  assert.equal(Object.values(imported.tasks)[0].sprintId, imported.sprints[0].id);

  fail = false;
  clock = new Date("2026-11-06T08:12:00Z");
  issue.payload.planning.iterations[0].state = "closed";
  await nextPoll();
  imported = await planning!.getImportedBoardPlanning(ctx.room.id, clock);
  assert.equal(imported.sprints[0].state, "closed");
  assert.equal(imported.sprints[0].source?.stale, false);
  const expired = await planning!.getImportedBoardPlanning(ctx.room.id, new Date("2026-11-06T08:23:00Z"));
  assert.equal(expired.sprints[0].source?.stale, true, "a stopped connector cannot leave authoritative active metrics forever");
});

test("an out-of-filter Jira representative does not starve another ticket in its sprint", options, async () => {
  let clock = new Date("2026-11-06T08:00:00Z");
  const ctx = await setup("jira-representative-rotation", new Map(), { now: () => clock });
  const metadata = { estimate: 3, estimateAvailable: true, iterationsAvailable: true,
    iterations: [{ id: "24", name: "Sprint 24", state: "future", startDate: "2026-11-06", endDate: "2026-11-20", goal: null }] };
  for (const key of ["HT-1", "HT-2"]) ctx.tickets.set(key, { ...item(key, "todo", "2026-11-01T10:00:00Z"), payload: { planning: metadata } });
  await ctx.service.syncFilter(ctx.filter);
  const reads: string[] = [];
  ctx.jira.provider.listItems = async (_conn, filter, opts) => {
    if (opts.updatedSince) return [];
    reads.push(filter!);
    return filter!.includes('"HT-2"') ? [{ ...ctx.tickets.get("HT-2")!, payload: { planning: {
      ...metadata, iterations: [{ ...metadata.iterations[0], state: "active" }],
    } } }] : [];
  };
  for (const time of ["2026-11-06T08:03:00Z", "2026-11-06T08:06:00Z"]) {
    clock = new Date(time);
    await ctx.service.syncFilter({ ...ctx.filter, last_synced_at: "2026-11-06T08:00:00Z" });
  }
  assert.equal(reads.length, 2);
  assert.match(reads[1], /"HT-2"/);
  const imported = await planning!.getImportedBoardPlanning(ctx.room.id, clock);
  assert.equal(imported.sprints[0].state, "active");
  assert.equal(imported.sprints[0].source?.stale, false);
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

  assert.deepEqual(await filters!.getRoomTrackerScope(bare.id), { sources: [], linearTeamKeys: [], githubRepos: [] });
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
  await filters!.upsertRoomTrackerFilter({ room_id: ctx.room.id, connection_id: ctx.connection.id, provider: "jira", filter: "project = HT", enabled: false, account_id: ctx.accountId });
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

async function filterRow(id: string) {
  const { eq } = await import("drizzle-orm");
  const [row] = await client!.db.select().from(schema!.room_tracker_filters).where(eq(schema!.room_tracker_filters.id, id));
  return row!;
}

test("a webhook reads only tickets LetAgents holds, and asks for a poll only for new ones", options, async () => {
  const ctx = await setup("webhook-known");
  ctx.tickets.set("HT-20", item("HT-20", "todo", "2026-10-21T10:00:00.000Z", "To Do"));
  await ctx.service.syncFilter(ctx.filter);
  const before = await filterRow(ctx.filter.id);
  ctx.jira.calls.getItem.length = 0;

  ctx.tickets.set("HT-20", item("HT-20", "in_progress", "2026-10-21T10:10:00.000Z"));
  await ctx.service.handleWebhook(ctx.connection, [{ key: "HT-20", item: null, deleted: false }]);
  assert.deepEqual(ctx.jira.calls.getItem, ["HT-20"]);
  assert.equal((await filterRow(ctx.filter.id)).sync_requested_at, before.sync_requested_at, "a known ticket asks for no poll");

  await ctx.service.handleWebhook(ctx.connection, [{ key: "ZZ-1", item: null, deleted: false }]);
  assert.deepEqual(ctx.jira.calls.getItem, ["HT-20"], "an unknown ticket is not read");
  assert.equal(await count("SELECT count(*)::int AS n FROM external_items WHERE connection_id = $1 AND key = 'ZZ-1'", [ctx.connection.id]), 0);
  assert.ok((await filterRow(ctx.filter.id)).sync_requested_at, "it asks the filters for an early poll");
});

test("an early poll waits a minimum gap after the last claim", options, async () => {
  const ctx = await setup("early-gap");
  const start = new Date(Date.now() + 60 * 60_000);
  // Default gap: half the interval, longer than the worker's quarter-interval tick.
  const claim = (at: Date) => filters!.claimDueRoomTrackerFilters({ now: at, intervalMs: 120_000, limit: 500 })
    .then((rows) => rows.find((row) => row.id === ctx.filter.id));
  const first = await claim(start);
  assert.ok(first);
  await client!.pool.query("UPDATE room_tracker_filters SET sync_finished_at = $2, sync_requested_at = $3 WHERE id = $1",
    [ctx.filter.id, new Date(start.getTime() + 1_000).toISOString(), new Date(start.getTime() + 2_000).toISOString()]);
  assert.equal(await claim(new Date(start.getTime() + 30_000)), undefined, "not at the next worker tick");
  assert.ok(await claim(new Date(start.getTime() + 61_000)), "due once half an interval passed");
});

test("a failed poll backs off, doubling, and does not stop the other filters", options, async () => {
  const { TrackerProviderError } = await import("../connectors/providers/types.js");
  const ctx = await setup("backoff");
  ctx.jira.failures.listItems = new TrackerProviderError("definite", "Tracker answered 500", 500);
  const first = await filters!.claimDueRoomTrackerFilters({ now: new Date(), intervalMs: 60_000, limit: 500 });
  const mine = first.find((row) => row.id === ctx.filter.id)!;
  const result = await ctx.service.syncFilter(mine, 60_000);
  assert.match(result.error ?? "", /500/);
  const once = await filterRow(ctx.filter.id);
  assert.equal(once.failure_count, 1);
  const wait1 = Date.parse(once.backoff_until!) - Date.parse(once.sync_finished_at!);
  assert.ok(wait1 >= 59_000 && wait1 <= 61_000, `first backoff is one interval (${wait1})`);

  // While backing off, the filter is not claimed.
  assert.equal((await filters!.claimDueRoomTrackerFilters({ now: new Date(Date.now() + 30_000), intervalMs: 1_000, limit: 500 }))
    .some((row) => row.id === ctx.filter.id), false);

  // A 429 honours Retry-After when it is longer than the doubled interval.
  ctx.jira.failures.listItems = new TrackerProviderError("definite", "Tracker answered 429", 429, 20 * 60_000);
  await ctx.service.syncFilter({ ...(await filterRow(ctx.filter.id)) }, 60_000);
  const twice = await filterRow(ctx.filter.id);
  assert.equal(twice.failure_count, 2);
  const wait2 = Date.parse(twice.backoff_until!) - Date.parse(twice.sync_finished_at!);
  assert.ok(wait2 >= 20 * 60_000 - 1_000, `Retry-After wins (${wait2})`);

  // Success clears the backoff.
  ctx.jira.failures.listItems = null;
  await ctx.service.syncFilter({ ...(await filterRow(ctx.filter.id)) }, 60_000);
  const ok = await filterRow(ctx.filter.id);
  assert.equal(ok.failure_count, 0);
  assert.equal(ok.backoff_until, null);
});

test("auto import does not ask a failing tracker again for a minute", options, async () => {
  const { TrackerProviderError } = await import("../connectors/providers/types.js");
  const ctx = await setup("import-errors");
  ctx.jira.failures.getItem = new TrackerProviderError("definite", "Tracker answered 503", 503);
  const tryImport = () => ctx.service.importTicketForRoom(ctx.room.id, [{ provider: "jira", key: "HT-30", ref: "jira:HT-30" }]);
  assert.equal(await tryImport(), undefined);
  assert.equal(await tryImport(), undefined);
  assert.deepEqual(ctx.jira.calls.getItem, ["HT-30"], "the second event is answered from the error cache");
});

test("a person's rename of an imported card survives later syncs", options, async () => {
  const ctx = await setup("rename");
  ctx.tickets.set("HT-40", item("HT-40", "todo", "2026-10-21T10:00:00.000Z", "To Do"));
  await ctx.service.syncFilter(ctx.filter);
  const [card] = await roomTasks(ctx.room.id);
  ctx.tickets.set("HT-40", { ...item("HT-40", "todo", "2026-10-21T10:05:00.000Z", "To Do"), title: "Tracker renamed it" });
  await ctx.service.applyItem(ctx.connection, ctx.tickets.get("HT-40")!, { roomIds: [ctx.room.id] });
  assert.equal((await db!.getTaskById(ctx.room.id, card!.id))?.title, "Tracker renamed it", "untouched imported titles follow the ticket");
  await db!.updateTask(ctx.room.id, card!.id, { title: "Our words" });
  ctx.tickets.set("HT-40", { ...item("HT-40", "in_progress", "2026-10-21T10:09:00.000Z"), title: "Tracker again" });
  await ctx.service.applyItem(ctx.connection, ctx.tickets.get("HT-40")!, { roomIds: [ctx.room.id] });
  const after = await db!.getTaskById(ctx.room.id, card!.id);
  assert.equal(after?.title, "Our words");
  assert.equal(after?.ticket_state, "in_progress");
});

test("busy tickets do not push pull request status out of the artifact status read", options, async () => {
  const ctx = await setup("artifact-status");
  ctx.tickets.set("HT-50", item("HT-50", "todo", "2026-10-21T09:00:00.000Z", "To Do"));
  await ctx.service.syncFilter(ctx.filter);
  const [card] = await roomTasks(ctx.room.id);
  const prUrl = "https://github.com/BrosInCode/letagents/pull/950";
  await db!.insertGitHubRoomEvent({
    room_id: ctx.room.id, event_type: "pull_request", action: "opened", idempotency_key: unique("pr"),
    github_object_url: prUrl, title: "Fix", state: "open", linked_task_id: card!.id,
    provider_event_at: "2026-10-21T09:30:00.000Z",
  });
  // 600 newer tracker events linked to the same card.
  const values = Array.from({ length: 600 }, (_, index) => {
    const at = new Date(Date.parse("2026-10-21T10:00:00.000Z") + index * 1_000).toISOString();
    return `('gre_t${index}_${Date.now()}', '${ctx.room.id}', 'tracker_ticket', 'ticket_state_changed', '${unique("t")}', '${card!.id}', '${at}', '${at}')`;
  });
  await client!.pool.query(`INSERT INTO github_room_events (id, room_id, event_type, action, idempotency_key, linked_task_id, event_order_at, created_at) VALUES ${values.join(",")}`);
  const status = (await db!.getTasksGitHubArtifactStatus(ctx.room.id)).get(card!.id);
  assert.equal(status?.pr_state, "open");
});

test("a sync that throws is counted, backs off, and gives up its claim", options, async () => {
  const ctx = await setup("throws");
  const throwing = sync!.createTrackerSync({
    providers: { jira: ctx.jira.provider, linear: ctx.jira.provider },
    connections: { open: () => ({}) as ProviderConnection, recordFailure: async () => "x" },
    // A local failure outside syncFilter's own handling.
    store: { get: async () => { throw new Error("database went away"); }, addUnmapped: async () => undefined },
  });
  // Each tick claims up to ten due filters; other tests' filters may come first.
  let claimedHere = await filterRow(ctx.filter.id);
  for (let attempt = 0; attempt < 20 && claimedHere.failure_count === 0; attempt += 1) {
    await throwing.tick(60_000);
    claimedHere = await filterRow(ctx.filter.id);
  }
  assert.equal(claimedHere.failure_count, 1);
  assert.ok(claimedHere.backoff_until, "it backs off");
  assert.ok(Date.parse(claimedHere.sync_finished_at!) >= Date.parse(claimedHere.sync_claimed_at!), "the claim is finished");
  assert.equal(claimedHere.last_error, "Sync failed on the server. It retries at the next poll.");
});

test("a GitHub issue imports through the same sync path; messages match only the filter's repositories", options, async () => {
  const { eq } = await import("drizzle-orm");
  const refs = await import("../db/task-external-refs.js");
  const { detectKeysInMessage } = await import("../connectors/key-detectors.js");
  const now = new Date().toISOString();
  const accountId = unique("acct-github");
  await client!.db.insert(schema!.accounts).values({
    id: accountId, provider: "github", provider_user_id: accountId, login: accountId, display_name: accountId,
    avatar_url: null, created_at: now, updated_at: now,
  });
  const connectionId = `tcon_${crypto.randomUUID()}`;
  // Migration 0127 widened the provider and auth kind checks; no token is stored.
  const [connection] = await client!.db.insert(schema!.tracker_connections).values({
    id: connectionId, account_id: accountId, provider: "github", display_name: "acme", site_key: unique("installation"),
    site_url: "https://github.com/acme", auth_kind: "github_app", credentials_ciphertext: "sealed", credentials_iv: "iv",
    credentials_version: 1, tracker_user_id: "31524469", tracker_user_label: "EmmyMay", status_map: {},
  }).returning();
  const room = await db!.createProjectWithName(unique("github-issues"));
  await filters!.upsertRoomTrackerFilter({ room_id: room.id, connection_id: connectionId, provider: "github", filter: "acme/api", enabled: true, account_id: accountId });
  const [filter] = await client!.db.select().from(schema!.room_tracker_filters).where(eq(schema!.room_tracker_filters.room_id, room.id));
  const issue: ExternalItem = {
    provider: "github",
    key: "acme/api#12",
    title: "Ship the Connectors page",
    ticket_state: "in_progress",
    raw_status: "Open (assigned)",
    unmapped: false,
    assignee_id: "31524469",
    assignee_label: "EmmyMay",
    url: "https://github.com/acme/api/issues/12",
    tracker_updated_at: now,
    payload: { repo: "acme/api", number: 12 },
  };
  const filtersSeen: Array<string | null> = [];
  const github = {
    name: "github",
    async listItems(_conn: ProviderConnection, text: string | null) { filtersSeen.push(text); return [issue]; },
    async getItem() { return issue; },
  } as unknown as WorkItemProvider;
  const service = sync!.createTrackerSync({
    providers: { jira: github, linear: github, github } as never,
    connections: { open: () => ({ id: connectionId } as ProviderConnection), recordFailure: async (_row, error) => String(error) },
    store: { get: async (id) => (id === connectionId ? connection! : null), addUnmapped: async () => undefined },
  });

  const result = await service.syncFilter(filter!);
  assert.equal(result.error, null);
  assert.deepEqual(filtersSeen, ["acme/api"]);
  const [card] = await roomTasks(room.id);
  assert.equal(card?.external_ref, "github:acme/api#12");
  assert.equal(card?.ticket_state, "in_progress");
  assert.equal(card?.created_by, "tracker:github");

  refs.invalidateRoomExternalRefScope(room.id);
  const scope = await refs.getRoomExternalRefScope(room.id);
  assert.deepEqual(scope.detectorOptions.githubRepos, ["acme/api"]);
  assert.deepEqual(detectKeysInMessage("Fixes #12, and other/repo#3", scope.detectorOptions).map((match) => match.ref), ["github:acme/api#12"]);
  assert.deepEqual((await filters!.getRoomTrackerScope(room.id)).githubRepos, ["acme/api"]);

  // An issue event polls early only filters naming its repository, at most once per gap.
  const other = await db!.createProjectWithName(unique("github-other"));
  await filters!.upsertRoomTrackerFilter({ room_id: other.id, connection_id: connectionId, provider: "github", filter: "acme/web", enabled: true, account_id: accountId });
  const accept = (text: string) => filters!.githubReposInFilter(text).includes("acme/api");
  assert.equal(await filters!.requestMatchingRoomTrackerFilterSync(connectionId, accept, 60_000), 1);
  assert.equal(await filters!.requestMatchingRoomTrackerFilterSync(connectionId, accept, 60_000), 0, "not again within the gap");
  const [web] = await client!.db.select().from(schema!.room_tracker_filters).where(eq(schema!.room_tracker_filters.room_id, other.id));
  assert.equal(web?.sync_requested_at, null);
});


test("release metadata backfills unchanged bound tickets without rescan or new imports", options, async () => {
  let clock = new Date("2026-11-10T10:00:00Z");
  const ctx = await setup("release-backfill", new Map(), { now: () => clock });
  const old = item("HT-9001", "done", "2026-01-01T00:00:00Z", "Done");
  await ctx.service.applyItem(ctx.connection, old, { roomIds: [ctx.room.id] });
  const enriched = { ...old, payload: { releaseMetadataAvailable: true, releaseFields: [
    { id: "customfield_release", name: "Release", values: ["true"] },
    { id: "customfield_other", name: "Other context", values: null },
  ] } };
  ctx.tickets.set(old.key, enriched);
  ctx.tickets.set("HT-9999", item("HT-9999", "todo", "2026-01-01T00:00:00Z"));
  ctx.jira.provider.listItems = async (_connection, _filter, opts) => {
    assert.ok(opts.updatedSince, "keep the incremental cursor"); return [];
  };
  clock = new Date("2026-11-10T10:03:00Z");
  await ctx.service.syncFilter({ ...ctx.filter, last_synced_at: "2026-11-10T10:00:00Z" });
  assert.deepEqual(ctx.jira.calls.getItem, [old.key]);
  const rows = (await client!.pool.query("SELECT payload FROM external_items WHERE connection_id=$1", [ctx.connection.id])).rows;
  assert.deepEqual(rows[0].payload.releaseFields, enriched.payload.releaseFields);
  assert.equal((await roomTasks(ctx.room.id)).length, 1, "backfill never imports an unbound ticket");
  clock = new Date("2026-11-10T10:06:00Z");
  await ctx.service.syncFilter({ ...ctx.filter, last_synced_at: "2026-11-10T10:03:00Z" });
  assert.deepEqual(ctx.jira.calls.getItem, [old.key], "unrelated unknown field is not an endless refresh candidate");
});

test("release metadata refresh bounds requests and rotates unavailable tickets", options, async () => {
  let clock = new Date("2026-11-10T11:00:00Z");
  const ctx = await setup("release-refresh-bound", new Map(), { now: () => clock });
  for (let i = 1; i <= 22; i++) {
    const ticket = item(`HT-${9100+i}`, "todo", "2026-01-01T00:00:00Z");
    await ctx.service.applyItem(ctx.connection, ticket, { roomIds: [ctx.room.id] });
    ctx.tickets.set(ticket.key, { ...ticket, payload: { releaseMetadataAvailable: false, releaseFields: [{ id: "labels", name: "Label", values: [] }] } });
  }
  ctx.jira.provider.listItems = async () => [];
  ctx.jira.failures.getItem = new Error("unavailable");
  clock = new Date("2026-11-10T11:03:00Z");
  await ctx.service.syncFilter(ctx.filter);
  assert.equal(ctx.jira.calls.getItem.length, 20);
  clock = new Date("2026-11-10T11:04:00Z");
  await ctx.service.syncFilter(ctx.filter);
  assert.equal(ctx.jira.calls.getItem.length, 22, "remaining tickets proceed while failed reads cool down");
  ctx.jira.failures.getItem = null;
  clock = new Date("2026-11-10T11:07:00Z");
  await ctx.service.syncFilter(ctx.filter);
  assert.equal(ctx.jira.calls.getItem.length, 42);
  clock = new Date("2026-11-10T11:10:00Z");
  await ctx.service.syncFilter(ctx.filter);
  assert.equal(ctx.jira.calls.getItem.length, 62, "failed catalog discovery remains retryable");
});


test("release polling observes cleared flags outside the import filter without changing sprint authority or card order", options, async () => {
  const { defaultBoardPlanning } = await import("../../../shared/board-planning.mjs");
  const { getBoardPlanning } = await import("../db/board-planning.js");
  let clock = new Date("2026-11-10T12:00:00Z");
  const ctx = await setup("release-cleared", new Map(), { now: () => clock });
  const ticket = { ...item("HT-9201", "done", "2026-11-10T11:00:00Z", "Ready for release"), payload: {
    releaseMetadataAvailable: true, releaseFields: [{ id: "customfield_release", name: "Release", values: ["true"] }],
    planning: { iterationsAvailable: false, iterations: [] },
  } };
  await ctx.service.applyItem(ctx.connection, ticket, { roomIds: [ctx.room.id] });
  const document = defaultBoardPlanning();
  document.releaseRule = { kind: "tracker", connectionId: ctx.connection.id, fieldId: "customfield_release", value: "true" };
  await client!.db.insert(schema!.room_board_planning).values({ room_id: ctx.room.id, document, revision: 1, updated_by: 'test' });
  const before = await roomTasks(ctx.room.id);
  const cached = (await client!.pool.query("SELECT synced_at, payload FROM external_items WHERE connection_id=$1", [ctx.connection.id])).rows[0];
  ctx.jira.provider.listItems = async () => [];
  ctx.tickets.set(ticket.key, { ...ticket, tracker_updated_at: "2026-11-10T12:02:00Z", raw_status: "Released", payload: { ...ticket.payload,
    releaseFields: [{ id: "customfield_release", name: "Release", values: ["false"] }], planning: { iterationsAvailable: true, iterations: [] } } });
  assert.equal((await getBoardPlanning(ctx.room.id, true)).releases!.items.length, 1);
  clock = new Date("2026-11-10T12:03:00Z");
  await ctx.service.syncFilter(ctx.filter);
  assert.equal((await getBoardPlanning(ctx.room.id, true)).releases!.items.length, 0);
  assert.deepEqual(await roomTasks(ctx.room.id), before, "release enrichment cannot reorder or mutate cards");
  const after = (await client!.pool.query("SELECT synced_at, payload FROM external_items WHERE connection_id=$1", [ctx.connection.id])).rows[0];
  assert.deepEqual(after.payload.planning.iterations, cached.payload.planning.iterations);
  assert.equal(after.payload.planning.iterationsAvailable, cached.payload.planning.iterationsAvailable);
  assert.deepEqual(after.synced_at, cached.synced_at);

  await ctx.service.applyItem(ctx.connection, { ...ticket, tracker_updated_at: '2026-11-10T12:01:00Z' });
  assert.equal((await getBoardPlanning(ctx.room.id, true)).releases!.items.length, 0, 'a lagging normal import cannot restore the cleared flag');

  document.releaseRule = { ...document.releaseRule, fieldId: "status", value: "Released" };
  await client!.pool.query("UPDATE room_board_planning SET document=$1 WHERE room_id=$2", [JSON.stringify(document), ctx.room.id]);
  ctx.tickets.set(ticket.key, { ...ctx.tickets.get(ticket.key)!, raw_status: "Archived" });
  clock = new Date("2026-11-10T12:06:00Z");
  assert.equal((await getBoardPlanning(ctx.room.id, true)).releases!.items.length, 1);
  const released = ctx.tickets.get(ticket.key)!;
  ctx.tickets.set(ticket.key, { ...ticket, tracker_updated_at: '2026-11-10T12:01:00Z' });
  await ctx.service.syncFilter(ctx.filter);
  assert.equal((await getBoardPlanning(ctx.room.id, true)).releases!.items.length, 1, 'a lagging supplemental read cannot erase newer release evidence');
  ctx.tickets.set(ticket.key, released);
  clock = new Date('2026-11-10T12:09:00Z');
  await ctx.service.syncFilter(ctx.filter);
  assert.equal((await getBoardPlanning(ctx.room.id, true)).releases!.items.length, 0, "status rules are rechecked too");
});

test("a lagging release read cannot overwrite newer tracker evidence", options, async () => {
  let clock = new Date("2026-11-10T13:00:00Z");
  const ctx = await setup("release-lagging", new Map(), { now: () => clock });
  const ticket = item("HT-9301", "todo", "2026-11-10T12:30:00Z");
  await ctx.service.applyItem(ctx.connection, ticket, { roomIds: [ctx.room.id] });
  ctx.jira.provider.listItems = async () => [];
  ctx.jira.provider.getItem = async () => {
    await ctx.service.applyItem(ctx.connection, { ...ticket, tracker_updated_at: "2026-11-10T13:02:00Z", payload: { releaseMetadataAvailable: true,
      releaseFields: [{ id: "labels", name: "Label", values: ["release"] }] } });
    return { ...ticket, payload: { releaseMetadataAvailable: true, releaseFields: [{ id: "labels", name: "Label", values: [] }] } };
  };
  clock = new Date("2026-11-10T13:03:00Z"); await ctx.service.syncFilter(ctx.filter);
  const row = (await client!.pool.query("SELECT payload FROM external_items WHERE connection_id=$1", [ctx.connection.id])).rows[0];
  assert.deepEqual(row.payload.releaseFields[0].values, ["release"]);
});

test("partial tracker metadata keeps known waiting tickets until an authoritative clear", options, async () => {
  const { defaultBoardPlanning } = await import('../../../shared/board-planning.mjs');
  const { getBoardPlanning } = await import('../db/board-planning.js');
  let clock = new Date('2026-11-10T14:00:00Z');
  const ctx = await setup('release-partial', new Map(), { now: () => clock });
  const ticket = { ...item('HT-9401', 'done', '2026-11-10T13:00:00Z'), payload: {
    releaseMetadataAvailable: true, releaseFields: [{ id: 'release', name: 'Release', values: ['true'] }],
  } };
  await ctx.service.applyItem(ctx.connection, ticket, { roomIds: [ctx.room.id] });
  const document = defaultBoardPlanning();
  document.releaseRule = { kind: 'tracker', connectionId: ctx.connection.id, fieldId: 'release', value: 'true' };
  await client!.db.insert(schema!.room_board_planning).values({ room_id: ctx.room.id, document, updated_by: 'test' });
  ctx.jira.provider.listItems = async () => [];
  ctx.tickets.set(ticket.key, { ...ticket, payload: { releaseMetadataAvailable: false,
    releaseFields: [{ id: 'release', name: 'Release', values: null }] } });
  clock = new Date('2026-11-10T14:03:00Z'); await ctx.service.syncFilter(ctx.filter);
  let queue = (await getBoardPlanning(ctx.room.id, true)).releases!;
  assert.equal(queue.items.length, 1); assert.equal(queue.unavailable, 1);
  await ctx.service.applyItem(ctx.connection, { ...ticket, tracker_updated_at: '2026-11-10T14:04:00Z',
    payload: { releaseMetadataAvailable: false, releaseFields: [] } });
  queue = (await getBoardPlanning(ctx.room.id, true)).releases!;
  assert.equal(queue.items.length, 1, 'normal poll catalog failure preserves known flags'); assert.equal(queue.unavailable, 1);
  await ctx.service.applyItem(ctx.connection, { ...ticket, tracker_updated_at: '2026-11-10T14:05:00Z', payload: {
    releaseMetadataAvailable: true, releaseFields: [{ id: 'release', name: 'Release', values: [] }],
  } });
  queue = (await getBoardPlanning(ctx.room.id, true)).releases!;
  assert.equal(queue.items.length, 0); assert.equal(queue.unavailable, 0);
});
