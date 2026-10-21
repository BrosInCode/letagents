import type { ReserveTrackerWorkflowEffectInput, ReserveWorkflowEffectInput } from "../db/workflow-effects.js";
import type { WorkflowEffect } from "../db/types/effects.js";
import {
  type GitHubReviewCreateResult,
  type GitHubReviewEffectRequest,
  type GitHubReviewLookupResult,
  type GitHubReviewProvider,
  type GitHubReviewVerdict,
} from "./github-review-provider.js";

export const WORKFLOW_EFFECT_PENDING_STALE_MS = 2 * 60_000;
export const WORKFLOW_EFFECT_AMBIGUOUS_LOOKUP_INTERVAL_MS = 5 * 60_000;
export const WORKFLOW_EFFECT_SETTLED_RETENTION_MS = 30 * 24 * 60 * 60_000;
const FAILED_RETRY_BASE_MS = 30_000;

export type WorkflowEffectCreateResult = GitHubReviewCreateResult;
export type WorkflowEffectLookupResult = GitHubReviewLookupResult;

/** Runs one effect kind against its provider. */
export interface WorkflowEffectExecutor {
  /** One provider write that embeds `effect.correlation_key`. */
  create(effect: WorkflowEffect): Promise<WorkflowEffectCreateResult>;
  /** Read-only search for an earlier write by its correlation marker. */
  lookup(effect: WorkflowEffect): Promise<WorkflowEffectLookupResult>;
}

interface ReserveResult {
  effect: WorkflowEffect;
  claimed: boolean;
  processing_token: string | null;
}

export interface WorkflowEffectStore {
  reserve(input: ReserveWorkflowEffectInput): Promise<ReserveResult>;
  /** Tracker effects: reserved under a live connection instead of a lease. */
  reserveTracker?(input: ReserveTrackerWorkflowEffectInput): Promise<ReserveResult>;
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

export interface SubmitTrackerEffectInput {
  room_id: string;
  task_id: string;
  connection_id: string;
  provider: "jira" | "linear";
  /** The ticket key, e.g. `HT-1234`. */
  key: string;
  idempotency_key: string;
  actor_label: string;
  action:
    | { kind: "tracker_transition"; to_status: string }
    | { kind: "tracker_comment"; body: string };
}

export const TRACKER_COMMENT_MAX_LENGTH = 16_000;

export interface WorkflowEffectBrokerDeps {
  store: WorkflowEffectStore;
  provider: GitHubReviewProvider;
  /** Jira and Linear writes. Without it, tracker effects fail definitely. */
  tracker?: WorkflowEffectExecutor;
  now?: () => Date;
}

const unconfiguredTrackerExecutor: WorkflowEffectExecutor = {
  async create() {
    return { kind: "definite_failure", error: "Ticket connectors are not configured on this server; the tracker was not changed." };
  },
  async lookup() {
    throw new Error("Ticket connectors are not configured on this server; the tracker cannot be checked.");
  },
};

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
  executor: WorkflowEffectExecutor;
  now: Date;
}): Promise<WorkflowEffect> {
  let result: WorkflowEffectCreateResult;
  try {
    result = await input.executor.create(input.effect);
  } catch (error) {
    // An executor that throws cannot say whether the write landed.
    result = { kind: "ambiguous", error: error instanceof Error ? error.message : "Provider write outcome is unknown." };
  }
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
  executor: WorkflowEffectExecutor;
  now: Date;
}): Promise<WorkflowEffect> {
  try {
    const result = await input.executor.lookup(input.effect);
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
  const githubExecutor: WorkflowEffectExecutor = {
    create: (effect) => provider.create(toReviewRequest(effect), effect.correlation_key),
    lookup: (effect) => provider.lookup(toReviewRequest(effect), effect.correlation_key),
  };
  const executorFor = (effect: WorkflowEffect): WorkflowEffectExecutor =>
    effect.kind === "github_review_verdict" ? githubExecutor : deps.tracker ?? unconfiguredTrackerExecutor;

  /** Run a freshly reserved, retried or ambiguous effect once. */
  async function drive(reserved: ReserveResult): Promise<WorkflowEffect> {
    if (reserved.claimed && reserved.processing_token) {
      return performCreate({ effect: reserved.effect, token: reserved.processing_token, store, executor: executorFor(reserved.effect), now: nowFn() });
    }
    if (reserved.effect.state === "failed") {
      const claim = await store.claimFailed(reserved.effect.id, nowFn());
      if (claim) return performCreate({ effect: claim.effect, token: claim.processing_token, store, executor: executorFor(claim.effect), now: nowFn() });
    }
    if (reserved.effect.state === "ambiguous") {
      const claim = await store.claimAmbiguous(reserved.effect.id, nowFn());
      if (claim) return performLookup({ effect: claim.effect, token: claim.processing_token, store, executor: executorFor(claim.effect), now: nowFn() });
    }
    return reserved.effect;
  }

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
      return drive(reserved);
    },

    /**
     * Reserve one tracker write in the journal, then run it once. Every Jira
     * or Linear write goes through here (ticket connectors invariant 3).
     */
    async submitTrackerEffect(input: SubmitTrackerEffectInput): Promise<WorkflowEffect> {
      if (!store.reserveTracker) throw new Error("This workflow effect store cannot reserve tracker effects.");
      const key = input.key.trim().toUpperCase();
      const requestPayload: Record<string, unknown> = input.action.kind === "tracker_transition"
        ? { connection_id: input.connection_id, key, to_status: input.action.to_status.trim() }
        : { connection_id: input.connection_id, key, body: input.action.body.trim() };
      const quarantine = input.action.kind === "tracker_comment"
        ? (!input.action.body.trim()
            ? "Tracker comment is empty."
            : input.action.body.length > TRACKER_COMMENT_MAX_LENGTH ? "Tracker comment is too long." : null)
        : (!input.action.to_status.trim() ? "Tracker transition names no target status." : null);
      const reserved = await store.reserveTracker({
        room_id: input.room_id,
        task_id: input.task_id,
        connection_id: input.connection_id,
        kind: input.action.kind,
        provider: input.provider,
        idempotency_key: input.idempotency_key,
        request_payload: requestPayload,
        created_by: input.actor_label,
        quarantine_reason: quarantine,
        now: nowFn(),
      });
      return drive(reserved);
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
          ? performLookup({ effect: claim.effect, token: claim.processing_token, store, executor: executorFor(claim.effect), now })
          : await store.get(current.id) ?? current;
      }
      if (current.state === "failed") {
        const claim = await store.claimFailed(current.id, now);
        return claim
          ? performCreate({ effect: claim.effect, token: claim.processing_token, store, executor: executorFor(claim.effect), now })
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
