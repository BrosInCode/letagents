import type { ExecutionDelegationDecisionCoordinatorOptions } from "./execution-delegation-decision-coordinator.js";
import { ExecutionDelegationDecisionCoordinator } from "./execution-delegation-decision-coordinator.js";
import type { ExecutionDelegationSyncOptions } from "./execution-delegation-sync-coordinator.js";
import { ExecutionDelegationSyncCoordinator } from "./execution-delegation-sync-coordinator.js";
import {
  ExecutionApprovalPublisher,
  type ExecutionApprovalPublisherOptions,
} from "./execution-approval-publisher.js";
import type { InstallHostGrantInput, WorkerAuthorityCoordinator } from "./worker-authority-coordinator.js";

type ApprovalPublicationOptions = Omit<ExecutionApprovalPublisherOptions, "approvals" | "entries" | "authority"> & {
  path: string;
};

type Options = {
  entries: ExecutionDelegationSyncOptions["entries"] & ExecutionDelegationDecisionCoordinatorOptions["entries"]
    & ExecutionApprovalPublisherOptions["entries"];
  authority: ExecutionDelegationSyncOptions["authority"] & ExecutionDelegationDecisionCoordinatorOptions["authority"]
    & ExecutionApprovalPublisherOptions["authority"] & Pick<WorkerAuthorityCoordinator, "installHostGrant">;
  approvals: ExecutionDelegationDecisionCoordinatorOptions["approvals"] & ExecutionApprovalPublisherOptions["approvals"];
  remote: ExecutionDelegationSyncOptions["remote"] & ExecutionDelegationDecisionCoordinatorOptions["remote"];
  approvalPublication?: ApprovalPublicationOptions;
  requestConvergence(entryId: string): void;
  diagnostic(domain: "grant" | "decision", entryId: string, error: unknown): void;
};

/** Owns grant, decision, and public-approval reconciliation as one delegation lifecycle domain. */
export class ExecutionDelegationCoordinator {
  private readonly grants: ExecutionDelegationSyncCoordinator;
  private readonly decisions: ExecutionDelegationDecisionCoordinator;
  private approvalPublisher: ExecutionApprovalPublisher | null | undefined;
  private fenced = false;

  constructor(private readonly options: Options) {
    this.decisions = new ExecutionDelegationDecisionCoordinator({
      entries: options.entries,
      authority: options.authority,
      approvals: options.approvals,
      remote: options.remote,
      diagnostic: (entryId, error) => options.diagnostic("decision", entryId, error),
    });
    this.grants = new ExecutionDelegationSyncCoordinator({
      entries: options.entries,
      authority: options.authority,
      remote: options.remote,
      entryObserved: (entryId) => this.requestDecisions(entryId),
      requestConvergence: (entryId) => {
        options.requestConvergence(entryId);
        this.approvalPublicationChanged(entryId);
      },
      diagnostic: (entryId, error) => options.diagnostic("grant", entryId, error),
    });
  }

  request(entryId: string): void {
    if (this.fenced) return;
    void this.grants.request(entryId).catch((error) => this.options.diagnostic("grant", entryId, error));
    this.requestDecisions(entryId);
  }

  requestRoom(roomId: string): void {
    if (this.fenced) return;
    void this.grants.requestRoom(roomId).catch((error) => this.options.diagnostic("grant", roomId, error));
  }

  requestDecisions(entryId: string): void {
    if (this.fenced) return;
    void this.decisions.request(entryId).catch((error) => this.options.diagnostic("decision", entryId, error));
    this.approvalPublicationChanged(entryId);
  }

  start(): void {
    const options = this.options.approvalPublication;
    if (this.fenced || !options || this.approvalPublisher !== undefined) return;
    const { path, ...publisherOptions } = options;
    this.approvalPublisher = ExecutionApprovalPublisher.open(path, {
      ...publisherOptions,
      approvals: this.options.approvals,
      entries: this.options.entries,
      authority: this.options.authority,
    });
  }

  async installHostGrant(input: InstallHostGrantInput): ReturnType<WorkerAuthorityCoordinator["installHostGrant"]> {
    const status = await this.options.authority.installHostGrant(input);
    if (status.status === "installed") this.request(input.entry_id);
    return status;
  }

  async fenceAndDrain(): Promise<void> {
    this.fenced = true;
    this.approvalPublisher?.close();
    await Promise.all([this.grants.fenceAndDrain(), this.decisions.fenceAndDrain()]);
  }

  private approvalPublicationChanged(entryId: string): void {
    if (this.fenced || !this.options.approvalPublication) return;
    this.start();
    this.approvalPublisher?.changed(entryId);
  }
}
