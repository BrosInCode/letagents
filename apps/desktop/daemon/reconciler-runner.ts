import type { ProviderActionHandle, ProviderActionPort, ProviderActionRef, ProviderActionSpawn } from "./provider-action-port.js";
import { decideReconciliation, type ReconcilerDecision, type ReconcilerSnapshot } from "./reconciler-policy.js";

export type ReconcilerExecutionInput = Omit<ReconcilerSnapshot, "capabilities"> & {
  workAttemptId: string;
  spawn: ProviderActionSpawn;
  handle: ProviderActionHandle | null;
  resumeFrom: ProviderActionRef | null;
};

/** Executes only actions explicitly selected by the fenced policy. */
export class ProviderReconciler {
  constructor(private readonly port: ProviderActionPort) {}

  async reconcile(input: ReconcilerExecutionInput, watchdogThresholdMs: number): Promise<ReconcilerDecision> {
    const capabilities = await this.port.capabilities(input.workAttemptId);
    const decision = decideReconciliation({ ...input, capabilities }, watchdogThresholdMs);
    if (decision.action === "poke" && input.handle) await this.port.poke(input.handle, "You have addressed room messages waiting.");
    if (decision.action === "restart_fresh") await this.port.spawn(input.spawn);
    if (decision.action === "restart_with_resume" && input.resumeFrom) await this.port.resume(input.resumeFrom, input.spawn);
    if (decision.action === "stop" && input.handle) await this.port.stop(input.handle);
    return decision;
  }
}
