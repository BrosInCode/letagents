import { randomUUID } from "node:crypto";

import type { CodexPermissionFileChange, ProviderPermissionRequest } from "../shared/provider-permissions.js";
import type {
  ApprovalAuthority,
  ApprovalReference,
  ExecutionApprovalRecord,
} from "./execution-approval-journal.js";
import type { ProviderActionHandle, ProviderActionPort } from "./provider-action-port.js";
import type { DaemonManifestEntry } from "./types.js";

export type NativeApprovalDispatchStatus = "resolved" | "decision_sent" | "uncertain";

export type NativeApprovalDispatchInput = {
  expected: ApprovalReference;
  authority: ApprovalAuthority;
  approval: ExecutionApprovalRecord;
  decisionId: string;
  decision: "allow_once" | "deny";
  projectionSha256: string;
  handle: ProviderActionHandle;
  native: ProviderPermissionRequest;
  executionGenerationId: string;
  expectedFileChanges?: readonly CodexPermissionFileChange[];
  assertCurrent(): void;
  markNativeDispatch?(): void;
};

type Options = {
  store: {
    getEntry(entryId: string): Promise<DaemonManifestEntry | undefined>;
    beginExecutionApprovalDispatch(input: {
      expected: ApprovalReference;
      authority: ApprovalAuthority;
      decisionId: string;
      dispatchId: string;
      projectionSha256: string;
      atMs: number;
    }, fence: (commit: () => Promise<void>) => Promise<void>): Promise<{ dispatch: boolean }>;
    recordExecutionApprovalOutcome(input: {
      expected: ApprovalReference;
      decisionId: string;
      dispatchId: string;
      evidence: "sent_unacknowledged" | "dispatch_uncertain" | "native_processed" | "exact_native_execution";
      atMs: number;
    }, fence: (commit: () => Promise<void>) => Promise<void>): Promise<ExecutionApprovalRecord>;
    validateExecutionApprovalAuthority(expected: ApprovalReference, authority: ApprovalAuthority): Promise<() => void>;
  };
  provider: ProviderActionPort | undefined;
  exactAuthority(entry: DaemonManifestEntry, handle: ProviderActionHandle, generation: string): Promise<boolean>;
  fenceCommit(commit: () => Promise<void>): Promise<void>;
  nowMs(): number;
};

/** Owns the single native-write edge shared by host and delegated selections. */
export class ExecutionApprovalNativeDispatcher {
  constructor(private readonly options: Options) {}

  async dispatch(input: NativeApprovalDispatchInput): Promise<NativeApprovalDispatchStatus> {
    const provider = this.options.provider;
    if (!provider?.replyPermission) throw new Error("The native approval provider is unavailable.");
    const fence = (commit: () => Promise<void>) => this.options.fenceCommit(async () => {
      input.assertCurrent();
      await commit();
    });
    const dispatchId = randomUUID();
    let dispatchStarted = false;
    let assertOperationalAuthority: (() => void) | null = null;
    try {
      const result = await provider.replyPermission(
        input.handle,
        input.native,
        input.decision === "allow_once" ? "once" : "reject",
        {
          expectedFileChanges: input.expectedFileChanges,
          beforeNativeDispatch: async () => {
            input.assertCurrent();
            const entry = await this.options.store.getEntry(input.expected.agentId);
            if (!entry || !await this.options.exactAuthority(entry, input.handle, input.executionGenerationId)) {
              throw new Error("Approval authority changed.");
            }
            const permit = await this.options.store.beginExecutionApprovalDispatch({
              expected: input.expected,
              authority: input.authority,
              decisionId: input.decisionId,
              dispatchId,
              projectionSha256: input.projectionSha256,
              atMs: this.options.nowMs(),
            }, fence);
            if (!permit.dispatch) throw new Error("This approval dispatch was already recorded.");
            dispatchStarted = true;
            assertOperationalAuthority = await this.options.store.validateExecutionApprovalAuthority(
              input.expected,
              input.authority,
            );
            input.assertCurrent();
          },
          assertNativeDispatch: () => {
            input.assertCurrent();
            if (!assertOperationalAuthority || this.options.nowMs() >= input.approval.request.expiresAtMs) {
              throw new Error("Approval authority is unavailable.");
            }
            assertOperationalAuthority();
            input.markNativeDispatch?.();
          },
        },
      );
      await this.options.store.recordExecutionApprovalOutcome({
        expected: input.expected,
        decisionId: input.decisionId,
        dispatchId,
        evidence: result.outcome,
        atMs: this.options.nowMs(),
      }, this.options.fenceCommit);
      return result.outcome === "native_processed" ? "resolved" : "decision_sent";
    } catch {
      if (dispatchStarted) {
        await this.options.store.recordExecutionApprovalOutcome({
          expected: input.expected,
          decisionId: input.decisionId,
          dispatchId,
          evidence: "dispatch_uncertain",
          atMs: this.options.nowMs(),
        }, this.options.fenceCommit).catch(() => undefined);
        return "uncertain";
      }
      throw new Error("The decision was recorded but could not be sent. Refresh the request before trying again.");
    }
  }
}
