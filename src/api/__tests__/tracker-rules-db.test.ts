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
// Pull request numbers are unique per run: a reused database keeps earlier
// runs' events, and the projection treats a repeat as a redelivery.
const PR_BASE = Math.floor(Date.now() / 1000) % 1_000_000 * 100;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;

/** A tracker executor that records each write instead of calling Jira. */
function fakeTracker() {
  const created: Array<{ kind: string; payload: Record<string, unknown>; correlation_key: string }> = [];
  /** Kinds the tracker refuses, with how many more refusals (Infinity: always). */
  const refuse = new Map<string, number>();
  const executor: WorkflowEffectExecutor = {
    async create(effect: WorkflowEffect) {
      created.push({ kind: effect.kind, payload: effect.request_payload, correlation_key: effect.correlation_key });
      const left = refuse.get(effect.kind) ?? 0;
      if (left > 0) {
        refuse.set(effect.kind, left - 1);
        return { kind: "definite_failure", error: "Jira answered 503." };
      }
      return { kind: "succeeded", external_id: `jira-${created.length}`, external_url: null, response_payload: null };
    },
    async lookup() {
      return { kind: "not_found" };
    },
  };
  return { created, executor, refuse };
}

async function bindTicket(connectionId: string, roomId: string, taskId: string, key = "HT-1234"): Promise<string> {
  const itemId = `xitem_${crypto.randomUUID()}`;
  await client!.db.insert(schema!.external_items).values({
    id: itemId, connection_id: connectionId, provider: "jira", key, title: "Proration", ticket_state: "todo",
    raw_status: "To Do", synced_at: new Date().toISOString(),
  }).onConflictDoNothing();
  const [row] = await client!.pool.query("SELECT id FROM external_items WHERE connection_id = $1 AND key = $2", [connectionId, key]).then((result) => result.rows);
  await client!.pool.query("UPDATE tasks SET external_item_id = $1 WHERE room_id = $2 AND number = $3",
    [row.id, roomId, Number(taskId.replace(/\D+/g, ""))]);
  return row.id;
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
  await db!.assignProjectAdmin(room.id, accountId);
  await filters!.upsertRoomTrackerFilter({
    room_id: room.id, connection_id: connectionId, provider: "jira", filter: "project = HT", enabled: true, account_id: accountId,
  });
  const created = await db!.createTask(room.id, "Proration", "human", undefined, undefined, { externalRef: "jira:HT-1234" });
  await db!.updateTask(room.id, created.id, { status: "accepted" });
  // Sync binds the card to the ticket it imported through this connection.
  const itemId = await bindTicket(connectionId, room.id, created.id);
  const card = (await db!.getTaskById(room.id, created.id))!;
  const bound = await client!.pool.query("SELECT external_item_id FROM tasks WHERE room_id = $1 AND number = $2",
    [room.id, Number(card.id.replace(/\D+/g, ""))]);
  assert.equal(bound.rows[0].external_item_id, itemId);

  const tracker = fakeTracker();
  const clock = { now: new Date() };
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
    now: () => clock.now,
  });
  const pending: Array<Promise<void>> = [];
  const engine = engineModule!.createTrackerRuleEngine({
    store: rules!.trackerRuleStore,
    roomScope: filters!.getRoomTrackerScope,
    roomConnection: engineModule!.findRoomRuleConnection,
    ticketBound: engineModule!.isTicketBoundToConnection,
    ownerIsRoomAdmin: engineModule!.isRoomAdminAccount,
    countApprovals: engineModule!.countPullRequestApprovals,
    reserve: (input) => broker.reserveTrackerEffect(input),
    drive: (reserved) => broker.driveTrackerEffect(reserved),
    getEffect: (id) => broker.getEffect(id),
    schedule: (work) => { pending.push(work()); },
  });
  const settle = async () => { await Promise.all(pending.splice(0)); };
  return { accountId, connectionId, room, card, tracker, engine, settle, broker, clock };
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

function openedPayload(number = PR_BASE + 91, extra: { draft?: boolean; association?: string } = {}) {
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
  return {
    ...payload,
    pull_request: { ...payload.pull_request, base: { ref: "main" }, author_association: extra.association ?? "MEMBER" },
  };
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
    ["tracker_transition", "succeeded", `${rule.id}:${deliveryId}:jira:HT-1234:0`],
    ["tracker_comment", "succeeded", `${rule.id}:${deliveryId}:jira:HT-1234:1`],
  ]);
  assert.equal(effects[0]!.request_payload.to_status, "In Review");
  assert.equal(effects[1]!.request_payload.body,
    `PR ${PR_BASE + 91} by octocat on HT-1234-fix-proration-rounding: https://github.com/BrosInCode/letagents/pull/${PR_BASE + 91}`);
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
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 92));
  assert.equal((await effectRows(context.room.id)).length, 0);
  assert.equal((await runRows(context.room.id)).length, 0);

  await rules!.trackerRuleStore.setEnabled(context.connectionId, rule.id, true);
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 93, { draft: true }));
  assert.equal((await effectRows(context.room.id)).length, 0, "a draft PR does not match draft: false");
  assert.equal(context.tracker.created.length, 0);
});

test("a tracker_ticket sync event never triggers a rule", options, async () => {
  const context = await setup("sync");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  const pullRequest = openedPayload(PR_BASE + 94);
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
      matchedByTicketKey: true,
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
  const otherCreated = await db!.createTask(other.id, "Proration", "human", undefined, undefined, { externalRef: "jira:HT-1234" });
  await bindTicket(context.connectionId, other.id, otherCreated.id);
  const otherCard = (await db!.getTaskById(other.id, otherCreated.id))!;
  const deliveryId = unique("delivery");
  const roomEvent = materialize!.materializeGitHubWebhookEvent("pull_request", openedPayload(PR_BASE + 95) as never, deliveryId)!.roomEvent!;
  const storedEvent = { event_type: "pull_request", metadata: {}, base_ref: "main", head_ref: "HT-1234-fix-proration-rounding" };
  const first = await context.engine.runForRepoEvent({ deliveryId, storedEvent, eventRoomId: context.room.id, roomEvent, task: context.card, matchedByTicketKey: true });
  const second = await context.engine.runForRepoEvent({ deliveryId, storedEvent, eventRoomId: other.id, roomEvent, task: otherCard, matchedByTicketKey: true });
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
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 96));
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

test("a PR from an outside author, or a card the connection never bound, writes nothing", options, async () => {
  const context = await setup("trust");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  // Anyone can open a pull request on a public repository and name a key.
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 97, { association: "NONE" }));
  assert.equal((await effectRows(context.room.id)).length, 0);
  const skipped = await runRows(context.room.id);
  assert.deepEqual(skipped.map((run) => [run.outcome, run.detail]), [["skipped", "untrusted_actor"]], "the owner sees why");
  const audit = await governance!.listBoardGovernanceAudit(context.room.id);
  assert.match(audit.find((entry) => entry.kind === "tracker_rule_run")?.reason ?? "", /no write access/);

  // A key typed onto a card by hand is not a ticket sync bound through this connection.
  const loose = await db!.createTask(context.room.id, "Loose", "human", undefined, undefined, { externalRef: "jira:HR-17" });
  const roomEvent = materialize!.materializeGitHubWebhookEvent("pull_request", openedPayload(PR_BASE + 98) as never, unique("loose"))!.roomEvent!;
  const result = await context.engine.runForRepoEvent({
    deliveryId: unique("loose"),
    storedEvent: { event_type: "pull_request", metadata: {}, base_ref: "main" },
    eventRoomId: context.room.id,
    roomEvent,
    task: loose,
    matchedByTicketKey: true,
  });
  // Bound to the cached item of another key: refused as well.
  await bindTicket(context.connectionId, context.room.id, loose.id);
  const forged = await context.engine.runForRepoEvent({
    deliveryId: unique("forged"),
    storedEvent: { event_type: "pull_request", metadata: {}, base_ref: "main" },
    eventRoomId: context.room.id,
    roomEvent,
    task: loose,
    matchedByTicketKey: true,
  });
  await context.settle();
  assert.deepEqual([result.runs, forged.runs], [[], []]);
  assert.equal(context.tracker.created.length, 0);
});

test("a rule runs once per ticket and event within the debounce window", options, async () => {
  const context = await setup("debounce");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 99));
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 100));
  assert.equal(context.tracker.created.length, 2, "the second opened PR within the window writes nothing");
  assert.deepEqual((await runRows(context.room.id)).map((run) => [run.outcome, run.detail]),
    [["succeeded", null], ["skipped", "debounced"]]);
});

test("a transition the tracker refuses once is retried by the sweep, and then the comment posts", options, async () => {
  const context = await setup("retry");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  context.tracker.refuse.set("tracker_transition", 1);
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 101));
  assert.deepEqual(context.tracker.created.map((entry) => entry.kind), ["tracker_transition"]);
  assert.deepEqual((await effectRows(context.room.id)).map((effect) => [effect.kind, effect.state]), [["tracker_transition", "failed"]],
    "the comment is not reserved while the transition can still be retried");
  assert.equal((await runRows(context.room.id))[0]!.outcome, "pending");
  let audit = await governance!.listBoardGovernanceAudit(context.room.id);
  assert.equal(audit.find((entry) => entry.kind === "tracker_rule_run")?.metadata?.outcome, "failed", "the audit shows the retrying write");

  // The journal sweep retries the transition after its backoff; then the run continues.
  context.clock.now = new Date(Date.now() + 5 * 60_000);
  await context.broker.sweepOnce();
  await context.engine.advancePendingRuns();
  await context.settle();
  assert.deepEqual(context.tracker.created.map((entry) => entry.kind), ["tracker_transition", "tracker_transition", "tracker_comment"]);
  assert.deepEqual((await effectRows(context.room.id)).map((effect) => [effect.kind, effect.state]),
    [["tracker_transition", "succeeded"], ["tracker_comment", "succeeded"]]);
  assert.equal((await runRows(context.room.id))[0]!.outcome, "succeeded");
  audit = await governance!.listBoardGovernanceAudit(context.room.id);
  assert.equal(audit.find((entry) => entry.kind === "tracker_rule_run")?.metadata?.outcome, "succeeded");
});

test("a transition refused until no attempts are left ends the run without the comment", options, async () => {
  const context = await setup("dead");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  context.tracker.refuse.set("tracker_transition", Infinity);
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 102));
  for (let minutes = 5; minutes <= 20; minutes += 5) {
    context.clock.now = new Date(Date.now() + minutes * 60_000);
    await context.broker.sweepOnce();
    await context.engine.advancePendingRuns();
  }
  await context.settle();
  assert.ok(context.tracker.created.every((entry) => entry.kind === "tracker_transition"));
  assert.deepEqual((await effectRows(context.room.id)).map((effect) => effect.kind), ["tracker_transition"]);
  assert.equal((await runRows(context.room.id))[0]!.outcome, "failed");
});

test("a pull request URL set by hand on an imported card runs no rule", options, async () => {
  const context = await setup("pr-url");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  const number = PR_BASE + 103;
  // A room member points the card at a pull request that does not name the
  // ticket, and an agent holds the card's work lease for it: the projection
  // accepts the link, but it is not the ticket key.
  const prUrl = `https://github.com/BrosInCode/letagents/pull/${number}`;
  await db!.updateTask(context.room.id, context.card.id, { pr_url: prUrl });
  await db!.createTaskLease({
    room_id: context.room.id, task_id: context.card.id, kind: "work", agent_key: "agent-1", actor_label: "Agent | emmy | codex",
    created_by: "Agent | emmy | codex", branch_ref: "feature/unrelated", pr_url: prUrl,
  });
  let accepted = false;
  const original = context.engine.runForRepoEvent;
  context.engine.runForRepoEvent = async (input) => {
    accepted = input.task.id === context.card.id && input.matchedByTicketKey === false;
    return original(input);
  };
  const payload = buildPullRequestPayload({
    number, title: "Unrelated change", body: "", url: `https://github.com/BrosInCode/letagents/pull/${number}`,
    branchRef: "feature/unrelated", sha: `sha-${number}`, actor: "kai",
  });
  await deliver(context, unique("delivery"), {
    ...payload, pull_request: { ...payload.pull_request, base: { ref: "main" }, author_association: "MEMBER" },
  });
  assert.equal(accepted, true, "the projection accepted the lease link and asked the engine");
  assert.equal((await effectRows(context.room.id)).length, 0);
  assert.equal((await runRows(context.room.id)).length, 0);
  assert.equal(context.tracker.created.length, 0);
});

test("a rule stops when the filter's owner is no longer a room admin", options, async () => {
  const context = await setup("admin");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  await client!.pool.query("DELETE FROM project_admins WHERE project_id = $1", [context.room.id]);
  await deliver(context, unique("delivery"), openedPayload(PR_BASE + 104));
  assert.equal(context.tracker.created.length, 0);
  assert.deepEqual((await runRows(context.room.id)).map((run) => [run.outcome, run.detail]), [["skipped", "owner_not_admin"]]);
});
