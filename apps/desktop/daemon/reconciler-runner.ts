import type { ProviderActionHandle, ProviderActionPort, ProviderActionRef, ProviderActionSpawn } from "./provider-action-port.js";
import { decideReconciliation, type ReconcilerDecision, type ReconcilerSnapshot } from "./reconciler-policy.js";

export type ReconcilerExecutionInput = Omit<ReconcilerSnapshot, "capabilities"> & {
  actionId?: string;
  workAttemptId: string;
  spawn: ProviderActionSpawn;
  handle: ProviderActionHandle | null;
  resumeFrom: ProviderActionRef | null;
};

export type ReconcilerExecutionHooks = { beforeAction?: (action: "poke" | "restart_fresh" | "restart_with_resume" | "stop") => Promise<void> };

/** Executes only actions explicitly selected by the fenced policy. */
export class ProviderReconciler {
  constructor(private readonly port: ProviderActionPort) {}

  async reconcile(input: ReconcilerExecutionInput, watchdogThresholdMs: number, hooks: ReconcilerExecutionHooks = {}): Promise<{ decision: ReconcilerDecision; disposition: "executed" | "held" | "failed" }> {
    const owned = input.spawn.workAttemptId === input.workAttemptId
      && (!input.handle || input.handle.workAttemptId === input.workAttemptId)
      && (!input.resumeFrom || input.resumeFrom.workAttemptId === input.workAttemptId);
    if (!owned) return { decision: { action: "hold_coordination", observedState: "recovering", condition: "coordination_blocked", reason: "provider action ownership does not match work attempt" }, disposition: "held" };
    let capabilities;
    try {
      capabilities = await this.port.capabilities(input.workAttemptId);
    } catch (error) {
      return { decision: { action: "wait", observedState: "failed", condition: "none", reason: `provider capabilities failed: ${error instanceof Error ? error.message : "unknown error"}` }, disposition: "failed" };
    }
    // P1.5 does not yet expose a daemon-verifiable receipt to this process.
    // Until it does, active-lease restart is hard-off; stop remains permitted.
    const decision = decideReconciliation({ ...input, capabilities, fencedRebindProven: input.activeLease ? false : input.fencedRebindProven }, watchdogThresholdMs);
    try {
      if (decision.action === "poke") {
        if (!input.handle) return { decision: { ...decision, action: "wait", reason: "poke requires a live provider handle" }, disposition: "held" };
        await hooks.beforeAction?.("poke");
        await this.port.poke(input.handle, "You have addressed room messages waiting.", { actionId: input.actionId });
      }
      if (decision.action === "restart_fresh") {
        await hooks.beforeAction?.("restart_fresh");
        await this.port.spawn({ ...input.spawn, actionId: input.actionId });
      }
      if (decision.action === "restart_with_resume") {
        if (!input.resumeFrom) return { decision: { ...decision, action: "hold_coordination", condition: "coordination_blocked", reason: "resume requires a durable provider continuation" }, disposition: "held" };
        await hooks.beforeAction?.("restart_with_resume");
        await this.port.resume(input.resumeFrom, { ...input.spawn, actionId: input.actionId });
      }
      if (decision.action === "stop") {
        if (!input.handle) return { decision: { ...decision, action: "wait", reason: "stop requires a live provider handle" }, disposition: "held" };
        await hooks.beforeAction?.("stop");
        await this.port.stop(input.handle, { actionId: input.actionId });
      }
    } catch (error) {
      return { decision: { action: "wait", observedState: "failed", condition: "none", reason: `provider ${decision.action} failed: ${error instanceof Error ? error.message : "unknown error"}` }, disposition: "failed" };
    }
    return { decision, disposition: decision.action === "wait" || decision.action === "hold_coordination" || decision.action === "quarantine" ? "held" : "executed" };
  }
}
