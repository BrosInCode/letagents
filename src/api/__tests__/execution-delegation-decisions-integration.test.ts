import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import express, { type Response } from "express";

import {
  EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS,
  parseExecutionDelegationDecisionIntent,
} from "../../../shared/execution-delegation-decision.mjs";
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
const { registerExecutionDelegationDecisionRoutes } = await import("../routes/execution-delegation-decisions.js");
const { agentApprovalEvents, executionDelegationEvents } = await import("../server/events.js");

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

async function seed(options: { delegationTtlMs?: number } = {}) {
  const n = ++ordinal;
  const now = new Date();
  const ownerId = `decision_owner_${n}`;
  const approverId = `decision_approver_${n}`;
  const otherId = `decision_other_${n}`;
  for (const id of [ownerId, approverId, otherId]) {
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
  const room = await db!.createProjectWithName(`decision-room-${n}`);
  const agent = await db!.registerAgentIdentity({
    owner_account_id: ownerId,
    owner_login: ownerId,
    owner_label: ownerId,
    name: `decision-agent-${n}`,
  });
  const host = await db!.createSupervisorHostGrant({
    owner_account_id: ownerId,
    host_id: `decision_host_${n}`,
    installation_id: `decision_installation_${n}`,
    allowed_room_ids: [room.id],
    allowed_agent_keys: [agent.canonical_key],
    expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
  });
  await Promise.all([
    db!.createSession(approverId, `decision_approver_session_${n}`, new Date(now.getTime() + 60 * 60_000).toISOString()),
    db!.createSession(ownerId, `decision_owner_session_${n}`, new Date(now.getTime() + 60 * 60_000).toISOString()),
    db!.createSession(otherId, `decision_other_session_${n}`, new Date(now.getTime() + 60 * 60_000).toISOString()),
    db!.createOwnerToken({ accountId: approverId, githubUserId: approverId, token: `decision_approver_token_${n}` }),
  ]);
  const delegationNow = new Date();
  const delegation = await db!.admitExecutionDelegationGrantRevision({
    owner_account_id: ownerId,
    supervisor_grant_id: host.grant.grant_id,
    room_id: room.id,
    agent_key: agent.canonical_key,
    approver_account_id: approverId,
    category: "file_change",
    risk_ceiling: "low",
    expires_at: new Date(delegationNow.getTime() + (options.delegationTtlMs ?? 30 * 60_000)).toISOString(),
    client_request_id: `delegation_${n}`,
    expected_revision: 0,
    now: delegationNow,
  });
  return { n, now, ownerId, approverId, otherId, room, agent, host, delegation: delegation.grant };
}

function decisionInput(seeded: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
  return {
    actor_account_id: seeded.approverId,
    delegation_instance_id: seeded.delegation.delegation_instance_id,
    expected_revision: seeded.delegation.revision,
    request_id: `approval_request_${seeded.n}`,
    request_version: 1,
    request_sha256: "a".repeat(64),
    projection_sha256: "b".repeat(64),
    decision: "allow_once" as const,
    client_request_id: `decision_request_${++ordinal}`,
    ...overrides,
  };
}

test("decision admission is immutable, idempotent, and single-winner per exact approval", databaseOptions, async () => {
  const seeded = await seed();
  const input = decisionInput(seeded, { client_request_id: "same_decision_request" });
  const admitted = await Promise.all([
    db!.admitExecutionDelegationDecision(input),
    db!.admitExecutionDelegationDecision(input),
  ]);
  assert.deepEqual(admitted.map((result) => result.status).sort(), ["created", "replayed"]);
  assert.equal(admitted[0]!.decision.decision_id, admitted[1]!.decision.decision_id);
  assert.equal(admitted[0]!.decision.actor_account_id, seeded.approverId);

  await assert.rejects(
    db!.admitExecutionDelegationDecision({ ...input, decision: "deny" }),
    db!.ExecutionDelegationDecisionIdempotencyConflictError,
  );

  const competing = await Promise.allSettled([
    db!.admitExecutionDelegationDecision(decisionInput(seeded, {
      request_id: "competing_request",
      client_request_id: "competing_allow",
    })),
    db!.admitExecutionDelegationDecision(decisionInput(seeded, {
      request_id: "competing_request",
      client_request_id: "competing_deny",
      decision: "deny",
    })),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = competing.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.reason instanceof db!.ExecutionDelegationDecisionConflictError);
  assert.equal((await client!.db.select().from(schema!.execution_delegation_decisions)).length, 2);

  const revisionNow = new Date();
  const revised = await db!.admitExecutionDelegationGrantRevision({
    owner_account_id: seeded.ownerId,
    supervisor_grant_id: seeded.host.grant.grant_id,
    room_id: seeded.room.id,
    agent_key: seeded.agent.canonical_key,
    approver_account_id: seeded.approverId,
    category: "file_change",
    risk_ceiling: "low",
    expires_at: new Date(revisionNow.getTime() + 30 * 60_000).toISOString(),
    client_request_id: "decision_test_revision",
    delegation_instance_id: seeded.delegation.delegation_instance_id,
    expected_revision: seeded.delegation.revision,
    now: revisionNow,
  });
  const revisedDecision = await db!.admitExecutionDelegationDecision(decisionInput(seeded, {
    expected_revision: revised.grant.revision,
    request_id: input.request_id,
    request_version: input.request_version,
    decision: "deny",
    client_request_id: "decision_after_revision",
  }));
  assert.equal(revisedDecision.status, "created",
    "a stale recorded intent cannot strand the still-pending approval after authority renews");
  await assert.rejects(
    db!.admitExecutionDelegationDecision(decisionInput(seeded, {
      expected_revision: revised.grant.revision,
      request_id: input.request_id,
      request_version: input.request_version,
      client_request_id: "competing_decision_after_revision",
    })),
    db!.ExecutionDelegationDecisionConflictError,
  );
  const replayAfterRevision = await db!.admitExecutionDelegationDecision(input);
  assert.equal(replayAfterRevision.status, "replayed");
  assert.equal(replayAfterRevision.decision.decision_id, admitted[0]!.decision.decision_id);
  assert.equal((await client!.db.select().from(schema!.execution_delegation_decisions)).length, 3);

  await assert.rejects(
    client!.pool.query("UPDATE execution_delegation_decisions SET decision='deny' WHERE decision_id=$1", [
      admitted[0]!.decision.decision_id,
    ]),
    /immutable/,
  );
});

test("decision admission repeats exact delegation authority inside the recording transaction", databaseOptions, async () => {
  const seeded = await seed();
  await assert.rejects(
    db!.admitExecutionDelegationDecision(decisionInput(seeded, { actor_account_id: seeded.ownerId })),
    db!.ExecutionDelegationDecisionAuthorityError,
  );
  await assert.rejects(
    db!.admitExecutionDelegationDecision(decisionInput(seeded, { expected_revision: 2 })),
    db!.ExecutionDelegationDecisionRevisionConflictError,
  );
  await assert.rejects(
    db!.admitExecutionDelegationDecision(decisionInput(seeded, { request_version: 2_147_483_648 })),
    db!.ExecutionDelegationDecisionAuthorityError,
  );

  await db!.revokeExecutionDelegationGrant({
    owner_account_id: seeded.ownerId,
    delegation_instance_id: seeded.delegation.delegation_instance_id,
  });
  await assert.rejects(
    db!.admitExecutionDelegationDecision(decisionInput(seeded)),
    db!.ExecutionDelegationDecisionTerminalError,
  );
  assert.equal((await client!.db.select().from(schema!.execution_delegation_decisions)).length, 0);
});

test("decision admission rechecks wall-clock expiry after waiting for its authority lock", databaseOptions, async () => {
  const seeded = await seed({ delegationTtlMs: 2_000 });
  const holder = await client!.pool.connect();
  let released = false;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `execution_delegation_instance:${seeded.delegation.delegation_instance_id}`,
    ]);
    const pending = db!.admitExecutionDelegationDecision(decisionInput(seeded, {
      client_request_id: "expires_while_waiting",
    }));
    void pending.catch(() => undefined);

    let observedWaitingLock = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await client!.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
      );
      if ((result.rows[0]?.count ?? 0) > 0) {
        observedWaitingLock = true;
        break;
      }
      await delay(10);
    }
    assert.equal(observedWaitingLock, true, "the decision reached the contended delegation lock");

    const waitMs = Date.parse(seeded.delegation.expires_at) - Date.now() + 25;
    if (waitMs > 0) await delay(waitMs);
    await holder.query("COMMIT");
    released = true;

    await assert.rejects(pending, db!.ExecutionDelegationDecisionTerminalError);
    assert.equal((await client!.db.select().from(schema!.execution_delegation_decisions)).length, 0);
  } finally {
    if (!released) await holder.query("ROLLBACK");
    holder.release();
  }
});

test("host decision inventory is deterministic and paginated", databaseOptions, async () => {
  const seeded = await seed();
  await client!.db.insert(schema!.execution_delegation_decisions).values(
    Array.from({ length: 101 }, (_, index) => ({
      decision_id: `paged_decision_${String(index).padStart(3, "0")}`,
      delegation_instance_id: seeded.delegation.delegation_instance_id,
      delegation_revision: seeded.delegation.revision,
      actor_account_id: seeded.approverId,
      request_id: `paged_request_${index}`,
      request_version: 1,
      request_sha256: "a".repeat(64),
      projection_sha256: "b".repeat(64),
      decision: "deny",
      client_request_id: `paged_client_request_${index}`,
      request_fingerprint: index.toString(16).padStart(64, "0"),
      decided_at: seeded.now.toISOString(),
    })),
  );

  const scope = {
    owner_account_id: seeded.ownerId,
    host_id: seeded.host.grant.host_id,
    installation_id: seeded.host.grant.installation_id,
    room_id: seeded.room.id,
    agent_key: seeded.agent.canonical_key,
  };
  const first = await db!.listExecutionDelegationDecisionIdsForHost(scope);
  assert.equal(first.decision_ids.length, 100);
  assert.equal(first.next_cursor, "paged_decision_099");
  const second = await db!.listExecutionDelegationDecisionIdsForHost({ ...scope, after: first.next_cursor });
  assert.deepEqual(second, { decision_ids: ["paged_decision_100"], next_cursor: null });
});

test("host decision inventory contains only choices that could still apply", databaseOptions, async () => {
  const seeded = await seed();
  const now = new Date("2026-09-03T12:00:00.000Z");
  const day = EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS;
  await client!.pool.query(`
    INSERT INTO execution_delegation_decisions
      (decision_id, delegation_instance_id, delegation_revision, actor_account_id, request_id,
       request_version, request_sha256, projection_sha256, decision, client_request_id,
       request_fingerprint, decided_at)
    SELECT 'historical_decision_' || lpad(ordinal::text, 5, '0'), $1, $2, $3,
      'historical_request_' || ordinal, 1, repeat('a', 64), repeat('b', 64), 'deny',
      'historical_client_' || ordinal, repeat('c', 64), $4
    FROM generate_series(0, 10000) AS ordinal
  `, [seeded.delegation.delegation_instance_id, seeded.delegation.revision, seeded.approverId,
    new Date(now.getTime() - day).toISOString()]);
  await client!.db.insert(schema!.execution_delegation_decisions).values({
    decision_id: "applicable_decision", delegation_instance_id: seeded.delegation.delegation_instance_id,
    delegation_revision: seeded.delegation.revision, actor_account_id: seeded.approverId,
    request_id: "applicable_request", request_version: 1, request_sha256: "a".repeat(64),
    projection_sha256: "b".repeat(64), decision: "deny", client_request_id: "applicable_client",
    request_fingerprint: "d".repeat(64), decided_at: new Date(now.getTime() - day + 1).toISOString(),
  });
  const scope = { owner_account_id: seeded.ownerId, host_id: seeded.host.grant.host_id,
    installation_id: seeded.host.grant.installation_id, room_id: seeded.room.id,
    agent_key: seeded.agent.canonical_key, now };
  assert.deepEqual(await db!.listExecutionDelegationDecisionIdsForHost(scope), {
    decision_ids: ["applicable_decision"], next_cursor: null,
  });
  assert.ok(await db!.getExecutionDelegationDecisionForHost({
    owner_account_id: seeded.ownerId, host_id: seeded.host.grant.host_id,
    installation_id: seeded.host.grant.installation_id, decision_id: "historical_decision_00000",
  }), "the applicability window narrows inventory without rewriting immutable history");
});

type MembershipMode = "allow" | "deny" | "indeterminate";

function routeDeps(mode: { value: MembershipMode }, onCheck?: () => Promise<void> | void) {
  return {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId,
    resolveRoomOrReply: async (roomId: string) => db!.getProjectById(roomId),
    requireParticipant: async (
      _req: AuthenticatedRequest,
      res: Response,
      _project: { id: string },
      options?: { freshCollaboratorCheck?: boolean; throwOnIndeterminate?: boolean },
    ) => {
      assert.equal(options?.freshCollaboratorCheck, true);
      assert.equal(options?.throwOnIndeterminate, true);
      await onCheck?.();
      if (mode.value === "indeterminate") throw new Error("GitHub unavailable");
      if (mode.value === "deny") {
        res.status(403).json({ error: "Room membership is required." });
        return false;
      }
      return true;
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

function cookie(id: string) {
  return { cookie: `letagents_session=${id}`, "content-type": "application/json" };
}

function decisionBody(seeded: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
  const { actor_account_id: _actor, delegation_instance_id: _instance, ...body } = decisionInput(seeded, overrides);
  return body;
}

test("decision route binds authorship to a fresh session membership check and emits once", databaseOptions, async () => {
  const seeded = await seed();
  const mode = { value: "allow" as MembershipMode };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerExecutionDelegationDecisionRoutes(app, routeDeps(mode));
  const server = await listen(app);
  try {
    const baseUrl = serverUrl(server);
    const path = `/execution-delegations/${seeded.delegation.delegation_instance_id}/decisions`;
    const post = (headers: Record<string, string>, body: unknown) => fetch(baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const body = decisionBody(seeded, { client_request_id: "route_decision" });
    assert.equal((await post(cookie(`decision_approver_session_${seeded.n}`), {
      ...body,
      actor_account_id: seeded.approverId,
    })).status, 400, "the deciding principal is never accepted from the request body");
    assert.equal((await post({
      authorization: `Bearer decision_approver_token_${seeded.n}`,
      "content-type": "application/json",
    }, body)).status, 401, "owner tokens cannot author delegated decisions");
    assert.equal((await post(cookie(`decision_owner_session_${seeded.n}`), body)).status, 404);
    assert.equal((await post(cookie(`decision_other_session_${seeded.n}`), body)).status, 404);
    assert.equal((await post(cookie(`decision_approver_session_${seeded.n}`), {
      ...body,
      expected_revision: 2_147_483_648,
    })).status, 400);
    assert.equal((await post(cookie(`decision_approver_session_${seeded.n}`), {
      ...body,
      request_version: 2_147_483_648,
    })).status, 400);

    mode.value = "deny";
    assert.equal((await post(cookie(`decision_approver_session_${seeded.n}`), body)).status, 403);
    mode.value = "indeterminate";
    const unavailable = await post(cookie(`decision_approver_session_${seeded.n}`), body);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json() as any).retryable, true);

    mode.value = "allow";
    let invalidations = 0;
    let approvalInvalidations = 0;
    const listener = () => { invalidations += 1; };
    const approvalListener = () => { approvalInvalidations += 1; };
    executionDelegationEvents.on("execution_delegation:invalidated", listener);
    agentApprovalEvents.on("agent_approval:invalidated", approvalListener);
    try {
      const createdInvalidation = once(executionDelegationEvents, "execution_delegation:invalidated");
      const createdApprovalInvalidation = once(agentApprovalEvents, "agent_approval:invalidated");
      const created = await post(cookie(`decision_approver_session_${seeded.n}`), body);
      assert.equal(created.status, 201);
      const createdBody = await created.json() as any;
      assert.equal(createdBody.status, "created");
      assert.equal(createdBody.decision.actor_account_id, seeded.approverId);
      assert.equal("client_request_id" in createdBody.decision, false);
      assert.equal("request_fingerprint" in createdBody.decision, false);
      await createdInvalidation;
      await createdApprovalInvalidation;
      assert.equal(invalidations, 1);
      assert.equal(approvalInvalidations, 1);

      const replayInvalidation = once(executionDelegationEvents, "execution_delegation:invalidated");
      const replayApprovalInvalidation = once(agentApprovalEvents, "agent_approval:invalidated");
      const replay = await post(cookie(`decision_approver_session_${seeded.n}`), body);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as any).status, "replayed");
      await replayInvalidation;
      await replayApprovalInvalidation;
      assert.equal(invalidations, 2, "an idempotent replay repairs a lost delegation pointer");
      assert.equal(approvalInvalidations, 2, "an idempotent replay repairs a lost approval pointer");
    } finally {
      executionDelegationEvents.off("execution_delegation:invalidated", listener);
      agentApprovalEvents.off("agent_approval:invalidated", approvalListener);
    }
  } finally {
    await close(server);
  }
});

test("decision route loses a pre-read race to revocation and host reads stay exact", databaseOptions, async () => {
  const seeded = await seed();
  let releaseMembership!: () => void;
  let membershipReached!: () => void;
  const membershipStarted = new Promise<void>((resolve) => { membershipReached = resolve; });
  const membershipRelease = new Promise<void>((resolve) => { releaseMembership = resolve; });
  const mode = { value: "allow" as MembershipMode };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerExecutionDelegationDecisionRoutes(app, routeDeps(mode, async () => {
    membershipReached();
    await membershipRelease;
  }));
  const server = await listen(app);
  try {
    const baseUrl = serverUrl(server);
    const pending = fetch(`${baseUrl}/execution-delegations/${seeded.delegation.delegation_instance_id}/decisions`, {
      method: "POST",
      headers: cookie(`decision_approver_session_${seeded.n}`),
      body: JSON.stringify(decisionBody(seeded, { client_request_id: "revocation_race" })),
    });
    await membershipStarted;
    await db!.revokeExecutionDelegationGrant({
      owner_account_id: seeded.ownerId,
      delegation_instance_id: seeded.delegation.delegation_instance_id,
    });
    releaseMembership();
    assert.equal((await pending).status, 409,
      "the recording transaction repeats the terminal grant fence after the route pre-read");
    assert.equal((await client!.db.select().from(schema!.execution_delegation_decisions)).length, 0);
  } finally {
    releaseMembership?.();
    await close(server);
  }

  const active = await seed();
  const admitted = await db!.admitExecutionDelegationDecision(decisionInput(active, {
    client_request_id: "host_read",
  }));
  const readApp = express();
  registerHttpMiddleware(readApp, { resolveRequestAuth });
  registerExecutionDelegationDecisionRoutes(readApp, routeDeps({ value: "allow" }));
  const readServer = await listen(readApp);
  try {
    const baseUrl = serverUrl(readServer);
    const hostHeaders = {
      authorization: `Bearer ${active.host.token}`,
      "x-letagents-supervisor-generation": String(active.host.grant.current_generation),
    };
    const inventory = new URL(
      `${baseUrl}/supervisor-host-grants/${active.host.grant.grant_id}/execution-delegation-decisions`,
    );
    inventory.searchParams.set("room_id", active.room.id);
    inventory.searchParams.set("agent_key", active.agent.canonical_key);
    const inventoryResponse = await fetch(inventory, { headers: hostHeaders });
    assert.equal(inventoryResponse.status, 200);
    assert.deepEqual(await inventoryResponse.json(), {
      decision_ids: [admitted.decision.decision_id],
      next_cursor: null,
    });
    const exactUrl = `${inventory.origin}${inventory.pathname}/${admitted.decision.decision_id}`;
    const exact = await fetch(exactUrl, { headers: hostHeaders });
    assert.equal(exact.status, 200);
    const payload = (await exact.json() as any).decision;
    assert.deepEqual(parseExecutionDelegationDecisionIntent(payload), payload,
      "the server and daemon share one strict decision-intent contract");
    assert.equal(parseExecutionDelegationDecisionIntent({ ...payload, unexpected: true }), null);
    assert.equal(parseExecutionDelegationDecisionIntent({ ...payload, request_version: 2_147_483_648 }), null);
    assert.equal(parseExecutionDelegationDecisionIntent({ ...payload, actor_account_id: active.ownerId }), null);
    assert.equal(payload.scope_sha256, active.delegation.scope_sha256);
    assert.equal(payload.request_sha256, admitted.decision.request_sha256);
    assert.equal("client_request_id" in payload, false);
    assert.equal("request_fingerprint" in payload, false);

    const foreign = await db!.createSupervisorHostGrant({
      owner_account_id: active.ownerId,
      host_id: `foreign_decision_host_${++ordinal}`,
      installation_id: `foreign_decision_installation_${ordinal}`,
      allowed_room_ids: [active.room.id],
      allowed_agent_keys: [active.agent.canonical_key],
      expires_at: new Date(active.now.getTime() + 60 * 60_000).toISOString(),
    });
    assert.equal((await fetch(
      `${baseUrl}/supervisor-host-grants/${foreign.grant.grant_id}/execution-delegation-decisions/${admitted.decision.decision_id}`,
      { headers: {
        authorization: `Bearer ${foreign.token}`,
        "x-letagents-supervisor-generation": String(foreign.grant.current_generation),
      } },
    )).status, 404);
  } finally {
    await close(readServer);
  }
});

test("feature-off hides new decision writes while preserving host reconciliation reads", databaseOptions, async () => {
  const seeded = await seed();
  const admitted = await db!.admitExecutionDelegationDecision(decisionInput(seeded, {
    client_request_id: "feature_off_read",
  }));
  const prior = process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED;
  process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED = "false";
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerExecutionDelegationDecisionRoutes(app, routeDeps({ value: "allow" }));
  const server = await listen(app);
  try {
    const baseUrl = serverUrl(server);
    const hiddenPath = `/execution-delegations/${seeded.delegation.delegation_instance_id}/decisions`;
    const hidden = await fetch(baseUrl + hiddenPath, {
      method: "POST",
      headers: cookie(`decision_approver_session_${seeded.n}`),
      body: JSON.stringify(decisionBody(seeded)),
    });
    const unknown = await fetch(baseUrl + "/route-that-does-not-exist", { method: "POST" });
    assert.equal(hidden.status, unknown.status);
    assert.equal(hidden.headers.get("content-type"), unknown.headers.get("content-type"));

    const hostHeaders = {
      authorization: `Bearer ${seeded.host.token}`,
      "x-letagents-supervisor-generation": String(seeded.host.grant.current_generation),
    };
    const exact = await fetch(
      `${baseUrl}/supervisor-host-grants/${seeded.host.grant.grant_id}/execution-delegation-decisions/${admitted.decision.decision_id}`,
      { headers: hostHeaders },
    );
    assert.equal(exact.status, 200, "already-recorded intents remain host-reconcilable while admission is disabled");
  } finally {
    await close(server);
    if (prior === undefined) delete process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED;
    else process.env.LETAGENTS_EXECUTION_DELEGATION_ENABLED = prior;
  }
});
