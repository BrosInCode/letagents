import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { daemonMaintenancePath, DAEMON_MAINTENANCE_MESSAGE } from "../../../../../shared/daemon-maintenance.mjs";
import { connectDaemon, daemonEndpoint, defaultDaemonStateDir } from "../../../../../shared/daemon-endpoint.mjs";
import type { DesktopSupervisorDaemonStatus } from "../../ipc-types.js";
import { desktopRoot } from "../paths.js";
import { loadHostApprovalSigner, type HostApprovalSigner } from "../host-approval-auth.js";
import type { HostApprovalChallenge } from "../../../shared/host-approval-auth.js";
import type { DesktopHostApproval, HostApprovalCandidate, HostApprovalSelection } from "../../../shared/host-approvals.js";
import {
  KILL_EXIT_TIMEOUT_MS,
  NATURAL_EXIT_TIMEOUT_MS,
  PROCESS_POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  START_TIMEOUT_MS,
  SUPERVISOR_DAEMON_PROTOCOL_VERSION,
  TERMINATE_EXIT_TIMEOUT_MS,
  TURN_CONTROL_REQUEST_TIMEOUT_MS,
} from "./constants.js";
import { isConnectionUnavailable, SupervisorDaemonProtocolMismatchError, SupervisorDaemonRequestTimeoutError } from "./errors.js";
import { defaultInspectDaemonProcess } from "./process-identity.js";
import type {
  DaemonHandoffDiagnostic,
  DaemonIdentityInspection,
  DaemonProcessIdentity,
  SupervisorDaemonLifecycleOptions,
  WireResponse,
} from "./types.js";

export abstract class SupervisorDaemonClientBase {
  /** The daemon's state directory; every local path below derives from it, never from the socket. */
  readonly stateDir: string;
  /** Where the daemon is reached: a socket file on POSIX, a named pipe on Windows. */
  readonly socketPath: string;
  protected readonly peerProofPath: string | null;
  readonly daemonScriptPath: string;
  protected ensureOperation: Promise<DesktopSupervisorDaemonStatus> | null = null;
  /**
   * Short-lived answer for `ensureRunning`.
   *
   * Problem: every supervisor IPC (list-agents, state push, inspector poll every
   * 5 s, approvals) ran a full negotiation: a maintenance-file read, an
   * environment copy with two SHA-256 fingerprints, and a `daemon.negotiate`
   * request on a new socket.
   * Rule: after a negotiation that proved the daemon ready and current, reuse
   * that status for `readyStatusTtlMs`.
   * Invalidation: any lost connection, timeout or disconnect, daemon exit, a
   * disconnect seen by the observer, a handoff, a maintenance request, an
   * application-update step, or an environment refresh clears it at once.
   * A held maintenance status is never cached.
   */
  protected readyStatus: { status: DesktopSupervisorDaemonStatus; expiresAt: number } | null = null;
  private readonly readyStatusTtlMs: number;
  protected applicationUpdateHandoff: Promise<void> | null = null;
  protected environmentRefreshHandoff: Promise<DesktopSupervisorDaemonStatus> | null = null;
  protected applicationUpdatePrepared = false;
  protected maintenanceRequested = false;
  protected readonly maintenanceRequests = new Set<() => void>();
  protected maintenanceTarget: DaemonProcessIdentity | null = null;
  protected maintenanceOperation: Promise<void> | null = null;
  protected get maintenancePath(): string { return daemonMaintenancePath(this.stateDir); }

  protected assertNotRestarting(): void {
    if (this.maintenanceRequested) throw new Error(DAEMON_MAINTENANCE_MESSAGE);
  }

  protected drainingCurrentDaemon = false;
  protected readonly startupApprovalWaiters = new Set<() => void>();
  private lastReadyGeneration: number | null = null;
  private readonly generationListeners = new Set<(status: DesktopSupervisorDaemonStatus) => void>();
  protected readonly spawnDaemon: (scriptPath: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  protected readonly daemonWorkingDirectory: string;
  protected readonly lifecycleLogPath: string;
  protected readonly signalDaemon: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  protected readonly inspectDaemonProcess: (pid: number) => DaemonIdentityInspection | null | undefined;
  protected readonly reportHandoffDiagnostic: (diagnostic: DaemonHandoffDiagnostic) => void;
  protected readonly naturalExitTimeoutMs: number;
  protected readonly terminateTimeoutMs: number;
  protected readonly killTimeoutMs: number;
  protected readonly processPollIntervalMs: number;
  protected readonly startTimeoutMs: number;
  protected readonly statePreparationWaitMs: number;
  protected readonly requestTimeoutMs: number;
  protected readonly turnControlRequestTimeoutMs: number;
  protected readonly now: () => Date;
  protected attachedDaemonObservation: {
    identity: DaemonProcessIdentity;
    generation: number;
  } | null = null;
  // Caller deadlines do not end child custody. Retain the launch and its
  // readiness fences until process exit or a completed negotiated handoff.
  protected ownedDaemon: {
    pid: number | null;
    ready: boolean;
    retiredGeneration: number | undefined;
    runtimeEnvironmentFingerprint: string;
    compatibilityFingerprint: string;
  } | null = null;
  protected readonly loadApprovalSigner: typeof loadHostApprovalSigner;
  protected approvalSigner: { fingerprint: string; promise: Promise<HostApprovalSigner> } | null = null;
  protected readonly approvalPresentations = new Map<string, {
    roomId: string; view: DesktopHostApproval; candidate: HostApprovalCandidate; challenge: HostApprovalChallenge;
    presentationSha256: string; touchedAt: number;
    /** A recorded choice carries the digest it was made on; a choice minted here is signed against the card. */
    decision: { id: string; choice: HostApprovalSelection; projectionSha256: string | null } | null;
  }>();

  constructor(options: SupervisorDaemonLifecycleOptions = {}) {
    this.loadApprovalSigner = options.loadApprovalSigner ?? loadHostApprovalSigner;
    this.stateDir = options.stateDir ?? defaultDaemonStateDir();
    const endpoint = daemonEndpoint(this.stateDir);
    this.socketPath = options.socketPath ?? endpoint.connectPath;
    this.peerProofPath = options.socketPath === undefined ? endpoint.proofPath : null;
    this.daemonScriptPath = options.daemonScriptPath ?? join(desktopRoot, "dist-daemon", "main.js");
    this.daemonWorkingDirectory = options.daemonWorkingDirectory ?? this.stateDir;
    this.lifecycleLogPath = options.lifecycleLogPath ?? join(this.stateDir, "daemon-lifecycle.jsonl");
    this.signalDaemon = options.signalDaemon ?? ((pid, signal) => {
      if (signal === "SIGTERM" && options.terminateDaemon) {
        options.terminateDaemon(pid);
        return;
      }
      process.kill(pid, signal);
    });
    this.inspectDaemonProcess = options.inspectDaemonProcess ?? defaultInspectDaemonProcess;
    this.reportHandoffDiagnostic = options.reportHandoffDiagnostic ?? ((diagnostic) => {
      console.error(JSON.stringify(diagnostic));
    });
    this.naturalExitTimeoutMs = options.handoffTimeoutMs ?? NATURAL_EXIT_TIMEOUT_MS;
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? TERMINATE_EXIT_TIMEOUT_MS;
    this.killTimeoutMs = options.killTimeoutMs ?? KILL_EXIT_TIMEOUT_MS;
    this.processPollIntervalMs = options.processPollIntervalMs ?? PROCESS_POLL_INTERVAL_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.statePreparationWaitMs = options.statePreparationWaitMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.turnControlRequestTimeoutMs = options.turnControlRequestTimeoutMs ?? TURN_CONTROL_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.readyStatusTtlMs = options.readyStatusTtlMs ?? 2000;
    this.spawnDaemon = options.spawnDaemon ?? ((scriptPath, cwd, env) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd,
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env,
      });
      child.unref();
      return child;
    });
  }

  protected cacheReadyStatus(status: DesktopSupervisorDaemonStatus): DesktopSupervisorDaemonStatus {
    if (this.readyStatusTtlMs > 0 && !this.maintenanceRequested && !status.maintenanceHoldId
      && !this.applicationUpdateHandoff && !this.applicationUpdatePrepared) {
      this.readyStatus = { status, expiresAt: Date.now() + this.readyStatusTtlMs };
    }
    return status;
  }

  protected invalidateReadyStatus(): void {
    this.readyStatus = null;
  }

  onGeneration(listener: (status: DesktopSupervisorDaemonStatus) => void): () => void {
    this.generationListeners.add(listener);
    return () => this.generationListeners.delete(listener);
  }

  protected rememberReadyStatus(status: DesktopSupervisorDaemonStatus): DesktopSupervisorDaemonStatus {
    if (this.maintenanceRequested || status.maintenanceHoldId) return status;
    if (this.lastReadyGeneration !== status.generation) {
      this.lastReadyGeneration = status.generation;
      queueMicrotask(() => {
        for (const listener of this.generationListeners) listener(status);
      });
    }
    return status;
  }

  protected request<T = unknown>(
    method: string,
    params?: unknown,
    version = SUPERVISOR_DAEMON_PROTOCOL_VERSION,
    timeoutMs = this.requestTimeoutMs,
    unrefSocket = false,
    signal?: AbortSignal,
    assertDispatch?: () => void,
    maintenance = false,
  ): Promise<T> {
    if (!maintenance && this.maintenanceRequested) return Promise.reject(new Error(DAEMON_MAINTENANCE_MESSAGE));
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID();
      const socket = connectDaemon(this.socketPath, { proofPath: this.peerProofPath });
      if (unrefSocket) socket.unref();
      const chunks: string[] = [];
      let settled = false;
      let onAbort: (() => void) | null = null;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        this.maintenanceRequests.delete(cancelForMaintenance);
        socket.destroy();
        if (error && (isConnectionUnavailable(error) || error instanceof SupervisorDaemonRequestTimeoutError
          || /disconnected before replying/.test(error.message))) this.invalidateReadyStatus();
        if (error) reject(error); else resolve(value as T);
      };
      const cancelForMaintenance = () => finish(new Error(DAEMON_MAINTENANCE_MESSAGE));
      if (!maintenance) this.maintenanceRequests.add(cancelForMaintenance);
      onAbort = () => finish(new Error(`Supervisor daemon request aborted: ${method}`));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.setTimeout(timeoutMs, () => finish(new SupervisorDaemonRequestTimeoutError(method)));
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error(`Supervisor daemon disconnected before replying: ${method}`)));
      socket.on("data", (chunk: string) => {
        if (settled) return;
        // Each earlier chunk is already known to contain no newline. Scanning
        // the growing response again makes large state snapshots quadratic.
        const newline = chunk.indexOf("\n");
        chunks.push(newline < 0 ? chunk : chunk.slice(0, newline));
        if (newline < 0) return;
        try {
          const response = JSON.parse(chunks.join("")) as WireResponse;
          if (response.id !== id) throw new Error("Supervisor daemon response id mismatch.");
          if (!response.ok) {
            // The daemon refused. Generation and capability fences answer this way, and the cached
            // status the request was built from may be what is stale, so the next call negotiates again.
            this.invalidateReadyStatus();
            if (/Protocol version mismatch/i.test(response.error ?? "")) {
              throw new SupervisorDaemonProtocolMismatchError(version, response.version, response.error ?? "Protocol version mismatch.");
            }
            throw new Error(response.error || `Supervisor daemon request failed: ${method}`);
          }
          finish(undefined, response.result as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Invalid supervisor daemon response."));
        }
      });
      socket.once("connect", () => {
        if (settled) return;
        try { if (!maintenance) this.assertNotRestarting(); assertDispatch?.(); socket.write(`${JSON.stringify({ version, id, method, params })}\n`); }
        catch (error) { finish(error instanceof Error ? error : new Error("Supervisor request was not dispatched.")); }
      });
    });
  }
}
