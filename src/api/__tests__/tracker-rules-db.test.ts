import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { TrackerRuleInput } from "../../../shared/ticket-connectors.mjs";
import type { WorkflowEffect } from "../db/types/effects.js";
import type { WorkflowEffectExecutor } from "../workflow-effects/broker.js";
import { buildPullRequestPayload } from "./github-webhook-integration/payloads.js";

const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
else process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.LETAGENTS_GITHUB_ENFORCEMENT_MODE = "off";
const client = url ? await import("../db/client.js") : null;
const db = url ? await import("../db.js") : null;
const schema = url ? await import("../db/schema.js") : null;
const filters = url ? await import("../connectors/room-filters.js") : null;
const rules = url ? await import("../connectors/rules/store.js") : null;
const engineModule = url ? await import("../connectors/rules/engine.js") : null;
const brokerModule = url ? await import("../workflow-effects/broker.js") : null;
const projection = url ? await import("../github/room-event-projection.js") : null;
const materialize = url ? await import("../github/room-events/materialize.js") : null;
const governance = url ? await import("../db/coordination/board-governance.js") : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? "Set TEST_DB_URL to run PostgreSQL integration tests." : false };

let sequence = 0;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;

/** A tracker executor that records each write instead of calling Jira. */
function fakeTracker() {
  const created: Array<{ kind: string; payload: Record<string, unknown>; correlation_key: string }> = [];
  const executor: WorkflowEffectExecutor = {
    async create(effect: WorkflowEffect) {
      created.push({ kind: effect.kind, payload: effect.request_payload, correlation_key: effect.correlation_key });
      return { kind: "succeeded", external_id: `jira-${created.length}`, external_url: null, response_payload: null };
    },
    async lookup() {
      return { kind: "not_found" };
    },
  };
  return { created, executor };
}

async function setup(label: string) {
  const now = new Date().toISOString();
  const accountId = unique(`acct-${label}`);
  await client!.db.insert(schema!.accounts).values({
    id: accountId, provider: "github", provider_user_id: accountId, login: accountId, display_name: accountId,
    avatar_url: null, created_at: now, updated_at: now,
  });
  const connectionId = `tcon_${crypto.randomUUID()}`;
  await client!.db.insert(schema!.tracker_connections).values({
    id: connectionId, account_id: accountId, provider: "jira", display_name: "acme", site_key: unique("acme.atlassian.net"),
    site_url: "https://acme.atlassian.net", auth_kind: "api_token", credentials_ciphertext: "sealed", credentials_iv: "iv",
    credentials_version: 1, tracker_user_id: "acc-1", tracker_user_label: "Emmy", status_map: {},
  });
  const room = await db!.createProjectWithName(unique(`rules-${label}`));
  await filters!.upsertRoomTrackerFilter({
    room_id: room.id, connection_id: connectionId, provider: "jira", filter: "project = HT", enabled: true, account_id: accountId,
  });
  const card = await db!.createTask(room.id, "Proration", "human", undefined, undefined, { externalRef: "jira:HT-1234" });
  await db!.updateTask(room.id, card.id, { status: "accepted" });

  const tracker = fakeTracker();
  const broker = brokerModule!.createWorkflowEffectBroker({
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
    provider: { create: async () => { throw new Error("no GitHub"); }, lookup: async () => { throw new Error("no GitHub"); } } as never,
    tracker: tracker.executor,
  });
  const pending: Array<Promise<void>> = [];
  const engine = engineModule!.createTrackerRuleEngine({
    store: rules!.trackerRuleStore,
    roomScope: filters!.getRoomTrackerScope,
    roomConnection: engineModule!.findRoomRuleConnection,
    countApprovals: engineModule!.countPullRequestApprovals,
    submit: (input) => broker.submitTrackerEffect(input),
    schedule: (work) => { pending.push(work()); },
  });
  const settle = async () => { await Promise.all(pending.splice(0)); };
  return { accountId, connectionId, room, card, tracker, engine, settle };
}

const openedRule: TrackerRuleInput = {
  name: "Opened, not draft: In Review",
  room_id: null,
  trigger: { event: "pull_request", action: "opened", draft: false },
  actions: [
    { kind: "transition", toStatus: "In Review" },
    { kind: "comment", template: "PR {{pr_number}} by {{author}} on {{branch}}: {{pr_url}}" },
  ],
};

function openedPayload(number = 91, extra: { draft?: boolean } = {}) {
  const payload = buildPullRequestPayload({
    number,
    title: "Round proration",
    body: "",
    url: `https://github.com/BrosInCode/letagents/pull/${number}`,
    branchRef: "HT-1234-fix-proration-rounding",
    sha: `sha-${number}`,
    actor: "kai",
    draft: extra.draft,
  });
  return { ...payload, pull_request: { ...payload.pull_request, base: { ref: "main" } } };
}

async function deliver(
  context: Awaited<ReturnType<typeof setup>>,
  deliveryId: string,
  payload: Record<string, unknown>,
  input: { retryFailedDelivery?: boolean } = {},
) {
  const materialized = materialize!.materializeGitHubWebhookEvent("pull_request", payload as never, deliveryId);
  assert.ok(materialized);
  await db!.recordGitHubWebhookDelivery({ delivery_id: deliveryId, event_name: "pull_request", action: "opened", room_id: context.room.id });
  const result = await projection!.handleMaterializedGitHubRoomEvent(context.room, materialized, {
    deliveryId,
    installationId: null,
    githubRepoId: null,
    retryFailedDelivery: input.retryFailedDelivery,
    deps: {
      runTrackerRulesForRepoEvent: (event) => context.engine.runForRepoEvent(event),
      applyGitHubRefRoomLifecycle: async () => undefined,
    },
  });
  await context.settle();
  return result;
}

async function effectRows(roomId: string) {
  const result = await client!.pool.query(
    "SELECT kind, state, idempotency_key, request_payload FROM workflow_effects WHERE room_id = $1 ORDER BY idempotency_key", [roomId]);
  return result.rows as Array<{ kind: string; state: string; idempotency_key: string; request_payload: Record<string, unknown> }>;
}

async function runRows(roomId: string) {
  const result = await client!.pool.query("SELECT * FROM tracker_rule_runs WHERE room_id = $1 ORDER BY created_at", [roomId]);
  return result.rows as Array<Record<string, unknown>>;
}

test("a PR opened from HT-1234-x reserves two effects once, and a redelivery reserves nothing", options, async () => {
  const context = await setup("opened");
  const rule = await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);

  await deliver(context, unique("delivery"), openedPayload());
  const deliveryId = (await runRows(context.room.id))[0]?.delivery_id as string;
  const effects = await effectRows(context.room.id);
  assert.deepEqual(effects.map((effect) => [effect.kind, effect.state, effect.idempotency_key]), [
    ["tracker_transition", "succeeded", `${rule.id}:${deliveryId}:0`],
    ["tracker_comment", "succeeded", `${rule.id}:${deliveryId}:1`],
  ]);
  assert.equal(effects[0]!.request_payload.to_status, "In Review");
  assert.equal(effects[1]!.request_payload.body,
    "PR 91 by octocat on HT-1234-fix-proration-rounding: https://github.com/BrosInCode/letagents/pull/91");
  assert.deepEqual(context.tracker.created.map((entry) => [entry.kind, entry.payload.key]), [
    ["tracker_transition", "HT-1234"],
    ["tracker_comment", "HT-1234"],
  ], "the provider is called once for each action");

  const runs = await runRows(context.room.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.outcome, "succeeded");
  assert.equal(runs[0]!.task_id, context.card.id);
  assert.equal((runs[0]!.effect_ids as string[]).length, 2);

  // GitHub redelivers the same event: the projection sees a duplicate.
  await deliver(context, deliveryId, openedPayload());
  // The route retries a delivery it marked failed: the journal answers with the same rows.
  await deliver(context, deliveryId, openedPayload(), { retryFailedDelivery: true });
  assert.equal((await effectRows(context.room.id)).length, 2, "a redelivery reserves nothing new");
  assert.equal(context.tracker.created.length, 2, "and calls the tracker no more");
  assert.equal((await runRows(context.room.id)).length, 1);

  // The run shows in the board governance audit.
  const audit = await governance!.listBoardGovernanceAudit(context.room.id);
  const entry = audit.find((candidate) => candidate.kind === "tracker_rule_run");
  assert.ok(entry);
  assert.equal(entry.metadata?.rule_name, openedRule.name);
  assert.equal(entry.metadata?.task_id, context.card.id);
  assert.equal(entry.metadata?.event_type, "pull_request");
  assert.equal(entry.metadata?.event_action, "opened");
  assert.equal(entry.metadata?.outcome, "succeeded");
});

test("a disabled rule, and a rule whose trigger does not match, never fire", options, async () => {
  const context = await setup("disabled");
  const rule = await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  await rules!.trackerRuleStore.setEnabled(context.connectionId, rule.id, false);
  await deliver(context, unique("delivery"), openedPayload(92));
  assert.equal((await effectRows(context.room.id)).length, 0);
  assert.equal((await runRows(context.room.id)).length, 0);

  await rules!.trackerRuleStore.setEnabled(context.connectionId, rule.id, true);
  await deliver(context, unique("delivery"), openedPayload(93, { draft: true }));
  assert.equal((await effectRows(context.room.id)).length, 0, "a draft PR does not match draft: false");
  assert.equal(context.tracker.created.length, 0);
});

test("a tracker_ticket sync event never triggers a rule", options, async () => {
  const context = await setup("sync");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  const pullRequest = openedPayload(94);
  const roomEvent = materialize!.materializeGitHubWebhookEvent("pull_request", pullRequest as never, "sync-delivery")!.roomEvent!;
  // Even a sync event row that carries a repo-shaped room event is refused.
  for (const storedEvent of [
    { event_type: "tracker_ticket", metadata: { source: "tracker_sync" } },
    { event_type: "pull_request", metadata: { source: "tracker_sync" } },
  ]) {
    const result = await context.engine.runForRepoEvent({
      deliveryId: unique("sync"),
      storedEvent,
      eventRoomId: context.room.id,
      roomEvent,
      task: context.card,
    });
    assert.deepEqual(result.runs, []);
  }
  await context.settle();
  assert.equal((await effectRows(context.room.id)).length, 0);
  assert.equal(context.tracker.created.length, 0);
});

test("a rule for every room writes once when two rooms see the same delivery", options, async () => {
  const context = await setup("two-rooms");
  const rule = await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  const other = await db!.createProjectWithName(unique("rules-other"));
  await filters!.upsertRoomTrackerFilter({
    room_id: other.id, connection_id: context.connectionId, provider: "jira", filter: "project = HT", enabled: true, account_id: context.accountId,
  });
  const otherCard = await db!.createTask(other.id, "Proration", "human", undefined, undefined, { externalRef: "jira:HT-1234" });
  const deliveryId = unique("delivery");
  const roomEvent = materialize!.materializeGitHubWebhookEvent("pull_request", openedPayload(95) as never, deliveryId)!.roomEvent!;
  const storedEvent = { event_type: "pull_request", metadata: {}, base_ref: "main", head_ref: "HT-1234-fix-proration-rounding" };
  const first = await context.engine.runForRepoEvent({ deliveryId, storedEvent, eventRoomId: context.room.id, roomEvent, task: context.card });
  const second = await context.engine.runForRepoEvent({ deliveryId, storedEvent, eventRoomId: other.id, roomEvent, task: otherCard });
  await context.settle();
  assert.equal(first.runs.length, 1);
  assert.deepEqual(second.runs, []);
  assert.equal(context.tracker.created.length, 2);
  assert.equal((await effectRows(other.id)).length, 0);
  assert.ok((await effectRows(context.room.id)).every((effect) => effect.idempotency_key.startsWith(`${rule.id}:`)));
});

test("a rule on another account's connection, or a filter its owner did not set, never writes", options, async () => {
  const context = await setup("owner");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  // The room's filter now claims to be someone else's: rules must not act on it.
  await client!.pool.query("UPDATE room_tracker_filters SET created_by_account_id = 'someone-else' WHERE room_id = $1", [context.room.id]);
  await deliver(context, unique("delivery"), openedPayload(96));
  assert.equal((await effectRows(context.room.id)).length, 0);
  assert.equal(context.tracker.created.length, 0);
});

test("rule versions grow on update and rollback, and a run plans from the rule as it was", options, async () => {
  const context = await setup("versions");
  const rule = await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  const updated = await rules!.trackerRuleStore.update(context.connectionId, rule.id, context.accountId, {
    ...openedRule, name: "Renamed", actions: [{ kind: "transition", toStatus: "Code Review" }],
  });
  assert.equal(updated?.version, 2);
  assert.equal(await rules!.trackerRuleStore.get("tcon_other", rule.id), null, "a rule is found only under its own connection");
  const versions = await rules!.trackerRuleStore.versions(rule.id);
  assert.deepEqual(versions.map((version) => [version.version, version.name]), [[2, "Renamed"], [1, openedRule.name]]);
  const old = await rules!.trackerRuleStore.version(rule.id, 1);
  const rolledBack = await rules!.trackerRuleStore.update(context.connectionId, rule.id, context.accountId, {
    name: old!.name, room_id: old!.room_id, trigger: old!.trigger, actions: old!.actions,
  });
  assert.equal(rolledBack?.version, 3);
  assert.deepEqual(rolledBack?.actions, openedRule.actions);
});
