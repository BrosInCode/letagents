import { isDeepStrictEqual } from "node:util";
import type { HostApprovalReference } from "../shared/host-approvals.js";
import { claudeToolOperation } from "../../../shared/claude-tool-operation.mjs";
import type { NativeExecutionFact, NativeExecutionObservation, NativeExecutionSubscription } from "../shared/execution-protocol.js";
import type { ProviderPermissionObservation, ProviderPermissionRequest } from "../shared/provider-permissions.js";
import type { ExecutionApprovalRecord } from "./execution-approval-journal.js";
import type { ProviderActionHandle, ProviderActionPort } from "./provider-action-port.js";

type Store = {
  closeExecutionApprovalRequest(expected: HostApprovalReference, nowMs: () => number,
    fence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord>;
  readLatestExecutionApproval(requestId: string): Promise<ExecutionApprovalRecord | null>;
  recordExecutionApprovalOutcome(input: {
    expected: HostApprovalReference;
    decisionId: string;
    dispatchId: string;
    evidence: "exact_native_execution" | "native_request_closed";
    atMs: number;
  }, fence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord>;
};

type PendingReconciliation = {
  key: string;
  native: ProviderPermissionRequest;
  executionKey: string | null;
  expected: HostApprovalReference;
  decisionId: string;
  decision: "allow_once" | "deny";
  operation: Extract<NativeExecutionFact, { domain: "execution" }>["operation"] | null;
  armed: boolean;
  dispatched: boolean;
  closedAtMs: number | null;
  lowerBound: { sourceId: string; sequence: number } | null;
};

function requestIdentity(native: ProviderPermissionRequest, expected: HostApprovalReference): {
  key: string; operation: NonNullable<PendingReconciliation["operation"]>;
} | null {
  if (native.provider === "claude-code") {
    const request = native.native.request;
    if (!request.tool_use_id?.trim()) return null;
    // Claude tool requests lack a turn UUID. The broker has already correlated
    // this exact request to the live native turn before admitting the reference.
    return { key: JSON.stringify([expected.providerContinuationId, expected.providerTurnId, request.tool_use_id]),
      operation: claudeToolOperation(request.tool_name) };
  }
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
  // Claude's generic error result also covers refusal/cancellation before a
  // tool starts. It proves completion of the request, not consumption of allow.
  if (pending.native.provider === "claude-code") return pending.decision === "allow_once"
    && fact.kind === "completed" && fact.outcome === "succeeded";
  if (pending.decision === "deny") return fact.kind === "completed" && fact.outcome === "denied_before_start";
  return fact.kind === "started"
    || (fact.kind === "completed" && !["denied_before_start", "cancelled_before_start"].includes(fact.outcome));
}

/** Settles an approval only after its exact native operation proves application. */
export class ApprovalExecutionReconciler {
  private subscription: NativeExecutionSubscription | null = null;
  private readonly evidence = new Map<string, NativeExecutionObservation>();
  private readonly pending = new Map<string, PendingReconciliation>();
  private closed = false;
  private readonly admittedRequests = new Map<string, { native: ProviderPermissionRequest; expected: HostApprovalReference }>();
  private readonly closedRequests: Extract<ProviderPermissionObservation, { type: "request_closed" }>[] = [];

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
    if (native.provider !== "codex" && native.provider !== "claude-code") return null;
    const identity = requestIdentity(native, expected);
    const value: PendingReconciliation = { key: expected.requestId, native,
      executionKey: identity?.key ?? null, operation: identity?.operation ?? null,
      expected, decisionId, decision, armed: false, dispatched: false, closedAtMs: null, lowerBound: null };
    this.pending.set(value.key, value);
    while (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!);
    return value;
  }

  arm(value: PendingReconciliation): void {
    value.armed = true;
    void this.reconcile(value.key);
  }

  markNativeDispatch(value: PendingReconciliation): void {
    value.dispatched = true;
    const subscription = this.subscription;
    if (!subscription) return;
    value.lowerBound = { sourceId: subscription.sourceId, sequence: subscription.position().latestSequence };
  }

  trackRequest(native: ProviderPermissionRequest, expected: HostApprovalReference): void {
    if (native.provider !== "claude-code" || this.closed || !this.options.isCurrent()) return;
    this.admittedRequests.set(expected.requestId, { native, expected });
    while (this.admittedRequests.size > 64) this.admittedRequests.delete(this.admittedRequests.keys().next().value!);
    for (const event of this.closedRequests) this.closeAdmittedRequest(event, native, expected);
  }

  private closeAdmittedRequest(event: Extract<ProviderPermissionObservation, { type: "request_closed" }>,
    native: ProviderPermissionRequest, expected: HostApprovalReference): void {
    if (event.request.provider !== "claude-code" || native.provider !== "claude-code"
      || !("providerTurnId" in event) || event.providerTurnId !== expected.providerTurnId
      || event.providerContinuationId !== expected.providerContinuationId
      || !isDeepStrictEqual(event.request.native, native.native)) return;
    void this.options.store.closeExecutionApprovalRequest(expected, this.options.nowMs, commit =>
      this.options.fenceCommit(async () => {
        if (this.closed || !this.options.isCurrent()) throw new Error("Approval closure authority changed.");
        await commit();
      })).then(() => { this.options.onChanged?.(); }).catch(() => { /* A matching admission replay can retry. */ });
  }

  observeRequestClosed(event: Extract<ProviderPermissionObservation, { type: "request_closed" }>): void {
    const native = event.request;
    if (this.closed || !this.options.isCurrent()) return;
    if (native.provider === "claude-code") {
      this.closedRequests.push(event);
      if (this.closedRequests.length > 64) this.closedRequests.shift();
      for (const { native: admitted, expected } of this.admittedRequests.values()) this.closeAdmittedRequest(event, admitted, expected);
      return;
    }
    for (const value of this.pending.values()) {
      if (!value.dispatched || native.provider !== "codex" || value.native.provider !== "codex"
        || value.native.native !== native.native) continue;
      value.closedAtMs ??= this.options.nowMs();
      void this.reconcile(value.key);
    }
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
    this.admittedRequests.clear();
    this.closedRequests.length = 0;
  }

  private observe(observation: NativeExecutionObservation): void {
    if (this.closed || !this.options.isCurrent()) return;
    const key = executionKey(observation.fact);
    if (!key || (observation.fact.kind !== "started" && observation.fact.kind !== "completed")) return;
    this.evidence.delete(key);
    this.evidence.set(key, observation);
    while (this.evidence.size > 64) this.evidence.delete(this.evidence.keys().next().value!);
    for (const pending of this.pending.values()) {
      if (pending.executionKey === key) void this.reconcile(pending.key);
    }
  }

  private async reconcile(key: string): Promise<void> {
    const pending = this.pending.get(key);
    const observation = pending?.executionKey ? this.evidence.get(pending.executionKey) : undefined;
    const lowerBound = pending?.lowerBound;
    if (!pending?.armed || this.closed || !this.options.isCurrent()) return;
    const connection = this.options.handle.providerConnection;
    const exactProcess = pending.native.provider !== "claude-code"
      || (connection?.kind === "claude_cli" && Boolean(connection.processIdentity)
        && observation?.nativeProcessIdentity === connection.processIdentity
        && observation?.nativeProcessPid === connection.pid);
    const applied = lowerBound && observation && observation.sourceId === lowerBound.sourceId
      && observation.sequence > lowerBound.sequence && exactProcess && confirmsDecision(observation.fact, pending);
    if (!applied && pending.closedAtMs === null) return;
    try {
      const record = await this.options.store.readLatestExecutionApproval(pending.expected.requestId);
      const decision = record?.decision;
      if (!record || record.request.requestVersion !== pending.expected.requestVersion
        || decision?.decisionId !== pending.decisionId || decision.decision !== pending.decision || !decision.dispatchId) return;
      await this.options.store.recordExecutionApprovalOutcome({ expected: pending.expected,
        decisionId: pending.decisionId, dispatchId: decision.dispatchId,
        evidence: applied ? "exact_native_execution" : "native_request_closed", atMs: this.options.nowMs() }, commit =>
        this.options.fenceCommit(async () => {
          if (this.closed || !this.options.isCurrent()) throw new Error("Approval execution authority changed.");
          await commit();
        }));
      // Item-backed approvals can still gain stronger application evidence
      // after their prompt closes. MCP closures never invent item identity.
      if (applied || !pending.executionKey) this.pending.delete(key);
      if (applied && pending.executionKey) this.evidence.delete(pending.executionKey);
      this.options.onChanged?.();
    } catch { /* An exact replay can retry reconciliation without redispatching. */ }
  }
}
