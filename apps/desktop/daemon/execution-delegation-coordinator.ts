import type { ExecutionDelegationDecisionCoordinatorOptions } from "./execution-delegation-decision-coordinator.js";
import { ExecutionDelegationDecisionCoordinator } from "./execution-delegation-decision-coordinator.js";
import type { ExecutionDelegationSyncOptions } from "./execution-delegation-sync-coordinator.js";
import { ExecutionDelegationSyncCoordinator } from "./execution-delegation-sync-coordinator.js";

type Options = {
  entries: ExecutionDelegationSyncOptions["entries"] & ExecutionDelegationDecisionCoordinatorOptions["entries"];
  authority: ExecutionDelegationSyncOptions["authority"] & ExecutionDelegationDecisionCoordinatorOptions["authority"];
  approvals: ExecutionDelegationDecisionCoordinatorOptions["approvals"];
  remote: ExecutionDelegationSyncOptions["remote"] & ExecutionDelegationDecisionCoordinatorOptions["remote"];
  requestConvergence(entryId: string): void;
  diagnostic(domain: "grant" | "decision", entryId: string, error: unknown): void;
};

/** Owns delegation grant and decision reconciliation as one daemon lifecycle domain. */
export class ExecutionDelegationCoordinator {
  private readonly grants: ExecutionDelegationSyncCoordinator;
  private readonly decisions: ExecutionDelegationDecisionCoordinator;

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
      requestConvergence: (entryId) => options.requestConvergence(entryId),
      diagnostic: (entryId, error) => options.diagnostic("grant", entryId, error),
    });
  }

  request(entryId: string): void {
    void this.grants.request(entryId).catch((error) => this.options.diagnostic("grant", entryId, error));
    this.requestDecisions(entryId);
  }

  requestRoom(roomId: string): void {
    void this.grants.requestRoom(roomId).catch((error) => this.options.diagnostic("grant", roomId, error));
  }

  requestDecisions(entryId: string): void {
    void this.decisions.request(entryId).catch((error) => this.options.diagnostic("decision", entryId, error));
  }

  async fenceAndDrain(): Promise<void> {
    await Promise.all([this.grants.fenceAndDrain(), this.decisions.fenceAndDrain()]);
  }
}
