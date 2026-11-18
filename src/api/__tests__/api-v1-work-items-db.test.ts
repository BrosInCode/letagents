import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { WorkItemSearchResult } from "../../../shared/api/work-items.mjs";

// /api/v1 work items end to end: the real app, auth, room access, the room's
// tracker filter in the database, sealed credentials, and a fake Jira site.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;
const CONNECTOR_KEY = randomBytes(32).toString("hex");
process.env.LETAGENTS_CONNECTOR_SECRET_KEY = CONNECTOR_KEY;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 work items DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const filters = testDatabaseUrl ? await import("../connectors/room-filters.js") : null;
const crypto = testDatabaseUrl ? await import("../connectors/crypto.js") : null;
const sync = testDatabaseUrl ? await import("../connectors/sync.js") : null;
const events = testDatabaseUrl ? await import("../server/events.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;

// The fake Jira site: tickets by key; search reads the project and key from the JQL.
const tickets = new Map<string, { status: string; category: string; updated: string }>();
const jiraRequests: string[] = [];
const realFetch = globalThis.fetch;

function jiraIssue(key: string) {
  const ticket = tickets.get(key)!;
  return {
    id: `id-${key}`,
    key,
    fields: {
      summary: `Ticket ${key}`,
      status: { name: ticket.status, statusCategory: { key: ticket.category } },
      assignee: null,
      updated: ticket.updated,
      labels: [],
    },
  };
}

function fakeJiraFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://acme.atlassian.net/")) return realFetch(input, init);
  jiraRequests.push(url);
  const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
  if (url.endsWith("/rest/api/3/field")) return json([]);
  if (url.endsWith("/rest/api/3/search/jql")) {
    const jql = String((JSON.parse(String(init?.body)) as { jql: string }).jql);
    const project = /project = (\w+)/.exec(jql)?.[1];
    const key = /key = "([^"]+)"/.exec(jql)?.[1];
    const keys = [...tickets.keys()].filter((k) => (!project || k.startsWith(`${project}-`)) && (!key || k === key));
    return json({ issues: keys.map(jiraIssue), isLast: true });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

let server: Server | null = null;
let base = "";
let seq = 0;

async function person(login: string): Promise<{ id: string; cookie: string }> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `wi-${login}`, login, display_name: login });
  const token = `api-v1-wi-session-${login}`;
  await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return { id: account.id, cookie: `letagents_session=${token}` };
}

let ada: { id: string; cookie: string };
let cy: { id: string; cookie: string };

/** A room whose Jira filter (`project = HT`) runs on Ada's connection. */
async function trackerRoom(enabled = true) {
  seq += 1;
  const room = await api!.createProjectWithName(`api-v1-work-items-${seq}`);
  await members!.addRoomMember({ roomId: room.id, accountId: ada.id, addedVia: "creator" });
  const connectionId = `tcon_wi_${seq}`;
  const sealed = crypto!.createConnectorCipher(CONNECTOR_KEY).encrypt(
    { kind: "api_token", site_url: "https://acme.atlassian.net", email: "ada@example.com", api_token: "ATATT3xFfGF0tokenvalue1234567890" },
    { connection_id: connectionId, account_id: ada.id },
  );
  const [connection] = await dbClient!.db.insert(schema!.tracker_connections).values({
    id: connectionId, account_id: ada.id, provider: "jira", display_name: "acme", site_key: `acme-${seq}`,
    site_url: "https://acme.atlassian.net", auth_kind: "api_token", credentials_ciphertext: sealed.ciphertext,
    credentials_iv: sealed.iv, credentials_version: sealed.version, tracker_user_id: "acc-ada", tracker_user_label: "Ada",
    status_map: {},
  }).returning();
  await filters!.upsertRoomTrackerFilter({ room_id: room.id, connection_id: connectionId, provider: "jira", filter: "project = HT", enabled, account_id: ada.id });
  return { room, connection: connection!, path: `/rooms/${encodeURIComponent(room.id)}/work-items` };
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    globalThis.fetch = fakeJiraFetch as typeof fetch;
    ada = await person("ada");
    cy = await person("cy");
    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  test.after(async () => {
    globalThis.fetch = realFetch;
    routesModule!.closeApiRouteEventBroker();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await dbClient!.pool.end();
  });
}

async function get(route: string, headers: Record<string, string> = {}) {
  const res = await realFetch(`${base}${route}`, { headers });
  return { status: res.status, body: await res.json() };
}

test("only a participant reads the room's work items", { skip }, async () => {
  const { path: route } = await trackerRoom();
  tickets.set("HT-1", { status: "To Do", category: "new", updated: "2026-11-17T10:00:00.000+0000" });
  tickets.set("HR-1", { status: "Secret", category: "new", updated: "2026-11-17T10:00:00.000+0000" });
  jiraRequests.length = 0;

  assert.deepEqual(await get(route, { cookie: cy.cookie }), {
    status: 403, body: { code: "not_participant", message: "You are not a participant in this room." },
  });
  assert.equal((await get(route)).status, 401);
  assert.equal(jiraRequests.length, 0, "no tracker request before room access");

  const ok = await get(`${route}?query=${encodeURIComponent('status = "To Do"')}&limit=5`, { cookie: ada.cookie });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(WorkItemSearchResult.safeParse(ok.body).success);
  assert.deepEqual(ok.body.items.map((item: { key: string }) => item.key), ["HT-1"]);

  assert.equal((await get(`${route}?query=${encodeURIComponent(") OR (project = HR")}`, { cookie: ada.cookie })).body.code, "invalid_input");
  assert.equal((await get(`${route}/HR-1`, { cookie: ada.cookie })).body.code, "not_found");
  assert.equal((await get(`${route}?limit=201`, { cookie: ada.cookie })).body.code, "invalid_input");
});

test("a disabled room filter is no_source", { skip }, async () => {
  const { path: route } = await trackerRoom(false);
  jiraRequests.length = 0;
  const res = await get(route, { cookie: ada.cookie });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "no_source");
  assert.equal(jiraRequests.length, 0);
});

test("a search right after a ticket change returns the new state, and the room hears work_items", { skip }, async () => {
  const { room, connection, path: route } = await trackerRoom();
  tickets.set("HT-2", { status: "To Do", category: "new", updated: "2026-11-17T10:00:00.000+0000" });
  const first = await get(route, { cookie: ada.cookie });
  assert.deepEqual(first.body.items.map((item: { key: string; status: string }) => [item.key, item.status]), [["HT-1", "To Do"], ["HT-2", "To Do"]]);

  // Jira changes; within 60 s the cached read still answers.
  tickets.set("HT-2", { status: "Done", category: "done", updated: "2026-11-17T11:00:00.000+0000" });
  assert.equal((await get(route, { cookie: ada.cookie })).body.items[1].status, "To Do");

  // Sync applies the change: the generation moves, the next search is live.
  const invalidated = new Promise<string>((resolve) => {
    const listener = (event: { projectId: string }) => {
      if (event.projectId !== room.id) return;
      events!.workItemEvents.off("work_items:invalidated", listener);
      resolve(event.projectId);
    };
    events!.workItemEvents.on("work_items:invalidated", listener);
  });
  const trackerSync = sync!.getDefaultTrackerSync()!;
  const applied = await trackerSync.applyItem(connection, {
    provider: "jira", key: "HT-2", title: "Ticket HT-2", ticket_state: "done", raw_status: "Done", unmapped: false,
    assignee_id: null, assignee_label: null, url: "https://acme.atlassian.net/browse/HT-2",
    tracker_updated_at: "2026-11-17T11:00:00.000Z", payload: {},
  }, { roomIds: [room.id] });
  assert.equal(applied.changed, true);
  assert.equal(await invalidated, room.id);

  const after = await get(route, { cookie: ada.cookie });
  const ticket = after.body.items.find((item: { key: string }) => item.key === "HT-2");
  assert.equal(ticket.status, "Done");
  assert.equal(ticket.statusCategory, "done");
  // The card sync created links back to the ticket.
  assert.deepEqual(ticket.linkedTask, { taskId: applied.created[0]!.id });
});
