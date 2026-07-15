import assert from "node:assert/strict";
import test from "node:test";

import type { WorkflowEffect } from "../db/types/effects.js";
import {
  createWorkflowEffectBroker,
  WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS,
  type SubmitGitHubReviewVerdictInput,
  type WorkflowEffectStore,
} from "../workflow-effects/broker.js";
import type { GitHubReviewProvider } from "../workflow-effects/github-review-provider.js";

function makeMemoryStore() {
  const effects = new Map<string, WorkflowEffect>();
  const keyToId = new Map<string, string>();
  let sequence = 0;
  const token = () => `token_${++sequence}`;
  const put = (effect: WorkflowEffect) => {
    effects.set(effect.id, effect);
    return effect;
  };
  const update = (id: string, values: Partial<WorkflowEffect>) => {
    const effect = effects.get(id);
    if (!effect) return null;
    return put({ ...effect, ...values });
  };

  const store = {
    async reserve(input: any) {
      const key = `${input.room_id}\0${input.idempotency_key}`;
      const existingId = keyToId.get(key);
      if (existingId) {
        return { effect: effects.get(existingId)!, claimed: false, processing_token: null };
      }
      const quarantined = Boolean(input.quarantine_reason);
      const processingToken = quarantined ? null : token();
      const now = (input.now ?? new Date()).toISOString();
      const effect: WorkflowEffect = {
        id: `effect_${++sequence}`,
        room_id: input.room_id,
        task_id: input.task_id,
        lease_id: input.lease_id,
        kind: input.kind,
        provider: input.provider,
        idempotency_key: input.idempotency_key,
        correlation_key: `correlation_${input.idempotency_key}`,
        request_fingerprint: "fingerprint",
        request_payload: input.request_payload,
        state: "pending",
        attempt_count: quarantined ? 0 : 1,
        max_attempts: input.max_attempts ?? 3,
        processing_token: processingToken,
        processing_started_at: processingToken ? now : null,
        next_attempt_at: null,
        external_id: null,
        external_url: null,
        response_payload: null,
        last_error: null,
        quarantined_at: quarantined ? now : null,
        quarantine_reason: input.quarantine_reason ?? null,
        created_by: input.created_by,
        created_at: now,
        updated_at: now,
        completed_at: null,
      };
      keyToId.set(key, effect.id);
      put(effect);
      return { effect, claimed: Boolean(processingToken), processing_token: processingToken };
    },
    async get(id: string) { return effects.get(id) ?? null; },
    async claimFailed(id: string, now = new Date()) {
      const effect = effects.get(id);
      if (!effect || effect.state !== "failed" || effect.processing_token || effect.attempt_count >= effect.max_attempts) return null;
      if (effect.next_attempt_at && effect.next_attempt_at > now.toISOString()) return null;
      const processingToken = token();
      const claimed = update(id, {
        state: "pending",
        attempt_count: effect.attempt_count + 1,
        processing_token: processingToken,
        processing_started_at: now.toISOString(),
        next_attempt_at: null,
      })!;
      return { effect: claimed, processing_token: processingToken };
    },
    async claimAmbiguous(id: string, now = new Date()) {
      const effect = effects.get(id);
      if (
        !effect || effect.state !== "ambiguous" || effect.processing_token || effect.quarantined_at
        || (effect.next_attempt_at && effect.next_attempt_at > now.toISOString())
      ) return null;
      const processingToken = token();
      const claimed = update(id, {
        processing_token: processingToken,
        processing_started_at: now.toISOString(),
      })!;
      return { effect: claimed, processing_token: processingToken };
    },
    async stalePendingToAmbiguous(id: string, staleBefore: Date, now = new Date()) {
      const effect = effects.get(id);
      if (!effect || effect.state !== "pending" || !effect.processing_started_at || effect.processing_started_at > staleBefore.toISOString()) return null;
      return update(id, {
        state: "ambiguous",
        processing_token: null,
        processing_started_at: null,
        updated_at: now.toISOString(),
      });
    },
    async succeed(input: any) {
      const effect = effects.get(input.id);
      if (!effect || effect.processing_token !== input.processing_token) return null;
      return update(input.id, {
        state: "succeeded",
        processing_token: null,
        processing_started_at: null,
        external_id: input.external_id,
        external_url: input.external_url ?? null,
        response_payload: input.response_payload ?? null,
        completed_at: (input.now ?? new Date()).toISOString(),
        last_error: null,
      });
    },
    async fail(input: any) {
      const effect = effects.get(input.id);
      if (!effect || effect.processing_token !== input.processing_token) return null;
      return update(input.id, {
        state: "failed",
        processing_token: null,
        processing_started_at: null,
        last_error: input.error,
        next_attempt_at: input.next_attempt_at?.toISOString() ?? null,
      });
    },
    async ambiguous(input: any) {
      const effect = effects.get(input.id);
      if (!effect || effect.processing_token !== input.processing_token) return null;
      return update(input.id, {
        state: "ambiguous",
        processing_token: null,
        processing_started_at: null,
        last_error: input.error,
      });
    },
    async releaseLookup(input: any) {
      const released = await this.ambiguous(input);
      return released ? update(input.id, { next_attempt_at: input.next_attempt_at.toISOString() }) : null;
    },
    async listReconcilable(input: any) {
      return [...effects.values()].filter((effect) => {
        if (effect.quarantined_at) return false;
        if (effect.state === "ambiguous" && !effect.processing_token) {
          return !effect.next_attempt_at || effect.next_attempt_at <= input.now.toISOString();
        }
        if (effect.state === "failed" && effect.attempt_count < effect.max_attempts) {
          return !effect.next_attempt_at || effect.next_attempt_at <= input.now.toISOString();
        }
        return effect.state === "pending"
          && Boolean(effect.processing_started_at)
          && effect.processing_started_at! <= input.stale_before.toISOString();
      }).slice(0, input.limit);
    },
    async pruneSettled(input: any) {
      let deleted = 0;
      for (const effect of [...effects.values()]) {
        const settled = effect.state === "succeeded"
          || (effect.state === "failed" && effect.attempt_count >= effect.max_attempts)
          || Boolean(effect.quarantined_at);
        if (settled && effect.updated_at <= input.settled_before.toISOString()) {
          effects.delete(effect.id);
          deleted += 1;
          if (deleted >= input.limit) break;
        }
      }
      return deleted;
    },
  } as WorkflowEffectStore;

  return { store, effects };
}

function submission(overrides: Partial<SubmitGitHubReviewVerdictInput> = {}): SubmitGitHubReviewVerdictInput {
  return {
    room_id: "focus_37",
    task_id: "task_32",
    lease_id: "lease_review_1",
    lease_epoch: 0,
    agent_key: "owner/reviewer",
    agent_session_id: "session_1",
    actor_label: "Reviewer",
    idempotency_key: "verdict-head-abc",
    owner: "BrosInCode",
    repo: "letagents",
    pull_number: 777,
    expected_head_sha: "a".repeat(40),
    installation_id: "installation_1",
    verdict: "approve",
    body: "Verified exact head abc.",
    ...overrides,
  };
}

test("duplicate submissions with the same key create one provider effect", async () => {
  const { store } = makeMemoryStore();
  let creates = 0;
  const provider: GitHubReviewProvider = {
    async create(request) {
      creates += 1;
      assert.equal(request.expected_head_sha, "a".repeat(40));
      return { kind: "succeeded", external_id: "review_1", external_url: null, response_payload: {} };
    },
    async lookup() { return { kind: "not_found" }; },
  };
  const broker = createWorkflowEffectBroker({ store, provider });
  const first = await broker.submitGitHubReviewVerdict(submission());
  const second = await broker.submitGitHubReviewVerdict(submission());
  assert.equal(first.id, second.id);
  assert.equal(second.state, "succeeded");
  assert.equal(creates, 1);
});

test("crash after provider commit reconciles the marker without a second create", async () => {
  const { store, effects } = makeMemoryStore();
  let creates = 0;
  const provider: GitHubReviewProvider = {
    async create() {
      creates += 1;
      return { kind: "ambiguous", error: "must not recreate" };
    },
    async lookup() {
      return { kind: "found", external_id: "review_42", external_url: "https://github.com/review/42", response_payload: {} };
    },
  };
  const now = new Date("2026-07-15T12:00:00.000Z");
  const broker = createWorkflowEffectBroker({ store, provider, now: () => now });
  // Reservation committed, GitHub accepted the marker-bearing review, then the
  // process died before it could persist the provider result: the durable row
  // is still pending with an expired processing claim.
  const reserved = await store.reserve({
    room_id: "focus_37",
    task_id: "task_32",
    lease_id: "lease_review_1",
    lease_epoch: 0,
    agent_key: "owner/reviewer",
    agent_session_id: "session_1",
    kind: "github_review_verdict",
    provider: "github",
    idempotency_key: "verdict-head-abc",
    request_payload: {
      owner: "BrosInCode", repo: "letagents", pull_number: 777,
      expected_head_sha: "a".repeat(40),
      installation_id: "installation_1", verdict: "approve", body: "Verified.",
    },
    created_by: "Reviewer",
    now: new Date("2026-07-15T11:00:00.000Z"),
  });
  effects.set(reserved.effect.id, {
    ...reserved.effect,
    processing_started_at: "2026-07-15T11:00:00.000Z",
  });
  await broker.sweepOnce();
  const reconciled = await store.get(reserved.effect.id);
  assert.equal(reconciled?.state, "succeeded");
  assert.equal(reconciled?.external_id, "review_42");
  assert.equal(creates, 0);
});

test("ambiguous not-found remains ambiguous and is never blindly retried", async () => {
  const { store } = makeMemoryStore();
  let now = new Date("2026-07-15T00:00:00.000Z");
  let creates = 0;
  let lookups = 0;
  const provider: GitHubReviewProvider = {
    async create() {
      creates += 1;
      return { kind: "ambiguous", error: "timeout" };
    },
    async lookup() {
      lookups += 1;
      return { kind: "not_found" };
    },
  };
  const broker = createWorkflowEffectBroker({ store, provider, now: () => now });
  const submitted = await broker.submitGitHubReviewVerdict(submission());
  await broker.sweepOnce();
  await broker.sweepOnce();
  await broker.submitGitHubReviewVerdict(submission());
  assert.equal((await store.get(submitted.id))?.state, "ambiguous");
  assert.equal(creates, 1);
  assert.equal(lookups, 1, "persisted next_attempt_at suppresses every-sweep lookups");
  now = new Date(now.getTime() + WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS);
  await broker.sweepOnce();
  assert.equal(lookups, 2);
});

test("definite failures retry only to the bounded attempt limit", async () => {
  const { store } = makeMemoryStore();
  let now = new Date("2026-07-15T00:00:00.000Z");
  let creates = 0;
  const provider: GitHubReviewProvider = {
    async create() {
      creates += 1;
      return { kind: "definite_failure", error: "validation rejected" };
    },
    async lookup() { return { kind: "not_found" }; },
  };
  const broker = createWorkflowEffectBroker({ store, provider, now: () => now });
  const submitted = await broker.submitGitHubReviewVerdict(submission());
  for (let attempt = 0; attempt < 4; attempt += 1) {
    now = new Date(now.getTime() + 5 * 60_000);
    await broker.reconcile((await store.get(submitted.id))!);
  }
  assert.equal(creates, 3);
  assert.equal((await store.get(submitted.id))?.attempt_count, 3);
  assert.equal((await store.get(submitted.id))?.state, "failed");
});

test("empty or junk blocking verdicts are durably quarantined", async () => {
  const { store } = makeMemoryStore();
  let creates = 0;
  const provider: GitHubReviewProvider = {
    async create() { creates += 1; return { kind: "ambiguous", error: "must not run" }; },
    async lookup() { return { kind: "not_found" }; },
  };
  const broker = createWorkflowEffectBroker({ store, provider });
  const effect = await broker.submitGitHubReviewVerdict(submission({
    verdict: "request_changes",
    body: "asdf",
  }));
  assert.ok(effect.quarantined_at);
  assert.match(effect.quarantine_reason ?? "", /quarantined/i);
  assert.equal(effect.attempt_count, 0);
  assert.equal(creates, 0);
  assert.equal(await broker.sweepOnce(), 0);
});

test("multiword all-junk blocking verdicts are quarantined", async () => {
  for (const body of ["asdf asdf", "lorem ipsum", "junk testing qwerty"]) {
    const { store } = makeMemoryStore();
    let creates = 0;
    const provider: GitHubReviewProvider = {
      async create() { creates += 1; return { kind: "ambiguous", error: "must not run" }; },
      async lookup() { return { kind: "not_found" }; },
    };
    const broker = createWorkflowEffectBroker({ store, provider });
    const effect = await broker.submitGitHubReviewVerdict(submission({
      idempotency_key: `junk-${body}`,
      verdict: "request_changes",
      body,
    }));
    assert.ok(effect.quarantined_at, body);
    assert.equal(creates, 0, body);
  }
});

test("concurrent workers racing one logical key produce one effect", async () => {
  const { store, effects } = makeMemoryStore();
  let creates = 0;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const provider: GitHubReviewProvider = {
    async create() {
      creates += 1;
      await createGate;
      return { kind: "succeeded", external_id: "review_once", external_url: null, response_payload: {} };
    },
    async lookup() { return { kind: "not_found" }; },
  };
  const broker = createWorkflowEffectBroker({ store, provider });
  const first = broker.submitGitHubReviewVerdict(submission());
  const second = broker.submitGitHubReviewVerdict(submission());
  releaseCreate();
  const results = await Promise.all([first, second]);
  assert.equal(new Set(results.map((effect) => effect.id)).size, 1);
  assert.equal(effects.size, 1);
  assert.equal(creates, 1);
});
