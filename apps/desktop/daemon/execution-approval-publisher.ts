import type { DatabaseSync } from "node:sqlite";

import {
  EXECUTION_APPROVAL_PUBLICATION_VERSION,
  parseExecutionApprovalPublicationInput,
  type ExecutionApprovalPublicationInput,
} from "../../../shared/execution-approval-publication.mjs";
import {
  cancelPreparedExecutionApprovalEffectsInTransaction,
  completeEffectInTransaction,
  EffectClaimRefusedError,
  EffectExecutor,
  EffectFenceError,
  EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
  EXECUTION_APPROVAL_EFFECT_MAX_ATTEMPTS,
  EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
  executionApprovalCloseIdempotencyKey,
  executionApprovalPublishIdempotencyKey,
  failEffect,
  getEffectByIdempotencyKey,
  hasInterruptedExecutionApprovalEffects,
  hasPendingRoomMoveForAgent,
  listActiveExecutionApprovalEffectsForAgent,
  parseExecutionApprovalCloseEffectPayload,
  parseExecutionApprovalPublishEffectPayload,
  prepareEffectInTransaction,
  pruneTerminalExecutionApprovalEffectsInTransaction,
  recoverInterruptedEffectsOnStartup,
  rescheduleEffectForRetry,
  retireObsoleteExecutionApprovalEffects,
  withFencedEffectTransaction,
  type EffectHandler,
  type EffectRecord,
  type ExecutionApprovalCloseEffectPayload,
  type ExecutionApprovalPublicationIdentity,
  type ExecutionApprovalPublishEffectPayload,
} from "./effect-journal/index.js";
import {
  ExecutionApprovalPublicationStore,
  publicationPinFrom,
  type ExecutionApprovalPublicationRecord,
} from "./execution-approval-publication-store.js";
import {
  closeExecutionApprovalPublication,
  publishExecutionApproval,
  type ExecutionApprovalPublicationCloseHttpInput,
  type ExecutionApprovalPublicationCloseHttpResult,
  type ExecutionApprovalPublicationHttpInput,
  type ExecutionApprovalPublicationHttpResult,
} from "./execution-approval-publication-http.js";
import type { DelegatableApprovalAdmission } from "./host-approval-broker.js";
import type { ExecutionApprovalRecord } from "./execution-approval-journal.js";
import { ExecutionDelegationJournalError } from "./execution-delegation-journal.js";
import type { ManifestStore } from "./manifest-store.js";
import { DaemonFenceLostError } from "./singleton.js";
import type { SupervisedAgentInboxStore } from "./supervised-agent-inbox-store.js";
import type { ValidateInstalledExecutionDelegationInput } from "./worker-authority-coordinator.js";
import {
  currentWorkerPublicationAuthority,
  sameWorkerPublicationOrigin,
} from "./worker-publication-authority.js";
import type { WorkerRuntimeCustody } from "./worker-runtime-custody.js";

export type ExecutionApprovalPublisherOptions = {
  custody: Pick<WorkerRuntimeCustody, "hostGrant" | "workerAuthorization">;
  approvals: { admitDelegatable(agentId: string): Promise<DelegatableApprovalAdmission[]> };
  entries: Pick<ManifestStore,
    "getExecutionApproval" | "listExecutionDelegationsForApprovalPublication" | "readExecutionApprovalProjection">;
  inbox: Pick<SupervisedAgentInboxStore, "get">;
  authority: { validateExecutionDelegation(input: ValidateInstalledExecutionDelegationInput): Promise<unknown> };
  daemonGeneration(): number;
  isClosing(): boolean;
  assertCurrent(): Promise<void>;
  /** Synchronous generation fence check run inside every write transaction before COMMIT. */
  assertWriteFence?(): void;
  /** Shared process-wide effect executor; standalone tests create an internal executor if omitted. */
  effectExecutor?: EffectExecutor;
  /** When false, `attach()` registers effect handlers without arming the flush timer until `start()` runs. */
  startImmediately?: boolean;
  publish?(input: ExecutionApprovalPublicationHttpInput): Promise<ExecutionApprovalPublicationHttpResult>;
  closePublication?(input: ExecutionApprovalPublicationCloseHttpInput): Promise<ExecutionApprovalPublicationCloseHttpResult>;
  diagnostic?(code: "storage_unavailable" | "authority_unavailable" | "publication_unavailable" | "publication_conflict"): void;
  now?(): number;
};

type PublicationAuthority = NonNullable<ReturnType<typeof currentWorkerPublicationAuthority>>;
type PendingPublishSettlement = {
  attemptCount: number;
  authority: PublicationAuthority;
  record: ExecutionApprovalPublicationRecord;
  result: ExecutionApprovalPublicationHttpResult;
};
type PendingCloseSettlement = {
  attemptCount: number;
  authority: PublicationAuthority;
  record: ExecutionApprovalPublicationRecord;
  result: ExecutionApprovalPublicationCloseHttpResult;
};

class ApprovalSettlementStorageError extends Error {
  constructor(cause: unknown) {
    super("Execution approval publication settlement storage write failed.", { cause });
    this.name = "ApprovalSettlementStorageError";
  }
}

class ApprovalCustodyLostError extends Error {
  constructor() {
    super("Execution approval publication dispatch custody changed before settlement.");
    this.name = "ApprovalCustodyLostError";
  }
}

const COALESCE_MS = 1_000;
const RETRY_MS = 30_000;
const MAX_ADMISSION_AGENTS = 1_024;
const MAX_UPLOADS_PER_PASS = 4;
const PENDING_PRIORITY: Record<ExecutionApprovalPublicationRecord["state"], number> = {
  attempted: 0, closing: 1, open: 2, acknowledged: 3,
  closed: 4, conflict: 4, expired: 4, invalid: 4,
};

function recordIdentityKey(identity: {
  agentId: string;
  roomId: string;
  delegationInstanceId: string;
  delegationRevision: number;
  requestId: string;
  requestVersion: number;
}): string {
  return JSON.stringify([
    identity.agentId,
    identity.roomId,
    identity.delegationInstanceId,
    identity.delegationRevision,
    identity.requestId,
    identity.requestVersion,
  ]);
}

const key = (record: ExecutionApprovalPublicationRecord) => recordIdentityKey({
  agentId: record.agentId,
  roomId: record.roomId,
  delegationInstanceId: record.delegationInstanceId,
  delegationRevision: record.delegationRevision,
  requestId: record.expected.requestId,
  requestVersion: record.expected.requestVersion,
});

function effectIdentityKey(effect: EffectRecord): string | null {
  if (effect.kind === EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND) {
    const parsed = parseExecutionApprovalPublishEffectPayload(effect.payload);
    if (!parsed) return null;
    return recordIdentityKey({
      agentId: effect.agent_id,
      roomId: parsed.room_id,
      delegationInstanceId: parsed.delegation_instance_id,
      delegationRevision: parsed.delegation_revision,
      requestId: parsed.request_id,
      requestVersion: parsed.request_version,
    });
  }
  if (effect.kind === EXECUTION_APPROVAL_CLOSE_EFFECT_KIND) {
    const parsed = parseExecutionApprovalCloseEffectPayload(effect.payload);
    if (!parsed) return null;
    return recordIdentityKey({
      agentId: effect.agent_id,
      roomId: parsed.room_id,
      delegationInstanceId: parsed.delegation_instance_id,
      delegationRevision: parsed.delegation_revision,
      requestId: parsed.request_id,
      requestVersion: parsed.request_version,
    });
  }
  return null;
}

function publication(record: ExecutionApprovalPublicationRecord, projectionJson: string): ExecutionApprovalPublicationInput {
  const value = parseExecutionApprovalPublicationInput({
    version: EXECUTION_APPROVAL_PUBLICATION_VERSION,
    room_id: record.roomId,
    source_message_id: record.sourceMessageId,
    delegation_instance_id: record.delegationInstanceId,
    delegation_revision: record.delegationRevision,
    request_id: record.expected.requestId,
    request_version: record.expected.requestVersion,
    request_sha256: record.expected.requestSha256,
    projection_sha256: record.projectionSha256,
    projection_json: projectionJson,
    produced_at: new Date(record.producedAtMs).toISOString(),
    expires_at: new Date(record.expiresAtMs).toISOString(),
  });
  if (!value) throw new Error("Execution approval publication pin violated the wire contract.");
  return value;
}

/** Optional, bounded approval-evidence publication. It owns no provider or credential recovery. */
export class ExecutionApprovalPublisher {
  private readonly store: ExecutionApprovalPublicationStore;
  private readonly executor: EffectExecutor;
  private readonly ownsExecutor: boolean;
  private recoveredOwnedExecutor = false;
  private readonly cancellation = new AbortController();
  private readonly pendingAgents = new Set<string>();
  private readonly admissionRetryAt = new Map<string, number>();
  /** Local recheck throttle for still-open `acknowledged` pins waiting on local decision; outbound HTTP retry backoff lives durably in `effects`. */
  private readonly acknowledgedCheckAt = new Map<string, number>();
  private readonly pendingDispatchAuthority = new Map<string, PublicationAuthority>();
  private readonly pendingPublishProjection = new Map<string, { projectionSha256: string; json: string }>();
  private readonly pendingPublishSettlements = new Map<string, PendingPublishSettlement>();
  private readonly pendingCloseSettlements = new Map<string, PendingCloseSettlement>();
  private scheduled: NodeJS.Timeout | null = null;
  private scheduledFor = Infinity;
  private started: boolean;
  private running = false;
  private closed = false;
  private scanAfter = "";

  static attach(database: DatabaseSync, options: ExecutionApprovalPublisherOptions): ExecutionApprovalPublisher {
    const publisher = new ExecutionApprovalPublisher(database, options);
    if (options.startImmediately !== false) publisher.schedule(0);
    return publisher;
  }

  constructor(private readonly database: DatabaseSync, private readonly options: ExecutionApprovalPublisherOptions) {
    this.started = options.startImmediately !== false;
    this.store = new ExecutionApprovalPublicationStore(database, options.assertWriteFence);
    this.ownsExecutor = !options.effectExecutor;
    this.executor = options.effectExecutor ?? new EffectExecutor({
      getDatabase: () => this.database,
      currentDaemonGeneration: () => this.options.daemonGeneration(),
      assertCurrent: () => this.options.assertCurrent(),
      assertWriteFence: () => { this.options.assertWriteFence?.(); },
      isClosing: () => this.closed || this.options.isClosing(),
      nowMs: () => this.now(),
      nowIso: () => this.nowIso(),
    });
    this.executor.registerHandler(EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND, this.createPublishEffectHandler());
    this.executor.registerHandler(EXECUTION_APPROVAL_CLOSE_EFFECT_KIND, this.createCloseEffectHandler());
  }

  /** Arm the background publisher loop after daemon startup recovery completes. */
  start(): void {
    if (this.unavailable()) return;
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  /**
   * Recovers orphaned/inactive `executing` approval-publication effects for
   * `agentId` back to `prepared` (for example before purge preparation), while
   * leaving any genuinely active in-flight execution untouched in `executing`
   * so purge cannot commit out from under live HTTP work.
   */
  recoverInactiveExecutingForAgent(agentId: string): number {
    if (this.unavailable()) return 0;
    const now = this.now();
    let recovered = 0;
    for (const effect of listActiveExecutionApprovalEffectsForAgent(this.database, agentId)) {
      if (effect.state !== "executing") continue;
      const next = this.recoverInactiveExecutingEffect(effect, now);
      if (next.state !== "executing") recovered += 1;
    }
    return recovered;
  }

  /** Post-observation hint only; native inspection and SQLite work run on the coalesced lane. */
  changed(agentId: string): void {
    if (this.unavailable() || typeof agentId !== "string" || !agentId.trim()) return;
    if (this.pendingAgents.size >= MAX_ADMISSION_AGENTS && !this.pendingAgents.has(agentId)) {
      this.report("storage_unavailable");
      return;
    }
    this.pendingAgents.add(agentId);
    this.schedule(COALESCE_MS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancellation.abort();
    if (this.ownsExecutor) this.executor.fence();
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.scheduledFor = Infinity;
    this.pendingAgents.clear();
    this.admissionRetryAt.clear();
    this.acknowledgedCheckAt.clear();
    this.pendingDispatchAuthority.clear();
    this.pendingPublishProjection.clear();
    this.pendingPublishSettlements.clear();
    this.pendingCloseSettlements.clear();
  }

  private unavailable(): boolean { return this.closed || this.options.isClosing() || this.executor.isFenced; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private nowIso(): string { return new Date(this.now()).toISOString(); }
  private writeFence = (): void => { this.options.assertWriteFence?.(); };
  private report(code: Parameters<NonNullable<ExecutionApprovalPublisherOptions["diagnostic"]>>[0]): void {
    try { if (this.options.diagnostic) this.options.diagnostic(code); else console.warn(`[execution_approval_publication] ${code}`); }
    catch { /* diagnostics are optional */ }
  }

  private terminalize(
    record: ExecutionApprovalPublicationRecord,
    state: "conflict" | "expired" | "invalid",
    options?: { requireNoPendingRoomMove?: boolean; effectError?: string },
  ): void {
    const recordKey = key(record);
    let skipped = false;
    withFencedEffectTransaction(this.database, this.writeFence, () => {
      if (options?.requireNoPendingRoomMove && hasPendingRoomMoveForAgent(this.database, record.agentId)) {
        skipped = true;
        return;
      }
      if (state === "conflict") this.store.conflictInTransaction(record);
      else if (state === "expired") this.store.expireInTransaction(record);
      else this.store.invalidateInTransaction(record);
      const matchingEffectIds = listActiveExecutionApprovalEffectsForAgent(this.database, record.agentId)
        .filter(effect => effectIdentityKey(effect) === recordKey)
        .map(effect => effect.id);
      if (matchingEffectIds.length > 0) {
        cancelPreparedExecutionApprovalEffectsInTransaction(this.database, {
          effectIds: matchingEffectIds,
          expectedEpoch: this.options.daemonGeneration(),
          error: options?.effectError ?? `publication_${state}`,
          nowIso: this.nowIso(),
        });
      }
      pruneTerminalExecutionApprovalEffectsInTransaction(this.database, record.agentId);
    });
    if (!skipped) this.acknowledgedCheckAt.delete(recordKey);
  }

  private tryTerminalize(
    record: ExecutionApprovalPublicationRecord,
    state: "conflict" | "expired" | "invalid",
    options?: { requireNoPendingRoomMove?: boolean; effectError?: string },
  ): void {
    try {
      this.terminalize(record, state, options);
    } catch (error) {
      if (error instanceof DaemonFenceLostError) throw error;
      if (error instanceof EffectFenceError) {
        if (this.unavailable()) return;
        throw error;
      }
      if (!this.unavailable()) this.report("storage_unavailable");
    }
  }

  private schedule(delay: number): void {
    if (!this.started || this.unavailable()) return;
    const due = Date.now() + delay;
    if (this.scheduled && this.scheduledFor <= due) return;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduledFor = due;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      this.scheduledFor = Infinity;
      void this.flush();
    }, delay);
    this.scheduled.unref();
  }

  private currentAuthority(agentId: string) {
    if (this.unavailable()) return null;
    const current = currentWorkerPublicationAuthority(
      this.options.custody,
      agentId,
      this.options.daemonGeneration(),
      this.now(),
    );
    return current?.grant.ownerAccountId && current.grant.scopeKey === "owner" ? current : null;
  }

  private matchesDispatchAuthority(
    record: ExecutionApprovalPublicationRecord,
    authority: PublicationAuthority,
  ): boolean {
    if (this.unavailable()) return false;
    const current = this.currentAuthority(record.agentId);
    return Boolean(
      current
      && current.grant === authority.grant
      && current.worker === authority.worker
      && sameWorkerPublicationOrigin(current.origin, record)
      && current.worker.workAttemptId === record.workAttemptId,
    );
  }

  private createPublishEffectHandler(): EffectHandler {
    return {
      retryable: true,
      autoPump: false,
      defaultMaxAttempts: EXECUTION_APPROVAL_EFFECT_MAX_ATTEMPTS,
      backoff: { baseDelayMs: RETRY_MS, maxDelayMs: RETRY_MS, factor: 1 },
      authorizeClaim: (_database, effect) => {
        const payload = parseExecutionApprovalPublishEffectPayload(effect.payload);
        if (!payload) return "Execution approval publication effect payload is invalid.";
        const record = this.store.getByIdentity({
          agentId: effect.agent_id,
          roomId: payload.room_id,
          delegationInstanceId: payload.delegation_instance_id,
          delegationRevision: payload.delegation_revision,
          requestId: payload.request_id,
          requestVersion: payload.request_version,
        });
        if (!record || record.state !== "attempted" || record.projectionSha256 !== payload.projection_sha256) {
          return "Execution approval publication is no longer pending.";
        }
        if (record.expiresAtMs <= this.now()) {
          return "Execution approval publication has expired.";
        }
        return null;
      },
      execute: async (claimed, context) => {
        const payload = parseExecutionApprovalPublishEffectPayload(claimed.payload);
        if (!payload) {
          return { status: "failed", error: "Execution approval publication effect payload is invalid." };
        }
        const record = this.store.getByIdentity({
          agentId: claimed.agent_id,
          roomId: payload.room_id,
          delegationInstanceId: payload.delegation_instance_id,
          delegationRevision: payload.delegation_revision,
          requestId: payload.request_id,
          requestVersion: payload.request_version,
        });
        if (!record || record.state !== "attempted" || record.projectionSha256 !== payload.projection_sha256) {
          return { status: "failed", error: "publication_superseded_before_dispatch" };
        }
        const expected = this.pendingDispatchAuthority.get(claimed.id);
        const current = this.currentAuthority(record.agentId);
        if (this.unavailable() || context.signal.aborted
          || !current || !sameWorkerPublicationOrigin(current.origin, record)
          || current.worker.workAttemptId !== record.workAttemptId
          || (expected && (current.grant !== expected.grant || current.worker !== expected.worker))) {
          return { status: "retry", error: "authority_unavailable", retryAfterMs: 0 };
        }
        let projectionJson = this.pendingPublishProjection.get(claimed.id)?.projectionSha256 === record.projectionSha256
          ? this.pendingPublishProjection.get(claimed.id)!.json
          : null;
        if (projectionJson === null) {
          try {
            const loaded = await this.options.entries.readExecutionApprovalProjection(record.expected);
            if (!loaded || loaded.sha256 !== record.projectionSha256 || loaded.producedAtMs !== record.producedAtMs) {
              return { status: "failed", error: "publication_projection_invalid" };
            }
            projectionJson = loaded.json;
          } catch (error) {
            if (error instanceof DaemonFenceLostError) throw error;
            if (!this.unavailable()) this.report("publication_unavailable");
            return { status: "retry", error: "publication_unavailable" };
          }
        }
        const signal = AbortSignal.any([context.signal, this.cancellation.signal]);
        let result: ExecutionApprovalPublicationHttpResult;
        try {
          result = await (this.options.publish ?? publishExecutionApproval)({
            apiOrigin: record.apiOrigin,
            grantId: current.grant.grantId,
            supervisorGrant: current.grant.supervisorGrant,
            grantGeneration: current.grant.grantGeneration,
            sessionId: current.worker.agentSessionId,
            agentKey: record.agentKey,
            signal,
            publication: publication(record, projectionJson),
          });
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (this.unavailable() || signal.aborted) {
            return { status: "retry", error: "publication_cancelled_on_close", retryAfterMs: 0 };
          }
          // Never persist raw provider/HTTP exception text or tokens in `effects.last_error`.
          this.report("publication_unavailable");
          return { status: "retry", error: "publication_unavailable" };
        }
        try {
          await context.assertCurrent();
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (!this.unavailable()) this.report("authority_unavailable");
          return { status: "retry", error: "authority_unavailable", retryAfterMs: 0 };
        }
        const after = this.currentAuthority(record.agentId);
        if (this.unavailable() || signal.aborted || after?.grant !== current.grant || after?.worker !== current.worker) {
          return { status: "retry", error: "publication_cancelled_on_close", retryAfterMs: 0 };
        }
        this.pendingPublishSettlements.set(claimed.id, {
          attemptCount: claimed.attempt_count,
          authority: current,
          record,
          result,
        });
        const outcome = result.status === "acknowledged"
          ? {
              status: "acknowledged" as const,
              publication_id: result.publicationId,
              publication_digest: result.publicationDigest,
            }
          : result.status === "terminal"
            ? { status: "terminal" as const, reason: result.reason }
            : { status: "conflict" as const };
        return { status: "completed", outcome };
      },
      settle: async (claimed, executionResult, defaultSettle) => {
        const pending = this.pendingPublishSettlements.get(claimed.id);
        this.pendingPublishSettlements.delete(claimed.id);
        if (executionResult.status !== "completed") {
          return this.runDefaultSettle(defaultSettle);
        }
        if (this.unavailable() || !pending || pending.attemptCount !== claimed.attempt_count) {
          return this.rescheduleSettlementRejection(claimed, "publication_cancelled_on_close");
        }
        if (!this.matchesDispatchAuthority(pending.record, pending.authority)) {
          return this.rescheduleSettlementRejection(claimed, "authority_changed_before_settlement");
        }
        try {
          const settled = withFencedEffectTransaction(this.database, this.writeFence, () => {
            if (!this.matchesDispatchAuthority(pending.record, pending.authority)) {
              throw new ApprovalCustodyLostError();
            }
            if (pending.result.status === "conflict") {
              this.store.conflictInTransaction(pending.record);
            } else if (pending.result.status === "terminal") {
              if (pending.result.reason === "expired") this.store.expireInTransaction(pending.record);
              else this.store.invalidateInTransaction(pending.record);
            } else {
              if (!this.store.acknowledgeInTransaction(pending.record, pending.result)) {
                throw new Error("Execution approval publication receipt was not journaled.");
              }
            }
            const completed = completeEffectInTransaction(this.database, {
              id: claimed.id,
              expectedEpoch: claimed.epoch,
              expectedAttemptCount: claimed.attempt_count,
              outcome: executionResult.outcome,
              nowIso: this.nowIso(),
            });
            pruneTerminalExecutionApprovalEffectsInTransaction(this.database, claimed.agent_id);
            return completed;
          });
          this.acknowledgedCheckAt.delete(key(pending.record));
          if (pending.result.status === "conflict") this.report("publication_conflict");
          return settled;
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (error instanceof ApprovalCustodyLostError) {
            return this.rescheduleSettlementRejection(claimed, "authority_changed_before_settlement");
          }
          return this.handleSettlementStorageFailure(claimed, error);
        }
      },
    };
  }

  private createCloseEffectHandler(): EffectHandler {
    return {
      retryable: true,
      autoPump: false,
      defaultMaxAttempts: EXECUTION_APPROVAL_EFFECT_MAX_ATTEMPTS,
      backoff: { baseDelayMs: RETRY_MS, maxDelayMs: RETRY_MS, factor: 1 },
      authorizeClaim: (_database, effect) => {
        const payload = parseExecutionApprovalCloseEffectPayload(effect.payload);
        if (!payload) return "Execution approval close effect payload is invalid.";
        const record = this.store.getByIdentity({
          agentId: effect.agent_id,
          roomId: payload.room_id,
          delegationInstanceId: payload.delegation_instance_id,
          delegationRevision: payload.delegation_revision,
          requestId: payload.request_id,
          requestVersion: payload.request_version,
        });
        if (!record || record.state !== "closing"
          || record.publicationId !== payload.publication_id
          || record.publicationDigest !== payload.publication_digest) {
          return "Execution approval publication closure is no longer pending.";
        }
        if (record.expiresAtMs <= this.now()) {
          return "Execution approval publication has expired.";
        }
        return null;
      },
      execute: async (claimed, context) => {
        const payload = parseExecutionApprovalCloseEffectPayload(claimed.payload);
        if (!payload) {
          return { status: "failed", error: "Execution approval close effect payload is invalid." };
        }
        const record = this.store.getByIdentity({
          agentId: claimed.agent_id,
          roomId: payload.room_id,
          delegationInstanceId: payload.delegation_instance_id,
          delegationRevision: payload.delegation_revision,
          requestId: payload.request_id,
          requestVersion: payload.request_version,
        });
        if (!record || record.state !== "closing"
          || record.publicationId !== payload.publication_id
          || record.publicationDigest !== payload.publication_digest) {
          return { status: "failed", error: "publication_close_superseded_before_dispatch" };
        }
        const expected = this.pendingDispatchAuthority.get(claimed.id);
        const current = this.currentAuthority(record.agentId);
        if (this.unavailable() || context.signal.aborted
          || !current || !sameWorkerPublicationOrigin(current.origin, record)
          || current.worker.workAttemptId !== record.workAttemptId
          || (expected && (current.grant !== expected.grant || current.worker !== expected.worker))) {
          return { status: "retry", error: "authority_unavailable", retryAfterMs: 0 };
        }
        const signal = AbortSignal.any([context.signal, this.cancellation.signal]);
        let result: ExecutionApprovalPublicationCloseHttpResult;
        try {
          result = await (this.options.closePublication ?? closeExecutionApprovalPublication)({
            apiOrigin: record.apiOrigin,
            grantId: current.grant.grantId,
            supervisorGrant: current.grant.supervisorGrant,
            grantGeneration: current.grant.grantGeneration,
            sessionId: current.worker.agentSessionId,
            agentKey: record.agentKey,
            signal,
            publicationId: payload.publication_id,
            publicationDigest: payload.publication_digest,
          });
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (this.unavailable() || signal.aborted) {
            return { status: "retry", error: "publication_cancelled_on_close", retryAfterMs: 0 };
          }
          this.report("publication_unavailable");
          return { status: "retry", error: "publication_unavailable" };
        }
        try {
          await context.assertCurrent();
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (!this.unavailable()) this.report("authority_unavailable");
          return { status: "retry", error: "authority_unavailable", retryAfterMs: 0 };
        }
        const after = this.currentAuthority(record.agentId);
        if (this.unavailable() || signal.aborted || after?.grant !== current.grant || after?.worker !== current.worker) {
          return { status: "retry", error: "publication_cancelled_on_close", retryAfterMs: 0 };
        }
        this.pendingCloseSettlements.set(claimed.id, {
          attemptCount: claimed.attempt_count,
          authority: current,
          record,
          result,
        });
        const outcome = result.status === "closed"
          ? { status: "closed" as const, closed_at_ms: result.closedAtMs }
          : result.status === "terminal"
            ? { status: "terminal" as const, reason: result.reason }
            : { status: "conflict" as const };
        return { status: "completed", outcome };
      },
      settle: async (claimed, executionResult, defaultSettle) => {
        const pending = this.pendingCloseSettlements.get(claimed.id);
        this.pendingCloseSettlements.delete(claimed.id);
        if (executionResult.status !== "completed") {
          return this.runDefaultSettle(defaultSettle);
        }
        if (this.unavailable() || !pending || pending.attemptCount !== claimed.attempt_count) {
          return this.rescheduleSettlementRejection(claimed, "publication_cancelled_on_close");
        }
        if (!this.matchesDispatchAuthority(pending.record, pending.authority)) {
          return this.rescheduleSettlementRejection(claimed, "authority_changed_before_settlement");
        }
        try {
          const settled = withFencedEffectTransaction(this.database, this.writeFence, () => {
            if (!this.matchesDispatchAuthority(pending.record, pending.authority)) {
              throw new ApprovalCustodyLostError();
            }
            if (pending.result.status === "conflict") {
              this.store.conflictInTransaction(pending.record);
            } else if (pending.result.status === "terminal") {
              if (pending.result.reason === "expired") this.store.expireInTransaction(pending.record);
              else this.store.invalidateInTransaction(pending.record);
            } else {
              if (!this.store.acknowledgeCloseInTransaction(pending.record, pending.result.closedAtMs)) {
                throw new Error("Execution approval publication closure was not journaled.");
              }
            }
            const completed = completeEffectInTransaction(this.database, {
              id: claimed.id,
              expectedEpoch: claimed.epoch,
              expectedAttemptCount: claimed.attempt_count,
              outcome: executionResult.outcome,
              nowIso: this.nowIso(),
            });
            pruneTerminalExecutionApprovalEffectsInTransaction(this.database, claimed.agent_id);
            return completed;
          });
          this.acknowledgedCheckAt.delete(key(pending.record));
          if (pending.result.status === "conflict") this.report("publication_conflict");
          return settled;
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (error instanceof ApprovalCustodyLostError) {
            return this.rescheduleSettlementRejection(claimed, "authority_changed_before_settlement");
          }
          return this.handleSettlementStorageFailure(claimed, error);
        }
      },
    };
  }

  private runDefaultSettle(defaultSettle: () => EffectRecord): EffectRecord {
    try {
      return defaultSettle();
    } catch (error) {
      if (error instanceof DaemonFenceLostError) throw error;
      if (error instanceof EffectFenceError) throw error;
      if (!this.unavailable()) this.report("storage_unavailable");
      throw new ApprovalSettlementStorageError(error);
    }
  }

  private handleSettlementStorageFailure(claimed: EffectRecord, error: unknown): EffectRecord {
    if (this.unavailable()) throw error;
    if (error instanceof EffectFenceError) throw error;
    this.report("storage_unavailable");
    try {
      return this.rescheduleExecutingEffect(claimed, this.now() + RETRY_MS, "settlement_write_failed");
    } catch (retryError) {
      if (retryError instanceof DaemonFenceLostError) throw retryError;
      throw new ApprovalSettlementStorageError(error);
    }
  }

  private rescheduleExecutingEffect(effect: EffectRecord, nextAttemptAtMs: number, error: string): EffectRecord {
    if (effect.attempt_count < effect.max_attempts) {
      return rescheduleEffectForRetry(this.database, this.writeFence, {
        id: effect.id,
        expectedEpoch: effect.epoch,
        expectedAttemptCount: effect.attempt_count,
        nextAttemptAtMs: Math.max(0, nextAttemptAtMs),
        error,
        nowIso: this.nowIso(),
      });
    }
    return failEffect(this.database, this.writeFence, {
      id: effect.id,
      expectedEpoch: effect.epoch,
      expectedAttemptCount: effect.attempt_count,
      error,
      nowIso: this.nowIso(),
    });
  }

  private rescheduleCancelledEffect(claimed: EffectRecord, error: string): EffectRecord {
    return this.rescheduleExecutingEffect(claimed, this.now(), error);
  }

  private rescheduleSettlementRejection(claimed: EffectRecord, error: string): EffectRecord {
    try {
      return this.rescheduleCancelledEffect(claimed, error);
    } catch (retryError) {
      if (retryError instanceof DaemonFenceLostError) throw retryError;
      if (retryError instanceof EffectFenceError) throw retryError;
      if (!this.unavailable()) this.report("storage_unavailable");
      throw new ApprovalSettlementStorageError(retryError);
    }
  }

  /**
   * Recovers an orphaned `executing` approval-publication effect whose
   * execution promise is no longer active in this process (for example after a
   * failed SQLite settlement write left the row `executing`). Never touches
   * genuinely active in-flight executions or future-epoch rows.
   */
  private recoverInactiveExecutingEffect(effect: EffectRecord, now: number): EffectRecord {
    if (effect.state !== "executing") return effect;
    if (this.executor.isEffectActive(effect.id)) return effect;
    if (effect.attempt_count < 1 || effect.epoch > this.options.daemonGeneration()) return effect;
    const updatedAtMs = Date.parse(effect.updated_at);
    const baseMs = Number.isFinite(updatedAtMs) ? Math.min(updatedAtMs, now) : now;
    try {
      return this.rescheduleExecutingEffect(effect, baseMs + RETRY_MS, "recovered_inactive_executing_effect");
    } catch (error) {
      if (error instanceof DaemonFenceLostError) throw error;
      if (!this.unavailable()) this.report("storage_unavailable");
      return effect;
    }
  }

  private async admit(agentId: string): Promise<void> {
    const authority = this.currentAuthority(agentId);
    if (!authority || !authority.worker.workAttemptId) return;
    const approvals = await this.options.approvals.admitDelegatable(agentId);
    await this.options.assertCurrent();
    const current = this.currentAuthority(agentId);
    if (this.unavailable() || current?.grant !== authority.grant || current?.worker !== authority.worker) return;
    const delegations = await this.options.entries.listExecutionDelegationsForApprovalPublication({
      agentId,
      roomId: authority.origin.roomId,
      agentKey: authority.origin.agentKey,
      ownerAccountId: authority.grant.ownerAccountId!,
      hostId: authority.origin.hostId,
      installationId: authority.origin.installationId,
      grantId: authority.grant.grantId,
      atMs: this.now(),
    });
    await this.options.assertCurrent();
    const afterList = this.currentAuthority(agentId);
    if (this.unavailable() || afterList?.grant !== authority.grant || afterList?.worker !== authority.worker) return;
    for (const admitted of approvals) {
      if (admitted.owned.workAttemptId !== authority.worker.workAttemptId
        || admitted.owned.provider !== "codex"
        || admitted.owned.executionGenerationId !== admitted.approval.request.executionGenerationId
        || admitted.approval.request.agentId !== agentId
        || admitted.approval.request.roomId !== authority.origin.roomId
        || !/^msg_[1-9]\d{0,9}$/.test(admitted.sourceMessageId)
        || Number(admitted.sourceMessageId.slice(4)) > 2_147_483_647
        || admitted.projection.requestId !== admitted.approval.request.requestId
        || admitted.projection.requestVersion !== admitted.approval.request.requestVersion
        || admitted.projection.requestSha256 !== admitted.approval.request.requestSha256
        || admitted.projection.agentId !== agentId
        || admitted.projection.roomId !== authority.origin.roomId
        || admitted.projection.executionGenerationId !== admitted.approval.request.executionGenerationId
        || admitted.projection.turnId !== admitted.approval.request.turnId) continue;
      const request = admitted.approval.request;
      const expected = { requestId: request.requestId, requestVersion: request.requestVersion,
        requestSha256: request.requestSha256, agentId: request.agentId, roomId: request.roomId,
        executionGenerationId: request.executionGenerationId, runtimeGenerationId: request.runtimeGenerationId,
        turnId: request.turnId, providerContinuationId: request.providerContinuationId,
        providerTurnId: request.providerTurnId, connectionId: request.connectionId, nativeRequestId: request.nativeRequestId };
      for (const delegation of delegations) {
        const expiresAtMs = Math.min(request.expiresAtMs, delegation.expiresAtMs);
        if (expiresAtMs <= this.now() || admitted.projection.producedAtMs >= expiresAtMs) continue;
        try {
          this.store.pin(publicationPinFrom(authority.origin, delegation, {
            sourceMessageId: admitted.sourceMessageId,
            inboxItemId: admitted.owned.inboxItemId,
            workAttemptId: admitted.owned.workAttemptId,
            expected,
            projectionSha256: admitted.projection.sha256,
            producedAtMs: admitted.projection.producedAtMs,
            expiresAtMs,
          }), this.now());
        } catch (error) {
          this.report("storage_unavailable");
          throw error;
        }
      }
    }
  }

  private durableAgentRoomId(agentId: string): string | null {
    try {
      const row = this.database.prepare("SELECT room_id FROM agents WHERE agent_id=?").get(agentId) as
        | { room_id?: unknown }
        | undefined;
      return row && typeof row.room_id === "string" ? row.room_id : null;
    } catch {
      return null;
    }
  }

  private hasNonTerminalRoomMove(agentId: string): boolean {
    try {
      return hasPendingRoomMoveForAgent(this.database, agentId);
    } catch {
      // Fail closed on unexpected storage errors so compensatable moves never drop retries.
      return true;
    }
  }

  private nextOpenAgentAfter(after: string): string | null {
    const row = this.database.prepare(`
      SELECT agent_id FROM (
        SELECT agent_id FROM execution_approval_publications
        WHERE state IN ('open','attempted','acknowledged','closing')
        UNION
        SELECT agent_id FROM effects
        WHERE kind IN (?, ?) AND state IN ('prepared', 'executing')
      )
      WHERE agent_id > ? ORDER BY agent_id LIMIT 1
    `).get(EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND, EXECUTION_APPROVAL_CLOSE_EFFECT_KIND, after) as
      | { agent_id?: unknown }
      | undefined;
    return row && typeof row.agent_id === "string" ? row.agent_id : null;
  }

  private nextOpenAgent(): string | null {
    let next = this.nextOpenAgentAfter(this.scanAfter);
    if (!next) { this.scanAfter = ""; next = this.nextOpenAgentAfter(""); }
    if (next) this.scanAfter = next;
    return next;
  }

  /**
   * Recovers inactive `executing` approval effects for `agentId` and retires
   * durably obsolete `prepared` rows across both approval effect kinds.
   * Temporary missing authority (stopped agent, expired grant, or handoff in
   * the same room) and non-terminal room moves (whose compensation can restore
   * the source room and authority) preserve `prepared` rows and deadlines.
   */
  private reconcileActiveEffectsForAgent(agentId: string, now: number): EffectRecord[] {
    const recovered = listActiveExecutionApprovalEffectsForAgent(this.database, agentId).map((rawEffect) =>
      rawEffect.state === "executing"
        ? this.recoverInactiveExecutingEffect(rawEffect, now)
        : rawEffect);
    const currentGeneration = this.options.daemonGeneration();
    const roomMoveInProgress = this.hasNonTerminalRoomMove(agentId);
    const durableRoomId = this.durableAgentRoomId(agentId);
    const retirements: Array<{
      id: string;
      error: string;
      requireNoPendingRoomMove?: boolean;
      invalidatePublication?: ExecutionApprovalPublicationIdentity;
    }> = [];

    for (const effect of recovered) {
      if (effect.state !== "prepared" || effect.epoch > currentGeneration) continue;
      if (effect.kind === EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND) {
        const payload = parseExecutionApprovalPublishEffectPayload(effect.payload);
        if (!payload) {
          retirements.push({ id: effect.id, error: "invalid_execution_approval_payload" });
          continue;
        }
        const identity: ExecutionApprovalPublicationIdentity = {
          roomId: payload.room_id,
          delegationInstanceId: payload.delegation_instance_id,
          delegationRevision: payload.delegation_revision,
          requestId: payload.request_id,
          requestVersion: payload.request_version,
        };
        const record = this.store.getByIdentity({ agentId, ...identity });
        if (!record) {
          retirements.push({ id: effect.id, error: "publication_record_missing" });
          continue;
        }
        if (record.state === "closed" || record.state === "conflict" || record.state === "expired" || record.state === "invalid") {
          retirements.push({ id: effect.id, error: `publication_${record.state}` });
          continue;
        }
        if (record.state === "acknowledged" || record.state === "closing") {
          retirements.push({ id: effect.id, error: "publication_already_acknowledged" });
          continue;
        }
        if (record.projectionSha256 !== payload.projection_sha256) {
          retirements.push({ id: effect.id, error: "publication_projection_superseded" });
          continue;
        }
        if (!roomMoveInProgress && durableRoomId !== null && durableRoomId !== payload.room_id) {
          retirements.push({
            id: effect.id,
            error: "room_moved",
            requireNoPendingRoomMove: true,
            invalidatePublication: identity,
          });
        }
        continue;
      }
      if (effect.kind === EXECUTION_APPROVAL_CLOSE_EFFECT_KIND) {
        const payload = parseExecutionApprovalCloseEffectPayload(effect.payload);
        if (!payload) {
          retirements.push({ id: effect.id, error: "invalid_execution_approval_payload" });
          continue;
        }
        const identity: ExecutionApprovalPublicationIdentity = {
          roomId: payload.room_id,
          delegationInstanceId: payload.delegation_instance_id,
          delegationRevision: payload.delegation_revision,
          requestId: payload.request_id,
          requestVersion: payload.request_version,
        };
        const record = this.store.getByIdentity({ agentId, ...identity });
        if (!record) {
          retirements.push({ id: effect.id, error: "publication_record_missing" });
          continue;
        }
        if (record.state === "closed" || record.state === "conflict" || record.state === "expired" || record.state === "invalid") {
          retirements.push({ id: effect.id, error: `publication_${record.state}` });
          continue;
        }
        if (record.state !== "closing"
          || record.publicationId !== payload.publication_id
          || record.publicationDigest !== payload.publication_digest) {
          retirements.push({ id: effect.id, error: "publication_close_superseded" });
          continue;
        }
        if (!roomMoveInProgress && durableRoomId !== null && durableRoomId !== payload.room_id) {
          retirements.push({
            id: effect.id,
            error: "room_moved",
            requireNoPendingRoomMove: true,
            invalidatePublication: identity,
          });
        }
      }
    }

    let retiredIds = new Set<string>();
    if (retirements.length > 0) {
      try {
        retiredIds = new Set(retireObsoleteExecutionApprovalEffects(this.database, this.writeFence, {
          agentId,
          expectedEpoch: currentGeneration,
          retirements,
          nowIso: this.nowIso(),
        }));
      } catch (error) {
        if (error instanceof DaemonFenceLostError) throw error;
        if (error instanceof EffectFenceError) {
          if (!this.unavailable()) throw error;
        } else if (!this.unavailable()) {
          this.report("storage_unavailable");
        }
      }
    }

    return recovered.filter((effect) =>
      !retiredIds.has(effect.id) && (effect.state === "prepared" || effect.state === "executing"),
    );
  }

  /** Deterministic seam for focused real-store tests. No caller awaits this to run an agent. */
  async flush(): Promise<void> {
    if (this.unavailable() || this.running) return;
    this.running = true;
    let more = false;
    let admissionFailed = false;
    try {
      await this.options.assertCurrent();
      if (this.unavailable()) return;
      if (this.ownsExecutor && !this.recoveredOwnedExecutor) {
        if (hasInterruptedExecutionApprovalEffects(this.database)) {
          recoverInterruptedEffectsOnStartup(this.database, this.writeFence, {
            daemonGeneration: this.options.daemonGeneration(),
            nowMs: this.now(),
            nowIso: this.nowIso(),
          });
        }
        this.recoveredOwnedExecutor = true;
      }
      const admissionAgent = [...this.pendingAgents]
        .filter(agentId => (this.admissionRetryAt.get(agentId) ?? -Infinity) <= this.now())
        .sort()[0];
      if (admissionAgent) {
        this.pendingAgents.delete(admissionAgent);
        try {
          await this.admit(admissionAgent);
          this.admissionRetryAt.delete(admissionAgent);
        }
        catch {
          if (!this.unavailable()) {
            this.pendingAgents.add(admissionAgent);
            this.admissionRetryAt.set(admissionAgent, this.now() + RETRY_MS);
            admissionFailed = true;
            this.report("authority_unavailable");
          }
        }
      }
      more = [...this.pendingAgents]
        .some(agentId => (this.admissionRetryAt.get(agentId) ?? -Infinity) <= this.now());
      if (this.unavailable()) return;
      const agentId = this.nextOpenAgent();
      if (!agentId) return;
      more = this.nextOpenAgentAfter(agentId) !== null || more;
      const now = this.now();
      const activeEffects = this.reconcileActiveEffectsForAgent(agentId, now);
      if (this.unavailable()) return;
      const activeByRecordKey = new Map<string, EffectRecord[]>();
      for (const effect of activeEffects) {
        const identityKey = effectIdentityKey(effect);
        if (!identityKey) continue;
        const bucket = activeByRecordKey.get(identityKey);
        if (bucket) bucket.push(effect);
        else activeByRecordKey.set(identityKey, [effect]);
      }
      const eligible: Array<{ record: ExecutionApprovalPublicationRecord; sortAt: number }> = [];
      for (const record of this.store.listOpen(agentId)) {
        const recordKey = key(record);
        const effectsForRecord = activeByRecordKey.get(recordKey) ?? [];
        if (effectsForRecord.some(effect => effect.state === "executing")) continue;
        if (record.expiresAtMs <= now) {
          eligible.push({ record, sortAt: -Infinity });
          continue;
        }
        if (record.state === "acknowledged") {
          const checkedAt = this.acknowledgedCheckAt.get(recordKey);
          if (checkedAt !== undefined && now - checkedAt < RETRY_MS) continue;
          eligible.push({ record, sortAt: checkedAt ?? -Infinity });
          continue;
        }
        if (record.state === "open" || record.state === "attempted") {
          const publishKey = executionApprovalPublishIdempotencyKey({
            roomId: record.roomId,
            delegationInstanceId: record.delegationInstanceId,
            delegationRevision: record.delegationRevision,
            requestId: record.expected.requestId,
            requestVersion: record.expected.requestVersion,
            projectionSha256: record.projectionSha256,
          });
          const existing = getEffectByIdempotencyKey(
            this.database,
            record.agentId,
            EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
            publishKey,
          );
          if (existing) {
            if (existing.state !== "prepared") continue;
            if (existing.next_attempt_at_ms !== null && existing.next_attempt_at_ms > now) continue;
          }
          eligible.push({ record, sortAt: existing?.next_attempt_at_ms ?? -Infinity });
          continue;
        }
        if (record.state === "closing" && record.publicationId && record.publicationDigest) {
          const closeKey = executionApprovalCloseIdempotencyKey({
            roomId: record.roomId,
            delegationInstanceId: record.delegationInstanceId,
            delegationRevision: record.delegationRevision,
            requestId: record.expected.requestId,
            requestVersion: record.expected.requestVersion,
            publicationId: record.publicationId,
            publicationDigest: record.publicationDigest,
          });
          const existing = getEffectByIdempotencyKey(
            this.database,
            record.agentId,
            EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
            closeKey,
          );
          if (existing) {
            if (existing.state !== "prepared") continue;
            if (existing.next_attempt_at_ms !== null && existing.next_attempt_at_ms > now) continue;
          }
          eligible.push({ record, sortAt: existing?.next_attempt_at_ms ?? -Infinity });
        }
      }
      eligible.sort((left, right) => PENDING_PRIORITY[left.record.state] - PENDING_PRIORITY[right.record.state]
        || left.sortAt - right.sortAt);
      more = eligible.length > MAX_UPLOADS_PER_PASS || more;
      const roomMoveInProgress = this.hasNonTerminalRoomMove(agentId);
      const durableRoomId = this.durableAgentRoomId(agentId);
      for (const { record } of eligible.slice(0, MAX_UPLOADS_PER_PASS)) {
        if (record.expiresAtMs <= this.now()) {
          this.tryTerminalize(record, "expired");
          continue;
        }
        if (!roomMoveInProgress && durableRoomId !== null && durableRoomId !== record.roomId) {
          this.tryTerminalize(record, "invalid", { requireNoPendingRoomMove: true, effectError: "room_moved" });
          continue;
        }
        const authority = this.currentAuthority(record.agentId);
        if (!authority) continue;
        if (!sameWorkerPublicationOrigin(authority.origin, record)
          || authority.worker.workAttemptId !== record.workAttemptId) {
          if (this.hasNonTerminalRoomMove(record.agentId)) continue;
          this.tryTerminalize(record, "invalid", { requireNoPendingRoomMove: true });
          continue;
        }
        let effectId: string | null = null;
        try {
          const inbox = await this.options.inbox.get(record.inboxItemId);
          const projection = await this.options.entries.readExecutionApprovalProjection(record.expected);
          let approval: ExecutionApprovalRecord | null = null;
          if (record.state === "open") {
            try {
              await this.options.authority.validateExecutionDelegation({ entryId: record.agentId,
                delegationInstanceId: record.delegationInstanceId, revision: record.delegationRevision,
                approverAccountId: record.approverAccountId, category: "file_change", risk: "low",
                scopeSha256: record.delegationScopeSha256 });
            } catch (error) {
              await this.options.assertCurrent();
              const stillCurrent = this.currentAuthority(record.agentId);
              if (error instanceof ExecutionDelegationJournalError
                && stillCurrent?.grant === authority.grant && stillCurrent.worker === authority.worker) {
                if (["expired", "terminal"].includes(error.code)) this.tryTerminalize(record, "expired");
                else if (error.code === "revision_conflict") this.tryTerminalize(record, "invalid");
                else throw error;
                continue;
              }
              throw error;
            }
          }
          if (record.state === "open" || record.state === "acknowledged") {
            approval = await this.options.entries.getExecutionApproval(record.expected);
          }
          await this.options.assertCurrent();
          const current = this.currentAuthority(record.agentId);
          if (this.unavailable() || current?.grant !== authority.grant || current?.worker !== authority.worker) return;
          if (!inbox || inbox.inbox_item_id !== record.inboxItemId || inbox.agent_id !== record.agentId
            || inbox.room_id !== record.roomId || inbox.source_message_id !== record.sourceMessageId
            || !projection || projection.sha256 !== record.projectionSha256
            || projection.producedAtMs !== record.producedAtMs) {
            this.tryTerminalize(record, "invalid");
            continue;
          }
          if (record.state === "open" && (!approval
            || approval.request.state !== "requested" || approval.decision)) {
            this.tryTerminalize(record, "invalid");
            continue;
          }
          if (record.state === "acknowledged" || record.state === "closing") {
            if (record.state === "acknowledged") {
              if (!approval) throw new Error("Acknowledged execution approval publication lost its local request.");
              if (approval.request.state === "requested" && !approval.decision) {
                this.acknowledgedCheckAt.set(key(record), this.now());
                continue;
              }
            }
            if (!record.publicationId || !record.publicationDigest) {
              throw new Error("Acknowledged execution approval publication lost its exact receipt.");
            }
            const closePayload: ExecutionApprovalCloseEffectPayload = {
              room_id: record.roomId,
              delegation_instance_id: record.delegationInstanceId,
              delegation_revision: record.delegationRevision,
              request_id: record.expected.requestId,
              request_version: record.expected.requestVersion,
              publication_id: record.publicationId,
              publication_digest: record.publicationDigest,
            };
            const closeKey = executionApprovalCloseIdempotencyKey({
              roomId: record.roomId,
              delegationInstanceId: record.delegationInstanceId,
              delegationRevision: record.delegationRevision,
              requestId: record.expected.requestId,
              requestVersion: record.expected.requestVersion,
              publicationId: record.publicationId,
              publicationDigest: record.publicationDigest,
            });
            let preparedClose: EffectRecord;
            if (record.state === "acknowledged") {
              try {
                preparedClose = withFencedEffectTransaction(this.database, this.writeFence, () => {
                  this.store.beginCloseInTransaction(record);
                  return prepareEffectInTransaction(this.database, {
                    agent_id: record.agentId,
                    kind: EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
                    idempotency_key: closeKey,
                    epoch: this.options.daemonGeneration(),
                    payload: closePayload,
                    retryable: true,
                    max_attempts: EXECUTION_APPROVAL_EFFECT_MAX_ATTEMPTS,
                  }, this.nowIso()).effect;
                });
                this.acknowledgedCheckAt.delete(key(record));
              } catch (error) {
                if (error instanceof DaemonFenceLostError) throw error;
                if (error instanceof EffectFenceError) {
                  if (this.unavailable()) return;
                  throw error;
                }
                this.report("storage_unavailable");
                continue;
              }
            } else {
              preparedClose = (await this.executor.prepare({
                agent_id: record.agentId,
                kind: EXECUTION_APPROVAL_CLOSE_EFFECT_KIND,
                idempotency_key: closeKey,
                payload: closePayload,
                retryable: true,
                max_attempts: EXECUTION_APPROVAL_EFFECT_MAX_ATTEMPTS,
              })).effect;
            }
            if (preparedClose.state !== "prepared") continue;
            if (preparedClose.next_attempt_at_ms !== null && preparedClose.next_attempt_at_ms > this.now()) continue;
            effectId = preparedClose.id;
            this.pendingDispatchAuthority.set(effectId, current);
            await this.executor.runEffect(effectId);
            continue;
          }
          const publishPayload: ExecutionApprovalPublishEffectPayload = {
            room_id: record.roomId,
            delegation_instance_id: record.delegationInstanceId,
            delegation_revision: record.delegationRevision,
            request_id: record.expected.requestId,
            request_version: record.expected.requestVersion,
            projection_sha256: record.projectionSha256,
          };
          const publishKey = executionApprovalPublishIdempotencyKey({
            roomId: record.roomId,
            delegationInstanceId: record.delegationInstanceId,
            delegationRevision: record.delegationRevision,
            requestId: record.expected.requestId,
            requestVersion: record.expected.requestVersion,
            projectionSha256: record.projectionSha256,
          });
          let preparedPublish: EffectRecord;
          if (record.state === "open") {
            try {
              preparedPublish = withFencedEffectTransaction(this.database, this.writeFence, () => {
                this.store.markAttemptedInTransaction(record);
                return prepareEffectInTransaction(this.database, {
                  agent_id: record.agentId,
                  kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
                  idempotency_key: publishKey,
                  epoch: this.options.daemonGeneration(),
                  payload: publishPayload,
                  retryable: true,
                  max_attempts: EXECUTION_APPROVAL_EFFECT_MAX_ATTEMPTS,
                }, this.nowIso()).effect;
              });
            } catch (error) {
              if (error instanceof DaemonFenceLostError) throw error;
              if (error instanceof EffectFenceError) {
                if (this.unavailable()) return;
                throw error;
              }
              this.report("storage_unavailable");
              continue;
            }
          } else {
            preparedPublish = (await this.executor.prepare({
              agent_id: record.agentId,
              kind: EXECUTION_APPROVAL_PUBLISH_EFFECT_KIND,
              idempotency_key: publishKey,
              payload: publishPayload,
              retryable: true,
              max_attempts: EXECUTION_APPROVAL_EFFECT_MAX_ATTEMPTS,
            })).effect;
          }
          if (preparedPublish.state !== "prepared") continue;
          if (preparedPublish.next_attempt_at_ms !== null && preparedPublish.next_attempt_at_ms > this.now()) continue;
          effectId = preparedPublish.id;
          this.pendingDispatchAuthority.set(effectId, current);
          this.pendingPublishProjection.set(effectId, {
            projectionSha256: projection.sha256,
            json: projection.json,
          });
          const settled = await this.executor.runEffect(effectId);
          if (settled.state === "completed"
            && (settled.outcome as { status?: unknown } | null)?.status === "acknowledged") {
            more = true;
          }
        } catch (error) {
          if (error instanceof DaemonFenceLostError) throw error;
          if (error instanceof EffectClaimRefusedError) continue;
          if (error instanceof ApprovalSettlementStorageError) continue;
          if (error instanceof EffectFenceError) {
            if (this.unavailable()) return;
            throw error;
          }
          if (!this.unavailable()) this.report("publication_unavailable");
        } finally {
          if (effectId) {
            this.pendingDispatchAuthority.delete(effectId);
            this.pendingPublishProjection.delete(effectId);
            this.pendingPublishSettlements.delete(effectId);
            this.pendingCloseSettlements.delete(effectId);
          }
        }
      }
    } catch {
      if (!this.unavailable()) this.report("authority_unavailable");
    } finally {
      this.running = false;
      const nextAdmissionRetry = [...this.pendingAgents].reduce((next, agentId) =>
        Math.min(next, this.admissionRetryAt.get(agentId) ?? this.now()), Infinity);
      const delay = more || nextAdmissionRetry <= this.now()
        ? COALESCE_MS
        : Math.min(RETRY_MS, Math.max(COALESCE_MS, nextAdmissionRetry - this.now()));
      if (admissionFailed && delay > COALESCE_MS && this.scheduled) {
        clearTimeout(this.scheduled);
        this.scheduled = null;
        this.scheduledFor = Infinity;
      }
      this.schedule(delay);
    }
  }
}
