import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { TrackerRuleInput } from "../../../shared/ticket-connectors.mjs";
import type { WorkflowEffect } from "../db/types/effects.js";
import type { JevEndpoint } from "../messages/jev-conversation-routing.js";
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
const lookups = url ? await import("../connectors/jev/lookups.js") : null;
const jevStore = url ? await import("../connectors/jev/store.js") : null;
const jevLink = url ? await import("../connectors/jev-link.js") : null;
const intents = url ? await import("../db/coordination/board-intents.js") : null;
test.before(async () => { if (client) await migrate(client.db, { migrationsFolder: resolve("drizzle") }); });
test.after(async () => { await client?.pool.end(); });
const options = { skip: !url ? "Set TEST_DB_URL to run PostgreSQL integration tests." : false };

let sequence = 0;
const PR_BASE = Math.floor(Date.now() / 1000) % 1_000_000 * 100;
const unique = (label: string) => `${label}-${Date.now()}-${++sequence}`;
const endpoint: JevEndpoint = { provider: "typesafe", apiKey: "test-key", baseUrl: "https://jev.invalid", model: "jev-test", timeoutMs: 4_000 };

function fakeTracker() {
  const created: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const executor: WorkflowEffectExecutor = {
    async create(effect: WorkflowEffect) {
      created.push({ kind: effect.kind, payload: effect.request_payload });
      return { kind: "succeeded", external_id: `jira-${created.length}`, external_url: null, response_payload: null };
    },
    async lookup() {
      return { kind: "not_found" };
    },
  };
  return { created, executor };
}

/** A ticket synced through the connection and bound to a card in the room (what the room's filter imported). */
async function syncedCard(input: { roomId: string; connectionId: string; key: string; assignee: string; state?: string; title?: string }) {
  const created = await db!.createTask(input.roomId, input.title ?? `Ticket ${input.key}`, "human", undefined, undefined, { externalRef: `jira:${input.key}` });
  await db!.updateTask(input.roomId, created.id, { status: "accepted" });
  const itemId = `xitem_${crypto.randomUUID()}`;
  await client!.db.insert(schema!.external_items).values({
    id: itemId, connection_id: input.connectionId, provider: "jira", key: input.key, title: input.title ?? `Ticket ${input.key}`,
    ticket_state: input.state ?? "todo", raw_status: "To Do", assignee_id: input.assignee, synced_at: new Date().toISOString(),
  });
  await client!.pool.query("UPDATE tasks SET external_item_id = $1 WHERE room_id = $2 AND number = $3",
    [itemId, input.roomId, Number(created.id.replace(/\D+/g, ""))]);
  return created.id;
}

async function setup(label: string, input: { jev?: boolean } = {}) {
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
    credentials_version: 1, tracker_user_id: "acc-kai", tracker_user_label: "Kai", status_map: {},
    jev_linking_enabled: input.jev ?? true,
  });
  const room = await db!.createProjectWithName(unique(`jev-${label}`));
  await db!.assignProjectAdmin(room.id, accountId);
  await filters!.upsertRoomTrackerFilter({
    room_id: room.id, connection_id: connectionId, provider: "jira", filter: "project = HT", enabled: true, account_id: accountId,
  });

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
  const pending: Array<Promise<unknown>> = [];
  const engine = engineModule!.createTrackerRuleEngine({
    store: rules!.trackerRuleStore,
    roomScope: filters!.getRoomTrackerScope,
    roomConnection: engineModule!.findRoomRuleConnection,
    ticketBound: engineModule!.isTicketBoundToConnection,
    ownerIsRoomAdmin: engineModule!.isRoomAdminAccount,
    countApprovals: engineModule!.countPullRequestApprovals,
    reserve: (reserve) => broker.reserveTrackerEffect(reserve),
    drive: (reserved) => broker.driveTrackerEffect(reserved),
    getEffect: (id) => broker.getEffect(id),
    schedule: (work) => { pending.push(work()); },
  });
  const jev = { calls: 0, choice: "ticket_1", score: 0.93 };
  const service = jevLink!.createJevLinkService({
    endpoint: () => endpoint,
    // No live model call: the answer is fixed by the test.
    evaluate: async () => {
      jev.calls += 1;
      return { body: { answers: { ticket: { choice: jev.choice, probabilities: { [jev.choice]: jev.score } } } }, latencyMs: 4 };
    },
    questions: jevStore!.jevQuestionStore,
    intents: jevStore!.jevIntentStore,
    roomJevConnection: lookups!.findRoomJevConnection,
    authorTrackerUserId: lookups!.findAuthorTrackerUserId,
    candidates: lookups!.listJevLinkCandidates,
    commitSubjects: async () => [],
    getTask: db!.getTaskById,
    cardLocked: async (roomId, taskId) => (await db!.getActiveTaskLocks(roomId, taskId)).length > 0,
    writeArtifacts: (roomId, taskId, artifacts) => db!.updateTask(roomId, taskId, { workflow_artifacts: artifacts }),
    previewRules: (preview) => engine.previewForRepoEvent(preview),
    runApprovedPlan: (plan) => engine.runApprovedPlan(plan),
    createIntent: (created) => intents!.createBoardIntent({ room_id: created.room_id, action_type: "tracker_jev_link", task_id: created.task_id, payload: created.payload, proposer_actor_label: "jev" }),
    approveIntent: async (approval) => (await intents!.approveBoardIntent(approval))?.intent ?? null,
    denyIntent: intents!.denyBoardIntent,
    postMessage: async () => undefined,
    log: () => undefined,
  });
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { accountId, connectionId, room, tracker, engine, service, jev, pending, settle };
}

const openedRule: TrackerRuleInput = {
  name: "Opened: In Review",
  room_id: null,
  trigger: { event: "pull_request", action: "opened", draft: false },
  actions: [{ kind: "transition", toStatus: "In Review" }],
};
const pushedRule: TrackerRuleInput = {
  name: "New push: comment",
  room_id: null,
  trigger: { event: "pull_request", action: "synchronize" },
  actions: [{ kind: "comment", template: "New push on {{pr_url}}" }],
};

/** A pull request whose branch, title and body name no ticket key. */
function payload(author: string, number: number, action: "opened" | "synchronize" | "closed", sha: string) {
  const built = buildPullRequestPayload({
    number, title: "Round proration the right way", body: "Uses banker's rounding.",
    url: `https://github.com/BrosInCode/letagents/pull/${number}`, branchRef: "fix-proration-rounding", sha, actor: author,
  });
  return { ...built, action, pull_request: { ...built.pull_request, user: { login: author }, base: { ref: "main" }, author_association: "MEMBER" } };
}

async function deliver(context: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>) {
  const deliveryId = unique("delivery");
  const materialized = materialize!.materializeGitHubWebhookEvent("pull_request", body as never, deliveryId);
  assert.ok(materialized);
  await db!.recordGitHubWebhookDelivery({ delivery_id: deliveryId, event_name: "pull_request", action: String(body.action), room_id: context.room.id });
  await projection!.handleMaterializedGitHubRoomEvent(context.room, materialized, {
    deliveryId, installationId: null, githubRepoId: null,
    deps: {
      runTrackerRulesForRepoEvent: (event) => context.engine.runForRepoEvent(event),
      linkPullRequestWithJev: (input) => { context.pending.push(context.service.linkPullRequest(input)); },
      proposeForClosedPullRequestWithJev: () => undefined,
      applyGitHubRefRoomLifecycle: async () => undefined,
    },
  });
  await context.settle();
}

async function effects(roomId: string) {
  const result = await client!.pool.query("SELECT kind, state, idempotency_key FROM workflow_effects WHERE room_id = $1 ORDER BY created_at", [roomId]);
  return result.rows as Array<{ kind: string; state: string; idempotency_key: string }>;
}

async function jevIntents(roomId: string) {
  return (await intents!.listBoardIntents({ room_id: roomId, limit: 50 })).filter((intent) => intent.action_type === "tracker_jev_link");
}

async function linkMark(roomId: string, taskId: string, prUrl: string) {
  return (await db!.getTaskById(roomId, taskId))!.workflow_artifacts.find((artifact) => artifact.url === prUrl)?.linked_by ?? null;
}

test("the candidate set is bounded at 20 and excludes tickets outside the room's filter", options, async () => {
  const context = await setup("candidates");
  for (let index = 0; index < 25; index += 1) {
    await syncedCard({ roomId: context.room.id, connectionId: context.connectionId, key: `HT-${100 + index}`, assignee: "acc-kai" });
  }
  await syncedCard({ roomId: context.room.id, connectionId: context.connectionId, key: "HT-900", assignee: "acc-kai", state: "done" });
  await syncedCard({ roomId: context.room.id, connectionId: context.connectionId, key: "HT-901", assignee: "acc-someone-else" });
  // A ticket the connection can read but this room's filter never imported: no card is bound to it here.
  await client!.db.insert(schema!.external_items).values({
    id: `xitem_${crypto.randomUUID()}`, connection_id: context.connectionId, provider: "jira", key: "HT-902", title: "Outside the filter",
    ticket_state: "todo", raw_status: "To Do", assignee_id: "acc-kai", synced_at: new Date().toISOString(),
  });
  // Bound in another room that imports with the same connection.
  const other = await db!.createProjectWithName(unique("jev-other"));
  await filters!.upsertRoomTrackerFilter({ room_id: other.id, connection_id: context.connectionId, provider: "jira", filter: "project = OPS", enabled: true, account_id: context.accountId });
  await syncedCard({ roomId: other.id, connectionId: context.connectionId, key: "OPS-1", assignee: "acc-kai" });

  const candidates = await lookups!.listJevLinkCandidates({ roomId: context.room.id, connectionId: context.connectionId, trackerUserId: "acc-kai", limit: 50 });
  assert.equal(candidates.length, 20, "capped at 20 even when asked for more");
  const keys = new Set(candidates.map((candidate) => candidate.key));
  for (const excluded of ["HT-900", "HT-901", "HT-902", "OPS-1"]) assert.ok(!keys.has(excluded), `${excluded} is not a candidate`);
  assert.equal(await lookups!.findAuthorTrackerUserId({ login: context.accountId.toUpperCase(), provider: "jira", siteKey: (await client!.pool.query("SELECT site_key FROM tracker_connections WHERE id = $1", [context.connectionId])).rows[0].site_key }), "acc-kai");
  assert.equal(await lookups!.findAuthorTrackerUserId({ login: "nobody-here", provider: "jira", siteKey: "x" }), null);
});

test("Jev links a PR with no key: suggestion and intent, no effect; approval runs PR5 once; a suggestion never fires a rule", options, async () => {
  const context = await setup("link");
  const opened = await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, pushedRule);
  const taskId = await syncedCard({ roomId: context.room.id, connectionId: context.connectionId, key: "HT-1234", assignee: "acc-kai", title: "Proration rounds wrong" });
  const number = PR_BASE + 91;
  const prUrl = `https://github.com/BrosInCode/letagents/pull/${number}`;

  await deliver(context, payload(context.accountId, number, "opened", "sha-a"));
  assert.equal(context.jev.calls, 1);
  assert.equal(await linkMark(context.room.id, taskId, prUrl), "jev_suggested");
  const pending = await jevIntents(context.room.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.status, "pending");
  assert.equal(pending[0]!.payload.summary, 'Move HT-1234 to In Review? (rule "Opened: In Review")');
  assert.equal(pending[0]!.payload.rule_id, opened.id);
  assert.equal((await effects(context.room.id)).length, 0, "no effect before approval");
  assert.equal(context.tracker.created.length, 0);

  // A new push while the link is only a suggestion: the push rule matches, but a suggestion never fires a rule.
  await deliver(context, payload(context.accountId, number, "synchronize", "sha-b"));
  assert.equal((await effects(context.room.id)).length, 0);
  assert.equal(context.jev.calls, 1, "the PR now reaches the card by URL; Jev is not asked again");

  const approved = await context.service.approveIntent({ intent: pending[0]!, decisionBy: "emmy", reason: null });
  await context.settle();
  assert.equal(approved.run.status, "started");
  assert.deepEqual((await effects(context.room.id)).map((effect) => [effect.kind, effect.state, effect.idempotency_key]), [
    ["tracker_transition", "succeeded", `${opened.id}:jev:${pending[0]!.id}:jira:HT-1234:0`],
  ]);
  assert.equal(context.tracker.created.length, 1);
  assert.equal(await linkMark(context.room.id, taskId, prUrl), "jev_confirmed");
  assert.equal((await intents!.getBoardIntent({ room_id: context.room.id, intent_id: pending[0]!.id }))!.status, "used");

  // A retried approval runs nothing new.
  const used = (await intents!.getBoardIntent({ room_id: context.room.id, intent_id: pending[0]!.id }))!;
  const again = await context.service.approveIntent({ intent: used, decisionBy: "emmy", reason: null });
  await context.settle();
  assert.equal(again.run.status, "existing");
  assert.equal((await effects(context.room.id)).length, 1);
  assert.equal(context.tracker.created.length, 1);

  // Accepted once: later events run the PR5 automatic path.
  await deliver(context, payload(context.accountId, number, "synchronize", "sha-c"));
  const after = await effects(context.room.id);
  assert.deepEqual(after.map((effect) => effect.kind), ["tracker_transition", "tracker_comment"]);
});

test("denial detaches the suggestion and Jev is not asked again for that PR", options, async () => {
  const context = await setup("deny");
  await rules!.trackerRuleStore.create(context.connectionId, context.accountId, openedRule);
  const taskId = await syncedCard({ roomId: context.room.id, connectionId: context.connectionId, key: "HT-77", assignee: "acc-kai" });
  const number = PR_BASE + 92;
  const prUrl = `https://github.com/BrosInCode/letagents/pull/${number}`;
  await deliver(context, payload(context.accountId, number, "opened", "sha-a"));
  const [pending] = await jevIntents(context.room.id);
  assert.ok(pending);
  const denied = await context.service.denyIntent({ intent: pending, decisionBy: "emmy", reason: "wrong ticket" });
  assert.equal(denied.detached, true);
  assert.equal(await linkMark(context.room.id, taskId, prUrl), null, "the PR left the card");
  assert.equal((await effects(context.room.id)).length, 0);
  // The next push reaches no card; the rejection keeps Jev from suggesting the same link again.
  await deliver(context, payload(context.accountId, number, "synchronize", "sha-b"));
  assert.equal(context.jev.calls, 1);
  assert.equal(await linkMark(context.room.id, taskId, prUrl), null);
});

test("low confidence attaches a suggestion only; the switch off means no Jev call", options, async () => {
  const low = await setup("low");
  await rules!.trackerRuleStore.create(low.connectionId, low.accountId, openedRule);
  const taskId = await syncedCard({ roomId: low.room.id, connectionId: low.connectionId, key: "HT-55", assignee: "acc-kai" });
  low.jev.score = 0.5;
  const number = PR_BASE + 93;
  await deliver(low, payload(low.accountId, number, "opened", "sha-a"));
  assert.equal(await linkMark(low.room.id, taskId, `https://github.com/BrosInCode/letagents/pull/${number}`), "jev_suggested");
  assert.equal((await jevIntents(low.room.id)).length, 0);
  assert.equal((await effects(low.room.id)).length, 0);

  const off = await setup("off", { jev: false });
  await syncedCard({ roomId: off.room.id, connectionId: off.connectionId, key: "HT-56", assignee: "acc-kai" });
  await deliver(off, payload(off.accountId, PR_BASE + 94, "opened", "sha-a"));
  assert.equal(off.jev.calls, 0);
  const rows = await client!.pool.query("SELECT count(*)::int AS n FROM tracker_jev_questions WHERE room_id = $1", [off.room.id]);
  assert.equal(rows.rows[0].n, 0);
});

test("metrics count questions, outcomes and latency for the account's connections", options, async () => {
  const context = await setup("metrics");
  await syncedCard({ roomId: context.room.id, connectionId: context.connectionId, key: "HT-60", assignee: "acc-kai" });
  context.jev.choice = "none";
  await deliver(context, payload(context.accountId, PR_BASE + 95, "opened", "sha-a"));
  const metrics = await jevStore!.jevQuestionStore.metrics(context.accountId, new Date(Date.now() - 60_000));
  const link = metrics.kinds.find((kind) => kind.kind === "link")!;
  assert.equal(metrics.enabled_connections, 1);
  assert.equal(link.count, 1);
  assert.deepEqual(link.outcomes, { none: 1 });
  assert.equal(typeof link.latency_ms_avg, "number");
});

test("a client edit that changes a marked pull request's number drops the mark", options, async () => {
  const context = await setup("marks");
  const taskId = await syncedCard({ roomId: context.room.id, connectionId: context.connectionId, key: "HT-61", assignee: "acc-kai" });
  const prUrl = `https://github.com/BrosInCode/letagents/pull/${PR_BASE + 96}`;
  await db!.updateTask(context.room.id, taskId, { workflow_artifacts: [{ provider: "github", kind: "pull_request", number: PR_BASE + 96, url: prUrl, linked_by: "jev_confirmed" }] });
  // A client echoes the list without the mark (validation drops it): the mark stays.
  await db!.updateTask(context.room.id, taskId, { workflow_artifacts: [{ provider: "github", kind: "pull_request", number: PR_BASE + 96, url: prUrl, state: "open" }] });
  assert.equal(await linkMark(context.room.id, taskId, prUrl), "jev_confirmed");
  // A client changes the number under the same URL: the mark does not follow.
  await db!.updateTask(context.room.id, taskId, { workflow_artifacts: [{ provider: "github", kind: "pull_request", number: 999, url: prUrl }] });
  assert.equal(await linkMark(context.room.id, taskId, prUrl), null);
});
