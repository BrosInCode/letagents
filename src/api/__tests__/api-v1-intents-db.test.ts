import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { Intent } from "../../../shared/api/intents.mjs";

// /api/v1 intents end to end: the real app, auth, room access, room policy,
// page grants, the room's tracker filter, sealed tracker credentials, the
// effect journal, the board, and a fake Jira site that records who wrote.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;
const CONNECTOR_KEY = randomBytes(32).toString("hex");
process.env.LETAGENTS_CONNECTOR_SECRET_KEY = CONNECTOR_KEY;

// The fake Jira sites. Tracker providers keep the fetch they were made with,
// and the effect broker makes its providers when the app loads, so the fake
// goes in before any app module.
const realFetch = globalThis.fetch;
const tickets = new Map<string, { status: string }>();
const jiraWrites: Array<{ site: string; as: string; method: string; path: string; body: unknown }> = [];
const TRANSITIONS = [{ id: "21", to: { name: "In Progress" } }, { id: "31", to: { name: "Done" } }];

function jiraIssue(key: string, site: string) {
  return {
    id: `id-${key}`,
    key,
    self: `${site}/rest/api/3/issue/${key}`,
    fields: {
      summary: `Ticket ${key}`,
      status: { name: tickets.get(key)!.status, statusCategory: { key: "new" } },
      assignee: null,
      updated: "2026-11-17T10:00:00.000+0000",
      labels: [],
    },
  };
}

function fakeJiraFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (!url.hostname.endsWith(".atlassian.net")) return realFetch(input, init);
  const site = `https://${url.hostname}`;
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  const as = Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString().split(":")[0] ?? "";
  const method = (init?.method ?? "GET").toUpperCase();
  const route = url.pathname.replace(/^\/rest\/api\/3/, "");
  const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
  if (route === "/field") return json([]);
  if (route === "/search/jql") {
    const jql = String((JSON.parse(String(init?.body)) as { jql: string }).jql);
    const project = /project = (\w+)/.exec(jql)?.[1];
    const key = /key = "([^"]+)"/.exec(jql)?.[1];
    const keys = [...tickets.keys()].filter((k) => (!project || k.startsWith(`${project}-`)) && (!key || k === key));
    return json({ issues: keys.map((k) => jiraIssue(k, site)), isLast: true });
  }
  const issue = /^\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?$/.exec(route);
  if (issue && tickets.has(issue[1]!)) {
    const [, key, tail] = issue;
    if (method === "POST") jiraWrites.push({ site, as, method, path: route, body: JSON.parse(String(init?.body)) });
    if (!tail) return json(jiraIssue(key!, site));
    if (tail === "/transitions" && method === "GET") return json({ transitions: TRANSITIONS });
    if (tail === "/transitions") {
      const id = (JSON.parse(String(init?.body)) as { transition: { id: string } }).transition.id;
      tickets.get(key!)!.status = TRANSITIONS.find((t) => t.id === id)!.to.name;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return json({ id: `comment-${jiraWrites.length}` }, 201);
  }
  return json({ errorMessages: ["not found"] }, 404);
}
globalThis.fetch = fakeJiraFetch as typeof fetch;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 intents DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const intentStore = testDatabaseUrl ? await import("../db/api-intents.js") : null;
const intentService = testDatabaseUrl ? await import("../intents/service.js") : null;
const effectRuntime = testDatabaseUrl ? await import("../workflow-effects/runtime.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const filters = testDatabaseUrl ? await import("../connectors/room-filters.js") : null;
const crypto = testDatabaseUrl ? await import("../connectors/crypto.js") : null;
const policy = testDatabaseUrl ? await import("../v1/policy.js") : null;
const events = testDatabaseUrl ? await import("../server/events.js") : null;
const helpers = testDatabaseUrl ? await import("./page-grant-test-helpers.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;

interface Person { id: string; session: string; email: string }
let server: Server | null = null;
let base = "";
let seq = 0;
let ada: Person; // room admin; her connection runs the room filter on acme
let bob: Person; // member; his own connection is on acme too
let cy: Person; // member; her own connection is on another Jira site
let dan: Person; // member; no tracker connection

async function person(login: string): Promise<Person> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `intent-${login}`, login, display_name: login });
  const session = `api-v1-intents-session-${login}`;
  await accountSessions!.createSession(account.id, session, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return { id: account.id, session, email: `${login}@example.com` };
}

async function connection(owner: Person, site: string, siteKey: string): Promise<string> {
  seq += 1;
  const id = `tcon_intent_${seq}`;
  const sealed = crypto!.createConnectorCipher(CONNECTOR_KEY).encrypt(
    { kind: "api_token", site_url: site, email: owner.email, api_token: `ATATT3xFfGF0token${seq}value1234567890` },
    { connection_id: id, account_id: owner.id },
  );
  await dbClient!.db.insert(schema!.tracker_connections).values({
    id, account_id: owner.id, provider: "jira", display_name: siteKey, site_key: siteKey, site_url: site, auth_kind: "api_token",
    credentials_ciphertext: sealed.ciphertext, credentials_iv: sealed.iv, credentials_version: sealed.version,
    tracker_user_id: `acc-${owner.id}`, tracker_user_label: owner.email, status_map: {},
  });
  return id;
}

let adaAcme = "";
const BOB_OWNER_TOKEN = "api_v1_intents_owner_token_bob";
const DAN_OWNER_TOKEN = "api_v1_intents_owner_token_dan";

/** A room Ada made (she is its admin); Bob, Cy and Dan are members. Its Jira filter is `project = HT` on Ada's acme connection. */
async function room(options: { tracker?: boolean } = {}) {
  seq += 1;
  const created = await api!.createProjectWithName(`api-v1-intents-${seq}`);
  await members!.recordRoomCreator(created.id, ada.id);
  for (const member of [bob, cy, dan]) await members!.addRoomMember({ roomId: created.id, accountId: member.id, addedVia: "seed" });
  if (options.tracker !== false) {
    await filters!.upsertRoomTrackerFilter({ room_id: created.id, connection_id: adaAcme, provider: "jira", filter: "project = HT", enabled: true, account_id: ada.id });
  }
  return { id: created.id, route: `/rooms/${encodeURIComponent(created.id)}/intents` };
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    ada = await person("ada");
    bob = await person("bob");
    cy = await person("cy");
    dan = await person("dan");
    await ownerTokens!.createOwnerToken({ accountId: bob.id, githubUserId: "intent-bob", token: BOB_OWNER_TOKEN });
    await ownerTokens!.createOwnerToken({ accountId: dan.id, githubUserId: "intent-dan", token: DAN_OWNER_TOKEN });
    adaAcme = await connection(ada, "https://acme.atlassian.net", "acme");
    await connection(bob, "https://acme.atlassian.net", "acme");
    await connection(cy, "https://other.atlassian.net", "other");
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

async function call(route: string, bearer: string, body?: unknown) {
  const res = await realFetch(`${base}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const propose = (route: string, bearer: string, kind: string, payload: unknown) => call(route, bearer, { kind, payload });
const approve = (route: string, bearer: string, id: string) => call(`${route}/${id}/approve`, bearer, {});
const deny = (route: string, bearer: string, id: string, reason?: string) => call(`${route}/${id}/deny`, bearer, reason ? { reason } : {});

async function effectsFor(roomId: string) {
  return (await dbClient!.pool.query(
    "SELECT task_id, subject, kind, state, request_payload FROM workflow_effects WHERE room_id = $1 ORDER BY created_at", [roomId])).rows;
}

test("a member's ticket.transition waits for a room admin, and the room hears about it", { skip }, async () => {
  const { id: roomId, route } = await room();
  tickets.set("HT-1", { status: "To Do" });
  jiraWrites.length = 0;
  const heard = new Promise<string>((resolve) => {
    const listener = (event: { projectId: string; resource: string }) => {
      if (event.projectId !== roomId || event.resource !== "intents") return;
      events!.roomResourceEvents.off("room_resource:invalidated", listener);
      resolve(event.resource);
    };
    events!.roomResourceEvents.on("room_resource:invalidated", listener);
  });

  const res = await propose(route, dan.session, "ticket.transition", { key: "HT-1", toStatus: "In Progress" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(Intent.safeParse(res.body).success);
  assert.equal(res.body.state, "pending_approval");
  assert.deepEqual(res.body.proposedBy, { principal: { kind: "person", id: dan.id, login: "dan" } });
  assert.equal(jiraWrites.length, 0);
  assert.deepEqual(await effectsFor(roomId), []);
  // Pages hear `intents` and read again.
  assert.equal(await heard, "intents");

  const notice = await dbClient!.pool.query("SELECT text, source FROM messages WHERE room_id = $1 AND client_message_id = $2",
    [roomId, `api_intent:${res.body.id}:approval_notify`]);
  assert.equal(notice.rowCount, 1);
  assert.match(notice.rows[0].text, /dan proposes to move HT-1 to In Progress\. .* waits for a room admin/);

  // The same person proposing the same change again gets the same pending intent.
  const again = await propose(route, dan.session, "ticket.transition", { key: "HT-1", toStatus: "In Progress" });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, res.body.id);
  // Another person proposing it gets their own.
  const other = await propose(route, cy.session, "ticket.transition", { key: "HT-1", toStatus: "In Progress" });
  assert.equal(other.status, 201);
  assert.notEqual(other.body.id, res.body.id);

  const pending = await call(`${route}?state=pending_approval`, ada.session);
  assert.deepEqual(pending.body.intents.map((intent: { id: string }) => intent.id).sort(), [res.body.id, other.body.id].sort());
});

test("with the viewer's own connection on the room's Jira site, ticket.transition runs at once through it", { skip }, async () => {
  const { id: roomId, route } = await room();
  tickets.set("HT-2", { status: "To Do" });
  jiraWrites.length = 0;

  const res = await propose(route, bob.session, "ticket.transition", { key: "HT-2", toStatus: "In Progress" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.state, "done", JSON.stringify(res.body));
  assert.equal(res.body.result.key, "HT-2");
  assert.equal(res.body.decidedBy, null);
  // Bob's credentials wrote, not the filter owner's.
  assert.deepEqual(jiraWrites.map(({ as, path: p }) => [as, p]), [["bob@example.com", "/issue/HT-2/transitions"]]);
  assert.equal(tickets.get("HT-2")!.status, "In Progress");

  // The journal row names the ticket, not a card.
  const [effect] = await effectsFor(roomId);
  assert.equal(effect.task_id, null);
  assert.equal(effect.subject, "jira:HT-2");
  assert.equal(effect.kind, "tracker_transition");
  assert.equal(effect.state, "succeeded");

  // A comment through his own connection runs too.
  const comment = await propose(route, bob.session, "ticket.comment", { key: "HT-2", body: "Started on this." });
  assert.equal(comment.body.state, "done", JSON.stringify(comment.body));
  assert.equal(jiraWrites.at(-1)!.path, "/issue/HT-2/comment");
  assert.equal(jiraWrites.at(-1)!.as, "bob@example.com");
});

test("a ticket outside the room filter is refused, and nothing is stored or written", { skip }, async () => {
  const { id: roomId, route } = await room();
  tickets.set("HR-9", { status: "To Do" });
  jiraWrites.length = 0;

  for (const who of [bob, dan]) {
    const res = await propose(route, who.session, "ticket.transition", { key: "HR-9", toStatus: "Done" });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "not_found");
  }
  assert.equal((await propose(route, bob.session, "ticket.comment", { key: "HR-9", body: "hi" })).body.code, "not_found");
  const stored = await dbClient!.pool.query("SELECT 1 FROM api_intents WHERE room_id = $1", [roomId]);
  assert.equal(stored.rowCount, 0);
  assert.equal(jiraWrites.length, 0);

  // A room with no tracker filter has no source at all.
  const bare = await room({ tracker: false });
  assert.equal((await propose(bare.route, bob.session, "ticket.transition", { key: "HT-1", toStatus: "Done" })).body.code, "no_source");
});

test("a viewer connection on another Jira site is not their own: an admin approves, and the room filter's connection runs it once", { skip }, async () => {
  const { id: roomId, route } = await room();
  tickets.set("HT-3", { status: "To Do" });
  jiraWrites.length = 0;

  const res = await propose(route, cy.session, "ticket.transition", { key: "HT-3", toStatus: "Done" });
  assert.equal(res.body.state, "pending_approval", JSON.stringify(res.body));
  assert.equal(jiraWrites.length, 0);

  // Only a room admin in person decides: not a member, not the admin's own page.
  const refused = { code: "not_granted", message: "Only a room admin, signed in to LetAgents, can approve or deny intents." };
  assert.deepEqual(await approve(route, bob.session, res.body.id), { status: 403, body: refused });
  const adminPage = await helpers!.mintTestPageGrant({ accountId: ada.id, roomId, capabilities: ["tickets.propose", "intents.read"] });
  assert.equal((await approve(route, adminPage.token, res.body.id)).body.code, "not_granted");

  const approved = await approve(route, ada.session, res.body.id);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.state, "done", JSON.stringify(approved.body));
  assert.equal(approved.body.decidedBy, ada.id);
  assert.deepEqual(jiraWrites.map(({ site, as }) => [site, as]), [["https://acme.atlassian.net", "ada@example.com"]]);

  // Approving again runs nothing twice.
  const twice = await approve(route, ada.session, res.body.id);
  assert.equal(twice.status, 200);
  assert.equal(twice.body.state, "done");
  assert.equal(jiraWrites.length, 1);
  assert.equal((await effectsFor(roomId)).length, 1);
  // A decided intent cannot be denied afterwards.
  assert.equal((await deny(route, ada.session, res.body.id)).body.code, "conflict");
  assert.equal((await call(`${route}/${res.body.id}`, dan.session)).body.state, "done");
});

test("an approved task.update from a page is applied without any agent", { skip }, async () => {
  const { id: roomId, route } = await room({ tracker: false });
  const task = await api!.createTask(roomId, "Fix the login page", "human");
  await api!.updateTask(roomId, task.id, { status: "accepted" });
  await policy!.setRoomPolicy({ roomId, capability: "tasks.propose", mode: "approve", accountId: ada.id });
  const page = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId, capabilities: ["tasks.propose", "intents.read"] });

  const res = await propose(route, page.token, "task.update", { taskId: task.id, status: "assigned", assignee: "bob" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.state, "pending_approval");
  assert.deepEqual(res.body.proposedBy, {
    principal: { kind: "person", id: bob.id, login: "bob" }, via: { kind: "page", id: "page_test", version: 1 },
  });
  assert.equal((await api!.getTaskById(roomId, task.id))!.status, "accepted");

  const approved = await approve(route, ada.session, res.body.id);
  assert.equal(approved.body.state, "done", JSON.stringify(approved.body));
  assert.deepEqual(approved.body.result, { taskId: task.id });
  const updated = (await api!.getTaskById(roomId, task.id))!;
  assert.equal(updated.status, "assigned");
  assert.equal(updated.assignee, "bob");
  // No board intent and no agent took part.
  assert.equal((await dbClient!.pool.query("SELECT 1 FROM board_intents WHERE room_id = $1", [roomId])).rowCount, 0);

  // The record keeps the page and the capability the kind needs.
  const actions = await dbClient!.pool.query(
    "SELECT method, capability, via_kind, outcome FROM api_actions WHERE room_id = $1 AND method = 'intents.propose'", [roomId]);
  assert.deepEqual(actions.rows, [{ method: "intents.propose", capability: "tasks.propose", via_kind: "page", outcome: "ok" }]);
});

test("a denied intent writes nothing, and cannot be approved afterwards", { skip }, async () => {
  const { id: roomId, route } = await room();
  const task = await api!.createTask(roomId, "Ship the release", "human");
  await policy!.setRoomPolicy({ roomId, capability: "tasks.propose", mode: "approve", accountId: ada.id });
  tickets.set("HT-4", { status: "To Do" });
  jiraWrites.length = 0;

  const update = await propose(route, dan.session, "task.update", { taskId: task.id, assignee: "dan" });
  const ticket = await propose(route, dan.session, "ticket.comment", { key: "HT-4", body: "Please look" });
  assert.equal(update.body.state, "pending_approval");
  assert.equal(ticket.body.state, "pending_approval");

  const denied = await deny(route, ada.session, update.body.id, "Not this sprint");
  assert.equal(denied.body.state, "denied");
  assert.equal(denied.body.error, "A room admin denied it: Not this sprint");
  assert.equal((await deny(route, ada.session, ticket.body.id)).body.state, "denied");
  // Denying again returns it; approving after a denial is a conflict.
  assert.equal((await deny(route, ada.session, update.body.id)).body.state, "denied");
  assert.equal((await approve(route, ada.session, update.body.id)).body.code, "conflict");

  assert.equal((await api!.getTaskById(roomId, task.id))!.assignee, null);
  assert.equal(jiraWrites.length, 0);
  assert.deepEqual(await effectsFor(roomId), []);
});

test("a page without tickets.propose cannot propose ticket kinds; its board kinds follow the Board Manager", { skip }, async () => {
  const { id: roomId, route } = await room();
  tickets.set("HT-5", { status: "To Do" });
  jiraWrites.length = 0;
  const page = await helpers!.mintTestPageGrant({ accountId: bob.id, roomId, capabilities: ["tasks.propose"] });

  assert.deepEqual(await propose(route, page.token, "ticket.transition", { key: "HT-5", toStatus: "Done" }), {
    status: 403, body: { code: "not_granted", message: 'This caller does not hold the "tickets.propose" capability.' },
  });
  // Without intents.read it cannot read intents back either.
  assert.equal((await call(route, page.token)).body.code, "not_granted");
  assert.equal((await dbClient!.pool.query("SELECT 1 FROM api_intents WHERE room_id = $1", [roomId])).rowCount, 0);

  // With the Board Manager off (the default), a page's board change runs at once.
  const created = await propose(route, page.token, "task.create", { title: "Write the release notes" });
  assert.equal(created.body.state, "done", JSON.stringify(created.body));
  const card = (await api!.getTaskById(roomId, created.body.result.taskId))!;
  assert.equal(card.title, "Write the release notes");
  // Bob is not an admin, so his card waits as proposed, as it does on the board.
  assert.equal(card.status, "proposed");
  assert.equal(card.created_by, "human");
  assert.equal(jiraWrites.length, 0);
});

test("board kinds keep the person's own rights: admin-only changes are refused at once", { skip }, async () => {
  const { route, id: roomId } = await room({ tracker: false });
  const task = await api!.createTask(roomId, "Refactor the API", "human");

  for (const payload of [{ taskId: task.id, status: "done" }, { taskId: task.id, title: "New title" }]) {
    const res = await propose(route, dan.session, "task.update", payload);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, "not_granted");
  }
  assert.equal((await propose(route, dan.session, "task.update", { taskId: "task_999", status: "in_progress" })).body.code, "not_found");
  // The board's status rule applies before anything waits or runs.
  const skipped = await propose(route, dan.session, "task.update", { taskId: task.id, status: "in_progress" });
  assert.equal(skipped.body.code, "conflict");
  assert.match(skipped.body.message, /is proposed; it can move to accepted, cancelled, not in_progress/);
  assert.equal((await propose(route, dan.session, "task.update", { taskId: task.id })).body.code, "invalid_input");
  assert.equal((await dbClient!.pool.query("SELECT 1 FROM api_intents WHERE room_id = $1", [roomId])).rowCount, 0);

  // The admin may: her own write runs at once, and her card is accepted.
  const done = await propose(route, ada.session, "task.update", { taskId: task.id, status: "accepted", title: "Refactor the v1 API" });
  assert.equal(done.body.state, "done", JSON.stringify(done.body));
  const updated = (await api!.getTaskById(roomId, task.id))!;
  assert.equal(updated.status, "accepted");
  assert.equal(updated.title, "Refactor the v1 API");
  const created = await propose(route, ada.session, "task.create", { title: "Plan the launch" });
  assert.equal((await api!.getTaskById(roomId, created.body.result.taskId))!.status, "accepted");
});

test("an owner token acts through an integration: no board kinds, and every ticket write waits for a room admin", { skip }, async () => {
  const { id: roomId, route } = await room();
  const task = await api!.createTask(roomId, "Owner token target", "human");
  tickets.set("HT-6", { status: "To Do" });
  jiraWrites.length = 0;

  for (const [kind, payload] of [["task.create", { title: "From a script" }], ["task.update", { taskId: task.id, assignee: "bob" }]] as const) {
    const res = await propose(route, BOB_OWNER_TOKEN, kind, payload);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, "not_granted");
    assert.match(res.body.message, /board intents/);
  }

  // Dan has no connection of his own: the filter owner's would write, so an admin approves.
  const pending = await propose(route, DAN_OWNER_TOKEN, "ticket.transition", { key: "HT-6", toStatus: "Done" });
  assert.equal(pending.body.state, "pending_approval", JSON.stringify(pending.body));
  assert.deepEqual(pending.body.proposedBy.via, { kind: "integration", id: "owner-token" });
  // Bob's own connection is on the room's site, but a token is not Bob in person: it waits too.
  const own = await propose(route, BOB_OWNER_TOKEN, "ticket.comment", { key: "HT-6", body: "Seen" });
  assert.equal(own.body.state, "pending_approval", JSON.stringify(own.body));
  assert.deepEqual(jiraWrites, [], "nothing is written to Jira before an admin approves");
  assert.equal((await api!.getTaskById(roomId, task.id))!.assignee, null);
  const ownApproved = await approve(route, ada.session, own.body.id);
  assert.equal(ownApproved.body.state, "done", JSON.stringify(ownApproved.body));
  assert.equal(jiraWrites.length, 1);

  // Approving later keeps the limit the proposal was stored with.
  const approved = await approve(route, ada.session, pending.body.id);
  assert.equal(approved.body.state, "done", JSON.stringify(approved.body));
  assert.equal(jiraWrites.at(-1)!.as, "ada@example.com");
});

test("a room that allows tickets.propose still needs an admin when the filter owner's connection would write", { skip }, async () => {
  const { id: roomId, route } = await room();
  tickets.set("HT-7", { status: "To Do" });
  jiraWrites.length = 0;
  for (const mode of ["allow", "confirm"] as const) {
    await policy!.setRoomPolicy({ roomId, capability: "tickets.propose", mode, accountId: ada.id });
    const res = await propose(route, dan.session, "ticket.comment", { key: "HT-7", body: `under ${mode}` });
    assert.equal(res.body.state, "pending_approval", JSON.stringify(res.body));
  }
  // The viewer's own connection follows the room's allow.
  const own = await propose(route, bob.session, "ticket.comment", { key: "HT-7", body: "mine" });
  assert.equal(own.body.state, "done", JSON.stringify(own.body));
  assert.equal(jiraWrites.length, 1);
});

test("a retry with the same clientIntentId returns the first intent and runs nothing again", { skip }, async () => {
  const { route } = await room();
  tickets.set("HT-8", { status: "To Do" });
  jiraWrites.length = 0;
  const body = { kind: "ticket.comment", clientIntentId: "page-42:comment-1", payload: { key: "HT-8", body: "Once" } };
  const first = await call(route, bob.session, body);
  assert.equal(first.status, 201);
  assert.equal(first.body.state, "done");
  assert.equal(first.body.clientIntentId, "page-42:comment-1");
  const retry = await call(route, bob.session, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(jiraWrites.length, 1);
  // The same key for another change is a conflict; another person's same key is their own.
  assert.equal((await call(route, bob.session, { ...body, payload: { key: "HT-8", body: "Twice" } })).body.code, "conflict");
  const dans = await call(route, dan.session, body);
  assert.equal(dans.status, 201);
  assert.notEqual(dans.body.id, first.body.id);
  assert.equal((await call(route, bob.session, { ...body, clientIntentId: "has spaces" })).body.code, "invalid_input");
});

test("an approved intent that has not started can still be denied", { skip }, async () => {
  const { id: roomId, route } = await room();
  tickets.set("HT-9", { status: "To Do" });
  const res = await propose(route, dan.session, "ticket.transition", { key: "HT-9", toStatus: "Done" });
  const now = new Date().toISOString();
  assert.ok(await intentStore!.moveApiIntent(roomId, res.body.id, ["pending_approval"], { state: "approved", decided_by: ada.id, decided_at: now }, now));
  const denied = await deny(route, ada.session, res.body.id);
  assert.equal(denied.body.state, "denied", JSON.stringify(denied.body));
  assert.equal(tickets.get("HT-9")!.status, "To Do");
});

test("intents a stopped server left running finish from the board or the journal", { skip }, async () => {
  const { id: roomId, route } = await room();
  tickets.set("HT-10", { status: "To Do" });
  const actor = { principal: { kind: "person" as const, id: bob.id, login: "bob" }, roomId };
  const long = new Date(Date.now() - 11 * 60_000).toISOString();
  const running = async (kind: "task.create" | "task.update" | "ticket.comment", payload: Record<string, unknown>) =>
    (await intentStore!.insertApiIntent({ roomId, kind, payload, actor, state: "running", now: long })).row;

  // A card made before the stop: done. No card: failed. An update: failed.
  const made = await running("task.create", { title: "Made before the stop" });
  const card = await api!.createTask(roomId, "Made before the stop", "human", undefined, undefined, {
    clientTaskId: (await import("../intents/task-executor.js")).intentClientTaskId(made.id),
  });
  const lost = await running("task.create", { title: "Never made" });
  const update = await running("task.update", { taskId: card.id, assignee: "bob" });
  // A ticket write the journal finished, and one that never reached it.
  const written = await running("ticket.comment", { key: "HT-10", body: "Reached the journal" });
  const reserved = await effectRuntime!.workflowEffectBroker.reserveTrackerEffect({
    room_id: roomId, task_id: null, connection_id: adaAcme, connection_account_id: ada.id, provider: "jira", key: "HT-10",
    idempotency_key: `api_intent:${written.id}`, actor_label: "bob", action: { kind: "tracker_comment", body: "Reached the journal" },
  });
  // Driven outside any intent run: the settle hook finishes the intent.
  await effectRuntime!.workflowEffectBroker.driveTrackerEffect(reserved);
  assert.equal((await intentStore!.getApiIntent(roomId, written.id))!.state, "done");
  const never = await running("ticket.comment", { key: "HT-10", body: "Never journaled" });
  const fresh = await intentStore!.insertApiIntent({ roomId, kind: "task.update", payload: { taskId: card.id, status: "cancelled" }, actor, state: "running", now: new Date().toISOString() });

  assert.ok((await intentService!.sweepStuckIntents()) >= 4);
  const state = async (id: string) => (await intentStore!.getApiIntent(roomId, id))!;
  assert.deepEqual([(await state(made.id)).state, (await state(made.id)).result], ["done", { taskId: card.id }]);
  assert.equal((await state(lost.id)).state, "failed");
  assert.equal((await state(update.id)).state, "failed");
  assert.equal((await state(never.id)).state, "failed");
  // Running for less than ten minutes: left alone.
  assert.equal((await state(fresh.row.id)).state, "running");
  assert.equal((await call(`${route}/${made.id}`, dan.session)).body.state, "done");
});
