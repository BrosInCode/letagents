import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import express, { type Response } from "express";

import type { AuthenticatedRequest } from "../http/helpers.js";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "true";
process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED = "true";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const db = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { registerHttpMiddleware } = await import("../http/middleware.js");
const { resolveRequestAuth } = await import("../request/auth.js");
const { registerExecutionDelegationRoutes } = await import("../routes/execution-delegations.js");
const { executionDelegationEvents } = await import("../server/events.js");

async function reset(): Promise<void> {
  if (!client) throw new Error("DB-backed delegation tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}

const databaseOptions = {
  skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed delegation tests" : false,
};

let ordinal = 0;

async function seed() {
  const n = ++ordinal;
  const now = new Date();
  const ownerId = `delegation_owner_${n}`;
  const approverId = `delegation_approver_${n}`;
  for (const id of [ownerId, approverId]) {
    await client!.db.insert(schema!.accounts).values({
      id,
      provider: "github",
      provider_user_id: id,
      login: id,
      display_name: id,
      avatar_url: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  }
  const room = await db!.createProjectWithName(`delegation-room-${n}`);
  const agent = await db!.registerAgentIdentity({
    owner_account_id: ownerId,
    owner_login: ownerId,
    owner_label: ownerId,
    name: `agent-${n}`,
    display_name: `Agent ${n}`,
  });
  const grantResult = await db!.createSupervisorHostGrant({
    owner_account_id: ownerId,
    host_id: `host_${n}`,
    installation_id: `installation_${n}`,
    allowed_room_ids: [room.id],
    allowed_agent_keys: [agent.canonical_key],
    expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
  });
  return { now, ownerId, approverId, room, agent, grant: grantResult.grant, grantToken: grantResult.token };
}

function admissionInput(
  seeded: Awaited<ReturnType<typeof seed>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    owner_account_id: seeded.ownerId,
    supervisor_grant_id: seeded.grant.grant_id,
    room_id: seeded.room.id,
    agent_key: seeded.agent.canonical_key,
    approver_account_id: seeded.approverId,
    category: "file_change" as const,
    risk_ceiling: "low" as const,
    expires_at: new Date(seeded.now.getTime() + 30 * 60_000).toISOString(),
    client_request_id: `request_${++ordinal}`,
    expected_revision: 0,
    now: seeded.now,
    ...overrides,
  };
}

test("admission derives canonical owner authority and rejects non-owner grant scope", databaseOptions, async () => {
  const seeded = await seed();
  const created = await db!.admitExecutionDelegationGrantRevision(admissionInput(seeded));

  assert.equal(created.status, "created");
  assert.equal(created.grant.revision, 1);
  assert.equal(created.grant.agent_key, seeded.agent.canonical_key);
  assert.equal(created.grant.admission_supervisor_grant_id, seeded.grant.grant_id);
  assert.equal(created.grant.host_id, seeded.grant.host_id);
  assert.equal("agent_id" in created.grant, false);

  const originalScopeDigest = created.grant.scope_sha256;
  const renamedRoomId = `${seeded.room.id}-renamed`;
  await client!.pool.query("UPDATE rooms SET id = $1 WHERE id = $2", [renamedRoomId, seeded.room.id]);
  const [renamed] = await client!.db.select().from(schema!.execution_delegation_grants);
  assert.equal(renamed!.room_id, renamedRoomId);
  assert.equal(renamed!.scope_sha256, originalScopeDigest);

  const rentalGrant = (await db!.createSupervisorHostGrant({
    owner_account_id: seeded.ownerId,
    host_id: seeded.grant.host_id,
    installation_id: seeded.grant.installation_id,
    scope_key: "rental:rental_test",
    rental_session_id: "rental_test",
    allowed_room_ids: [seeded.room.id],
    allowed_agent_keys: [seeded.agent.canonical_key],
    expires_at: new Date(seeded.now.getTime() + 60 * 60_000).toISOString(),
  })).grant;
  await assert.rejects(
    db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
      supervisor_grant_id: rentalGrant.grant_id,
      client_request_id: "rental_scope_request",
    })),
    db!.ExecutionDelegationAuthorityError,
  );

  const disallowedRoom = await db!.createProjectWithName(`disallowed-room-${++ordinal}`);
  await assert.rejects(
    client!.pool.query(
      "UPDATE execution_delegation_grants SET room_id = $1 WHERE delegation_instance_id = $2",
      [disallowedRoom.id, created.grant.delegation_instance_id],
    ),
    /room authority is immutable/,
  );
  const disallowedAgent = await db!.registerAgentIdentity({
    owner_account_id: seeded.ownerId,
    owner_login: seeded.ownerId,
    owner_label: seeded.ownerId,
    name: `disallowed-agent-${++ordinal}`,
  });
  for (const overrides of [
    { room_id: disallowedRoom.id, client_request_id: "room_not_allowed" },
    { agent_key: disallowedAgent.canonical_key, client_request_id: "agent_not_allowed" },
    { approver_account_id: "missing_approver", client_request_id: "missing_approver" },
    { owner_account_id: seeded.approverId, client_request_id: "foreign_owner" },
    {
      now: new Date(seeded.now.getTime() + 2 * 60 * 60_000),
      expires_at: new Date(seeded.now.getTime() + 3 * 60 * 60_000).toISOString(),
      client_request_id: "expired_source",
    },
    {
      expires_at: new Date(seeded.now.getTime() + 30 * 24 * 60 * 60_000 + 1).toISOString(),
      client_request_id: "ttl_too_long",
    },
  ]) {
    await assert.rejects(
      db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, overrides)),
      db!.ExecutionDelegationAuthorityError,
    );
  }
});

test("admission is idempotent and conflicts when a request key changes meaning", databaseOptions, async () => {
  const seeded = await seed();
  const input = admissionInput(seeded, { client_request_id: "same_request" });
  const results = await Promise.all([
    db!.admitExecutionDelegationGrantRevision(input),
    db!.admitExecutionDelegationGrantRevision(input),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["created", "replayed"]);
  assert.equal(results[0]!.grant.delegation_instance_id, results[1]!.grant.delegation_instance_id);
  const rows = await client!.db.select().from(schema!.execution_delegation_grants);
  assert.equal(rows.length, 1);

  await assert.rejects(
    db!.admitExecutionDelegationGrantRevision({
      ...input,
      expires_at: new Date(seeded.now.getTime() + 40 * 60_000).toISOString(),
    }),
    db!.ExecutionDelegationIdempotencyConflictError,
  );
});

test("revision CAS admits one successor and keeps revision identity immutable", databaseOptions, async () => {
  const seeded = await seed();
  const first = await db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
    client_request_id: "revision_1",
  }));
  const attempts = await Promise.allSettled([
    db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
      client_request_id: "revision_2a",
      delegation_instance_id: first.grant.delegation_instance_id,
      expected_revision: 1,
    })),
    db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
      client_request_id: "revision_2b",
      delegation_instance_id: first.grant.delegation_instance_id,
      expected_revision: 1,
      expires_at: new Date(seeded.now.getTime() + 35 * 60_000).toISOString(),
    })),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof db!.ExecutionDelegationRevisionConflictError);

  const rows = await client!.db.select().from(schema!.execution_delegation_grants)
    .where(eq(
      schema!.execution_delegation_grants.delegation_instance_id,
      first.grant.delegation_instance_id,
    ))
    .orderBy(asc(schema!.execution_delegation_grants.revision));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.retired_by_revision, 2);
  assert.ok(rows[0]!.retired_at);
  assert.equal(rows[1]!.retired_at, null);

  const replacementApproverId = `replacement_approver_${++ordinal}`;
  await client!.db.insert(schema!.accounts).values({
    id: replacementApproverId,
    provider: "github",
    provider_user_id: replacementApproverId,
    login: replacementApproverId,
    display_name: replacementApproverId,
    avatar_url: null,
    created_at: seeded.now.toISOString(),
    updated_at: seeded.now.toISOString(),
  });
  await assert.rejects(
    db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
      client_request_id: "scope_change",
      delegation_instance_id: first.grant.delegation_instance_id,
      expected_revision: 2,
      approver_account_id: replacementApproverId,
    })),
    db!.ExecutionDelegationAuthorityError,
  );

  await assert.rejects(
    client!.pool.query(
      "UPDATE execution_delegation_grants SET agent_key = $1 WHERE delegation_instance_id = $2 AND revision = 2",
      ["forged/agent", first.grant.delegation_instance_id],
    ),
    /agent authority is immutable/,
  );

  const race = await Promise.allSettled([
    db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
      client_request_id: "revision_3_race",
      delegation_instance_id: first.grant.delegation_instance_id,
      expected_revision: 2,
    })),
    db!.revokeExecutionDelegationGrant({
      owner_account_id: seeded.ownerId,
      delegation_instance_id: first.grant.delegation_instance_id,
      now: new Date(seeded.now.getTime() + 1_000),
    }),
  ]);
  assert.equal(race[1]!.status, "fulfilled");
  if (race[0]!.status === "rejected") {
    assert.ok(race[0]!.reason instanceof db!.ExecutionDelegationTerminalError);
  }
  const raceRows = await client!.db.select()
    .from(schema!.execution_delegation_grants)
    .where(eq(
      schema!.execution_delegation_grants.delegation_instance_id,
      first.grant.delegation_instance_id,
    ));
  assert.equal(raceRows.filter((row) => !row.retired_at).length, 1);
  assert.ok(raceRows.find((row) => !row.retired_at)!.revoked_at);
});

test("source grant rotation preserves scope while delegation revocation and expiry stay terminal", databaseOptions, async () => {
  const seeded = await seed();
  const firstInput = admissionInput(seeded, { client_request_id: "initial" });
  const first = await db!.admitExecutionDelegationGrantRevision(firstInput);
  await db!.revokeSupervisorHostGrant({
    grant_id: seeded.grant.grant_id,
    owner_account_id: seeded.ownerId,
  });

  const replay = await db!.admitExecutionDelegationGrantRevision(firstInput);
  assert.equal(replay.status, "replayed");
  await assert.rejects(
    db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
      client_request_id: "revoked_source",
      delegation_instance_id: first.grant.delegation_instance_id,
      expected_revision: 1,
    })),
    db!.ExecutionDelegationAuthorityError,
  );

  const replacementGrant = (await db!.createSupervisorHostGrant({
    owner_account_id: seeded.ownerId,
    host_id: seeded.grant.host_id,
    installation_id: seeded.grant.installation_id,
    allowed_room_ids: [seeded.room.id],
    allowed_agent_keys: [seeded.agent.canonical_key],
    expires_at: new Date(seeded.now.getTime() + 60 * 60_000).toISOString(),
  })).grant;
  const revised = await db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
    supervisor_grant_id: replacementGrant.grant_id,
    client_request_id: "replacement_source",
    delegation_instance_id: first.grant.delegation_instance_id,
    expected_revision: 1,
  }));
  assert.equal(revised.grant.revision, 2);
  assert.equal(revised.grant.delegation_instance_id, first.grant.delegation_instance_id);
  assert.equal(revised.grant.admission_supervisor_grant_id, replacementGrant.grant_id);

  const revoked = await db!.revokeExecutionDelegationGrant({
    owner_account_id: seeded.ownerId,
    delegation_instance_id: first.grant.delegation_instance_id,
    now: new Date(seeded.now.getTime() + 1_000),
  });
  assert.ok(revoked?.revoked_at);
  assert.equal((await db!.revokeExecutionDelegationGrant({
    owner_account_id: seeded.ownerId,
    delegation_instance_id: first.grant.delegation_instance_id,
  }))?.revoked_at, revoked!.revoked_at);
  await assert.rejects(
    db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
      supervisor_grant_id: replacementGrant.grant_id,
      client_request_id: "after_revoke",
      delegation_instance_id: first.grant.delegation_instance_id,
      expected_revision: 2,
    })),
    db!.ExecutionDelegationTerminalError,
  );
  await assert.rejects(
    client!.pool.query(
      "UPDATE execution_delegation_grants SET revoked_at = NULL WHERE delegation_instance_id = $1 AND revision = 2",
      [first.grant.delegation_instance_id],
    ),
    /revoked execution delegation revisions are terminal/,
  );

  const freshAfterRevoke = await db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
    supervisor_grant_id: replacementGrant.grant_id,
    client_request_id: "fresh_after_revoke",
  }));
  assert.equal(freshAfterRevoke.grant.revision, 1);
  assert.notEqual(freshAfterRevoke.grant.delegation_instance_id, first.grant.delegation_instance_id);

  const expiring = await seed();
  const expiresAt = new Date(expiring.now.getTime() + 1_000);
  const expiringGrant = await db!.admitExecutionDelegationGrantRevision(admissionInput(expiring, {
    client_request_id: "expiring_delegation",
    expires_at: expiresAt.toISOString(),
  }));
  await assert.rejects(
    db!.admitExecutionDelegationGrantRevision(admissionInput(expiring, {
      client_request_id: "after_expiry",
      delegation_instance_id: expiringGrant.grant.delegation_instance_id,
      expected_revision: 1,
      now: new Date(expiresAt.getTime() + 1),
    })),
    db!.ExecutionDelegationTerminalError,
  );
  const freshAfterExpiry = await db!.admitExecutionDelegationGrantRevision(admissionInput(expiring, {
    client_request_id: "fresh_after_expiry",
    now: new Date(expiresAt.getTime() + 1),
  }));
  assert.equal(freshAfterExpiry.grant.revision, 1);
  assert.notEqual(
    freshAfterExpiry.grant.delegation_instance_id,
    expiringGrant.grant.delegation_instance_id,
  );
  const [expiredRevision] = await client!.db.select()
    .from(schema!.execution_delegation_grants)
    .where(eq(
      schema!.execution_delegation_grants.delegation_instance_id,
      expiringGrant.grant.delegation_instance_id,
    ));
  assert.ok(expiredRevision!.expired_at);
  assert.ok(await db!.revokeExecutionDelegationGrant({
    owner_account_id: expiring.ownerId,
    delegation_instance_id: expiringGrant.grant.delegation_instance_id,
    now: new Date(expiresAt.getTime() + 1),
  }));
});

test("host inventory is paginated and includes revoked and expired latest rows", databaseOptions, async () => {
  const seeded = await seed();
  const ids = Array.from({ length: 101 }, (_, index) =>
    `execution_delegation_inventory_${String(index).padStart(3, "0")}`
  );
  const createdAt = seeded.now.toISOString();
  const expiresAt = new Date(seeded.now.getTime() + 60_000).toISOString();
  const terminalAt = new Date(seeded.now.getTime() + 120_000).toISOString();
  await client!.db.insert(schema!.execution_delegation_grants).values(ids.map((id, index) => ({
    delegation_instance_id: id,
    revision: 1,
    owner_account_id: seeded.ownerId,
    admission_supervisor_grant_id: seeded.grant.grant_id,
    host_id: seeded.grant.host_id,
    installation_id: seeded.grant.installation_id,
    scope_key: "owner",
    room_id: seeded.room.id,
    agent_key: seeded.agent.canonical_key,
    approver_account_id: seeded.approverId,
    category: "file_change",
    risk_ceiling: "low",
    scope_sha256: "a".repeat(64),
    client_request_id: `inventory_${index}`,
    request_fingerprint: index.toString(16).padStart(64, "0"),
    created_at: createdAt,
    expires_at: expiresAt,
    expired_at: index % 2 === 0 ? terminalAt : null,
    retired_at: null,
    retired_by_revision: null,
    revoked_at: index % 2 === 1 ? terminalAt : null,
  })));

  const first = await db!.listExecutionDelegationIdsForHost({
    owner_account_id: seeded.ownerId,
    host_id: seeded.grant.host_id,
    installation_id: seeded.grant.installation_id,
    room_id: seeded.room.id,
    agent_key: seeded.agent.canonical_key,
  });
  assert.equal(first.delegation_instance_ids.length, 100);
  assert.equal(first.next_cursor, ids[99]);
  const second = await db!.listExecutionDelegationIdsForHost({
    owner_account_id: seeded.ownerId,
    host_id: seeded.grant.host_id,
    installation_id: seeded.grant.installation_id,
    room_id: seeded.room.id,
    agent_key: seeded.agent.canonical_key,
    after: first.next_cursor,
  });
  assert.deepEqual([...first.delegation_instance_ids, ...second.delegation_instance_ids], ids);
  assert.equal(second.next_cursor, null);
});

function delegationRouteDeps(sessionParticipants?: Set<string>, freshChecks?: boolean[]) {
  return {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async (roomId: string) => db!.getProjectById(roomId),
    requireParticipant: async (
      req: AuthenticatedRequest,
      res: Response,
      _project: { id: string },
      options?: { freshCollaboratorCheck?: boolean; throwOnIndeterminate?: boolean },
    ) => {
      if (req.authKind === "session") freshChecks?.push(options?.freshCollaboratorCheck === true);
      if (!sessionParticipants || req.authKind !== "session"
        || sessionParticipants.has(req.sessionAccount?.account_id)) return true;
      res.status(403).json({ error: "Room membership is required." });
      return false;
    },
  };
}

async function listen(app: express.Express) {
  return new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function close(server: ReturnType<express.Express["listen"]>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function serverUrl(server: ReturnType<express.Express["listen"]>): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("HTTP routes bind authorship to auth and expose exact owner, approver, and current-host views", databaseOptions, async () => {
  const seeded = await seed();
  const otherId = `delegation_other_${++ordinal}`;
  await client!.db.insert(schema!.accounts).values({
    id: otherId,
    provider: "github",
    provider_user_id: otherId,
    login: otherId,
    display_name: otherId,
    avatar_url: null,
    created_at: seeded.now.toISOString(),
    updated_at: seeded.now.toISOString(),
  });
  await Promise.all([
    db!.createOwnerToken({ accountId: seeded.ownerId, githubUserId: seeded.ownerId, token: "delegation_owner_token" }),
    db!.createOwnerToken({ accountId: seeded.approverId, githubUserId: seeded.approverId, token: "delegation_approver_token" }),
    db!.createOwnerToken({ accountId: otherId, githubUserId: otherId, token: "delegation_other_token" }),
    db!.createSession(
      seeded.approverId,
      "delegation_approver_session",
      new Date(seeded.now.getTime() + 60 * 60_000).toISOString(),
    ),
  ]);

  const sessionParticipants = new Set([seeded.approverId]);
  const freshChecks: boolean[] = [];
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerExecutionDelegationRoutes(app, delegationRouteDeps(sessionParticipants, freshChecks));
  const server = await listen(app);
  try {
    const baseUrl = serverUrl(server);
    const ownerHeaders = { authorization: "Bearer delegation_owner_token", "content-type": "application/json" };
    const approverOwnerHeaders = { authorization: "Bearer delegation_approver_token", "content-type": "application/json" };
    const approverHeaders = {
      cookie: "letagents_session=delegation_approver_session",
      "content-type": "application/json",
    };
    const otherHeaders = { authorization: "Bearer delegation_other_token", "content-type": "application/json" };
    const createBody = {
      supervisor_grant_id: seeded.grant.grant_id,
      room_id: seeded.room.id,
      agent_key: seeded.agent.canonical_key,
      approver_account_id: seeded.approverId,
      category: "file_change",
      risk_ceiling: "low",
      expires_at: new Date(seeded.now.getTime() + 30 * 60_000).toISOString(),
      client_request_id: "route_create",
    };
    const create = (headers: Record<string, string>, body: unknown) => fetch(`${baseUrl}/execution-delegations`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    assert.equal((await create(ownerHeaders, { ...createBody, owner_account_id: otherId })).status, 400);
    assert.equal((await create(approverOwnerHeaders, createBody)).status, 403,
      "a designated account cannot author an owner mutation by naming the owner grant");
    const createdInvalidation = once(executionDelegationEvents, "execution_delegation:invalidated");
    const createdResponse = await create(ownerHeaders, createBody);
    assert.equal(createdResponse.status, 201);
    assert.deepEqual(await createdInvalidation, [{ projectId: seeded.room.id }]);
    const created = await createdResponse.json() as { delegation: Record<string, unknown> };
    const instanceId = String(created.delegation.delegation_instance_id);
    assert.equal(created.delegation.owner_account_id, seeded.ownerId);
    assert.equal(created.delegation.approver_account_id, seeded.approverId);
    assert.equal(created.delegation.status, "active");
    assert.equal("request_fingerprint" in created.delegation, false);
    assert.equal("admission_supervisor_grant_id" in created.delegation, false);
    assert.equal("scope_sha256" in created.delegation, false,
      "the account projection does not expose host admission evidence");

    const accountUrl = `${baseUrl}/execution-delegations/${instanceId}`;
    for (const headers of [ownerHeaders, approverHeaders]) {
      const response = await fetch(accountUrl, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json() as any;
      assert.equal(body.delegation.delegation_instance_id, instanceId);
      assert.equal("scope_sha256" in body.delegation, false);
    }
    assert.deepEqual(freshChecks, [true], "approver visibility reaches the fresh Git Room membership check");
    assert.equal((await fetch(accountUrl, { headers: approverOwnerHeaders })).status, 401,
      "approver visibility requires a current human browser session");
    sessionParticipants.delete(seeded.approverId);
    assert.equal((await fetch(accountUrl, { headers: approverHeaders })).status, 403,
      "approver visibility is revalidated against current room membership");
    sessionParticipants.add(seeded.approverId);
    const absentUrl = `${baseUrl}/execution-delegations/execution_delegation_missing`;
    const foreign = await fetch(accountUrl, { headers: otherHeaders });
    const absent = await fetch(absentUrl, { headers: otherHeaders });
    assert.equal(foreign.status, 404);
    assert.equal(absent.status, 404);
    assert.deepEqual(await foreign.json(), await absent.json());

    const reviseBody = {
      ...createBody,
      client_request_id: "route_revise",
      expected_revision: 1,
      expires_at: new Date(seeded.now.getTime() + 35 * 60_000).toISOString(),
    };
    const reviseUrl = `${accountUrl}/revisions`;
    assert.equal((await fetch(reviseUrl, {
      method: "POST", headers: approverHeaders, body: JSON.stringify(reviseBody),
    })).status, 404);
    const revisedInvalidation = once(executionDelegationEvents, "execution_delegation:invalidated");
    const revisedResponse = await fetch(reviseUrl, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify(reviseBody),
    });
    assert.equal(revisedResponse.status, 200);
    assert.deepEqual(await revisedInvalidation, [{ projectId: seeded.room.id }]);
    assert.equal((await revisedResponse.json() as any).delegation.revision, 2);
    const exactServerGrant = await db!.getExecutionDelegationGrantForOwner({
      owner_account_id: seeded.ownerId,
      delegation_instance_id: instanceId,
    });
    assert.ok(exactServerGrant);

    const supervisorHeaders = {
      authorization: `Bearer ${seeded.grantToken}`,
      "x-letagents-supervisor-generation": String(seeded.grant.current_generation),
    };
    const hostUrl = `${baseUrl}/supervisor-host-grants/${seeded.grant.grant_id}/execution-delegations/${instanceId}`;
    const hostResponse = await fetch(hostUrl, { headers: supervisorHeaders });
    assert.equal(hostResponse.status, 200);
    const hostBody = await hostResponse.json() as any;
    assert.equal(hostBody.delegation.revision, 2);
    assert.equal(hostBody.delegation.scope_sha256, exactServerGrant.scope_sha256);
    assert.equal("admission_supervisor_grant_id" in hostBody.delegation, false);

    const inventoryUrl = new URL(
      `${baseUrl}/supervisor-host-grants/${seeded.grant.grant_id}/execution-delegations`,
    );
    inventoryUrl.searchParams.set("room_id", seeded.room.id);
    inventoryUrl.searchParams.set("agent_key", seeded.agent.canonical_key);
    const inventoryResponse = await fetch(inventoryUrl, { headers: supervisorHeaders });
    assert.equal(inventoryResponse.status, 200);
    assert.equal(inventoryResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await inventoryResponse.json(), {
      delegation_instance_ids: [instanceId],
      next_cursor: null,
    }, "the host inventory returns IDs only for its exact room and agent scope");
    inventoryUrl.searchParams.set("extra", "rejected");
    assert.equal((await fetch(inventoryUrl, { headers: supervisorHeaders })).status, 400);
    inventoryUrl.searchParams.delete("extra");

    const foreignHost = await db!.createSupervisorHostGrant({
      owner_account_id: seeded.ownerId,
      host_id: `foreign_host_${++ordinal}`,
      installation_id: `foreign_installation_${ordinal}`,
      allowed_room_ids: [seeded.room.id],
      allowed_agent_keys: [seeded.agent.canonical_key],
      expires_at: new Date(seeded.now.getTime() + 60 * 60_000).toISOString(),
    });
    const foreignHostUrl = `${baseUrl}/supervisor-host-grants/${foreignHost.grant.grant_id}/execution-delegations/${instanceId}`;
    assert.equal((await fetch(foreignHostUrl, {
      headers: {
        authorization: `Bearer ${foreignHost.token}`,
        "x-letagents-supervisor-generation": String(foreignHost.grant.current_generation),
      },
    })).status, 404);

    const rentalHostId = `delegation_rental_host_${++ordinal}`;
    const rentalListingId = `delegation_rental_listing_${ordinal}`;
    const rentalSessionId = `delegation_rental_session_${ordinal}`;
    await client!.db.insert(schema!.rental_provider_hosts).values({
      id: rentalHostId,
      provider_account_id: seeded.ownerId,
      host_id: seeded.grant.host_id,
      installation_id: seeded.grant.installation_id,
      enabled: true,
      last_heartbeat_at: seeded.now,
    });
    await client!.db.insert(schema!.rental_listings).values({
      id: rentalListingId,
      provider_account_id: seeded.ownerId,
      provider_host_id: rentalHostId,
      display_name: "Delegation rental",
      status: "active",
      ide_kind: "codex",
    });
    await client!.db.insert(schema!.rental_sessions).values({
      id: rentalSessionId,
      listing_id: rentalListingId,
      renter_account_id: seeded.approverId,
      provider_account_id: seeded.ownerId,
      room_id: seeded.room.id,
      task_title: "Delegation rental test",
      task_prompt: "Exercise rental grant concealment.",
      provider_host_id: rentalHostId,
      status: "active",
      launch_state: "active",
    });
    const rentalHost = await db!.createSupervisorHostGrant({
      owner_account_id: seeded.ownerId,
      host_id: seeded.grant.host_id,
      installation_id: seeded.grant.installation_id,
      scope_key: `rental:${rentalSessionId}`,
      rental_session_id: rentalSessionId,
      allowed_room_ids: [seeded.room.id],
      allowed_agent_keys: [seeded.agent.canonical_key],
      expires_at: new Date(seeded.now.getTime() + 60 * 60_000).toISOString(),
    });
    const rentalHostUrl = `${baseUrl}/supervisor-host-grants/${rentalHost.grant.grant_id}/execution-delegations/${instanceId}`;
    const rentalResponse = await fetch(rentalHostUrl, {
      headers: {
        authorization: `Bearer ${rentalHost.token}`,
        "x-letagents-supervisor-generation": String(rentalHost.grant.current_generation),
      },
    });
    assert.equal(rentalResponse.status, 404);
    assert.deepEqual(await rentalResponse.json(), await (await fetch(absentUrl, { headers: otherHeaders })).json(),
      "rental-lineage grants receive the same concealment response as a missing delegation");

    const foreignRevoke = await fetch(accountUrl, { method: "DELETE", headers: otherHeaders });
    const missingRevoke = await fetch(absentUrl, { method: "DELETE", headers: otherHeaders });
    assert.equal(foreignRevoke.status, 404);
    assert.deepEqual(await foreignRevoke.json(), await missingRevoke.json());
    const revokedInvalidation = once(executionDelegationEvents, "execution_delegation:invalidated");
    const revokedResponse = await fetch(accountUrl, { method: "DELETE", headers: ownerHeaders });
    assert.equal(revokedResponse.status, 200);
    assert.deepEqual(await revokedInvalidation, [{ projectId: seeded.room.id }]);
    assert.equal((await revokedResponse.json() as any).delegation.status, "revoked");
    assert.equal((await (await fetch(accountUrl, { headers: approverHeaders })).json() as any).delegation.status, "revoked",
      "the designated approver keeps a transparency view after authority ends");
    assert.equal((await (await fetch(hostUrl, { headers: {
      authorization: `Bearer ${seeded.grantToken}`,
      "x-letagents-supervisor-generation": String(seeded.grant.current_generation),
    } })).json() as any)
      .delegation.status, "revoked", "the exact host can reconcile terminal authority");
    assert.deepEqual(await (await fetch(inventoryUrl, { headers: supervisorHeaders })).json(), {
      delegation_instance_ids: [instanceId],
      next_cursor: null,
    }, "revoked latest rows remain discoverable for terminal reconciliation");

    await db!.revokeSupervisorHostGrant({
      grant_id: seeded.grant.grant_id,
      owner_account_id: seeded.ownerId,
    });
    const narrowerRoom = await db!.createProjectWithName(`narrower-room-${++ordinal}`);
    const narrowerAgent = await db!.registerAgentIdentity({
      owner_account_id: seeded.ownerId,
      owner_login: seeded.ownerId,
      owner_label: seeded.ownerId,
      name: `narrower-agent-${ordinal}`,
    });
    const narrowerHost = await db!.createSupervisorHostGrant({
      owner_account_id: seeded.ownerId,
      host_id: seeded.grant.host_id,
      installation_id: seeded.grant.installation_id,
      allowed_room_ids: [narrowerRoom.id],
      allowed_agent_keys: [narrowerAgent.canonical_key],
      expires_at: new Date(seeded.now.getTime() + 60 * 60_000).toISOString(),
    });
    const narrowerHostUrl = `${baseUrl}/supervisor-host-grants/${narrowerHost.grant.grant_id}/execution-delegations/${instanceId}`;
    assert.equal((await fetch(narrowerHostUrl, {
      headers: {
        authorization: `Bearer ${narrowerHost.token}`,
        "x-letagents-supervisor-generation": String(narrowerHost.grant.current_generation),
      },
    })).status, 404, "a same-host replacement cannot widen its narrower room and agent scope");
  } finally {
    await close(server);
  }
});

test("feature-off stops admission while preserving transparency, revocation, and host reconciliation", databaseOptions, async () => {
  const seeded = await seed();
  const existing = await db!.admitExecutionDelegationGrantRevision(admissionInput(seeded, {
    client_request_id: "feature_off_revoke",
  }));
  await db!.createOwnerToken({ accountId: seeded.ownerId, githubUserId: seeded.ownerId, token: "delegation_gate_owner" });
  const prior = process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED;
  process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED = "false";
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerExecutionDelegationRoutes(app, delegationRouteDeps());
  const server = await listen(app);
  try {
    const baseUrl = serverUrl(server);
    const ownerHeaders = { authorization: "Bearer delegation_gate_owner" };
    const gatedAccountRequests = [
      { method: "POST", path: "/execution-delegations" },
      { method: "POST", path: `/execution-delegations/${existing.grant.delegation_instance_id}/revisions` },
    ] as const;
    for (const request of gatedAccountRequests) {
      const options = { method: request.method, headers: ownerHeaders };
      const hidden = await fetch(baseUrl + request.path, options);
      const unknown = await fetch(baseUrl + "/route-that-does-not-exist", options);
      assert.equal(hidden.status, unknown.status);
      assert.equal(hidden.headers.get("content-type"), unknown.headers.get("content-type"));
      assert.match(await hidden.text(), /^<!DOCTYPE html>/);
      assert.match(await unknown.text(), /^<!DOCTYPE html>/);
    }
    const accountTarget = `/execution-delegations/${existing.grant.delegation_instance_id}`;
    const visibleAccount = await fetch(baseUrl + accountTarget, { headers: ownerHeaders });
    assert.equal(visibleAccount.status, 200, "issued authority remains visible after admission is disabled");
    assert.equal((await visibleAccount.json() as any).delegation.status, "active");

    const supervisorHeaders = {
      authorization: `Bearer ${seeded.grantToken}`,
      "x-letagents-supervisor-generation": String(seeded.grant.current_generation),
    };
    const hostTarget = `/supervisor-host-grants/${seeded.grant.grant_id}/execution-delegations/${existing.grant.delegation_instance_id}`;
    assert.equal((await fetch(baseUrl + hostTarget, { headers: supervisorHeaders })).status, 200);
    const inventoryTarget = new URL(
      `${baseUrl}/supervisor-host-grants/${seeded.grant.grant_id}/execution-delegations`,
    );
    inventoryTarget.searchParams.set("room_id", seeded.room.id);
    inventoryTarget.searchParams.set("agent_key", seeded.agent.canonical_key);
    assert.deepEqual(await (await fetch(inventoryTarget, { headers: supervisorHeaders })).json(), {
      delegation_instance_ids: [existing.grant.delegation_instance_id],
      next_cursor: null,
    });

    const revoked = await fetch(
      baseUrl + accountTarget,
      { method: "DELETE", headers: ownerHeaders },
    );
    assert.equal(revoked.status, 200, "feature-off keeps the owner kill switch available");
    assert.equal((await revoked.json() as any).delegation.status, "revoked");
    assert.equal((await (await fetch(baseUrl + hostTarget, { headers: supervisorHeaders })).json() as any)
      .delegation.status, "revoked", "feature-off revocation remains host-reconcilable");

    const missingHostTarget = `/supervisor-host-grants/${seeded.grant.grant_id}/execution-delegations/execution_delegation_hidden`;
    const hiddenHost = await fetch(baseUrl + missingHostTarget, { headers: supervisorHeaders });
    const unknownHost = await fetch(baseUrl + "/supervisor-route-that-does-not-exist", { headers: supervisorHeaders });
    assert.equal(hiddenHost.status, 404);
    assert.equal(unknownHost.status, 403);

    for (const request of gatedAccountRequests) {
      const hiddenOptions = await fetch(baseUrl + request.path, { method: "OPTIONS", headers: ownerHeaders });
      const unknownOptions = await fetch(baseUrl + "/route-that-does-not-exist", { method: "OPTIONS", headers: ownerHeaders });
      assert.equal(hiddenOptions.status, 204);
      assert.equal(hiddenOptions.status, unknownOptions.status);
      assert.equal(await hiddenOptions.text(), await unknownOptions.text());
    }
  } finally {
    await close(server);
    if (prior === undefined) delete process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED;
    else process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED = prior;
  }
});
