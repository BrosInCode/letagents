import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { DataDocument } from "../../../shared/api/data.mjs";
import { parsePageManifest } from "../../../shared/api/manifest.mjs";

// The data.* methods end to end: the real app, auth middleware, room access
// and database. The scope rules for pages and agents, which no real caller
// reaches yet, are tested on resolveDocumentScope directly.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;

const { resolveDocumentScope } = await import("../v1/documents.js");

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 data DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const events = testDatabaseUrl ? await import("../server/events.js") : null;

let server: Server | null = null;
let base = "";
let roomA = "";
let roomB = "";

async function person(login: string): Promise<{ id: string; cookie: string }> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `api-v1-data-${login}`, login, display_name: login });
  const token = `api-v1-data-session-${login}`;
  await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return { id: account.id, cookie: `letagents_session=${token}` };
}

let ada: { id: string; cookie: string };
let bob: { id: string; cookie: string };
let cy: { id: string; cookie: string };

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

    ada = await person("ada");
    bob = await person("bob");
    cy = await person("cy");
    roomA = (await api!.createProjectWithName("api-v1-data-a")).id;
    roomB = (await api!.createProjectWithName("api-v1-data-b")).id;
    await members!.addRoomMember({ roomId: roomA, accountId: ada.id, addedVia: "creator" });
    await members!.addRoomMember({ roomId: roomA, accountId: bob.id, addedVia: "seed" });
    await members!.addRoomMember({ roomId: roomA, accountId: cy.id, addedVia: "seed" });
    await members!.addRoomMember({ roomId: roomB, accountId: ada.id, addedVia: "creator" });

    server = appModule!.createApiApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  test.after(async () => {
    routesModule!.closeApiRouteEventBroker();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await dbClient!.pool.end();
  });
}

const docPath = (room: string, scope: string, collection: string, docId?: string, query = "") =>
  `/rooms/${encodeURIComponent(room)}/data/${scope}/${collection}${docId === undefined ? "" : `/${docId}`}${query ? `?${query}` : ""}`;

async function call(method: string, route: string, who: { cookie: string }, body?: unknown) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { cookie: who.cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

test("set, get, update and delete one document; each write adds one to the revision", { skip }, async () => {
  const route = docPath(roomA, "page", "notes", "meeting-1");
  const created = await call("PUT", route, ada, { pageId: "pg_hub", data: { title: "Standup", owner: "ada", done: false } });
  assert.equal(created.status, 200);
  assert.ok(DataDocument.safeParse(created.body).success);
  assert.deepEqual({ ...created.body, updatedAt: "x" }, {
    scope: "page", pageId: "pg_hub", collection: "notes", docId: "meeting-1",
    data: { title: "Standup", owner: "ada", done: false }, revision: 1,
    updatedBy: { kind: "person", id: ada.id }, updatedAt: "x",
  });

  const read = await call("GET", docPath(roomA, "page", "notes", "meeting-1", "pageId=pg_hub"), bob);
  assert.deepEqual(read, { status: 200, body: created.body, retryAfter: null });

  // A shallow merge: done changes, owner (null) goes, title stays. A
  // "__proto__" field is dropped by the input parse, never merged.
  const updated = await call("PATCH", route, bob, { pageId: "pg_hub", data: JSON.parse('{"done":true,"owner":null,"__proto__":1}') });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.data, { title: "Standup", done: true });
  assert.equal(updated.body.revision, 2);
  assert.deepEqual(updated.body.updatedBy, { kind: "person", id: bob.id });

  const replaced = await call("PUT", route, ada, { pageId: "pg_hub", data: { title: "Retro" } });
  assert.deepEqual([replaced.body.revision, replaced.body.data], [3, { title: "Retro" }]);

  assert.deepEqual((await call("DELETE", `${route}?pageId=pg_hub`, ada)).body, { deleted: true });
  assert.deepEqual((await call("DELETE", `${route}?pageId=pg_hub`, ada)).body, { deleted: false });
  assert.equal((await call("GET", `${route}?pageId=pg_hub`, ada)).body.code, "not_found");
  assert.equal((await call("PATCH", route, ada, { pageId: "pg_hub", data: { done: true } })).body.code, "not_found");
  // A new document after a delete starts again at revision 1.
  assert.equal((await call("PUT", route, ada, { pageId: "pg_hub", data: {} })).body.revision, 1);
});

test("compare-and-set: a write over a revision you did not read is a 409 conflict and changes nothing", { skip }, async () => {
  const route = docPath(roomA, "room", "calendar", "release-7");
  // ifRevision 0: create only.
  assert.equal((await call("PUT", route, ada, { data: { date: "2026-12-01" }, ifRevision: 0 })).body.revision, 1);
  const again = await call("PUT", route, bob, { data: { date: "2026-12-02" }, ifRevision: 0 });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "conflict");

  assert.equal((await call("PATCH", route, ada, { data: { date: "2026-12-03" }, ifRevision: 1 })).body.revision, 2);
  // Bob still holds revision 1.
  const stale = await call("PATCH", route, bob, { data: { date: "2026-12-04" }, ifRevision: 1 });
  assert.deepEqual(stale, { status: 409, body: { code: "conflict", message: "The document is at revision 2, not 1. Read it again and retry." }, retryAfter: null });
  assert.equal((await call("DELETE", `${route}?ifRevision=1`, bob)).body.code, "conflict");
  assert.deepEqual((await call("GET", route, bob)).body.data, { date: "2026-12-03" });
  assert.equal((await call("PUT", docPath(roomA, "room", "calendar", "missing"), bob, { data: {}, ifRevision: 4 })).body.code, "conflict");

  // Two writers race over the same revision: exactly one wins.
  const race = await Promise.all([
    call("PUT", route, ada, { data: { by: "ada" }, ifRevision: 2 }),
    call("PUT", route, bob, { data: { by: "bob" }, ifRevision: 2 }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await call("GET", route, ada)).body.revision, 3);
  assert.deepEqual((await call("DELETE", `${route}?ifRevision=3`, ada)).body, { deleted: true });
});

test("caps: 64 KB per document, 16 KB per viewer per page, 5,000 documents per scope", { skip }, async () => {
  const big = await call("PUT", docPath(roomA, "room", "blobs", "big"), ada, { data: { text: "x".repeat(64 * 1024) } });
  assert.equal(big.status, 413);
  assert.equal(big.body.code, "too_large");
  assert.equal((await call("PUT", docPath(roomA, "room", "blobs", "fits"), ada, { data: { text: "x".repeat(60 * 1024) } })).status, 200);
  // A merge that grows past the cap is refused too.
  assert.equal((await call("PATCH", docPath(roomA, "room", "blobs", "fits"), ada, { data: { more: "x".repeat(5 * 1024) } })).body.code, "too_large");

  const prefs = (docId: string) => docPath(roomA, "viewer", "prefs", docId);
  assert.equal((await call("PUT", prefs("a"), ada, { pageId: "pg_caps", data: { v: "x".repeat(9 * 1024) } })).status, 200);
  const over = await call("PUT", prefs("b"), ada, { pageId: "pg_caps", data: { v: "x".repeat(9 * 1024) } });
  assert.equal(over.body.code, "too_large");
  assert.match(over.body.message, /16384 bytes in all/);
  // Replacing a document counts its new size, not both; another viewer and another page have their own 16 KB.
  assert.equal((await call("PUT", prefs("a"), ada, { pageId: "pg_caps", data: { v: "x".repeat(15 * 1024) } })).status, 200);
  assert.equal((await call("PUT", prefs("b"), bob, { pageId: "pg_caps", data: { v: "x".repeat(9 * 1024) } })).status, 200);
  assert.equal((await call("PUT", prefs("b"), ada, { pageId: "pg_other", data: { v: "x".repeat(9 * 1024) } })).status, 200);

  await dbClient!.pool.query(
    `INSERT INTO api_documents (room_id, scope, scope_id, collection, doc_id, data, size_bytes, revision, updated_by_kind, updated_by_id)
     SELECT $1, 'page', 'pg_full', 'rows', 'r' || n, '{}'::jsonb, 2, 1, 'person', $2 FROM generate_series(1, 5000) AS n`,
    [roomA, ada.id],
  );
  const full = await call("PUT", docPath(roomA, "page", "other_collection", "one-more"), ada, { pageId: "pg_full", data: {} });
  assert.equal(full.body.code, "too_large");
  assert.match(full.body.message, /5000 documents/);
  // An existing document in a full scope can still change, and another page is not full.
  assert.equal((await call("PUT", docPath(roomA, "page", "rows", "r1"), ada, { pageId: "pg_full", data: { ok: true } })).body.revision, 2);
  assert.equal((await call("PUT", docPath(roomA, "page", "rows", "r1"), ada, { pageId: "pg_room_two", data: {} })).status, 200);
});

test("names, ids and the page id are checked against the contract", { skip }, async () => {
  for (const route of [
    docPath(roomA, "room", "Bad-Name", "d1"),
    docPath(roomA, "room", `c${"x".repeat(40)}`, "d1"),
    docPath(roomA, "room", "ok", "bad%20id"),
    docPath(roomA, "room", "ok", "x".repeat(129)),
    docPath(roomA, "team", "ok", "d1"),
  ]) {
    assert.equal((await call("PUT", route, ada, { data: {} })).body.code, "invalid_input", route);
  }
  assert.equal((await call("PUT", docPath(roomA, "room", `c${"x".repeat(39)}`, "a.b:c-d_E"), ada, { data: {} })).status, 200);
  assert.deepEqual((await call("PUT", docPath(roomA, "page", "ok", "d1"), ada, { data: {} })).body, {
    code: "invalid_input", message: "pageId: the page scope needs the page id.",
  });
  assert.equal((await call("PUT", docPath(roomA, "room", "ok", "d1"), ada, { pageId: "pg_hub", data: {} })).body.code, "invalid_input");
  assert.equal((await call("PUT", docPath(roomA, "room", "ok", "d1"), ada, { data: ["not", "an", "object"] })).body.code, "invalid_input");
});

test("the room in the URL decides everything: the same page id in another room sees nothing", { skip }, async () => {
  await call("PUT", docPath(roomA, "page", "steps", "s1"), ada, { pageId: "pg_shared", data: { room: "a" } });
  await call("PUT", docPath(roomA, "room", "steps", "s1"), ada, { data: { room: "a" } });
  await call("PUT", docPath(roomA, "viewer", "steps", "s1"), ada, { pageId: "pg_shared", data: { room: "a" } });

  for (const scope of ["page", "room", "viewer"]) {
    const query = scope === "room" ? "" : "pageId=pg_shared";
    assert.equal((await call("GET", docPath(roomB, scope, "steps", "s1", query), ada)).status, 404, scope);
    assert.deepEqual((await call("GET", docPath(roomB, scope, "steps", undefined, query), ada)).body, { documents: [], nextAfter: null }, scope);
  }
  // Writing in room B makes a separate document, and room A's is unchanged.
  assert.equal((await call("PUT", docPath(roomB, "page", "steps", "s1"), ada, { pageId: "pg_shared", data: { room: "b" } })).body.revision, 1);
  assert.deepEqual((await call("GET", docPath(roomA, "page", "steps", "s1", "pageId=pg_shared"), ada)).body.data, { room: "a" });
  // Bob is not in room B at all.
  assert.equal((await call("GET", docPath(roomB, "page", "steps", "s1", "pageId=pg_shared"), bob)).body.code, "not_participant");
});

test("the viewer scope is only ever the caller's own data", { skip }, async () => {
  await call("PUT", docPath(roomA, "viewer", "tabs", "current"), ada, { pageId: "pg_view", data: { tab: "release" } });
  await call("PUT", docPath(roomA, "viewer", "tabs", "current"), bob, { pageId: "pg_view", data: { tab: "sprint" } });
  assert.deepEqual((await call("GET", docPath(roomA, "viewer", "tabs", "current", "pageId=pg_view"), ada)).body.data, { tab: "release" });
  assert.deepEqual((await call("GET", docPath(roomA, "viewer", "tabs", "current", "pageId=pg_view"), bob)).body.data, { tab: "sprint" });
  assert.equal((await call("GET", docPath(roomA, "viewer", "tabs", "current", "pageId=pg_view"), cy)).status, 404);
  assert.deepEqual((await call("GET", docPath(roomA, "viewer", "tabs", undefined, "pageId=pg_view"), cy)).body, { documents: [], nextAfter: null });
  const list = await call("GET", docPath(roomA, "viewer", "tabs", undefined, "pageId=pg_view"), bob);
  assert.deepEqual(list.body.documents.map((d: { data: unknown; pageId: string }) => [d.pageId, d.data]), [["pg_view", { tab: "sprint" }]]);
  // Bob's delete removes only his own.
  assert.deepEqual((await call("DELETE", docPath(roomA, "viewer", "tabs", "current", "pageId=pg_view"), bob)).body, { deleted: true });
  assert.equal((await call("GET", docPath(roomA, "viewer", "tabs", "current", "pageId=pg_view"), ada)).status, 200);
});

test("a list pages through the collection in doc id order", { skip }, async () => {
  for (const id of ["e", "a", "c", "b", "d"]) await call("PUT", docPath(roomA, "page", "queue", id), ada, { pageId: "pg_list", data: { id } });
  await call("PUT", docPath(roomA, "page", "other", "z"), ada, { pageId: "pg_list", data: {} });
  const seen: string[][] = [];
  let after: string | null = "";
  while (after !== null) {
    const query: string = `pageId=pg_list&limit=2${after ? `&after=${after}` : ""}`;
    const page = await call("GET", docPath(roomA, "page", "queue", undefined, query), bob);
    assert.equal(page.status, 200);
    seen.push(page.body.documents.map((d: { docId: string }) => d.docId));
    after = page.body.nextAfter;
  }
  assert.deepEqual(seen, [["a", "b"], ["c", "d"], ["e"]]);
  assert.equal((await call("GET", docPath(roomA, "page", "queue", undefined, "pageId=pg_list&limit=101"), bob)).body.code, "invalid_input");
});

test("each write publishes a documents invalidation for the room; a read or a no-op delete does not", { skip }, async () => {
  const seen: Array<{ projectId: string; resource: string }> = [];
  // Room B only: writes in room A from earlier tests may still be coalescing.
  const listener = (event: { projectId: string; resource: string }) => {
    if (event.projectId === roomB) seen.push(event);
  };
  events!.roomResourceEvents.on("room_resource:invalidated", listener);
  try {
    await call("PUT", docPath(roomB, "room", "events", "e1"), ada, { data: { n: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(seen, [{ projectId: roomB, resource: "documents" }]);

    seen.length = 0;
    await call("GET", docPath(roomB, "room", "events", "e1"), ada);
    await call("DELETE", docPath(roomB, "room", "events", "missing"), ada);
    await call("PUT", docPath(roomB, "room", "events", "e1"), ada, { data: {}, ifRevision: 9 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(seen, []);

    await call("DELETE", docPath(roomB, "room", "events", "e1"), ada);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(seen, [{ projectId: roomB, resource: "documents" }]);
  } finally {
    events!.roomResourceEvents.off("room_resource:invalidated", listener);
  }
});

test("writes are limited to 120 a minute per actor", { skip }, async () => {
  for (let n = 0; n < 120; n += 1) {
    const res = await call("PUT", docPath(roomA, "room", "counter", "c"), cy, { data: { n } });
    assert.equal(res.status, 200, `write ${n}`);
  }
  const limited = await call("PUT", docPath(roomA, "room", "counter", "c"), cy, { data: { n: 120 } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.ok(Number(limited.retryAfter) > 0);
  // Reads have their own class.
  assert.equal((await call("GET", docPath(roomA, "room", "counter", "c"), cy)).body.revision, 120);
});

// ── Scope rules for callers no route resolves yet (pages, agents) ──────────

const pageActor = { principal: { kind: "person" as const, id: "acct_ada" }, via: { kind: "page" as const, id: "pg_hub" }, roomId: "room_a" };
const agentActor = { principal: { kind: "agent" as const, id: "agent_key_1" }, roomId: "room_a" };

test("a page uses its own page id, and is refused another page's", () => {
  const call = { actor: pageActor, roomId: "room_a" };
  assert.deepEqual(resolveDocumentScope(call, { scope: "page" }), { roomId: "room_a", scope: "page", scopeId: "pg_hub", pageId: "pg_hub" });
  assert.deepEqual(resolveDocumentScope(call, { scope: "page", pageId: "pg_hub" }).scopeId, "pg_hub");
  assert.deepEqual(resolveDocumentScope(call, { scope: "viewer" }), { roomId: "room_a", scope: "viewer", scopeId: "pg_hub:acct_ada", pageId: "pg_hub" });
  assert.throws(() => resolveDocumentScope(call, { scope: "page", pageId: "pg_other" }), { code: "not_granted" });
  assert.throws(() => resolveDocumentScope(call, { scope: "viewer", pageId: "pg_other" }), { code: "not_granted" });
  assert.deepEqual(resolveDocumentScope(call, { scope: "room" }), { roomId: "room_a", scope: "room", scopeId: "", pageId: null });
});

test("an agent names the page for page data and has no viewer data", () => {
  const call = { actor: agentActor, roomId: "room_a" };
  assert.equal(resolveDocumentScope(call, { scope: "page", pageId: "pg_hub" }).scopeId, "pg_hub");
  assert.throws(() => resolveDocumentScope(call, { scope: "page" }), { code: "invalid_input" });
  assert.throws(() => resolveDocumentScope(call, { scope: "viewer", pageId: "pg_hub" }), { code: "not_granted" });
  assert.equal(resolveDocumentScope(call, { scope: "room" }).scopeId, "");
});

test("a collection name a manifest accepts is one the data methods accept", () => {
  const capabilities = ["data.room"];
  assert.equal(parsePageManifest({ api: 1, title: "T", surfaces: ["room.tab"], capabilities, collections: { room: [`c${"x".repeat(39)}`] } }).ok, true);
  assert.equal(parsePageManifest({ api: 1, title: "T", surfaces: ["room.tab"], capabilities, collections: { room: [`c${"x".repeat(40)}`] } }).ok, false);
});
