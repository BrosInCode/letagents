import type { DatabaseSync } from "node:sqlite";

import {
  EXECUTION_APPROVAL_PUBLICATION_VERSION,
  parseExecutionApprovalPublicationInput,
  type ExecutionApprovalPublicationInput,
} from "../../../shared/execution-approval-publication.mjs";
import { openDaemonStateObservationDatabase } from "./daemon-state-database.js";
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
  publish?(input: ExecutionApprovalPublicationHttpInput): Promise<ExecutionApprovalPublicationHttpResult>;
  closePublication?(input: ExecutionApprovalPublicationCloseHttpInput): Promise<ExecutionApprovalPublicationCloseHttpResult>;
  diagnostic?(code: "storage_unavailable" | "authority_unavailable" | "publication_unavailable" | "publication_conflict"): void;
  now?(): number;
};

const COALESCE_MS = 1_000;
const RETRY_MS = 30_000;
const MAX_ADMISSION_AGENTS = 1_024;
const MAX_UPLOADS_PER_PASS = 4;
const PENDING_PRIORITY: Record<ExecutionApprovalPublicationRecord["state"], number> = {
  attempted: 0, closing: 1, open: 2, acknowledged: 3,
  closed: 4, conflict: 4, expired: 4, invalid: 4,
};
const key = (record: ExecutionApprovalPublicationRecord) => JSON.stringify([
  record.agentId, record.roomId, record.delegationInstanceId, record.delegationRevision,
  record.expected.requestId, record.expected.requestVersion,
]);

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
  private readonly cancellation = new AbortController();
  private readonly pendingAgents = new Set<string>();
  private readonly admissionRetryAt = new Map<string, number>();
  private readonly attemptedAt = new Map<string, number>();
  private scheduled: NodeJS.Timeout | null = null;
  private scheduledFor = Infinity;
  private running = false;
  private closed = false;
  private scanAfter = "";

  static open(path: string, options: ExecutionApprovalPublisherOptions): ExecutionApprovalPublisher | null {
    try {
      const publisher = new ExecutionApprovalPublisher(openDaemonStateObservationDatabase(path), options);
      publisher.schedule(0);
      return publisher;
    } catch {
      console.warn("[execution_approval_publication] storage_unavailable");
      return null;
    }
  }

  constructor(private readonly database: DatabaseSync, private readonly options: ExecutionApprovalPublisherOptions) {
    this.store = new ExecutionApprovalPublicationStore(database);
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
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.scheduledFor = Infinity;
    this.pendingAgents.clear();
    this.admissionRetryAt.clear();
    this.attemptedAt.clear();
    try { this.database.close(); } catch { this.report("storage_unavailable"); }
  }

  private unavailable(): boolean { return this.closed || this.options.isClosing(); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private report(code: Parameters<NonNullable<ExecutionApprovalPublisherOptions["diagnostic"]>>[0]): void {
    try { if (this.options.diagnostic) this.options.diagnostic(code); else console.warn(`[execution_approval_publication] ${code}`); }
    catch { /* diagnostics are optional */ }
  }
  private terminalize(record: ExecutionApprovalPublicationRecord, state: "conflict" | "expired" | "invalid"): void {
    if (state === "conflict") this.store.conflict(record);
    else if (state === "expired") this.store.expire(record);
    else this.store.invalidate(record);
    this.attemptedAt.delete(key(record));
  }
  private schedule(delay: number): void {
    if (this.unavailable()) return;
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

  private nextOpenAgent(): string | null {
    let next = this.store.nextOpenAgent(this.scanAfter);
    if (!next) { this.scanAfter = ""; next = this.store.nextOpenAgent(""); }
    if (next) this.scanAfter = next;
    return next;
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
      more = this.store.nextOpenAgent(agentId) !== null || more;
      const pending = this.store.listOpen(agentId).filter(record => {
        const prior = this.attemptedAt.get(key(record));
        return prior === undefined || this.now() - prior >= RETRY_MS;
      }).sort((left, right) => PENDING_PRIORITY[left.state] - PENDING_PRIORITY[right.state]
        || (this.attemptedAt.get(key(left)) ?? -Infinity) - (this.attemptedAt.get(key(right)) ?? -Infinity));
      more = pending.length > MAX_UPLOADS_PER_PASS || more;
      for (const record of pending.slice(0, MAX_UPLOADS_PER_PASS)) {
        if (record.expiresAtMs <= this.now()) {
          try { this.terminalize(record, "expired"); } catch { this.report("storage_unavailable"); }
          continue;
        }
        const authority = this.currentAuthority(record.agentId);
        if (!authority) continue;
        if (!sameWorkerPublicationOrigin(authority.origin, record)
          || authority.worker.workAttemptId !== record.workAttemptId) {
          try { this.terminalize(record, "invalid"); } catch { this.report("storage_unavailable"); }
          continue;
        }
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
                if (["expired", "terminal"].includes(error.code)) this.terminalize(record, "expired");
                else if (error.code === "revision_conflict") this.terminalize(record, "invalid");
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
            this.terminalize(record, "invalid");
            continue;
          }
          if (record.state === "open" && (!approval
            || approval.request.state !== "requested" || approval.decision)) {
            this.terminalize(record, "invalid");
            continue;
          }
          const httpAuthority = { apiOrigin: record.apiOrigin, grantId: authority.grant.grantId,
            supervisorGrant: authority.grant.supervisorGrant, grantGeneration: authority.grant.grantGeneration,
            sessionId: authority.worker.agentSessionId, agentKey: record.agentKey, signal: this.cancellation.signal };
          if (record.state === "acknowledged" || record.state === "closing") {
            if (record.state === "acknowledged") {
              if (!approval) throw new Error("Acknowledged execution approval publication lost its local request.");
              if (approval.request.state === "requested" && !approval.decision) {
                this.attemptedAt.set(key(record), this.now());
                continue;
              }
            }
            if (!record.publicationId || !record.publicationDigest) {
              throw new Error("Acknowledged execution approval publication lost its exact receipt.");
            }
            let closing = record;
            if (record.state === "acknowledged") {
              try { closing = this.store.beginClose(record); }
              catch { this.report("storage_unavailable"); continue; }
            }
            this.attemptedAt.set(key(closing), this.now());
            const result = await (this.options.closePublication ?? closeExecutionApprovalPublication)({
              ...httpAuthority, publicationId: closing.publicationId!, publicationDigest: closing.publicationDigest!,
            });
            await this.options.assertCurrent();
            const after = this.currentAuthority(record.agentId);
            if (this.unavailable() || after?.grant !== authority.grant || after?.worker !== authority.worker) return;
            if (result.status === "conflict") {
              this.terminalize(closing, "conflict");
              this.report("publication_conflict");
            } else if (result.status === "terminal") {
              this.terminalize(closing, result.reason === "expired" ? "expired" : "invalid");
            } else {
              if (!this.store.acknowledgeClose(closing, result.closedAtMs)) {
                throw new Error("Execution approval publication closure was not journaled.");
              }
              this.attemptedAt.delete(key(closing));
            }
            continue;
          }
          let dispatch = record;
          if (record.state === "open") {
            try { dispatch = this.store.markAttempted(record); }
            catch { this.report("storage_unavailable"); continue; }
          }
          this.attemptedAt.set(key(dispatch), this.now());
          const result = await (this.options.publish ?? publishExecutionApproval)({
            ...httpAuthority, publication: publication(dispatch, projection.json),
          });
          await this.options.assertCurrent();
          const after = this.currentAuthority(record.agentId);
          if (this.unavailable() || after?.grant !== authority.grant || after?.worker !== authority.worker) return;
          if (result.status === "conflict") {
            this.terminalize(record, "conflict");
            this.report("publication_conflict");
          } else if (result.status === "terminal") {
            this.terminalize(record, result.reason === "expired" ? "expired" : "invalid");
          } else {
            if (!this.store.acknowledge(dispatch, result)) {
              throw new Error("Execution approval publication receipt was not journaled.");
            }
            this.attemptedAt.delete(key(record));
            more = true;
          }
        } catch {
          if (!this.unavailable()) this.report("publication_unavailable");
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
