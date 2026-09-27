import type { DaemonMaintenanceHold } from "../../../../shared/daemon-maintenance.mjs";
import type { DaemonProcessIdentity } from "./supervisor-daemon.js";

type Observation = { kind: "same" | "absent" | "zombie" | "unverifiable" | "changed" };
export interface ForceDaemonRestartPort {
  identify(): Promise<DaemonProcessIdentity>;
  persistHold(): Promise<DaemonMaintenanceHold>;
  observe(identity: DaemonProcessIdentity): Observation;
  signal(identity: DaemonProcessIdentity, signal: "SIGTERM" | "SIGKILL"): Observation;
  wait(identity: DaemonProcessIdentity, timeoutMs: number): Promise<Observation>;
  socketReleased(): Promise<boolean>;
  terminateTimeoutMs: number;
  killTimeoutMs: number;
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
    if (observation.kind !== "same") break;
    observation = port.signal(identity, signal);
    if (observation.kind === "same") {
      observation = await port.wait(identity, signal === "SIGTERM" ? port.terminateTimeoutMs : port.killTimeoutMs);
    }
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
