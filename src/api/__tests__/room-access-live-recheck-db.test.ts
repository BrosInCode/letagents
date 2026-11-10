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

async function addMember(roomId: string, accountId: string): Promise<void> {
  await pool!.query(`INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'seed')`, [roomId, accountId]);
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
    await addMember(project.id, account.id);
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
    await addMember(project.id, account.id);
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
    await addMember(project.id, account.id);
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
  "a room that is not repo-backed refuses an anonymous reader and a signed-in stranger, at entry and on recheck",
  { concurrency: false, skip },
  async () => {
    const project = await createAdHocRoom();
    const anonymous = anonymousRequest();
    const refused = fakeResponse();
    assert.equal(await access!.requireGitRoomParticipant(anonymous, refused as never, project), false);
    assert.equal(refused.statusCode, 401);
    assert.equal(await access!.reauthorizeGitRoomParticipant(anonymous, project), false);

    const account = await createAccount("stranger");
    const token = "live_recheck_stranger_token";
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString());
    const req = sessionRequest(token, (await accountSessions!.getSessionAccountByToken(token))!);
    const strangerResponse = fakeResponse();
    assert.equal(await access!.requireGitRoomParticipant(req, strangerResponse as never, project), false);
    assert.equal(strangerResponse.statusCode, 403);
    assert.equal((strangerResponse.body as { code?: string }).code, "ROOM_MEMBERSHIP_REQUIRED");

    // A member who is removed while a stream is open fails the next recheck.
    await addMember(project.id, account.id);
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), true);
    await pool!.query("DELETE FROM room_members WHERE room_id = $1 AND account_id = $2", [project.id, account.id]);
    assert.equal(await access!.reauthorizeGitRoomParticipant(req, project), false);
  },
);

async function startPublicRepoGitHubStub() {
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests += 1;
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname.toLowerCase();
    // A signed-in caller of this stub has the triage role on the public repository.
    const reply = pathname === "/repos/brosincode/public-repo"
      ? { status: 200, payload: {
        private: false,
        owner: { login: "BrosInCode" },
        ...(req.headers.authorization ? { permissions: { pull: true, triage: true } } : {}),
      } }
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
    // A GitHub token, so the role check on the public repository can run.
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString(), "github-user-token");
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
    await addMember(project.id, account.id);
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
    const anonymous = fakeResponse();
    assert.equal(await access!.requireGitRoomParticipant(anonymousRequest(), anonymous as never, project), false);
    assert.equal(anonymous.statusCode, 401, "a public repository room needs a sign-in too");
    const account = await createAccount("public-repo-entry");
    const token = "live_recheck_public_repo_entry";
    // A GitHub token, so the role check on the public repository can run.
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString(), "github-user-token");
    const req = sessionRequest(token, (await accountSessions!.getSessionAccountByToken(token))!);
    assert.equal(await access!.requireGitRoomParticipant(req, fakeResponse() as never, project), true);
    assert.equal(access!.liveRecheckIsFreshAtEntry(req), false, "repository entries may have used a visibility cache");
  },
);

test(
  "a repo room admin row grants admin only while GitHub still admits the person",
  { concurrency: false, skip },
  async () => {
    const project = await rooms!.createProjectWithName("github.com/brosincode/admin-row-repo");
    const account = await createAccount("stale-admin");
    await pool!.query(
      "INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, $3)",
      [project.id, account.id, new Date().toISOString()],
    );
    const token = "live_recheck_stale_admin_token";
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString(), "github-user-token");
    const req = sessionRequest(token, (await accountSessions!.getSessionAccountByToken(token))!);

    const decide = (decision: import("../github/repo-access.js").RepoRoomAccessDecision) => ({
      getGitRoomBindingForRoom: async () => null,
      resolveRepoRoomAccessDecision: async () => decision,
    });

    // Still on the repository: the admin row counts.
    const allowed = fakeResponse();
    assert.equal(await access!.requireGitRoomAdmin(req, allowed as never, project, decide({ kind: "allow" })), true);
    assert.equal(await access!.resolveGitRoomProjectRole(project, req.sessionAccount, decide({ kind: "allow" })), "admin");

    // Removed from the private repository: the old admin row grants nothing.
    const removed = fakeResponse();
    assert.equal(
      await access!.requireGitRoomAdmin(req, removed as never, project, decide({ kind: "private_repo_no_access" })),
      false,
    );
    assert.equal(removed.statusCode, 403);
    assert.equal((removed.body as { code?: string }).code, "PRIVATE_REPO_NO_ACCESS");
    assert.equal(
      await access!.resolveGitRoomProjectRole(project, req.sessionAccount, decide({ kind: "private_repo_no_access" })),
      "participant",
    );

    // Lost the role on a public repository: the same.
    const demoted = fakeResponse();
    assert.equal(
      await access!.requireGitRoomAdmin(req, demoted as never, project, decide({ kind: "repo_collaborator_required" })),
      false,
    );
    assert.equal(demoted.statusCode, 403);

    // GitHub gave no answer: a 503 to retry, as for any participant.
    const unanswered = Object.assign(fakeResponse(), { setHeader() {} });
    assert.equal(
      await access!.requireGitRoomAdmin(req, unanswered as never, project, decide({ kind: "repo_access_unavailable" })),
      false,
    );
    assert.equal(unanswered.statusCode, 503);
  },
);

test(
  "an admin of a room without a repository keeps admin without any GitHub decision",
  { concurrency: false, skip },
  async () => {
    const project = await createAdHocRoom();
    const account = await createAccount("adhoc-admin");
    await addMember(project.id, account.id);
    await pool!.query(
      "INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, $3)",
      [project.id, account.id, new Date().toISOString()],
    );
    const token = "live_recheck_adhoc_admin_token";
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString());
    const req = sessionRequest(token, (await accountSessions!.getSessionAccountByToken(token))!);
    assert.equal(await access!.requireGitRoomAdmin(req, fakeResponse() as never, project), true);
    assert.equal(await access!.resolveGitRoomProjectRole(project, req.sessionAccount), "admin");
  },
);

async function startPrivateRepoGitHubStub() {
  // GitHub knows the private repository; it lists nobody as a collaborator.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname.toLowerCase();
    const reply = pathname === "/repos/brosincode/stale-admin-repo"
      ? { status: 200, payload: { private: true, owner: { login: "BrosInCode" } } }
      : { status: 404, payload: { message: "Not Found" } };
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind the GitHub API stub");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

test(
  "an admin row left after removal from a private repo opens no agent ask action and passes no rule owner check",
  { concurrency: false, skip },
  async (t) => {
    const stub = await startPrivateRepoGitHubStub();
    const previousBaseUrl = process.env.GITHUB_API_BASE_URL;
    process.env.GITHUB_API_BASE_URL = stub.baseUrl;
    t.after(async () => {
      if (previousBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
      else process.env.GITHUB_API_BASE_URL = previousBaseUrl;
      await stub.close();
    });
    const askRoutes = await import("../routes/agent-asks.js");
    const engine = await import("../connectors/rules/engine.js");

    const project = await rooms!.createProjectWithName("github.com/brosincode/stale-admin-repo");
    const account = await createAccount("ask-stale-admin");
    await pool!.query(
      "INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, $3)",
      [project.id, account.id, new Date().toISOString()],
    );
    const token = "live_recheck_ask_stale_admin";
    await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString(), "github-user-token");
    const sessionAccount = (await accountSessions!.getSessionAccountByToken(token))!;

    // Agent asks: the admin path of remove and of the workspace review.
    assert.equal(await askRoutes.isCurrentRoomAdmin(project.id, sessionAccount), false);
    // Approving a proposal: the admin row no longer stands in for write access.
    assert.equal(await askRoutes.canWriteRoomRepo(project.id, sessionAccount), false);

    // Tracker rule owner and wake rule cancel: the same answer, with the
    // decision injected so no GitHub credential lookup is needed.
    const decide = (kind: "allow" | "private_repo_no_access") => ({
      getAccount: async () => sessionAccount,
      access: {
        getGitRoomBindingForRoom: async () => null,
        resolveRepoRoomAccessDecision: async () => ({ kind }),
      },
    });
    assert.equal(await engine.isRoomAdminAccount(project.id, account.id, decide("private_repo_no_access")), false);
    assert.equal(await engine.isRoomAdminAccount(project.id, account.id, decide("allow")), true);
    assert.equal(
      await engine.isRoomAdminAccount(project.id, account.id, { getAccount: async () => null }),
      false,
      "with no stored GitHub credential the admin row cannot be checked, so it counts for nothing",
    );
  },
);

async function startSwitchableRepoGitHubStub(repo: string) {
  // "no_collaborators": GitHub knows the private repo and lists nobody.
  // "outage": GitHub answers every call with 503.
  let mode: "no_collaborators" | "outage" = "no_collaborators";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname.toLowerCase();
    const reply = mode === "outage"
      ? { status: 503, payload: { message: "Service Unavailable" } }
      : pathname === `/repos/brosincode/${repo}`
        ? { status: 200, payload: { private: true, owner: { login: "BrosInCode" } } }
        : { status: 404, payload: { message: "Not Found" } };
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind the GitHub API stub");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setMode: (next: typeof mode) => { mode = next; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

async function askRouteHarness(roomId: string) {
  const askRoutes = await import("../routes/agent-asks.js");
  const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const app = {
    get(path: string | RegExp, handler: (req: unknown, res: unknown) => Promise<void>) { routes.set(`get ${path}`, handler); },
    post(path: string | RegExp, handler: (req: unknown, res: unknown) => Promise<void>) { routes.set(`post ${path}`, handler); },
  };
  const ended: string[] = [];
  const ask = {
    id: "ask_12345678-1234-4234-8234-123456789abc", state: "active", room_id: roomId, asker_account_id: "someone-else",
    giver_account_id: "giver", provider_id: "claude-code", model: null, model_label: "Claude", amount_percent: null, note: "",
  };
  askRoutes.registerAgentAskRoutes(app as never, {} as never, {
    byId: async () => ask,
    isAdmin: askRoutes.isCurrentRoomAdmin,
    end: async () => { ended.push(ask.id); return ask; },
    proposals: async () => [{ id: "chg_1", summary: "secret change", state: "waiting", error: null, pr_url: null, files: [{ path: "a.ts", content: "secret" }], created_at: "c" }],
    reads: async () => [],
    name: async () => "Someone",
  } as never);
  const call = async (route: string, path: string, account: unknown) => {
    const res = {
      statusCode: 200, body: null as unknown, headers: {} as Record<string, string>,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
      setHeader(name: string, value: string) { this.headers[name] = value; },
    };
    await routes.get(route)!({ params: { id: ask.id }, body: {}, query: {}, headers: {}, path, authKind: "session", sessionAccount: account }, res);
    return res;
  };
  return {
    ended,
    remove: (account: unknown) => call("post /agent-asks/:id/remove", `/agent-asks/${ask.id}/remove`, account),
    workspace: (account: unknown) => call("get /agent-asks/:id/workspace", `/agent-asks/${ask.id}/workspace`, account),
  };
}

test(
  "agent ask routes refuse a former repo admin, and answer 503 to retry when GitHub gives no answer",
  { concurrency: false, skip },
  async (t) => {
    const stub = await startSwitchableRepoGitHubStub("ask-route-repo");
    const previousBaseUrl = process.env.GITHUB_API_BASE_URL;
    process.env.GITHUB_API_BASE_URL = stub.baseUrl;
    t.after(async () => {
      if (previousBaseUrl === undefined) delete process.env.GITHUB_API_BASE_URL;
      else process.env.GITHUB_API_BASE_URL = previousBaseUrl;
      await stub.close();
    });

    const formerAdmin = async (suffix: string, roomId: string) => {
      const account = await createAccount(suffix);
      await pool!.query(
        "INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, $3)",
        [roomId, account.id, new Date().toISOString()],
      );
      const token = `live_recheck_${suffix}`;
      await accountSessions!.createSession(account.id, token, new Date(Date.now() + 60_000).toISOString(), `github-token-${suffix}`);
      return (await accountSessions!.getSessionAccountByToken(token))!;
    };

    // Removed from the private repo: no remove, no reading proposed files.
    const removedRoom = await rooms!.createProjectWithName("github.com/brosincode/ask-route-repo");
    const removed = await formerAdmin("ask-route-removed", removedRoom.id);
    const asks = await askRouteHarness(removedRoom.id);
    const refusedRemove = await asks.remove(removed);
    assert.equal(refusedRemove.statusCode, 403);
    assert.equal((refusedRemove.body as { code?: string }).code, "not_allowed");
    const refusedWorkspace = await asks.workspace(removed);
    assert.equal(refusedWorkspace.statusCode, 403);
    assert.equal(asks.ended.length, 0);

    // GitHub is down (a room and a person it has not answered for before).
    stub.setMode("outage");
    const outageRoom = await rooms!.createProjectWithName("github.com/brosincode/ask-route-outage");
    const waiting = await formerAdmin("ask-route-outage", outageRoom.id);
    const outageAsks = await askRouteHarness(outageRoom.id);
    const retryRemove = await outageAsks.remove(waiting);
    assert.equal(retryRemove.statusCode, 503);
    assert.equal(retryRemove.headers["Retry-After"], "30");
    assert.equal((await outageAsks.workspace(waiting)).statusCode, 503);
    assert.equal(outageAsks.ended.length, 0);
  },
);
