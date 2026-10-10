import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { OwnerTokenAccount, SessionAccount } from "../db/types/auth.js";
import type { AuthenticatedRequest } from "../http/helpers.js";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) {
  process.env.DB_URL = testDatabaseUrl;
} else {
  process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
}

const dbClientModule = testDatabaseUrl ? await import("../db/client.js") : null;
const accountSessions = testDatabaseUrl ? await import("../db/auth/account-sessions.js") : null;
const ownerTokens = testDatabaseUrl ? await import("../db/auth/owner-tokens.js") : null;
const rooms = testDatabaseUrl ? await import("../db/rooms.js") : null;
const access = testDatabaseUrl ? await import("../rooms/access.js") : null;
const liveAuthorization = testDatabaseUrl ? await import("../rooms/live-authorization.js") : null;

const db = dbClientModule?.db;
const pool = dbClientModule?.pool;
const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const skip = requiresDatabase
  ? "set TEST_DB_URL to run DB-backed live room recheck tests"
  : false;

async function resetDatabase(): Promise<void> {
  if (!db || !pool) throw new Error("DB-backed live room recheck tests require TEST_DB_URL");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await migrate(db, { migrationsFolder });
}

test.beforeEach(async () => {
  if (!requiresDatabase) await resetDatabase();
});

if (!requiresDatabase) {
  test.after(async () => {
    await pool?.end();
  });
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

function sessionRequest(token: string, account: SessionAccount): AuthenticatedRequest {
  return {
    headers: { cookie: `letagents_session=${token}` },
    authKind: "session",
    sessionAccount: account,
    agentSession: null,
  } as unknown as AuthenticatedRequest;
}

function ownerTokenRequest(token: string, account: OwnerTokenAccount): AuthenticatedRequest {
  return {
    headers: { authorization: `Bearer ${token}` },
    authKind: "owner_token",
    sessionAccount: account,
    agentSession: null,
  } as unknown as AuthenticatedRequest;
}

function anonymousRequest(): AuthenticatedRequest {
  return {
    headers: {},
    authKind: null,
    sessionAccount: null,
    agentSession: null,
  } as unknown as AuthenticatedRequest;
}

async function createAdHocRoom() {
  const project = await rooms!.createProjectWithName("live_recheck_room");
  assert.equal(access!.isRepoBackedProject(project), false, "the room under test is not repo-backed");
  return project;
}

async function createAccount(suffix: string) {
  return accountSessions!.upsertAccount({
    provider: "github",
    provider_user_id: `live-recheck-${suffix}`,
    login: `live-recheck-${suffix}`,
    display_name: "Live Recheck",
  });
}

test(
  "a revoked app session fails the live recheck in a room that is not repo-backed",
  { concurrency: false, skip },
  async () => {
    const project = await createAdHocRoom();
    const account = await createAccount("session");
    const token = "live_recheck_session_token";
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString());
    const sessionAccount = await accountSessions!.getSessionAccountByToken(token);
    assert.ok(sessionAccount);

    const req = sessionRequest(token, sessionAccount);
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), true, "a live session keeps its stream");

    await accountSessions!.deleteSessionByToken(token);
    assert.equal(
      await access!.reauthorizeGitRoomParticipant(req, project),
      false,
      "a revoked session must not keep receiving live room events",
    );
  },
);

test(
  "an app session that expires while its stream is open fails the live recheck",
  { concurrency: false, skip },
  async () => {
    const project = await createAdHocRoom();
    const account = await createAccount("expiry");
    const token = "live_recheck_expiring_token";
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString());
    const sessionAccount = await accountSessions!.getSessionAccountByToken(token);
    assert.ok(sessionAccount);

    const req = sessionRequest(token, sessionAccount);
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), true);

    await pool!.query(
      "UPDATE auth_sessions SET expires_at = $1 WHERE account_id = $2",
      [new Date(Date.now() - 1_000).toISOString(), account.id],
    );
    assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), false);
  },
);

test(
  "a deleted owner token fails the live recheck in a room that is not repo-backed",
  { concurrency: false, skip },
  async () => {
    const project = await createAdHocRoom();
    const account = await createAccount("owner");
    const token = "live_recheck_owner_token";
    const ownerToken = await ownerTokens!.createOwnerToken({
      accountId: account.id,
      githubUserId: account.provider_user_id,
      token,
    });
    const ownerTokenAccount = await ownerTokens!.getOwnerTokenAccountByToken(token);
    assert.ok(ownerTokenAccount);

    const req = ownerTokenRequest(token, ownerTokenAccount);
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), true);

    await ownerTokens!.deleteOwnerTokenById(ownerToken.token_id);
    assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), false);
  },
);

test(
  "an anonymous reader of a room that is not repo-backed keeps passing the live recheck",
  { concurrency: false, skip },
  async () => {
    const project = await createAdHocRoom();
    const req = anonymousRequest();
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), true);
  },
);

async function startPublicRepoGitHubStub() {
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests += 1;
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname.toLowerCase();
    const reply = pathname === "/repos/brosincode/public-repo"
      ? { status: 200, payload: { private: false, owner: { login: "BrosInCode" } } }
      : { status: 404, payload: { message: "Not Found" } };
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind the GitHub API stub");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

test(
  "a revoked app session fails the live recheck in a public repository room without asking GitHub",
  { concurrency: false, skip },
  async (t) => {
    const stub = await startPublicRepoGitHubStub();
    const previousBaseUrl = process.env.GITHUB_API_BASE_URL;
    process.env.GITHUB_API_BASE_URL = stub.baseUrl;
    t.after(async () => {
      if (previousBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
      else process.env.GITHUB_API_BASE_URL = previousBaseUrl;
      await stub.close();
    });

    const project = await rooms!.createProjectWithName("github.com/brosincode/public-repo");
    assert.equal(access!.isRepoBackedProject(project), true, "the room under test is repo-backed");
    const account = await createAccount("public-repo");
    const token = "live_recheck_public_repo_token";
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString());
    const sessionAccount = await accountSessions!.getSessionAccountByToken(token);
    assert.ok(sessionAccount);

    const req = sessionRequest(token, sessionAccount);
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(
      await access!.reauthorizeGitRoomParticipant(req, project),
      true,
      "a live session keeps its stream in a public repository room",
    );

    await accountSessions!.deleteSessionByToken(token);
    const requestsBeforeRevokedRecheck = stub.requestCount();
    assert.equal(
      await access!.reauthorizeGitRoomParticipant(req, project),
      false,
      "a revoked session must not degrade to the room's anonymous access",
    );
    assert.equal(stub.requestCount(), requestsBeforeRevokedRecheck, "the revoked recheck fails before any GitHub lookup");
  },
);

test(
  "the shared live lease closes a revoked session's stream on its next recheck",
  { concurrency: false, skip },
  async () => {
    const project = await createAdHocRoom();
    const account = await createAccount("lease");
    const token = "live_recheck_lease_token";
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString());
    const sessionAccount = await accountSessions!.getSessionAccountByToken(token);
    assert.ok(sessionAccount);

    const req = sessionRequest(token, sessionAccount);
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(
      access!.liveRecheckIsFreshAtEntry(req),
      true,
      "an ad-hoc room entry is exact, so the first body needs no second read",
    );
    const lease = liveAuthorization!.acquireLiveRoomAuthorization({
      req,
      roomId: project.id,
      accessRoomName: project.id,
      freshAtEntry: access!.liveRecheckIsFreshAtEntry(req),
      authorize: () => access!.reauthorizeGitRoomParticipant(req, project),
    });
    try {
      assert.equal(await lease.check(), true);
      await accountSessions!.deleteSessionByToken(token);
      assert.equal(await lease.check({ force: true }), false, "the next recheck fails closed");
      assert.equal(await lease.check(), false, "the denial holds for the rest of the lease window");
    } finally {
      lease.release();
    }
  },
);

test(
  "a repository room entry is not fresh for the live recheck, so its first body is rechecked",
  { concurrency: false, skip },
  async (t) => {
    const stub = await startPublicRepoGitHubStub();
    const previousBaseUrl = process.env.GITHUB_API_BASE_URL;
    process.env.GITHUB_API_BASE_URL = stub.baseUrl;
    t.after(async () => {
      if (previousBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
      else process.env.GITHUB_API_BASE_URL = previousBaseUrl;
      await stub.close();
    });

    const project = await rooms!.createProjectWithName("github.com/brosincode/public-repo");
    const req = anonymousRequest();
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(access!.liveRecheckIsFreshAtEntry(req), false, "repository entries may have used a visibility cache");
  },
);
