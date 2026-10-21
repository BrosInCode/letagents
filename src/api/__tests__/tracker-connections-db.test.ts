import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

const testDatabaseUrl = process.env.TEST_DB_URL;
if (testDatabaseUrl) process.env.DB_URL = testDatabaseUrl;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const client = testDatabaseUrl ? await import("../db/client.js") : null;
const db = testDatabaseUrl ? await import("../db.js") : null;
const schema = testDatabaseUrl ? await import("../db/schema.js") : null;
const { trackerConnectionStore } = await import("../connectors/store.js");
const { createWorkflowEffectBroker } = await import("../workflow-effects/broker.js");

async function reset(): Promise<void> {
  if (!client) throw new Error("DB-backed tracker connection tests require TEST_DB_URL");
  await client.pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.pool.query("CREATE SCHEMA public");
  await migrate(client.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

const skip = !testDatabaseUrl && "requires TEST_DB_URL";
if (testDatabaseUrl) {
  test.beforeEach(reset);
  test.after(async () => { await client?.pool.end(); });
}

let ordinal = 0;
async function account(): Promise<string> {
  const id = `tracker_account_${++ordinal}`;
  const now = new Date().toISOString();
  await client!.db.insert(schema!.accounts).values({
    id, provider: "github", provider_user_id: id, login: id, display_name: id, avatar_url: null, created_at: now, updated_at: now,
  });
  return id;
}

function connectionValues(accountId: string, id: string, siteKey = "acme.atlassian.net") {
  return {
    id,
    account_id: accountId,
    provider: "jira" as const,
    display_name: "acme",
    site_key: siteKey,
    site_url: `https://${siteKey}`,
    auth_kind: "api_token" as const,
    credentials_ciphertext: "sealed",
    credentials_iv: "iv",
    credentials_version: 1,
    tracker_user_id: "acc-1",
    tracker_user_label: "Emmy",
    status_map: { "To Do": "todo" },
  };
}

test("connections upsert per account and site, merge unmapped statuses, and stay account-scoped", { skip }, async () => {
  const owner = await account();
  const other = await account();
  const first = await trackerConnectionStore.upsert(connectionValues(owner, "tcon_1"));
  assert.equal(first.jev_linking_enabled, false);
  assert.equal(first.status, "active");
  assert.deepEqual(first.unmapped_statuses, []);
  const again = await trackerConnectionStore.upsert({ ...connectionValues(owner, "tcon_1"), credentials_ciphertext: "sealed-2" });
  assert.equal(again.id, "tcon_1");
  assert.equal(again.credentials_ciphertext, "sealed-2");
  // A different id for the same site never overwrites ciphertext bound to tcon_1.
  await assert.rejects(trackerConnectionStore.upsert(connectionValues(owner, "tcon_x")), /changed while it was saved/);
  assert.equal((await trackerConnectionStore.findBySite(owner, "jira", "acme.atlassian.net"))?.id, "tcon_1");

  // Credentials are replaced only over the sealed value the writer read.
  assert.equal(await trackerConnectionStore.saveCredentials("tcon_1", { ciphertext: "c3", iv: "iv3", version: 1 }, "stale-iv"), false);
  assert.equal(await trackerConnectionStore.saveCredentials("tcon_1", { ciphertext: "c3", iv: "iv3", version: 1 }, "iv"), true);
  assert.equal((await trackerConnectionStore.get("tcon_1"))?.credentials_ciphertext, "c3");
  assert.equal(await trackerConnectionStore.saveCredentials("tcon_1", { ciphertext: "c4", iv: "iv4", version: 1 }, "iv"), false);

  await trackerConnectionStore.addUnmapped("tcon_1", ["Blocked", "QA"]);
  await trackerConnectionStore.addUnmapped("tcon_1", ["QA", "Parked"]);
  assert.deepEqual([...(await trackerConnectionStore.get("tcon_1"))!.unmapped_statuses].sort(), ["Blocked", "Parked", "QA"]);

  assert.equal(await trackerConnectionStore.update("tcon_1", other, { jev_linking_enabled: true }), null);
  assert.equal((await trackerConnectionStore.update("tcon_1", owner, { jev_linking_enabled: true }))?.jev_linking_enabled, true);
  assert.equal((await trackerConnectionStore.list(other)).length, 0);
  assert.equal(await trackerConnectionStore.delete("tcon_1", other), false);
  assert.equal(await trackerConnectionStore.delete("tcon_1", owner), true);

  await trackerConnectionStore.upsert(connectionValues(owner, "tcon_2"));
  await client!.pool.query("DELETE FROM accounts WHERE id = $1", [owner]);
  assert.equal(await trackerConnectionStore.get("tcon_2"), null, "connections go with their account");
});

test("OAuth states are single use, provider bound and expire", { skip }, async () => {
  const owner = await account();
  const future = new Date(Date.now() + 60_000).toISOString();
  await trackerConnectionStore.createOAuthState({ state_hash: "h1", account_id: owner, provider: "linear", loopback_port: 49152, code_verifier: "v".repeat(43), expires_at: future });
  assert.deepEqual(await trackerConnectionStore.peekOAuthState("h1", "linear"), { loopback_port: 49152 });
  assert.equal(await trackerConnectionStore.peekOAuthState("h1", "jira"), null);
  assert.deepEqual(await trackerConnectionStore.consumeOAuthState("h1", "linear"), { account_id: owner, code_verifier: "v".repeat(43) });
  assert.equal(await trackerConnectionStore.consumeOAuthState("h1", "linear"), null);
  await trackerConnectionStore.createOAuthState({ state_hash: "h2", account_id: owner, provider: "jira", loopback_port: 49152, expires_at: future });
  assert.equal(await trackerConnectionStore.consumeOAuthState("h2", "linear"), null);
  assert.equal(await trackerConnectionStore.consumeOAuthState("h2", "jira"), null, "a wrong-provider try used it up");
  await trackerConnectionStore.createOAuthState({ state_hash: "h3", account_id: owner, provider: "jira", loopback_port: 49152, expires_at: new Date(Date.now() - 1).toISOString() });
  assert.equal(await trackerConnectionStore.consumeOAuthState("h3", "jira"), null);
});

test("the journal accepts tracker effects without a lease and still requires one for GitHub verdicts", { skip }, async () => {
  const owner = await account();
  await trackerConnectionStore.upsert(connectionValues(owner, "tcon_1"));
  const room = await db!.createProjectWithName("tracker-effects-room");
  const reserve = (overrides: Record<string, unknown> = {}) => db!.reserveTrackerWorkflowEffect({
    room_id: room.id,
    task_id: "task_1",
    connection_id: "tcon_1",
    connection_account_id: owner,
    kind: "tracker_transition",
    provider: "jira",
    idempotency_key: "rule_1:delivery_1:0",
    request_payload: { key: "HT-1234", to_status: "In Review" },
    created_by: "Rule",
    ...overrides,
  } as Parameters<typeof db.reserveTrackerWorkflowEffect>[0]);

  const first = await reserve();
  assert.equal(first.claimed, true);
  assert.equal(first.effect.lease_id, null);
  assert.equal(first.effect.request_payload.connection_id, "tcon_1");
  assert.match(first.effect.correlation_key, /^lae_[0-9a-f]{32}$/);
  const duplicate = await reserve();
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.effect.id, first.effect.id);
  await assert.rejects(reserve({ request_payload: { key: "HT-1234", to_status: "Done" } }), db!.WorkflowEffectIdempotencyConflictError);
  await assert.rejects(reserve({ idempotency_key: "other", connection_id: "tcon_missing" }), db!.WorkflowEffectConnectionUnavailableError);
  await assert.rejects(reserve({ idempotency_key: "other", provider: "linear" }), db!.WorkflowEffectConnectionUnavailableError);
  const stranger = await account();
  await assert.rejects(reserve({ idempotency_key: "other", connection_account_id: stranger }), db!.WorkflowEffectConnectionUnavailableError);

  await assert.rejects(client!.pool.query(`
    INSERT INTO workflow_effects (id, room_id, task_id, lease_id, kind, provider, idempotency_key, correlation_key,
      request_fingerprint, request_payload, created_by, created_at, updated_at)
    VALUES ('effect_bad', $1, 'task_1', NULL, 'github_review_verdict', 'github', 'k', 'c', 'f', '{}', 'x', now(), now())
  `, [room.id]), /workflow_effects_kind_provider_check/);
  await assert.rejects(client!.pool.query(`
    INSERT INTO workflow_effects (id, room_id, task_id, lease_id, kind, provider, idempotency_key, correlation_key,
      request_fingerprint, request_payload, created_by, created_at, updated_at)
    VALUES ('effect_bad2', $1, 'task_1', NULL, 'tracker_comment', 'github', 'k2', 'c2', 'f', '{}', 'x', now(), now())
  `, [room.id]), /workflow_effects_kind_provider_check/);
});

test("the broker runs a tracker effect through the PostgreSQL journal: failure, retry, success", { skip }, async () => {
  const owner = await account();
  await trackerConnectionStore.upsert(connectionValues(owner, "tcon_1"));
  const room = await db!.createProjectWithName("tracker-broker-room");
  let clock = Date.now();
  let attempts = 0;
  const broker = createWorkflowEffectBroker({
    store: {
      reserve: db!.reserveWorkflowEffect,
      reserveTracker: db!.reserveTrackerWorkflowEffect,
      get: db!.getWorkflowEffect,
      claimFailed: db!.claimFailedWorkflowEffect,
      claimAmbiguous: db!.claimAmbiguousWorkflowEffect,
      stalePendingToAmbiguous: db!.markStalePendingWorkflowEffectAmbiguous,
      succeed: db!.markWorkflowEffectSucceeded,
      fail: db!.markWorkflowEffectFailed,
      ambiguous: db!.markWorkflowEffectAmbiguous,
      releaseLookup: db!.releaseWorkflowEffectLookup,
      listReconcilable: db!.listReconcilableWorkflowEffects,
      pruneSettled: db!.pruneSettledWorkflowEffects,
    },
    provider: { async create() { throw new Error("unused"); }, async lookup() { throw new Error("unused"); } },
    tracker: {
      async create(effect) {
        attempts += 1;
        assert.equal(effect.kind, "tracker_comment");
        return attempts === 1
          ? { kind: "definite_failure", error: "Tracker answered 400" }
          : { kind: "succeeded", external_id: "20055", external_url: null, response_payload: { key: "HT-1234" } };
      },
      async lookup() { return { kind: "not_found" }; },
    },
    now: () => new Date(clock),
  });
  const input = {
    room_id: room.id,
    task_id: "task_1",
    connection_id: "tcon_1",
    connection_account_id: owner,
    provider: "jira" as const,
    key: "HT-1234",
    idempotency_key: "rule_1:delivery_9:1",
    actor_label: "Rule",
    action: { kind: "tracker_comment" as const, body: "PR opened" },
  };
  const failed = await broker.submitTrackerEffect(input);
  assert.equal(failed.state, "failed");
  clock += 60_000;
  assert.equal(await broker.sweepOnce(), 1);
  const settled = await db!.getWorkflowEffect(failed.id);
  assert.equal(settled?.state, "succeeded");
  assert.equal(settled?.external_id, "20055");
  assert.equal(settled?.attempt_count, 2);
  assert.equal((await broker.submitTrackerEffect(input)).state, "succeeded");
  assert.equal(attempts, 2);
});

test("lookups are counted and a removed connection exhausts the effect in PostgreSQL", { skip }, async () => {
  const owner = await account();
  await trackerConnectionStore.upsert(connectionValues(owner, "tcon_1"));
  const room = await db!.createProjectWithName("tracker-lookup-room");
  const reserved = await db!.reserveTrackerWorkflowEffect({
    room_id: room.id,
    task_id: "task_1",
    connection_id: "tcon_1",
    connection_account_id: owner,
    kind: "tracker_transition",
    provider: "jira",
    idempotency_key: "rule_1:delivery_2:0",
    request_payload: { key: "HT-1", to_status: "Done" },
    created_by: "Rule",
  });
  assert.equal(reserved.effect.lookup_count, 0);
  const ambiguous = await db!.markWorkflowEffectAmbiguous({ id: reserved.effect.id, processing_token: reserved.processing_token!, error: "502" });
  assert.equal(ambiguous?.state, "ambiguous");
  const claim = await db!.claimAmbiguousWorkflowEffect(reserved.effect.id);
  const released = await db!.releaseWorkflowEffectLookup({
    id: reserved.effect.id, processing_token: claim!.processing_token, error: "not found", next_attempt_at: new Date(),
  });
  assert.equal(released?.lookup_count, 1);
  const again = await db!.claimAmbiguousWorkflowEffect(reserved.effect.id);
  const failed = await db!.markWorkflowEffectFailed({
    id: reserved.effect.id, processing_token: again!.processing_token, error: "connection removed", next_attempt_at: null, exhaust: true,
  });
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.attempt_count, failed?.max_attempts);
  assert.equal(await db!.claimFailedWorkflowEffect(reserved.effect.id), null, "no retry is left");
});
