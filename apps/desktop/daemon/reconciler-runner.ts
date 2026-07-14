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

  async reconcile(input: ReconcilerExecutionInput, watchdogThresholdMs: number): Promise<{ decision: ReconcilerDecision; disposition: "executed" | "held" }> {
    const capabilities = await this.port.capabilities(input.workAttemptId);
    const decision = decideReconciliation({ ...input, capabilities }, watchdogThresholdMs);
    if (decision.action === "poke") {
      if (!input.handle) return { decision: { ...decision, action: "wait", reason: "poke requires a live provider handle" }, disposition: "held" };
      await this.port.poke(input.handle, "You have addressed room messages waiting.");
    }
    if (decision.action === "restart_fresh") await this.port.spawn(input.spawn);
    if (decision.action === "restart_with_resume") {
      if (!input.resumeFrom) return { decision: { ...decision, action: "hold_coordination", condition: "coordination_blocked", reason: "resume requires a durable provider continuation" }, disposition: "held" };
      await this.port.resume(input.resumeFrom, input.spawn);
    }
    if (decision.action === "stop") {
      if (!input.handle) return { decision: { ...decision, action: "wait", reason: "stop requires a live provider handle" }, disposition: "held" };
      await this.port.stop(input.handle);
    }
    return { decision, disposition: decision.action === "wait" || decision.action === "hold_coordination" || decision.action === "quarantine" ? "held" : "executed" };
  }
}
