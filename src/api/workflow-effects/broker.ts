import type { ReserveWorkflowEffectInput } from "../db/workflow-effects.js";
import type { WorkflowEffect } from "../db/types/effects.js";
import {
  type GitHubReviewEffectRequest,
  type GitHubReviewProvider,
  type GitHubReviewVerdict,
} from "./github-review-provider.js";

export const WORKFLOW_EFFECT_PENDING_STALE_MS = 2 * 60_000;
export const WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS = 5 * 60_000;
export const WORKFLOW_EFFECT_SETTLED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const FAILED_RETRY_BASE_MS = 30_000;

export interface WorkflowEffectStore {
  reserve(input: ReserveWorkflowEffectInput): Promise<{
    effect: WorkflowEffect;
    claimed: boolean;
    processing_token: string | null;
  }>;
  get(id: string): Promise<WorkflowEffect | null>;
  claimFailed(id: string, now?: Date): Promise<{ effect: WorkflowEffect; processing_token: string } | null>;
  claimAmbiguous(id: string, now?: Date): Promise<{ effect: WorkflowEffect; processing_token: string } | null>;
  stalePendingToAmbiguous(id: string, staleBefore: Date, now?: Date): Promise<WorkflowEffect | null>;
  succeed(input: {
    id: string; processing_token: string; external_id: string; external_url?: string | null;
    response_payload?: Record<string, unknown> | null; now?: Date;
  }): Promise<WorkflowEffect | null>;
  fail(input: {
    id: string; processing_token: string; error: string; next_attempt_at: Date | null; now?: Date;
  }): Promise<WorkflowEffect | null>;
  ambiguous(input: {
    id: string; processing_token: string; error: string; now?: Date;
  }): Promise<WorkflowEffect | null>;
  releaseLookup(input: {
    id: string; processing_token: string; error: string; next_attempt_at: Date; now?: Date;
  }): Promise<WorkflowEffect | null>;
  listReconcilable(input: { stale_before: Date; now?: Date; limit?: number }): Promise<WorkflowEffect[]>;
  pruneSettled(input: { settled_before: Date; limit?: number }): Promise<number>;
}

export interface SubmitGitHubReviewVerdictInput extends GitHubReviewEffectRequest {
  room_id: string;
  task_id: string;
  lease_id: string;
  lease_epoch: number;
  agent_key: string;
  agent_session_id: string;
  actor_label: string;
  idempotency_key: string;
}

export interface WorkflowEffectBrokerDeps {
  store: WorkflowEffectStore;
  provider: GitHubReviewProvider;
  now?: () => Date;
}

function toReviewRequest(effect: WorkflowEffect): GitHubReviewEffectRequest {
  const payload = effect.request_payload;
  return {
    owner: String(payload.owner ?? ""),
    repo: String(payload.repo ?? ""),
    pull_number: Number(payload.pull_number),
    expected_head_sha: String(payload.expected_head_sha ?? ""),
    installation_id: String(payload.installation_id ?? ""),
    verdict: String(payload.verdict) as GitHubReviewVerdict,
    body: String(payload.body ?? ""),
  };
}

export function blockingVerdictQuarantineReason(
  verdict: GitHubReviewVerdict,
  body: string,
): string | null {
  if (verdict !== "request_changes") return null;
  const normalized = body.trim().toLowerCase();
  if (!normalized) return "Blocking review verdict has no explanation.";
  const words = normalized.match(/[a-z][a-z0-9'-]*/g) ?? [];
  const explicitJunk = new Set(["sdf", "asdf", "qwerty", "test", "testing", "junk", "lorem", "ipsum"]);
  if (words.length === 0 || words.every((word) => explicitJunk.has(word))) {
    return "Blocking review verdict was quarantined as empty or junk input.";
  }
  return null;
}

async function performCreate(input: {
  effect: WorkflowEffect;
  token: string;
  store: WorkflowEffectStore;
  provider: GitHubReviewProvider;
  now: Date;
}): Promise<WorkflowEffect> {
  const result = await input.provider.create(toReviewRequest(input.effect), input.effect.correlation_key);
  let persisted: WorkflowEffect | null;
  if (result.kind === "succeeded") {
    persisted = await input.store.succeed({
      id: input.effect.id,
      processing_token: input.token,
      external_id: result.external_id,
      external_url: result.external_url,
      response_payload: result.response_payload,
      now: input.now,
    });
  } else if (result.kind === "definite_failure") {
    const exhausted = input.effect.attempt_count >= input.effect.max_attempts;
    persisted = await input.store.fail({
      id: input.effect.id,
      processing_token: input.token,
      error: result.error,
      next_attempt_at: exhausted
        ? null
        : new Date(input.now.getTime() + FAILED_RETRY_BASE_MS * input.effect.attempt_count),
      now: input.now,
    });
  } else {
    persisted = await input.store.ambiguous({
      id: input.effect.id,
      processing_token: input.token,
      error: result.error,
      now: input.now,
    });
  }
  return persisted ?? await input.store.get(input.effect.id) ?? input.effect;
}

async function performLookup(input: {
  effect: WorkflowEffect;
  token: string;
  store: WorkflowEffectStore;
  provider: GitHubReviewProvider;
  now: Date;
}): Promise<WorkflowEffect> {
  try {
    const result = await input.provider.lookup(toReviewRequest(input.effect), input.effect.correlation_key);
    const persisted = result.kind === "found"
      ? await input.store.succeed({
          id: input.effect.id,
          processing_token: input.token,
          external_id: result.external_id,
          external_url: result.external_url,
          response_payload: result.response_payload,
          now: input.now,
        })
      : await input.store.releaseLookup({
          id: input.effect.id,
          processing_token: input.token,
          error: "Provider lookup completed without finding the correlation marker; creation was not retried.",
          next_attempt_at: new Date(input.now.getTime() + WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS),
          now: input.now,
        });
    return persisted ?? await input.store.get(input.effect.id) ?? input.effect;
  } catch (error) {
    const persisted = await input.store.releaseLookup({
      id: input.effect.id,
      processing_token: input.token,
      error: error instanceof Error ? error.message : "Provider reconciliation lookup failed.",
      next_attempt_at: new Date(input.now.getTime() + WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS),
      now: input.now,
    });
    return persisted ?? await input.store.get(input.effect.id) ?? input.effect;
  }
}

export function createWorkflowEffectBroker(deps: WorkflowEffectBrokerDeps) {
  const store = deps.store;
  const provider = deps.provider;
  const nowFn = deps.now ?? (() => new Date());

  return {
    async submitGitHubReviewVerdict(input: SubmitGitHubReviewVerdictInput): Promise<WorkflowEffect> {
      const requestPayload: GitHubReviewEffectRequest = {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pull_number,
        expected_head_sha: input.expected_head_sha,
        installation_id: input.installation_id,
        verdict: input.verdict,
        body: input.body.trim(),
      };
      const reserved = await store.reserve({
        room_id: input.room_id,
        task_id: input.task_id,
        lease_id: input.lease_id,
        lease_epoch: input.lease_epoch,
        agent_key: input.agent_key,
        agent_session_id: input.agent_session_id,
        kind: "github_review_verdict",
        provider: "github",
        idempotency_key: input.idempotency_key,
        request_payload: requestPayload as unknown as Record<string, unknown>,
        created_by: input.actor_label,
        quarantine_reason: blockingVerdictQuarantineReason(input.verdict, input.body),
        now: nowFn(),
      });

      if (reserved.claimed && reserved.processing_token) {
        return performCreate({ effect: reserved.effect, token: reserved.processing_token, store, provider, now: nowFn() });
      }
      if (reserved.effect.state === "failed") {
        const claim = await store.claimFailed(reserved.effect.id, nowFn());
        if (claim) return performCreate({ effect: claim.effect, token: claim.processing_token, store, provider, now: nowFn() });
      }
      if (reserved.effect.state === "ambiguous") {
        const claim = await store.claimAmbiguous(reserved.effect.id, nowFn());
        if (claim) return performLookup({ effect: claim.effect, token: claim.processing_token, store, provider, now: nowFn() });
      }
      return reserved.effect;
    },

    async reconcile(effect: WorkflowEffect): Promise<WorkflowEffect> {
      let current = effect;
      const now = nowFn();
      if (current.state === "pending") {
        const transitioned = await store.stalePendingToAmbiguous(
          current.id,
          new Date(now.getTime() - WORKFLOW_EFFECT_PENDING_STALE_MS),
          now,
        );
        if (!transitioned) return await store.get(current.id) ?? current;
        current = transitioned;
      }
      if (current.state === "ambiguous") {
        const claim = await store.claimAmbiguous(current.id, now);
        return claim
          ? performLookup({ effect: claim.effect, token: claim.processing_token, store, provider, now })
          : await store.get(current.id) ?? current;
      }
      if (current.state === "failed") {
        const claim = await store.claimFailed(current.id, now);
        return claim
          ? performCreate({ effect: claim.effect, token: claim.processing_token, store, provider, now })
          : await store.get(current.id) ?? current;
      }
      return current;
    },

    async sweepOnce(limit = 50): Promise<number> {
      const now = nowFn();
      const effects = await store.listReconcilable({
        stale_before: new Date(now.getTime() - WORKFLOW_EFFECT_PENDING_STALE_MS),
        now,
        limit,
      });
      await Promise.all(effects.map((effect) => this.reconcile(effect)));
      await store.pruneSettled({
        settled_before: new Date(now.getTime() - WORKFLOW_EFFECT_SETTLED_RETENTION_MS),
        limit: 200,
      });
      return effects.length;
    },
  };
}
