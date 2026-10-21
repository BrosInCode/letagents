import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { withDaemonMaintenanceOperation, readDaemonMaintenance, DAEMON_MAINTENANCE_MESSAGE } from "../../../../../shared/daemon-maintenance.mjs";
import { forceStopDaemon, waitForConfirmedDaemonExit } from "../force-daemon-restart.js";
import type { DesktopSupervisorDaemonStatus } from "../../ipc-types.js";
import { desktopShellEnvironmentReady } from "../desktop-shell-environment.js";
import { prepareSupervisorState } from "../supervisor-state-recovery.js";
import {
  HANDOFF_DRAIN_REQUEST_TIMEOUT_MS,
  MANIFEST_LIST_REQUEST_TIMEOUT_MS,
  SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION,
  SUPERVISOR_DAEMON_PROTOCOL_VERSION,
} from "./constants.js";
import { isConnectionUnavailable, SupervisorDaemonProtocolMismatchError, SupervisorDaemonRequestTimeoutError } from "./errors.js";
import { appendDaemonLifecycleEvent } from "./lifecycle-log.js";
import { supervisorDaemonSpawnEnvironment } from "./spawn-environment.js";
import { mapStatus } from "./status-mapping.js";
import type { DaemonIdentityInspection, DaemonProcessIdentity, RetiredDaemonObservation } from "./types.js";
import { SupervisorDaemonClientBase } from "./client-base.js";

export abstract class SupervisorDaemonLifecycleClient extends SupervisorDaemonClientBase {
  async isMaintenanceHeld(): Promise<boolean> {
    if (this.maintenanceRequested) return true;
    const hold = await readDaemonMaintenance(this.maintenancePath);
    return this.maintenanceRequested || Boolean(hold);
  }
  async getMaintenanceStatus(): Promise<{ held: boolean; ready: boolean }> {
    const hold = await readDaemonMaintenance(this.maintenancePath);
    if (!hold) return { held: false, ready: false };
    const status = await this.request<Record<string, unknown>>("daemon.negotiate", undefined,
      SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.requestTimeoutMs, false, undefined, undefined, true).catch(() => null);
    return { held: true, ready: status?.maintenance_hold_id === hold.id };
  }

  /** Native-confirmed action. The caller relaunches Electron after success. */
  stopForMaintenance(resume = false): Promise<void> {
    if (this.applicationUpdatePrepared) return Promise.reject(new Error("The application update is already being installed."));
    if (this.maintenanceOperation) return this.maintenanceOperation;
    this.maintenanceRequested = true;
    this.invalidateReadyStatus();
    for (const cancel of this.maintenanceRequests) cancel();
    const operation = withDaemonMaintenanceOperation(async owner => {
      const hold = await owner.read();
      const observed: { negotiated: Record<string, unknown> | null } = { negotiated: null };
      const identify = async () => {
        try {
          observed.negotiated = await this.request<Record<string, unknown>>("daemon.negotiate", undefined,
            SUPERVISOR_DAEMON_PROTOCOL_VERSION, this.requestTimeoutMs, false, undefined, undefined, true);
          return this.captureRetiredDaemon(observed.negotiated);
        } catch (error) {
          if (observed.negotiated || !this.maintenanceTarget) throw error;
          return this.maintenanceTarget;
        }
      };
      if (resume) {
        const target = await identify();
        if (!hold || observed.negotiated?.maintenance_hold_id !== hold.id) {
          throw new Error("Force restart the service before resuming supervision.");
        }
        await this.request("daemon.prepare_handoff", undefined, SUPERVISOR_DAEMON_PROTOCOL_VERSION,
          this.requestTimeoutMs, false, undefined, undefined, true);
        // macOS may briefly lose process identity during clean exit. Wait for
        // positive exit evidence without signalling or accepting a later match.
        const stopped = await waitForConfirmedDaemonExit({
          observe: identity => this.observeRetiredDaemon(identity), now: Date.now,
          delay, pollIntervalMs: this.processPollIntervalMs,
        }, target, this.observeRetiredDaemon(target), this.terminateTimeoutMs);
        if (!["absent", "zombie"].includes(stopped.kind) || !await this.isSocketReleased(SUPERVISOR_DAEMON_PROTOCOL_VERSION, true)) {
          throw new Error("The maintenance service has not stopped. Supervision remains paused.");
        }
        await owner.clear(hold.id);
      } else {
        await forceStopDaemon({ identify, persistHold: () => owner.create(),
          observe: target => this.observeRetiredDaemon(target), signal: (target, signal) => this.guardedSignalRetiredDaemon(target, signal),
          delay, now: Date.now, pollIntervalMs: this.processPollIntervalMs,
          socketReleased: () => this.isSocketReleased(SUPERVISOR_DAEMON_PROTOCOL_VERSION, true),
          terminateTimeoutMs: this.terminateTimeoutMs, killTimeoutMs: this.killTimeoutMs });
      }
      this.stopAttachedDaemonObservation();
      this.ownedDaemon = null;
    }, this.maintenancePath);
    this.maintenanceOperation = operation;
    void operation.finally(() => { if (this.maintenanceOperation === operation) this.maintenanceOperation = null; }).catch(() => undefined);
    return operation;
  }

  ensureRunning(startupPreparation?: Promise<void>): Promise<DesktopSupervisorDaemonStatus> {
    if (this.maintenanceRequested) return Promise.reject(new Error(DAEMON_MAINTENANCE_MESSAGE));
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return Promise.reject(new Error("Supervised agents currently require macOS."));
    }
    if (this.applicationUpdateHandoff || this.applicationUpdatePrepared) {
      return Promise.reject(new Error("Supervisor startup is paused while LetAgents installs an application update."));
    }
    if (this.environmentRefreshHandoff) return this.environmentRefreshHandoff;
    if (!this.ensureOperation) {
      const cached = this.readyStatus;
      if (cached && Date.now() < cached.expiresAt && !this.drainingCurrentDaemon
        && !this.maintenanceOperation && (!this.ownedDaemon || this.ownedDaemon.ready)) {
        return Promise.resolve(cached.status);
      }
      this.readyStatus = null;
      this.ensureOperation = Promise.resolve(startupPreparation)
        .then(() => desktopShellEnvironmentReady())
        .then(() => this.ensureRunningOnce())
        .then((status) => this.cacheReadyStatus(this.rememberReadyStatus(status)))
        .finally(() => { this.ensureOperation = null; });
    }
    return this.ensureOperation;
  }

  /** Join startup already registered by the app without starting another service. */
  async waitForStartup(): Promise<void> {
    if (!this.ensureOperation || this.drainingCurrentDaemon) return;
    let release!: () => void;
    const currentDaemonReady = new Promise<void>(resolve => { release = resolve; });
    this.startupApprovalWaiters.add(release);
    try {
      // A negotiated old daemon may need a human approval before startup can
      // replace it. Also wake reads that joined startup before negotiation.
      await Promise.race([this.ensureOperation, currentDaemonReady]);
    } finally { this.startupApprovalWaiters.delete(release); }
  }

  /**
   * Retire the serving daemon without touching provider processes. The next
   * desktop version will start its bundled daemon and recover exact provider
   * generations during normal startup reconciliation.
   */
  prepareForApplicationUpdate(): Promise<void> {
    this.invalidateReadyStatus();
    if (this.maintenanceRequested) return Promise.reject(new Error(DAEMON_MAINTENANCE_MESSAGE));
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return Promise.reject(new Error("Application update handoff currently requires macOS."));
    }
    if (this.applicationUpdatePrepared) return Promise.resolve();
    if (!this.applicationUpdateHandoff) {
      this.applicationUpdateHandoff = this.prepareForApplicationUpdateOnce()
        .then(() => {
          this.applicationUpdatePrepared = true;
        })
        .finally(() => {
          this.applicationUpdateHandoff = null;
        });
    }
    return this.applicationUpdateHandoff;
  }

  /** Restore the current app's daemon only when Squirrel failed to take over. */
  resumeAfterApplicationUpdateFailure(): Promise<DesktopSupervisorDaemonStatus> {
    this.applicationUpdatePrepared = false;
    this.invalidateReadyStatus();
    return this.ensureRunning();
  }

  /** Explicit setup action: reconcile provider environment without replacing an already current service. */
  restartForEnvironmentRefresh(): Promise<DesktopSupervisorDaemonStatus> {
    if (this.maintenanceRequested) return Promise.reject(new Error(DAEMON_MAINTENANCE_MESSAGE));
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return Promise.reject(new Error("Supervised agents currently require macOS."));
    }
    if (!this.environmentRefreshHandoff) {
      this.environmentRefreshHandoff = (async () => {
        await desktopShellEnvironmentReady();
        if (this.ensureOperation) await this.ensureOperation;
        if (this.applicationUpdateHandoff || this.applicationUpdatePrepared) {
          throw new Error("Supervisor startup is paused while LetAgents installs an application update.");
        }
        this.invalidateReadyStatus();
        this.ensureOperation = this.ensureRunningOnce(true)
          .then((status) => this.cacheReadyStatus(this.rememberReadyStatus(status)))
          .finally(() => { this.ensureOperation = null; });
        return this.ensureOperation;
      })().finally(() => {
        this.environmentRefreshHandoff = null;
      });
    }
    return this.environmentRefreshHandoff;
  }

  /** Compare only: opening setup must not retire the owner of live approval connections. */
  async isRuntimeEnvironmentCurrent(): Promise<boolean> {
    await this.waitForStartup();
    try {
      const negotiated = await this.request<Record<string, unknown>>("daemon.negotiate");
      return negotiated.runtime_environment_fingerprint ===
        supervisorDaemonSpawnEnvironment().LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT;
    } catch (error) {
      // An absent daemon will inherit this environment when explicitly started.
      if (isConnectionUnavailable(error)) return true;
      throw error;
    }
  }

  /**
   * Observe an existing daemon without becoming its lifecycle owner.
   * Subscriptions use this path so merely registering an IPC listener can
   * never spawn or resurrect the supervisor process.
   */
  async connectIfRunning(): Promise<DesktopSupervisorDaemonStatus | null> {
    if (process.platform !== "darwin" && process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON !== "1") {
      return null;
    }
    try {
      const negotiated = await this.request<Record<string, unknown>>(
        "daemon.negotiate",
        undefined,
        SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      );
      const status = mapStatus(negotiated);
      this.observeAttachedDaemon(status);
      return this.rememberReadyStatus(status);
    } catch (error) {
      if (isConnectionUnavailable(error)) {
        this.recordAttachedDaemonDisconnect();
        return null;
      }
      throw error;
    }
  }

  private async ensureRunningOnce(refreshRuntimeEnvironment = false): Promise<DesktopSupervisorDaemonStatus> {
    await this.waitForOwnedDaemonReadiness();
    this.assertNotRestarting();
    const hold = await readDaemonMaintenance(this.maintenancePath);
    const spawnEnvironment = supervisorDaemonSpawnEnvironment();
    const expectedRuntimeEnvironmentFingerprint = spawnEnvironment.LETAGENTS_SUPERVISOR_RUNTIME_ENVIRONMENT_FINGERPRINT!;
    let retiredGeneration: number | undefined;
    try {
      const negotiated = await this.request<Record<string, unknown>>("daemon.negotiate", undefined, SUPERVISOR_DAEMON_PROTOCOL_VERSION)
        .catch((error: unknown) => {
          if (!(error instanceof SupervisorDaemonRequestTimeoutError) || error.method !== "daemon.negotiate") throw error;
          this.assertNotRestarting();
          // Sibling provider starts can briefly delay the service. Retry only
          // this read, once, with the existing rich-read bound. A timeout is
          // never evidence that another daemon may be spawned.
          return this.request<Record<string, unknown>>("daemon.negotiate", undefined,
            SUPERVISOR_DAEMON_PROTOCOL_VERSION, MANIFEST_LIST_REQUEST_TIMEOUT_MS);
        });
      this.assertNotRestarting();
      if (hold && negotiated.maintenance_hold_id !== hold.id) throw new Error("Service maintenance is pending. Use Force restart service in Settings → Updates.");
      const daemonVersion = Number(negotiated.protocol_version ?? 0);
      const implementationVersion = String(negotiated.implementation_version ?? "unknown");
      if (
        daemonVersion === SUPERVISOR_DAEMON_PROTOCOL_VERSION
        && Boolean(hold) === Boolean(negotiated.maintenance_hold_id)
        && implementationVersion === SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION
        && negotiated.compatibility_fingerprint === spawnEnvironment.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT
        && (!refreshRuntimeEnvironment || negotiated.runtime_environment_fingerprint === expectedRuntimeEnvironmentFingerprint)
      ) {
        const status = mapStatus(negotiated);
        this.observeAttachedDaemon(status);
        return status;
      }
      const retired = this.captureRetiredDaemon(negotiated);
      retiredGeneration = Number(negotiated.generation);
      // Handoff drains in-flight provider dispatch reservations, which can
      // span a full provider launch; the tight control timeout aborted real
      // upgrades attempted while any agent was mid-launch.
      await this.drainCurrentDaemon(daemonVersion);
      this.stopAttachedDaemonObservation();
      await this.enforceRetiredDaemonExit(retired, daemonVersion, implementationVersion);
      if (this.ownedDaemon?.pid === retired.pid) this.ownedDaemon = null;
    } catch (error) {
      if (!isConnectionUnavailable(error)) throw error;
      this.recordAttachedDaemonDisconnect();
      // A previously ready child can also temporarily lose its socket. Only
      // its exit/handoff, never a failed connection, permits another launch.
      if (this.ownedDaemon) throw error;
    }
    await access(this.daemonScriptPath);
    this.stopAttachedDaemonObservation();
    await mkdir(this.daemonWorkingDirectory, { recursive: true, mode: 0o700 });
    // OS-backed signing may wait for disk or a Keychain dialog. Finish that
    // before the child starts its bounded verifier handshake, rather than
    // racing secure storage against the child's one-second IPC deadline.
    const signer = hold ? null : await this.loadApprovalSigner().catch(() => null);
    const approvalPublicKey = signer?.publicKey ?? null;
    this.assertNotRestarting();
    if (signer) this.approvalSigner = {
      fingerprint: createHash("sha256").update(Buffer.from(signer.publicKey, "base64")).digest("hex"),
      promise: Promise.resolve(signer),
    };
    const child = this.spawnDaemon(this.daemonScriptPath, this.daemonWorkingDirectory, spawnEnvironment);
    if (child.pid) {
      const identity = this.safeInspectDaemon(child.pid);
      if (identity?.state === "live" && identity.pid === child.pid) this.maintenanceTarget = { ...identity, expectedScriptPath: this.daemonScriptPath };
    }
    const statePreparation = prepareSupervisorState(child, undefined, this.statePreparationWaitMs,
      async () => approvalPublicKey);
    const childPid = Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0 ? child.pid! : null;
    const owned = {
      pid: childPid,
      ready: false,
      retiredGeneration,
      runtimeEnvironmentFingerprint: expectedRuntimeEnvironmentFingerprint,
      compatibilityFingerprint: spawnEnvironment.LETAGENTS_SUPERVISOR_COMPATIBILITY_FINGERPRINT!,
    };
    this.ownedDaemon = owned;
    appendDaemonLifecycleEvent(this.lifecycleLogPath, { event: "daemon_spawned", pid: childPid });
    child.once("error", (error) => {
      // An error after a successful spawn may be an IPC/signalling error,
      // not process death. A failed spawn has no native PID to preserve.
      this.invalidateReadyStatus();
      if (childPid === null && this.ownedDaemon === owned) this.ownedDaemon = null;
      appendDaemonLifecycleEvent(this.lifecycleLogPath, {
        event: "daemon_spawn_error",
        pid: childPid,
        detail: error instanceof Error ? error.stack || error.message : String(error),
      });
    });
    child.once("exit", (exitCode, signal) => {
      this.invalidateReadyStatus();
      if (this.ownedDaemon === owned) this.ownedDaemon = null;
      appendDaemonLifecycleEvent(this.lifecycleLogPath, {
        event: "daemon_exited",
        pid: childPid,
        exitCode,
        signal,
      });
    });
    // Migration/OS-key custody has its own bootstrap protocol. The socket's
    // short startup deadline must not expire while a large backup is fsyncing.
    await statePreparation;
    const status = await this.waitForHealthy(owned.retiredGeneration,
      owned.runtimeEnvironmentFingerprint, owned.compatibilityFingerprint);
    owned.ready = true;
    return status;
  }

  private async waitForOwnedDaemonReadiness(): Promise<void> {
    const owned = this.ownedDaemon;
    if (!owned || owned.ready) return;
    await this.waitForHealthy(owned.retiredGeneration,
      owned.runtimeEnvironmentFingerprint, owned.compatibilityFingerprint);
    owned.ready = true;
  }

  private async drainCurrentDaemon(daemonVersion: number): Promise<void> {
    this.invalidateReadyStatus();
    this.drainingCurrentDaemon = true;
    for (const ready of this.startupApprovalWaiters) ready();
    try {
      // Approval reads must reach this live owner even when ensureOperation is
      // waiting for an upgrade. Joining that promise would deadlock the turn.
      await this.request("daemon.prepare_handoff", undefined, daemonVersion, HANDOFF_DRAIN_REQUEST_TIMEOUT_MS);
    } finally {
      this.drainingCurrentDaemon = false;
    }
  }

  private async prepareForApplicationUpdateOnce(): Promise<void> {
    if (this.ensureOperation) await this.ensureOperation;
    await this.waitForOwnedDaemonReadiness();
    let negotiated: Record<string, unknown>;
    try {
      negotiated = await this.request<Record<string, unknown>>(
        "daemon.negotiate",
        undefined,
        SUPERVISOR_DAEMON_PROTOCOL_VERSION,
      );
    } catch (error) {
      // A failed or never-started supervisor has no owner-only socket to
      // relinquish. Keep the update fence active, but do not prevent Squirrel
      // from replacing the app that may contain the daemon recovery fix.
      if (isConnectionUnavailable(error) && !this.ownedDaemon) return;
      throw error;
    }
    const daemonVersion = Number(negotiated.protocol_version ?? 0);
    const implementationVersion = String(negotiated.implementation_version ?? "unknown");
    const retired = this.captureRetiredDaemon(negotiated);
    await this.drainCurrentDaemon(daemonVersion);
    this.stopAttachedDaemonObservation();
    await this.enforceRetiredDaemonExit(retired, daemonVersion, implementationVersion);
    if (this.ownedDaemon?.pid === retired.pid) this.ownedDaemon = null;
  }

  private async waitForHealthy(
    retiredGeneration: number | undefined,
    expectedRuntimeEnvironmentFingerprint: string,
    expectedCompatibilityFingerprint: string,
  ): Promise<DesktopSupervisorDaemonStatus> {
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const result = await this.request<Record<string, unknown>>("daemon.negotiate");
        const status = mapStatus(result);
        if (status.protocolVersion !== SUPERVISOR_DAEMON_PROTOCOL_VERSION) {
          throw new SupervisorDaemonProtocolMismatchError(SUPERVISOR_DAEMON_PROTOCOL_VERSION, status.protocolVersion, "Replacement daemon protocol does not match the desktop.");
        }
        if (status.implementationVersion !== SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION) {
          throw new Error(
            `Replacement supervisor daemon is still ${status.implementationVersion}; expected ${SUPERVISOR_DAEMON_IMPLEMENTATION_VERSION}. Rebuild the desktop daemon and try again.`,
          );
        }
        if (result.runtime_environment_fingerprint !== expectedRuntimeEnvironmentFingerprint) {
          throw new Error("Replacement supervisor daemon did not inherit the current provider runtime environment.");
        }
        if (result.compatibility_fingerprint !== expectedCompatibilityFingerprint) {
          throw new Error("Replacement supervisor daemon did not inherit the current state and runtime identity.");
        }
        if (retiredGeneration !== undefined && status.generation <= retiredGeneration) {
          throw new Error(
            `Replacement supervisor daemon did not acquire a newer singleton generation; received ${status.generation} after ${retiredGeneration}.`,
          );
        }
        return status;
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }
    throw new Error(`Timed out waiting for the supervisor daemon: ${lastError instanceof Error ? lastError.message : "unreachable"}`);
  }

  private captureRetiredDaemon(negotiated: Record<string, unknown>): DaemonProcessIdentity {
    const pid = Number(negotiated.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
      throw new Error("Refusing daemon handoff because the serving daemon PID is invalid.");
    }
    const inspected = this.safeInspectDaemon(pid);
    if (!inspected || inspected.state === "zombie") {
      throw new Error("Refusing daemon handoff because the serving daemon process identity is unverifiable.");
    }
    if (inspected.pid !== pid) {
      throw new Error("Refusing daemon handoff because the inspected daemon PID does not match the serving daemon.");
    }
    // A prior app install or a local development build can legitimately own
    // the stable daemon socket. Let that negotiated daemon retire itself, but
    // retain the current script path as the hard boundary for TERM/KILL: only
    // the exact executable this desktop expected to launch may be signalled.
    return this.maintenanceTarget = { ...inspected, expectedScriptPath: this.daemonScriptPath };
  }

  private observeAttachedDaemon(status: DesktopSupervisorDaemonStatus): void {
    if (status.pid === this.ownedDaemon?.pid) {
      this.stopAttachedDaemonObservation();
      return;
    }
    if (
      this.attachedDaemonObservation?.identity.pid === status.pid
      && this.attachedDaemonObservation.generation === status.generation
    ) return;
    this.stopAttachedDaemonObservation();
    const inspected = this.safeInspectDaemon(status.pid);
    if (!inspected || inspected.state !== "live" || inspected.pid !== status.pid) return;
    const observation = {
      identity: { ...inspected, expectedScriptPath: this.daemonScriptPath },
      generation: status.generation,
    };
    this.attachedDaemonObservation = observation;
    this.maintenanceTarget = observation.identity;
  }

  private recordAttachedDaemonDisconnect(): void {
    this.invalidateReadyStatus();
    const observation = this.attachedDaemonObservation;
    if (!observation) return;
    const current = this.observeRetiredDaemon(observation.identity);
    if (current.kind === "same" || current.kind === "unverifiable") return;
    this.attachedDaemonObservation = null;
    appendDaemonLifecycleEvent(this.lifecycleLogPath, {
      event: current.kind === "changed" ? "daemon_identity_changed" : "daemon_disappeared",
      pid: observation.identity.pid,
      generation: observation.generation,
      detail: current.kind === "changed"
        ? current.reason
        : `Observed daemon became ${current.kind}.`,
    });
  }

  private stopAttachedDaemonObservation(): void {
    this.attachedDaemonObservation = null;
  }

  private async enforceRetiredDaemonExit(
    retired: DaemonProcessIdentity,
    daemonVersion: number,
    implementationVersion: string,
  ): Promise<void> {
    let observation = await this.waitForRetiredProcessChange(retired, this.naturalExitTimeoutMs);
    let authorityReleased = await this.isSocketReleased(daemonVersion);
    if (observation.kind === "absent" || observation.kind === "zombie") {
      if (!authorityReleased) throw new Error("Retired daemon process ended without releasing its control socket.");
      if (observation.kind === "zombie") {
        this.emitHandoffDiagnostic(retired, implementationVersion, true, "zombie_after_natural_exit", "Retired daemon is a zombie after authority release; replacement may proceed.");
      }
      return;
    }
    if (observation.kind !== "same") {
      if (!authorityReleased) {
        throw new Error(`Existing supervisor daemon still owns its socket and its process identity is ${observation.kind}; leaving it serving.`);
      }
      this.emitHandoffDiagnostic(retired, implementationVersion, true, observation.kind, this.observationDetail(observation));
      return;
    }

    if (!this.commandPointsAtExpectedDaemon(retired.command, retired.expectedScriptPath)) {
      throw new Error(authorityReleased
        ? "A LetAgents daemon from another installation released its socket but did not exit; it was not signalled and the replacement was not started."
        : "A LetAgents daemon from another installation did not retire after the negotiated handoff; it was not signalled and the replacement was not started.");
    }

    if (implementationVersion === "2.0.25" && authorityReleased) {
      this.emitHandoffDiagnostic(retired, implementationVersion, authorityReleased, "legacy_sigterm_expected", "Daemon 2.0.25 released authority but retains live RPC handles; SIGTERM escalation is expected.");
    }
    this.assertNotRestarting();
    observation = this.guardedSignalRetiredDaemon(retired, "SIGTERM");
    if (observation.kind === "same") {
      observation = await this.waitForRetiredProcessChange(retired, this.terminateTimeoutMs);
    }
    authorityReleased = await this.isSocketReleased(daemonVersion);
    if (observation.kind === "absent" || observation.kind === "zombie") {
      if (!authorityReleased) throw new Error("Retired daemon did not release its control socket after SIGTERM.");
      return;
    }
    if (observation.kind !== "same") {
      if (!authorityReleased) {
        throw new Error(`Existing supervisor daemon still owns its socket after SIGTERM and its process identity is ${observation.kind}; leaving it serving.`);
      }
      this.emitHandoffDiagnostic(retired, implementationVersion, true, observation.kind, this.observationDetail(observation));
      return;
    }

    this.assertNotRestarting();
    observation = this.guardedSignalRetiredDaemon(retired, "SIGKILL");
    if (observation.kind === "same") {
      observation = await this.waitForRetiredProcessChange(retired, this.killTimeoutMs);
    }
    authorityReleased = await this.isSocketReleased(daemonVersion);
    if (!authorityReleased) {
      throw new Error("Existing supervisor daemon still owns its socket after bounded TERM/KILL enforcement; replacement was not started.");
    }
    if (observation.kind === "same") {
      this.emitHandoffDiagnostic(retired, implementationVersion, true, "non_zombie_survived_sigkill", "Retired daemon survived SIGKILL but no longer owns authority; replacement will prove singleton acquisition.");
      return;
    }
    if (observation.kind === "zombie") {
      this.emitHandoffDiagnostic(retired, implementationVersion, true, "zombie_after_sigkill", "Retired daemon became a zombie after SIGKILL; replacement will prove singleton acquisition.");
      return;
    }
    if (observation.kind !== "absent") {
      this.emitHandoffDiagnostic(retired, implementationVersion, true, observation.kind, this.observationDetail(observation));
    }
  }

  private guardedSignalRetiredDaemon(
    retired: DaemonProcessIdentity,
    signal: "SIGTERM" | "SIGKILL",
  ): RetiredDaemonObservation {
    const observation = this.observeRetiredDaemon(retired);
    if (observation.kind !== "same") return observation;
    if (!Number.isSafeInteger(retired.pid) || retired.pid <= 1 || retired.pid === process.pid) {
      return { kind: "changed", reason: "invalid daemon PID" };
    }
    // Deliberately signal the exact positive daemon PID. Provider-stop code may
    // signal provider process groups; daemon replacement must never do so.
    try {
      this.signalDaemon(retired.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return this.observeRetiredDaemon(retired);
      }
      throw error;
    }
    return observation;
  }

  private async waitForRetiredProcessChange(
    retired: DaemonProcessIdentity,
    timeoutMs: number,
  ): Promise<RetiredDaemonObservation> {
    const deadline = Date.now() + timeoutMs;
    let observation = this.observeRetiredDaemon(retired);
    while (observation.kind === "same" && Date.now() < deadline) {
      await delay(Math.min(this.processPollIntervalMs, Math.max(0, deadline - Date.now())));
      observation = this.observeRetiredDaemon(retired);
    }
    return observation;
  }

  private observeRetiredDaemon(retired: DaemonProcessIdentity): RetiredDaemonObservation {
    const current = this.safeInspectDaemon(retired.pid);
    if (current === null) return { kind: "absent" };
    if (current === undefined) return { kind: "unverifiable" };
    if (current.pid !== retired.pid) return { kind: "changed", reason: "inspected PID changed" };
    if (current.kernelStartTime !== retired.kernelStartTime) {
      return { kind: "changed", reason: "kernel start time changed (PID reuse)" };
    }
    if (current.state === "zombie") return { kind: "zombie" };
    if (current.command !== retired.command) return { kind: "changed", reason: "full command changed" };
    return { kind: "same", identity: retired };
  }

  private safeInspectDaemon(pid: number): DaemonIdentityInspection | null | undefined {
    try {
      return this.inspectDaemonProcess(pid);
    } catch {
      return undefined;
    }
  }

  private commandPointsAtExpectedDaemon(command: string, expectedScriptPath = this.daemonScriptPath): boolean {
    return command === expectedScriptPath || command.endsWith(` ${expectedScriptPath}`);
  }

  private async isSocketReleased(daemonVersion: number, maintenance = false): Promise<boolean> {
    try {
      await this.request("daemon.negotiate", undefined, daemonVersion, this.requestTimeoutMs, false, undefined, undefined, maintenance);
      return false;
    } catch (error) {
      if (isConnectionUnavailable(error)) return true;
      // A timeout, malformed response, or daemon error still proves that the
      // socket was connectable; it does not prove authority release. Keep the
      // result conservative so an exact identity-guarded TERM/KILL can retire
      // an acknowledged-but-unresponsive predecessor.
      return false;
    }
  }

  private observationDetail(observation: Exclude<RetiredDaemonObservation, { kind: "same" }>): string {
    return observation.kind === "changed"
      ? `Retired daemon identity changed: ${observation.reason}. It was not signalled.`
      : `Retired daemon identity is ${observation.kind}. It was not signalled.`;
  }

  private emitHandoffDiagnostic(
    retired: DaemonProcessIdentity,
    implementationVersion: string,
    authorityReleased: boolean,
    outcome: string,
    detail: string,
  ): void {
    this.reportHandoffDiagnostic({
      event: "supervisor_daemon_handoff",
      outcome,
      pid: retired.pid,
      implementationVersion,
      authorityReleased,
      detail,
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
