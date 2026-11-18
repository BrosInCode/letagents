import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { RoomSummary } from "../../../shared/api/rooms.mjs";

// GET /api/v1/rooms/:room end to end: the real app, auth middleware, room
// access decision and database.
const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
delete process.env.LETAGENTS_BASE_URL;
delete process.env.PUBLIC_API_URL;

const skip = testDatabaseUrl ? false : "set TEST_DB_URL to run the /api/v1 rooms DB tests";
const dbClient = testDatabaseUrl ? await import("../db/client.js") : null;
const api = testDatabaseUrl ? await import("../db.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const members = testDatabaseUrl ? await import("../db/room-members.js") : null;
const appModule = testDatabaseUrl ? await import("../server/app.js") : null;
const routesModule = testDatabaseUrl ? await import("../server/routes.js") : null;

const OWNER_TOKEN = "api_v1_rooms_owner_token_ada";
let server: Server | null = null;
let github: Server | null = null;
let base = "";
let roomId = "";
let roomName = "";
const previousGitHubBaseUrl = process.env.GITHUB_API_BASE_URL;

async function person(login: string, githubToken: string | null = null): Promise<{ id: string; cookie: string }> {
  const account = await accountSessions!.upsertAccount({ provider: "github", provider_user_id: `api-v1-${login}`, login, display_name: login });
  const token = `api-v1-session-${login}`;
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

    // A GitHub stub: acme/widgets is public, and the token "github-token-role" has a role on it.
    github = createServer((req, res) => {
      const found = (req.url ?? "").toLowerCase().startsWith("/repos/acme/widgets");
      const role = req.headers.authorization === "Bearer github-token-role";
      res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(found ? { private: false, owner: { login: "acme" }, permissions: { pull: true, triage: role } } : { message: "Not Found" }));
    }).listen(0, "127.0.0.1");
    await once(github, "listening");
    process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;

    ada = await person("ada", "github-token-role");
    bob = await person("bob");
    cy = await person("cy");
    await ownerTokens!.createOwnerToken({ accountId: ada.id, githubUserId: "api-v1-ada", token: OWNER_TOKEN });
    const room = await api!.createProjectWithName("api-v1-rooms");
    roomId = room.id;
    roomName = room.display_name;
    await members!.addRoomMember({ roomId, accountId: ada.id, addedVia: "creator" });
    await members!.addRoomMember({ roomId, accountId: bob.id, addedVia: "seed" });

    await dbClient!.pool.query("INSERT INTO rooms (id, display_name, created_at) VALUES ('github.com/acme/widgets', 'acme/widgets', now())");
    await dbClient!.pool.query(`INSERT INTO room_git_bindings (room_id, provider, host, repository_full_name, repository_owner,
      repository_name, ref_type, ref_name, default_branch, visibility, is_default, source, created_at, updated_at)
      VALUES ('github.com/acme/widgets', 'github', 'github.com', 'acme/widgets', 'acme', 'widgets', 'default_branch', 'main', 'main',
      'public', true, 'manual', now(), now())`);

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

async function get(route: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${route}`, { headers });
  return { status: res.status, body: await res.json() };
}

test("a member reads the room through the API, by session cookie or owner token", { skip }, async () => {
  const expected = { id: roomId, name: roomName, kind: "main", parentRoomId: null, repo: null, visibility: "members" };
  const byCookie = await get(`/rooms/${encodeURIComponent(roomId)}`, { cookie: bob.cookie });
  assert.deepEqual(byCookie, { status: 200, body: expected });
  assert.ok(RoomSummary.safeParse(byCookie.body).success);
  assert.deepEqual(await get(`/rooms/${encodeURIComponent(roomId)}`, { authorization: `Bearer ${OWNER_TOKEN}` }), { status: 200, body: expected });
});

test("a repository room reports its repository and visibility", { skip }, async () => {
  assert.deepEqual(await get(`/rooms/${encodeURIComponent("github.com/acme/widgets")}`, { cookie: ada.cookie }), {
    status: 200,
    body: {
      id: "github.com/acme/widgets",
      name: "acme/widgets",
      kind: "main",
      parentRoomId: null,
      repo: {
        provider: "github", host: "github.com", owner: "acme", name: "widgets", fullName: "acme/widgets",
        url: "https://github.com/acme/widgets", ref: { type: "default_branch", name: "main" },
      },
      visibility: "public",
    },
  });
});

test("a signed-in person who is not a member gets not_participant; no sign-in gets unauthenticated", { skip }, async () => {
  assert.deepEqual(await get(`/rooms/${encodeURIComponent(roomId)}`, { cookie: cy.cookie }), {
    status: 403, body: { code: "not_participant", message: "You are not a participant in this room." },
  });
  // No GitHub role on the public repository: not a participant either.
  assert.equal((await get(`/rooms/${encodeURIComponent("github.com/acme/widgets")}`, { cookie: bob.cookie })).body.code, "not_participant");
  assert.deepEqual(await get(`/rooms/${encodeURIComponent(roomId)}`), {
    status: 401, body: { code: "unauthenticated", message: "Sign in to LetAgents to use the API." },
  });
});

test("a missing room is not_found and bad input is invalid_input, both in the one error shape", { skip }, async () => {
  assert.deepEqual(await get("/rooms/no-such-room-here", { cookie: ada.cookie }), {
    status: 404, body: { code: "not_found", message: "Room not found." },
  });
  assert.deepEqual(await get(`/rooms/${encodeURIComponent(roomId)}?verbose=1`, { cookie: ada.cookie }), {
    status: 400, body: { code: "invalid_input", message: 'Unrecognized key: "verbose"' },
  });
});
