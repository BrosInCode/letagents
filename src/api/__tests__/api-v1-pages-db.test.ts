import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import express from "express";

import { ApiError } from "../../../shared/api/core.mjs";
import { PageDetail, PageDocument, PageList } from "../../../shared/api/pages.mjs";
import type { ApiCallerIdentifier, ApiRoomAccessResolver } from "../v1/context.js";
import type { PageGrantsPort } from "../v1/page-grants-port.js";

// The pages registry end to end: the real auth middleware, room access for
// people, the database and the version rules. Agents and page grants are not
// identified by the API yet (the actor chain adds them), so this test names
// them with headers and checks their room the way the actor chain will.
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
const pagesArea = testDatabaseUrl ? await import("../v1/areas/pages.js") : null;
const pagesRules = testDatabaseUrl ? await import("../v1/pages.js") : null;
const resolution = testDatabaseUrl ? await import("../rooms/resolution.js") : null;
const accessDecision = testDatabaseUrl ? await import("../rooms/access-decision.js") : null;

const OWNER_TOKEN = "api_v1_pages_owner_token_ada";

interface Person { id: string; cookie: string }
let ada: Person; // room A admin
let bob: Person; // room A participant, owns agent-bob
let dee: Person; // room A participant
let cy: Person; // room B admin
let roomA = "";
let roomB = "";
let server: Server | null = null;
let base = "";
let origin = "";

// Which room each agent's session is in, and who owns it.
const agentRooms = new Map<string, string>();
const minted: { accountId: string; pageId: string; pageVersion: number; capabilities: readonly string[] }[] = [];
const revoked: { pageId?: string; roomId?: string; accountId?: string }[] = [];
const grants: PageGrantsPort = {
  async mintPageGrant(input) {
    minted.push({ accountId: input.accountId, pageId: input.pageId, pageVersion: input.pageVersion, capabilities: input.capabilities });
    return { token: `lapg.test${minted.length}`, grantId: `pgt_${minted.length}`, expiresAt: "2030-01-01T00:00:00.000Z" };
  },
  async revokePageGrants(filter) {
    revoked.push(filter);
    return 1;
  },
};
const attachmentBytes = new Map<string, Buffer>();

const identifyCaller: ApiCallerIdentifier = async (req) => {
  const agent = req.headers["x-test-agent"];
  if (typeof agent === "string") return { principal: { kind: "agent", id: agent }, account: null };
  const caller = await actor!.identifyCaller(req);
  const page = req.headers["x-test-page"];
  return caller && typeof page === "string" ? { ...caller, via: { kind: "page", id: page, version: 1 } } : caller;
};

const resolveRoomAccess: ApiRoomAccessResolver = async (caller, roomParam) => {
  if (caller.principal.kind !== "agent") return actor!.resolveRoomAccess(caller, roomParam);
  const room = await resolution!.resolveExistingRoomRequest(roomParam);
  if (!room) throw new ApiError("not_found", "Room not found.");
  if (agentRooms.get(caller.principal.id) !== room.id) throw new ApiError("not_participant", "You are not a participant in this room.");
  return { actor: { principal: caller.principal, roomId: room.id }, room, access: await accessDecision!.classifyRoomAccess(room) };
};

async function person(login: string): Promise<Person> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `api-v1-pages-${login}`, login, display_name: login });
  const token = `api-v1-pages-session-${login}`;
  await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60 * 60_000).toISOString(), null);
  return { id: account.id, cookie: `letagents_session=${token}` };
}

async function agent(key: string, owner: Person, roomId: string): Promise<void> {
  await dbClient!.pool.query(
    `INSERT INTO agents (id, canonical_key, name, display_name, owner_account_id, owner_login, owner_label, created_at, updated_at)
      VALUES ($1, $1, $1, $1, $2, 'owner', 'owner', now(), now())`,
    [key, owner.id],
  );
  agentRooms.set(key, roomId);
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
    roomA = (await api!.createProjectWithName("api-v1-pages-a")).id;
    roomB = (await api!.createProjectWithName("api-v1-pages-b")).id;
    await members!.recordRoomCreator(roomA, ada.id);
    await members!.addRoomMember({ roomId: roomA, accountId: bob.id, addedVia: "seed" });
    await members!.addRoomMember({ roomId: roomA, accountId: dee.id, addedVia: "seed" });
    await members!.recordRoomCreator(roomB, cy.id);
    await agent("agent-ada", ada, roomA);
    await agent("agent-bob", bob, roomA);
    await agent("agent-cy", cy, roomB);

    const app = express();
    middleware!.registerHttpMiddleware(app, { resolveRequestAuth: requestAuth!.resolveRequestAuth });
    router!.registerApiV1Routes(app, {
      routes: pagesArea!.createPagesRoutes({
        grants,
        readAttachment: async (attachment) => attachmentBytes.get(attachment.object_key) ?? Buffer.alloc(0),
      }),
      identifyCaller,
      resolveRoomAccess,
      // Capabilities and room policy are the actor chain's; this test is about the registry's own rules.
      checkCapability: async () => undefined,
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

type As = Person | { agent: string } | { token: string } | { page: string; as: Person } | null;

async function call(method: string, route: string, as: As, body?: unknown) {
  const headers: Record<string, string> = {};
  if (as && "cookie" in as) {
    headers.cookie = as.cookie;
    // A cookie write must come from the app's own origin.
    headers.origin = origin;
  } else if (as && "agent" in as) headers["x-test-agent"] = as.agent;
  else if (as && "token" in as) headers.authorization = `Bearer ${as.token}`;
  else if (as && "page" in as) Object.assign(headers, { cookie: as.as.cookie, origin, "x-test-page": as.page });
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const roomPath = (roomId: string) => `/rooms/${encodeURIComponent(roomId)}`;
const pagesPath = (roomId: string, rest = "") => `${roomPath(roomId)}/pages${rest}`;

function pageHtml(title: string, capabilities: string[] = [], extra: Record<string, unknown> = {}): string {
  const manifest = { api: 1, title, surfaces: ["room.tab"], capabilities, ...extra };
  return `<!doctype html><title>${title}</title>\n<script type="application/letagents-page+json">${JSON.stringify(manifest)}</script>\n<main>${title}</main>`;
}

async function create(as: As, title: string, capabilities: string[] = [], extra: Record<string, unknown> = {}) {
  return call("POST", pagesPath(roomA), as, { html: pageHtml(title, capabilities), ...extra });
}

/** A page made by ada, approved with its capabilities, pinned on the room tab. */
async function adminPage(title: string, capabilities: string[] = []): Promise<string> {
  const made = await create(ada, title, capabilities);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id as string;
  if (capabilities.length) {
    const approved = await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 1, capabilities });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  }
  assert.equal((await call("POST", pagesPath(roomA, `/${id}/placements`), ada, {})).status, 200);
  return id;
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
  assert.equal((await create({ page: "page_x", as: ada }, "Through a page")).body.code, "not_granted");

  const id = await adminPage("Table page", ["rooms.read"]);
  const pageRoute = pagesPath(roomA, `/${id}`);

  // View: every participant and agent in the room.
  for (const viewer of [ada, bob, { agent: "agent-bob" }] as As[]) {
    assert.equal((await call("GET", pageRoute, viewer)).status, 200);
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

  // Admin actions: only a room admin, in person, in the app.
  const adminOnly: [string, string, unknown][] = [
    ["POST", `${pageRoute}/placements`, {}],
    ["DELETE", `${pageRoute}/placements?surface=room.tab`, undefined],
    ["POST", `${pageRoute}/approve`, { version: 3, capabilities: ["rooms.read"] }],
    ["POST", `${pageRoute}/current`, { version: 2 }],
    ["DELETE", pageRoute, undefined],
  ];
  for (const [method, route, body] of adminOnly) {
    for (const who of [bob, { agent: "agent-ada" }, { token: OWNER_TOKEN }, { page: id, as: ada }] as As[]) {
      const refused = await call(method, route, who, body);
      assert.equal(refused.body.code, "not_granted", `${method} ${route} as ${JSON.stringify(who)}: ${JSON.stringify(refused.body)}`);
    }
  }
  // A cookie write from another site is refused too.
  const crossSite = await fetch(`${base}${pageRoute}/current`, {
    method: "POST", headers: { cookie: ada.cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ version: 2 }),
  });
  assert.equal((await crossSite.json()).code, "not_granted");

  // Roll back to version 2 (Undo): live again with its grant; open grants end.
  revoked.length = 0;
  const rolledBack = await call("POST", `${pageRoute}/current`, ada, { version: 2 });
  assert.equal(rolledBack.status, 200);
  assert.equal(rolledBack.body.currentVersion, 2);
  assert.equal(statusOf(rolledBack.body, 4), "superseded");
  assert.deepEqual(revoked, [{ pageId: id, roomId: roomA }]);
  assert.equal((await call("POST", `${pageRoute}/current`, ada, { version: 3 })).body.code, "conflict", "a version that never went live cannot be rolled back to");

  // Open a page: people only, in the app.
  minted.length = 0;
  const opened = await call("POST", `${pageRoute}/grant`, bob);
  assert.equal(opened.status, 201);
  assert.deepEqual(opened.body, {
    token: "lapg.test1", grantId: "pgt_1", expiresAt: "2030-01-01T00:00:00.000Z",
    page: { id, title: "Table page by agent-bob", version: 2 }, capabilities: ["rooms.read"],
  });
  assert.deepEqual(minted, [{ accountId: bob.id, pageId: id, pageVersion: 2, capabilities: ["rooms.read"] }]);
  for (const who of [{ agent: "agent-ada" }, { token: OWNER_TOKEN }, { page: id, as: ada }] as As[]) {
    assert.equal((await call("POST", `${pageRoute}/grant`, who)).body.code, "not_granted");
  }
  assert.equal(minted.length, 1);
  // A page that is not pinned cannot be opened.
  assert.equal((await call("POST", pagesPath(roomA, `/${byAda.body.id}/grant`), ada)).body.code, "not_found");

  // Delete: gone for everyone, and its grants end.
  revoked.length = 0;
  assert.deepEqual((await call("DELETE", pageRoute, ada)).body, { id, deleted: true });
  assert.deepEqual(revoked, [{ pageId: id }]);
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
  const id = await adminPage("Drafts");
  const draft = await call("POST", pagesPath(roomA, `/${id}/versions`), { agent: "agent-bob" }, { html: pageHtml("Drafts v2"), draft: true });
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
  for (const who of [dee, { agent: "agent-ada" }, { page: id, as: ada }] as As[]) {
    assert.equal(statusOf((await call("GET", pagesPath(roomA, `/${id}`), who)).body, 2), undefined, JSON.stringify(who));
    assert.equal((await document(who)).body.code, "not_found");
  }
  // The live document and the tab stay on version 1.
  assert.equal((await call("GET", pagesPath(roomA, `/${id}/document`), dee)).body.page.version, 1);
  assert.ok((await call("GET", pagesPath(roomA, "?surface=room.tab"), dee)).body.pages.some((page: { id: string; version: number }) => page.id === id && page.version === 1));
  // A draft cannot be approved into the room.
  assert.equal((await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 2, capabilities: [] })).body.code, "conflict");
});

test("an admin grants only capabilities the manifest asks for; approving ends open grants", { skip }, async () => {
  const made = await create(ada, "Approve me", ["rooms.read", "tasks.read"]);
  const id = made.body.id as string;
  assert.equal(made.body.currentVersion, null);
  const wider = await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 1, capabilities: ["rooms.read", "jobs.start"] });
  assert.equal(wider.status, 400);
  assert.equal(wider.body.code, "invalid_input");
  assert.match(wider.body.message, /jobs\.start/);
  revoked.length = 0;
  const approved = await call("POST", pagesPath(roomA, `/${id}/approve`), ada, { version: 1, capabilities: ["tasks.read"] });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.currentVersion, 1);
  assert.deepEqual({ ...approved.body.grant, approvedAt: "-" }, { version: 1, capabilities: ["tasks.read"], approvedBy: ada.id, approvedAt: "-" });
  assert.deepEqual(revoked, [{ pageId: id, roomId: roomA }]);
  assert.equal((await call("POST", pagesPath(roomA, `/${id}/placements`), ada, {})).status, 200);
  minted.length = 0;
  assert.deepEqual((await call("POST", pagesPath(roomA, `/${id}/grant`), dee)).body.capabilities, ["tasks.read"]);
});

test("unpinning ends the page's grants through the grants port and drops it from the tab", { skip }, async () => {
  const id = await adminPage("Unpin me", ["rooms.read"]);
  revoked.length = 0;
  const unpinned = await call("DELETE", pagesPath(roomA, `/${id}/placements?surface=room.tab`), ada);
  assert.equal(unpinned.status, 200);
  assert.deepEqual(unpinned.body.placements, []);
  assert.deepEqual(revoked, [{ pageId: id, roomId: roomA }]);
  assert.ok(!(await call("GET", pagesPath(roomA, "?surface=room.tab"), bob)).body.pages.some((page: { id: string }) => page.id === id));
  // The room still owns it.
  assert.equal((await call("GET", pagesPath(roomA, `/${id}`), bob)).status, 200);
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
      // An agent is refused admin actions before any lookup; everything else is not_found.
      if ("agent" in (who as object) && answer.body.code === "not_granted") continue;
      assert.equal(answer.body.code, "not_found", `${method} ${route} as ${JSON.stringify(who)}: ${JSON.stringify(answer.body)}`);
    }
  }
  assert.deepEqual((await call("GET", pagesPath(roomB, "?surface=room.tab"), cy)).body, { pages: [] });
  // And people outside room A cannot reach it through room A.
  assert.equal((await call("GET", pagesPath(roomA, `/${id}`), cy)).body.code, "not_participant");
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

test("a page is at most 2 MB of HTML, sent inline or as an attachment", { skip }, async () => {
  const fits = pageHtml("Big", [], {}) + "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(pageHtml("Big")));
  assert.equal(Buffer.byteLength(fits), 2 * 1024 * 1024);
  const made = await call("POST", pagesPath(roomA), ada, { html: fits });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.versions[0].byteSize, 2 * 1024 * 1024);
  const tooBig = await call("POST", pagesPath(roomA, `/${made.body.id}/versions`), ada, { html: `${fits}y` });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, "too_large");
  const document = await call("GET", pagesPath(roomA, `/${made.body.id}/document`), bob);
  assert.equal(document.body.html.length, fits.length);
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
  const room = (await api!.createProjectWithName("api-v1-pages-tabs")).id;
  await members!.recordRoomCreator(room, ada.id);
  assert.deepEqual(await call("GET", pagesPath(room, "?surface=room.tab"), ada), { status: 200, body: { pages: [] } });

  const make = async (title: string) => (await call("POST", pagesPath(room), ada, { html: pageHtml(title) })).body.id as string;
  const first = await make("First");
  const second = await make("Second");
  const unpinned = await make("Unpinned");
  assert.equal((await call("POST", pagesPath(room, `/${first}/placements`), ada, {})).status, 200);
  assert.equal((await call("POST", pagesPath(room, `/${second}/placements`), ada, { position: 0 })).status, 200);
  const list = await call("GET", pagesPath(room, "?surface=room.tab"), ada);
  assert.deepEqual(list, { status: 200, body: { pages: [{ id: second, title: "Second", version: 1 }, { id: first, title: "First", version: 1 }] } });
  assert.ok(PageList.safeParse(list.body).success);
  assert.deepEqual((await call("GET", pagesPath(room), ada)).body.pages.map((page: { id: string }) => page.id), [first, second, unpinned]);

  const document = await call("GET", pagesPath(room, `/${first}/document`), ada);
  assert.deepEqual(document, { status: 200, body: { page: { id: first, title: "First", version: 1 }, html: pageHtml("First") } });
  assert.ok(PageDocument.safeParse(document.body).success);
  assert.deepEqual(Object.keys(document.body).sort(), ["html", "page"]);
});

test("diagnostics: the viewer reports, the newest 200 per version stay, and authors, admins and agents read them", { skip }, async () => {
  const made = await create({ agent: "agent-bob" }, "Noisy");
  const id = made.body.id as string;
  const report = (as: As, entries: unknown[]) => call("POST", pagesPath(roomA, `/${id}/diagnostics`), as, { version: 1, entries });
  for (let batch = 0; batch < 5; batch += 1) {
    const entries = Array.from({ length: 50 }, (_, n) => ({ kind: "console_error", message: `error ${batch * 50 + n}` }));
    assert.deepEqual((await report(dee, entries)).body, { accepted: 50 });
  }
  assert.deepEqual((await report({ page: id, as: dee }, [{ kind: "failed_call", message: "rooms.get: 503" }])).body, { accepted: 1 });
  assert.equal((await report({ page: "page_other", as: dee }, [{ kind: "exception", message: "x" }])).body.code, "not_granted");
  assert.equal((await report({ agent: "agent-ada" }, [{ kind: "exception", message: "x" }])).body.code, "not_granted");
  assert.equal((await report(dee, Array.from({ length: 51 }, () => ({ kind: "exception", message: "x" })))).body.code, "invalid_input");

  const read = (as: As, query = "") => call("GET", pagesPath(roomA, `/${id}/diagnostics${query}`), as);
  for (const who of [ada, bob, { agent: "agent-bob" }, { agent: "agent-ada" }] as As[]) {
    assert.equal((await read(who)).status, 200, JSON.stringify(who));
  }
  assert.equal((await read(dee)).body.code, "not_granted");
  const all = await read(ada, "?limit=200");
  assert.equal(all.body.entries.length, 200);
  assert.deepEqual(all.body.entries[0], { version: 1, kind: "failed_call", message: "rooms.get: 503", at: all.body.entries[0].at });
  assert.equal(all.body.entries.at(-1).message, "error 51", "the oldest entries were dropped");
  const { rows } = await dbClient!.pool.query("SELECT count(*)::int AS count FROM page_diagnostics WHERE page_id = $1", [id]);
  assert.equal(rows[0].count, 200);
});

test("the registry hooks other areas call answer for the page version", { skip }, async () => {
  const made = await create(ada, "Hooks", [], {});
  const id = made.body.id as string;
  const html = pageHtml("Hooks", ["data.page", "work_items.read"], { collections: { page: ["next_steps"] }, workItemFields: ["customfield_10027"] });
  await call("POST", pagesPath(roomA, `/${id}/versions`), ada, { html });
  assert.equal(await pagesRules!.pageExistsInRoom(roomA, id), true);
  assert.equal(await pagesRules!.pageExistsInRoom(roomB, id), false);
  assert.deepEqual(await pagesRules!.pageAllowedCollections(id, 2, "page"), ["next_steps"]);
  assert.deepEqual(await pagesRules!.pageAllowedCollections(id, 2, "viewer"), []);
  assert.deepEqual(await pagesRules!.pageAllowedCollections(id, 1, "page"), []);
  assert.deepEqual(await pagesRules!.pageWorkItemFields(id, 2), ["customfield_10027"]);
  assert.deepEqual(await pagesRules!.pageWorkItemFields(id, 99), []);
});
