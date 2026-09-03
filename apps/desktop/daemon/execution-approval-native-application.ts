import type { HostApprovalPresentation, HostApprovalStatus } from "../shared/host-approvals.js";
import type { CodexPermissionFileChange, ProviderPermissionRequest } from "../shared/provider-permissions.js";
import type {
  ApprovalAuthority,
  ApprovalReference,
  ExecutionApprovalRecord,
} from "./execution-approval-journal.js";
import type { ExecutionApprovalNativeDispatcher } from "./execution-approval-native-dispatch.js";
import type { ProviderActionHandle } from "./provider-action-port.js";

export type RecordedApprovalDecision = {
  agentId: string;
  requestId: string;
  requestVersion: number;
  requestSha256: string;
  decisionId: string;
  actorId: string;
  decision: "allow_once" | "deny";
  projectionSha256: string;
};

export type RecordedApprovalSelection = {
  expected: ApprovalReference;
  presentation: HostApprovalPresentation;
  approvalAuthority: ApprovalAuthority;
  approval: ExecutionApprovalRecord;
  assertCurrent(): void;
};

export type NativeApprovalApplication = RecordedApprovalSelection & {
  handle: ProviderActionHandle;
  native: ProviderPermissionRequest;
  executionGenerationId: string;
  expectedFileChanges?: readonly CodexPermissionFileChange[];
  markNativeDispatch?(): void;
};

export class NativeApprovalUnavailableError extends Error {
  constructor() {
    super("The native approval request is unavailable.");
    this.name = "NativeApprovalUnavailableError";
  }
}

type Options = {
  readLatest(requestId: string): Promise<ExecutionApprovalRecord | null>;
  dispatcher: ExecutionApprovalNativeDispatcher;
};

function status(record: ExecutionApprovalRecord): HostApprovalStatus {
  if (record.request.state === "resolved") return "resolved";
  if (record.request.state === "requested") return "pending";
  if (record.request.state === "decision_recorded") return "decision_recorded";
  if (record.request.state === "dispatching") return "uncertain";
  return "unavailable";
}

/** Serializes host/delegate races and applies one already-recorded choice. */
export class ExecutionApprovalNativeApplicationCoordinator {
  private readonly decisions = new Map<string, Promise<HostApprovalStatus>>();

  constructor(private readonly options: Options) {}

  apply(
    input: RecordedApprovalDecision,
    resolve: () => Promise<NativeApprovalApplication>,
    select: (prepared: RecordedApprovalSelection) => Promise<ExecutionApprovalRecord>,
  ): Promise<HostApprovalStatus> {
    const previous = this.decisions.get(input.requestId);
    const operation = (previous?.catch(() => undefined) ?? Promise.resolve())
      .then(() => this.applyOnce(input, resolve, select));
    this.decisions.set(input.requestId, operation);
    return operation.finally(() => {
      if (this.decisions.get(input.requestId) === operation) this.decisions.delete(input.requestId);
    });
  }

  private async applyOnce(
    input: RecordedApprovalDecision,
    resolve: () => Promise<NativeApprovalApplication>,
    select: (prepared: RecordedApprovalSelection) => Promise<ExecutionApprovalRecord>,
  ): Promise<HostApprovalStatus> {
    const prior = await this.options.readLatest(input.requestId);
    if (prior?.decision) {
      const decision = prior.decision;
      if (decision.decisionId !== input.decisionId || decision.actorId !== input.actorId
        || decision.decision !== input.decision || decision.projectionSha256 !== input.projectionSha256) {
        throw new Error("An approval decision is already recorded.");
      }
      if (decision.dispatchId) return status(prior);
    }
    const prepared = await resolve();
    if (prepared.expected.requestId !== input.requestId
      || prepared.expected.requestVersion !== input.requestVersion
      || prepared.expected.requestSha256 !== input.requestSha256
      || prepared.expected.agentId !== input.agentId) {
      throw new Error("The displayed approval request has changed.");
    }
    const selected = await select(prepared);
    const decision = selected.decision;
    if (!decision || decision.decisionId !== input.decisionId || decision.actorId !== input.actorId
      || decision.decision !== input.decision || decision.projectionSha256 !== input.projectionSha256) {
      throw new Error("The recorded approval decision changed.");
    }
    if (decision.dispatchId) return status(selected);
    return this.options.dispatcher.dispatch({
      expected: prepared.expected,
      authority: prepared.approvalAuthority,
      approval: prepared.approval,
      decisionId: input.decisionId,
      decision: input.decision,
      projectionSha256: input.projectionSha256,
      handle: prepared.handle,
      native: prepared.native,
      executionGenerationId: prepared.executionGenerationId,
      expectedFileChanges: prepared.expectedFileChanges,
      assertCurrent: prepared.assertCurrent,
      markNativeDispatch: prepared.markNativeDispatch,
    });
  }
}
