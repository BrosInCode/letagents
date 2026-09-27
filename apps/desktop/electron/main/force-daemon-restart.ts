import type { DaemonMaintenanceHold } from "../../../../shared/daemon-maintenance.mjs";
import type { DaemonProcessIdentity } from "./supervisor-daemon.js";

type Observation = { kind: "same" | "absent" | "zombie" | "unverifiable" | "changed" };
export interface ForceDaemonRestartPort {
  identify(): Promise<DaemonProcessIdentity>;
  persistHold(): Promise<DaemonMaintenanceHold>;
  observe(identity: DaemonProcessIdentity): Observation;
  signal(identity: DaemonProcessIdentity, signal: "SIGTERM" | "SIGKILL"): Observation;
  delay(timeoutMs: number): Promise<void>;
  now(): number;
  pollIntervalMs: number;
  socketReleased(): Promise<boolean>;
  terminateTimeoutMs: number;
  killTimeoutMs: number;
}

async function waitForForcedExit(port: ForceDaemonRestartPort, identity: DaemonProcessIdentity,
  observation: Observation, timeoutMs: number): Promise<Observation> {
  const deadline = port.now() + timeoutMs;
  let identityLoss: Observation | undefined;
  while (true) {
    if (observation.kind === "changed" || observation.kind === "unverifiable") identityLoss ??= observation;
    // Once identity is lost, neither a later match nor a zombie permits another
    // signal or proves this process stopped. Positive PID absence still can.
    if (observation.kind === "absent" || (observation.kind === "zombie" && !identityLoss)) return observation;
    const remaining = deadline - port.now();
    if (remaining <= 0) return identityLoss ?? observation;
    await port.delay(Math.min(port.pollIntervalMs, remaining));
    observation = port.observe(identity);
  }
}

/** An explicit interruption, never a provider handoff or a native death receipt. */
export async function forceStopDaemon(port: ForceDaemonRestartPort): Promise<void> {
  const identity = await port.identify();
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || identity.pid === process.pid
    || !(identity.command === identity.expectedScriptPath || identity.command.endsWith(` ${identity.expectedScriptPath}`))) {
    throw new Error("Cannot safely identify this installation's background service. No process was stopped.");
  }
  const hold = await port.persistHold();
  if (!hold || hold.version !== 1 || !hold.id) throw new Error("Service maintenance was not saved. No process was stopped.");
  let observation = port.observe(identity);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (observation.kind === "same") observation = port.signal(identity, signal);
    observation = await waitForForcedExit(port, identity, observation,
      signal === "SIGTERM" ? port.terminateTimeoutMs : port.killTimeoutMs);
    if (observation.kind !== "same") break;
  }
  // Socket loss alone never permits a second owner; neither do an ambiguous
  // identity change or a signal's successful return value.
  if (observation.kind !== "absent" && observation.kind !== "zombie") {
    throw new Error(`Could not confirm the background service stopped (${observation.kind}). Maintenance remains active; no replacement was started.`);
  }
  if (!await port.socketReleased()) throw new Error("Another service still answers on the control socket. No replacement was started.");
}


/** Native confirmation must remain tied to the trusted window through its await. */
export async function performConfirmedMaintenance(port: {
  assertTrusted(): void;
  confirm(resume: boolean): Promise<boolean>;
  stop(resume: boolean): Promise<void>;
  relaunch(): void;
}, resume: boolean): Promise<void> {
  port.assertTrusted();
  if (!await port.confirm(resume)) return;
  port.assertTrusted();
  await port.stop(resume);
  port.relaunch();
}
