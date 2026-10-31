import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_STATUS_MAPS } from "../../../shared/ticket-connectors.mjs";
import { createConnectionService } from "../connectors/connections.js";
import { createConnectorCipher } from "../connectors/crypto.js";
import { createTrackerEffectExecutor } from "../connectors/effects.js";
import { createJiraProvider } from "../connectors/providers/jira.js";
import { createLinearProvider } from "../connectors/providers/linear.js";
import { type WorkItemProvider, TrackerProviderError } from "../connectors/providers/types.js";
import type { TrackerConnectionRow, TrackerConnectionStore } from "../connectors/store.js";
import type { WorkflowEffect } from "../db/types/effects.js";
import {
  createWorkflowEffectBroker,
  WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS,
  WORKFLOW_EFFECT_PENDING_STALE_MS,
  TRACKER_TRANSITION_LOOKUPS_BEFORE_RETRY,
  type SubmitTrackerEffectInput,
  type WorkflowEffectStore,
} from "../workflow-effects/broker.js";
import type { GitHubReviewProvider } from "../workflow-effects/github-review-provider.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "connectors");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"));

/** The journal's state machine in memory, as the PostgreSQL store implements it. */
function memoryJournal() {
  const effects = new Map<string, WorkflowEffect>();
  const byKey = new Map<string, string>();
  let sequence = 0;
  const update = (id: string, values: Partial<WorkflowEffect>) => {
    const effect = effects.get(id);
    if (!effect) return null;
    const next = { ...effect, ...values };
    effects.set(id, next);
    return next;
  };
  const finish = (input: { id: string; processing_token: string }, values: Partial<WorkflowEffect>) => {
    const effect = effects.get(input.id);
    if (!effect || effect.processing_token !== input.processing_token) return null;
    return update(input.id, { ...values, processing_token: null, processing_started_at: null });
  };
  const store: WorkflowEffectStore = {
    async reserve() { throw new Error("GitHub verdicts are not used here"); },
    async reserveTracker(input) {
      const key = `${input.room_id}\0${input.idempotency_key}`;
      const existing = byKey.get(key);
      if (existing) return { effect: effects.get(existing)!, claimed: false, processing_token: null };
      const now = (input.now ?? new Date()).toISOString();
      const token = input.quarantine_reason ? null : `token_${++sequence}`;
      const effect: WorkflowEffect = {
        id: `effect_${++sequence}`,
        room_id: input.room_id,
        task_id: input.task_id,
        lease_id: null,
        kind: input.kind,
        provider: input.provider,
        idempotency_key: input.idempotency_key,
        correlation_key: `lae_${String(sequence).padStart(32, "0")}`,
        request_fingerprint: "fingerprint",
        request_payload: { ...input.request_payload, connection_id: input.connection_id },
        state: "pending",
        attempt_count: token ? 1 : 0,
        lookup_count: 0,
        max_attempts: input.max_attempts ?? 3,
        processing_token: token,
        processing_started_at: token ? now : null,
        next_attempt_at: null,
        external_id: null,
        external_url: null,
        response_payload: null,
        last_error: null,
        quarantined_at: token ? null : now,
        quarantine_reason: input.quarantine_reason ?? null,
        created_by: input.created_by,
        created_at: now,
        updated_at: now,
        completed_at: null,
      };
      effects.set(effect.id, effect);
      byKey.set(key, effect.id);
      return { effect, claimed: Boolean(token), processing_token: token };
    },
    async get(id) { return effects.get(id) ?? null; },
    async claimFailed(id, now = new Date()) {
      const effect = effects.get(id);
      if (!effect || effect.state !== "failed" || effect.processing_token || effect.attempt_count >= effect.max_attempts) return null;
      if (effect.next_attempt_at && effect.next_attempt_at > now.toISOString()) return null;
      const token = `token_${++sequence}`;
      return {
        effect: update(id, { state: "pending", attempt_count: effect.attempt_count + 1, processing_token: token, processing_started_at: now.toISOString(), next_attempt_at: null })!,
        processing_token: token,
      };
    },
    async claimAmbiguous(id, now = new Date()) {
      const effect = effects.get(id);
      if (!effect || effect.state !== "ambiguous" || effect.processing_token || effect.quarantined_at) return null;
      if (effect.next_attempt_at && effect.next_attempt_at > now.toISOString()) return null;
      const token = `token_${++sequence}`;
      return { effect: update(id, { processing_token: token, processing_started_at: now.toISOString() })!, processing_token: token };
    },
    async stalePendingToAmbiguous(id, staleBefore) {
      const effect = effects.get(id);
      if (!effect || effect.state !== "pending" || !effect.processing_started_at || effect.processing_started_at > staleBefore.toISOString()) return null;
      return update(id, { state: "ambiguous", processing_token: null, processing_started_at: null });
    },
    async succeed(input) {
      return finish(input, {
        state: "succeeded",
        external_id: input.external_id,
        external_url: input.external_url ?? null,
        response_payload: input.response_payload ?? null,
        last_error: null,
        completed_at: (input.now ?? new Date()).toISOString(),
      });
    },
    async fail(input) {
      const effect = effects.get(input.id);
      return finish(input, {
        state: "failed",
        last_error: input.error,
        next_attempt_at: input.next_attempt_at?.toISOString() ?? null,
        ...(input.exhaust && effect ? { attempt_count: effect.max_attempts } : {}),
      });
    },
    async ambiguous(input) {
      return finish(input, { state: "ambiguous", last_error: input.error, next_attempt_at: null });
    },
    async releaseLookup(input) {
      const lookups = (effects.get(input.id)?.lookup_count ?? 0) + 1;
      return finish(input, { state: "ambiguous", last_error: input.error, next_attempt_at: input.next_attempt_at.toISOString(), lookup_count: lookups });
    },
    async listReconcilable() { return [...effects.values()]; },
    async pruneSettled() { return 0; },
  };
  return { store, effects };
}

const unusedGitHub: GitHubReviewProvider = {
  async create() { throw new Error("not used"); },
  async lookup() { throw new Error("not used"); },
};

const cipher = createConnectorCipher(randomBytes(32).toString("hex"));

/** A connection store holding one encrypted Jira and one Linear connection. */
function connectionStore() {
  const rows = new Map<string, TrackerConnectionRow>();
  const statuses: Array<{ id: string; status: string; error: string | null }> = [];
  const add = (id: string, provider: "jira" | "linear", credentials: Record<string, unknown>) => {
    const sealed = cipher.encrypt(credentials, { connection_id: id, account_id: "acct_1" });
    rows.set(id, {
      id,
      account_id: "acct_1",
      provider,
      display_name: provider,
      site_key: provider,
      site_url: null,
      auth_kind: "api_token",
      credentials_ciphertext: sealed.ciphertext,
      credentials_iv: sealed.iv,
      credentials_version: sealed.version,
      tracker_user_id: "me",
      tracker_user_label: "Me",
      status_map: { ...DEFAULT_STATUS_MAPS[provider] },
      unmapped_statuses: [],
      jev_linking_enabled: false,
      status: "active",
      last_error: null,
      last_verified_at: null,
      created_at: "2026-10-21T00:00:00.000Z",
      updated_at: "2026-10-21T00:00:00.000Z",
    });
  };
  add("tcon_jira", "jira", { kind: "api_token", site_url: "https://acme.atlassian.net", email: "emmy@example.com", api_token: "ATATT3xFfGF0secretsecretsecret" });
  add("tcon_linear", "linear", { kind: "api_token", api_key: "lin_api_secretsecretsecretsecret" });
  const store = {
    async get(id: string) { return rows.get(id) ?? null; },
    async setStatus(id: string, status: string, error: string | null) { statuses.push({ id, status, error }); },
    async saveCredentials() { return true; },
  } as unknown as TrackerConnectionStore;
  return { store, rows, statuses };
}

function harness(providers: { jira: WorkItemProvider; linear: WorkItemProvider }, start = new Date("2026-10-21T10:00:00.000Z")) {
  let clock = start.getTime();
  const journal = memoryJournal();
  const connections = connectionStore();
  const service = createConnectionService({ store: connections.store, cipher, providers });
  const broker = createWorkflowEffectBroker({
    store: journal.store,
    provider: unusedGitHub,
    tracker: createTrackerEffectExecutor({ store: connections.store, service, providers }),
    now: () => new Date(clock),
  });
  return { broker, journal, connections, advance: (ms: number) => { clock += ms; } };
}

function stubProvider(overrides: Partial<WorkItemProvider>): WorkItemProvider {
  const fail = async () => { throw new Error("unexpected provider call"); };
  return {
    name: "jira",
    whoAmI: fail,
    listItems: fail,
    getItem: fail,
    listTransitions: fail,
    transition: fail,
    comment: fail,
    findTransition: fail,
    findComment: fail,
    ...overrides,
  } as WorkItemProvider;
}

function transition(overrides: Partial<SubmitTrackerEffectInput> = {}): SubmitTrackerEffectInput {
  return {
    room_id: "room_1",
    task_id: "task_7",
    connection_id: "tcon_jira",
    connection_account_id: "acct_1",
    provider: "jira",
    key: "ht-1234",
    idempotency_key: "rule_1:delivery_1:0",
    actor_label: "Rule: PR opened",
    action: { kind: "tracker_transition", to_status: "In Review" },
    ...overrides,
  };
}

test("tracker_transition succeeds once; a duplicate submission makes no second write", async () => {
  const calls: unknown[] = [];
  const jira = stubProvider({
    async transition(conn, key, toStatus, correlationKey) {
      calls.push({ key, toStatus, correlationKey, token: (conn.credentials as { api_token: string }).api_token });
      return { externalId: `${key}:transition:31`, url: "https://acme.atlassian.net/browse/HT-1234" };
    },
  });
  const { broker } = harness({ jira, linear: stubProvider({}) });
  const first = await broker.submitTrackerEffect(transition());
  const second = await broker.submitTrackerEffect(transition());
  assert.equal(first.state, "succeeded");
  assert.equal(first.external_id, "HT-1234:transition:31");
  assert.equal(first.lease_id, null);
  assert.equal(second.id, first.id);
  assert.deepEqual(calls, [{ key: "HT-1234", toStatus: "In Review", correlationKey: first.correlation_key, token: "ATATT3xFfGF0secretsecretsecret" }]);
  assert.ok(!JSON.stringify(first).includes("ATATT3x"), "credentials never reach the journal row");
});

test("tracker_comment succeeds and the comment carries the effect's correlation key", async () => {
  let marker = "";
  const linear = stubProvider({
    name: "linear",
    async comment(_conn, key, body, correlationKey) {
      marker = correlationKey;
      assert.equal(body, "PR #88 opened");
      return { externalId: "comment_1", url: `https://linear.app/x/issue/${key}#comment-1` };
    },
  });
  const { broker } = harness({ jira: stubProvider({}), linear });
  const effect = await broker.submitTrackerEffect(transition({
    connection_id: "tcon_linear",
    provider: "linear",
    key: "BIL-12",
    action: { kind: "tracker_comment", body: "  PR #88 opened  " },
  }));
  assert.equal(effect.kind, "tracker_comment");
  assert.equal(effect.state, "succeeded");
  assert.equal(marker, effect.correlation_key);
  assert.equal(effect.request_payload.body, "PR #88 opened");
});

test("a definite tracker failure is retried after the backoff and then succeeds", async () => {
  let attempts = 0;
  const jira = stubProvider({
    async transition() {
      attempts += 1;
      if (attempts === 1) throw new TrackerProviderError("definite", "Jira answered 400: transition screen requires a field", 400);
      return { externalId: "HT-1234:transition:31" };
    },
  });
  const { broker, advance } = harness({ jira, linear: stubProvider({}) });
  const failed = await broker.submitTrackerEffect(transition());
  assert.equal(failed.state, "failed");
  assert.match(failed.last_error ?? "", /400/);
  assert.ok(failed.next_attempt_at);
  // Before the backoff ends, a resubmission does not call the tracker again.
  assert.equal((await broker.submitTrackerEffect(transition())).state, "failed");
  assert.equal(attempts, 1);
  advance(60_000);
  const retried = await broker.reconcile(failed);
  assert.equal(retried.state, "succeeded");
  assert.equal(retried.attempt_count, 2);
  assert.equal(attempts, 2);
});

test("an auth failure fails the effect and marks the connection for reconnect", async () => {
  const jira = stubProvider({
    async transition() { throw new TrackerProviderError("auth", "Tracker answered 401: token ATATT3xFfGF0secretsecretsecret revoked", 401); },
  });
  const { broker, connections } = harness({ jira, linear: stubProvider({}) });
  const effect = await broker.submitTrackerEffect(transition());
  assert.equal(effect.state, "failed");
  assert.ok(!(effect.last_error ?? "").includes("ATATT3xFfGF0secret"), effect.last_error ?? "");
  assert.deepEqual(connections.statuses.map((entry) => [entry.id, entry.status]), [["tcon_jira", "needs_reauth"]]);
});

test("a removed connection fails definitely without a provider call", async () => {
  const { broker, connections } = harness({ jira: stubProvider({}), linear: stubProvider({}) });
  connections.rows.delete("tcon_jira");
  const effect = await broker.submitTrackerEffect(transition());
  assert.equal(effect.state, "failed");
  assert.match(effect.last_error ?? "", /removed/);
});

test("an ambiguous Jira comment is reconciled by its hidden marker, never written twice", async () => {
  const writes: string[] = [];
  let commentsListed = 0;
  let lastCorrelation = "";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/issue/HT-1234/comment")) {
      writes.push(url);
      lastCorrelation = JSON.parse(String(init.body)).properties[0].value.correlation_key;
      return new Response("upstream timeout", { status: 504 });
    }
    if (url.includes("/issue/HT-1234/comment?")) {
      commentsListed += 1;
      const page = fixture("jira-comments-with-marker") as { comments: Array<{ properties: Array<{ value: { correlation_key: string } }> }> };
      page.comments[0].properties[0].value.correlation_key = commentsListed === 1 ? "lae_someoneelse0000000000000000000" : lastCorrelation;
      return new Response(JSON.stringify(page), { status: 200 });
    }
    throw new Error(`Unexpected live request: ${url}`);
  }) as typeof fetch;
  const { broker, journal, advance } = harness({ jira: createJiraProvider({ fetchImpl, env: {} }), linear: createLinearProvider({ fetchImpl }) });
  const input = transition({ action: { kind: "tracker_comment", body: "PR #88 opened" } });
  const ambiguous = await broker.submitTrackerEffect(input);
  assert.equal(ambiguous.state, "ambiguous");
  assert.equal(writes.length, 1);

  // First lookup: the marker is not there yet. The effect stays ambiguous and
  // waits for the lookup interval; it is never recreated.
  const notYet = await broker.submitTrackerEffect(input);
  assert.equal(notYet.state, "ambiguous");
  assert.ok(notYet.next_attempt_at);
  assert.equal((await broker.submitTrackerEffect(input)).state, "ambiguous");
  assert.equal(commentsListed, 1);

  advance(WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS);
  const found = await broker.reconcile(journal.effects.get(ambiguous.id)!);
  assert.equal(found.state, "succeeded");
  assert.equal(found.external_id, "20055");
  assert.equal(writes.length, 1, "reconciliation never writes");
});

test("an ambiguous Linear transition is reconciled from issue history after a stale pending claim", async () => {
  let updates = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (body.includes("issueUpdate")) {
      updates += 1;
      throw new Error("socket hang up");
    }
    if (body.includes("history(")) return new Response(JSON.stringify(fixture("linear-issue-history")), { status: 200 });
    return new Response(JSON.stringify(fixture("linear-issue-with-states")), { status: 200 });
  }) as typeof fetch;
  const providers = { jira: createJiraProvider({ fetchImpl, env: {} }), linear: createLinearProvider({ fetchImpl }) };
  const { broker, journal, advance } = harness(providers);
  const effect = await broker.submitTrackerEffect(transition({ connection_id: "tcon_linear", provider: "linear", key: "BIL-12" }));
  assert.equal(effect.state, "ambiguous");
  assert.match(effect.last_error ?? "", /socket hang up/);
  advance(WORKFLOW_EFFECT_PENDING_STALE_MS);
  const reconciled = await broker.reconcile(journal.effects.get(effect.id)!);
  assert.equal(reconciled.state, "succeeded");
  assert.equal(reconciled.external_id, "BIL-12:history:h-2");
  assert.equal(updates, 1);
});

test("empty or oversized tracker comments are quarantined and never sent", async () => {
  const { broker } = harness({ jira: stubProvider({}), linear: stubProvider({}) });
  const empty = await broker.submitTrackerEffect(transition({ idempotency_key: "e", action: { kind: "tracker_comment", body: "   " } }));
  assert.equal(empty.state, "pending");
  assert.equal(empty.quarantine_reason, "Tracker comment is empty.");
  const big = await broker.submitTrackerEffect(transition({ idempotency_key: "b", action: { kind: "tracker_comment", body: "x".repeat(16_001) } }));
  assert.equal(big.quarantine_reason, "Tracker comment is too long.");
});

test("without a tracker executor, tracker effects fail without a write", async () => {
  const journal = memoryJournal();
  const broker = createWorkflowEffectBroker({ store: journal.store, provider: unusedGitHub });
  const effect = await broker.submitTrackerEffect(transition());
  assert.equal(effect.state, "failed");
  assert.match(effect.last_error ?? "", /not enabled/);
});

test("an ambiguous transition not found after three lookups is retried, and the retry reads the status first", async () => {
  let transitions = 0;
  let lookups = 0;
  const jira = stubProvider({
    async transition() {
      transitions += 1;
      if (transitions === 1) throw new TrackerProviderError("ambiguous", "Tracker answered 502", 502);
      return { externalId: "HT-1234:status:In Review" };
    },
    async findTransition() { lookups += 1; return null; },
  });
  const { broker, journal, advance } = harness({ jira, linear: stubProvider({}) });
  const effect = await broker.submitTrackerEffect(transition());
  assert.equal(effect.state, "ambiguous");
  for (let lookup = 1; lookup < TRACKER_TRANSITION_LOOKUPS_BEFORE_RETRY; lookup += 1) {
    const checked = await broker.reconcile(journal.effects.get(effect.id)!);
    assert.equal(checked.state, "ambiguous");
    assert.equal(checked.lookup_count, lookup);
    advance(WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS);
  }
  const failed = await broker.reconcile(journal.effects.get(effect.id)!);
  assert.equal(failed.state, "failed");
  assert.match(failed.last_error ?? "", /retried/);
  assert.equal(transitions, 1, "the third lookup itself does not write");
  const retried = await broker.reconcile(failed);
  assert.equal(retried.state, "succeeded");
  assert.equal(retried.attempt_count, 2);
  assert.equal(transitions, 2);
  assert.equal(lookups, TRACKER_TRANSITION_LOOKUPS_BEFORE_RETRY);
});

test("an ambiguous comment that is never found stays ambiguous and is never written again", async () => {
  let comments = 0;
  const jira = stubProvider({
    async comment() { comments += 1; throw new TrackerProviderError("ambiguous", "Tracker answered 504", 504); },
    async findComment() { return null; },
  });
  const { broker, journal, advance } = harness({ jira, linear: stubProvider({}) });
  const effect = await broker.submitTrackerEffect(transition({ action: { kind: "tracker_comment", body: "PR opened" } }));
  for (let lookup = 0; lookup < TRACKER_TRANSITION_LOOKUPS_BEFORE_RETRY + 2; lookup += 1) {
    const checked = await broker.reconcile(journal.effects.get(effect.id)!);
    assert.equal(checked.state, "ambiguous");
    advance(WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS);
  }
  assert.equal(comments, 1);
});

test("an ambiguous effect whose connection was removed fails for good", async () => {
  const jira = stubProvider({
    async transition() { throw new TrackerProviderError("ambiguous", "Tracker answered 502", 502); },
  });
  const { broker, journal, connections } = harness({ jira, linear: stubProvider({}) });
  const effect = await broker.submitTrackerEffect(transition());
  assert.equal(effect.state, "ambiguous");
  connections.rows.delete("tcon_jira");
  const gone = await broker.reconcile(journal.effects.get(effect.id)!);
  assert.equal(gone.state, "failed");
  assert.equal(gone.attempt_count, gone.max_attempts);
  assert.match(gone.last_error ?? "", /removed/);
  assert.equal((await broker.reconcile(gone)).state, "failed", "no retry is left");
});
