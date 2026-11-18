import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import express from "express";

import { PageDetail, PageDocument, PageGrantToken, PageList } from "../../../shared/api/pages.mjs";
import type { ApiCallerIdentifier } from "../v1/context.js";

// The pages registry end to end: the real auth middleware, caller and room
// access, capability check, page grants and database. Worker bearers may not
// write through /api/v1 yet, so agents (and a person acting through a job)
// are named with test headers; the rest is the real pipeline.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 pages DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const contentDeletion = testDatabaseUrl ? await import("../db/content-deletion.js") : null;
const middleware = testDatabaseUrl ? await import("../http/middleware.js") : null;
const requestAuth = testDatabaseUrl ? await import("../request/auth.js") : null;
const router = testDatabaseUrl ? await import("../v1/router.js") : null;
const actor = testDatabaseUrl ? await import("../v1/actor.js") : null;
const capability = testDatabaseUrl ? await import("../v1/capability.js") : null;
const rateLimit = testDatabaseUrl ? await import("../v1/rate-limit.js") : null;
const pagesArea = testDatabaseUrl ? await import("../v1/areas/pages.js") : null;
const pagesRules = testDatabaseUrl ? await import("../v1/pages.js") : null;
const documents = testDatabaseUrl ? await import("../v1/documents.js") : null;
const workItemFields = testDatabaseUrl ? await import("../v1/work-item-fields.js") : null;
const pageGrants = testDatabaseUrl ? await import("../v1/page-grants.js") : null;
const grantHelpers = testDatabaseUrl ? await import("./page-grant-test-helpers.js") : null;

const OWNER_TOKEN = "api_v1_pages_owner_token_ada";

interface Person { id: string; cookie: string; sessionId: string }
let ada: Person; // room A admin
let bob: Person; // room A participant, owns agent-bob
let dee: Person; // room A participant
let cy: Person; // room B admin
let roomA = "";
let roomB = "";
let server: Server | null = null;
let base = "";
let origin = "";

// The room each agent's worker session is in.
const agentRooms = new Map<string, string>();
const attachmentBytes = new Map<string, Buffer>();

const identifyCaller: ApiCallerIdentifier = async (req) => {
  const agent = req.headers["x-test-agent"];
  if (typeof agent === "string") return { principal: { kind: "agent", id: agent }, account: null, roomId: agentRooms.get(agent) };
  const caller = await actor!.identifyCaller(req);
  const job = req.headers["x-test-job"];
  return caller && typeof job === "string" ? { ...caller, via: { kind: "job", id: job } } : caller;
};

async function person(login: string): Promise<Person> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `api-v1-pages-${login}`, login, display_name: login });
  const token = `api-v1-pages-session-${login}`;
  const session = await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return { id: account.id, cookie: `letagents_session=${token}`, sessionId: session.id };
}

async function agent(key: string, owner: Person, roomId: string): Promise<void> {
  await dbClient!.pool.query(
    `INSERT INTO agents (id, canonical_key, name, display_name, owner_account_id, owner_login, owner_label, created_at, updated_at)
      VALUES ($1, $1, $1, $1, $2, 'owner', 'owner', now(), now())`,
    [key, owner.id],
  );
  agentRooms.set(key, roomId);
}

async function room(name: string, admin: Person, ...others: Person[]): Promise<string> {
  const id = (await api!.createProjectWithName(name)).id;
  await members!.recordRoomCreator(id, admin.id);
  for (const other of others) await members!.addRoomMember({ roomId: id, accountId: other.id, addedVia: "seed" });
  return id;
}

if (testDatabaseUrl) {
  test.before(async () => {
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await dbClient!.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await dbClient!.pool.query("CREATE SCHEMA public");
    await migrate(dbClient!.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

    ada = await person("ada");
    bob = await person("bob");
    dee = await person("dee");
    cy = await person("cy");
    await ownerTokens!.createOwnerToken({ accountId: ada.id, githubUserId: "api-v1-pages-ada", token: OWNER_TOKEN });
    roomA = await room("api-v1-pages-a", ada, bob, dee);
    roomB = await room("api-v1-pages-b", cy);
    await agent("agent-ada", ada, roomA);
    await agent("agent-bob", bob, roomA);
    await agent("agent-cy", cy, roomB);

    const app = express();
    middleware!.registerHttpMiddleware(app, { resolveRequestAuth: requestAuth!.resolveRequestAuth });
    router!.registerApiV1Routes(app, {
      routes: pagesArea!.createPagesRoutes({
        readAttachment: async (attachment) => attachmentBytes.get(attachment.object_key) ?? Buffer.alloc(0),
      }),
      identifyCaller,
      resolveRoomAccess: actor!.resolveRoomAccess,
      checkCapability: capability!.checkCapability,
      // The bounds test makes more than a minute's worth of writes as one person.
      rateLimiter: rateLimit!.createApiRateLimiter({
        classes: Object.fromEntries(["read", "search", "write", "post", "intent", "job"].map((name) => [name, { limit: 100_000, windowMs: 60_000 }])) as never,
      }),
      strictContract: true,
    });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    base = `${origin}/api/v1`;
  });
  test.after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await dbClient!.pool.end();
  });
}

type As = Person | { agent: string } | { token: string } | { job: string; as: Person } | null;

async function call(method: string, route: string, as: As, body?: unknown) {
  const headers: Record<string, string> = {};
  if (as && "cookie" in as) {
    headers.cookie = as.cookie;
    // A cookie write must come from the app's own origin.
    headers.origin = origin;
  } else if (as && "agent" in as) headers["x-test-agent"] = as.agent;
  else if (as && "token" in as) headers.authorization = `Bearer ${as.token}`;
  else if (as && "job" in as) Object.assign(headers, { cookie: as.as.cookie, origin, "x-test-job": as.job });
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const pagesPath = (roomId: string, rest = "") => `/rooms/${encodeURIComponent(roomId)}/pages${rest}`;

function pageHtml(title: string, capabilities: string[] = [], extra: Record<string, unknown> = {}): string {
  const manifest = { api: 1, title, surfaces: ["room.tab"], capabilities, ...extra };
  return `<!doctype html><title>${title}</title>\n<script type="application/letagents-page+json">${JSON.stringify(manifest)}</script>\n<main>${title}</main>`;
}

async function create(as: As, title: string, capabilities: string[] = [], extra: Record<string, unknown> = {}, roomId = roomA) {
  return call("POST", pagesPath(roomId), as, { html: pageHtml(title, capabilities), ...extra });
}

/** A page made by `admin`, approved with its capabilities, pinned on the room tab. */
async function adminPage(title: string, capabilities: string[] = [], roomId = roomA, admin = ada): Promise<string> {
  const made = await create(admin, title, capabilities, {}, roomId);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  if (capabilities.length) {
    const approved = await call("POST", pagesPath(roomId, `/${id}/approve`), admin, { version: 1, capabilities });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  }
  assert.equal((await call("POST", pagesPath(roomId, `/${id}/placements`), admin, {})).status, 200);
  return id;
}

/** Opens a page as the person: the real page_grant bearer. */
async function open(as: Person, id: string, roomId = roomA): Promise<string> {
  const opened = await call("POST", pagesPath(roomId, `/${id}/grant`), as);
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  return opened.body.token as string;
}

async function tokenRevoked(token: string): Promise<boolean> {
  const { rows } = await dbClient!.pool.query(
    "SELECT revoked_at IS NOT NULL AS revoked FROM api_page_tokens WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')",
    [token],
  );
  assert.equal(rows.length, 1, "the token is stored");
  return rows[0].revoked;
}

/** An uploaded file on a message, as the attachment routes leave it. */
async function attach(roomId: string, messageNumber: number, uploadId: string, filename: string, byteSize: number, objectKey: string) {
  await dbClient!.pool.query(
    `INSERT INTO message_attachment_uploads (upload_id, room_id, filename, content_type, byte_size, storage_provider, bucket, object_key,
      status, expires_at, attached_message_number, created_at, attached_at)
      VALUES ($1, $2, $3, 'text/html', $4, 's3', 'b', $5, 'attached', now() + interval '1 hour', $6, now(), now())`,
    [uploadId, roomId, filename, byteSize, objectKey, messageNumber],
  );
  await dbClient!.pool.query(
    `INSERT INTO message_attachments (room_id, message_number, attachment_number, upload_id, filename, content_type, byte_size,
      storage_provider, bucket, object_key, created_at) VALUES ($1, $2, 1, $3, $4, 'text/html', $5, 's3', 'b', $6, now())`,
    [roomId, messageNumber, uploadId, filename, byteSize, objectKey],
  );
}

const statusOf = (detail: PageDetail, version: number) => detail.versions.find((row) => row.version === version)?.status;

test("who can do what: view, make, version, pin, approve, roll back, delete and open", { skip }, async () => {
  // Make a page: room admins and agents in the room go live (nothing asked);
  // a participant's page waits for a room admin.
  const byAda = await create(ada, "Ada page");
  assert.equal(byAda.status, 201);
  assert.ok(PageDetail.safeParse(byAda.body).success);
  assert.equal(byAda.body.currentVersion, 1);
  const byBob = await create(bob, "Bob page");
  assert.equal(byBob.status, 201);
  assert.equal(byBob.body.currentVersion, null);
  assert.equal(statusOf(byBob.body, 1), "pending_approval");
  assert.equal((await create({ agent: "agent-ada" }, "Agent ada page")).body.currentVersion, 1);
  assert.equal((await create({ agent: "agent-bob" }, "Agent bob page")).body.currentVersion, 1);
  // A job carries no permission: no pages through one.
  assert.equal((await create({ job: "job_1", as: ada }, "Through a job")).body.code, "not_granted");

  const id = await adminPage("Table page", ["rooms.read"]);
  const pageRoute = pagesPath(roomA, `/${id}`);
  let pageToken = await open(ada, id);
  assert.equal((await create({ token: pageToken }, "Through a page")).body.code, "not_granted");

  // View: every participant and agent in the room, and the page itself.
  for (const viewer of [ada, bob, { agent: "agent-bob" }, { token: pageToken }] as As[]) {
    assert.equal((await call("GET", pageRoute, viewer)).status, 200, JSON.stringify(viewer));
    assert.equal((await call("GET", `${pageRoute}/document`, viewer)).status, 200);
    assert.equal((await call("GET", pagesPath(roomA, "?surface=room.tab"), viewer)).status, 200);
  }

  // A version with the same capabilities: live for an admin and any agent; a participant's waits.
  const publish = (as: As, title: string, capabilities = ["rooms.read"]) =>
    call("POST", `${pageRoute}/versions`, as, { html: pageHtml(title, capabilities) });
  const v2 = await publish({ agent: "agent-bob" }, "Table page by agent-bob");
  assert.equal(v2.status, 201);
  assert.equal(v2.body.currentVersion, 2);
  assert.deepEqual(v2.body.updatedBy, { kind: "agent", id: "agent-bob", ownerAccountId: bob.id });
  assert.equal(v2.body.title, "Table page by agent-bob");
  assert.deepEqual(v2.body.grant.capabilities, ["rooms.read"]);
  assert.equal(v2.body.grant.approvedBy, ada.id, "the admin who granted these capabilities stays on the record");
  const v3 = await publish(bob, "Table page by bob");
  assert.equal(v3.body.currentVersion, 2);
  assert.equal(statusOf(v3.body, 3), "pending_approval");
  assert.equal((await publish(ada, "Table page by ada")).body.currentVersion, 4);
  assert.equal((await publish({ agent: "agent-cy" }, "From another room")).body.code, "not_participant");
  assert.equal((await publish({ job: "job_2", as: ada }, "Through a job")).body.code, "not_granted");

  // The live updates above ended the page's grants; open it again.
  assert.equal((await call("GET", pageRoute, { token: pageToken })).status, 401);
  pageToken = await open(ada, id);

  // Admin actions: only a room admin, in person, in the app.
  const adminOnly: [string, string, unknown][] = [
    ["POST", `${pageRoute}/placements`, {}],
    ["DELETE", `${pageRoute}/placements?surface=room.tab`, undefined],
    ["POST", `${pageRoute}/approve`, { version: 3, capabilities: ["rooms.read"] }],
    ["POST", `${pageRoute}/current`, { version: 2 }],
    ["DELETE", pageRoute, undefined],
  ];
  for (const [method, route, body] of adminOnly) {
    for (const who of [bob, { agent: "agent-ada" }, { token: OWNER_TOKEN }, { token: pageToken }, { job: "job_3", as: ada }] as As[]) {
      const refused = await call(method, route, who, body);
      assert.equal(refused.body.code, "not_granted", `${method} ${route} as ${JSON.stringify(who)}: ${JSON.stringify(refused.body)}`);
    }
  }
  // A cookie write from another site is refused too.
  const crossSite = await fetch(`${base}${pageRoute}/current`, {
    method: "POST", headers: { cookie: ada.cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ version: 2 }),
  });
  assert.equal((await crossSite.json()).code, "not_granted");

  // Roll back to version 2 (Undo): live again with its grant.
  const rolledBack = await call("POST", `${pageRoute}/current`, ada, { version: 2 });
  assert.equal(rolledBack.status, 200);
  assert.equal(rolledBack.body.currentVersion, 2);
  assert.equal(statusOf(rolledBack.body, 4), "superseded");
  assert.equal((await call("POST", `${pageRoute}/current`, ada, { version: 3 })).body.code, "conflict", "a version that never went live cannot be rolled back to");

  // Open a page: people only, in the app; the desktop's shape.
  const opened = await call("POST", `${pageRoute}/grant`, bob);
  assert.equal(opened.status, 201);
  assert.deepEqual(Object.keys(opened.body).sort(), ["capabilities", "expiresAt", "token"]);
  assert.ok(PageGrantToken.safeParse(opened.body).success);
  assert.match(opened.body.token, /^lapg\./);
  assert.deepEqual(opened.body.capabilities, ["rooms.read"]);
  assert.ok(Date.parse(opened.body.expiresAt) > Date.now());
  const { rows } = await dbClient!.pool.query(
    "SELECT account_id, page_id, page_version, capabilities FROM api_page_tokens WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')",
    [opened.body.token],
  );
  assert.deepEqual(rows, [{ account_id: bob.id, page_id: id, page_version: 2, capabilities: ["rooms.read"] }]);
  // The desktop names the version it shows: a grant for another version would mix them.
  assert.equal((await call("POST", `${pageRoute}/grant`, bob, { version: 2 })).status, 201);
  const otherVersion = await call("POST", `${pageRoute}/grant`, bob, { version: 4 });
  assert.equal(otherVersion.body.code, "conflict");
  assert.match(otherVersion.body.message, /Version 4 of this page is no longer live/);
  pageToken = await open(ada, id);
  for (const who of [{ agent: "agent-ada" }, { token: OWNER_TOKEN }, { token: pageToken }, { job: "job_4", as: ada }] as As[]) {
    assert.equal((await call("POST", `${pageRoute}/grant`, who)).body.code, "not_granted", JSON.stringify(who));
  }
  // A page that is not pinned cannot be opened.
  assert.equal((await call("POST", pagesPath(roomA, `/${byAda.body.id}/grant`), ada)).body.code, "not_found");

  // Delete: gone for everyone.
  assert.deepEqual((await call("DELETE", pageRoute, ada)).body, { id, deleted: true });
  assert.equal((await call("GET", pageRoute, ada)).status, 404);
});

test("a version that asks for more capabilities waits for a room admin, whoever made it", { skip }, async () => {
  const id = await adminPage("Widening", ["rooms.read"]);
  for (const who of [ada, { agent: "agent-ada" }, { agent: "agent-bob" }] as As[]) {
    const wider = await call("POST", pagesPath(roomA, `/${id}/versions`), who, { html: pageHtml("Widening", ["rooms.read", "tasks.read"]) });
    assert.equal(wider.status, 201);
    assert.equal(wider.body.currentVersion, 1);
    assert.equal(wider.body.versions[0].status, "pending_approval", JSON.stringify(who));
  }
  // A page made with capabilities waits too: there is no grant to keep.
  const made = await create({ agent: "agent-ada" }, "Asks at once", ["tasks.read"]);
  assert.equal(made.body.currentVersion, null);
  assert.equal(statusOf(made.body, 1), "pending_approval");
});

test("a page that can act for people takes new versions only from admins and agents of admins", { skip }, async () => {
  const id = await adminPage("Job desk", ["jobs.start"]);
  const publish = (as: As) => call("POST", pagesPath(roomA, `/${id}/versions`), as, { html: pageHtml("Job desk", ["jobs.start"]) });
  assert.equal(statusOf((await publish({ agent: "agent-bob" })).body, 2), "pending_approval", "agent whose owner is not an admin");
  assert.equal(statusOf((await publish(bob)).body, 3), "pending_approval", "a person who is not an admin");
  const byAgentAda = await publish({ agent: "agent-ada" });
  assert.equal(statusOf(byAgentAda.body, 4), "live", "agent whose owner is an admin");
  assert.equal(byAgentAda.body.currentVersion, 4);
  assert.equal((await publish(ada)).body.currentVersion, 5);
  // Dropping the capability does not dodge the rule: the page holds it now.
  const dropped = await call("POST", pagesPath(roomA, `/${id}/versions`), { agent: "agent-bob" }, { html: pageHtml("Job desk", []) });
  assert.equal(statusOf(dropped.body, 6), "pending_approval");
});

test("a draft shows only to room admins and its author or the author's owner", { skip }, async () => {
  const id = await adminPage("Drafts", ["rooms.read"]);
  const pageToken = await open(dee, id);
  const draft = await call("POST", pagesPath(roomA, `/${id}/versions`), { agent: "agent-bob" }, { html: pageHtml("Drafts v2", ["rooms.read"]), draft: true });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.currentVersion, 1);
  assert.equal(statusOf(draft.body, 2), "draft");
  const document = (as: As) => call("GET", pagesPath(roomA, `/${id}/document?version=2`), as);
  for (const who of [ada, bob, { agent: "agent-bob" }] as As[]) {
    assert.equal(statusOf((await call("GET", pagesPath(roomA, `/${id}`), who)).body, 2), "draft", JSON.stringify(who));
    const html = await document(who);
    assert.equal(html.status, 200);
    assert.equal(html.body.page.title, "Drafts v2");
  }
  for (const who of [dee, { agent: "agent-ada" }, { token: pageToken }, { job: "job_5", as: ada }] as As[]) {
    assert.equal(statusOf((await call("GET", pagesPath(roomA, `/${id}`), who)).body, 2), undefined, JSON.stringify(who));
    assert.equal((await document(who)).body.code, "not_found");
  }
  // The live document and the tab stay on version 1.
  assert.equal((await call("GET", pagesPath(roomA, `/${id}/document`), dee)).body.page.version, 1);
  assert.ok((await call("GET", pagesPath(roomA, "?surface=room.tab"), dee)).body.pages.some((page: { id: string; version: number }) => page.id === id && page.version === 1));
  // A draft cannot be approved into the room.
  assert.equal((await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 2, capabilities: [] })).body.code, "conflict");
});

test("a page with no live version is \"Untitled\" to those who cannot see its versions", { skip }, async () => {
  const made = await create(bob, "Secret plans", [], { slug: "secret-plans" });
  const id = made.body.id as string;
  assert.equal(made.body.title, "Secret plans");
  for (const who of [ada, bob] as As[]) assert.equal((await call("GET", pagesPath(roomA, `/${id}`), who)).body.title, "Secret plans");
  for (const who of [dee, { agent: "agent-ada" }] as As[]) {
    const seen = await call("GET", pagesPath(roomA, `/${id}`), who);
    assert.equal(seen.status, 200);
    assert.deepEqual([seen.body.title, seen.body.slug, seen.body.versions], ["Untitled", "untitled", []]);
  }
  await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 1, capabilities: [] });
  assert.equal((await call("GET", pagesPath(roomA, `/${id}`), dee)).body.title, "Secret plans");
});

test("an admin grants only capabilities the manifest asks for", { skip }, async () => {
  const made = await create(ada, "Approve me", ["rooms.read", "tasks.read"]);
  const id = made.body.id as string;
  assert.equal(made.body.currentVersion, null);
  const wider = await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 1, capabilities: ["rooms.read", "jobs.start"] });
  assert.equal(wider.status, 400);
  assert.equal(wider.body.code, "invalid_input");
  assert.match(wider.body.message, /jobs\.start/);
  assert.equal((await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 1, capabilities: ["rooms.admin"] })).body.code, "invalid_input");
  const approved = await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 1, capabilities: ["tasks.read"] });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.currentVersion, 1);
  assert.deepEqual({ ...approved.body.grant, approvedAt: "-" }, { version: 1, capabilities: ["tasks.read"], approvedBy: ada.id, approvedAt: "-" });
  assert.equal((await call("POST", pagesPath(roomA, `/${id}/placements`), ada, {})).status, 200);
  assert.deepEqual((await call("POST", pagesPath(roomA, `/${id}/grant`), dee)).body.capabilities, ["tasks.read"]);
});

test("unpin, a grant change, roll back, a live update and delete each end the page's open page grants", { skip }, async () => {
  const id = await adminPage("Revoke me", ["rooms.read", "tasks.read"]);
  const route = (rest = "") => pagesPath(roomA, `/${id}${rest}`);
  const steps: [string, () => Promise<{ status: number }>, () => Promise<void>][] = [
    ["approve with fewer capabilities", () => call("POST", route("/approve"), ada, { version: 1, capabilities: ["rooms.read"] }), async () => undefined],
    ["a live update", () => call("POST", route("/versions"), { agent: "agent-bob" }, { html: pageHtml("Revoke me 2", ["rooms.read"]) }), async () => undefined],
    ["roll back", () => call("POST", route("/current"), ada, { version: 1 }), async () => undefined],
    ["unpin", () => call("DELETE", route("/placements"), ada),
      async () => assert.equal((await call("POST", route("/placements"), ada, {})).status, 200)],
    ["delete", () => call("DELETE", route(), ada), async () => undefined],
  ];
  for (const [name, step, after] of steps) {
    const token = await open(dee, id);
    assert.equal((await call("GET", route(), { token })).status, 200, name);
    assert.equal(await tokenRevoked(token), false);
    assert.ok([200, 201].includes((await step()).status), name);
    assert.equal(await tokenRevoked(token), true, name);
    assert.equal((await call("GET", route(), { token })).status, 401, name);
    await after();
  }
});

test("a refresh renews only a token of the live version with capabilities it still holds", { skip }, async () => {
  const id = await adminPage("Refresh me", ["rooms.read", "tasks.read"]);
  const minter = grantHelpers!.testPageGrantMinter(dee.id, dee.sessionId);
  const live = await grantHelpers!.mintTestPageGrant({ accountId: dee.id, sessionId: dee.sessionId, roomId: roomA, pageId: id, pageVersion: 1, capabilities: ["rooms.read", "tasks.read"] });
  assert.ok(await pageGrants!.refreshPageGrant({ minter, token: live.token }));
  // Still live, but a version the page no longer shows, or more than it was granted.
  const stale = await grantHelpers!.mintTestPageGrant({ accountId: dee.id, sessionId: dee.sessionId, roomId: roomA, pageId: id, pageVersion: 2, capabilities: ["rooms.read"] });
  assert.equal(await pageGrants!.refreshPageGrant({ minter, token: stale.token }), null);
  await dbClient!.pool.query("UPDATE page_grants SET capabilities = ARRAY['rooms.read'] WHERE page_id = $1", [id]);
  assert.equal(await pageGrants!.refreshPageGrant({ minter, token: live.token }), null);
});

test("drafts and waiting versions are bounded per page and per author; live pages per room", { skip }, async () => {
  const roomC = await room("api-v1-pages-bounds", ada, bob, dee, cy);
  const id = await adminPage("Bounded", [], roomC);
  const propose = (as: As, n: number, draft = false) =>
    call("POST", pagesPath(roomC, `/${id}/versions`), as, { html: pageHtml(`Bounded ${n}`, ["tasks.read"]), draft });
  // An author's fourth replaces their oldest.
  for (let n = 1; n <= 4; n += 1) assert.equal((await propose(bob, n, n % 2 === 0)).status, 201);
  const bobs = (await call("GET", pagesPath(roomC, `/${id}`), bob)).body.versions
    .filter((row: { author: { id: string } }) => row.author.id === bob.id).map((row: { version: number }) => row.version);
  assert.deepEqual(bobs, [5, 4, 3], "version 2 made way for version 5");
  // Ten waiting in all: nobody adds an eleventh.
  for (let n = 1; n <= 3; n += 1) assert.equal((await propose(dee, n)).status, 201);
  for (let n = 1; n <= 3; n += 1) assert.equal((await propose(ada, n)).status, 201);
  assert.equal((await propose(cy, 1)).status, 201);
  const full = await propose(cy, 2);
  assert.equal(full.body.code, "conflict");
  assert.match(full.body.message, /10 drafts/);

  // Pages that are not live yet: five per author.
  for (let n = 1; n <= 5; n += 1) assert.equal((await create(dee, `Waiting ${n}`, [], {}, roomC)).body.currentVersion, null);
  assert.equal((await create(dee, "Waiting 6", [], {}, roomC)).body.code, "conflict");
  assert.equal((await create(bob, "Bob waits", [], {}, roomC)).status, 201, "another author is not held back");

  // Live pages: fifty per room. Pages waiting do not count.
  for (let n = 2; n <= 50; n += 1) assert.equal((await create(ada, `Live ${n}`, [], {}, roomC)).body.currentVersion, 1);
  const tooMany = await create(ada, "Live 51", [], {}, roomC);
  assert.equal(tooMany.body.code, "conflict");
  assert.match(tooMany.body.message, /50 live pages/);
  assert.equal((await create(cy, "Still waits", [], {}, roomC)).status, 201);
  const waiting = (await create(cy, "Approve later", [], {}, roomC)).body.id;
  assert.equal((await call("POST", pagesPath(roomC, `/${waiting}/approve`), ada, { version: 1, capabilities: [] })).body.code, "conflict");
});

test("another room's page id is not_found on every route", { skip }, async () => {
  const id = await adminPage("Room A only", ["rooms.read"]);
  const inB = (rest: string) => pagesPath(roomB, `/${id}${rest}`);
  const tries: [string, string, unknown][] = [
    ["GET", inB(""), undefined],
    ["GET", inB("/document"), undefined],
    ["GET", inB("/diagnostics"), undefined],
    ["POST", inB("/versions"), { html: pageHtml("Hijack") }],
    ["POST", inB("/placements"), {}],
    ["DELETE", inB("/placements"), undefined],
    ["POST", inB("/approve"), { version: 1, capabilities: [] }],
    ["POST", inB("/current"), { version: 1 }],
    ["POST", inB("/grant"), undefined],
    ["POST", inB("/diagnostics"), { version: 1, entries: [{ kind: "exception", message: "x" }] }],
    ["DELETE", inB(""), undefined],
  ];
  for (const [method, route, body] of tries) {
    for (const who of [cy, { agent: "agent-cy" }] as As[]) {
      const answer = await call(method, route, who, body);
      // An agent is refused admin, grant and report calls before any lookup; everything else is not_found.
      if ("agent" in (who as object) && answer.body.code === "not_granted") continue;
      assert.equal(answer.body.code, "not_found", `${method} ${route} as ${JSON.stringify(who)}: ${JSON.stringify(answer.body)}`);
    }
  }
  assert.deepEqual((await call("GET", pagesPath(roomB, "?surface=room.tab"), cy)).body, { pages: [] });
  // People outside room A cannot reach it through room A, and its page grant opens only room A.
  assert.equal((await call("GET", pagesPath(roomA, `/${id}`), cy)).body.code, "not_participant");
  const token = await open(ada, id);
  assert.equal((await call("GET", pagesPath(roomB, `/${id}`), { token })).body.code, "not_granted");
});

test("a page made from a message's HTML attachment keeps working after the message is deleted", { skip }, async () => {
  const message = await api!.addMessage(roomA, "ada", "here is the page");
  const number = Number(message.id.replace("msg_", ""));
  const objectKey = `rooms/${roomA}/uploads/up_page/board.html`;
  const html = pageHtml("From a file");
  attachmentBytes.set(objectKey, Buffer.from(html, "utf8"));
  await attach(roomA, number, "up_page", "board.html", Buffer.byteLength(html), objectKey);
  const source = { messageId: message.id, attachmentId: "att_1" };
  // The attachment is room A's: room B's admin cannot pin it from room B.
  assert.equal((await call("POST", pagesPath(roomB), cy, { source })).body.code, "not_found");
  const made = await call("POST", pagesPath(roomA), ada, { source });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.versions[0].source, source);
  assert.equal(made.body.title, "From a file");

  await contentDeletion!.deleteRoomMessage({ roomId: roomA, messageId: message.id, accountId: ada.id, admin: true });
  const document = await call("GET", pagesPath(roomA, `/${made.body.id}/document`), dee);
  assert.equal(document.status, 200);
  assert.equal(document.body.html, html);
  assert.equal((await call("POST", pagesPath(roomA), ada, { source })).body.code, "not_found", "the attachment is gone, the page is not");
});

test("a page is at most 2 MB of HTML, sent inline (even fully escaped) or as an attachment", { skip }, async () => {
  const head = pageHtml("Big");
  const fits = head + "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(head));
  assert.equal(Buffer.byteLength(fits), 2 * 1024 * 1024);
  const made = await call("POST", pagesPath(roomA), ada, { html: fits });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.versions[0].byteSize, 2 * 1024 * 1024);
  const tooBig = await call("POST", pagesPath(roomA, `/${made.body.id}/versions`), ada, { html: `${fits}y` });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, "too_large");
  const document = await call("GET", pagesPath(roomA, `/${made.body.id}/document`), bob);
  assert.equal(document.body.html.length, fits.length);

  // Control characters travel as \uXXXX: six bytes of JSON for one of HTML.
  const escaped = head + "\u0001".repeat(2 * 1024 * 1024 - Buffer.byteLength(head));
  assert.ok(Buffer.byteLength(JSON.stringify({ html: escaped })) > 12 * 1024 * 1024 - 1024);
  const version = await call("POST", pagesPath(roomA, `/${made.body.id}/versions`), ada, { html: escaped });
  assert.equal(version.status, 201, JSON.stringify(version.body).slice(0, 300));

  // Only the page HTML routes take the larger body.
  const padded = await call("POST", pagesPath(roomA, `/${made.body.id}/approve`), ada, { version: 1, capabilities: [], pad: "x".repeat(1536 * 1024) });
  assert.deepEqual(padded, { status: 413, body: { code: "too_large", message: "The request body is too large." } });

  const message = await api!.addMessage(roomA, "ada", "a big file");
  await attach(roomA, Number(message.id.replace("msg_", "")), "up_big", "big.html", 3 * 1024 * 1024, "big");
  assert.equal((await call("POST", pagesPath(roomA), ada, { source: { messageId: message.id, attachmentId: "att_1" } })).body.code, "too_large");
});

test("a manifest problem is invalid_input with the field to fix", { skip }, async () => {
  const none = await call("POST", pagesPath(roomA), ada, { html: "<p>no manifest</p>" });
  assert.equal(none.body.code, "invalid_input");
  assert.match(none.body.message, /no manifest/);
  const bad = await call("POST", pagesPath(roomA), ada, { html: pageHtml("Bad", ["rooms.read", "nope.read"]) });
  assert.equal(bad.body.code, "invalid_input");
  assert.match(bad.body.message, /capabilities\[1\]/);
  const both = await call("POST", pagesPath(roomA), ada, { html: pageHtml("Both"), source: { messageId: "msg_1", attachmentId: "att_1" } });
  assert.equal(both.body.code, "invalid_input");
});

test("the desktop's room tab list and page document have the agreed shapes", { skip }, async () => {
  const roomT = await room("api-v1-pages-tabs", ada);
  assert.deepEqual(await call("GET", pagesPath(roomT, "?surface=room.tab"), ada), { status: 200, body: { pages: [] } });

  const make = async (title: string) => (await call("POST", pagesPath(roomT), ada, { html: pageHtml(title) })).body.id as string;
  const first = await make("First");
  const second = await make("Second");
  const unpinned = await make("Unpinned");
  assert.equal((await call("POST", pagesPath(roomT, `/${first}/placements`), ada, {})).status, 200);
  assert.equal((await call("POST", pagesPath(roomT, `/${second}/placements`), ada, { position: 0 })).status, 200);
  const list = await call("GET", pagesPath(roomT, "?surface=room.tab"), ada);
  assert.deepEqual(list, { status: 200, body: { pages: [{ id: second, title: "Second", version: 1 }, { id: first, title: "First", version: 1 }] } });
  assert.ok(PageList.safeParse(list.body).success);
  assert.deepEqual((await call("GET", pagesPath(roomT), ada)).body.pages.map((page: { id: string }) => page.id), [first, second, unpinned]);

  const document = await call("GET", pagesPath(roomT, `/${first}/document`), ada);
  assert.deepEqual(document, { status: 200, body: { page: { id: first, title: "First", version: 1 }, html: pageHtml("First") } });
  assert.ok(PageDocument.safeParse(document.body).success);
  assert.deepEqual(Object.keys(document.body).sort(), ["html", "page"]);
});

test("diagnostics: the app or the page version reports, the newest 200 stay, and authors, admins and agents read them", { skip }, async () => {
  const made = await create({ agent: "agent-bob" }, "Noisy", ["rooms.read"]);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  const approved = await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 1, capabilities: ["rooms.read"] });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await call("POST", pagesPath(roomA, `/${id}/placements`), ada, {})).status, 200);
  const report = (as: As, entries: unknown[], version = 1) => call("POST", pagesPath(roomA, `/${id}/diagnostics`), as, { version, entries });
  for (let batch = 0; batch < 5; batch += 1) {
    const entries = Array.from({ length: 50 }, (_, n) => ({ kind: "console_error", message: `error ${batch * 50 + n}` }));
    assert.deepEqual((await report(dee, entries)).body, { accepted: 50 });
  }
  const pageToken = await open(dee, id);
  assert.deepEqual((await report({ token: pageToken }, [{ kind: "failed_call", message: "rooms.get: 503" }])).body, { accepted: 1 });
  // Not for another version of itself, not through an owner token, a job or an agent.
  await call("POST", pagesPath(roomA, `/${id}/versions`), ada, { html: pageHtml("Noisy 2", ["rooms.read"]), draft: true });
  assert.equal((await report({ token: pageToken }, [{ kind: "exception", message: "x" }], 2)).body.code, "not_granted");
  for (const who of [{ token: OWNER_TOKEN }, { job: "job_6", as: dee }, { agent: "agent-ada" }] as As[]) {
    assert.equal((await report(who, [{ kind: "exception", message: "x" }])).body.code, "not_granted", JSON.stringify(who));
  }
  assert.equal((await report(dee, Array.from({ length: 51 }, () => ({ kind: "exception", message: "x" })))).body.code, "invalid_input");
  const { rows: reporters } = await dbClient!.pool.query(
    "SELECT reporter_kind, reporter_account_id, count(*)::int AS count FROM page_diagnostics WHERE page_id = $1 GROUP BY 1, 2 ORDER BY 1", [id]);
  assert.deepEqual(reporters, [{ reporter_kind: "page", reporter_account_id: dee.id, count: 1 }, { reporter_kind: "person", reporter_account_id: dee.id, count: 199 }]);

  const read = (as: As, query = "") => call("GET", pagesPath(roomA, `/${id}/diagnostics${query}`), as);
  for (const who of [ada, bob, { agent: "agent-bob" }, { agent: "agent-ada" }] as As[]) {
    assert.equal((await read(who)).status, 200, JSON.stringify(who));
  }
  assert.equal((await read(dee)).body.code, "not_granted");
  // A draft's diagnostics only for those who can see the draft.
  assert.equal((await read({ agent: "agent-bob" }, "?version=2")).body.code, "not_found");
  assert.equal((await read(ada, "?version=2")).status, 200);
  const all = await read(ada, "?limit=200");
  assert.equal(all.body.entries.length, 200);
  assert.deepEqual(all.body.entries[0], { version: 1, kind: "failed_call", message: "rooms.get: 503", at: all.body.entries[0].at });
  assert.equal(all.body.entries.at(-1).message, "error 51", "the oldest entries were dropped");
});

test("documents and work items ask the registry what a page version may use", { skip }, async () => {
  const made = await create(ada, "Hooks");
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  const html = pageHtml("Hooks", ["data.page", "work_items.read"], { collections: { page: ["next_steps"] }, workItemFields: ["customfield_10027"] });
  await call("POST", pagesPath(roomA, `/${id}/versions`), ada, { html });
  assert.equal(await documents!.pageExistsInRoom(roomA, id), true);
  assert.equal(await documents!.pageExistsInRoom(roomB, id), false);
  assert.equal(await documents!.pageExistsInRoom(roomA, "page_nothere"), false);
  const asPage = (version: number) => ({ principal: { kind: "person" as const, id: dee.id }, via: { kind: "page" as const, id, version }, roomId: roomA });
  assert.deepEqual(await documents!.allowedCollectionsFor(asPage(2)), { page: ["next_steps"] });
  assert.deepEqual(await documents!.allowedCollectionsFor(asPage(1)), {});
  assert.equal(await documents!.allowedCollectionsFor({ principal: { kind: "person", id: dee.id }, roomId: roomA }), null);
  assert.deepEqual(await workItemFields!.allowedWorkItemFields(asPage(2)), ["customfield_10027"]);
  assert.deepEqual(await workItemFields!.allowedWorkItemFields(asPage(99)), []);
  assert.deepEqual(await pagesRules!.pageAllowedCollections(id, 2, "viewer"), []);
});
