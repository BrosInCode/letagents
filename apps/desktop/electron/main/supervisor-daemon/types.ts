import type { ChildProcess } from "node:child_process";
import type {
  DaemonActivityEvent,
  DaemonManifestEntryView,
  DaemonResponse,
} from "#daemon-contract/index.js";
import type { loadHostApprovalSigner } from "../host-approval-auth.js";

// Wire shapes derive directly from the shared RPC contract (#daemon-contract/index.js).
export type WireResponse = DaemonResponse;
export type WireEntry = DaemonManifestEntryView;
export type WireActivityEvent = DaemonActivityEvent;

export type DaemonProcessState = "live" | "zombie";
export type DaemonProcessIdentity = {
  pid: number;
  kernelStartTime: string;
  command: string;
  state: DaemonProcessState;
  expectedScriptPath: string;
};

export type DaemonIdentityInspection = Omit<DaemonProcessIdentity, "expectedScriptPath">;
export type RetiredDaemonObservation =
  | { kind: "same"; identity: DaemonProcessIdentity }
  | { kind: "absent" }
  | { kind: "zombie" }
  | { kind: "unverifiable" }
  | { kind: "changed"; reason: string };

export type DaemonHandoffDiagnostic = {
  event: "supervisor_daemon_handoff";
  outcome: string;
  pid: number;
  implementationVersion: string;
  authorityReleased: boolean;
  detail: string;
};

export interface SupervisorDaemonLifecycleOptions {
  loadApprovalSigner?: typeof loadHostApprovalSigner;
  /** The daemon state directory (default: the user's LetAgents state root). */
  stateDir?: string;
  /** Tests only: connect here instead of the state directory's endpoint. */
  socketPath?: string;
  /** Tests only, with `socketPath`: the proof file for a Windows pipe at that path. Elsewhere it is unused. */
  peerProofPath?: string | null;
  daemonScriptPath?: string;
  daemonWorkingDirectory?: string;
  lifecycleLogPath?: string;
  spawnDaemon?: (scriptPath: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  /** @deprecated Prefer signalDaemon so tests can distinguish TERM from KILL. */
  terminateDaemon?: (pid: number) => void;
  signalDaemon?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  inspectDaemonProcess?: (pid: number) => DaemonIdentityInspection | null | undefined;
  reportHandoffDiagnostic?: (diagnostic: DaemonHandoffDiagnostic) => void;
  handoffTimeoutMs?: number;
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
  processPollIntervalMs?: number;
  startTimeoutMs?: number;
  statePreparationWaitMs?: number;
  requestTimeoutMs?: number;
  turnControlRequestTimeoutMs?: number;
  now?: () => Date;
  /**
   * How long a verified-ready status answers `ensureRunning` without a new
   * negotiation. Default 2000 ms. Zero turns the cache off.
   */
  readyStatusTtlMs?: number;
}

/**
 * What the state watch learns from one answer: the whole state, or the state
 * since the sequence it holds (the entries whose view changed, the ids of
 * entries that are gone, and the order of every entry now).
 */
export type DesktopSupervisorStateChanges = {
  complete: false;
  daemonGeneration: number;
  sequence: number;
  changedEntries: import("../../ipc-types.js").DesktopSupervisorManifestEntry[];
  removedEntryIds: string[];
  entryOrder: string[];
};
export type DesktopSupervisorStateWatchResult =
  | ({ complete: true } & import("../../ipc-types.js").DesktopSupervisorStateSnapshot)
  | DesktopSupervisorStateChanges;
