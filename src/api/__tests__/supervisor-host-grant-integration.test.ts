import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import express from "express";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "true";
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const authDb = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { resolveRequestAuth } = await import("../request/auth.js");
const { isSupervisorGrantRouteAllowed } = await import("../request/supervisor-grant-route-registry.js");
const { registerHttpMiddleware } = await import("../http/middleware.js");
const { clearSupervisorAccessRevalidationCache, registerSupervisorHostGrantRoutes, requireSupervisorGrantRoomAccess, respondToStaleSupervisorGrantFence } = await import("../routes/supervisor-host-grants.js");
const { SupervisorGrantFenceStaleError } = await import("../db/auth.js");
const { requireGitRoomParticipant } = await import("../rooms/access.js");
const { hashToken } = await import("../db/utils.js");
const { registerRoomAgentWorkRoutes } = await import("../routes/rooms/agent-work.js");
const { publishRoomAgentWork, readRoomAgentWork } = await import("../db/room-agent-work.js");
const { parseRoomAgentWorkSummary } = await import("../../shared/room-agent-work.js");

async function reset() {
  if (!client) throw new Error("DB-backed supervisor tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}

async function seedOwner(id: string): Promise<void> {
  await client!.db.insert(schema!.accounts).values({
    id, provider: "github", provider_user_id: id, login: id, display_name: id,
    avatar_url: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
}

function recorder() {
  return { statusCode: 200, body: null as any, headers: {} as Record<string, string>, setHeader(key: string, value: string) { this.headers[key] = value; }, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; return this; } };
}

async function setupLifecycle() {
  clearSupervisorAccessRevalidationCache();
  await seedOwner("owner_route");
  const room = await authDb!.createProjectWithName("supervisor-route-room");
  const agent = await authDb!.registerAgentIdentity({ canonical_key: "owner/route-agent", name: "route-agent", display_name: "Route Agent", owner_account_id: "owner_route", owner_login: "owner", owner_label: "Owner" });
  const grantResult = await authDb!.createSupervisorHostGrant({ owner_account_id: "owner_route", host_id: "host_route", installation_id: "install_route", allowed_room_ids: [room.id], allowed_agent_keys: [agent.canonical_key], expires_at: new Date(Date.now() + 60_000).toISOString() });
  const handlers = new Map<string, any>();
  let participantAllowed = true;
  let readerAllowed = true;
  const accessOptions: Array<{ freshCollaboratorCheck?: boolean; throwOnIndeterminate?: boolean }> = [];
  const routeDeps = {
    resolveCanonicalRoomRequestId: async (id: string) => id === "room_alias" ? room.id : id,
    resolveRoomOrReply: async () => room,
    requireParticipant: async (_req: unknown, res: any) => {
      if (!readerAllowed) res.status(403).json({ error: "Not a room participant." });
      return readerAllowed;
    },
    getProjectById: async () => room,
    resolveProjectRepoAccessTarget: async () => ({
      roomName: room.id,
      repoRoomName: "github.com/org/repo",
    }),
    resolveRepoRoomAccessDecision: async (input) => {
      accessOptions.push({
        freshCollaboratorCheck: input.freshCollaboratorCheck,
        throwOnIndeterminate: input.throwOnIndeterminate,
      });
      return participantAllowed ? { kind: "allow" } : { kind: "private_repo_no_access" };
    },
    getGitHubAppRepositoryByRoomId: async () => undefined,
    getSupervisorGrantOwnerAccount: async () => ({
      account_id: "owner_route", provider_access_token: "github-token",
      provider: "github", login: "owner_route",
    }),
  };
  registerSupervisorHostGrantRoutes({ post(path: string, handler: any) { handlers.set(`POST ${path}`, handler); }, delete(path: string, handler: any) { handlers.set(`DELETE ${path}`, handler); } } as never, routeDeps as never);
  registerRoomAgentWorkRoutes({ post(path: string, handler: any) { handlers.set(`POST ${path}`, handler); }, get(_path: RegExp, handler: any) { handlers.set("GET agent-work", handler); } } as never, routeDeps as never, routeDeps as never);
  const principal = grantResult.grant;
  const reqBase = { authKind: "supervisor_grant", supervisorGrant: principal, headers: {}, body: { generation: principal.current_generation }, params: { grantId: principal.grant_id } };
  return {
    room, agent, grantResult, handlers, reqBase, accessOptions,
    setParticipantAllowed(value: boolean) { participantAllowed = value; },
    setReaderAllowed(value: boolean) { readerAllowed = value; },
  };
}

test("supervisor registry is exact default-deny", () => {
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/renew"), true);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/leases/tl_1/attestation"), true);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/leases/tl_1/rebind"), true);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/rooms/room_1/messages"), false);
  assert.equal(isSupervisorGrantRouteAllowed("DELETE", "/supervisor-host-grants/grant_1"), false);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/worker-sessions/session_1/agent-work"), true);
  assert.equal(isSupervisorGrantRouteAllowed("GET", "/supervisor-host-grants/grant_1/worker-sessions/session_1/agent-work"), false);
  assert.equal(isSupervisorGrantRouteAllowed("POST", "/supervisor-host-grants/grant_1/worker-sessions/session_1/agent-work/other"), false);
});

test("middleware attaches the supervisor principal and rejects non-registry routes", async () => {
  const handlers: Array<(...args: any[]) => unknown> = [];
  const app = { use(handler: (...args: any[]) => unknown) { handlers.push(handler); }, options() {} };
  const principal = { grant_id: "grant_1", owner_account_id: "owner", host_id: "host", installation_id: "install", token_version: 1, allowed_room_ids: ["room"], allowed_agent_keys: ["owner/agent"], current_generation: 1, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null };
  registerHttpMiddleware(app as never, { resolveRequestAuth: async () => ({ account: null, authKind: "supervisor_grant" as const, supervisorGrant: principal }) });
  const auth = handlers[1]!;
  for (const [path, status] of [["/supervisor-host-grants/grant_1/renew", 200], ["/rooms/room/messages", 403]] as const) {
    const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json() {} }; let next = false;
    await auth({ method: "POST", path, headers: {} }, res, () => { next = true; });
    assert.equal(res.statusCode, status); assert.equal(next, status === 200);
  }
});

test("feature-off retains only owner revoke route", () => {
  const prior = process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED;
  process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "false";
  const paths: string[] = [];
  try {
    registerSupervisorHostGrantRoutes({ post(path: string) { paths.push(`POST ${path}`); }, delete(path: string) { paths.push(`DELETE ${path}`); } } as never, {} as never);
    assert.deepEqual(paths, ["DELETE /supervisor-host-grants/:grantId"]);
  } finally { process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = prior; }
});

test("the exact in-transaction stale supervisor fence error maps to HTTP 409", () => {
  const response = recorder();
  assert.equal(respondToStaleSupervisorGrantFence(response as never, new SupervisorGrantFenceStaleError()), true);
  assert.equal(response.statusCode, 409);
  assert.match((response.body as any).error, /fence is stale/i);
  assert.equal(respondToStaleSupervisorGrantFence(recorder() as never, new Error("unrelated")), false);
});

test("grant room revalidation uses a fresh check and revokes on definitive denial", async () => {
  clearSupervisorAccessRevalidationCache();
  const response = recorder();
  const options: Array<{ freshCollaboratorCheck?: boolean; throwOnIndeterminate?: boolean }> = [];
  const revoked: string[] = [];
  const grant = {
    grant_id: "grant_access", owner_account_id: "owner_access", host_id: "host", installation_id: "install",
    scope_key: "owner", rental_session_id: null, token_version: 1, allowed_room_ids: ["github.com/org/repo"],
    allowed_agent_keys: ["owner/agent"], current_generation: 1, issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null,
  };
  const allowed = await requireSupervisorGrantRoomAccess(grant as never, response as never, {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async (roomId: string) => ({ id: roomId }),
    requireParticipant: async () => true,
    getProjectById: async (roomId: string) => ({ id: roomId } as never),
    resolveProjectRepoAccessTarget: async (project: any) => ({ roomName: project.id, repoRoomName: project.id }),
    resolveRepoRoomAccessDecision: async (input: any) => {
      options.push(input);
      return { kind: "private_repo_no_access" };
    },
    getGitHubAppRepositoryByRoomId: async () => undefined,
    getSupervisorGrantOwnerAccount: async () => ({
      account_id: "owner_access", provider: "github", login: "owner", provider_access_token: "token",
    }),
    revokeSupervisorGrantAuthority: async (input: any) => {
      revoked.push(input.grant_id);
      return { grant, revoked_now: true, ended_session_ids: [] } as never;
    },
  }, { kind: "all" });
  assert.equal(allowed, false);
  assert.equal(options[0]?.freshCollaboratorCheck, true);
  assert.equal(options[0]?.throwOnIndeterminate, true);
  assert.deepEqual(revoked, ["grant_access"]);
  assert.equal(response.statusCode, 403);
});

test("indeterminate fresh room access errors do not revoke grant authority", async () => {
  clearSupervisorAccessRevalidationCache();
  let revoked = false;
  const grant = {
    grant_id: "grant_transient", owner_account_id: "owner_access", host_id: "host", installation_id: "install",
    scope_key: "owner", rental_session_id: null, token_version: 1, allowed_room_ids: ["github.com/org/repo"],
    allowed_agent_keys: ["owner/agent"], current_generation: 1, issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null,
  };
  const response = recorder();
  const allowed = await requireSupervisorGrantRoomAccess(grant as never, response as never, {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async (roomId: string) => ({ id: roomId }),
    requireParticipant: async () => true,
    getProjectById: async (roomId: string) => ({ id: roomId } as never),
    resolveProjectRepoAccessTarget: async (project: any) => ({ roomName: project.id, repoRoomName: project.id }),
    resolveRepoRoomAccessDecision: async () => { throw new Error("GitHub unavailable"); },
    getGitHubAppRepositoryByRoomId: async () => undefined,
    getSupervisorGrantOwnerAccount: async () => ({
      account_id: "owner_access", provider: "github", login: "owner", provider_access_token: "token",
    }),
    revokeSupervisorGrantAuthority: async () => {
      revoked = true;
      return null;
    },
  }, { kind: "all" });
  assert.equal(allowed, false);
  assert.equal(response.statusCode, 503);
  assert.equal((response.body as any).code, "SUPERVISOR_ACCESS_REVALIDATION_UNAVAILABLE");
  assert.equal(revoked, false);
});

test("missing owner credentials and deleted rooms never trigger destructive teardown", async () => {
  const grant = {
    grant_id: "grant_uncertain", owner_account_id: "owner_access", host_id: "host", installation_id: "install",
    scope_key: "owner", rental_session_id: null, token_version: 1, allowed_room_ids: ["github.com/org/repo"],
    allowed_agent_keys: ["owner/agent"], current_generation: 1, issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null,
  };
  for (const mode of ["missing_credential", "deleted_room"] as const) {
    clearSupervisorAccessRevalidationCache();
    let revoked = false;
    const response = recorder();
    const allowed = await requireSupervisorGrantRoomAccess(grant as never, response as never, {
      resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
      resolveRoomOrReply: async (roomId: string) => ({ id: roomId }),
      requireParticipant: async () => true,
      getProjectById: async (roomId: string) => mode === "deleted_room" ? null : ({ id: roomId } as never),
      resolveProjectRepoAccessTarget: async (project: any) => ({ roomName: project.id, repoRoomName: project.id }),
      resolveRepoRoomAccessDecision: async () => ({ kind: "allow" }),
      getGitHubAppRepositoryByRoomId: async () => undefined,
      getSupervisorGrantOwnerAccount: async () => null,
      revokeSupervisorGrantAuthority: async () => {
        revoked = true;
        return null;
      },
    }, { kind: "all" });
    assert.equal(allowed, false);
    assert.equal(response.statusCode, mode === "deleted_room" ? 409 : 503);
    assert.equal(revoked, false);
  }
});

test("room-scoped checks are targeted, de-duplicated, and briefly cache successful access", async () => {
  clearSupervisorAccessRevalidationCache();
  const grant = {
    grant_id: "grant_targeted", owner_account_id: "owner_targeted", host_id: "host", installation_id: "install",
    scope_key: "owner", rental_session_id: null, token_version: 1,
    allowed_room_ids: ["github.com/org/repo-a", "github.com/org/repo-b"],
    allowed_agent_keys: ["owner/agent"], current_generation: 1, issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null,
  };
  const resolvedRooms: string[] = [];
  let accessChecks = 0;
  const deps = {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async (roomId: string) => ({ id: roomId }),
    requireParticipant: async () => true,
    getProjectById: async (roomId: string) => ({ id: roomId } as never),
    resolveProjectRepoAccessTarget: async (project: any) => {
      resolvedRooms.push(project.id);
      return { roomName: project.id, repoRoomName: project.id };
    },
    resolveRepoRoomAccessDecision: async () => {
      accessChecks += 1;
      return { kind: "allow" as const };
    },
    getGitHubAppRepositoryByRoomId: async () => undefined,
    getSupervisorGrantOwnerAccount: async () => ({
      account_id: grant.owner_account_id, provider: "github", login: "owner", provider_access_token: "token",
    }),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(await requireSupervisorGrantRoomAccess(
      grant as never,
      recorder() as never,
      deps,
      { kind: "rooms", room_ids: ["github.com/org/repo-a", "github.com/org/repo-a"] },
    ), true);
  }
  assert.deepEqual([...new Set(resolvedRooms)], ["github.com/org/repo-a"]);
  assert.equal(accessChecks, 1, "the second hot-path request uses the 60-second successful-access cache");
});

test("inactive GitHub App authority revokes independently of owner OAuth availability", async () => {
  clearSupervisorAccessRevalidationCache();
  let revoked = false;
  const grant = {
    grant_id: "grant_app_inactive", owner_account_id: "owner_app", host_id: "host", installation_id: "install",
    scope_key: "owner", rental_session_id: null, token_version: 1,
    allowed_room_ids: ["github.com/org/repo"], allowed_agent_keys: ["owner/agent"], current_generation: 1,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null,
  };
  const response = recorder();
  const allowed = await requireSupervisorGrantRoomAccess(grant as never, response as never, {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async (roomId: string) => ({ id: roomId }),
    requireParticipant: async () => true,
    getProjectById: async (roomId: string) => ({ id: roomId } as never),
    resolveProjectRepoAccessTarget: async (project: any) => ({ roomName: project.id, repoRoomName: project.id }),
    resolveRepoRoomAccessDecision: async () => ({ kind: "allow" }),
    getGitHubAppRepositoryByRoomId: async () => ({ installation_id: "install", removed_at: null } as never),
    getGitHubAppInstallationById: async () => ({
      installation_id: "install", suspended_at: new Date().toISOString(), uninstalled_at: null,
    } as never),
    getSupervisorGrantOwnerAccount: async () => null,
    revokeSupervisorGrantAuthority: async () => {
      revoked = true;
      return { grant, revoked_now: true, ended_session_ids: [] } as never;
    },
  }, { kind: "all" });
  assert.equal(allowed, false);
  assert.equal(response.statusCode, 409);
  assert.equal((response.body as any).code, "SUPERVISOR_GITHUB_INSTALLATION_INACTIVE");
  assert.equal(revoked, true);
});

test("lifecycle mint enforces room and agent allowlists through the actual route", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const allowed = recorder();
  await mint({ ...reqBase, body: { generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "worker_route_1" } }, allowed);
  assert.equal(allowed.statusCode, 201); assert.equal((allowed.body as any).session_token, undefined);
  assert.ok((allowed.body as any).worker_bearer_id);
  assert.ok((allowed.body as any).worker_bearer_expires_at);
  const mintedAuth = await resolveRequestAuth({ headers: { authorization: `Bearer ${(allowed.body as any).worker_bearer}` } } as never);
  assert.ok(mintedAuth.agentSession);
  assert.ok(new Date(mintedAuth.agentSession!.expires_at).getTime() <= new Date(grantResult.grant.expires_at).getTime());
  const denied = recorder();
  await mint({ ...reqBase, body: { generation: 1, room_id: "other_room", agent_key: agent.canonical_key, agent_instance_id: "worker_route_1" } }, denied);
  assert.equal(denied.statusCode, 403);
  const otherAgent = await authDb!.registerAgentIdentity({ canonical_key: "owner/disallowed-agent", name: "disallowed-agent", display_name: "Disallowed Agent", owner_account_id: "owner_route", owner_login: "owner", owner_label: "Owner" });
  const agentDenied = recorder();
  await mint({ ...reqBase, body: { generation: 1, room_id: room.id, agent_key: otherAgent.canonical_key, agent_instance_id: "worker_route_1" } }, agentDenied);
  assert.equal(agentDenied.statusCode, 403);
});

test("lost Git Room access blocks renewal and tears down the grant-owned worker", { skip: requiresDatabase }, async () => {
  const {
    room, agent, handlers, reqBase, grantResult, accessOptions, setParticipantAllowed,
  } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const minted = recorder();
  await mint({
    ...reqBase,
    body: {
      generation: 1,
      room_id: room.id,
      agent_key: agent.canonical_key,
      agent_instance_id: "worker_access_revoked",
    },
  }, minted);
  assert.equal(minted.statusCode, 201);

  setParticipantAllowed(false);
  clearSupervisorAccessRevalidationCache(grantResult.grant.grant_id);
  const renew = handlers.get("POST /supervisor-host-grants/:grantId/renew"); assert.ok(renew);
  const denied = recorder();
  await renew({
    ...reqBase,
    body: {
      generation: 1,
      host_id: grantResult.grant.host_id,
      installation_id: grantResult.grant.installation_id,
    },
  }, denied);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(accessOptions.at(-1), {
    freshCollaboratorCheck: true,
    throwOnIndeterminate: true,
  });

  const [storedGrant] = await client!.db.select().from(schema!.supervisor_host_grants)
    .where(eq(schema!.supervisor_host_grants.grant_id, grantResult.grant.grant_id));
  const [storedSession] = await client!.db.select().from(schema!.room_agent_sessions)
    .where(eq(schema!.room_agent_sessions.session_id, (minted.body as any).session_id));
  const [storedBearer] = await client!.db.select().from(schema!.room_agent_session_bearers)
    .where(eq(schema!.room_agent_session_bearers.bearer_id, (minted.body as any).worker_bearer_id));
  assert.ok(storedGrant?.revoked_at);
  assert.ok(storedSession?.ended_at);
  assert.ok(storedBearer?.revoked_at);

  const staleWorker = await resolveRequestAuth({
    headers: { authorization: `Bearer ${(minted.body as any).worker_bearer}` },
  } as never);
  assert.equal(staleWorker.authKind, null);
});

test("repository access-change revocation finds repo grants and ends their workers", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const now = new Date().toISOString();
  await client!.db.insert(schema!.room_git_bindings).values({
    room_id: room.id,
    provider: "github",
    host: "github.com",
    repository_id: "repo_access_change",
    repository_full_name: "BrosInCode/private-repo",
    repository_owner: "BrosInCode",
    repository_name: "private-repo",
    ref_type: "default_branch",
    ref_name: "main",
    default_branch: "main",
    base_ref: null,
    head_ref: null,
    head_repository_id: null,
    head_repository_full_name: null,
    head_repository_owner: null,
    head_repository_name: null,
    visibility: "private",
    is_default: true,
    source: "webhook",
    created_at: now,
    updated_at: now,
  });

  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const minted = recorder();
  await mint({
    ...reqBase,
    body: {
      generation: 1,
      room_id: room.id,
      agent_key: agent.canonical_key,
      agent_instance_id: "worker_repo_access_change",
    },
  }, minted);
  assert.equal(minted.statusCode, 201);

  const revoked = await authDb!.revokeSupervisorGrantsForRepositoryAccessChange({
    repository_full_name: "brosincode/PRIVATE-repo",
    canonical_room_id: "github.com/brosincode/private-repo",
    owner_login: "OWNER_ROUTE",
  });
  assert.deepEqual(revoked.revoked_grant_ids, [grantResult.grant.grant_id]);
  assert.deepEqual(revoked.ended_session_ids, [(minted.body as any).session_id]);
  assert.equal((await resolveRequestAuth({
    headers: { authorization: `Bearer ${(minted.body as any).worker_bearer}` },
  } as never)).authKind, null);
});

test("revocation retry finishes worker teardown after the grant was already revoked", { skip: requiresDatabase }, async () => {
  const { room, agent, grantResult } = await setupLifecycle();
  await authDb!.upsertGitHubRepositoryLink({
    github_repo_id: "repo_revocation_retry",
    room_id: room.id,
    owner_login: "BrosInCode",
    repo_name: "revocation-retry",
    default_branch: "main",
    visibility: "private",
  });
  const session = await authDb!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Retry Worker",
    agent_key: agent.canonical_key, agent_instance_id: "worker_revocation_retry", display_name: "Retry Worker",
    owner_account_id: "owner_route", owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: grantResult.grant.grant_id,
  });

  await authDb!.revokeSupervisorHostGrant({
    grant_id: grantResult.grant.grant_id,
    owner_account_id: "owner_route",
  });
  assert.equal((await resolveRequestAuth({
    headers: { authorization: `Bearer ${session.worker_bearer}` },
  } as never)).authKind, null, "bearer auth closes as soon as the parent grant is revoked");

  const retried = await authDb!.revokeSupervisorGrantsForRepositoryAccessChange({
    repository_full_name: "brosincode/REVOCATION-retry",
    canonical_room_id: room.id,
  });
  assert.deepEqual(retried.revoked_grant_ids, []);
  assert.deepEqual(retried.ended_session_ids, [session.session_id]);
  const ended = await authDb!.getSupervisorRoomAgentSession({
    session_id: session.session_id,
    supervisor_grant_id: grantResult.grant.grant_id,
    include_ended: true,
  });
  assert.ok(ended?.ended_at);
});

test("repository revocation follows historical room aliases after a rename", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_alias");
  const link = await authDb!.upsertGitHubRepositoryLink({
    github_repo_id: "repo_alias",
    room_id: "github.com/org/new-name",
    owner_login: "org",
    repo_name: "new-name",
    default_branch: "main",
    visibility: "private",
  });
  const historicalRoomId = "github.com/org/old-name";
  await authDb!.createRoomAlias(link.room_id, historicalRoomId);
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_alias", host_id: "host_alias", installation_id: "install_alias",
    allowed_room_ids: [historicalRoomId], allowed_agent_keys: ["owner_alias/agent"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  const result = await authDb!.revokeSupervisorGrantsForRepositoryAccessChange({
    repository_full_name: "ORG/NEW-NAME",
    canonical_room_id: link.room_id,
  });
  assert.deepEqual(result.revoked_grant_ids, [created.grant.grant_id]);
});

test("GitHub App installation loss revokes every installed repository grant and worker", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_installation");
  const installationId = "installation_access_loss";
  await authDb!.upsertGitHubAppInstallation({
    installation_id: installationId, target_type: "Organization", target_login: "org",
    target_github_id: "github_org", repository_selection: "selected",
  });
  const appRepository = await authDb!.upsertGitHubAppRepository({
    github_repo_id: "repo_installation_access_loss", installation_id: installationId,
    owner_login: "org", repo_name: "installed-private",
  });
  await authDb!.upsertGitHubRepositoryLink({
    github_repo_id: "repo_installation_access_loss", room_id: appRepository.room_id,
    owner_login: "org", repo_name: "installed-private", default_branch: "main", visibility: "private",
  });
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_installation", host_id: "host_installation", installation_id: installationId,
    allowed_room_ids: [appRepository.room_id], allowed_agent_keys: ["owner_installation/agent"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const session = await authDb!.createRoomAgentSession({
    room_id: appRepository.room_id, session_kind: "worker", runtime: "test", actor_label: "Install Worker",
    agent_key: "owner_installation/agent", display_name: "Install Worker",
    owner_account_id: "owner_installation", owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: created.grant.grant_id,
  });

  const result = await authDb!.revokeSupervisorGrantsForGitHubInstallationAccessChange({
    installation_id: installationId,
  });
  assert.deepEqual(result.revoked_grant_ids, [created.grant.grant_id]);
  assert.deepEqual(result.ended_session_ids, [session.session_id]);
  assert.equal((await resolveRequestAuth({
    headers: { authorization: `Bearer ${session.worker_bearer}` },
  } as never)).authKind, null);
});

test("grant revalidation falls back to a live session when the owner token is expired", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_credential_fallback");
  await authDb!.createOwnerToken({
    accountId: "owner_credential_fallback", githubUserId: "github_owner_credential_fallback",
    token: "letagents-owner-token", providerAccessToken: "expired-provider-token",
    oauthTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await authDb!.createSession(
    "owner_credential_fallback",
    "live-browser-session",
    new Date(Date.now() + 60_000).toISOString(),
    "live-provider-token",
  );
  const owner = await authDb!.getSupervisorGrantOwnerAccount("owner_credential_fallback");
  assert.equal(owner?.provider_access_token, "live-provider-token");
});

test("daemon-excluded presence filters supervisor sessions before the result limit", { skip: requiresDatabase }, async () => {
  const { room, agent, grantResult } = await setupLifecycle();
  const legacySession = await authDb!.createRoomAgentSession({
    room_id: room.id,
    session_kind: "worker",
    runtime: "test",
    actor_label: "Legacy Agent | Owner's agent | Agent",
    agent_key: agent.canonical_key,
    agent_instance_id: "legacy-instance",
    display_name: "Legacy Agent",
    owner_account_id: "owner_route",
    owner_label: "Owner",
    ide_label: "Agent",
  });
  await authDb!.markRoomAgentDeliveryConnected({
    room_id: room.id,
    actor_label: legacySession.actor_label,
    agent_key: legacySession.agent_key,
    agent_instance_id: legacySession.agent_instance_id,
    agent_session_id: legacySession.session_id,
    session_kind: "worker",
    runtime: "test",
    display_name: legacySession.display_name,
    owner_label: legacySession.owner_label,
    ide_label: legacySession.ide_label,
    credential_fence: { kind: "session_token", token_hash: hashToken(legacySession.session_token) },
    transport: "long_poll",
  });

  let firstDaemonSessionId = "";
  let firstDaemonDeliveryKey = "";
  for (let index = 0; index < 21; index += 1) {
    const displayName = `Daemon Agent ${String(index).padStart(2, "0")}`;
    const daemonSession = await authDb!.createRoomAgentSession({
      room_id: room.id,
      session_kind: "worker",
      runtime: "test",
      actor_label: `${displayName} | Owner's agent | Agent`,
      agent_key: agent.canonical_key,
      agent_instance_id: `daemon-instance-${index}`,
      display_name: displayName,
      owner_account_id: "owner_route",
      owner_label: "Owner",
      ide_label: "Agent",
      supervisor_grant_id: grantResult.grant.grant_id,
    });
    const delivery = await authDb!.markRoomAgentDeliveryConnected({
      room_id: room.id,
      actor_label: daemonSession.actor_label,
      agent_key: daemonSession.agent_key,
      agent_instance_id: daemonSession.agent_instance_id,
      agent_session_id: daemonSession.session_id,
      session_kind: "worker",
      runtime: "test",
      display_name: daemonSession.display_name,
      owner_label: daemonSession.owner_label,
      ide_label: daemonSession.ide_label,
      credential_fence: { kind: "session_token", token_hash: hashToken(daemonSession.session_token) },
      transport: "long_poll",
    });
    if (index === 0) {
      firstDaemonSessionId = daemonSession.session_id;
      firstDaemonDeliveryKey = delivery.delivery_key;
    }
  }

  const reminderEligible = await authDb!.getRoomAgentPresence(room.id, {
    limit: 20,
    excludeSupervisorManaged: true,
  });
  assert.deepEqual(
    reminderEligible.map((entry) => entry.agent_session_id),
    [legacySession.session_id]
  );

  const liveCandidate = await authDb!.getLivenessAnnouncementCandidate({
    room_id: room.id,
    delivery_key: firstDaemonDeliveryKey,
  });
  assert.equal(liveCandidate?.supervisor_managed, true);
  assert.equal(liveCandidate?.agent_session_ended_at, null);

  await authDb!.endRoomAgentSession({
    session_id: firstDaemonSessionId,
    room_id: room.id,
  });
  const endedCandidate = await authDb!.getLivenessAnnouncementCandidate({
    room_id: room.id,
    delivery_key: firstDaemonDeliveryKey,
  });
  assert.equal(endedCandidate?.supervisor_managed, true);
  assert.ok(endedCandidate?.agent_session_ended_at);
});

test("a freshly minted supervisor bearer can immediately read its Git-backed Focus room through HTTP", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions");
  assert.ok(mint);
  const minted = recorder();
  await mint({ ...reqBase, body: {
    generation: 1,
    room_id: room.id,
    agent_key: agent.canonical_key,
    agent_instance_id: "http-tail-bootstrap-worker",
  } }, minted);
  assert.equal(minted.statusCode, 201);

  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  app.get(`/rooms/${room.id}/messages`, async (req, res) => {
    const allowed = await requireGitRoomParticipant(req as never, res, {
      ...room,
      parent_room_id: "github.com/BrosInCode/letagents",
    });
    if (allowed) res.json({ messages: [] });
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/rooms/${room.id}/messages?limit=1&before=latest`, {
      headers: { authorization: `Bearer ${(minted.body as any).worker_bearer}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { messages: [] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("idempotent supervisor worker creation rotates one session and revokes its old bearer", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const body = { generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "durable-worker-1" };
  const first = recorder();
  await mint({ ...reqBase, body }, first);
  assert.equal(first.statusCode, 201);
  const firstAuth = await resolveRequestAuth({
    headers: { authorization: `Bearer ${(first.body as any).worker_bearer}` },
  } as never);
  assert.ok(firstAuth.agentSession);
  const oldFence = {
    kind: "bearer" as const,
    bearer_id: firstAuth.agentSession!.bearer_id,
    generation: firstAuth.agentSession!.bearer_generation,
  };
  const deliveryIdentity = {
    room_id: room.id,
    actor_label: firstAuth.agentSession!.actor_label,
    agent_key: firstAuth.agentSession!.agent_key,
    agent_instance_id: firstAuth.agentSession!.agent_instance_id,
    agent_session_id: firstAuth.agentSession!.agent_session_id,
    session_kind: "worker" as const,
    runtime: firstAuth.agentSession!.runtime,
    display_name: firstAuth.agentSession!.display_name,
    owner_label: firstAuth.agentSession!.owner_label,
    ide_label: firstAuth.agentSession!.ide_label,
  };
  await authDb!.upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat({
    ...deliveryIdentity,
    credential_fence: oldFence,
    presence: { status: "working", status_text: "old supervisor bearer" },
  });
  const second = recorder();
  await mint({ ...reqBase, body }, second);
  assert.equal(second.statusCode, 201);
  assert.equal((first.body as any).session_id, (second.body as any).session_id);
  assert.notEqual((first.body as any).worker_bearer, (second.body as any).worker_bearer);
  assert.notEqual((first.body as any).worker_bearer_id, (second.body as any).worker_bearer_id);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${(first.body as any).worker_bearer}` } } as never)).authKind, null);
  const secondAuth = await resolveRequestAuth({
    headers: { authorization: `Bearer ${(second.body as any).worker_bearer}` },
  } as never);
  assert.equal(secondAuth.authKind, "agent_session");
  assert.ok(secondAuth.agentSession);
  assert.equal((second.body as any).session_token, undefined);

  const retired = await client!.pool.query<{
    active_connection_count: number;
    presence_count: number;
  }>(`
    SELECT
      COALESCE(MAX(d.active_connection_count), 0)::int AS active_connection_count,
      (SELECT COUNT(*)::int FROM room_agent_presence p
        WHERE p.room_id = $1 AND p.agent_session_id = $2) AS presence_count
    FROM room_agent_delivery_sessions d
    WHERE d.room_id = $1 AND d.agent_session_id = $2
  `, [room.id, firstAuth.agentSession!.agent_session_id]);
  assert.deepEqual(retired.rows[0], { active_connection_count: 0, presence_count: 0 });

  const newFence = {
    kind: "bearer" as const,
    bearer_id: secondAuth.agentSession!.bearer_id,
    generation: secondAuth.agentSession!.bearer_generation,
  };
  await authDb!.upsertDesktopRoomAgentDeliveryAndPresenceHeartbeat({
    ...deliveryIdentity,
    credential_fence: newFence,
    presence: { status: "working", status_text: "new supervisor bearer" },
  });
  const [beforeOldCleanup] = await client!.db.select({
    last_seen_at: schema!.room_agent_sessions.last_seen_at,
  }).from(schema!.room_agent_sessions)
    .where(eq(schema!.room_agent_sessions.session_id, firstAuth.agentSession!.agent_session_id))
    .limit(1);
  await authDb!.markRoomAgentDeliveryHeartbeat({
    room_id: room.id,
    actor_label: deliveryIdentity.actor_label,
    agent_session_id: deliveryIdentity.agent_session_id,
    credential_fence: oldFence,
  });
  assert.equal(await authDb!.markRoomAgentDeliveryDisconnected({
    room_id: room.id,
    actor_label: deliveryIdentity.actor_label,
    agent_session_id: deliveryIdentity.agent_session_id,
    credential_fence: oldFence,
  }), null);
  const [afterOldCleanup] = await client!.db.select({
    last_seen_at: schema!.room_agent_sessions.last_seen_at,
  }).from(schema!.room_agent_sessions)
    .where(eq(schema!.room_agent_sessions.session_id, firstAuth.agentSession!.agent_session_id))
    .limit(1);
  assert.equal(afterOldCleanup.last_seen_at, beforeOldCleanup.last_seen_at,
    "the retired process cannot refresh the stable replacement session");
  const currentDelivery = (await authDb!.getRoomAgentDeliverySessions(room.id))
    .find((delivery) => delivery.agent_session_id === deliveryIdentity.agent_session_id);
  assert.equal(currentDelivery?.active_connection_count, 1,
    "the retired process cleanup cannot decrement the replacement delivery lease");
});

test("supervisor worker end is idempotent after a committed response is lost", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const minted = recorder();
  await mint({ ...reqBase, body: {
    generation: 1, room_id: room.id, agent_key: agent.canonical_key,
    agent_instance_id: "lost-end-response-worker",
  } }, minted);
  assert.equal(minted.statusCode, 201);
  const end = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/end"); assert.ok(end);
  const request = {
    ...reqBase,
    params: { grantId: grantResult.grant.grant_id, sessionId: (minted.body as any).session_id },
    body: { generation: 1 },
  };
  const first = recorder();
  await end(request, first);
  assert.equal(first.statusCode, 200);
  assert.ok((first.body as any).ended_at);
  const retry = recorder();
  await end(request, retry);
  assert.equal(retry.statusCode, 200);
  assert.equal((retry.body as any).session_id, (minted.body as any).session_id);
  assert.equal((retry.body as any).ended_at, (first.body as any).ended_at,
    "the retry returns the original committed terminal record");
  assert.equal(
    (await resolveRequestAuth({ headers: { authorization: `Bearer ${(minted.body as any).worker_bearer}` } } as never)).authKind,
    null,
    "the exact worker bearer is rejected after the durable end acknowledgement",
  );
});

test("supervisor worker retry collapses all historical active duplicates before rotating the retained session", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const common = {
    room_id: room.id, session_kind: "worker" as const, runtime: "legacy", agent_key: agent.canonical_key,
    agent_instance_id: "duplicate-worker", display_name: "Route Agent", owner_account_id: "owner_route",
    owner_label: "Owner", ide_label: "Legacy", supervisor_grant_id: grantResult.grant.grant_id,
    worker_bearer_expires_at: new Date(Date.now() + 30_000).toISOString(),
  };
  const retained = await authDb!.createRoomAgentSession({ ...common, actor_label: "Legacy duplicate A" });
  const duplicate = await authDb!.createRoomAgentSession({ ...common, actor_label: "Legacy duplicate B" });
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const response = recorder();
  await mint({ ...reqBase, body: {
    generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "duplicate-worker",
  } }, response);
  assert.equal(response.statusCode, 201);
  assert.equal((response.body as any).session_id, retained.session_id);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${retained.worker_bearer}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${duplicate.worker_bearer}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${(response.body as any).worker_bearer}` } } as never)).authKind, "agent_session");
  const [duplicateRow] = await client!.db.select().from(schema!.room_agent_sessions)
    .where(eq(schema!.room_agent_sessions.session_id, duplicate.session_id)).limit(1);
  assert.ok(duplicateRow.ended_at, "duplicate session is ended inside the replacement transaction");
  const matching = await client!.db.select().from(schema!.room_agent_sessions)
    .where(eq(schema!.room_agent_sessions.agent_instance_id, "duplicate-worker"));
  assert.equal(matching.filter((row) => row.ended_at === null
    && row.supervisor_grant_id === grantResult.grant.grant_id
    && row.room_id === room.id
    && row.agent_key === agent.canonical_key).length, 1);
});

test("a replacement grant takes over the exact durable worker session across grant ids", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const body = { generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "rollover-worker" };
  const first = recorder();
  await mint({ ...reqBase, body }, first);
  assert.equal(first.statusCode, 201);
  const capturedByOldGrant = await authDb!.getSupervisorRoomAgentSession({
    session_id: (first.body as any).session_id,
    supervisor_grant_id: grantResult.grant.grant_id,
  });
  assert.ok(capturedByOldGrant, "grant A route prelookup captured the session before rollover");
  const replacementGrant = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_route", host_id: "host_route_2", installation_id: "install_route_2",
    allowed_room_ids: [room.id], allowed_agent_keys: [agent.canonical_key],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const second = recorder();
  await mint({
    ...reqBase, supervisorGrant: replacementGrant.grant,
    params: { grantId: replacementGrant.grant.grant_id }, body,
  }, second);
  assert.equal(second.statusCode, 201);
  assert.equal((second.body as any).session_id, (first.body as any).session_id);
  assert.notEqual((second.body as any).worker_bearer, (first.body as any).worker_bearer);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${(first.body as any).worker_bearer}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${(second.body as any).worker_bearer}` } } as never)).authKind, "agent_session");
  const [session] = await client!.db.select().from(schema!.room_agent_sessions)
    .where(eq(schema!.room_agent_sessions.session_id, (first.body as any).session_id)).limit(1);
  assert.equal(session.supervisor_grant_id, replacementGrant.grant.grant_id);
  await assert.rejects(authDb!.endRoomAgentSession({
    session_id: capturedByOldGrant!.session_id,
    owner_account_id: grantResult.grant.owner_account_id,
    supervisor_grant_id: grantResult.grant.grant_id,
    supervisor_grant_fence: {
      grant_id: grantResult.grant.grant_id,
      generation: grantResult.grant.current_generation,
      token_version: grantResult.grant.token_version,
    },
  }), (error: unknown) => authDb!.isSupervisorGrantFenceStaleError(error));
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${(second.body as any).worker_bearer}` } } as never)).authKind, "agent_session",
    "grant A's stale end cannot terminate grant B's replacement bearer");
});

test("stale supervisor worker fence is an explicit conflict, never an internal error", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const session = await authDb!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Stale Worker",
    agent_key: agent.canonical_key, agent_instance_id: "stale-worker", display_name: "Stale Worker",
    owner_account_id: "owner_route", owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: grantResult.grant.grant_id,
  });
  const resolved = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  assert.ok(resolved.agentSession);
  const staleFence = { grant_id: grantResult.grant.grant_id, generation: 1, token_version: 1 };
  const rotated = await authDb!.rotateSupervisorHostGrant({
    grant_id: grantResult.grant.grant_id, expected_generation: 1, expected_token_version: 1,
    expires_at: grantResult.grant.expires_at,
  });
  assert.ok(rotated);
  await assert.rejects(authDb!.createOrRotateSupervisorWorkerSession({
    room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Stale Worker",
    agent_key: agent.canonical_key, agent_instance_id: "stale-worker", display_name: "Stale Worker",
    owner_account_id: "owner_route", owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: grantResult.grant.grant_id, supervisor_grant_fence: staleFence,
  }), (error: unknown) => authDb!.isSupervisorGrantFenceStaleError(error));
  await assert.rejects(authDb!.rotateRoomAgentSessionBearer({
    bearer_id: resolved.agentSession!.bearer_id, session_id: session.session_id,
    supervisor_grant_id: grantResult.grant.grant_id, supervisor_grant_fence: staleFence,
  }), (error: unknown) => authDb!.isSupervisorGrantFenceStaleError(error));
  await assert.rejects(authDb!.endRoomAgentSession({
    session_id: session.session_id, owner_account_id: "owner_route", supervisor_grant_fence: staleFence,
  }), (error: unknown) => authDb!.isSupervisorGrantFenceStaleError(error));
  const mint = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions"); assert.ok(mint);
  const response = recorder();
  await mint({ ...reqBase, body: {
    generation: 1, room_id: room.id, agent_key: agent.canonical_key, agent_instance_id: "stale-worker",
  } }, response);
  assert.equal(response.statusCode, 409);
  const rotate = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/rotate"); assert.ok(rotate);
  const rotateResponse = recorder();
  await rotate({ ...reqBase, params: { grantId: grantResult.grant.grant_id, sessionId: session.session_id }, body: {
    generation: 1, bearer_id: resolved.agentSession!.bearer_id,
  } }, rotateResponse);
  assert.equal(rotateResponse.statusCode, 409);
  const end = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/end"); assert.ok(end);
  const endResponse = recorder();
  await end({ ...reqBase, params: { grantId: grantResult.grant.grant_id, sessionId: session.session_id }, body: {
    generation: 1,
  } }, endResponse);
  assert.equal(endResponse.statusCode, 409);
});

test("lifecycle handlers fail closed when the path grant differs from the authenticated grant", { skip: requiresDatabase }, async () => {
  const { handlers, reqBase } = await setupLifecycle();
  const requests: Array<[string, Record<string, unknown>]> = [
    ["POST /supervisor-host-grants/:grantId/handoff", { body: { generation: 1 } }],
    ["POST /supervisor-host-grants/:grantId/worker-sessions", { body: { generation: 1, room_id: "room", agent_key: "owner/agent", agent_instance_id: "worker_1" } }],
    ["POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/rotate", { params: { grantId: "different_grant", sessionId: "session" }, body: { generation: 1, bearer_id: "bearer" } }],
    ["POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/end", { params: { grantId: "different_grant", sessionId: "session" }, body: { generation: 1 } }],
  ];
  for (const [route, override] of requests) {
    const handler = handlers.get(route); assert.ok(handler);
    const response = recorder();
    await handler({ ...reqBase, ...override, params: { grantId: "different_grant", ...(override.params as object ?? {}) } }, response);
    assert.equal(response.statusCode, 403, route);
  }
});

test("wrong-session rotation route cannot mutate a grant-bound bearer", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const session = await authDb!.createRoomAgentSession({ room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Route Agent", agent_key: agent.canonical_key, display_name: "Route Agent", owner_account_id: "owner_route", owner_label: "Owner", ide_label: "Agent", supervisor_grant_id: grantResult.grant.grant_id, worker_bearer_expires_at: new Date(Date.now() + 30_000).toISOString() });
  const initial = await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never);
  const rotate = handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/rotate"); assert.ok(rotate);
  const response = recorder();
  await rotate({ ...reqBase, params: { grantId: grantResult.grant.grant_id, sessionId: "wrong_session" }, body: { generation: 1, bearer_id: initial.agentSession!.bearer_id } }, response);
  assert.equal(response.statusCode, 403);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never)).authKind, "agent_session");
});

test("attestation route: strict inputs, in-tx authorization, immutable evidence", { skip: requiresDatabase }, async () => {
  const { room, agent, handlers, reqBase, grantResult } = await setupLifecycle();
  const attest = handlers.get("POST /supervisor-host-grants/:grantId/leases/:leaseId/attestation"); assert.ok(attest);
  const grantId = reqBase.params.grantId;

  // The predecessor is a real supervised worker: minted under THIS grant, then
  // ended (terminal) — the in-tx authorization requires both.
  const from = await authDb!.createRoomAgentSession({ room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Route Agent", agent_key: agent.canonical_key, display_name: "Route Agent", owner_account_id: "owner_route", owner_label: "Owner", ide_label: "Agent", supervisor_grant_id: grantResult.grant.grant_id });
  const lease = await authDb!.createTaskLease({ room_id: room.id, task_id: "task_1", kind: "work", agent_key: agent.canonical_key, actor_label: "Route Agent", created_by: "Route Agent", agent_session_id: from.session_id });
  const wa = randomUUID();
  const eg = randomUUID();
  const goodBody = { generation: 1, expected_epoch: 0, from_agent_session_id: from.session_id, work_attempt_id: wa, execution_generation_id: eg, cause: "crashed" };
  const call = async (body: Record<string, unknown>, leaseId = lease.id) => {
    const res = recorder();
    await attest({ ...reqBase, params: { grantId, leaseId }, body }, res);
    return res;
  };

  // A live (not ended) predecessor cannot be attested terminal.
  const live = await call(goodBody);
  assert.equal(live.statusCode, 403);
  assert.equal((live.body as any).code, "predecessor_live");

  await authDb!.endRoomAgentSession({ session_id: from.session_id });

  // Terminal predecessor, in-scope lease → 201, recorded at the grant's current
  // generation, un-consumed.
  const ok = await call(goodBody);
  assert.equal(ok.statusCode, 201);
  assert.equal((ok.body as any).lease_id, lease.id);
  assert.equal((ok.body as any).supervisor_generation, 1);
  assert.equal((ok.body as any).consumed_at, null);
  const recordedId = (ok.body as any).id;

  // Idempotent identical retry → 200, the SAME untouched row (and the body
  // cannot forge a different generation than the validated grant fence).
  const retry = await call({ ...goodBody, supervisor_generation: 99 });
  assert.equal(retry.statusCode, 200, "identical retry is idempotent, not a new insert");
  assert.equal((retry.body as any).id, recordedId);
  assert.equal((retry.body as any).supervisor_generation, 1, "generation is taken from the grant, not the body");
  assert.equal((retry.body as any).attested_at, (ok.body as any).attested_at, "evidence untouched by the retry");

  // Conflicting retry (different execution identity) → 409, evidence immutable.
  const conflict = await call({ ...goodBody, execution_generation_id: randomUUID() });
  assert.equal(conflict.statusCode, 409);
  assert.equal((conflict.body as any).code, "evidence_conflict");
  const [row] = await client!.db.select().from(schema!.task_lease_rebind_attestations).where(eq(schema!.task_lease_rebind_attestations.id, recordedId)).limit(1);
  assert.equal(row.execution_generation_id, eg, "original evidence not overwritten");

  // Strict JSON integer epoch: string epochs (Number-coercible or not) → 400.
  for (const expected_epoch of ["", "0", "3", null, 1.5]) {
    const bad = await call({ ...goodBody, expected_epoch });
    assert.equal(bad.statusCode, 400, `expected_epoch ${JSON.stringify(expected_epoch)} rejected`);
  }

  // Strict cause enum and UUID-shaped P1b execution ids → 400.
  assert.equal((await call({ ...goodBody, cause: "sdf" })).statusCode, 400);
  assert.equal((await call({ ...goodBody, work_attempt_id: "wa_1" })).statusCode, 400);
  assert.equal((await call({ ...goodBody, execution_generation_id: "eg_1" })).statusCode, 400);

  // Wrong epoch / wrong from-session (not the holder) → 409 lease_mismatch.
  const wrongEpoch = await call({ ...goodBody, expected_epoch: 5 });
  assert.equal(wrongEpoch.statusCode, 409);
  assert.equal((wrongEpoch.body as any).code, "lease_mismatch");
  const wrongFrom = await call({ ...goodBody, from_agent_session_id: "sess_not_holder" });
  assert.equal(wrongFrom.statusCode, 409);
  assert.equal((wrongFrom.body as any).code, "lease_mismatch");

  // Stale grant generation proof → rejected before any write.
  const staleGrant = await call({ ...goodBody, generation: 99 });
  assert.equal(staleGrant.statusCode, 403);

  // A lease the grant does not scope (different agent key) → 403, nothing written.
  const otherAgent = await authDb!.registerAgentIdentity({ canonical_key: "owner/other-agent", name: "other-agent", display_name: "Other", owner_account_id: "owner_route", owner_login: "owner", owner_label: "Owner" });
  const otherLease = await authDb!.createTaskLease({ room_id: room.id, task_id: "task_2", kind: "work", agent_key: otherAgent.canonical_key, actor_label: "Other", created_by: "Other" });
  const denied = await call({ ...goodBody, from_agent_session_id: "sess_x" }, otherLease.id);
  assert.equal(denied.statusCode, 403);
  assert.equal((denied.body as any).code, "grant_scope");

  // Unknown lease → 404.
  const missing = await call(goodBody, "tl_nope");
  assert.equal(missing.statusCode, 404);

  // Missing required fields → 400.
  const bad = await call({ generation: 1, expected_epoch: 0, from_agent_session_id: from.session_id });
  assert.equal(bad.statusCode, 400);

  // Exactly one attestation row exists after the whole gauntlet.
  const rows = await client!.db.select().from(schema!.task_lease_rebind_attestations);
  assert.equal(rows.length, 1, "only the one legitimate attestation was persisted");
});

test("rebind route requires the exact attestation tuple and a strict integer epoch", { skip: requiresDatabase }, async () => {
  const { handlers, reqBase } = await setupLifecycle();
  const rebind = handlers.get("POST /supervisor-host-grants/:grantId/leases/:leaseId/rebind"); assert.ok(rebind);
  const grantId = reqBase.params.grantId;
  const call = async (body: Record<string, unknown>) => {
    const res = recorder();
    await rebind({ ...reqBase, params: { grantId, leaseId: "tl_x" }, body }, res);
    return res;
  };
  const good = {
    generation: 1, expected_epoch: 0, from_agent_session_id: "sess_a", to_agent_session_id: "sess_b",
    attestation_id: "tlra_1", work_attempt_id: randomUUID(), execution_generation_id: randomUUID(),
  };
  // Every degraded variant of the exact-tuple requirement → 400 before any DB work.
  assert.equal((await call({ ...good, attestation_id: undefined })).statusCode, 400);
  assert.equal((await call({ ...good, work_attempt_id: undefined })).statusCode, 400);
  assert.equal((await call({ ...good, execution_generation_id: "eg_1" })).statusCode, 400);
  assert.equal((await call({ ...good, expected_epoch: "0" })).statusCode, 400);
  assert.equal((await call({ ...good, expected_epoch: "" })).statusCode, 400);
  // Well-formed but nonexistent → the transaction decides (409 lost_race here).
  const wellFormed = await call(good);
  assert.equal(wellFormed.statusCode, 409);
  assert.equal((wellFormed.body as any).code, "lost_race");
});

test("concurrent renewal has exactly one winner and stale token cannot replay", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_1");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_1", host_id: "host_1", installation_id: "install_1",
    allowed_room_ids: ["room_1"], allowed_agent_keys: ["owner/agent_1"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const input = { grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1, expires_at: new Date(Date.now() + 120_000).toISOString() };
  const [left, right] = await Promise.all([authDb!.rotateSupervisorHostGrant(input), authDb!.rotateSupervisorHostGrant(input)]);
  assert.equal([left, right].filter(Boolean).length, 1);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
  const winner = left ?? right;
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${winner!.token}` } } as never)).authKind, "supervisor_grant");
});

test("matching-scope grant creation recovers a lost response by preserving identity and rotating the unknown bearer", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_create_recovery");
  const input = {
    owner_account_id: "owner_create_recovery",
    host_id: "host_create_recovery",
    installation_id: "install_create_recovery",
    allowed_room_ids: ["room_create_recovery"],
    allowed_agent_keys: ["owner_create_recovery/agent"],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const first = await authDb!.createSupervisorHostGrant(input);
  const recovered = await authDb!.createSupervisorHostGrant({
    ...input,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  });
  assert.equal(recovered.grant.grant_id, first.grant.grant_id);
  assert.equal(recovered.grant.token_version, first.grant.token_version + 1);
  assert.notEqual(recovered.token, first.token);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${first.token}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${recovered.token}` } } as never)).authKind, "supervisor_grant");
  await assert.rejects(
    authDb!.createSupervisorHostGrant({ ...input, allowed_room_ids: ["different_room"] }),
    (error: unknown) => authDb!.isSupervisorGrantProvisionConflictError(error),
  );
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${recovered.token}` } } as never)).authKind, "supervisor_grant",
    "a mismatched recovery attempt cannot rotate the exact active grant");
});

test("handoff is a current-generation CAS, rotates its host token, and rejects stale authority", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_2");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_2", host_id: "host_2", installation_id: "install_2",
    allowed_room_ids: ["room_2"], allowed_agent_keys: ["owner/agent_2"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const [left, right] = await Promise.all([
    authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 }),
    authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 }),
  ]);
  assert.equal([left, right].filter(Boolean).length, 1);
  const winner = left ?? right;
  assert.equal(winner!.grant.current_generation, 2);
  assert.equal(winner!.grant.token_version, 2);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${winner!.token}` } } as never)).authKind, "supervisor_grant");
  assert.equal((await authDb!.advanceSupervisorHostGrantGeneration({ grant_id: created.grant.grant_id, expected_generation: 1, expected_token_version: 1 })), null);
  await authDb!.revokeSupervisorHostGrant({ grant_id: created.grant.grant_id, owner_account_id: "owner_2" });
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
});

test("an expired grant cannot authenticate even before a worker bearer reaches its own expiry", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_3");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_3", host_id: "host_3", installation_id: "install_3",
    allowed_room_ids: ["room_3"], allowed_agent_keys: ["owner/agent_3"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await client!.db.update(schema!.supervisor_host_grants).set({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .where(eq(schema!.supervisor_host_grants.grant_id, created.grant.grant_id));
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${created.token}` } } as never)).authKind, null);
});

test("a valid browser cookie plus supervisor bearer fails closed", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_5");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_5", host_id: "host_5", installation_id: "install_5",
    allowed_room_ids: ["room_5"], allowed_agent_keys: ["owner/agent_5"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await authDb!.createSession("owner_5", "browser_session", new Date(Date.now() + 60_000).toISOString());
  const auth = await resolveRequestAuth({ headers: { cookie: "letagents_session=browser_session", authorization: `Bearer ${created.token}` } } as never);
  assert.equal(auth.authKind, null);
  assert.equal(auth.account, null);
});

test("revoking a parent grant immediately invalidates its worker bearer", { skip: requiresDatabase }, async () => {
  await seedOwner("owner_4");
  const created = await authDb!.createSupervisorHostGrant({
    owner_account_id: "owner_4", host_id: "host_4", installation_id: "install_4",
    allowed_room_ids: ["placeholder"], allowed_agent_keys: ["owner/agent_4"], expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const room = await authDb!.createProjectWithName("supervisor-worker-room");
  const session = await authDb!.createRoomAgentSession({
    room_id: room.id, session_kind: "worker", runtime: "test", actor_label: "Worker | Owner | Agent", agent_key: "owner/agent_4",
    display_name: "Worker", owner_account_id: "owner_4", owner_label: "Owner", ide_label: "Agent",
    supervisor_grant_id: created.grant.grant_id, worker_bearer_expires_at: new Date(Date.now() + 30_000).toISOString(),
  });
  await authDb!.revokeSupervisorHostGrant({ grant_id: created.grant.grant_id, owner_account_id: "owner_4" });
  assert.equal((await resolveRequestAuth({ headers: { authorization: `Bearer ${session.worker_bearer}` } } as never)).authKind, null);
});

const workSummary = {
  version: 1, recorded_state: "active", evidence_incomplete: false, elapsed_ms: null,
  operation_counts: { unresolved: 1, succeeded: 0, failed: 0, denied_before_start: 0, cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0 },
};

async function setupWork() {
  const lifecycle = await setupLifecycle();
  const mint = lifecycle.handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions");
  const mintBody = { generation: 1, room_id: lifecycle.room.id, agent_key: lifecycle.agent.canonical_key, agent_instance_id: "work_instance" };
  const minted = recorder();
  await mint({ ...lifecycle.reqBase, body: mintBody }, minted);
  assert.equal(minted.statusCode, 201);
  const session = minted.body;
  const now = new Date().toISOString();
  await client!.db.insert(schema!.messages).values({ room_id: lifecycle.room.id, number: 1, sender: "Owner", text: "Assess this project", timestamp: now });
  await client!.db.insert(schema!.message_agent_receipts).values({
    id: randomUUID(), room_id: lifecycle.room.id, message_room_id: lifecycle.room.id, message_number: 1,
    agent_session_id: session.session_id, agent_key: lifecycle.agent.canonical_key, actor_label: "Work Agent",
    activation_reason: "explicit_mention", receipt_state: "responding", created_at: now, updated_at: now,
  });
  const input = {
    fence: { grant_id: lifecycle.grantResult.grant.grant_id, generation: 1, token_version: 1 },
    room_id: lifecycle.room.id, session_id: session.session_id, source_message_number: 1, revision: 1, summary: workSummary,
  };
  const publish = lifecycle.handlers.get("POST /supervisor-host-grants/:grantId/worker-sessions/:sessionId/agent-work");
  const publishRequest = { ...lifecycle.reqBase, params: { ...lifecycle.reqBase.params, sessionId: session.session_id },
    body: { generation: 1, room_id: lifecycle.room.id, source_message_id: "msg_1", revision: 1, summary: workSummary } };
  return { ...lifecycle, session, input, mint, mintBody, publish, publishRequest };
}

test("room work summary is a canonical, bounded allowlist without private fields", () => {
  assert.deepEqual(parseRoomAgentWorkSummary(workSummary), workSummary);
  assert.deepEqual(parseRoomAgentWorkSummary({ ...workSummary, operation_counts: Object.fromEntries(Object.entries(workSummary.operation_counts).reverse()) }), workSummary);
  for (const summary of [
    { ...workSummary, command: "SECRET=private npm test" },
    { ...workSummary, recorded_state: "\u202Ecompleted" },
    { ...workSummary, version: 2 }, { ...workSummary, elapsed_ms: -1 },
    { ...workSummary, elapsed_ms: "100" },
    { ...workSummary, operation_counts: { ...workSummary.operation_counts, path: "/Users/private" } },
    { ...workSummary, operation_counts: { ...workSummary.operation_counts, unresolved: 10_001 } },
    { ...workSummary, operation_counts: { ...workSummary.operation_counts, succeeded: -1 } },
  ]) assert.equal(parseRoomAgentWorkSummary(summary), null);
  const paths: string[] = [];
  const before = process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED;
  try {
    process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "false";
    registerRoomAgentWorkRoutes({ get() { paths.push("GET"); }, post() { paths.push("POST"); } } as never, {} as never, {} as never);
    assert.deepEqual(paths, ["GET"]);
  } finally { process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = before; }
});

test("room work HTTP writes require the exact supervisor and reads require current human membership", { skip: requiresDatabase }, async () => {
  const f = await setupWork();
  for (const authKind of ["session", "owner_token", "agent_session", null]) {
    const denied = recorder();
    await f.publish({ ...f.publishRequest, authKind }, denied);
    assert.equal(denied.statusCode, 403);
  }
  const wrongPath = recorder();
  await f.publish({ ...f.publishRequest, params: { ...f.publishRequest.params, grantId: "foreign_grant" } }, wrongPath);
  assert.equal(wrongPath.statusCode, 403);
  const invalid = recorder();
  await f.publish({ ...f.publishRequest, body: { ...f.publishRequest.body, summary: { ...workSummary, stdout: "private" } } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.doesNotMatch(JSON.stringify(invalid.body), /private|stdout/);
  const created = recorder();
  await f.publish({ ...f.publishRequest, body: { ...f.publishRequest.body, room_id: "room_alias" } }, created);
  assert.equal(created.statusCode, 201);
  const reader = f.handlers.get("GET agent-work");
  const readRequest = { authKind: "session", sessionAccount: { account_id: "owner_route" }, params: { 0: "room_alias", 1: created.body.work.attempt_id } };
  const result = recorder();
  await reader(readRequest, result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.room_id, f.room.id);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.deepEqual(Object.keys(result.body).sort(), ["agent_key", "attempt_id", "revision", "room_id", "source_message_id", "summary", "updated_at"]);
  assert.doesNotMatch(JSON.stringify(result.body), /work_instance|host_route|install_route|supervisor_grant|session_id/);
  f.setReaderAllowed(false);
  const denied = recorder(); await reader(readRequest, denied); assert.equal(denied.statusCode, 403);
  const worker = recorder(); await reader({ ...readRequest, authKind: "agent_session" }, worker); assert.equal(worker.statusCode, 401);
  f.setReaderAllowed(true);
  const unknown = recorder(); await reader({ ...readRequest, params: { 0: f.room.id, 1: randomUUID() } }, unknown);
  await client!.db.update(schema!.messages).set({ agent_prompt_kind: "auto", text: "" });
  const concealed = recorder(); await reader(readRequest, concealed);
  assert.equal(concealed.statusCode, 404); assert.deepEqual(concealed.body, unknown.body);
  assert.deepEqual(await readRoomAgentWork({ room_id: f.room.id }), { work: [], truncated: false });
});

test("room work revisions are idempotent and conflicts never overwrite or change identity", { skip: requiresDatabase }, async () => {
  const f = await setupWork();
  const first = await publishRoomAgentWork(f.input);
  const replay = await publishRoomAgentWork(f.input);
  assert.equal(first.status, "created"); assert.equal(replay.status, "replayed"); assert.deepEqual(replay.work, first.work);
  const newer = await publishRoomAgentWork({ ...f.input, revision: 2 });
  assert.equal(newer.work.attempt_id, first.work.attempt_id);
  await assert.rejects(publishRoomAgentWork(f.input), { code: "revision_conflict" });
  await assert.rejects(publishRoomAgentWork({ ...f.input, revision: 2, summary: { ...workSummary, recorded_state: "failed" } }), { code: "revision_conflict" });
  const concurrent = await Promise.allSettled([
    publishRoomAgentWork({ ...f.input, revision: 3, summary: { ...workSummary, recorded_state: "failed" } }),
    publishRoomAgentWork({ ...f.input, revision: 3, summary: { ...workSummary, recorded_state: "completed" } }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code, "revision_conflict");
  const rows = await client!.db.select().from(schema!.room_agent_work);
  assert.equal(rows.length, 1); assert.equal(rows[0].publisher_revision, 3);
});

test("room work survives in-place renewal and same-instance successor but refuses takeover and shutdown tail uploads", { skip: requiresDatabase }, async () => {
  const f = await setupWork();
  const first = await publishRoomAgentWork(f.input);
  const reminted = recorder(); await f.mint({ ...f.reqBase, body: f.mintBody }, reminted);
  assert.equal(reminted.body.session_id, f.session.session_id);
  assert.equal((await publishRoomAgentWork({ ...f.input, revision: 2 })).work.attempt_id, first.work.attempt_id);
  await authDb!.endRoomAgentSession({ session_id: f.session.session_id });
  await assert.rejects(publishRoomAgentWork({ ...f.input, revision: 3 }), { code: "publisher_not_authorized" });
  assert.equal((await readRoomAgentWork({ room_id: f.room.id })).work.length, 1);
  const successor = recorder(); await f.mint({ ...f.reqBase, body: f.mintBody }, successor);
  assert.notEqual(successor.body.session_id, f.session.session_id);
  const recovered = { ...f.input, session_id: successor.body.session_id, revision: 3 };
  assert.equal((await publishRoomAgentWork(recovered)).work.attempt_id, first.work.attempt_id);
  await seedOwner("foreign_owner");
  const foreign = await authDb!.createRoomAgentSession({
    room_id: f.room.id, session_kind: "worker", runtime: "legacy", actor_label: "Foreign worker",
    agent_key: f.agent.canonical_key, display_name: "Foreign worker", owner_account_id: "foreign_owner",
    owner_label: "Foreign", ide_label: "Agent", agent_instance_id: "foreign_instance",
  });
  // A foreign owner's live same-key session is still an ambiguity, not a
  // candidate to silently discard when counting possible successors.
  await assert.rejects(publishRoomAgentWork({ ...recovered, revision: 4 }), { code: "publisher_not_authorized" });
  await assert.rejects(publishRoomAgentWork({ ...recovered, session_id: foreign.session_id, revision: 4 }), { code: "publisher_not_authorized" });
  await authDb!.endRoomAgentSession({ session_id: foreign.session_id });
  const other = recorder(); await f.mint({ ...f.reqBase, body: { ...f.mintBody, agent_instance_id: "different_instance", display_name: "Other Agent" } }, other);
  assert.equal(other.statusCode, 201);
  await assert.rejects(publishRoomAgentWork({ ...recovered, revision: 4 }), { code: "publisher_not_authorized" });
  await authDb!.endRoomAgentSession({ session_id: successor.body.session_id });
  await assert.rejects(publishRoomAgentWork({ ...recovered, session_id: other.body.session_id, revision: 4 }), { code: "publisher_conflict" });
  await authDb!.endRoomAgentSession({ session_id: other.body.session_id });
  const otherHost = await authDb!.createSupervisorHostGrant({ owner_account_id: "owner_route", host_id: "other_host", installation_id: "other_installation",
    allowed_room_ids: [f.room.id], allowed_agent_keys: [f.agent.canonical_key], expires_at: new Date(Date.now() + 60_000).toISOString() });
  const moved = recorder(); await f.mint({ ...f.reqBase, supervisorGrant: otherHost.grant, params: { grantId: otherHost.grant.grant_id }, body: f.mintBody }, moved);
  assert.equal(moved.statusCode, 201);
  await assert.rejects(publishRoomAgentWork({ ...recovered, session_id: moved.body.session_id, revision: 4,
    fence: { grant_id: otherHost.grant.grant_id, generation: 1, token_version: 1 } }), { code: "publisher_conflict" });
});

test("room work grant handoff fences stale generation without duplicating the public attempt", { skip: requiresDatabase }, async () => {
  const f = await setupWork();
  const first = await publishRoomAgentWork(f.input);
  const next = await authDb!.advanceSupervisorHostGrantGeneration({ grant_id: f.input.fence.grant_id, expected_generation: 1, expected_token_version: 1 });
  assert.ok(next);
  await assert.rejects(publishRoomAgentWork({ ...f.input, revision: 2 }), { code: "supervisor_grant_fence_stale" });
  const updated = await publishRoomAgentWork({ ...f.input, revision: 2, fence: { grant_id: next.grant.grant_id, generation: 2, token_version: next.grant.token_version } });
  assert.equal(updated.work.attempt_id, first.work.attempt_id);
});

test("room work rejects unrouted, foreign, ended, and rental-scoped publishers", { skip: requiresDatabase }, async () => {
  const f = await setupWork();
  await assert.rejects(publishRoomAgentWork({ ...f.input, source_message_number: 999 }), { code: "publisher_not_authorized" });
  await assert.rejects(publishRoomAgentWork({ ...f.input, session_id: "foreign_session" }), { code: "publisher_not_authorized" });
  await client!.db.update(schema!.supervisor_host_grants).set({ scope_key: "rental:session", rental_session_id: "rental" });
  await assert.rejects(publishRoomAgentWork(f.input), { code: "publisher_not_authorized" });
  await client!.db.update(schema!.supervisor_host_grants).set({ scope_key: "owner", rental_session_id: null });
  await client!.db.update(schema!.messages).set({ visibility: "internal" });
  await assert.rejects(publishRoomAgentWork(f.input), { code: "publisher_not_authorized" });
  assert.equal((await client!.db.select().from(schema!.room_agent_work)).length, 0);
});

test("room work follows source visibility and deletion without leaking list truncation", { skip: requiresDatabase }, async () => {
  const f = await setupWork();
  await publishRoomAgentWork(f.input);
  const [template] = await client!.db.select().from(schema!.room_agent_work);
  for (let number = 2; number <= 53; number++) {
    await client!.db.insert(schema!.messages).values({ room_id: f.room.id, number, sender: "Owner", text: "", agent_prompt_kind: "auto", timestamp: new Date().toISOString() });
    await client!.db.insert(schema!.room_agent_work).values({ ...template, attempt_id: randomUUID(), source_message_number: number });
  }
  const visible = await readRoomAgentWork({ room_id: f.room.id });
  assert.equal(visible.work.length, 1); assert.equal(visible.truncated, false);
  await client!.db.update(schema!.messages).set({ text: "Visible" });
  const full = await readRoomAgentWork({ room_id: f.room.id });
  assert.equal(full.work.length, 50); assert.equal(full.truncated, true);
  await client!.db.delete(schema!.messages);
  assert.deepEqual(await readRoomAgentWork({ room_id: f.room.id }), { work: [], truncated: false });
  assert.equal((await client!.db.select().from(schema!.room_agent_work)).length, 0);
});

test("room work rechecks grant-row rotation and source deletion after lock waits", { skip: requiresDatabase }, async () => {
  const f = await setupWork();
  const lock = await client!.pool.connect();
  async function waitForBlockedPublisher() {
    for (let i = 0; i < 200; i++) {
      const result = await client!.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%select%' LIMIT 1");
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Publisher did not reach the expected row-lock barrier.");
  }
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT grant_id FROM supervisor_host_grants WHERE grant_id = $1 FOR UPDATE", [f.input.fence.grant_id]);
    const publishing = publishRoomAgentWork(f.input).then(() => null, (error) => error);
    await waitForBlockedPublisher();
    await lock.query("UPDATE supervisor_host_grants SET token_version = 2 WHERE grant_id = $1", [f.input.fence.grant_id]);
    await lock.query("COMMIT"); assert.equal((await publishing)?.code, "supervisor_grant_fence_stale");
    await lock.query("BEGIN");
    await lock.query("SELECT number FROM messages WHERE room_id = $1 AND number = 1 FOR UPDATE", [f.room.id]);
    const deleting = publishRoomAgentWork({ ...f.input, fence: { ...f.input.fence, token_version: 2 } }).then(() => null, (error) => error);
    await waitForBlockedPublisher();
    await lock.query("DELETE FROM messages WHERE room_id = $1 AND number = 1", [f.room.id]);
    await lock.query("COMMIT"); assert.equal((await deleting)?.code, "publisher_not_authorized");
    assert.equal((await client!.db.select().from(schema!.room_agent_work)).length, 0);
  } finally { await lock.query("ROLLBACK"); lock.release(); }
});
