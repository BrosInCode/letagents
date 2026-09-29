import {
  EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS,
  type ExecutionDelegationDecisionIntent,
} from "../../../shared/execution-delegation-decision.mjs";
import { collectBoundedInventory } from "./bounded-inventory.js";
import { SupervisorGrantRequestError, type SupervisorGrantHttp } from "./cloud-http.js";
import type { ExecutionApprovalProjectionRecord } from "./execution-approval-projection-journal.js";
import { ApprovalJournalError, type ApprovalReference, type ExecutionApprovalRecord } from "./execution-approval-journal.js";
import { ExecutionDelegationJournalError } from "./execution-delegation-journal.js";
import {
  NativeApprovalUnavailableError,
  type RecordedApprovalDecision,
  type RecordedApprovalSelection,
} from "./execution-approval-native-application.js";
import type { DaemonManifestEntry } from "./types.js";
import type { InstalledHostGrant } from "./worker-runtime-custody.js";

type Lane = { controller: AbortController; promise: Promise<void> };
export type ExecutionDelegationDecisionRetryTimer = { unref(): unknown };
type RetryState = { attempts: number; timer: ExecutionDelegationDecisionRetryTimer | null };

const RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

class DecisionIntentRejectedError extends Error {}

export type ExecutionDelegationDecisionCoordinatorOptions = {
  entries: {
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
    readExecutionApprovalProjection(expected: ApprovalReference): Promise<ExecutionApprovalProjectionRecord | null>;
  };
  authority: {
    currentHostGrant(entry: DaemonManifestEntry): InstalledHostGrant | null;
    syncExecutionDelegation(input: {
      entryId: string;
      delegationInstanceId: string;
      signal: AbortSignal;
    }): Promise<unknown>;
    recordDelegatedApproval(input: {
      entryId: string;
      intent: ExecutionDelegationDecisionIntent;
      expected: ApprovalReference;
      locallyWitnessedProjectionSha256: string;
      approvalAuthority: RecordedApprovalSelection["approvalAuthority"];
      assertApprovalCurrent(): void;
    }): Promise<ExecutionApprovalRecord>;
  };
  approvals: {
    applyRecordedDecision(
      input: RecordedApprovalDecision,
      select: (prepared: RecordedApprovalSelection) => Promise<ExecutionApprovalRecord>,
    ): Promise<unknown>;
  };
  remote: Pick<SupervisorGrantHttp,
    "getExecutionDelegationDecision" | "listExecutionDelegationDecisionIds">;
  diagnostic(entryId: string, error: unknown): void;
  nowMs?: () => number;
  setRetryTimeout?: (callback: () => void, delayMs: number) => ExecutionDelegationDecisionRetryTimer;
  clearRetryTimeout?: (timer: ExecutionDelegationDecisionRetryTimer) => void;
};

/** Exact-fetches recorded delegate choices and rendezvous them with native requests. */
export class ExecutionDelegationDecisionCoordinator {
  private readonly lanes = new Map<string, Lane>();
  private readonly eventSerials = new Map<string, number>();
  private readonly retries = new Map<string, RetryState>();
  private readonly nowMs: () => number;
  private readonly setRetryTimeout: NonNullable<ExecutionDelegationDecisionCoordinatorOptions["setRetryTimeout"]>;
  private readonly clearRetryTimeout: NonNullable<ExecutionDelegationDecisionCoordinatorOptions["clearRetryTimeout"]>;
  private fenced = false;

  constructor(private readonly options: ExecutionDelegationDecisionCoordinatorOptions) {
    this.nowMs = options.nowMs ?? Date.now;
    this.setRetryTimeout = options.setRetryTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearRetryTimeout = options.clearRetryTimeout
      ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  request(entryId: string): Promise<void> {
    if (this.fenced) return Promise.resolve();
    this.cancelRetry(entryId);
    return this.enqueue(entryId);
  }

  private enqueue(entryId: string): Promise<void> {
    if (this.fenced) return Promise.resolve();
    this.eventSerials.set(entryId, (this.eventSerials.get(entryId) ?? 0) + 1);
    return this.start(entryId);
  }

  private start(entryId: string): Promise<void> {
    const active = this.lanes.get(entryId);
    if (active) return active.promise;
    const startedEventSerial = this.eventSerials.get(entryId) ?? 0;
    const lane: Lane = { controller: new AbortController(), promise: Promise.resolve() };
    this.lanes.set(entryId, lane);
    lane.promise = Promise.resolve()
      .then(() => this.reconcileOnce(entryId, lane.controller.signal))
      .then(() => this.cancelRetry(entryId))
      .catch((error) => {
        this.scheduleRetry(entryId, error, lane.controller.signal);
        throw error;
      })
      .finally(() => {
        if (this.lanes.get(entryId) === lane) this.lanes.delete(entryId);
        if (!this.fenced && (this.eventSerials.get(entryId) ?? 0) > startedEventSerial) {
          queueMicrotask(() => {
            void this.start(entryId).catch((error) => this.options.diagnostic(entryId, error));
          });
        } else {
          this.eventSerials.delete(entryId);
        }
      });
    return lane.promise;
  }

  async fenceAndDrain(): Promise<void> {
    this.fenced = true;
    for (const entryId of this.retries.keys()) this.cancelRetry(entryId);
    for (const lane of this.lanes.values()) lane.controller.abort();
    await Promise.allSettled([...this.lanes.values()].map((lane) => lane.promise));
    this.eventSerials.clear();
  }

  private async reconcileOnce(entryId: string, signal: AbortSignal): Promise<void> {
    const list = this.options.remote.listExecutionDelegationDecisionIds;
    const get = this.options.remote.getExecutionDelegationDecision;
    if (!list || !get) return;
    const entry = await this.options.entries.getEntry(entryId);
    if (!entry) return;
    const grant = this.options.authority.currentHostGrant(entry);
    if (!grant || grant.ownerAccountId === null || grant.scopeKey !== "owner"
      || Date.parse(grant.expiresAt) <= this.nowMs()) return;
    const decisionIds = await collectBoundedInventory(async (after) => {
      const page = await list({
        apiUrl: grant.apiUrl,
        grantId: grant.grantId,
        supervisorGrant: grant.supervisorGrant,
        grantGeneration: grant.grantGeneration,
        roomId: grant.roomId,
        agentKey: grant.agentKey,
        after,
        signal,
      });
      return { ids: page.decisionIds, nextCursor: page.nextCursor };
    }, "Execution delegation decision inventory");

    let retryError: unknown = null;
    for (const decisionId of decisionIds) {
      signal.throwIfAborted();
      try {
        const intent = await get({
          apiUrl: grant.apiUrl,
          grantId: grant.grantId,
          supervisorGrant: grant.supervisorGrant,
          grantGeneration: grant.grantGeneration,
          decisionId,
          signal,
        });
        const decidedAtMs = Date.parse(intent.decided_at);
        if (!Number.isFinite(decidedAtMs)
          || decidedAtMs <= this.nowMs() - EXECUTION_DELEGATION_DECISION_APPLICABILITY_MS) {
          throw new DecisionIntentRejectedError("The delegated approval decision is no longer applicable.");
        }
        this.assertIntentScope(intent, grant);
        // Refresh the exact delegation immediately before applying its intent;
        // stale local grants are never the authority for a new decision.
        await this.options.authority.syncExecutionDelegation({
          entryId,
          delegationInstanceId: intent.delegation_instance_id,
          signal,
        });
        await this.options.approvals.applyRecordedDecision({
          agentId: entryId,
          requestId: intent.request_id,
          requestVersion: intent.request_version,
          requestSha256: intent.request_sha256,
          decisionId: intent.decision_id,
          actorId: intent.actor_account_id,
          decision: intent.decision,
          projectionSha256: intent.projection_sha256,
        }, async (prepared) => {
          const projection = await this.options.entries.readExecutionApprovalProjection(prepared.expected);
          if (!projection || projection.sha256 !== intent.projection_sha256) {
            throw new DecisionIntentRejectedError("The delegated approval projection does not match local evidence.");
          }
          return this.options.authority.recordDelegatedApproval({
            entryId,
            intent,
            expected: prepared.expected,
            locallyWitnessedProjectionSha256: projection.sha256,
            approvalAuthority: prepared.approvalAuthority,
            assertApprovalCurrent: prepared.assertCurrent,
          });
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof NativeApprovalUnavailableError) continue;
        if (this.shouldRetry(error) && retryError === null) retryError = error;
        else this.options.diagnostic(entryId, error);
      }
    }
    if (retryError !== null) throw retryError;
    const currentEntry = await this.options.entries.getEntry(entryId);
    if (!currentEntry || this.options.authority.currentHostGrant(currentEntry) !== grant) {
      throw new Error("Execution delegation decision authority changed during reconciliation.");
    }
  }

  private assertIntentScope(intent: ExecutionDelegationDecisionIntent, grant: InstalledHostGrant): void {
    if (intent.room_id !== grant.roomId || intent.agent_key !== grant.agentKey
      || intent.owner_account_id !== grant.ownerAccountId) {
      throw new DecisionIntentRejectedError("Execution delegation decision scope did not match the installed host grant.");
    }
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof DecisionIntentRejectedError || error instanceof NativeApprovalUnavailableError
      || error instanceof ApprovalJournalError || error instanceof ExecutionDelegationJournalError
      || (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError")) return false;
    return !(error instanceof SupervisorGrantRequestError)
      || error.status === 408 || error.status === 429 || error.status >= 500;
  }

  private scheduleRetry(entryId: string, error: unknown, signal: AbortSignal): void {
    if (this.fenced || signal.aborted || !this.shouldRetry(error)) return;
    const state = this.retries.get(entryId) ?? { attempts: 0, timer: null };
    if (state.timer || state.attempts >= RETRY_DELAYS_MS.length) return;
    const delayMs = RETRY_DELAYS_MS[state.attempts]!;
    state.attempts += 1;
    let timer!: ExecutionDelegationDecisionRetryTimer;
    timer = this.setRetryTimeout(() => {
      if (this.retries.get(entryId)?.timer !== timer) return;
      state.timer = null;
      void this.enqueue(entryId).catch((retryError) => this.options.diagnostic(entryId, retryError));
    }, delayMs);
    state.timer = timer;
    this.retries.set(entryId, state);
    timer.unref();
  }

  private cancelRetry(entryId: string): void {
    const state = this.retries.get(entryId);
    if (!state) return;
    if (state.timer) this.clearRetryTimeout(state.timer);
    this.retries.delete(entryId);
  }
}
