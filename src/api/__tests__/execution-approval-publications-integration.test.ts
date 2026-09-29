import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import express from "express";

import {
  EXECUTION_APPROVAL_PUBLICATION_VERSION,
  parseExecutionApprovalPublicationInput,
} from "../../../shared/execution-approval-publication.mjs";
import { serializeExecutionApprovalProjectionV1 } from "../../../shared/execution-approval-projection.mjs";
import type { AuthenticatedRequest } from "../http/helpers.js";

const testDatabaseUrl = process.env.TEST_DB_URL;
const requiresDatabase = !testDatabaseUrl;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_SUPERVISOR_HOST_GRANT_ENABLED = "true";
process.env.LETAGENTS_AGENT_SESSION_BEARER_ENABLED = "true";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const db = testDatabaseUrl ? await import("../db.js") : null;
const roomWork = testDatabaseUrl ? await import("../db/room-agent-work.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { registerHttpMiddleware } = await import("../http/middleware.js");
const { resolveRequestAuth } = await import("../request/auth.js");
const { registerExecutionDelegationDecisionRoutes } = await import("../routes/execution-delegation-decisions.js");
const { registerExecutionDelegationRoutes } = await import("../routes/execution-delegations.js");
const { registerExecutionApprovalPublicationRoutes } = await import("../routes/execution-approval-publications.js");
const { agentApprovalEvents } = await import("../server/events.js");
const { publishExecutionApproval } = await import("../../../apps/desktop/daemon/execution-approval-publication-http.js");

async function reset(): Promise<void> {
  if (!client) throw new Error("DB-backed publication tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

if (!requiresDatabase) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}
const databaseOptions = { skip: requiresDatabase ? "set TEST_DB_URL to run DB-backed publication tests" : false };

let ordinal = 0;

async function seed(options: { publishWork?: boolean } = {}) {
  const n = ++ordinal;
  const now = new Date();
  const ownerId = `publication_owner_${n}`;
  const approverId = `publication_approver_${n}`;
  const otherId = `publication_other_${n}`;
  for (const id of [ownerId, approverId, otherId]) {
    await client!.db.insert(schema!.accounts).values({
      id, provider: "github", provider_user_id: id, login: id, display_name: id,
      avatar_url: null, created_at: now.toISOString(), updated_at: now.toISOString(),
    });
  }
  const room = await db!.createProjectWithName(`publication-room-${n}`);
  const agent = await db!.registerAgentIdentity({
    owner_account_id: ownerId,
    owner_login: ownerId,
    owner_label: ownerId,
    name: `publication-agent-${n}`,
  });
  const host = await db!.createSupervisorHostGrant({
    owner_account_id: ownerId,
    host_id: `publication_host_${n}`,
    installation_id: `publication_installation_${n}`,
    allowed_room_ids: [room.id],
    allowed_agent_keys: [agent.canonical_key],
    expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
  });
  const session = await db!.createRoomAgentSession({
    room_id: room.id,
    session_kind: "worker",
    runtime: "test",
    registration_liveness: { host_id: host.grant.host_id },
    actor_label: `Publication Agent ${n}`,
    agent_key: agent.canonical_key,
    agent_instance_id: `daemon:publication-${n}`,
    display_name: `Publication Agent ${n}`,
    owner_account_id: ownerId,
    owner_label: ownerId,
    ide_label: "Test",
    supervisor_grant_id: host.grant.grant_id,
    supervisor_grant_fence: {
      grant_id: host.grant.grant_id,
      generation: host.grant.current_generation,
      token_version: host.grant.token_version,
    },
  });
  const sourceTime = new Date().toISOString();
  await client!.db.insert(schema!.messages).values({
    room_id: room.id, number: 1, sender: ownerId, text: "Change the project", timestamp: sourceTime,
  });
  await client!.db.insert(schema!.message_agent_receipts).values({
    id: randomUUID(), room_id: room.id, message_room_id: room.id, message_number: 1,
    agent_session_id: session.session_id, agent_key: agent.canonical_key,
    actor_label: session.actor_label, activation_reason: "explicit_mention",
    receipt_state: "responding", created_at: sourceTime, updated_at: sourceTime,
  });
  if (options.publishWork ?? true) {
    await roomWork!.publishRoomAgentWork({
      fence: {
        grant_id: host.grant.grant_id,
        generation: host.grant.current_generation,
        token_version: host.grant.token_version,
      },
      room_id: room.id,
      session_id: session.session_id,
      source_message_number: 1,
      revision: 1,
      summary: {
        version: 1,
        recorded_state: "active",
        evidence_incomplete: false,
        elapsed_ms: null,
        operation_counts: {
          unresolved: 1, succeeded: 0, failed: 0, denied_before_start: 0,
          cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0,
        },
      },
    });
  }
  const delegationNow = new Date();
  const delegation = await db!.admitExecutionDelegationGrantRevision({
    owner_account_id: ownerId,
    supervisor_grant_id: host.grant.grant_id,
    room_id: room.id,
    agent_key: agent.canonical_key,
    approver_account_id: approverId,
    category: "file_change",
    risk_ceiling: "low",
    expires_at: new Date(delegationNow.getTime() + 30 * 60_000).toISOString(),
    client_request_id: `publication_delegation_${n}`,
    expected_revision: 0,
    now: delegationNow,
  });
  await Promise.all([
    db!.createSession(approverId, `publication_approver_session_${n}`, new Date(now.getTime() + 60 * 60_000).toISOString()),
    db!.createSession(ownerId, `publication_owner_session_${n}`, new Date(now.getTime() + 60 * 60_000).toISOString()),
    db!.createSession(otherId, `publication_other_session_${n}`, new Date(now.getTime() + 60 * 60_000).toISOString()),
  ]);
  return { n, ownerId, approverId, otherId, room, agent, host, session, delegation: delegation.grant };
}

function publication(seeded: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
  const projectionJson = serializeExecutionApprovalProjectionV1({
    version: 1,
    category: "file_change",
    path_scope: "workspace_relative",
    changes: [{
      path: "src/index.ts", kind: "update", move_path: null,
      added_lines: 3, removed_lines: 1, diff_bytes: 80,
    }],
    totals: { file_count: 1, added_lines: 3, removed_lines: 1, diff_bytes: 80 },
  })!;
  const now = Date.now();
  const value = parseExecutionApprovalPublicationInput({
    version: EXECUTION_APPROVAL_PUBLICATION_VERSION,
    room_id: seeded.room.id,
    source_message_id: "msg_1",
    delegation_instance_id: seeded.delegation.delegation_instance_id,
    delegation_revision: seeded.delegation.revision,
    request_id: `publication_request_${seeded.n}`,
    request_version: 1,
    request_sha256: "a".repeat(64),
    projection_sha256: createHash("sha256").update(projectionJson).digest("hex"),
    projection_json: projectionJson,
    produced_at: new Date(now + 5 * 60_000).toISOString(),
    expires_at: new Date(now + 10 * 60_000).toISOString(),
    ...overrides,
  });
  assert.ok(value);
  return value;
}

type MembershipMode = "allow" | "deny" | "indeterminate";

function routeDeps(mode: { value: MembershipMode }, canonicalRoomId?: string) {
  return {
    resolveCanonicalRoomRequestId: async (roomId: string) => roomId === "room_alias" ? canonicalRoomId ?? roomId : roomId,
    resolveRoomOrReply: async (roomId: string) => db!.getProjectById(roomId),
    requireParticipant: async (_req: any, res: any, _project: any, options: any) => {
      assert.equal(options.freshCollaboratorCheck, true);
      assert.equal(options.throwOnIndeterminate, true);
      if (mode.value === "indeterminate") throw new Error("membership provider unavailable");
      if (mode.value === "deny") {
        res.status(403).json({ error: "membership removed" });
        return false;
      }
      return true;
    },
    getProjectById: async (roomId: string) => db!.getProjectById(roomId),
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

test("publication is one-shot, daemon-verifiable, and preserves exact delegate bytes", databaseOptions, async (t) => {
  const seeded = await seed();
  const mode = { value: "allow" as MembershipMode };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  const deps = routeDeps(mode, seeded.room.id) as never;
  registerExecutionDelegationRoutes(app, deps);
  registerExecutionDelegationDecisionRoutes(app, deps);
  registerExecutionApprovalPublicationRoutes(app, deps);
  const server = await listen(app);
  t.after(async () => close(server));
  const origin = serverUrl(server);
  const request = publication(seeded);
  let invalidations = 0;
  const listener = () => { invalidations += 1; };
  agentApprovalEvents.on("agent_approval:invalidated", listener);
  t.after(() => agentApprovalEvents.off("agent_approval:invalidated", listener));

  const publish = () => publishExecutionApproval({
    apiOrigin: origin,
    grantId: seeded.host.grant.grant_id,
    supervisorGrant: seeded.host.token,
    grantGeneration: seeded.host.grant.current_generation,
    sessionId: seeded.session.session_id,
    agentKey: seeded.agent.canonical_key,
    publication: request,
    signal: new AbortController().signal,
  });
  const createdEvent = once(agentApprovalEvents, "agent_approval:invalidated");
  const created = await publish();
  assert.equal(created.status, "acknowledged", "daemon and server verify one shared publication digest");
  await createdEvent;
  assert.equal(invalidations, 1);
  const replayEvent = once(agentApprovalEvents, "agent_approval:invalidated");
  const replay = await publish();
  assert.equal(replay.status, "acknowledged");
  await replayEvent;
  assert.equal(invalidations, 2, "a receipt replay repairs a pointer lost after commit");

  const conflict = await publishExecutionApproval({
    apiOrigin: origin, grantId: seeded.host.grant.grant_id, supervisorGrant: seeded.host.token,
    grantGeneration: seeded.host.grant.current_generation, sessionId: seeded.session.session_id,
    agentKey: seeded.agent.canonical_key,
    publication: publication(seeded, { request_sha256: "b".repeat(64) }),
    signal: new AbortController().signal,
  });
  assert.equal(conflict.status, "conflict");
  assert.equal((await client!.db.select().from(schema!.execution_approval_publications)).length, 1);
  await assert.rejects(
    client!.pool.query("UPDATE execution_approval_publications SET request_sha256=$1", ["c".repeat(64)]),
    /immutable/,
  );

  const aliasResponse = await fetch(
    `${origin}/supervisor-host-grants/${seeded.host.grant.grant_id}`
      + `/worker-sessions/${seeded.session.session_id}/execution-approval-publications`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${seeded.host.token}`,
        "content-type": "application/json",
        "x-letagents-supervisor-generation": String(seeded.host.grant.current_generation),
      },
      body: JSON.stringify(publication(seeded, { room_id: "room_alias", request_id: "alias_request" })),
    },
  );
  assert.equal(aliasResponse.status, 400, "signed publication identity is never rewritten from an alias");

  const [work] = await client!.db.select().from(schema!.room_agent_work);
  assert.ok(work);
  const extraPublishedAt = new Date();
  await client!.db.insert(schema!.execution_approval_publications).values(
    Array.from({ length: 50 }, (_, index) => ({
      publication_id: `execution_approval_publication_page_${String(index).padStart(2, "0")}`,
      room_agent_work_attempt_id: work.attempt_id,
      delegation_instance_id: seeded.delegation.delegation_instance_id,
      delegation_revision: seeded.delegation.revision,
      request_id: `page_request_${index}`,
      request_version: 1,
      request_sha256: createHash("sha256").update(`request-${index}`).digest("hex"),
      projection_sha256: request.projection_sha256,
      projection_json: request.projection_json,
      publication_digest: createHash("sha256").update(`publication-${index}`).digest("hex"),
      produced_at: request.produced_at,
      published_at: new Date(extraPublishedAt.getTime() + index).toISOString(),
      expires_at: request.expires_at,
    })),
  );

  const cookie = (id: string) => ({ cookie: `letagents_session=${id}` });
  const inventoryUrl = `${origin}/rooms/${seeded.room.id}/agent-approvals`;
  const inventory = await fetch(inventoryUrl, { headers: cookie(`publication_approver_session_${seeded.n}`) });
  assert.equal(inventory.status, 200);
  assert.equal(inventory.headers.get("cache-control"), "no-store");
  const inventoryBody = await inventory.json() as any;
  assert.equal(inventoryBody.publications.length, 50);
  assert.ok(inventoryBody.next_cursor);
  assert.equal("projection_json" in inventoryBody.publications[0], false);
  const nextPage = await fetch(`${inventoryUrl}?after=${encodeURIComponent(inventoryBody.next_cursor)}`, {
    headers: cookie(`publication_approver_session_${seeded.n}`),
  });
  assert.equal(nextPage.status, 200);
  const nextBody = await nextPage.json() as any;
  assert.equal(nextBody.publications.length, 1);
  assert.equal(nextBody.next_cursor, null);
  assert.equal(new Set([
    ...inventoryBody.publications.map((item: any) => item.publication_id),
    ...nextBody.publications.map((item: any) => item.publication_id),
  ]).size, 51, "stable cursor pagination neither drops nor duplicates approvals");
  assert.equal((await fetch(`${inventoryUrl}?after=missing_cursor`, {
    headers: cookie(`publication_approver_session_${seeded.n}`),
  })).status, 409);
  assert.deepEqual(await (await fetch(inventoryUrl, { headers: cookie(`publication_other_session_${seeded.n}`) })).json(), {
    publications: [], next_cursor: null,
  });

  const exactUrl = `${inventoryUrl}/${created.publicationId}/projection`;
  const exact = await fetch(exactUrl, { headers: cookie(`publication_approver_session_${seeded.n}`) });
  assert.equal(exact.status, 200);
  assert.equal(exact.headers.get("cache-control"), "no-store");
  assert.equal(await exact.text(), request.projection_json, "canonical projection bytes are never reserialized");
  assert.equal((await fetch(exactUrl, { headers: cookie(`publication_other_session_${seeded.n}`) })).status, 404);
  assert.equal((await fetch(exactUrl, { headers: cookie(`publication_owner_session_${seeded.n}`) })).status, 404);
  mode.value = "deny";
  assert.equal((await fetch(inventoryUrl, {
    headers: cookie(`publication_approver_session_${seeded.n}`),
  })).status, 404, "a failed current-membership check conceals the inventory");
  assert.equal((await fetch(exactUrl, {
    headers: cookie(`publication_approver_session_${seeded.n}`),
  })).status, 404);
  mode.value = "allow";

  const mismatchedDecision = await fetch(
    `${origin}/execution-delegations/${seeded.delegation.delegation_instance_id}/decisions`,
    {
      method: "POST",
      headers: {
        ...cookie(`publication_approver_session_${seeded.n}`),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_revision: seeded.delegation.revision,
        request_id: request.request_id,
        request_version: request.request_version,
        request_sha256: "f".repeat(64),
        projection_sha256: request.projection_sha256,
        decision: "deny",
        client_request_id: `publication_mismatched_decision_${seeded.n}`,
      }),
    },
  );
  assert.equal(mismatchedDecision.status, 409);
  assert.equal((await mismatchedDecision.json() as any).code,
    "execution_delegation_decision_conflict");

  const decidedEvent = once(agentApprovalEvents, "agent_approval:invalidated");
  const decided = await fetch(
    `${origin}/execution-delegations/${seeded.delegation.delegation_instance_id}/decisions`,
    {
      method: "POST",
      headers: {
        ...cookie(`publication_approver_session_${seeded.n}`),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_revision: seeded.delegation.revision,
        request_id: request.request_id,
        request_version: request.request_version,
        request_sha256: request.request_sha256,
        projection_sha256: request.projection_sha256,
        decision: "deny",
        client_request_id: `publication_decision_${seeded.n}`,
      }),
    },
  );
  assert.equal(decided.status, 201);
  await decidedEvent;
  assert.equal(invalidations, 3, "a committed decision emits a content-free approval pointer");
  assert.equal((await fetch(exactUrl, {
    headers: cookie(`publication_approver_session_${seeded.n}`),
  })).status, 404, "decided approval bytes are no longer actionable");

  const revokedEvent = once(agentApprovalEvents, "agent_approval:invalidated");
  const revoked = await fetch(
    `${origin}/execution-delegations/${seeded.delegation.delegation_instance_id}`,
    { method: "DELETE", headers: cookie(`publication_owner_session_${seeded.n}`) },
  );
  assert.equal(revoked.status, 200);
  await revokedEvent;
  assert.equal(invalidations, 4, "a terminal delegation mutation emits a content-free approval pointer");
  assert.deepEqual(await (await fetch(inventoryUrl, {
    headers: cookie(`publication_approver_session_${seeded.n}`),
  })).json(), { publications: [], next_cursor: null });

  mode.value = "indeterminate";
  const unavailable = await fetch(inventoryUrl, { headers: cookie(`publication_approver_session_${seeded.n}`) });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json() as any).retryable, true);

  assert.equal(await db!.pruneExpiredExecutionApprovalPublications({
    now: new Date(Date.parse(request.expires_at) + 1),
    limit: 10,
  }), 10, "retention cleanup is bounded per sweep");
  assert.equal((await client!.db.select().from(schema!.execution_approval_publications)).length, 41);
});

test("publication retries when recorded work has not arrived yet", databaseOptions, async (t) => {
  const seeded = await seed({ publishWork: false });
  const request = publication(seeded);
  const mode = { value: "allow" as MembershipMode };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerExecutionApprovalPublicationRoutes(app, routeDeps(mode, seeded.room.id) as never);
  const server = await listen(app);
  t.after(async () => close(server));
  const origin = serverUrl(server);
  const route = `${origin}/supervisor-host-grants/${seeded.host.grant.grant_id}`
    + `/worker-sessions/${seeded.session.session_id}/execution-approval-publications`;
  const headers = {
    authorization: `Bearer ${seeded.host.token}`,
    "content-type": "application/json",
    "x-letagents-supervisor-generation": String(seeded.host.grant.current_generation),
  };

  const early = await fetch(route, { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(early.status, 409);
  assert.deepEqual(await early.json(), {
    error: "Recorded agent work is not ready for this approval publication.",
    code: "publication_work_not_ready",
    retryable: true,
  });
  assert.equal((await client!.db.select().from(schema!.execution_approval_publications)).length, 0);

  await roomWork!.publishRoomAgentWork({
    fence: {
      grant_id: seeded.host.grant.grant_id,
      generation: seeded.host.grant.current_generation,
      token_version: seeded.host.grant.token_version,
    },
    room_id: seeded.room.id,
    session_id: seeded.session.session_id,
    source_message_number: 1,
    revision: 1,
    summary: {
      version: 1,
      recorded_state: "active",
      evidence_incomplete: false,
      elapsed_ms: null,
      operation_counts: {
        unresolved: 1, succeeded: 0, failed: 0, denied_before_start: 0,
        cancelled_before_start: 0, interrupted_after_start: 0, lost_after_start: 0,
      },
    },
  });
  await client!.db.update(schema!.room_agent_work)
    .set({ host_id: "foreign_host" })
    .where(eq(schema!.room_agent_work.room_id, seeded.room.id));
  const mismatched = await fetch(route, { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(mismatched.status, 403, "present but foreign recorded work is never treated as pending");
  assert.equal((await mismatched.json() as any).code, "publisher_not_authorized");
  await client!.db.update(schema!.room_agent_work)
    .set({ host_id: seeded.host.grant.host_id })
    .where(eq(schema!.room_agent_work.room_id, seeded.room.id));
  const retried = await publishExecutionApproval({
    apiOrigin: origin,
    grantId: seeded.host.grant.grant_id,
    supervisorGrant: seeded.host.token,
    grantGeneration: seeded.host.grant.current_generation,
    sessionId: seeded.session.session_id,
    agentKey: seeded.agent.canonical_key,
    publication: request,
    signal: new AbortController().signal,
  });
  assert.equal(retried.status, "acknowledged");
});

test("publication validates exact custody, bounded replay, and source concealment", databaseOptions, async () => {
  const seeded = await seed();
  const input = publication(seeded);
  const fence = {
    grant_id: seeded.host.grant.grant_id,
    generation: seeded.host.grant.current_generation,
    token_version: seeded.host.grant.token_version,
  };
  const result = await db!.publishExecutionApprovalPublication({
    fence, session_id: seeded.session.session_id, publication: input,
  });
  assert.equal(result.status, "created", "a future host produced_at survives ordinary clock skew");
  await assert.rejects(db!.publishExecutionApprovalPublication({
    fence, session_id: "foreign_session", publication: publication(seeded, { request_id: "foreign" }),
  }), { code: "publisher_not_authorized" });
  await assert.rejects(db!.publishExecutionApprovalPublication({
    fence,
    session_id: seeded.session.session_id,
    publication: publication(seeded, { request_id: "wrong_revision", delegation_revision: 2 }),
  }), { code: "delegation_revision_conflict" });
  await assert.rejects(db!.publishExecutionApprovalPublication({
    fence,
    session_id: seeded.session.session_id,
    publication: input,
    now: new Date(Date.parse(input.expires_at) + 1),
  }), { code: "publication_terminal" }, "request expiry is the exact replay boundary");
  await db!.revokeExecutionDelegationGrant({
    owner_account_id: seeded.ownerId,
    delegation_instance_id: seeded.delegation.delegation_instance_id,
  });
  const lostResponseReplay = await db!.publishExecutionApprovalPublication({
    fence, session_id: seeded.session.session_id, publication: input,
  });
  assert.equal(lostResponseReplay.status, "replayed",
    "an immutable committed receipt remains acknowledgeable after delegation revocation");
  assert.equal(await db!.pruneExpiredExecutionApprovalPublications({
    now: new Date(Date.parse(input.expires_at) - 1),
  }), 0, "terminal delegation rows survive until request replay is no longer applicable");
  assert.equal(await db!.pruneExpiredExecutionApprovalPublications({
    now: new Date(Date.parse(input.expires_at) + 1),
  }), 1);

  const concealed = await seed();
  const concealedResult = await db!.publishExecutionApprovalPublication({
    fence: {
      grant_id: concealed.host.grant.grant_id,
      generation: concealed.host.grant.current_generation,
      token_version: concealed.host.grant.token_version,
    },
    session_id: concealed.session.session_id,
    publication: publication(concealed),
  });
  assert.equal((await db!.listExecutionApprovalPublicationsForApprover({
    room_id: concealed.room.id,
    approver_account_id: concealed.approverId,
  })).publications.length, 1);
  await client!.pool.query(
    "UPDATE messages SET agent_prompt_kind='auto', text='' WHERE room_id=$1 AND number=1",
    [concealed.room.id],
  );
  assert.deepEqual(await db!.listExecutionApprovalPublicationsForApprover({
    room_id: concealed.room.id, approver_account_id: concealed.approverId,
  }), { publications: [], next_cursor: null });
  assert.equal(await db!.getExecutionApprovalPublicationForApprover({
    room_id: concealed.room.id,
    approver_account_id: concealed.approverId,
    publication_id: concealedResult.publication.publication_id,
  }), null);
});

test("publication admission is transactionally bounded per delegation instance", databaseOptions, async (t) => {
  const seeded = await seed();
  const at = new Date();
  const input = publication(seeded, {
    produced_at: new Date(at.getTime() - 60_000).toISOString(),
    expires_at: new Date(at.getTime() + 10 * 60_000).toISOString(),
  });
  const fence = {
    grant_id: seeded.host.grant.grant_id,
    generation: seeded.host.grant.current_generation,
    token_version: seeded.host.grant.token_version,
  };
  const first = await db!.publishExecutionApprovalPublication({
    fence,
    session_id: seeded.session.session_id,
    publication: input,
    now: at,
  });
  assert.equal(first.status, "created");
  const [work] = await client!.db.select().from(schema!.room_agent_work);
  assert.ok(work);

  await client!.db.insert(schema!.execution_delegation_decisions).values({
    decision_id: `execution_delegation_decision_capacity_${seeded.n}`,
    delegation_instance_id: seeded.delegation.delegation_instance_id,
    delegation_revision: seeded.delegation.revision,
    actor_account_id: seeded.approverId,
    request_id: input.request_id,
    request_version: input.request_version,
    request_sha256: input.request_sha256,
    projection_sha256: input.projection_sha256,
    decision: "deny",
    client_request_id: `publication_capacity_decision_${seeded.n}`,
    request_fingerprint: createHash("sha256").update(`capacity-${seeded.n}`).digest("hex"),
    decided_at: at.toISOString(),
  });
  await client!.db.insert(schema!.execution_approval_publications).values(
    Array.from({ length: 254 }, (_, index) => ({
      publication_id: `execution_approval_publication_capacity_${seeded.n}_${index}`,
      room_agent_work_attempt_id: work.attempt_id,
      delegation_instance_id: seeded.delegation.delegation_instance_id,
      delegation_revision: seeded.delegation.revision,
      request_id: `publication_capacity_request_${seeded.n}_${index}`,
      request_version: 1,
      request_sha256: createHash("sha256").update(`capacity-request-${index}`).digest("hex"),
      projection_sha256: input.projection_sha256,
      projection_json: input.projection_json,
      publication_digest: createHash("sha256").update(`capacity-publication-${index}`).digest("hex"),
      produced_at: new Date(at.getTime() - 60_000).toISOString(),
      published_at: at.toISOString(),
      expires_at: new Date(at.getTime() + (index === 0 ? 2 : 10) * 60_000).toISOString(),
      closed_at: new Date(at.getTime() + 1_000).toISOString(),
    })),
  );

  const raceInputs = ["a", "b"].map((suffix) => publication(seeded, {
    request_id: `publication_capacity_race_${suffix}_${seeded.n}`,
    produced_at: new Date(at.getTime() - 60_000).toISOString(),
    expires_at: new Date(at.getTime() + 10 * 60_000).toISOString(),
  }));
  const raced = await Promise.allSettled(raceInputs.map((candidate) =>
    db!.publishExecutionApprovalPublication({
      fence,
      session_id: seeded.session.session_id,
      publication: candidate,
      now: at,
    })));
  assert.deepEqual(raced.map((result) => result.status).sort(), ["fulfilled", "rejected"],
    "the delegation lock admits exactly one of two concurrent requests for the final slot");
  assert.equal((raced.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.code,
    "publication_capacity");

  const mode = { value: "allow" as MembershipMode };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  registerExecutionApprovalPublicationRoutes(app, routeDeps(mode, seeded.room.id) as never);
  const server = await listen(app);
  t.after(async () => close(server));
  const route = `${serverUrl(server)}/supervisor-host-grants/${seeded.host.grant.grant_id}`
    + `/worker-sessions/${seeded.session.session_id}/execution-approval-publications`;
  const headers = {
    authorization: `Bearer ${seeded.host.token}`,
    "content-type": "application/json",
    "x-letagents-supervisor-generation": String(seeded.host.grant.current_generation),
  };
  const overflow = publication(seeded, {
    request_id: `publication_capacity_overflow_${seeded.n}`,
    produced_at: new Date(at.getTime() - 60_000).toISOString(),
    expires_at: new Date(at.getTime() + 10 * 60_000).toISOString(),
  });

  const rejected = await fetch(route, { method: "POST", headers, body: JSON.stringify(overflow) });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {
    error: "This approval delegation has reached its active publication capacity.",
    code: "publication_capacity",
    retryable: true,
  });
  const replay = await fetch(route, { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(replay.status, 200, "exact replay remains available at capacity");
  assert.equal((await replay.json() as { status: string }).status, "replayed");

  const afterExpiry = new Date(at.getTime() + 3 * 60_000);
  assert.equal(await db!.pruneExpiredExecutionApprovalPublications({ now: afterExpiry }), 1);
  const recovered = await db!.publishExecutionApprovalPublication({
    fence,
    session_id: seeded.session.session_id,
    publication: overflow,
    now: afterExpiry,
  });
  assert.equal(recovered.status, "created", "expiry and pruning restore one admission slot");
});

test("host closure is one-way, custody-fenced, and immediately conceals the publication", databaseOptions, async (t) => {
  const seeded = await seed();
  const mode = { value: "allow" as MembershipMode };
  const app = express();
  registerHttpMiddleware(app, { resolveRequestAuth });
  const deps = routeDeps(mode, seeded.room.id) as never;
  registerExecutionDelegationDecisionRoutes(app, deps);
  registerExecutionApprovalPublicationRoutes(app, deps);
  const server = await listen(app);
  t.after(async () => close(server));
  const origin = serverUrl(server);
  const request = publication(seeded);
  const published = await publishExecutionApproval({
    apiOrigin: origin,
    grantId: seeded.host.grant.grant_id,
    supervisorGrant: seeded.host.token,
    grantGeneration: seeded.host.grant.current_generation,
    sessionId: seeded.session.session_id,
    agentKey: seeded.agent.canonical_key,
    publication: request,
    signal: new AbortController().signal,
  });
  assert.equal(published.status, "acknowledged");
  if (published.status !== "acknowledged") throw new Error("Publication was not acknowledged.");

  const closeUrl = (sessionId: string, publicationId = published.publicationId) =>
    `${origin}/supervisor-host-grants/${seeded.host.grant.grant_id}`
      + `/worker-sessions/${sessionId}/execution-approval-publications/${publicationId}/close`;
  const closeHeaders = {
    authorization: `Bearer ${seeded.host.token}`,
    "content-type": "application/json",
    "x-letagents-supervisor-generation": String(seeded.host.grant.current_generation),
  };
  const closePublication = (body: unknown, sessionId = seeded.session.session_id) => fetch(closeUrl(sessionId), {
    method: "POST",
    headers: closeHeaders,
    body: JSON.stringify(body),
  });

  let invalidations = 0;
  const listener = () => { invalidations += 1; };
  agentApprovalEvents.on("agent_approval:invalidated", listener);
  t.after(() => agentApprovalEvents.off("agent_approval:invalidated", listener));
  const closedEvent = once(agentApprovalEvents, "agent_approval:invalidated");
  const closedResponse = await closePublication({ publication_digest: published.publicationDigest });
  assert.equal(closedResponse.status, 200);
  assert.equal(closedResponse.headers.get("cache-control"), "no-store");
  const closed = await closedResponse.json() as any;
  assert.deepEqual(Object.keys(closed).sort(), [
    "closed_at", "publication_digest", "publication_id", "status",
  ]);
  assert.equal(closed.status, "closed");
  assert.equal(closed.publication_id, published.publicationId);
  assert.equal(closed.publication_digest, published.publicationDigest);
  await closedEvent;
  assert.equal(invalidations, 1);

  const cookie = { cookie: `letagents_session=publication_approver_session_${seeded.n}` };
  const inventoryUrl = `${origin}/rooms/${seeded.room.id}/agent-approvals`;
  assert.deepEqual(await (await fetch(inventoryUrl, { headers: cookie })).json(), {
    publications: [], next_cursor: null,
  });
  assert.equal((await fetch(`${inventoryUrl}/${published.publicationId}/projection`, {
    headers: cookie,
  })).status, 404, "closed projection bytes are immediately concealed");

  const closeReplayEvent = once(agentApprovalEvents, "agent_approval:invalidated");
  const replayedResponse = await closePublication({ publication_digest: published.publicationDigest });
  assert.equal(replayedResponse.status, 200);
  const replayed = await replayedResponse.json() as any;
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.closed_at, closed.closed_at, "close replay returns the original server timestamp");
  await closeReplayEvent;
  assert.equal(invalidations, 2, "close replay repairs a pointer lost after commit");
  const publishReplayEvent = once(agentApprovalEvents, "agent_approval:invalidated");
  const publishReplay = await publishExecutionApproval({
    apiOrigin: origin,
    grantId: seeded.host.grant.grant_id,
    supervisorGrant: seeded.host.token,
    grantGeneration: seeded.host.grant.current_generation,
    sessionId: seeded.session.session_id,
    agentKey: seeded.agent.canonical_key,
    publication: request,
    signal: new AbortController().signal,
  });
  assert.deepEqual(publishReplay, published, "closure does not break an exact lost-response publication replay");
  await publishReplayEvent;
  assert.equal(invalidations, 3, "publication replay also repairs the approval pointer");
  await assert.rejects(client!.pool.query(
    "UPDATE execution_approval_publications SET closed_at=$1 WHERE publication_id=$2",
    [new Date(Date.parse(closed.closed_at) + 1).toISOString(), published.publicationId],
  ), /immutable/, "closure metadata is one-way");

  const conflict = await closePublication({ publication_digest: "b".repeat(64) });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as any).code, "publication_conflict");
  const foreign = await closePublication(
    { publication_digest: published.publicationDigest },
    "foreign_worker_session",
  );
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json() as any).code, "publisher_not_authorized");

  const decision = await fetch(
    `${origin}/execution-delegations/${seeded.delegation.delegation_instance_id}/decisions`,
    {
      method: "POST",
      headers: {
        cookie: `letagents_session=publication_approver_session_${seeded.n}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_revision: seeded.delegation.revision,
        request_id: request.request_id,
        request_version: request.request_version,
        request_sha256: request.request_sha256,
        projection_sha256: request.projection_sha256,
        decision: "allow_once",
        client_request_id: `closed_publication_decision_${seeded.n}`,
      }),
    },
  );
  assert.equal(decision.status, 409);
  assert.equal((await decision.json() as any).code, "execution_delegation_decision_publication_closed");

  const stale = await seed();
  const staleRequest = publication(stale);
  const stalePublished = await db!.publishExecutionApprovalPublication({
    fence: {
      grant_id: stale.host.grant.grant_id,
      generation: stale.host.grant.current_generation,
      token_version: stale.host.grant.token_version,
    },
    session_id: stale.session.session_id,
    publication: staleRequest,
  });
  await client!.db.update(schema!.room_agent_sessions)
    .set({ ended_at: new Date().toISOString() })
    .where(eq(schema!.room_agent_sessions.session_id, stale.session.session_id));
  await assert.rejects(db!.closeExecutionApprovalPublication({
    fence: {
      grant_id: stale.host.grant.grant_id,
      generation: stale.host.grant.current_generation,
      token_version: stale.host.grant.token_version,
    },
    session_id: stale.session.session_id,
    publication_id: stalePublished.publication.publication_id,
    publication_digest: stalePublished.publication_digest,
  }), { code: "publisher_not_authorized" });
});
