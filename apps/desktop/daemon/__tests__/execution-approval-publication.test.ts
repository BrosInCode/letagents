import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  executionApprovalPublicationSha256,
  parseExecutionApprovalPublicationInput,
} from "../../../../shared/execution-approval-publication.mjs";
import { closeExecutionApprovalPublication, publishExecutionApproval } from "../execution-approval-publication-http.js";
import {
  applyExecutionApprovalPublicationSchema,
  ExecutionApprovalPublicationStore,
  type ExecutionApprovalPublicationPin,
} from "../execution-approval-publication-store.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const projectionJson = JSON.stringify({
  version: 1,
  category: "file_change",
  path_scope: "workspace_relative",
  changes: [{ path: "src/app.ts", kind: "update", move_path: null, added_lines: 1, removed_lines: 0, diff_bytes: 7 }],
  totals: { file_count: 1, added_lines: 1, removed_lines: 0, diff_bytes: 7 },
});
const projectionSha256 = sha(projectionJson);
const requestSha256 = sha("request");

function publication() {
  const result = parseExecutionApprovalPublicationInput({
    version: 1,
    room_id: "room",
    source_message_id: "msg_1",
    delegation_instance_id: "delegation",
    delegation_revision: 2,
    request_id: "request",
    request_version: 3,
    request_sha256: requestSha256,
    projection_sha256: projectionSha256,
    projection_json: projectionJson,
    produced_at: "2026-08-31T00:00:10.000Z",
    expires_at: "2026-08-31T00:01:00.000Z",
  });
  assert.ok(result);
  return result;
}

function pin(): ExecutionApprovalPublicationPin {
  return {
    agentId: "agent",
    roomId: "room",
    apiOrigin: "https://letagents.test",
    agentKey: "owner/agent",
    agentInstanceId: "daemon:agent",
    hostId: "host",
    installationId: "installation",
    sourceSessionId: "session",
    sourceMessageId: "msg_1",
    inboxItemId: "inbox",
    workAttemptId: "attempt",
    delegationInstanceId: "delegation",
    delegationRevision: 2,
    delegationScopeSha256: sha("scope"),
    approverAccountId: "approver",
    expected: {
      requestId: "request",
      requestVersion: 3,
      requestSha256,
      agentId: "agent",
      roomId: "room",
      executionGenerationId: "execution",
      runtimeGenerationId: "runtime",
      turnId: "turn",
      providerContinuationId: "continuation",
      providerTurnId: "provider-turn",
      connectionId: "connection",
      nativeRequestId: 7,
    },
    projectionSha256,
    producedAtMs: Date.parse("2026-08-31T00:00:10.000Z"),
    expiresAtMs: Date.parse("2026-08-31T00:01:00.000Z"),
  };
}

function fillPublicationCapacity(database: DatabaseSync, overrides: Record<string, string> = {}): void {
  const capacity = String(database.prepare("SELECT sql FROM sqlite_master WHERE name='execution_approval_publication_capacity'").get()!.sql);
  const columns = database.prepare("PRAGMA table_info(execution_approval_publications)").all().map(row => String(row.name));
  const selected = columns.map(column => overrides[column] ?? (column === "delegation_instance_id"
    ? "'delegation-'||ids.n" : `seed.${column}`)).join(",");
  database.exec(`DROP TRIGGER execution_approval_publication_capacity;
    WITH RECURSIVE ids(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM ids WHERE n<10000)
    INSERT INTO execution_approval_publications(${columns.join(",")})
      SELECT ${selected} FROM ids CROSS JOIN execution_approval_publications seed
      WHERE seed.delegation_instance_id='delegation';
    ${capacity};`);
}

test("publication receipts accept honest server-clock skew but never a timestamp at expiry", () => {
  const database = new DatabaseSync(":memory:");
  applyExecutionApprovalPublicationSchema(database);
  const store = new ExecutionApprovalPublicationStore(database);
  const record = store.markAttempted(store.pin(pin()));
  assert.equal(store.acknowledge(record, {
    publicationId: "publication",
    publicationDigest: sha("publication"),
    publishedAtMs: record.producedAtMs - 60_000,
  }), true);
  assert.equal(store.get(pin())!.state, "acknowledged");

  const later = { ...pin(), expected: { ...pin().expected, requestId: "later" } };
  const open = store.markAttempted(store.pin(later));
  assert.throws(() => store.acknowledge(open, {
    publicationId: "publication-later",
    publicationDigest: sha("later"),
    publishedAtMs: open.expiresAtMs,
  }));
  assert.equal(store.get(later)!.state, "attempted");
  database.close();
});

test("terminal publication outcomes are durable and never become retryable again", () => {
  const database = new DatabaseSync(":memory:");
  applyExecutionApprovalPublicationSchema(database);
  const store = new ExecutionApprovalPublicationStore(database);
  const expired = store.pin(pin());
  store.expire(expired);
  assert.equal(store.get(pin())!.state, "expired");
  assert.equal(store.listOpen("agent").length, 0);
  assert.equal(store.pin(pin()).state, "expired", "exact replay preserves terminal state");

  const staleRevision = { ...pin(), delegationRevision: 3 };
  store.invalidate(store.pin(staleRevision));
  assert.equal(store.get(staleRevision)!.state, "invalid");
  assert.throws(() => store.pin({ ...staleRevision, delegationScopeSha256: sha("replacement") }));
  database.close();
});

test("acknowledged closure is an exact durable two-step transition across restart", () => {
  const database = new DatabaseSync(":memory:");
  applyExecutionApprovalPublicationSchema(database);
  const store = new ExecutionApprovalPublicationStore(database);
  const attempted = store.markAttempted(store.pin(pin()));
  assert.equal(store.acknowledge(attempted, {
    publicationId: "publication",
    publicationDigest: sha("publication"),
    publishedAtMs: attempted.producedAtMs,
  }), true);
  const closing = store.beginClose(store.get(pin())!);
  assert.equal(closing.state, "closing");
  assert.throws(() => database.prepare(`UPDATE execution_approval_publications
    SET publication_digest=? WHERE delegation_instance_id='delegation'`).run(sha("replacement")), /immutable/);

  const reopened = new ExecutionApprovalPublicationStore(database);
  const recovered = reopened.get(pin())!;
  assert.equal(recovered.state, "closing");
  assert.equal(reopened.acknowledgeClose(recovered, recovered.producedAtMs + 1), true);
  assert.deepEqual({ state: reopened.get(pin())!.state, closedAtMs: reopened.get(pin())!.closedAtMs },
    { state: "closed", closedAtMs: recovered.producedAtMs + 1 });
  database.close();
});

test("receipt-bearing terminal outcomes remain exactly decodable after restart", () => {
  const database = new DatabaseSync(":memory:");
  applyExecutionApprovalPublicationSchema(database);
  const store = new ExecutionApprovalPublicationStore(database);
  for (const state of ["conflict", "expired", "invalid"] as const) {
    const value = { ...pin(), delegationInstanceId: `delegation-${state}` };
    const attempted = store.markAttempted(store.pin(value));
    store.acknowledge(attempted, { publicationId: `publication-${state}`,
      publicationDigest: sha(state), publishedAtMs: attempted.producedAtMs });
    const acknowledged = store.get(value)!;
    if (state === "conflict") store.conflict(store.beginClose(acknowledged));
    else if (state === "expired") store.expire(acknowledged);
    else store.invalidate(acknowledged);
    const recovered = new ExecutionApprovalPublicationStore(database).get(value)!;
    assert.equal(recovered.state, state);
    assert.equal(recovered.publicationId, `publication-${state}`);
    assert.equal(recovered.publicationDigest, sha(state));
  }
  database.close();
});

test("terminal retention frees bounded capacity while open custody survives restart", () => {
  const database = new DatabaseSync(":memory:");
  applyExecutionApprovalPublicationSchema(database);
  const store = new ExecutionApprovalPublicationStore(database);
  const seed = store.pin(pin()); store.expire(seed);
  fillPublicationCapacity(database);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_publications").get()!.n, 10_000);
  const current = { ...pin(), delegationInstanceId: "current" };
  assert.equal(store.pin(current).state, "open");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_publications").get()!.n, 5_001);
  store.markAttempted(store.get(current)!);
  assert.throws(() => database.prepare("DELETE FROM execution_approval_publications WHERE delegation_instance_id='current'").run(), /Pending/);
  const reopened = new ExecutionApprovalPublicationStore(database);
  assert.equal(reopened.get(current)!.state, "attempted");
  database.close();
});

test("capacity preserves unexpired receipts and fails closed when all remaining custody is required", () => {
  const database = new DatabaseSync(":memory:");
  applyExecutionApprovalPublicationSchema(database);
  const store = new ExecutionApprovalPublicationStore(database);
  const atMs = Date.now();
  const expiredPin = { ...pin(), producedAtMs: atMs - 2_000, expiresAtMs: atMs - 1 };
  const attempted = store.markAttempted(store.pin(expiredPin, atMs - 1_500));
  store.acknowledge(attempted, {
    publicationId: "publication",
    publicationDigest: sha("publication"),
    publishedAtMs: atMs - 1_000,
  });
  fillPublicationCapacity(database, { expires_at_ms: String(atMs + 60_000) });

  const current = { ...pin(), delegationInstanceId: "current", producedAtMs: atMs, expiresAtMs: atMs + 60_000 };
  assert.equal(store.pin(current, atMs).state, "open", "only the expired acknowledged receipt is compacted");
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM execution_approval_publications").get()!.n, 10_000);
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM execution_approval_publications
    WHERE state='acknowledged' AND expires_at_ms>?`).get(atMs)!.n, 9_999);
  assert.throws(() => store.pin({ ...current, delegationInstanceId: "overflow" }, atMs), /capacity reached/);
  assert.equal(store.get(current)!.state, "open");
  database.close();
});

test("HTTP verifies the shared stable publication digest and preserves terminal server codes", async t => {
  const value = publication();
  const digest = executionApprovalPublicationSha256(value);
  assert.ok(digest);
  assert.equal(executionApprovalPublicationSha256(Object.fromEntries(Object.entries(value).reverse())), digest,
    "publication digest does not depend on object insertion order or process locale");
  const base = {
    apiOrigin: "https://letagents.test",
    grantId: "grant",
    supervisorGrant: "PRIVATE_GRANT",
    grantGeneration: 1,
    sessionId: "session",
    agentKey: "owner/agent",
    publication: value,
    signal: new AbortController().signal,
  };
  const responses: Response[] = [
    new Response(JSON.stringify({
      status: "created",
      publication_digest: digest,
      publication: {
        publication_id: "publication",
        room_id: value.room_id,
        agent_key: "owner/agent",
        delegation_instance_id: value.delegation_instance_id,
        delegation_revision: value.delegation_revision,
        request_id: value.request_id,
        request_version: value.request_version,
        request_sha256: value.request_sha256,
        projection_sha256: value.projection_sha256,
        published_at: "2026-08-31T00:00:00.000Z",
        expires_at: value.expires_at,
      },
    }), { status: 201, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ code: "publication_terminal" }), { status: 409 }),
    new Response(JSON.stringify({ code: "delegation_revision_conflict" }), { status: 409 }),
    new Response(JSON.stringify({ code: "publisher_not_authorized" }), { status: 403 }),
    new Response(JSON.stringify({ code: "publication_conflict" }), { status: 409 }),
    new Response(JSON.stringify({ code: "publication_work_not_ready" }), { status: 409 }),
    new Response(JSON.stringify({ code: "publication_capacity" }), { status: 409 }),
    new Response(JSON.stringify({ status: "closed", publication_id: "publication",
      publication_digest: digest, closed_at: "2026-08-31T00:00:30.000Z" }), { status: 200 }),
    new Response(JSON.stringify({ status: "replayed", publication_id: "publication",
      publication_digest: digest, closed_at: "2026-08-31T00:00:30.000Z" }), { status: 200 }),
    new Response(JSON.stringify({ code: "publication_conflict" }), { status: 409 }),
    new Response(JSON.stringify({ code: "publication_terminal" }), { status: 409 }),
    new Response(JSON.stringify({ code: "publisher_not_authorized" }), { status: 403 }),
  ];
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push({ input: String(input), init });
    return responses.shift()!;
  });
  assert.deepEqual(await publishExecutionApproval(base), {
    status: "acknowledged",
    publicationId: "publication",
    publicationDigest: digest,
    publishedAtMs: Date.parse("2026-08-31T00:00:00.000Z"),
  });
  assert.deepEqual(await publishExecutionApproval(base), { status: "terminal", reason: "expired" });
  assert.deepEqual(await publishExecutionApproval(base), { status: "terminal", reason: "invalid_delegation" });
  assert.deepEqual(await publishExecutionApproval(base), { status: "terminal", reason: "invalid_delegation" });
  assert.deepEqual(await publishExecutionApproval(base), { status: "conflict" });
  await assert.rejects(publishExecutionApproval(base), /publication work custody failed with HTTP 409/);
  await assert.rejects(publishExecutionApproval(base), /publication capacity failed with HTTP 409/);
  const close = { ...base, publicationId: "publication", publicationDigest: digest };
  assert.deepEqual(await closeExecutionApprovalPublication(close), {
    status: "closed", closedAtMs: Date.parse("2026-08-31T00:00:30.000Z"),
  });
  assert.deepEqual(JSON.parse(String(requests.at(-1)!.init?.body)), { publication_digest: digest });
  assert.match(requests.at(-1)!.input, /execution-approval-publications\/publication\/close$/);
  assert.deepEqual(await closeExecutionApprovalPublication(close), {
    status: "closed", closedAtMs: Date.parse("2026-08-31T00:00:30.000Z"),
  });
  assert.deepEqual(await closeExecutionApprovalPublication(close), { status: "conflict" });
  assert.deepEqual(await closeExecutionApprovalPublication(close), { status: "terminal", reason: "expired" });
  assert.deepEqual(await closeExecutionApprovalPublication(close), { status: "terminal", reason: "invalid_delegation" });
});
