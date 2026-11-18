import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { capabilityForCall } from "../../../shared/api/core.mjs";
import { DataDocument, getDocument, listDocuments, setDocument } from "../../../shared/api/data.mjs";
import { parsePageManifest } from "../../../shared/api/manifest.mjs";

// The data.* methods end to end: the real app, auth middleware, room access
// and database. The scope rules for pages and agents, which no real caller
// reaches yet, are tested on resolveDocumentScope directly.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;

const documents = await import("../v1/documents.js");
const { resolveDocumentScope } = documents;
const { createCapabilityCheck } = await import("../v1/capability.js");

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 data DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;
const events = testDatabaseUrl ? await import("../server/events.js") : null;

let server: Server | null = null;
let github: Server | null = null;
const previousGitHubBaseUrl = process.env.GITHUB_API_BASE_URL;
const REPO_ROOM = "github.com/acme/widgets";
let base = "";
let roomA = "";
let roomB = "";

async function person(login: string, githubToken: string | null = null): Promise<{ id: string; cookie: string }> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `api-v1-data-${login}`, login, display_name: login });
  const token = `api-v1-data-session-${login}`;
  await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60 * 60_000).toISOString(), githubToken);
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

    // A GitHub stub: acme/widgets is public, and only the token "github-token-role" has a role on it.
    github = createServer((req, res) => {
      const found = (req.url ?? "").toLowerCase().startsWith("/repos/acme/widgets");
      const role = req.headers.authorization === "Bearer github-token-role";
      res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(found ? { private: false, owner: { login: "acme" }, permissions: { pull: true, triage: role } } : { message: "Not Found" }));
    }).listen(0, "127.0.0.1");
    await once(github, "listening");
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    await dbClient!.pool.query(`INSERT INTO rooms (id, display_name, created_at) VALUES ($1, 'acme/widgets', now())`, [REPO_ROOM]);
    await dbClient!.pool.query(`INSERT INTO room_git_bindings (room_id, provider, host, repository_full_name, repository_owner,
      repository_name, ref_type, ref_name, default_branch, visibility, is_default, source, created_at, updated_at)
      VALUES ($1, 'github', 'github.com', 'acme/widgets', 'acme', 'widgets', 'default_branch', 'main', 'main',
      'public', true, 'manual', now(), now())`, [REPO_ROOM]);

    ada = await person("ada", "github-token-role");
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
    await new Promise<void>((resolve) => github?.close(() => resolve()) ?? resolve());
    if (previousGitHubBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = previousGitHubBaseUrl;
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

  // A shallow merge: done changes, owner (null) goes, title stays.
  const updated = await call("PATCH", route, bob, { pageId: "pg_hub", data: { done: true, owner: null } });
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
  // The delete took revision 4; a document made again goes on from there, never back to 1.
  assert.equal((await call("PUT", route, ada, { pageId: "pg_hub", data: {} })).body.revision, 5);
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

test("each write publishes a documents invalidation for the room; a read, a viewer write or a no-op delete does not", { skip }, async () => {
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
    // A viewer's own data is nobody else's news.
    await call("PUT", docPath(roomB, "viewer", "events", "mine"), ada, { pageId: "pg_events", data: { n: 1 } });
    await call("DELETE", docPath(roomB, "viewer", "events", "mine", "pageId=pg_events"), ada);
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

test("revisions never repeat: a writer holding a revision from before a delete and re-create gets a conflict", { skip }, async () => {
  const route = docPath(roomA, "room", "aba", "doc");
  assert.equal((await call("PUT", route, ada, { data: { v: "first" } })).body.revision, 1);
  const held = (await call("GET", route, bob)).body.revision;
  assert.deepEqual((await call("DELETE", route, ada)).body, { deleted: true });
  // Gone for reads and lists, and "does not exist" for ifRevision 0.
  assert.equal((await call("GET", route, bob)).status, 404);
  assert.deepEqual((await call("GET", docPath(roomA, "room", "aba"), bob)).body, { documents: [], nextAfter: null });
  const again = await call("PUT", route, ada, { data: { v: "second" }, ifRevision: 0 });
  assert.equal(again.body.revision, 3);
  const stale = await call("PUT", route, bob, { data: { v: "stale" }, ifRevision: held });
  assert.equal(stale.body.code, "conflict");
  assert.deepEqual((await call("GET", route, bob)).body.data, { v: "second" });
});

test("document bodies Postgres cannot store, or that carry prototype keys, are invalid_input, never a 500", { skip }, async () => {
  const nest = (levels: number): Record<string, unknown> => {
    let value: Record<string, unknown> = { leaf: true };
    for (let n = 1; n < levels; n += 1) value = { a: value };
    return value;
  };
  const route = docPath(roomA, "room", "shapes", "s");
  assert.equal((await call("PUT", route, ada, { data: nest(64) })).status, 200);
  const cases: Array<[string, string]> = [
    [JSON.stringify({ data: nest(65) }), "nest at most 64 deep"],
    [JSON.stringify({ data: { list: [[[{ text: "nul \u0000 here" }]]] } }), "NUL character"],
    [JSON.stringify({ data: { ["key\u0000"]: 1 } }), "NUL character (\\u0000) is not allowed in a key"],
    [JSON.stringify({ data: { text: "half \ud800 a pair" } }), "lone UTF-16 surrogate"],
    [JSON.stringify({ data: { ["\udc00"]: 1 } }), "lone UTF-16 surrogate"],
    ['{"data":{"__proto__":{"admin":true}}}', 'The key "__proto__" is not allowed.'],
    ['{"data":{"rows":[{"__proto__":1}]}}', 'data.rows[0].__proto__: The key "__proto__" is not allowed.'],
    ['{"data":{"a":{"constructor":{"prototype":1}}}}', 'The key "constructor" is not allowed.'],
    ['{"data":{"prototype":1}}', 'The key "prototype" is not allowed.'],
  ];
  for (const [body, message] of cases) {
    const res = await fetch(`${base}${route}`, { method: "PUT", headers: { cookie: ada.cookie, "content-type": "application/json" }, body });
    const answer = await res.json();
    assert.equal(res.status, 400, body.slice(0, 60));
    assert.equal(answer.code, "invalid_input");
    assert.ok(answer.message.includes(message), `${answer.message} should include ${message}`);
  }
  // The same rules hold for a merge.
  assert.equal((await call("PATCH", route, ada, { data: { text: "\ud800" } })).body.code, "invalid_input");
  // Paired surrogates (an emoji) are fine.
  assert.deepEqual((await call("PUT", route, ada, { data: { text: "ship it 🚀" } })).body.data, { text: "ship it 🚀" });
});

test("room caps: 50,000 documents and 50 MB per room across all scopes, kept in the usage row", { skip }, async () => {
  // The usage row counts live documents and bytes exactly: compare with the rows in room B.
  const usage = async (room: string) => (await dbClient!.pool.query(
    "SELECT docs, bytes::float8 AS bytes FROM api_document_usage WHERE room_id = $1", [room])).rows[0];
  const actual = async (room: string) => (await dbClient!.pool.query(
    "SELECT count(*)::int AS docs, COALESCE(sum(size_bytes), 0)::float8 AS bytes FROM api_documents WHERE room_id = $1 AND NOT deleted", [room])).rows[0];
  await call("PUT", docPath(roomB, "page", "usage", "u1"), ada, { pageId: "pg_u", data: { v: "x".repeat(100) } });
  await call("PUT", docPath(roomB, "room", "usage", "u2"), ada, { data: { v: 1 } });
  await call("PATCH", docPath(roomB, "page", "usage", "u1"), ada, { pageId: "pg_u", data: { w: 2 } });
  await call("DELETE", docPath(roomB, "room", "usage", "u2"), ada);
  assert.deepEqual(await usage(roomB), await actual(roomB));

  const before = await usage(roomB);
  try {
    await dbClient!.pool.query("UPDATE api_document_usage SET docs = 50000 WHERE room_id = $1", [roomB]);
    const full = await call("PUT", docPath(roomB, "page", "usage", "new"), ada, { pageId: "pg_fresh", data: {} });
    assert.equal(full.body.code, "too_large");
    assert.match(full.body.message, /50000 documents/);
    // A document already there may still change.
    assert.equal((await call("PATCH", docPath(roomB, "page", "usage", "u1"), ada, { pageId: "pg_u", data: { w: 3 } })).status, 200);

    await dbClient!.pool.query("UPDATE api_document_usage SET docs = $2, bytes = $3 WHERE room_id = $1", [roomB, before.docs, 50 * 1024 * 1024 - 50]);
    const heavy = await call("PUT", docPath(roomB, "room", "usage", "heavy"), ada, { data: { v: "x".repeat(100) } });
    assert.equal(heavy.body.code, "too_large");
    assert.match(heavy.body.message, /52428800 bytes/);
    // Shrinking a document is always allowed.
    assert.equal((await call("PUT", docPath(roomB, "page", "usage", "u1"), ada, { pageId: "pg_u", data: {} })).status, 200);
  } finally {
    await dbClient!.pool.query("UPDATE api_document_usage SET docs = d.docs, bytes = d.bytes FROM (SELECT count(*)::int AS docs, COALESCE(sum(size_bytes), 0) AS bytes FROM api_documents WHERE room_id = $1 AND NOT deleted) AS d WHERE room_id = $1", [roomB]);
  }
});

test("old tombstones go when a later delete runs in the room; tombstones never count toward the caps", { skip }, async () => {
  await dbClient!.pool.query(
    `INSERT INTO api_documents (room_id, scope, scope_id, collection, doc_id, data, size_bytes, revision, deleted, updated_by_kind, updated_by_id, updated_at)
     VALUES ($1, 'room', '', 'old', 'gone', '{}'::jsonb, 0, 7, true, 'person', $2, now() - interval '40 days'),
            ($1, 'room', '', 'old', 'recent', '{}'::jsonb, 0, 3, true, 'person', $2, now() - interval '2 days')`,
    [roomB, ada.id],
  );
  await call("PUT", docPath(roomB, "room", "old", "live"), ada, { data: {} });
  await call("DELETE", docPath(roomB, "room", "old", "live"), ada);
  const { rows } = await dbClient!.pool.query("SELECT doc_id FROM api_documents WHERE room_id = $1 AND collection = 'old' ORDER BY doc_id", [roomB]);
  assert.deepEqual(rows.map((row) => row.doc_id), ["live", "recent"]);
  // A full scope with a tombstone in it: delete one document and a new one fits.
  assert.deepEqual((await call("DELETE", docPath(roomA, "page", "rows", "r2", "pageId=pg_full"), ada)).body, { deleted: true });
  assert.equal((await call("PUT", docPath(roomA, "page", "rows", "new-one"), ada, { pageId: "pg_full", data: {} })).status, 200);
});

test("writes take the room's posting rule: a public Git Room reader without a role cannot write", { skip }, async () => {
  // Ada holds a role on acme/widgets and can write through the API.
  assert.equal((await call("PUT", docPath(REPO_ROOM, "room", "notes", "n1"), ada, { data: { by: "ada" } })).status, 200);
  // Bob has no role: the API refuses him at the room, and the store's own write check refuses him too.
  assert.equal((await call("PUT", docPath(REPO_ROOM, "room", "notes", "n1"), bob, { data: { by: "bob" } })).body.code, "not_participant");
  const room = await api!.getProjectById(REPO_ROOM);
  const bobAccount = { account_id: bob.id, login: "bob", provider: "github", provider_access_token: null } as never;
  await assert.rejects(
    documents.setDocument({ actor: { principal: { kind: "person", id: bob.id }, roomId: REPO_ROOM }, room: room!, account: bobAccount }, {
      scope: "room", collection: "notes", docId: "n1", data: { by: "bob" },
    }),
    { code: "not_participant" },
  );
  assert.deepEqual((await call("GET", docPath(REPO_ROOM, "room", "notes", "n1"), ada)).body.data, { by: "ada" });
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

test("the scope in the input picks the capability the pipeline checks", async () => {
  for (const method of [listDocuments, getDocument, setDocument]) {
    assert.equal(capabilityForCall(method, { scope: "viewer" }), "data.viewer");
    assert.equal(capabilityForCall(method, { scope: "page" }), "data.page");
    assert.equal(capabilityForCall(method, { scope: "room" }), "data.room");
  }
  // A page whose grant holds data.page only.
  const actor = { ...pageActor, via: { ...pageActor.via, version: 1 } };
  const pageGrant = { page_id: "pg_hub", page_version: 1, room_id: "room_a", capabilities: ["data.page"] };
  const call = { actor, room: { id: "room_a" }, account: null, req: { pageGrant } } as never;
  const check = createCapabilityCheck({
    resolvePolicy: async (_roomId, capability) => ({ capability, mode: "allow", configured: "allow", source: "default", rule: null }),
  });
  await check(actor, setDocument, { scope: "page" }, call);
  await assert.rejects(check(actor, setDocument, { scope: "room" }, call), {
    code: "not_granted", message: 'This caller does not hold the "data.room" capability.',
  });
  await assert.rejects(check(actor, listDocuments, { scope: "viewer" }, call), {
    code: "not_granted", message: 'This caller does not hold the "data.viewer" capability.',
  });
});

test("page and viewer data need a page placed in the room (pageExistsInRoom)", async () => {
  const call = { actor: agentActor, room: { id: "room_a" } as never, account: null };
  const pageExists = async (roomId: string, pageId: string) => roomId === "room_a" && pageId === "pg_placed";
  for (const run of [
    () => documents.getDocument(call, { scope: "page", pageId: "pg_unplaced", collection: "c", docId: "d" }, { pageExists }),
    () => documents.listDocuments(call, { scope: "page", pageId: "pg_unplaced", collection: "c", limit: 10 }, { pageExists }),
    () => documents.setDocument(call, { scope: "page", pageId: "pg_unplaced", collection: "c", docId: "d", data: {} }, { pageExists, invalidate: () => assert.fail("no write") }),
  ]) {
    await assert.rejects(run(), { code: "not_found", message: "No page with this id in this room." });
  }
  assert.equal(await documents.pageExistsInRoom("room_a", "anything"), true, "until the pages registry fills it");
});
