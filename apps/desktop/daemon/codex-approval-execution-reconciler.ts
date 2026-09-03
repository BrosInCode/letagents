import type { HostApprovalReference } from "../shared/host-approvals.js";
import type { NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription } from "../shared/execution-protocol.js";
import type { ProviderPermissionRequest } from "../shared/provider-permissions.js";
import type { ExecutionApprovalRecord } from "./execution-approval-journal.js";
import type { ProviderActionHandle, ProviderActionPort } from "./provider-action-port.js";

type Store = {
  readLatestExecutionApproval(requestId: string): Promise<ExecutionApprovalRecord | null>;
  recordExecutionApprovalOutcome(input: {
    expected: HostApprovalReference;
    decisionId: string;
    dispatchId: string;
    evidence: "exact_native_execution";
    atMs: number;
  }, fence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord>;
};

type PendingReconciliation = {
  key: string;
  expected: HostApprovalReference;
  decisionId: string;
  decision: "allow_once" | "deny";
  operation: "command" | "file_change";
  armed: boolean;
  lowerBound: { sourceId: string; sequence: number } | null;
};

function requestIdentity(native: ProviderPermissionRequest): { key: string; operation: "command" | "file_change" } | null {
  if (native.provider !== "codex" || !native.native.params || typeof native.native.params !== "object"
    || Array.isArray(native.native.params)) return null;
  const params = native.native.params as Record<string, unknown>;
  if (![params.threadId, params.turnId, params.itemId].every(value => typeof value === "string" && value.length > 0)) return null;
  const operation = native.native.method === "item/commandExecution/requestApproval" ? "command"
    : native.native.method === "item/fileChange/requestApproval" ? "file_change" : null;
  return operation ? { key: JSON.stringify([params.threadId, params.turnId, params.itemId]), operation } : null;
}

function executionKey(fact: NativeExecutionFact): string | null {
  return fact.domain === "execution"
    ? JSON.stringify([fact.providerContinuationId, fact.providerTurnId, fact.executionId])
    : null;
}

function confirmsDecision(fact: NativeExecutionFact, pending: PendingReconciliation): boolean {
  if (fact.domain !== "execution") return false;
  if (fact.operation !== pending.operation) return false;
  if (pending.decision === "deny") return fact.kind === "completed" && fact.outcome === "denied_before_start";
  return fact.kind === "started"
    || (fact.kind === "completed" && !["denied_before_start", "cancelled_before_start"].includes(fact.outcome));
}

/** Settles a Codex approval only after its exact native item proves application. */
export class CodexApprovalExecutionReconciler {
  private subscription: NativeExecutionSubscription | null = null;
  private readonly evidence = new Map<string, NativeExecutionObservation>();
  private readonly pending = new Map<string, PendingReconciliation>();
  private closed = false;

  constructor(private readonly options: {
    provider: ProviderActionPort;
    handle: ProviderActionHandle;
    store: Store;
    isCurrent(): boolean;
    fenceCommit(commit: () => Promise<void>): Promise<void>;
    onChanged?(): void;
    nowMs(): number;
  }) {}

  start(): void {
    if (!this.options.provider.onExecution) return;
    void this.options.provider.onExecution(this.options.handle, event => this.observe(event)).then(subscription => {
      if (this.closed || !this.options.isCurrent()) subscription.dispose();
      else this.subscription = subscription;
    }).catch(() => undefined);
  }

  prepare(native: ProviderPermissionRequest, expected: HostApprovalReference, decisionId: string,
    decision: "allow_once" | "deny"): PendingReconciliation | null {
    const identity = requestIdentity(native);
    if (!identity) return null;
    const value = { ...identity, expected, decisionId, decision, armed: false, lowerBound: null };
    this.pending.set(identity.key, value);
    while (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!);
    return value;
  }

  arm(value: PendingReconciliation): void {
    value.armed = true;
    void this.reconcile(value.key);
  }

  markNativeDispatch(value: PendingReconciliation): void {
    const subscription = this.subscription;
    if (!subscription) return;
    value.lowerBound = { sourceId: subscription.sourceId, sequence: subscription.position().latestSequence };
  }

  discard(value: PendingReconciliation): void {
    if (this.pending.get(value.key) === value) this.pending.delete(value.key);
  }

  close(): void {
    this.closed = true;
    this.subscription?.dispose();
    this.subscription = null;
    this.evidence.clear();
    this.pending.clear();
  }

  private observe(observation: NativeExecutionObservation): void {
    if (this.closed || !this.options.isCurrent()) return;
    const key = executionKey(observation.fact);
    if (!key || (observation.fact.kind !== "started" && observation.fact.kind !== "completed")) return;
    this.evidence.delete(key);
    this.evidence.set(key, observation);
    while (this.evidence.size > 64) this.evidence.delete(this.evidence.keys().next().value!);
    void this.reconcile(key);
  }

  private async reconcile(key: string): Promise<void> {
    const pending = this.pending.get(key);
    const observation = this.evidence.get(key);
    const lowerBound = pending?.lowerBound;
    if (!pending?.armed || !lowerBound || !observation
      || observation.sourceId !== lowerBound.sourceId || observation.sequence <= lowerBound.sequence
      || !confirmsDecision(observation.fact, pending)
      || this.closed || !this.options.isCurrent()) return;
    try {
      const record = await this.options.store.readLatestExecutionApproval(pending.expected.requestId);
      const decision = record?.decision;
      if (!record || record.request.requestVersion !== pending.expected.requestVersion
        || decision?.decisionId !== pending.decisionId || decision.decision !== pending.decision || !decision.dispatchId) return;
      await this.options.store.recordExecutionApprovalOutcome({ expected: pending.expected,
        decisionId: pending.decisionId, dispatchId: decision.dispatchId,
        evidence: "exact_native_execution", atMs: this.options.nowMs() }, commit =>
        this.options.fenceCommit(async () => {
          if (this.closed || !this.options.isCurrent()) throw new Error("Approval execution authority changed.");
          await commit();
        }));
      this.pending.delete(key);
      this.evidence.delete(key);
      this.options.onChanged?.();
    } catch { /* An exact replay can retry reconciliation without redispatching. */ }
  }
}
